"""Maintainer build and pinned Linux controller installation; standard library only.

Verify this bootstrap script separately, then supply an independently trusted archive
SHA-256 and source revision. A checksum obtained from an untrusted archive is not trust.
"""
import argparse
import base64
import contextlib
import gzip
import hashlib
import io
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import uuid
from pathlib import Path

FILES = ('controller.py', 'engine.py', 'state.py', 'scan.py', 'service.py', 'catalog.py',
         'authorization-probe.mjs', 'runtime-contract.mjs', 'pm2_zip.py', 'bundle.json',
         'delivery.py', 'setup.py', 'install-controller.sh', 'yushuhub-upgrade@.service', 'INSTALL.txt')
MAX_ARCHIVE = 4 * 1024**2
MAX_EXPANDED = 16 * 1024**2
FINAL = {'committed', 'rolled_back'}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def atomic(path, data, mode=0o600):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.next')
    try:
        with temporary.open('xb') as stream:
            os.chmod(temporary, mode)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        sync_dir(path.parent)
    finally:
        temporary.unlink(missing_ok=True)


def sync_dir(path):
    if os.name == 'posix':
        fd = os.open(str(path), os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def public_fingerprint(raw):
    match = re.fullmatch(rb'\s*-----BEGIN PUBLIC KEY-----\s+([A-Za-z0-9+/=\r\n]+)-----END PUBLIC KEY-----\s*', raw)
    if not match:
        raise ValueError('PUBLIC_SPKI_KEY_REQUIRED')
    return sha(base64.b64decode(re.sub(rb'\s', b'', match[1]), validate=True))


def build(repo, revision, version, output, keys=()):
    if not re.fullmatch(r'[a-f0-9]{40}', revision) or not re.fullmatch(r'\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?', version):
        raise ValueError('EXACT_REVISION_AND_VERSION_REQUIRED')
    def git(*args):
        return subprocess.check_output(['git', '-C', str(repo), *args], stderr=subprocess.DEVNULL)
    if git('rev-parse', revision + '^{commit}').decode().strip() != revision:
        raise ValueError('SOURCE_REVISION_MISMATCH')
    payload = {name: git('show', revision + ':tools/upgrade-controller/' + name) for name in FILES}
    anchors = {}
    for key_id, path in keys:
        if not re.fullmatch(r'[A-Za-z0-9_.-]{1,64}', key_id) or key_id in anchors:
            raise ValueError('INVALID_OR_DUPLICATE_KEY_ID')
        raw = Path(path).read_bytes()
        anchors[key_id] = {'file': 'keys/' + key_id + '.pem', 'spkiSha256': public_fingerprint(raw)}
        payload[anchors[key_id]['file']] = raw
    manifest = {'format': 1, 'kind': 'yushuhub-controller', 'version': version,
        'sourceRevision': revision, 'platform': 'linux/amd64', 'keys': anchors,
        'files': {name: {'sha256': sha(raw), 'bytes': len(raw)} for name, raw in sorted(payload.items())}}
    payload['release-manifest.json'] = canonical(manifest)
    # Deterministic timestamps/ownership/order; Git object bytes, never the worktree.
    buffer = io.BytesIO()
    with gzip.GzipFile(fileobj=buffer, mode='wb', filename='', mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode='w', format=tarfile.USTAR_FORMAT) as archive:
            for name, raw in sorted(payload.items()):
                item = tarfile.TarInfo('controller/' + name)
                item.size, item.mode, item.mtime = len(raw), 0o600, 0
                archive.addfile(item, io.BytesIO(raw))
    raw = buffer.getvalue()
    verify_bytes(raw, sha(raw), revision)
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open('xb') as stream:
        stream.write(raw)
    receipt = {'format': 1, 'sourceRevision': revision, 'version': version,
               'archiveSha256': sha(raw), 'archiveBytes': len(raw), 'manifestSha256': sha(payload['release-manifest.json']),
               'bootstrapSha256': sha(payload['delivery.py']), 'keys': anchors}
    with output.with_suffix(output.suffix + '.json').open('x', encoding='utf-8') as stream:
        json.dump(receipt, stream, indent=2)
    return receipt


def verify_bytes(raw, expected, revision):
    if not re.fullmatch(r'[a-f0-9]{64}', expected) or not re.fullmatch(r'[a-f0-9]{40}', revision):
        raise ValueError('TRUSTED_ARCHIVE_SHA_AND_REVISION_REQUIRED')
    if len(raw) > MAX_ARCHIVE or sha(raw) != expected:
        raise ValueError('ARCHIVE_DIGEST_OR_SIZE_MISMATCH')
    files, total = {}, 0
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:gz') as archive:
        for member in archive:
            name = member.name
            if not member.isfile() or not name.startswith('controller/') or '\\' in name:
                raise ValueError('ARCHIVE_ENTRY_REJECTED')
            relative = name[len('controller/'):]
            if relative in files or relative not in FILES + ('release-manifest.json',) and not re.fullmatch(r'keys/[A-Za-z0-9_.-]{1,64}\.pem', relative):
                raise ValueError('ARCHIVE_PATH_OR_DUPLICATE_REJECTED')
            total += member.size
            if not 0 <= member.size <= 2 * 1024**2 or total > MAX_EXPANDED or len(files) >= 80:
                raise ValueError('ARCHIVE_EXPANSION_LIMIT')
            files[relative] = archive.extractfile(member).read()
    manifest = json.loads(files.get('release-manifest.json', b'{}'))
    if manifest.get('format') != 1 or manifest.get('kind') != 'yushuhub-controller' or manifest.get('sourceRevision') != revision or manifest.get('platform') != 'linux/amd64':
        raise ValueError('CONTROLLER_MANIFEST_MISMATCH')
    if not re.fullmatch(r'\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?', manifest.get('version', '')):
        raise ValueError('INVALID_CONTROLLER_VERSION')
    listed = manifest.get('files', {})
    if set(files) != set(listed) | {'release-manifest.json'} or not set(FILES).issubset(listed):
        raise ValueError('CONTROLLER_FILE_SET_MISMATCH')
    for name, entry in listed.items():
        if entry != {'bytes': len(files[name]), 'sha256': sha(files[name])}:
            raise ValueError('CONTROLLER_FILE_DIGEST_MISMATCH')
    anchors = manifest.get('keys', {})
    if {v.get('file') for v in anchors.values()} != {n for n in listed if n.startswith('keys/')}:
        raise ValueError('CONTROLLER_KEY_SET_MISMATCH')
    for key_id, entry in anchors.items():
        if not re.fullmatch(r'[A-Za-z0-9_.-]{1,64}', key_id) or entry.get('file') != 'keys/' + key_id + '.pem' or public_fingerprint(files[entry['file']]) != entry.get('spkiSha256'):
            raise ValueError('CONTROLLER_PUBLIC_KEY_MISMATCH')
    return manifest, files


def verified_archive(path, expected, revision):
    with Path(path).open('rb') as stream:
        raw = stream.read(MAX_ARCHIVE + 1)
    return verify_bytes(raw, expected, revision)


class Layout:
    """Prefix is injectable by unit tests only; the CLI always uses native paths."""
    def __init__(self, prefix=Path('/')):
        prefix = Path(prefix)
        self.install = prefix / 'opt/yushuhub-upgrade-controller'
        self.state = prefix / 'var/lib/yushuhub-upgrade'
        self.config = prefix / 'etc/yushuhub-upgrade'
        self.unit = prefix / 'etc/systemd/system/yushuhub-upgrade@.service'
        self.cli = prefix / 'usr/local/sbin/yushuhub-upgrade'
        self.setup = prefix / 'usr/local/sbin/yushuhub-upgrade-setup'
        self.journal = self.install / 'installation.json'


def controlled(path, directory=False):
    path = Path(path)
    if path.is_symlink() or not path.exists():
        raise ValueError('MANAGED_PATH_REQUIRES_REVIEW')
    status = path.stat()
    if status.st_uid != 0 or status.st_mode & 0o022 or directory != path.is_dir() or not directory and not path.is_file():
        raise ValueError('MANAGED_PATH_REQUIRES_REVIEW')
    # Check every existing ancestor, not just the last component.
    for parent in path.parents:
        status = parent.lstat()
        if parent.is_symlink() or status.st_uid != 0 or status.st_mode & 0o022:
            raise ValueError('MANAGED_PARENT_REQUIRES_REVIEW')


def command(args, allow_failure=False):
    env = dict(os.environ, DOCKER_HOST='unix:///var/run/docker.sock')
    for key in ('DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'):
        env.pop(key, None)
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=30, env=env)
    except (OSError, subprocess.TimeoutExpired):
        raise ValueError('INSTALL_COMMAND_OUTCOME_UNKNOWN') from None
    if result.returncode and not allow_failure:
        raise ValueError('INSTALL_COMMAND_FAILED')
    return result.returncode, result.stdout.strip()


def dependencies():
    if platform.system() != 'Linux' or platform.machine() != 'x86_64' or sys.version_info < (3, 8):
        raise ValueError('LINUX_AMD64_PYTHON38_REQUIRED')
    if not Path('/run/systemd/system').is_dir():
        raise ValueError('NATIVE_SYSTEMD_REQUIRED')
    if command(['docker', 'info', '--format', '{{.OSType}}'])[1] != 'linux':
        raise ValueError('LOCAL_LINUX_DOCKER_REQUIRED')
    version = command(['docker', 'compose', 'version', '--short'])[1].lstrip('v')
    if not re.fullmatch(r'\d+\.\d+(?:\.\d+)?(?:[-+].*)?', version) or tuple(map(int, version.split('.')[:2])) < (2, 30):
        raise ValueError('COMPOSE_2_30_REQUIRED')
    if not re.match(r'OpenSSL (?:1\.1\.1|[3-9]\.)', command(['openssl', 'version'])[1]):
        raise ValueError('OPENSSL_1_1_1_OR_3_REQUIRED')
    command(['ss', '--version'])
    command(['systemctl', '--version'])
    if not shutil.which('mysqldump') and not os.access('/www/server/mysql/bin/mysqldump', os.X_OK):
        raise ValueError('MYSQLDUMP_REQUIRED')


@contextlib.contextmanager
def install_locks(layout):
    import fcntl
    directory = layout.state / 'locks'
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    handles = []
    try:
        for key in sorted(['controller-install', 'host-cutover']):
            stream = (directory / (sha(key.encode()) + '.lock')).open('a')
            handles.append(stream)
            try:
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise ValueError('CONTROLLER_TASK_ACTIVE') from None
        yield
    finally:
        for handle in reversed(handles):
            handle.close()


def quiescent(layout):
    for pattern in ('instances/*/transaction.json', 'instances/*/last-request.json',
                    'pm2/*/transaction.json', 'pm2/*/last-request.json'):
        for path in layout.state.glob(pattern):
            controlled(path)
            record = json.loads(path.read_text())
            if record.get('stage') not in {'committed', 'rolled_back', 'rejected', 'failed'}:
                raise ValueError('SETTLE_PENDING_BUSINESS_TASK_BEFORE_INSTALL')


def units(layout):
    result = []
    for path in sorted((layout.config / 'instances').glob('*.json')):
        controlled(path)
        if not re.fullmatch(r'[a-z][a-z0-9-]{0,47}', path.stem) or json.loads(path.read_text()).get('instanceId') != path.stem:
            raise ValueError('INVALID_REGISTERED_INSTANCE')
        unit = 'yushuhub-upgrade@' + path.stem + '.service'
        code, state = command(['systemctl', 'is-active', unit], allow_failure=True)
        if state not in ('active', 'inactive', 'failed', 'unknown') or state == 'active' and code != 0:
            raise ValueError('CONTROLLER_SERVICE_STATE_UNKNOWN')
        result.append({'unit': unit, 'active': state == 'active'})
    return result


def current_target(layout):
    releases = layout.install / 'releases'
    if releases.exists() or releases.is_symlink():
        controlled(releases, directory=True)
    current = layout.install / 'current'
    if not current.exists() and not current.is_symlink():
        return None
    if not current.is_symlink():
        raise ValueError('CURRENT_MUST_BE_MANAGED_SYMLINK')
    target = current.resolve(strict=True)
    if target.parent != (layout.install / 'releases').resolve():
        raise ValueError('CURRENT_OUTSIDE_RELEASES')
    controlled(target, directory=True)
    return str(target)


def switch(layout, target):
    current = layout.install / 'current'
    if target is None:
        current.unlink(missing_ok=True)
    else:
        destination = Path(target)
        if destination.parent.resolve() != (layout.install / 'releases').resolve():
            raise ValueError('INVALID_RELEASE_TARGET')
        controlled(destination, directory=True)
        temporary = current.with_name('.current-' + uuid.uuid4().hex)
        temporary.symlink_to(destination)
        os.replace(temporary, current)
    sync_dir(layout.install)


def write_journal(layout, record, stage):
    record['stage'] = stage
    atomic(layout.journal, canonical(record))


def restore_install(layout, record):
    for item in record['units']:
        if item['active']:
            command(['systemctl', 'stop', item['unit']])
    switch(layout, record['previous'])
    for name, path in [('cli', layout.cli), ('setup', layout.setup), ('unit', layout.unit)]:
        item = record['previousFiles'][name]
        if item is None:
            path.unlink(missing_ok=True)
        else:
            atomic(path, base64.b64decode(item['base64'], validate=True), item['mode'])
    command(['systemctl', 'daemon-reload'])
    for item in record['units']:
        if item['active']:
            command(['systemctl', 'start', item['unit']])
    write_journal(layout, record, 'rolled_back')


def install(archive, expected, revision, apply=False, layout=None, check=dependencies):
    layout = layout or Layout()
    manifest, files = verified_archive(archive, expected, revision)
    check()  # No file writes or service changes before archive and dependency checks.
    for path in (layout.install, layout.state, layout.config, layout.cli.parent, layout.unit.parent):
        existing = path
        while not existing.exists() and not existing.is_symlink():
            existing = existing.parent
        controlled(existing, directory=True)
    previous = current_target(layout)
    service_units = units(layout)
    quiescent(layout)
    if layout.journal.exists():
        controlled(layout.journal)
        if json.loads(layout.journal.read_text()).get('stage') not in FINAL:
            raise ValueError('INSTALL_RECOVERY_REQUIRED')
    plan = {'action': 'install-controller', 'version': manifest['version'], 'sourceRevision': revision,
            'archiveSha256': expected, 'previousRelease': Path(previous).name if previous else None,
            'servicesToRestart': [u['unit'] for u in service_units if u['active']], 'applyRequired': not apply}
    if not apply:
        return plan
    if os.geteuid() != 0:
        raise ValueError('ROOT_INSTALL_REQUIRED')
    layout.install.mkdir(parents=True, exist_ok=True, mode=0o700)
    layout.state.mkdir(parents=True, exist_ok=True, mode=0o700)
    with install_locks(layout):
        quiescent(layout)
        if current_target(layout) != previous or units(layout) != service_units:
            raise ValueError('INSTALL_PLAN_CHANGED')
        record = {'format': 1, 'operationId': str(uuid.uuid4()), 'previous': previous,
                  'units': service_units, 'previousFiles': {}, 'archiveSha256': expected, 'sourceRevision': revision}
        for name, path in [('cli', layout.cli), ('setup', layout.setup), ('unit', layout.unit)]:
            if path.exists() or path.is_symlink():
                controlled(path)
                raw = path.read_bytes()
                if b'/opt/yushuhub-upgrade-controller/current/' not in raw and name != 'unit' or name == 'unit' and b'ExecStart=/usr/local/sbin/yushuhub-upgrade serve' not in raw:
                    raise ValueError('EXISTING_ENTRYPOINT_NOT_OWNED')
                record['previousFiles'][name] = {'base64': base64.b64encode(raw).decode(), 'mode': path.stat().st_mode & 0o777}
            else:
                record['previousFiles'][name] = None
        release_root = layout.install / 'releases'
        release_root.mkdir(mode=0o700, exist_ok=True)
        controlled(release_root, directory=True)
        target = release_root / (manifest['version'] + '-' + expected[:16])
        if target.exists():
            controlled(target, directory=True)
            entries = list(target.rglob('*'))
            if any(p.is_symlink() or not p.is_file() and not p.is_dir() for p in entries) or set(p.relative_to(target).as_posix() for p in entries if p.is_file()) != set(files) or any((target / n).read_bytes() != raw for n, raw in files.items()):
                raise ValueError('EXISTING_RELEASE_CHANGED')
        else:
            stage = Path(tempfile.mkdtemp(prefix='.install-', dir=release_root))
            for name, raw in files.items():
                atomic(stage / name, raw)
            os.rename(stage, target)
            sync_dir(release_root)
        if str(target) == previous:
            return dict(plan, stage='committed', alreadyInstalled=True, applyRequired=False)
        record['target'] = str(target)
        write_journal(layout, record, 'prepared')
        try:
            for item in service_units:
                if item['active']:
                    command(['systemctl', 'stop', item['unit']])
            quiescent(layout)
            write_journal(layout, record, 'services_stopped')
            for path, script in [(layout.cli, 'controller.py'), (layout.setup, 'setup.py')]:
                atomic(path, ('#!/usr/bin/env bash\nexec python3 /opt/yushuhub-upgrade-controller/current/' + script + ' "$@"\n').encode(), 0o755)
            atomic(layout.unit, files['yushuhub-upgrade@.service'], 0o644)
            switch(layout, str(target))
            write_journal(layout, record, 'switched')
            command(['systemctl', 'daemon-reload'])
            for item in service_units:
                if item['active']:
                    command(['systemctl', 'start', item['unit']])
                    if command(['systemctl', 'is-active', item['unit']])[1] != 'active':
                        raise ValueError('CONTROLLER_SERVICE_NOT_ACTIVE')
            write_journal(layout, record, 'committed')
        except Exception:
            try:
                restore_install(layout, record)
            except Exception:
                write_journal(layout, record, 'needs_attention')
            raise ValueError('CONTROLLER_INSTALL_FAILED_SEE_STATUS') from None
    return dict(plan, stage='committed', applyRequired=False)


def recover_install(apply=False, rollback=False, layout=None):
    layout = layout or Layout()
    controlled(layout.journal)
    record = json.loads(layout.journal.read_text())
    if record['stage'] == 'rolled_back':
        return {'stage': 'rolled_back'}
    if record['stage'] == 'committed' and not rollback:
        return {'stage': 'committed'}
    if not apply:
        return {'action': 'rollback-controller' if rollback else 'recover-controller', 'applyRequired': True}
    if os.geteuid() != 0:
        raise ValueError('ROOT_INSTALL_REQUIRED')
    with install_locks(layout):
        quiescent(layout)
        actual = current_target(layout)
        if actual not in (record['previous'], record['target']):
            raise ValueError('CURRENT_CHANGED_REQUIRES_REVIEW')
        try:
            restore_install(layout, record)
        except Exception:
            write_journal(layout, record, 'needs_attention')
            raise ValueError('INSTALL_RECOVERY_INCOMPLETE') from None
    return {'stage': 'rolled_back'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='action', required=True)
    builder = commands.add_parser('build')
    builder.add_argument('--repo', required=True)
    builder.add_argument('--revision', required=True)
    builder.add_argument('--version', required=True)
    builder.add_argument('--output', required=True)
    builder.add_argument('--public-key', action='append', default=[], help='keyId=public-key.pem; never a private key')
    for action in ('verify', 'install'):
        sub = commands.add_parser(action)
        sub.add_argument('--archive', required=True)
        sub.add_argument('--sha256', required=True)
        sub.add_argument('--revision', required=True)
        if action == 'install':
            sub.add_argument('--apply', action='store_true')
    for action in ('recover', 'rollback'):
        commands.add_parser(action).add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if args.action == 'build':
        result = build(args.repo, args.revision, args.version, args.output, [v.split('=', 1) for v in args.public_key])
    elif args.action == 'verify':
        manifest, _ = verified_archive(args.archive, args.sha256, args.revision)
        result = {'verified': True, 'sourceRevision': manifest['sourceRevision'], 'version': manifest['version'], 'keys': manifest['keys']}
    elif args.action == 'install':
        result = install(args.archive, args.sha256, args.revision, args.apply)
    else:
        result = recover_install(args.apply, args.action == 'rollback')
    print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        code = str(error)
        print(json.dumps({'error': code if re.fullmatch(r'[A-Z][A-Z0-9_]{0,120}', code) else 'CONTROLLER_DELIVERY_FAILED'}))
        sys.exit(1)
