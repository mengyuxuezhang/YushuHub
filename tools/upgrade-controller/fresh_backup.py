"""Cold, six-volume disaster backup/restore for the shipped fresh Compose only.

Never overwrites an existing deployment. Restore provisions a new, unused project;
then the operator imports the matching pinned Compose under that project name.
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import tarfile
import tempfile
import time
from pathlib import Path
from controller import IMAGE
from engine import Docker
from fresh import MYSQL_IMAGE
from state import locks, atomic_json

VOLUMES = {'app-data', 'app-logs', 'published', 'app-secret', 'root-secret', 'mysql-data'}
PROJECT = re.compile(r'^[a-z0-9][a-z0-9_-]{0,62}$')


def digest(path):
    value = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024*1024), b''):
            value.update(block)
    return value.hexdigest()


def output(command, path):
    with path.open('xb') as stream:
        os.chmod(path, 0o600)
        result = subprocess.run(command, stdout=stream, stderr=subprocess.DEVNULL, timeout=600)
        stream.flush(); os.fsync(stream.fileno())
    if result.returncode or not path.stat().st_size:
        raise ValueError('FRESH_BACKUP_COMMAND_FAILED')


def services(engine, project):
    result = {}
    for service in ('admin', 'database'):
        names = engine.run(['docker', 'ps', '-a', '--filter', 'label=com.docker.compose.project=' + project,
            '--filter', 'label=com.docker.compose.service=' + service, '--format', '{{.Names}}']).splitlines()
        if len(names) != 1:
            raise ValueError('ONE_FRESH_COMPOSE_SERVICE_REQUIRED')
        result[service] = engine.container(names[0])
    if (not IMAGE.fullmatch(result['admin']['Config']['Image']) or result['admin']['Config'].get('Entrypoint') != ['node', 'packaging/container/fresh-entrypoint.mjs']
            or result['admin']['Config'].get('User') != '1000:1000' or result['database']['Config']['Image'] != MYSQL_IMAGE):
        raise ValueError('PINNED_FRESH_APPLICATION_REQUIRED')
    if result['database']['HostConfig'].get('PortBindings'):
        raise ValueError('PRIVATE_FRESH_DATABASE_REQUIRED')
    return result


def volume_map(engine, project, containers):
    found = {}
    names = {mount['Name'] for container in containers.values() for mount in container['Mounts'] if mount['Type'] == 'volume'}
    for info in json.loads(engine.run(['docker', 'volume', 'inspect'] + sorted(names))):
        labels = info.get('Labels') or {}
        logical = labels.get('com.docker.compose.volume')
        if labels.get('com.docker.compose.project') != project or logical not in VOLUMES or logical in found:
            raise ValueError('FRESH_PROJECT_VOLUME_MISMATCH')
        found[logical] = info['Name']
    if set(found) != VOLUMES:
        raise ValueError('ALL_SIX_FRESH_VOLUMES_REQUIRED')
    return found


def wait_database(engine, name):
    for _ in range(120):
        info = engine.container(name)
        if info and info['State'].get('Health', {}).get('Status') == 'healthy':
            return
        time.sleep(1)
    raise ValueError('FRESH_DATABASE_NOT_READY')


def backup(project, destination, apply=False, engine=None, state_root='/var/lib/yushuhub-upgrade'):
    engine = engine or Docker()
    destination = Path(destination)
    if not PROJECT.fullmatch(project) or not destination.is_absolute() or destination.exists():
        raise ValueError('NEW_ABSOLUTE_BACKUP_FILE_REQUIRED')
    if not apply:
        return {'action': 'cold-backup-six-volumes', 'project': project, 'output': str(destination), 'applyRequired': True}
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if destination.parent.stat().st_uid != 0 or destination.parent.stat().st_mode & 0o077:
        raise ValueError('ROOT_PRIVATE_BACKUP_DIRECTORY_REQUIRED')
    with locks(state_root, ['host-cutover', 'fresh-backup:' + project]):
        containers = services(engine, project)
        volumes = volume_map(engine, project, containers)
        admin, database = containers['admin'], containers['database']
        if not database['State']['Running']:
            raise ValueError('START_DATABASE_BEFORE_BACKUP')
        image = admin['Config']['Image']
        engine.inspect_image(image)
        was_running = admin['State']['Running']
        database_stopped = False
        with tempfile.TemporaryDirectory(prefix='fresh-backup-', dir=destination.parent) as temporary:
            directory = Path(temporary)
            try:
                if was_running:
                    engine.run(['docker', 'stop', '--time', '30', admin['Name'].lstrip('/')])
                # Dump is an additional portable artifact, not the restore path of this tool.
                dump = 'export MYSQL_PWD=$(cat /run/root-secret/mysql-root); exec mysqldump -uroot --single-transaction --no-tablespaces --skip-lock-tables --set-gtid-purged=OFF yushuhub'
                output(['docker', 'exec', database['Name'].lstrip('/'), 'sh', '-c', dump], directory/'database.sql')
                database_stopped = True
                engine.run(['docker', 'stop', '--time', '60', database['Name'].lstrip('/')], timeout=90)
                for logical, name in sorted(volumes.items()):
                    output(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--user', '0:0', '--cap-drop', 'ALL', '--cap-add', 'DAC_OVERRIDE',
                        '--mount', 'type=volume,source=' + name + ',target=/snapshot,readonly', '--entrypoint', 'tar', image, '-cpf', '-', '-C', '/snapshot', '.'], directory/(logical+'.tar'))
                manifest = {'format': 1, 'kind': 'yushuhub-fresh-cold-backup', 'project': project, 'adminImage': image,
                    'databaseImage': MYSQL_IMAGE, 'method': 'cleanly-stopped-six-volumes', 'dumpRestoreTested': False,
                    'files': {p.name: {'sha256': digest(p), 'bytes': p.stat().st_size} for p in directory.iterdir()}}
                atomic_json(directory/'manifest.json', manifest)
                target = directory/'complete.tar'
                with tarfile.open(target, 'w') as archive:
                    for name in ['manifest.json'] + sorted(manifest['files']):
                        archive.add(directory/name, arcname=name, recursive=False)
                os.chmod(target, 0o600)
                with target.open('rb') as stream:
                    os.fsync(stream.fileno())
                os.replace(target, destination)
            finally:
                if database_stopped:
                    engine.run(['docker', 'start', database['Name'].lstrip('/')])
                    wait_database(engine, database['Name'].lstrip('/'))
                if was_running:
                    engine.run(['docker', 'start', admin['Name'].lstrip('/')])
        return {'stage': 'backup-created', 'project': project, 'archive': str(destination), 'sha256': digest(destination),
                'restoreMethod': 'same-MySQL-image cold volumes', 'dumpRestoreTested': False}


def restore(archive_path, expected, project, apply=False, resume=False, engine=None, state_root='/var/lib/yushuhub-upgrade'):
    engine = engine or Docker()
    archive_path = Path(archive_path)
    if not PROJECT.fullmatch(project) or not re.fullmatch(r'[a-f0-9]{64}', expected) or not archive_path.is_file() or digest(archive_path) != expected:
        raise ValueError('TRUSTED_BACKUP_SHA256_REQUIRED')
    if archive_path.stat().st_uid != 0 or archive_path.stat().st_mode & 0o077:
        raise ValueError('ROOT_PRIVATE_BACKUP_FILE_REQUIRED')
    with locks(state_root, ['host-cutover', 'fresh-backup:' + project]):
        if engine.run(['docker', 'ps', '-a', '--filter', 'label=com.docker.compose.project=' + project, '--format', '{{.ID}}']).strip():
            raise ValueError('RESTORE_REQUIRES_UNUSED_PROJECT_WITHOUT_CONTAINERS')
        with tempfile.TemporaryDirectory(prefix='fresh-restore-', dir=archive_path.parent) as temporary:
            directory = Path(temporary)
            allowed = {'manifest.json', 'database.sql'} | {name+'.tar' for name in VOLUMES}
            with tarfile.open(archive_path, 'r:') as archive:
                entries = archive.getmembers()
                if len(entries) != len(allowed) or {entry.name for entry in entries} != allowed or any(not entry.isfile() for entry in entries):
                    raise ValueError('INVALID_COLD_BACKUP_ARCHIVE')
                for entry in entries:
                    with (directory/entry.name).open('xb') as stream:
                        os.chmod(directory/entry.name, 0o600)
                        source = archive.extractfile(entry)
                        for block in iter(lambda: source.read(1024*1024), b''):
                            stream.write(block)
            manifest = json.loads((directory/'manifest.json').read_text())
            if manifest.get('kind') != 'yushuhub-fresh-cold-backup' or manifest.get('method') != 'cleanly-stopped-six-volumes' or manifest.get('databaseImage') != MYSQL_IMAGE or not IMAGE.fullmatch(manifest.get('adminImage', '')) or set(manifest.get('files', {})) != allowed - {'manifest.json'}:
                raise ValueError('INVALID_COLD_BACKUP_MANIFEST')
            for name, info in manifest['files'].items():
                if digest(directory/name) != info['sha256'] or (directory/name).stat().st_size != info['bytes']:
                    raise ValueError('BACKUP_MEMBER_HASH_MISMATCH')
            # Reject path traversal before the first Docker volume is created.
            for logical in VOLUMES:
                with tarfile.open(directory/(logical+'.tar')) as volume:
                    for entry in volume:
                        if entry.name.startswith('/') or '..' in Path(entry.name).parts:
                            raise ValueError('UNSAFE_VOLUME_ARCHIVE_PATH')
                        if entry.islnk() or entry.issym():
                            if entry.linkname.startswith('/') or '..' in Path(entry.linkname).parts:
                                if not (logical == 'mysql-data' and entry.name in ('./mysql.sock', 'mysql.sock') and entry.linkname == '/var/run/mysqld/mysqld.sock'):
                                    raise ValueError('UNSAFE_VOLUME_ARCHIVE_LINK')
                        elif not entry.isfile() and not entry.isdir():
                            raise ValueError('SPECIAL_VOLUME_ENTRY_NOT_SUPPORTED')
            existing_names = set(engine.run(['docker', 'volume', 'ls', '--format', '{{.Name}}']).splitlines())
            for logical in VOLUMES:
                name = project + '_' + logical
                if name in existing_names:
                    labels = json.loads(engine.run(['docker', 'volume', 'inspect', name]))[0].get('Labels') or {}
                    if not resume or labels.get('io.yushuhub.restore') != expected:
                        raise ValueError('RESTORE_WILL_NOT_OVERWRITE_EXISTING_VOLUMES')
            if not apply:
                return {'action': 'restore-cold-six-volumes', 'newProject': project, 'adminImage': manifest['adminImage'], 'databaseImage': MYSQL_IMAGE, 'applyRequired': True}
            engine.inspect_image(manifest['adminImage'], pull=True)
            for logical in sorted(VOLUMES):
                name = project + '_' + logical
                if name not in existing_names:
                    engine.run(['docker', 'volume', 'create', '--label', 'com.docker.compose.project=' + project,
                        '--label', 'com.docker.compose.volume=' + logical, '--label', 'io.yushuhub.restore=' + expected, name])
                with (directory/(logical+'.tar')).open('rb') as stream:
                    result = subprocess.run(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--user', '0:0', '--cap-drop', 'ALL',
                        '--cap-add', 'CHOWN', '--cap-add', 'FOWNER', '--cap-add', 'DAC_OVERRIDE',
                        '--mount', 'type=volume,source=' + name + ',target=/restore', '--entrypoint', 'tar', manifest['adminImage'], '-xpf', '-', '-C', '/restore'],
                        stdin=stream, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=600)
                if result.returncode:
                    raise ValueError('VOLUME_RESTORE_INCOMPLETE_USE_EXPLICIT_RESUME')
            receipt = {'stage': 'volumes-restored-not-yet-started', 'project': project, 'backupSha256': expected,
                'adminImage': manifest['adminImage'], 'databaseImage': MYSQL_IMAGE,
                'next': 'Import the matching pinned Compose using this exact project name; verify login, authorization and retained records.',
                'dumpRestoreTested': False}
            atomic_json(Path(state_root)/'fresh-restores'/(project+'.json'), receipt)
            return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='action', required=True)
    b = commands.add_parser('backup'); b.add_argument('--project', required=True); b.add_argument('--output', required=True); b.add_argument('--apply', action='store_true')
    r = commands.add_parser('restore'); r.add_argument('--project', required=True); r.add_argument('--archive', required=True); r.add_argument('--sha256', required=True); r.add_argument('--apply', action='store_true'); r.add_argument('--resume', action='store_true')
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise ValueError('ROOT_MAINTAINER_REQUIRED')
    result = backup(args.project, args.output, args.apply) if args.action == 'backup' else restore(args.archive, args.sha256, args.project, args.apply, args.resume)
    print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        code = str(error)
        print(json.dumps({'error': code if re.fullmatch(r'[A-Z][A-Z0-9_]{0,120}', code) else 'FRESH_BACKUP_OR_RESTORE_FAILED'}))
        raise SystemExit(1)
