"""Root-only legacy ZIP adapter using the controller locks and verification contracts.

The installed Docker controller is a separate lifecycle. This adapter never converts
an instance, touches an existing Docker registration, or restores business data.
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import sys
import tarfile
import uuid
import zipfile
from pathlib import Path
from controller import Controller, TERMINAL, source_configuration_closure, digest, mounted_roots, read_private_json, available_memory
from engine import Docker, EngineError
from scan import inventory, read_env
from state import Journal, atomic_json, atomic_bytes, locks, execute_request, latest_record, reserve_request, request_result, find_request, save_request

ENTRIES = ('cloud', 'src', 'web', 'docs', 'scripts', 'package.json', 'package-lock.json',
           '.env.example', '.gitignore', 'install.php', 'LICENSE', 'node_modules')
REVIEW = {'CENTER_AUTHORIZATION_REQUIRES_RUNTIME_VALIDATION', 'SAVED_AUTHORIZATION_REQUIRES_RUNTIME_VALIDATION', 'AUTHORIZATION_MODE_REQUIRES_REVIEW'}


def state_directory(root, app_root):
    return Path(root) / 'pm2' / hashlib.sha256(str(app_root).encode()).hexdigest()


def extract_zip(source, destination):
    """Validate every entry before extracting any bytes; never accept links or traversal."""
    if source.stat().st_size > 16 * 1024**2:
        raise ValueError('ZIP_SIZE_REQUIRES_REVIEW')
    with zipfile.ZipFile(source) as archive:
        entries = archive.infolist()
        if len(entries) > 1000 or sum(item.file_size for item in entries) > 48 * 1024**2 or any(item.file_size > 4 * 1024**2 for item in entries):
            raise ValueError('ZIP_SIZE_REQUIRES_REVIEW')
        seen = set()
        for item in entries:
            name = item.filename.replace('\\', '/')
            parts = name.rstrip('/').split('/')
            if not name or name.startswith('/') or any(p in ('', '.', '..') or ':' in p or '\x00' in p for p in parts):
                raise ValueError('UNSAFE_ZIP_PATH')
            if stat.S_ISLNK(item.external_attr >> 16) or name in seen:
                raise ValueError('ZIP_LINK_OR_DUPLICATE_REQUIRES_REVIEW')
            seen.add(name)
            if parts[0] in ('data', 'logs', 'uploads', 'node_modules', '.env') or any(p == '.git' or p.startswith('.env') and p != '.env.example' for p in parts):
                raise ValueError('ZIP_CONTAINS_RUNTIME_STATE')
        destination.mkdir(mode=0o700)
        archive.extractall(destination)


def replace_entries(source, target, present):
    for name in ENTRIES:
        old, replacement = target / name, source / name
        temporary = target / ('.yushuhub-upgrade-next-' + name)
        remove_entry(temporary)
        if name in present:
            if replacement.is_dir() and not replacement.is_symlink():
                shutil.copytree(replacement, temporary, symlinks=True)
            else:
                shutil.copy2(replacement, temporary, follow_symlinks=False)
        remove_entry(old)
        if name in present:
            os.replace(temporary, old)
    for name in present:
        entry = target / name
        if entry.is_dir():
            sync_tree(entry)
        elif entry.is_file() and not entry.is_symlink():
            with entry.open('rb') as stream:
                os.fsync(stream.fileno())
    fd = os.open(target, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def remove_entry(path):
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.exists():
        shutil.rmtree(path)


def tree_fingerprint(root):
    hashed = hashlib.sha256()
    for name in ENTRIES:
        entry = root / name
        candidates = [entry] + (sorted(entry.rglob('*')) if entry.is_dir() else [])
        for path in candidates:
            if path.is_symlink():
                content = ('link:' + os.readlink(path)).encode()
            elif path.is_file():
                content = digest(path).encode()
            elif path.is_dir():
                content = b'directory'
            else:
                content = b'absent'
            hashed.update(os.fsencode(str(path.relative_to(root))) + b'\0' + content + b'\0')
    return hashed.hexdigest()


def sync_tree(root):
    for parent, _, files in os.walk(root):
        for name in files:
            path = Path(parent) / name
            if not path.is_symlink():
                with path.open('rb') as stream:
                    os.fsync(stream.fileno())
    for parent, _, _ in os.walk(root, topdown=False):
        fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


class Pm2ZipController(Controller):
    def preflight(self, plan):
        super().preflight(plan)
        roots = [Path(plan['config']['appRoot'])]
        if plan.get('candidateDir'):
            roots.append(Path(plan['candidateDir']))
        code_bytes = 0
        for root in roots:
            for name in ENTRIES:
                entry = root / name
                if entry.is_file():
                    code_bytes += entry.stat().st_size
                elif entry.is_dir():
                    code_bytes += sum((Path(d)/f).lstat().st_size for d, _, files in os.walk(entry) for f in files)
        if shutil.disk_usage(self.root).free < code_bytes * 2 + int(plan['authorization'].get('databaseBytes',0)) * 3 + 256 * 1024**2:
            raise ValueError('INSUFFICIENT_DISK_FOR_EXACT_CODE_BACKUP')
    def directory(self, app_root):
        path = Path(app_root)
        if not path.is_absolute() or path == Path('/') or path.is_symlink() or path.resolve() != path:
            raise ValueError('APPLICATION_ROOT_REQUIRES_REVIEW')
        return state_directory(self.root, path)

    def validate_source(self, plan, identity=True, code=True):
        root = Path(plan['config']['appRoot'])
        if (root / '.yushuhub-deployment.json').exists():
            raise ValueError('INSTANCE_MANAGED_BY_DOCKER_CONTROLLER')
        if source_configuration_closure(root) != plan['configurationClosure']:
            raise ValueError('SOURCE_CONFIGURATION_CHANGED_REPLAN_REQUIRED')
        if code and tree_fingerprint(root) != plan['sourceTreeHash']:
            raise ValueError('SOURCE_CODE_CHANGED_REPLAN_REQUIRED')
        if identity and self.engine.authorization_probe(plan['config'])['identityHash'] != plan['authorization']['identityHash']:
            raise ValueError('AUTHORIZATION_CHANGED_REPLAN_REQUIRED')

    def prepare_plan(self, request, directory, operation):
        root = Path(request['appRoot'])
        scan = inventory(root)
        if set(scan['issues']) - REVIEW or len(scan['pm2']) != 1:
            raise ValueError('PM2_SCAN_REQUIRES_REVIEW')
        cfg = {'appRoot': str(root), 'port': scan['port'], 'stateDir': str(directory),
               'memoryMiB': 256, 'hostReserveMiB': 128,
               'mysqldump': request.get('mysqldump') or '/www/server/mysql/bin/mysqldump'}
        closure = source_configuration_closure(root)
        proof = self.engine.authorization_probe(cfg)
        cfg['expectedIdentityHash'] = proof['identityHash']
        old = self.engine.source_contract(str(root))
        if old['version'] != scan['runningVersion'] or closure['databaseLockKey'] != scan['databaseLockKey']:
            raise ValueError('SOURCE_RUNTIME_OR_DATABASE_CHANGED')
        roots = mounted_roots(root, scan)
        for path in roots:
            if path.relative_to(root).parts[0] in ENTRIES:
                raise ValueError('PERSISTENT_PATH_INSIDE_CODE_TREE_REQUIRES_REVIEW')
            if path == self.root or path in self.root.parents or self.root in path.parents:
                raise ValueError('PERSISTENT_PATH_OVERLAPS_CONTROLLER_STATE')
        for name in ENTRIES:
            if (root / name).is_symlink():
                raise ValueError('CODE_ROOT_SYMLINK_REQUIRES_REVIEW')
        plan = {'format': 1, 'config': cfg, 'inventory': scan, 'oldMode': 'pm2', 'targetMode': 'pm2-zip',
                'old': old, 'configurationClosure': closure, 'authorization': proof,
                'mountRoots': [str(path) for path in roots], 'sourceTreeHash': tree_fingerprint(root)}
        self.validate_source(plan)
        snapshot = directory / 'operations' / operation / 'environment'
        atomic_bytes(snapshot / '.env', (root / '.env').read_bytes())
        plan['sourceEnvSnapshotDir'] = str(snapshot)
        self.snapshot_environment(plan)
        return plan

    def stage_package(self, request, record, journal):
        plan = record['plan']
        archive = Path(request['archiveFile'])
        if archive.is_symlink() or archive.stat().st_uid != 0 or archive.stat().st_mode & 0o022:
            raise ValueError('ZIP_MUST_BE_ROOT_CONTROLLED')
        if not re.fullmatch(r'[a-f0-9]{64}', request.get('sha256', '')) or digest(archive) != request['sha256']:
            raise ValueError('ZIP_CHECKSUM_MISMATCH')
        work = Path(plan['config']['stateDir']) / 'operations' / record['operationId']
        stage = work / 'candidate'
        extract_zip(archive, stage)
        package = json.loads((stage / 'package.json').read_text())
        if package.get('name') != 'agent-ai-admin' or not re.fullmatch(r'\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?', package.get('version', '')):
            raise ValueError('INVALID_ZIP_PACKAGE_IDENTITY')
        if request.get('expectedVersion') and package['version'] != request['expectedVersion']:
            raise ValueError('ZIP_MANIFEST_VERSION_MISMATCH')
        target = self.engine.source_contract(str(stage))
        if any(plan['old'][key] != target[key] for key in ('schemaSha256', 'migrationSha256')):
            raise ValueError('DATABASE_MIGRATION_REQUIRES_SEPARATE_PLAN')
        if not (stage / 'package-lock.json').is_file():
            raise ValueError('LOCKED_DEPENDENCIES_REQUIRED')
        plan['target'] = target
        plan['candidateDir'] = str(stage)
        journal.save(record, 'preparing_dependencies')
        # Install only in the staged release while the old instance remains online.
        if available_memory() < 512 * 1024**2:
            raise ValueError('INSUFFICIENT_MEMORY_FOR_STAGED_DEPENDENCIES')
        self.engine.run(['npm', 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', str(stage)], timeout=600)
        if not (stage / 'node_modules').is_dir():
            raise ValueError('PREPARED_DEPENDENCIES_MISSING')
        self.validate_source(plan)

    def backup(self, plan, record, journal):
        root = Path(plan['config']['appRoot'])
        directory = Path(plan['config']['stateDir']) / 'operations' / record['operationId'] / 'backup'
        directory.mkdir(mode=0o700)
        self.backup_database(plan, directory)
        code = directory / 'code'
        code.mkdir(mode=0o700)
        present = []
        for name in ENTRIES:
            source = root / name
            if source.exists():
                present.append(name)
                if source.is_dir():
                    shutil.copytree(source, code / name, symlinks=True)
                else:
                    shutil.copy2(source, code / name)
        with tarfile.open(directory / 'persistent-files.tar.gz', 'w:gz') as archive:
            for index, path in enumerate(plan['mountRoots']):
                if Path(path).exists():
                    archive.add(path, arcname='mount-' + str(index))
            archive.add(Path(plan['sourceEnvSnapshotDir']) / '.env', arcname='original.env')
        if tree_fingerprint(code) != plan['sourceTreeHash']:
            raise ValueError('CODE_BACKUP_CHANGED_DURING_COPY')
        # Persist the completed backup before the first replacement of active files.
        sync_tree(directory)
        plan.update(backupDir=str(directory), originalEntries=present)
        journal.save(record, 'prepared')

    def restore_zip(self, plan, record, journal):
        self.validate_source(plan, identity=False, code=False)
        self.engine.pm2_processes(start_daemon=True)
        rows = [p for p in self.engine.pm2_processes() if p.get('pm2_env', {}).get('pm_cwd') == plan['config']['appRoot']]
        if len(rows) > 1:
            raise ValueError('PM2_RECOVERY_TARGET_AMBIGUOUS')
        journal.save(record, 'rolling_back')
        if rows:
            self.engine.pm2(plan['config']['appRoot'], 'stop', int(rows[0]['pm_id']))
        self.engine.port_is_free(plan['config']['port'])
        if plan.get('backupDir'):
            replace_entries(Path(plan['backupDir']) / 'code', Path(plan['config']['appRoot']), plan['originalEntries'])
        self.resume_pm2(plan)
        self.engine.verify(plan['config'], plan['old'], require_container=False)
        journal.save(record, 'rolled_back')

    def apply_zip(self, request):
        app_root = request['appRoot']
        request = dict(request, operationId=request.get('operationId') or str(uuid.uuid4()))
        operation_id = request['operationId']
        with locks(self.root, ['host-cutover', 'pm2:' + app_root]):
            return execute_request(self.directory(app_root), operation_id, {'action': 'upgrade', 'archiveSha256': request.get('sha256'), 'expectedVersion': request.get('expectedVersion')}, lambda: self._apply_zip_locked(request))

    def _apply_zip_locked(self, request):
        app_root = request['appRoot']
        directory = self.directory(app_root)
        operation = request['operationId']
        journal = Journal(directory)
        prior = journal.read()
        receipt = directory / 'operations' / (operation + '.json')
        if receipt.exists():
            previous = read_private_json(receipt)
            if previous.get('archiveSha256') != request.get('sha256') or previous.get('expectedVersion') != request.get('expectedVersion'):
                raise ValueError('OPERATION_ID_REUSED_WITH_DIFFERENT_RELEASE')
            return {'operationId': operation, 'stage': previous['stage']}
        if prior and prior['stage'] not in TERMINAL:
            raise ValueError('PENDING_TRANSACTION_REQUIRES_RECOVER')
        plan = self.prepare_plan(request, directory, operation)
        with locks(self.root, ['database:' + plan['inventory']['databaseLockKey']]):
            self.preflight(plan)
            record = {'operationId': operation, 'plan': plan, 'archiveSha256': request.get('sha256'), 'expectedVersion': request.get('expectedVersion')}
            journal.save(record, 'preparing')
            stopped = False
            try:
                self.stage_package(request, record, journal)
                self.preflight(plan)
                self.validate_source(plan)
                self.identify_pm2(plan)
                journal.save(record, 'draining')
                stopped = True
                self.engine.pm2(app_root, 'stop', plan['pm2Id'])
                self.engine.port_is_free(plan['config']['port'])
                journal.save(record, 'stopped')
                self.backup(plan, record, journal)
                self.validate_source(plan, identity=False)
                journal.save(record, 'replacing')
                candidate = Path(plan['candidateDir'])
                replace_entries(candidate, Path(app_root), [name for name in ENTRIES if (candidate / name).exists()])
                journal.save(record, 'starting')
                self.resume_pm2(plan)
                journal.save(record, 'verifying')
                self.engine.verify(plan['config'], plan['target'], require_container=False)
                atomic_json(directory / 'current.json', {'committedOperationId': operation})
                journal.save(record, 'committed')
            except Exception as error:
                code = str(error) if isinstance(error, (ValueError, EngineError)) else type(error).__name__
                if not stopped:
                    journal.save(record, 'rejected', error=code)
                else:
                    try:
                        self.restore_zip(plan, record, journal)
                        journal.save(record, 'rolled_back', error=code)
                    except Exception:
                        journal.save(record, 'needs_attention', error=code)
                raise RuntimeError('ZIP_UPGRADE_' + record['stage'].upper()) from None
            return {'operationId': operation, 'stage': 'committed', 'version': plan['target']['version']}

    def recover_zip(self, app_root, rollback=False, operation_id=None):
        operation_id = operation_id or str(uuid.uuid4())
        with locks(self.root, ['host-cutover', 'pm2:' + app_root]):
            return execute_request(self.directory(app_root), operation_id, {'action': 'rollback' if rollback else 'recover'}, lambda: self._recover_zip_locked(app_root, rollback))

    def _recover_zip_locked(self, app_root, rollback):
        directory = self.directory(app_root)
        journal = Journal(directory)
        record = journal.read()
        if not record:
            raise ValueError('NO_TRANSACTION_TO_RECOVER')
        if rollback:
            if record['stage'] not in TERMINAL:
                raise ValueError('PENDING_TRANSACTION_REQUIRES_RECOVER')
            current = read_private_json(directory / 'current.json')
            record = read_private_json(directory / 'operations' / (current['committedOperationId'] + '.json'))
        if record['stage'] in ('rolled_back', 'rejected') or record['stage'] == 'committed' and not rollback:
            return {'stage': record['stage'], 'operationId': record['operationId']}
        plan = record['plan']
        with locks(self.root, ['database:' + plan['inventory']['databaseLockKey']]):
            try:
                if record['stage'] in ('preparing', 'preparing_dependencies'):
                    self.engine.verify(plan['config'], plan['old'], require_container=False)
                    journal.save(record, 'rejected', error='INTERRUPTED_BEFORE_CUTOVER')
                else:
                    self.restore_zip(plan, record, journal)
            except Exception:
                journal.save(record, 'needs_attention', error='RECOVERY_INCOMPLETE')
                raise RuntimeError('RECOVERY_NEEDS_ATTENTION') from None
        return {'stage': record['stage'], 'operationId': record['operationId']}


def public_record(control, app_root):
    directory = control.directory(app_root)
    record = Journal(directory).read() or {}
    request_path = directory / 'last-request.json'
    request = read_private_json(request_path) if request_path.exists() else {}
    record = latest_record(record, request)
    body = {key: record[key] for key in ('stage', 'operationId', 'updatedAt', 'error') if key in record}
    if body.get('error') and not re.fullmatch(r'[A-Z][A-Z0-9_]{0,120}', body['error']):
        body['error'] = 'ZIP_UPGRADE_FAILED'
    return body


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['upgrade', 'recover', 'rollback', 'status'])
    parser.add_argument('--request', required=True)
    parser.add_argument('--detach', action='store_true')
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise ValueError('ROOT_LEGACY_ADAPTER_REQUIRED')
    request = read_private_json(args.request)
    for key in list(os.environ):
        if key.startswith('AI_'):
            del os.environ[key]
    control = Pm2ZipController()
    if args.action == 'status':
        print(json.dumps(public_record(control, request['appRoot']))); return
    request['operationId'] = request.get('operationId') or str(uuid.uuid4())
    if not re.fullmatch(r'[A-Za-z0-9-]{1,80}', request['operationId']):
        raise ValueError('INVALID_OPERATION_ID')
    request_path = control.directory(request['appRoot']) / 'last-request.json'
    intent = {'action': args.action}
    if args.action == 'upgrade':
        intent.update(archiveSha256=request.get('sha256'), expectedVersion=request.get('expectedVersion'))
    status = reserve_request(control.directory(request['appRoot']), request['operationId'], intent)
    if status['stage'] != 'accepted':
        print(json.dumps(request_result(status))); return
    if args.detach:
        child = os.fork()
        if child:
            os.waitpid(child, 0)
            print(json.dumps({'stage': 'accepted', 'operationId': request.get('operationId')})); return
        os.setsid()
        if os.fork():
            os._exit(0)
        os.chdir('/')
        os.umask(0o077)
        fd = os.open(os.devnull, os.O_RDWR)
        for stream in (0, 1, 2):
            os.dup2(fd, stream)
        os.close(fd)
    try:
        result = control.apply_zip(request) if args.action == 'upgrade' else control.recover_zip(request['appRoot'], args.action == 'rollback', request['operationId'])
        status.update(stage=result['stage'])
    except Exception as error:
        code = str(error)
        current = find_request(control.directory(request['appRoot']), request['operationId'], intent)
        if current and current['stage'] == 'accepted':
            current.update(stage='failed', error=code if re.fullmatch(r'[A-Z][A-Z0-9_]{0,120}', code) else 'ZIP_UPGRADE_FAILED')
            save_request(control.directory(request['appRoot']), current)
        raise
    if not args.detach:
        print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        code = str(error)
        print(json.dumps({'error': code if re.fullmatch(r'[A-Z][A-Z0-9_]{0,120}', code) else 'ZIP_UPGRADE_FAILED'}))
        sys.exit(1)
