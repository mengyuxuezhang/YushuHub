"""Root setup for existing instances only. Plans never change application or registration."""
import argparse
import hashlib
import json
import os
import re
import sys
import tempfile
from pathlib import Path
from catalog import refresh_catalog
from controller import Controller, ID, read_private_json, source_configuration_closure, review_plan_digest
from delivery import canonical, controlled, public_fingerprint, runtime_paths
from scan import inventory, read_env
from state import atomic_json, locks


def registration_plan(control, options, package=None):
    package = Path(package or Path(__file__).resolve().parent)
    instance = options['instance']
    if not ID.fullmatch(instance):
        raise ValueError('INVALID_INSTANCE_ID')
    app = Path(options['appRoot'])
    if not app.is_absolute() or not app.is_dir() or app.is_symlink() or app.resolve() != app or app == Path('/'):
        raise ValueError('CANONICAL_EXISTING_APPLICATION_REQUIRED')
    registration = control.config_root / 'instances' / (instance + '.json')
    if registration.exists() or registration.is_symlink():
        raise ValueError('INSTANCE_ALREADY_REGISTERED')
    controlled(package, directory=True)
    manifest = read_private_json(package / 'release-manifest.json')
    anchor = manifest.get('keys', {}).get(options['keyId'])
    if not anchor or not re.fullmatch(r'keys/[A-Za-z0-9_.-]{1,64}\.pem', anchor['file']):
        raise ValueError('KEY_NOT_IN_VERIFIED_CONTROLLER_PACKAGE')
    key = package / anchor['file']
    controlled(key)
    fingerprint = public_fingerprint(key.read_bytes())
    if fingerprint != anchor['spkiSha256'] or fingerprint != options['keyFingerprint']:
        raise ValueError('TRUSTED_PUBLIC_KEY_FINGERPRINT_MISMATCH')
    before = source_configuration_closure(app)
    scan = inventory(app)
    review = {'CENTER_AUTHORIZATION_REQUIRES_RUNTIME_VALIDATION', 'SAVED_AUTHORIZATION_REQUIRES_RUNTIME_VALIDATION', 'AUTHORIZATION_MODE_REQUIRES_REVIEW'}
    if set(scan['issues']) - review or len(scan['pm2']) != 1 or scan['pm2'][0]['status'] != 'online':
        raise ValueError('SOURCE_SCAN_REQUIRES_REVIEW')
    source_env = read_env(app)
    if (source_env.get('AI_DB_HOST') or '127.0.0.1').lower() not in ('127.0.0.1', 'localhost', '::1'):
        raise ValueError('LOCAL_EXCLUSIVE_DATABASE_REQUIRED')
    process = scan['pm2'][0]
    rows = [row for row in control.engine.pm2_processes() if row.get('pid') == process['pid']
            and Path(row.get('pm2_env', {}).get('pm_cwd', '/')).resolve() == app]
    if len(rows) != 1 or rows[0]['pm2_env'].get('exec_mode', 'fork_mode') != 'fork_mode' or Path(rows[0]['pm2_env'].get('pm_exec_path', '')).resolve() != app/'cloud/ai-admin/server.mjs':
        raise ValueError('SINGLE_PM2_FORK_INSTANCE_REQUIRED')
    uid = re.search(r'^Uid:\s+(\d+)', Path('/proc/'+str(process['pid'])+'/status').read_text(), re.M)
    if not uid or uid[1] != '0':
        raise ValueError('ROOT_PM2_INSTANCE_REQUIRED')
    memory, reserve = int(options['memoryMiB']), int(options['hostReserveMiB'])
    if not 128 <= memory <= 4096 or reserve < 96:
        raise ValueError('INVALID_MEMORY_BUDGET')
    dump = Path(options['mysqldump'])
    if not dump.is_absolute() or not dump.is_file() or not os.access(dump, os.X_OK):
        raise ValueError('MYSQLDUMP_UNAVAILABLE')
    cfg = {'instanceId': instance, 'appRoot': str(app), 'port': scan['port'],
        'databaseExclusive': True, 'databaseLockKey': before['databaseLockKey'],
        'memoryMiB': memory, 'hostReserveMiB': reserve, 'mysqldump': str(dump),
        'catalogUrl': options['catalogUrl'], 'catalogPublicKeys': {options['keyId']: str(key)},
        'webControlEnabled': True, 'migrationInitialRelease': options['initialRelease']}
    public_url = options.get('publicUrl') or source_env.get('AI_ADMIN_PUBLIC_URL')
    if public_url:
        from urllib.parse import urlparse
        origin = urlparse(public_url)
        if origin.scheme not in ('http', 'https') or not origin.hostname or origin.username or origin.password or origin.query or origin.fragment or origin.path not in ('', '/'):
            raise ValueError('INVALID_PUBLIC_ORIGIN')
        cfg['publicUrl'] = public_url.rstrip('/')
        if source_env.get('AI_ADMIN_PUBLIC_URL') and cfg['publicUrl'] != source_env['AI_ADMIN_PUBLIC_URL'].rstrip('/'):
            raise ValueError('PUBLIC_ORIGIN_DIFFERS_FROM_EXISTING_INSTANCE')
    existing = list((control.config_root / 'instances').glob('*.json'))
    if existing:
        raise ValueError('SINGLE_MANAGED_INSTANCE_SCOPE_REQUIRES_SEPARATE_PLAN')
    old = control.engine.source_contract(str(app))
    proof = control.engine.authorization_probe(cfg)
    if not proof.get('verified') or not re.fullmatch(r'[a-f0-9]{64}', proof.get('identityHash', '')):
        raise ValueError('SOURCE_IDENTITY_NOT_VERIFIED')
    # Metadata verification may use disposable scratch files/OpenSSL, but all catalog
    # registration/cache writes stay in the temporary directory during the plan.
    with tempfile.TemporaryDirectory(prefix='yushuhub-registration-plan-') as temporary:
        scratch = Controller(Path(temporary) / 'state', Path(temporary) / 'config')
        catalog_cfg = dict(cfg, stateDir=str(Path(temporary) / 'catalog'))
        latest, warning = refresh_catalog(scratch, catalog_cfg)
        if warning:
            raise ValueError('FRESH_VERIFIED_CATALOG_REQUIRED')
        releases = {p.stem: json.loads(p.read_text()) for p in (scratch.config_root / 'releases').glob('*.json')}
        cache = json.loads((Path(catalog_cfg['stateDir']) / 'verified-catalog.json').read_text())
    initial = releases.get(options['initialRelease'])
    if not initial or scan['runningVersion'] != old['version'] or initial['version'] != old['version'] or old['version'] not in initial['supportedFrom']:
        raise ValueError('VERIFIED_SAME_VERSION_MIGRATION_RELEASE_REQUIRED')
    if any(initial[k] != old[k] for k in ('htmlSha256', 'schemaSha256', 'migrationSha256')):
        raise ValueError('SOURCE_AND_MIGRATION_IMAGE_CONTRACT_DIFFER')
    if before != source_configuration_closure(app):
        raise ValueError('SOURCE_CONFIGURATION_CHANGED_DURING_PLAN')
    if before['databaseLockKey'] != scan['databaseLockKey']:
        raise ValueError('EFFECTIVE_DATABASE_DIFFERS_FROM_ENV_FILE')
    reviewed = {'format': 1, 'registration': cfg, 'sourceClosure': before,
        'identityHash': proof['identityHash'], 'sourceVersion': old['version'],
        'pm2': scan['pm2'], 'catalogPayloadSha256': hashlib.sha256(cache['payload'].encode()).hexdigest(),
        'catalogGeneration': cache['generation'], 'publicKeySpkiSha256': fingerprint}
    plan = {'action': 'register-existing-pm2', 'instanceId': instance, 'appRoot': str(app), 'port': scan['port'],
        'publicOrigin': cfg.get('publicUrl'), 'sourceVersion': old['version'],
        'initialRelease': options['initialRelease'], 'latestRelease': latest, 'authorizationMode': proof['mode'],
        'identitySha256': proof['identityHash'], 'databaseLocatorSha256': before['databaseLockKey'],
        'catalogGeneration': cache['generation'], 'publicKeySpkiSha256': fingerprint,
        'reviewSha256': hashlib.sha256(canonical(reviewed)).hexdigest(),
        'databaseOwnershipConfirmationRequired': True, 'applicationChanged': False}
    return plan, cfg, releases, cache


def register(control, options, reviewed, database_reviewed=False, package=None, runtime_policy=None):
    if os.geteuid() != 0:
        raise ValueError('ROOT_SETUP_REQUIRED')
    if not database_reviewed:
        raise ValueError('EXPLICIT_DATABASE_OWNERSHIP_CONFIRMATION_REQUIRED')
    if not re.fullmatch(r'[a-f0-9]{64}', reviewed or ''):
        raise ValueError('REVIEWED_PLAN_SHA_REQUIRED')
    with locks(control.root, ['host-cutover', 'instance:' + options['instance'], 'catalog-registration']):
        plan, cfg, releases, cache = registration_plan(control, options, package)
        if reviewed != plan['reviewSha256']:
            raise ValueError('REGISTRATION_PLAN_CHANGED')
        with locks(control.root, ['database:' + cfg['databaseLockKey']]):
            for release_id, release in releases.items():
                path = control.config_root / 'releases' / (release_id + '.json')
                if path.exists():
                    if read_private_json(path) != release:
                        raise ValueError('IMMUTABLE_RELEASE_ALREADY_EXISTS')
            for release_id, release in releases.items():
                path = control.config_root / 'releases' / (release_id + '.json')
                if not path.exists():
                    atomic_json(path, release)
            runtime_paths(options['instance'], runtime_policy or Path('/etc/tmpfiles.d/yushuhub-upgrade.conf'), apply=True)
            atomic_json(control.root / 'instances' / options['instance'] / 'verified-catalog.json', cache)
            # Publish registration last. No application, PM2, service or DB writes.
            atomic_json(control.config_root / 'instances' / (options['instance'] + '.json'), cfg)
    return {'stage': 'registered', 'instanceId': options['instance'], 'applicationChanged': False}


def migration_plan(control, instance):
    cfg = control.config(instance)
    release = cfg.get('migrationInitialRelease')
    if not release:
        raise ValueError('REGISTERED_MIGRATION_RELEASE_REQUIRED')
    plan = control.plan(instance, release)
    if plan['oldMode'] != 'pm2':
        raise ValueError('INSTANCE_ALREADY_MIGRATED_USE_CONTROLLER_UPGRADE')
    return {'action': 'migrate-existing-pm2', 'instanceId': instance, 'releaseId': release,
        'sourceVersion': plan['old']['version'], 'targetVersion': plan['target']['version'],
        'image': plan['target']['image'], 'identitySha256': plan['authorization']['identityHash'],
        'reviewSha256': review_plan_digest(plan), 'applyRequired': True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='action', required=True)
    for action in ('plan-registration', 'register'):
        sub = commands.add_parser(action)
        for option in ('instance', 'app-root', 'catalog-url', 'key-id', 'key-fingerprint', 'initial-release', 'mysqldump'):
            sub.add_argument('--' + option, required=True)
        sub.add_argument('--public-url')
        sub.add_argument('--memory-mib', type=int, default=256)
        sub.add_argument('--host-reserve-mib', type=int, default=128)
        if action == 'register':
            sub.add_argument('--review-sha', required=True)
            sub.add_argument('--database-reviewed', action='store_true')
            sub.add_argument('--apply', action='store_true')
    for action in ('plan-migration', 'migrate'):
        sub = commands.add_parser(action)
        sub.add_argument('--instance', required=True)
        if action == 'migrate':
            sub.add_argument('--review-sha', required=True)
            sub.add_argument('--operation-id', required=True)
            sub.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    control = Controller()
    if args.action in ('plan-registration', 'register'):
        options = {'instance': args.instance, 'appRoot': args.app_root, 'catalogUrl': args.catalog_url,
            'keyId': args.key_id, 'keyFingerprint': args.key_fingerprint, 'initialRelease': args.initial_release,
            'mysqldump': args.mysqldump, 'publicUrl': args.public_url,
            'memoryMiB': args.memory_mib, 'hostReserveMiB': args.host_reserve_mib}
        result = register(control, options, args.review_sha, args.database_reviewed) if args.action == 'register' and args.apply else registration_plan(control, options)[0]
    elif args.action == 'migrate' and args.apply:
        if os.geteuid() != 0:
            raise ValueError('ROOT_SETUP_REQUIRED')
        cfg = control.config(args.instance)
        result = control.apply(args.instance, cfg['migrationInitialRelease'], args.operation_id, approved_plan_sha256=args.review_sha)
    else:
        result = migration_plan(control, args.instance)
    print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        code = str(error)
        print(json.dumps({'error': code if re.fullmatch(r'[A-Z][A-Z0-9_]{0,120}', code) else 'CONTROLLER_SETUP_FAILED'}))
        sys.exit(1)
