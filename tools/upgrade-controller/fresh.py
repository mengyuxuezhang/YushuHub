"""Adopt a completed, pinned fresh Compose application; never runs panel YAML as root.

Only the admin container is replaced. Database, networks and named volumes remain.
The existing signed catalog, request receipts, Unix socket and host locks are reused.
"""
import hashlib
import json
import os
import re
import subprocess
import time
import tempfile
import urllib.request
from pathlib import Path
from urllib.parse import urlparse
from controller import Controller, IMAGE, ID, TERMINAL, private_json_snapshot
from state import Journal, atomic_json, locks

MYSQL_IMAGE = 'mysql:8.4@sha256:a81d043930e51745522bd5c430961cf8286f0a23f0a9a2a6e0108f7ea71b0902'


def sha(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def projection(container):
    config, host = container['Config'], container['HostConfig']
    env = sorted(v for v in config.get('Env', []) if not v.startswith('YUSHUHUB_INSTALL_TOKEN='))
    return {'user': config.get('User'), 'entrypoint': config.get('Entrypoint'), 'command': config.get('Cmd'),
        'env': env, 'readonly': host.get('ReadonlyRootfs'), 'privileged': host.get('Privileged'),
        'caps': sorted(host.get('CapDrop') or []), 'addCaps': sorted(host.get('CapAdd') or []),
        'security': sorted(host.get('SecurityOpt') or []), 'memory': host.get('Memory'),
        'restart': host.get('RestartPolicy', {}).get('Name'), 'ports': host.get('PortBindings'),
        'mounts': sorted([{'type': m['Type'], 'name': m.get('Name'), 'source': m['Source'] if m['Type'] == 'bind' else None,
                          'target': m['Destination'], 'rw': m['RW']} for m in container['Mounts']], key=lambda x: x['target']),
        'networks': sorted(container['NetworkSettings']['Networks']), 'tmpfs': host.get('Tmpfs') or {},
        'logging': host.get('LogConfig'), 'init': host.get('Init')}


def checked_template(container, instance):
    p = projection(container)
    if (p['user'] != '1000:1000' or p['entrypoint'] != ['node', 'packaging/container/fresh-entrypoint.mjs']
        or p['command'] not in (None, []) or not p['readonly'] or p['privileged']
        or p['caps'] != ['ALL'] or p['addCaps'] or p['security'] != ['no-new-privileges:true']
        or p['restart'] != 'unless-stopped' or not p['init'] or not 256 * 1024**2 <= p['memory'] <= 4096 * 1024**2):
        raise ValueError('FRESH_RUNTIME_POLICY_MISMATCH')
    bindings = p['ports'] or {}
    if set(bindings) != {'7077/tcp'} or len(bindings['7077/tcp']) != 1 or bindings['7077/tcp'][0]['HostIp'] != '127.0.0.1':
        raise ValueError('FRESH_LOOPBACK_PORT_REQUIRED')
    port = int(bindings['7077/tcp'][0]['HostPort'])
    if not 1 <= port <= 65535:
        raise ValueError('INVALID_FRESH_PORT')
    expected = {'/app/data': True, '/app/logs': True, '/app/published': True, '/run/yushuhub': False}
    if {m['target'] for m in p['mounts']} != set(expected) | {'/run/yushuhub-upgrade'}:
        raise ValueError('FRESH_PERSISTENT_MOUNTS_MISMATCH')
    for mount in p['mounts']:
        if mount['target'] == '/run/yushuhub-upgrade':
            if mount['type'] != 'bind' or mount['rw'] or mount['source'] != '/run/yushuhub-upgrade/' + instance:
                raise ValueError('FRESH_SOCKET_BINDING_MISMATCH')
        elif mount['type'] != 'volume' or mount['rw'] != expected[mount['target']] or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', mount['name'] or ''):
            raise ValueError('FRESH_NAMED_VOLUMES_REQUIRED')
    if len(p['networks']) != 2 or p['logging'] != {'Type': 'json-file', 'Config': {'max-file': '3', 'max-size': '10m'}}:
        raise ValueError('FRESH_NETWORK_OR_LOG_POLICY_MISMATCH')
    environment = dict(v.split('=', 1) for v in p['env'])
    fixed = {'AI_DB_HOST': 'database', 'AI_DB_NAME': 'yushuhub', 'AI_DB_USER': 'yushuhub',
             'AI_DB_PASSWORD_FILE': '/run/yushuhub/mysql-app', 'AI_ADMIN_PORT': '7077',
             'AI_ADMIN_UPGRADE_INSTANCE_ID': instance, 'AI_ADMIN_UPGRADE_SOCKET': '/run/yushuhub-upgrade/control.sock'}
    if any(environment.get(k) != v for k, v in fixed.items()) or environment.get('AI_FRESH_ALLOW_HTTP'):
        raise ValueError('FRESH_RUNTIME_ENVIRONMENT_MISMATCH')
    return p, port


class FreshController(Controller):
    def config(self, instance):
        if not ID.fullmatch(instance):
            raise ValueError('INVALID_INSTANCE_ID')
        cfg, fingerprint = private_json_snapshot(self.config_root / 'instances' / (instance + '.json'))
        if cfg.get('instanceId') != instance or cfg.get('deploymentMode') != 'fresh-compose':
            raise ValueError('FRESH_REGISTRATION_REQUIRED')
        cfg['_registrationSha256'] = fingerprint
        cfg['stateDir'] = str(self.root / 'instances' / instance)
        return cfg

    def current(self, cfg):
        return private_json_snapshot(Path(cfg['stateDir']) / 'current.json')[0]

    def inspect_runtime(self, cfg, release):
        self.check_database(cfg)
        container = self.engine.container(cfg['containerName'])
        if not container or container['Config']['Image'] != release['image'] or sha(projection(container)) != cfg['runtimeSha256']:
            raise ValueError('FRESH_RUNTIME_DRIFT')
        return container

    def check_database(self, cfg):
        database = self.engine.container(cfg['databaseContainer'])
        if not database or database['Config']['Image'] != MYSQL_IMAGE or sha(projection(database)) != cfg['databaseSha256']:
            raise ValueError('FRESH_DATABASE_CONFIGURATION_DRIFT')

    def identity(self, cfg):
        # Installation identity and encryption key must already exist, never generate them here.
        script = "import fs from 'node:fs';import c from 'node:crypto';const s=JSON.parse(fs.readFileSync('/app/data/fresh-install.json'));if(s.stage!=='complete')throw Error();const k=fs.readFileSync('/app/data/model-credentials.key');if(k.length!==32)throw Error();console.log(JSON.stringify({installationId:s.installationId,publicUrl:s.publicUrl,configuration:c.createHash('sha256').update(JSON.stringify(s)).digest('hex'),key:c.createHash('sha256').update(k).digest('hex')}))"
        return json.loads(self.engine.run(['docker', 'exec', cfg['containerName'], 'node', '--input-type=module', '-e', script]))

    def verify(self, cfg, release, authorization=None):
        end, stable = time.monotonic() + 180, 0
        while time.monotonic() < end:
            try:
                container = self.inspect_runtime(cfg, release)
                if not container['State']['Running'] or container['State'].get('Health', {}).get('Status') != 'healthy':
                    raise ValueError('FRESH_NOT_HEALTHY')
                for site in ['http://127.0.0.1:' + str(cfg['port']), cfg['publicUrl']]:
                    with urllib.request.urlopen(site + '/readyz', timeout=5) as response:
                        if not json.load(response).get('ready'):
                            raise ValueError('FRESH_NOT_READY')
                    with urllib.request.urlopen(site + '/api/runtime-info', timeout=5) as response:
                        if json.load(response).get('data', {}).get('version') != release['version']:
                            raise ValueError('FRESH_VERSION_MISMATCH')
                    with urllib.request.urlopen(site + '/admin/v2/', timeout=5) as response:
                        html = response.read()
                    if hashlib.sha256(html).hexdigest() != release['htmlSha256']:
                        raise ValueError('FRESH_FRONTEND_MISMATCH')
                    for asset in re.findall(rb'(?:src|href)="(/admin/v2/assets/[^"?]+\.(?:js|css))"', html):
                        with urllib.request.urlopen(site + asset.decode(), timeout=5) as response:
                            if not response.read(1):
                                raise ValueError('FRESH_ASSET_MISSING')
                if self.identity(cfg) != cfg['installation']:
                    raise ValueError('FRESH_IDENTITY_CHANGED')
                if authorization and self.engine.authorization_probe(cfg, use_container=True)['identityHash'] != authorization:
                    raise ValueError('FRESH_AUTHORIZATION_CHANGED')
                stable += 1
                if stable >= 3:
                    return
            except Exception:
                stable = 0
            time.sleep(1)
        raise ValueError('FRESH_HEALTH_VERIFICATION_FAILED')

    def plan(self, instance, release_name):
        cfg, target = self.config(instance), self.release(release_name)
        old = self.current(cfg)['release']
        self.inspect_runtime(cfg, old)
        if target['image'] == old['image']:
            raise ValueError('ALREADY_RUNNING_APPROVED_IMAGE')
        if old['version'] not in target['supportedFrom'] or target.get('migrationPolicy') != 'same-schema' or any(target[k] != old[k] for k in ('schemaSha256', 'migrationSha256')):
            raise ValueError('FRESH_SAME_SCHEMA_RELEASE_REQUIRED')
        if self.identity(cfg) != cfg['installation']:
            raise ValueError('FRESH_IDENTITY_CHANGED')
        proof = self.engine.authorization_probe(cfg, use_container=True)
        return {'format': 1, 'instanceId': instance, 'config': cfg, 'old': old, 'target': target,
                'authorization': proof['identityHash'], 'registration': cfg['_registrationSha256']}

    def backup(self, cfg, release, directory):
        directory.mkdir(parents=True, mode=0o700)
        # Admin is stopped before this call; root DB credential stays inside DB container.
        dump = "export MYSQL_PWD=$(cat /run/root-secret/mysql-root); exec mysqldump -uroot --single-transaction --no-tablespaces --skip-lock-tables --set-gtid-purged=OFF yushuhub"
        commands = [('database.sql', ['docker', 'exec', cfg['databaseContainer'], 'sh', '-c', dump])]
        for mount in cfg['template']['mounts']:
            if mount['type'] != 'volume':
                continue
            commands.append((mount['target'].strip('/').replace('/', '-') + '.tar', ['docker', 'run', '--rm', '--network', 'none', '--read-only', '--user', '0:0', '--cap-drop', 'ALL', '--cap-add', 'DAC_OVERRIDE',
                '--mount', 'type=volume,source=' + mount['name'] + ',target=/snapshot,readonly', '--entrypoint', 'tar', release['image'], '-cpf', '-', '-C', '/snapshot', '.']))
        for name, command in commands:
            path = directory / name
            with path.open('xb') as stream:
                os.chmod(path, 0o600)
                result = subprocess.run(command, stdout=stream, stderr=subprocess.DEVNULL, timeout=300)
                stream.flush()
                os.fsync(stream.fileno())
            if result.returncode or not path.stat().st_size:
                raise ValueError('FRESH_BACKUP_FAILED')

    def replace(self, cfg, release, permitted_images):
        self.check_database(cfg)
        existing = self.engine.container(cfg['containerName'])
        if existing:
            observed = projection(existing)
            # Our own interrupted create may not yet have joined the second network.
            if (not existing['State']['Running'] and existing['Config'].get('Labels', {}).get('io.yushuhub.fresh-controller') == cfg['instanceId']
                    and set(observed['networks']) <= set(cfg['template']['networks'])):
                observed['networks'] = cfg['template']['networks']
            if sha(observed) != cfg['runtimeSha256'] or existing['Config']['Image'] not in permitted_images:
                raise ValueError('FRESH_RUNTIME_DRIFT_REQUIRES_ATTENTION')
            if existing['State']['Running']:
                self.engine.run(['docker', 'stop', '--time', '30', cfg['containerName']])
            self.engine.run(['docker', 'rm', cfg['containerName']])
        p = cfg['template']
        args = ['docker', 'create', '--name', cfg['containerName'], '--user', '1000:1000', '--init', '--read-only',
            '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--restart', 'unless-stopped',
            '--memory', str(p['memory']), '--stop-timeout', '30', '--network', cfg['outboundNetwork'],
            '--publish', '127.0.0.1:' + str(cfg['port']) + ':7077', '--log-driver', 'json-file', '--log-opt', 'max-size=10m', '--log-opt', 'max-file=3',
            '--label', 'com.docker.compose.project=' + cfg['project'], '--label', 'com.docker.compose.service=admin',
            '--label', 'io.yushuhub.fresh-controller=' + cfg['instanceId'],
            '--health-cmd', "node -e \"fetch('http://127.0.0.1:7077/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"",
            '--health-interval', '10s', '--health-timeout', '5s', '--health-retries', '30', '--health-start-period', '60s']
        for value in p['env']:
            args += ['--env', value]
        for target, options in p['tmpfs'].items():
            args += ['--tmpfs', target + ':' + options]
        for mount in p['mounts']:
            source = mount['name'] if mount['type'] == 'volume' else mount['source']
            args += ['--mount', 'type=' + mount['type'] + ',source=' + source + ',target=' + mount['target'] + ('' if mount['rw'] else ',readonly')]
        args += [release['image']]
        self.engine.run(args)
        self.engine.run(['docker', 'network', 'connect', cfg['databaseNetwork'], cfg['containerName']])
        # No user-supplied YAML or executable is passed to the host daemon.
        self.engine.run(['docker', 'start', cfg['containerName']])

    def _apply_locked(self, instance, release_name, operation_id, approved_plan_sha256=None):
        cfg = self.config(instance)
        journal = Journal(cfg['stateDir'])
        previous = journal.read()
        if previous and previous['stage'] not in TERMINAL:
            raise ValueError('PENDING_TRANSACTION_REQUIRES_RECOVER')
        plan = self.plan(instance, release_name)
        record = {'operationId': operation_id, 'plan': plan}
        journal.save(record, 'pulling')
        with locks(self.root, ['database:' + cfg['databaseLockKey']]):
            stopped = False
            try:
                self.engine.inspect_image(plan['target']['image'], pull=True)
                actual = self.engine.image_contract(plan['target']['image'])
                if any(actual[k] != plan['target'][k] for k in ('version', 'htmlSha256', 'schemaSha256', 'migrationSha256')):
                    raise ValueError('FRESH_IMAGE_CONTRACT_MISMATCH')
                self.inspect_runtime(cfg, plan['old'])
                journal.save(record, 'draining')
                stopped = True
                self.engine.run(['docker', 'stop', '--time', '30', cfg['containerName']])
                journal.save(record, 'stopped')
                self.backup(cfg, plan['old'], Path(cfg['stateDir']) / 'backups' / operation_id)
                journal.save(record, 'starting')
                self.replace(cfg, plan['target'], {plan['old']['image'], plan['target']['image']})
                journal.save(record, 'verifying')
                self.verify(cfg, plan['target'], plan['authorization'])
                atomic_json(Path(cfg['stateDir']) / 'current.json', {'release': plan['target'], 'committedOperationId': operation_id})
                journal.save(record, 'committed')
            except Exception:
                if not stopped:
                    journal.save(record, 'rejected', error='FRESH_UPGRADE_REJECTED_BEFORE_STOP')
                else:
                    try:
                        self.replace(cfg, plan['old'], {plan['old']['image'], plan['target']['image']})
                        self.verify(cfg, plan['old'], plan['authorization'])
                        atomic_json(Path(cfg['stateDir']) / 'current.json', {'release': plan['old']})
                        journal.save(record, 'rolled_back', error='FRESH_UPGRADE_ROLLED_BACK')
                    except Exception:
                        journal.save(record, 'needs_attention', error='FRESH_RECOVERY_REQUIRED')
                raise ValueError('FRESH_UPGRADE_INCOMPLETE') from None
        return {'operationId': operation_id, 'stage': record['stage']}

    def _recover_locked(self, instance, rollback_committed):
        cfg = self.config(instance)
        journal = Journal(cfg['stateDir'])
        record = journal.read()
        if not record:
            raise ValueError('NO_TRANSACTION_TO_RECOVER')
        if rollback_committed:
            if record['stage'] not in TERMINAL:
                raise ValueError('PENDING_TRANSACTION_REQUIRES_RECOVER')
            operation = self.current(cfg).get('committedOperationId')
            if operation:
                record = private_json_snapshot(Path(cfg['stateDir']) / 'operations' / (operation + '.json'))[0]
        if record['stage'] in ('rejected', 'rolled_back') or record['stage'] == 'committed' and not rollback_committed:
            return {'stage': record['stage'], 'operationId': record['operationId']}
        plan = record['plan']
        if cfg['_registrationSha256'] != plan['registration']:
            raise ValueError('FRESH_REGISTRATION_DRIFT')
        with locks(self.root, ['database:' + cfg['databaseLockKey']]):
            try:
                self.replace(cfg, plan['old'], {plan['old']['image'], plan['target']['image']})
                self.verify(cfg, plan['old'], plan['authorization'])
                atomic_json(Path(cfg['stateDir']) / 'current.json', {'release': plan['old']})
                journal.save(record, 'rolled_back')
            except Exception:
                journal.save(record, 'needs_attention', error='FRESH_RECOVERY_REQUIRED')
                raise ValueError('FRESH_RECOVERY_REQUIRED') from None
        return {'stage': record['stage'], 'operationId': record['operationId']}


def register_fresh(control, options, apply=False, package=None):
    from catalog import refresh_catalog
    from delivery import controlled, public_fingerprint
    instance, project = options['instance'], options['project']
    if not ID.fullmatch(instance) or not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,62}', project):
        raise ValueError('INVALID_FRESH_INSTANCE_OR_PROJECT')
    if os.geteuid() != 0:
        raise ValueError('ROOT_SETUP_REQUIRED')
    package = Path(package or Path(__file__).resolve().parent)
    controlled(package, directory=True)
    manifest = private_json_snapshot(package / 'release-manifest.json')[0]
    key_id = options['keyId']
    anchor = manifest.get('keys', {}).get(key_id)
    if not anchor or not re.fullmatch(r'keys/[A-Za-z0-9_.-]{1,64}\.pem', anchor['file']):
        raise ValueError('KEY_NOT_IN_VERIFIED_CONTROLLER_PACKAGE')
    key = package / anchor['file']
    controlled(key)
    fingerprint = public_fingerprint(key.read_bytes())
    if fingerprint != anchor['spkiSha256'] or fingerprint != options['keyFingerprint']:
        raise ValueError('TRUSTED_PUBLIC_KEY_FINGERPRINT_MISMATCH')
    with locks(control.root, ['host-cutover', 'instance:' + instance, 'catalog-registration-setup']):
        if list((control.config_root / 'instances').glob('*.json')):
            raise ValueError('SINGLE_MANAGED_INSTANCE_SCOPE_REQUIRES_SEPARATE_PLAN')
        containers = {}
        for service in ('admin', 'database'):
            names = control.engine.run(['docker', 'ps', '-a', '--filter', 'label=com.docker.compose.project=' + project,
                                        '--filter', 'label=com.docker.compose.service=' + service, '--format', '{{.Names}}']).splitlines()
            if len(names) != 1:
                raise ValueError('ONE_FRESH_COMPOSE_SERVICE_REQUIRED')
            containers[service] = control.engine.container(names[0])
        admin, database = containers['admin'], containers['database']
        template, port = checked_template(admin, instance)
        if database['Config']['Image'] != MYSQL_IMAGE or database['HostConfig'].get('PortBindings') or not database['State']['Running']:
            raise ValueError('FRESH_PRIVATE_DATABASE_REQUIRED')
        networks = json.loads(control.engine.run(['docker', 'network', 'inspect'] + template['networks']))
        if any(n.get('Labels', {}).get('com.docker.compose.project') != project for n in networks):
            raise ValueError('FRESH_PROJECT_NETWORK_MISMATCH')
        internal = [n['Name'] for n in networks if n['Internal']]
        outbound = [n['Name'] for n in networks if not n['Internal']]
        if len(internal) != 1 or len(outbound) != 1 or sorted(database['NetworkSettings']['Networks']) != internal:
            raise ValueError('FRESH_INTERNAL_DATABASE_NETWORK_REQUIRED')
        mounts = {m['Destination']: m for m in database['Mounts']}
        if set(mounts) != {'/var/lib/mysql', '/run/root-secret', '/run/app-secret'} or any(m['Type'] != 'volume' for m in mounts.values()):
            raise ValueError('FRESH_DATABASE_VOLUME_POLICY_MISMATCH')
        application_secret = next(m['name'] for m in template['mounts'] if m['target'] == '/run/yushuhub')
        if mounts['/run/app-secret']['Name'] != application_secret or mounts['/run/root-secret']['RW'] or mounts['/run/app-secret']['RW']:
            raise ValueError('FRESH_DATABASE_CREDENTIAL_MOUNTS_MISMATCH')
        cfg = {'instanceId': instance, 'deploymentMode': 'fresh-compose', 'project': project,
            'containerName': admin['Name'].lstrip('/'), 'databaseContainer': database['Name'].lstrip('/'),
            'databaseSha256': sha(projection(database)), 'databaseLockKey': sha(mounts['/var/lib/mysql']['Name']),
            'port': port, 'template': template, 'runtimeSha256': sha(template),
            'databaseNetwork': internal[0], 'outboundNetwork': outbound[0],
            'catalogUrl': options['catalogUrl'], 'catalogPublicKeys': {key_id: str(key)},
            'stateDir': str(control.root / 'instances' / instance), 'webControlEnabled': True}
        with tempfile.TemporaryDirectory(prefix='yushuhub-fresh-registration-') as temporary:
            scratch = FreshController(Path(temporary) / 'state', Path(temporary) / 'config', engine=control.engine)
            temporary_cfg = dict(cfg, stateDir=str(Path(temporary) / 'cache'))
            _, warning = refresh_catalog(scratch, temporary_cfg)
            if warning:
                raise ValueError('FRESH_VERIFIED_CATALOG_REQUIRED')
            release = scratch.release(options['initialRelease'])
            if release['image'] != admin['Config']['Image']:
                raise ValueError('FRESH_RUNNING_APPROVED_IMAGE_REQUIRED')
            control.engine.inspect_image(release['image'])
            contract = control.engine.image_contract(release['image'])
            if any(contract[k] != release[k] for k in ('version', 'htmlSha256', 'schemaSha256', 'migrationSha256')):
                raise ValueError('FRESH_IMAGE_CONTRACT_MISMATCH')
            cfg['installation'] = control.identity(cfg)
            cfg['publicUrl'] = cfg['installation']['publicUrl']
            origin = urlparse(cfg['publicUrl'])
            if origin.scheme != 'https' or not origin.hostname or origin.username or origin.password or origin.query or origin.fragment or origin.path:
                raise ValueError('FRESH_HTTPS_ORIGIN_REQUIRED')
            control.verify(cfg, release)
            public = {'action': 'adopt-completed-fresh-compose', 'instanceId': instance, 'project': project,
                'version': release['version'], 'image': release['image'], 'port': port, 'publicUrl': cfg['publicUrl'],
                'configurationSha256': sha(cfg), 'applicationChanged': False, 'applyRequired': not apply}
            if apply:
                # Recheck the live definition immediately before installing the root registration.
                control.inspect_runtime(cfg, release)
                for entry in (scratch.config_root / 'releases').glob('*.json'):
                    atomic_json(control.config_root / 'releases' / entry.name, json.loads(entry.read_text()))
                atomic_json(Path(cfg['stateDir']) / 'verified-catalog.json', json.loads((Path(temporary_cfg['stateDir']) / 'verified-catalog.json').read_text()))
                atomic_json(Path(cfg['stateDir']) / 'current.json', {'release': release})
                atomic_json(control.config_root / 'instances' / (instance + '.json'), cfg)
            return public
