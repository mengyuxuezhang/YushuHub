"""Read-only, standard-library inventory. Never exports environment values or credentials."""
import hashlib
import json
import os
import platform
import re
import shutil
import socket
import subprocess
import urllib.request
from pathlib import Path

PATH_DEFAULTS = {
    'AI_UPLOAD_DIR': 'data/uploads', 'AI_UPDATE_ROOT': 'release/published-ai',
    'AI_PREVIEW_ROOT': 'release/ai-staging', 'AI_ADMIN_UPDATE_WORK_DIR': 'data/self-update',
    'AI_CURATED_SKILL_ROOT': 'data/curated-skills',
    'AI_CURATED_SKILL_KEK_PATH': 'data/curated-skill-market.key',
    'AI_CURATED_SKILL_SIGNING_PRIVATE_PATH': 'data/curated-skill-signing-private.pem',
    'AI_CURATED_SKILL_SIGNING_PUBLIC_PATH': 'data/curated-skill-signing-public.pem',
    'AI_CUSTOM_HOMEPAGE_ROOT': 'data/custom-homepage',
    'AI_MODEL_CREDENTIAL_KEY_PATH': 'data/model-credentials.key',
    'AI_VOICE_ARTIFACT_ROOT': 'data/voice-artifacts',
    'AI_PAYMENT_SECRET_FILE': 'data/payment-secret.key',
    'AI_LICENSE_STATE_FILE': 'data/deployment-license.json',
}
PATH_KEYS = set(PATH_DEFAULTS) | {'AI_LICENSE_PUBLIC_KEYS_FILE', 'AI_WORKER_IDENTITIES_FILE',
    'AI_OFFICIAL_SUBJECT_BINDINGS_FILE'}


JS_WHITESPACE = '\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'


def parse_env_text(text):
    if '\x00' in text:
        raise ValueError('ENV_BINARY_VALUES_UNSUPPORTED')
    result = {}
    for line in text.split('\n'):
        line = line.strip(JS_WHITESPACE)
        if not line or line.startswith('#') or '=' not in line:
            continue
        index = line.index('=')
        if index <= 0:
            continue
        key, value = line[:index].strip(JS_WHITESPACE), line[index + 1:].strip(JS_WHITESPACE)
        if value and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        # Match load-local-env.mjs: inherited environment wins, then the first file entry.
        result.setdefault(key, value)
    return result


def read_env(root):
    # read_bytes avoids Python universal-newline conversion changing literal secret characters.
    return parse_env_text((Path(root) / '.env').read_bytes().decode('utf-8'))


def command(args):
    return subprocess.run(args, capture_output=True, text=True, timeout=20, check=True).stdout


def pm2_daemon_available():
    home = Path(os.environ.get('PM2_HOME') or Path.home() / '.pm2')
    path = home / 'rpc.sock'
    try:
        with socket.socket(socket.AF_UNIX) as client:
            client.settimeout(.5)
            client.connect(str(path))
        return True
    except (FileNotFoundError, ConnectionRefusedError):
        # Only a missing/refused endpoint plus no live daemon is evidence of absence.
        # Timeouts, denied access and other errors must never become an empty jlist.
        try:
            pid = int((home / 'pm2.pid').read_text().strip())
            if pid <= 0:
                raise ValueError('PM2_DAEMON_STATE_UNKNOWN')
            os.kill(pid, 0)
        except (FileNotFoundError, ProcessLookupError):
            return False
        except (OSError, ValueError):
            raise ValueError('PM2_DAEMON_STATE_UNKNOWN') from None
        raise ValueError('PM2_DAEMON_STATE_UNKNOWN')
    except (OSError, AttributeError):
        raise ValueError('PM2_DAEMON_STATE_UNKNOWN') from None


def parse_pm2_list(output):
    # PM2 may prefix its first jlist with daemon startup banners. Only accept a
    # complete trailing JSON array with the expected process shape, never log fragments.
    cleaned = re.sub(r'\x1b\[[0-9;?]*[A-Za-z]', '', output)
    decoder = json.JSONDecoder()
    offset = 0
    for line in cleaned.splitlines(keepends=True):
        if line.lstrip().startswith('['):
            candidate = cleaned[offset:].lstrip()
            try:
                rows, end = decoder.raw_decode(candidate)
                if isinstance(rows, list) and not candidate[end:].strip() and all(isinstance(p, dict) and isinstance(p.get('name'), str) and isinstance(p.get('pm2_env'), dict) for p in rows):
                    return rows
            except ValueError:
                pass
        offset += len(line)
    raise ValueError('INVALID_PM2_PROCESS_LIST')


def database_lock_key(env):
    host = (env.get('AI_DB_HOST') or '127.0.0.1').lower()
    try:
        port = int(env.get('AI_DB_PORT') or '3306')
    except (ValueError, TypeError):
        raise ValueError('INVALID_DATABASE_PORT') from None
    if not 1 <= port <= 65535:
        raise ValueError('INVALID_DATABASE_PORT')
    locator = ['127.0.0.1' if host in ('localhost', '::1') else host, str(port), env.get('AI_DB_NAME') or 'agent_ai']
    return hashlib.sha256(json.dumps(locator).encode()).hexdigest()


def runtime(port):
    with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/runtime-info', timeout=5) as response:
        data = json.load(response)
    if data.get('success') is not True or not data.get('data', {}).get('version'):
        raise ValueError('runtime endpoint missing version')
    return data['data']


def inventory(root, pm2_rows=None, runtime_reader=runtime):
    root = Path(root).resolve(strict=True)
    package = json.loads((root / 'package.json').read_text(encoding='utf-8-sig'))
    if package.get('name') != 'agent-ai-admin':
        raise ValueError('NOT_ADMIN_INSTANCE')
    file_env = read_env(root)
    issues = []
    if pm2_rows is None:
        if not pm2_daemon_available():
            raise ValueError('PM2_DAEMON_NOT_RUNNING')
        pm2_rows = parse_pm2_list(command(['pm2', 'jlist']))
    matches = [p for p in pm2_rows if Path(p.get('pm2_env', {}).get('pm_cwd', '/')).resolve() == root]
    online = [p for p in matches if p.get('pm2_env', {}).get('status') == 'online']
    if len(online) != 1:
        issues.append('EXPECTED_ONE_ONLINE_PM2_PROCESS')
    inherited = {}
    selected = online[0].get('pm2_env', {}) if len(online) == 1 else {}
    nested = selected.get('env', {})
    if not isinstance(nested, dict):
        issues.append('INVALID_PM2_ENVIRONMENT')
        nested = {}
    for key, value in nested.items():
        if key.startswith('AI_'):
            if not isinstance(value, str):
                issues.append('INVALID_PM2_ENVIRONMENT')
            else:
                inherited[key] = value
    for key, value in selected.items():
        if key.startswith('AI_'):
            if not isinstance(value, str):
                issues.append('INVALID_PM2_ENVIRONMENT')
                continue
            if key in inherited and inherited[key] != value:
                issues.append('AMBIGUOUS_PM2_ENVIRONMENT')
            inherited[key] = value
    env = dict(file_env, **inherited)
    overrides = sorted(key for key in inherited if key not in file_env or inherited[key] != file_env[key])
    if overrides:
        # Report effective paths/DB accurately but block conversion until these values can be preserved.
        issues.append('PM2_ENV_DIFFERS_FROM_ENV_FILE')
    try:
        port = int(env.get('AI_ADMIN_PORT', '7077'))
    except (ValueError, TypeError):
        raise ValueError('INVALID_PORT') from None
    if not 1 <= port <= 65535:
        raise ValueError('INVALID_PORT')
    running = {}
    try:
        running = runtime_reader(port)
        if running.get('version') != package['version']:
            issues.append('DISK_RUNTIME_VERSION_MISMATCH')
    except Exception:
        issues.append('RUNTIME_INFO_UNAVAILABLE')
    paths = []
    defaults = dict(PATH_DEFAULTS)
    defaults['AI_PREVIEW_ROOT'] = str(Path(env.get('AI_UPDATE_ROOT') or root / defaults['AI_UPDATE_ROOT']).parent / 'ai-staging')
    for key in sorted(PATH_KEYS):
        value = env.get(key) or defaults.get(key)
        if not value:
            continue
        item = Path(value)
        if not item.is_absolute():
            item = root / item
        resolved = item.resolve()
        paths.append({'key': key, 'path': str(resolved), 'exists': resolved.exists(), 'symlink': item.is_symlink(),
                      'external': os.path.commonpath([str(resolved), str(root)]) != str(root)})
        if key.endswith(('_FILE', '_PATH')) and env.get(key) and not resolved.exists():
            issues.append('CONFIGURED_FILE_MISSING:' + key)
    unknown = sorted(key for key, value in env.items() if value and re.match(r'^AI_.*_(?:PATH|FILE|DIR|ROOT)$', key) and key not in PATH_KEYS)
    if unknown:
        issues.append('UNREVIEWED_PATH_CONFIGURATION')
    legacy_upload = root / 'cloud/ai-admin/uploads'
    if legacy_upload.exists() and any(legacy_upload.iterdir()):
        issues.append('LEGACY_UPLOADS_REQUIRE_MAPPING')
    # Hash only the database locator; credentials never leave this process.
    db_key = database_lock_key(env)
    mode = env.get('AI_AUTHORIZATION_MODE')
    if mode and mode not in ('center', 'legacy'):
        issues.append('INVALID_AUTHORIZATION_MODE')
        mode = 'invalid'
    marker = root / 'data/legacy-upgrade-mode.json'
    marker_valid = False
    if marker.exists():
        try:
            record = json.loads(marker.read_text())
            marker_valid = isinstance(record, dict) and record.get('format') == 1 and record.get('mode') == 'legacy-upgrade'
        except (OSError, ValueError):
            pass
        if not marker_valid:
            issues.append('INVALID_LEGACY_AUTHORIZATION_MARKER')
    saved = root / 'data/authorization-connection.json'
    if saved.exists():
        # Existence alone cannot attest Ed25519 keys, trusted center or certificate state.
        issues.append('SAVED_AUTHORIZATION_REQUIRES_RUNTIME_VALIDATION')
    if not mode:
        mode = 'legacy-marker' if marker_valid and not env.get('AI_LICENSE_CENTER_URL') and not env.get('AI_LICENSE_PUBLIC_KEYS_FILE') else 'requires-review'
    if mode == 'requires-review':
        issues.append('AUTHORIZATION_MODE_REQUIRES_REVIEW')
    if mode == 'center':
        # Version-only runtime-info is not an authorization attestation. This stage has
        # no trusted runtime verifier, even when a URL or public-key file is present.
        issues.append('CENTER_AUTHORIZATION_REQUIRES_RUNTIME_VALIDATION')
    if platform.system() != 'Linux' or platform.machine() not in ('x86_64', 'AMD64'):
        issues.append('UNSUPPORTED_HOST_PLATFORM')
    disk = shutil.disk_usage(root)
    return {'format': 1, 'appRoot': str(root), 'diskVersion': package['version'],
        'runningVersion': running.get('version'), 'runtimeInstanceId': running.get('instanceId'), 'port': port,
        'pm2': [{'name': p['name'], 'pid': p.get('pid'), 'status': p['pm2_env'].get('status'),
                 'interpreter': p['pm2_env'].get('exec_interpreter')} for p in matches],
        'databaseLockKey': db_key, 'authorizationMode': mode,
        'savedAuthorization': saved.exists(),
        'paths': paths, 'unreviewedPathKeys': unknown, 'pm2OverrideKeys': overrides,
        'diskFreeBytes': disk.free, 'issues': sorted(set(issues)), 'readyForPlan': not issues}


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app-root', required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(inventory(args.app_root), ensure_ascii=False, indent=2))
    except Exception as error:
        # Exceptions from PM2/HTTP/files may contain secrets; expose the type only.
        print(json.dumps({'error': 'SCAN_FAILED', 'type': type(error).__name__}))
        raise SystemExit(1)
