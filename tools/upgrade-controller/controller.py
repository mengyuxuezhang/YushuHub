"""Root-installed, registered-instance controller. scan/plan are read-only; mutations require --apply."""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import tarfile
import tempfile
import time
import uuid
from pathlib import Path
from urllib.parse import urlparse
from engine import Docker, EngineError
from scan import inventory, read_env, database_lock_key, PATH_DEFAULTS, PATH_KEYS
from state import Journal, atomic_json, locks

TERMINAL = {'committed', 'rolled_back', 'rejected'}
ID = re.compile(r'^[a-z][a-z0-9-]{0,47}$')
IMAGE = re.compile(r'^[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[a-f0-9]{64}$')


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def read_private_json(path):
    path = Path(path)
    if path.is_symlink() or (os.name == 'posix' and (path.stat().st_uid != 0 or path.stat().st_mode & 0o022)):
        raise ValueError('CONFIG_MUST_BE_ROOT_OWNED_AND_NOT_WRITABLE_BY_OTHERS')
    return json.loads(path.read_text())


def mounted_roots(root, scan):
    root = Path(root).resolve()
    candidates = [root / 'data', root / 'logs']
    for item in scan['paths']:
        path = Path(item['path'])
        if os.path.commonpath([str(path), str(root)]) != str(root):
            raise ValueError('EXTERNAL_PATH_REQUIRES_SEPARATE_REVIEW:' + item['key'])
        if path == root or path in root.parents or not path.relative_to(root).parts:
            raise ValueError('UNSAFE_PERSISTENT_PATH')
        if path.exists() and path.is_file():
            if not str(path).startswith(str(root / 'data') + os.sep):
                candidates.append(path)
        else:
            # Missing key files under data remain covered by the data directory.
            candidates.append(path.parent if item['key'].endswith(('_PATH', '_FILE')) else path)
    roots = []
    for path in sorted(set(candidates), key=lambda p: len(p.parts)):
        if any(path == parent or parent in path.parents for parent in roots):
            continue
        if path == root or path in root.parents:
            raise ValueError('MOUNT_WOULD_EXPOSE_APPLICATION_CODE')
        roots.append(path)
    return roots


def available_memory():
    fields = dict(line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())
    return int(fields['MemAvailable'].strip().split()[0]) * 1024


class Controller:
    def __init__(self, root='/var/lib/yushuhub-upgrade', config_root='/etc/yushuhub-upgrade', engine=None):
        self.root = Path(root)
        self.config_root = Path(config_root)
        self.engine = engine or Docker()

    def config(self, instance):
        if not ID.fullmatch(instance):
            raise ValueError('INVALID_INSTANCE_ID')
        cfg = read_private_json(self.config_root / 'instances' / (instance + '.json'))
        if cfg.get('instanceId') != instance:
            raise ValueError('INSTANCE_ID_MISMATCH')
        root = Path(cfg['appRoot'])
        if not root.is_absolute() or root.is_symlink() or root.resolve() == Path('/'):
            raise ValueError('INVALID_APPLICATION_ROOT')
        if root != root.resolve():
            raise ValueError('APPLICATION_ROOT_ALIAS_REQUIRES_REVIEW')
        cfg['containerName'] = 'yushuhub-' + instance
        cfg['stateDir'] = str(self.root / 'instances' / instance)
        try:
            cfg['port'] = int(cfg['port'])
            cfg['memoryMiB'] = int(cfg.get('memoryMiB', 256))
            cfg['hostReserveMiB'] = int(cfg.get('hostReserveMiB', 128))
        except (ValueError, TypeError):
            raise ValueError('INVALID_NUMERIC_INSTANCE_CONFIGURATION') from None
        if not 1 <= cfg['port'] <= 65535 or not 128 <= cfg['memoryMiB'] <= 4096 or cfg['hostReserveMiB'] < 96:
            raise ValueError('INVALID_MEMORY_BUDGET')
        if cfg.get('publicUrl'):
            url = urlparse(cfg['publicUrl'])
            if url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password or url.query or url.fragment or url.path not in ('', '/'):
                raise ValueError('INVALID_PUBLIC_ORIGIN')
            cfg['publicUrl'] = cfg['publicUrl'].rstrip('/')
        return cfg

    def release(self, name):
        if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9.-]{0,79}', name):
            raise ValueError('INVALID_RELEASE_ID')
        release = read_private_json(self.config_root / 'releases' / (name + '.json'))
        if not IMAGE.fullmatch(release.get('image', '')):
            raise ValueError('IMMUTABLE_IMAGE_REFERENCE_REQUIRED')
        for key in ('htmlSha256', 'schemaSha256', 'migrationSha256'):
            if not re.fullmatch(r'[a-f0-9]{64}', release.get(key, '')):
                raise ValueError('INVALID_RELEASE_CONTRACT')
        if release.get('platform') != 'linux/amd64' or not re.fullmatch(r'\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?', str(release.get('version', ''))):
            raise ValueError('INVALID_RELEASE_PLATFORM_OR_VERSION')
        return release

    def plan(self, instance, release_name):
        cfg, target = self.config(instance), self.release(release_name)
        state = Path(cfg['stateDir'])
        try:
            current = json.loads((state / 'current.json').read_text())
        except FileNotFoundError:
            current = None
        if current:
            scan = current['inventory']
            old = current['release']
            if not old.get('migrationSha256'):
                old = dict(old, **self.engine.image_contract(old['image']))
            if scan.get('sourceEnvSha256') and scan['sourceEnvSha256'] != digest(Path(cfg['appRoot']) / '.env'):
                raise ValueError('SOURCE_CONFIGURATION_CHANGED_REQUIRES_REVIEW')
        else:
            scan = inventory(cfg['appRoot'])
            if len(scan['pm2']) != 1:
                raise ValueError('MULTIPLE_PM2_DEFINITIONS_REQUIRE_REVIEW')
            old = self.engine.source_contract(cfg['appRoot'])
            if old['version'] != scan['runningVersion']:
                raise ValueError('SOURCE_RUNNING_VERSION_MISMATCH')
        runtime_review = {'CENTER_AUTHORIZATION_REQUIRES_RUNTIME_VALIDATION', 'SAVED_AUTHORIZATION_REQUIRES_RUNTIME_VALIDATION', 'AUTHORIZATION_MODE_REQUIRES_REVIEW'}
        if set(scan['issues']) - runtime_review:
            raise ValueError('SCAN_BLOCKED:' + ','.join(sorted(set(scan['issues']) - runtime_review)))
        authorization = self.engine.authorization_probe(cfg, use_container=bool(current))
        cfg['expectedIdentityHash'] = authorization['identityHash']
        if current and current.get('identityHash') and current['identityHash'] != authorization['identityHash']:
            raise ValueError('AUTHORIZATION_IDENTITY_CHANGED_REQUIRES_REVIEW')
        scan['sourceEnvSha256'] = digest(Path(cfg['appRoot']) / '.env')
        if int(cfg['port']) != scan['port']:
            raise ValueError('REGISTERED_PORT_CHANGED')
        if cfg.get('databaseExclusive') is not True:
            raise ValueError('DATABASE_OWNERSHIP_REVIEW_REQUIRED')
        if cfg.get('databaseLockKey') != scan['databaseLockKey']:
            raise ValueError('REGISTERED_DATABASE_LOCATOR_CHANGED_OR_UNREVIEWED')
        if old['version'] not in target.get('supportedFrom', []):
            raise ValueError('SOURCE_VERSION_NOT_SUPPORTED')
        # First release supports only identical schema code, never destructive/unknown migration.
        if old['schemaSha256'] != target['schemaSha256'] or old['migrationSha256'] != target['migrationSha256'] or target.get('migrationPolicy') != 'same-schema':
            raise ValueError('DATABASE_MIGRATION_REQUIRES_SEPARATE_PLAN')
        if not current and old['version'] != target['version']:
            raise ValueError('MIGRATE_TO_SAME_VERSION_FIRST')
        roots = mounted_roots(cfg['appRoot'], scan)
        for path in roots:
            for protected in (self.root.resolve(), self.config_root.resolve()):
                if path == protected or path in protected.parents or protected in path.parents:
                    raise ValueError('PERSISTENT_PATH_OVERLAPS_CONTROLLER_STATE_OR_CONFIGURATION')
        for other_file in (self.config_root / 'instances').glob('*.json'):
            if other_file.stem == instance:
                continue
            other = read_private_json(other_file)
            if not other.get('databaseLockKey'):
                raise ValueError('OTHER_INSTANCE_REGISTRATION_REQUIRES_REVIEW')
            other_root = Path(other['appRoot']).resolve()
            if other.get('databaseLockKey') == scan['databaseLockKey']:
                raise ValueError('DATABASE_SHARED_WITH_ANOTHER_REGISTERED_INSTANCE')
            if any(path == other_root or path in other_root.parents or other_root in path.parents for path in roots):
                raise ValueError('PERSISTENT_PATH_OVERLAPS_ANOTHER_REGISTERED_INSTANCE')
        for directory in roots:
            if directory.exists():
                if directory.is_symlink():
                    raise ValueError('SYMLINK_MOUNT_REQUIRES_REVIEW')
                if directory.is_dir():
                    for parent, dirs, files in os.walk(directory, followlinks=False):
                        if any((Path(parent) / name).is_symlink() for name in dirs + files):
                            raise ValueError('NESTED_SYMLINK_REQUIRES_REVIEW')
        pending = Journal(state).read()
        if pending and pending['stage'] not in TERMINAL:
            raise ValueError('PENDING_TRANSACTION_REQUIRES_RECOVER')
        return {'format': 1, 'instanceId': instance, 'releaseId': release_name, 'config': cfg,
                'inventory': scan, 'old': old, 'target': target, 'oldMode': 'docker' if current else 'pm2',
                'authorization': authorization, 'previousCurrent': current, 'mountRoots': [str(p) for p in roots]}

    def preflight(self, plan):
        cfg = plan['config']
        self.engine.available()
        processes = json.loads(self.engine.run(['pm2', 'jlist'])) if shutil.which('pm2') else []
        for process in processes:
            meta = process.get('pm2_env', {})
            other_root = Path(meta.get('pm_cwd', '/')).resolve()
            if meta.get('status') != 'online' or other_root == Path(cfg['appRoot']):
                continue
            try:
                package = json.loads((other_root / 'package.json').read_text())
                if package.get('name') != 'agent-ai-admin':
                    continue
                other_env = read_env(other_root)
            except (OSError, ValueError):
                continue
            inherited = dict(meta.get('env', {}))
            inherited.update({k: v for k, v in meta.items() if k.startswith('AI_')})
            other_env.update({k: v for k, v in inherited.items() if k.startswith('AI_') and isinstance(v, str)})
            if database_lock_key(other_env) == plan['inventory']['databaseLockKey']:
                raise ValueError('DATABASE_SHARED_WITH_ACTIVE_PM2_INSTANCE')
        executable = Path(cfg.get('mysqldump', '/www/server/mysql/bin/mysqldump'))
        if not executable.is_file() or not os.access(executable, os.X_OK):
            raise ValueError('MYSQLDUMP_UNAVAILABLE')
        # Known legacy watchdogs must be retired separately; never stop an unrelated unit.
        if Path('/run/systemd/system').exists():
            result = subprocess.run(['systemctl', 'show', 'agent-ai-admin-supervisor',
                '--property=ActiveState,Environment'], capture_output=True, text=True, timeout=10)
            if 'ActiveState=active' in result.stdout and ('AI_ADMIN_APP_DIR=' + cfg['appRoot']) in result.stdout:
                raise ValueError('TARGET_LEGACY_SUPERVISOR_REQUIRES_RETIREMENT')
        compose_version = self.engine.run(['docker', 'compose', 'version', '--short']).strip().lstrip('v')
        if tuple(int(p) for p in compose_version.split('.')[:2]) < (2, 30):
            raise ValueError('COMPOSE_2_30_OR_NEWER_REQUIRED')
        # Upper bound memory reservation; no OOM trial to discover whether it fits.
        rss = 0
        if plan['oldMode'] == 'pm2':
            online = [p for p in plan['inventory']['pm2'] if p['status'] == 'online']
            if len(online) != 1:
                raise ValueError('PM2_TARGET_AMBIGUOUS')
            try:
                stat = Path('/proc/' + str(online[0]['pid']) + '/status').read_text()
                process_uid = int(re.search(r'^Uid:\s+(\d+)', stat, re.M).group(1))
                rss = int(re.search(r'^VmRSS:\s+(\d+)', stat, re.M).group(1)) * 1024
            except Exception:
                raise ValueError('CANNOT_MEASURE_CURRENT_PROCESS') from None
            if process_uid != 0:
                raise ValueError('NONROOT_PM2_REQUIRES_USER_ADAPTER')
            self.engine.port_owner(cfg['port'], pid=online[0]['pid'])
        else:
            existing = self.engine.container(cfg['containerName'])
            if not existing or not existing['State']['Running'] or existing['Config']['Image'] != plan['old']['image']:
                raise ValueError('CURRENT_CONTAINER_DIFFERS_FROM_JOURNAL')
            # Measure actual charged memory; never count its full configured limit as freeable.
            usage = self.engine.run(['docker', 'stats', '--no-stream', '--format', '{{.MemUsage}}', cfg['containerName']]).split('/')[0].strip()
            match = re.fullmatch(r'([\d.]+)(B|KiB|MiB|GiB)', usage)
            if not match:
                raise ValueError('CANNOT_MEASURE_CURRENT_CONTAINER')
            rss = int(float(match[1]) * {'B': 1, 'KiB': 1024, 'MiB': 1024**2, 'GiB': 1024**3}[match[2]])
        required = (int(cfg.get('memoryMiB', 256)) + int(cfg.get('hostReserveMiB', 128))) * 1024 * 1024
        if available_memory() + rss < required:
            raise ValueError('INSUFFICIENT_MEMORY_RESERVE')
        size = 0
        for root in plan['mountRoots']:
            p = Path(root)
            if p.is_file():
                size += p.stat().st_size
            elif p.exists():
                size += sum((Path(d) / f).stat().st_size for d, _, files in os.walk(p) for f in files)
        parent = self.root if self.root.exists() else self.root.parent
        if shutil.disk_usage(parent).free < max(1024 ** 3, size * 2 + int(plan.get('authorization', {}).get('databaseBytes', 0)) * 3):
            raise ValueError('INSUFFICIENT_DISK_FOR_BACKUP_AND_RECOVERY')
        env = read_env(cfg['appRoot'])
        if (env.get('AI_DB_HOST') or '127.0.0.1').lower() not in ('127.0.0.1', 'localhost', '::1'):
            raise ValueError('REMOTE_OR_SHARED_DATABASE_REQUIRES_SEPARATE_PLAN')
        mode = env.get('AI_AUTHORIZATION_MODE')
        if not mode and plan['inventory']['authorizationMode'] not in ('legacy-marker',) and not plan.get('authorization', {}).get('verified'):
            if not plan['inventory']['savedAuthorization']:
                raise ValueError('AUTHORIZATION_MODE_REQUIRES_REVIEW')

    def backup_database(self, plan, directory):
        cfg = plan['config']
        executable = cfg.get('mysqldump', '/www/server/mysql/bin/mysqldump')
        if not Path(executable).is_file():
            raise ValueError('MYSQLDUMP_UNAVAILABLE')
        env = read_env(cfg['appRoot'])
        database = env.get('AI_DB_NAME', 'agent_ai')
        if not re.fullmatch(r'[A-Za-z0-9_]+', database):
            raise ValueError('DATABASE_NAME_REQUIRES_REVIEW')
        values = {'host': env.get('AI_DB_HOST', '127.0.0.1'), 'port': env.get('AI_DB_PORT', '3306'),
                  'user': env.get('AI_DB_USER', 'root'), 'password': env.get('AI_DB_PASSWORD', '')}
        credential = directory / 'mysql-client.cnf'
        try:
            with credential.open('w') as stream:
                os.chmod(credential, 0o600)
                stream.write('[client]\n')
                for key, value in values.items():
                    if '\n' in value or '\r' in value:
                        raise ValueError('UNSUPPORTED_DATABASE_CREDENTIAL_FORMAT')
                    stream.write(key + '="' + value.replace('\\', '\\\\').replace('"', '\\"') + '"\n')
            output = directory / 'database.sql'
            with output.open('wb') as stream:
                os.chmod(output, 0o600)
                result = subprocess.run([executable, '--defaults-extra-file=' + str(credential), '--single-transaction',
                    '--quick', '--routines', '--events', '--triggers', '--no-tablespaces', '--databases', database],
                    stdout=stream, stderr=subprocess.PIPE, timeout=600)
                stream.flush()
                os.fsync(stream.fileno())
            if result.returncode or output.stat().st_size == 0:
                raise ValueError('DATABASE_BACKUP_FAILED')
        finally:
            credential.unlink(missing_ok=True)

    def backup_and_prepare(self, plan, record, journal):
        cfg = plan['config']
        backup = Path(cfg['stateDir']) / 'backups' / record['operationId']
        backup.mkdir(mode=0o700, parents=True)
        self.backup_database(plan, backup)
        with tarfile.open(backup / 'files.tar.gz', 'w:gz') as archive:
            for index, path in enumerate(plan['mountRoots']):
                if Path(path).exists():
                    archive.add(path, arcname='mount-' + str(index), recursive=True)
            archive.add(Path(cfg['appRoot']) / '.env', arcname='original.env')
        os.chmod(backup / 'files.tar.gz', 0o600)
        with (backup / 'files.tar.gz').open('rb') as stream:
            os.fsync(stream.fileno())
        record['backup'] = str(backup)
        # Preserve original ownership metadata before changing access to shared persistent data.
        ownership = []
        for value in plan['mountRoots']:
            path = Path(value)
            existed = path.exists()
            path.mkdir(mode=0o700, parents=True, exist_ok=True) if not existed else None
            entries = [path]
            if path.is_dir():
                entries += [Path(d) / name for d, dirs, files in os.walk(path) for name in dirs + files]
            for entry in entries:
                if entry.is_symlink():
                    raise ValueError('DATA_CHANGED_TO_SYMLINK')
                stat = entry.stat()
                ownership.append([str(entry), stat.st_uid, stat.st_gid])
        atomic_json(backup / 'ownership.json', ownership)
        journal.save(record, 'prepared')
        for path, _, _ in ownership:
            os.chown(path, 1000, 1000, follow_symlinks=False)

    def compose_file(self, plan, release):
        cfg = plan['config']
        directory = Path(cfg['stateDir'])
        # Load secrets via the application's existing dotenv reader, never into Docker inspect Env.
        env = read_env(cfg['appRoot'])
        root = Path(cfg['appRoot'])
        for entry in plan['inventory']['paths']:
            key, path = entry['key'], Path(entry['path'])
            try:
                relative = path.relative_to(root / 'data')
                env[key] = str(Path('/app/data') / relative)
            except ValueError:
                env[key] = str(path)
        if not env.get('AI_PREVIEW_ROOT'):
            env['AI_PREVIEW_ROOT'] = str(Path(env['AI_UPDATE_ROOT']).parent / 'ai-staging')
        for key in ('AI_ADMIN_UPDATE_MANIFEST_URL', 'AI_SOURCE_VERSION_URL'):
            if key in env:
                env[key] = env[key].replace('http://8.147.134.68/agent/', 'https://updates.okpa.cn/agent/')
        config_file = directory / 'runtime.env'
        with config_file.open('w') as stream:
            os.chmod(config_file, 0o600)
            for key, value in env.items():
                if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', key) or '\n' in value or '\r' in value:
                    raise ValueError('ENV_FORMAT_REQUIRES_REVIEW')
                stream.write(key + '=' + value + '\n')
        os.chown(config_file, 1000, 1000)
        mounts = []
        for path in plan['mountRoots']:
            target = '/app/data' if Path(path) == root / 'data' else '/app/logs' if Path(path) == root / 'logs' else path
            mounts.append({'type': 'bind', 'source': path, 'target': target, 'bind': {'create_host_path': False}})
        mounts.append({'type': 'bind', 'source': str(config_file), 'target': '/app/.env', 'read_only': True})
        body = {'name': 'yushuhub-' + plan['instanceId'], 'services': {'app': {
            'image': release['image'], 'platform': 'linux/amd64', 'container_name': cfg['containerName'],
            'network_mode': 'host', 'user': '1000:1000', 'init': True,
            'environment': {'AI_ADMIN_DEPLOYMENT_MODE': 'docker', 'AI_ADMIN_HOST': '127.0.0.1', 'AI_ADMIN_PORT': str(cfg['port'])},
            'volumes': mounts, 'restart': 'unless-stopped', 'stop_grace_period': '45s',
            'mem_limit': str(cfg.get('memoryMiB', 256)) + 'm', 'pids_limit': 128, 'cpus': 1,
            'read_only': True, 'tmpfs': ['/tmp:size=64m,mode=1777'],
            'cap_drop': ['ALL'], 'security_opt': ['no-new-privileges:true'],
            'logging': {'driver': 'json-file', 'options': {'max-size': '10m', 'max-file': '3'}}}}}
        path = directory / 'compose.json'
        atomic_json(path, body)
        return path

    def identify_pm2(self, plan):
        rows = json.loads(self.engine.run(['pm2', 'jlist']))
        old = [p for p in plan['inventory']['pm2'] if p['status'] == 'online']
        matches = [p for p in rows if len(old) == 1 and p.get('pid') == old[0]['pid'] and
                   Path(p.get('pm2_env', {}).get('pm_cwd', '/')).resolve() == Path(plan['config']['appRoot']).resolve()]
        if len(matches) != 1:
            raise ValueError('PM2_PROCESS_CHANGED_SINCE_PLAN')
        plan['pm2Id'] = int(matches[0]['pm_id'])
        selected = matches[0]['pm2_env']
        if selected.get('exec_mode', 'fork_mode') != 'fork_mode':
            raise ValueError('PM2_CLUSTER_REQUIRES_SEPARATE_MIGRATION')
        script = Path(selected.get('pm_exec_path', ''))
        if script.resolve() != (Path(plan['config']['appRoot']) / 'cloud/ai-admin/server.mjs').resolve():
            raise ValueError('PM2_SCRIPT_DOES_NOT_MATCH_REGISTERED_INSTANCE')
        interpreter = os.readlink('/proc/' + str(matches[0]['pid']) + '/exe')
        resume = {'name': matches[0]['name'], 'script': str(script), 'cwd': plan['config']['appRoot'],
                  'interpreter': interpreter, 'env': selected.get('env', {})}
        for key in ('args', 'node_args', 'max_memory_restart', 'kill_timeout', 'listen_timeout'):
            if key in selected:
                resume[key] = selected[key]
        state = Path(plan['config']['stateDir'])
        plan['pm2ResumeFile'] = str(state / 'pm2-resume.json')
        atomic_json(plan['pm2ResumeFile'], {'apps': [resume]})
        home = Path(selected.get('PM2_HOME') or selected.get('env', {}).get('PM2_HOME') or Path.home() / '.pm2')
        dumps = []
        for name in ('dump.pm2', 'dump.pm2.bak'):
            path = home / name
            if path.exists():
                if path.is_symlink():
                    raise ValueError('PM2_STARTUP_DUMP_SYMLINK_REQUIRES_REVIEW')
                content = json.loads(path.read_text())
                if not isinstance(content, list):
                    raise ValueError('INVALID_PM2_STARTUP_DUMP')
                target = [row for row in content if row.get('pm_cwd') == plan['config']['appRoot']]
                if len(target) > 1:
                    raise ValueError('PM2_STARTUP_DUPLICATES_REQUIRE_REVIEW')
                dumps.append({'path': str(path), 'targetRows': target})
        plan['pm2AutostartFile'] = str(state / 'pm2-autostart.json')
        atomic_json(plan['pm2AutostartFile'], dumps)

    def edit_pm2_autostart(self, plan, restore=False):
        for item in json.loads(Path(plan['pm2AutostartFile']).read_text()):
            path = Path(item['path'])
            rows = json.loads(path.read_text()) if path.exists() else []
            # Preserve all other instances exactly as currently saved, including concurrent edits.
            remaining = [row for row in rows if row.get('pm_cwd') != plan['config']['appRoot']]
            if restore:
                remaining += item['targetRows']
            atomic_json(path, remaining)

    def resume_pm2(self, plan):
        rows = json.loads(self.engine.run(['pm2', 'jlist']))
        matches = [p for p in rows if p.get('pm2_env', {}).get('pm_cwd') == plan['config']['appRoot']]
        if len(matches) > 1:
            raise ValueError('PM2_RECOVERY_TARGET_AMBIGUOUS')
        if matches:
            self.engine.pm2(plan['config']['appRoot'], 'restart', int(matches[0]['pm_id']))
        else:
            if not plan.get('pm2ResumeFile') or not Path(plan['pm2ResumeFile']).is_file():
                raise ValueError('PM2_RESUME_DEFINITION_MISSING')
            self.engine.run(['pm2', 'start', plan['pm2ResumeFile']])
        self.edit_pm2_autostart(plan, restore=True)

    def stop_old(self, plan):
        if plan['oldMode'] == 'docker':
            self.engine.compose(Path(plan['config']['stateDir']) / 'compose.json', 'stop')
        else:
            # Confirm actual ID from PM2 before mutation, never select a guessed process name.
            self.edit_pm2_autostart(plan)
            self.engine.pm2(plan['config']['appRoot'], 'stop', plan['pm2Id'])

    def restore(self, plan, record, journal):
        cfg = plan['config']
        journal.save(record, 'rolling_back')
        # If this call is uncertain, stop here: starting old writer could create dual writers.
        self.engine.available()
        container = self.engine.container(cfg['containerName'])
        if container:
            self.engine.compose(Path(cfg['stateDir']) / 'compose.json', 'stop')
            if self.engine.container(cfg['containerName'])['State']['Running']:
                raise EngineError('FAILED_CANDIDATE_STILL_RUNNING')
        if plan['oldMode'] == 'pm2':
            if 'pm2Id' not in plan:
                raise ValueError('PM2_ID_MISSING_REQUIRES_MANUAL_REVIEW')
            self.resume_pm2(plan)
            self.engine.verify(cfg, plan['old'], require_container=False)
        else:
            self.engine.inspect_image(plan['old']['image'])
            self.engine.compose(self.compose_file(plan, plan['old']), 'up')
            self.engine.verify(cfg, plan['old'])
        if plan['oldMode'] == 'pm2':
            (Path(cfg['stateDir']) / 'current.json').unlink(missing_ok=True)
        else:
            atomic_json(Path(cfg['stateDir']) / 'current.json', plan.get('previousCurrent') or {'release': plan['old'], 'inventory': plan['inventory']})
        journal.save(record, 'rolled_back')

    def recover(self, instance, rollback_committed=False):
        cfg = self.config(instance)
        with locks(self.root, ['host-cutover', 'instance:' + instance]):
            journal = Journal(cfg['stateDir'])
            record = journal.read()
            if not record:
                raise ValueError('NO_TRANSACTION_TO_RECOVER')
            if rollback_committed:
                if record['stage'] not in TERMINAL:
                    raise ValueError('PENDING_TRANSACTION_REQUIRES_RECOVER')
                current_file = Path(cfg['stateDir']) / 'current.json'
                current = json.loads(current_file.read_text()) if current_file.exists() else {}
                operation = current.get('committedOperationId')
                if operation:
                    record = json.loads((Path(cfg['stateDir']) / 'operations' / (operation + '.json')).read_text())
            if record['stage'] in ('rejected', 'rolled_back'):
                return {'stage': record['stage'], 'operationId': record['operationId']}
            if record['stage'] == 'committed' and not rollback_committed:
                return {'stage': 'committed', 'operationId': record['operationId']}
            plan = record['plan']
            with locks(self.root, ['database:' + plan['inventory']['databaseLockKey']]):
                if record['stage'] == 'pulling':
                    # No writer was stopped at this stage; verify old service, don't touch it.
                    self.engine.verify(cfg, plan['old'], require_container=plan['oldMode'] == 'docker')
                    journal.save(record, 'rejected', error='INTERRUPTED_BEFORE_CUTOVER')
                else:
                    try:
                        self.restore(plan, record, journal)
                    except Exception:
                        journal.save(record, 'needs_attention', error='RECOVERY_INCOMPLETE')
                        raise RuntimeError('RECOVERY_NEEDS_ATTENTION') from None
            return {'stage': record['stage'], 'operationId': record['operationId']}

    def apply(self, instance, release_name, operation_id=None):
        cfg = self.config(instance)
        state = Path(cfg['stateDir'])
        operation_id = operation_id or str(uuid.uuid4())
        if not re.fullmatch(r'[A-Za-z0-9-]{1,80}', operation_id):
            raise ValueError('INVALID_OPERATION_ID')
        # Root-wide serialization also protects shared host memory and aliased DB locators.
        with locks(self.root, ['host-cutover', 'instance:' + instance]):
            journal = Journal(state)
            previous = journal.read()
            receipt = state / 'operations' / (operation_id + '.json')
            if receipt.exists() and (not previous or previous.get('operationId') != operation_id):
                previous = json.loads(receipt.read_text())
            if previous and previous.get('operationId') == operation_id:
                if previous['plan']['releaseId'] != release_name:
                    raise ValueError('OPERATION_ID_REUSED_WITH_DIFFERENT_RELEASE')
                return {'operationId': operation_id, 'stage': previous['stage']}
            plan = self.plan(instance, release_name)
            with locks(self.root, ['database:' + plan['inventory']['databaseLockKey']]):
                self.preflight(plan)
                record = {'operationId': operation_id, 'plan': plan}
                journal.save(record, 'pulling')
                stopped = False
                try:
                    self.engine.inspect_image(plan['target']['image'], pull=True)
                    actual = self.engine.image_contract(plan['target']['image'])
                    if any(actual.get(k) != plan['target'][k] for k in ('version', 'schemaSha256', 'migrationSha256', 'htmlSha256')):
                        raise ValueError('IMAGE_RELEASE_CONTRACT_MISMATCH')
                    if plan['oldMode'] == 'docker':
                        self.engine.inspect_image(plan['old']['image'])
                    # Recheck resources immediately before stopping, after image extraction.
                    self.preflight(plan)
                    if plan['oldMode'] == 'pm2':
                        self.identify_pm2(plan)
                    journal.save(record, 'draining')
                    # Mark uncertainty before stop; recovery must inspect actual processes.
                    stopped = True
                    self.stop_old(plan)
                    self.engine.port_is_free(cfg['port'])
                    journal.save(record, 'stopped')
                    self.backup_and_prepare(plan, record, journal)
                    compose = self.compose_file(plan, plan['target'])
                    journal.save(record, 'starting')
                    self.engine.compose(compose, 'up')
                    journal.save(record, 'verifying')
                    self.engine.verify(cfg, plan['target'])
                    if plan['oldMode'] == 'pm2':
                        # Remove the stopped entry so a later unrelated `pm2 save` cannot
                        # reintroduce the old writer at host boot. Resume definition is retained.
                        self.engine.pm2(cfg['appRoot'], 'delete', plan['pm2Id'])
                    current = {'release': plan['target'], 'inventory': plan['inventory'], 'committedOperationId': operation_id,
                               'identityHash': plan['authorization']['identityHash']}
                    atomic_json(state / 'current.json', current)
                    journal.save(record, 'committed')
                except Exception as error:
                    code = str(error) if isinstance(error, (ValueError, EngineError)) else type(error).__name__
                    if not stopped:
                        journal.save(record, 'rejected', error=code)
                    else:
                        try:
                            self.restore(plan, record, journal)
                            record['error'] = code
                            journal.save(record, 'rolled_back')
                        except Exception:
                            journal.save(record, 'needs_attention', error=code)
                    raise RuntimeError('UPGRADE_' + record['stage'].upper()) from None
                return {'operationId': operation_id, 'stage': record['stage'], 'version': plan['target']['version']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['scan', 'plan', 'upgrade', 'status', 'recover', 'rollback'])
    parser.add_argument('--app-root')
    parser.add_argument('--instance')
    parser.add_argument('--release')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--operation-id')
    args = parser.parse_args()
    if args.apply and args.command in ('upgrade', 'recover', 'rollback') and os.geteuid() != 0:
        raise ValueError('ROOT_CONTROLLER_REQUIRED')
    control = Controller()
    if args.command == 'scan':
        print(json.dumps(inventory(args.app_root), ensure_ascii=False, indent=2))
    elif args.command == 'status':
        cfg = control.config(args.instance)
        record = Journal(cfg['stateDir']).read()
        print(json.dumps({k: v for k, v in (record or {}).items() if k != 'plan'}, ensure_ascii=False, indent=2))
    elif args.command in ('recover', 'rollback'):
        if not args.apply:
            print(json.dumps({'action': args.command, 'instanceId': args.instance, 'applyRequired': True}))
        else:
            print(json.dumps(control.recover(args.instance, rollback_committed=args.command == 'rollback')))
    elif args.command == 'plan' or not args.apply:
        print(json.dumps(control.plan(args.instance, args.release), ensure_ascii=False, indent=2))
    else:
        if os.geteuid() != 0:
            raise ValueError('ROOT_CONTROLLER_REQUIRED')
        print(json.dumps(control.apply(args.instance, args.release, args.operation_id)))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Do not print raw command stderr, HTTP bodies, credentials or full traceback.
        print(json.dumps({'error': str(error) if isinstance(error, (ValueError, RuntimeError)) else type(error).__name__}))
        raise SystemExit(1)
