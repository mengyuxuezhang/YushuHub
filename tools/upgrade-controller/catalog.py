"""Signed release metadata only; never executes downloaded content."""
import base64
import json
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request
from pathlib import Path
from controller import IMAGE
from state import atomic_json, locks


def refresh_catalog(control, cfg):
    with locks(control.root, ['catalog-registration']):
        return _refresh_catalog(control, cfg)


def _refresh_catalog(control, cfg):
    url = cfg.get('catalogUrl')
    if not url:
        return cfg.get('desiredRelease'), ''
    parsed = urllib.parse.urlparse(url)
    loopback_test = cfg.get('allowLoopbackCatalogForTests') is True and parsed.hostname in ('127.0.0.1', 'localhost')
    if parsed.username or parsed.password or parsed.scheme != 'https' and not (loopback_test and parsed.scheme == 'http'):
        raise ValueError('CATALOG_REQUIRES_TRUSTED_HTTPS')
    state = Path(cfg['stateDir'])
    cache = state / 'verified-catalog.json'
    prior = json.loads(cache.read_text()) if cache.exists() else {}
    if time.time() - prior.get('fetchedAt', 0) < 60:
        return cfg.get('desiredRelease') or prior['latest'], ''
    try:
        with urllib.request.urlopen(url, timeout=8) as response:
            final = urllib.parse.urlparse(response.geturl())
            if final.scheme != 'https' and not (loopback_test and final.scheme == 'http' and final.hostname in ('127.0.0.1', 'localhost')):
                raise ValueError('CATALOG_REDIRECT_REJECTED')
            raw = response.read(262145)
        if len(raw) > 262144:
            raise ValueError('CATALOG_TOO_LARGE')
        envelope = json.loads(raw)
        payload = base64.b64decode(envelope['payload'], validate=True)
        signature = base64.b64decode(envelope['signature'], validate=True)
        # RSA-PSS is supported by the target's existing OpenSSL 1.1.1 CLI.
        # This update-only key is independent of the business Ed25519 license key.
        if envelope.get('algorithm') != 'RSA-PSS-SHA256' or len(signature) not in (384, 512) or len(payload) > 196608:
            raise ValueError('INVALID_CATALOG_ENVELOPE')
        key = cfg.get('catalogPublicKeys', {}).get(envelope.get('keyId'))
        if not key:
            raise ValueError('UNTRUSTED_CATALOG_SIGNING_KEY')
        key_path = Path(key)
        if key_path.is_symlink() or key_path.stat().st_uid != 0 or key_path.stat().st_mode & 0o022:
            raise ValueError('CATALOG_KEY_MUST_BE_ROOT_CONTROLLED')
        state.mkdir(mode=0o700, parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='catalog-', dir=state) as temporary:
            content, sig = Path(temporary) / 'payload', Path(temporary) / 'signature'
            content.write_bytes(payload)
            sig.write_bytes(signature)
            result = subprocess.run(['openssl', 'dgst', '-sha256', '-verify', str(key_path), '-signature', str(sig),
                '-sigopt', 'rsa_padding_mode:pss', '-sigopt', 'rsa_pss_saltlen:32', str(content)], capture_output=True, timeout=10)
            if result.returncode:
                raise ValueError('CATALOG_SIGNATURE_INVALID')
        data = json.loads(payload)
        generation = data.get('generation')
        releases = data.get('releases', [])
        if data.get('format') != 1 or not isinstance(generation, int) or generation < prior.get('generation', -1) or not 1 <= len(releases) <= 100:
            raise ValueError('INVALID_OR_REPLAYED_CATALOG')
        if generation == prior.get('generation') and prior.get('payload') != envelope['payload']:
            raise ValueError('CATALOG_GENERATION_CONFLICT')
        import re
        planned = []
        ids = set()
        for release in releases:
            release_id = release.get('id', '')
            if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.-]{0,79}', release_id) or release_id in ids:
                raise ValueError('INVALID_CATALOG_RELEASE_ID')
            ids.add(release_id)
            if release.get('platform') != 'linux/amd64' or not IMAGE.fullmatch(release.get('image', '')):
                raise ValueError('INVALID_CATALOG_IMAGE')
            for key in ('htmlSha256', 'schemaSha256', 'migrationSha256'):
                if not re.fullmatch(r'[a-f0-9]{64}', release.get(key, '')):
                    raise ValueError('INVALID_CATALOG_CONTRACT')
            if not re.fullmatch(r'\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?', release.get('version', '')):
                raise ValueError('INVALID_CATALOG_VERSION')
            if release.get('migrationPolicy') != 'same-schema' or not isinstance(release.get('supportedFrom'), list):
                raise ValueError('UNSUPPORTED_CATALOG_MIGRATION')
            path = control.config_root / 'releases' / (release_id + '.json')
            if path.exists() and json.loads(path.read_text()) != release:
                raise ValueError('IMMUTABLE_RELEASE_ALREADY_EXISTS')
            planned.append((path, release))
        if data.get('latest') not in ids:
            raise ValueError('CATALOG_LATEST_NOT_LISTED')
        for path, release in planned:
            if not path.exists():
                atomic_json(path, release)
        atomic_json(cache, {'generation': generation, 'fetchedAt': time.time(), 'latest': data['latest'], 'payload': envelope['payload']})
        return cfg.get('desiredRelease') or data['latest'], ''
    except Exception:
        # A previously verified immutable release remains usable during transient discovery failure.
        if prior.get('latest'):
            return cfg.get('desiredRelease') or prior['latest'], 'CATALOG_OFFLINE_USING_VERIFIED_CACHE'
        raise ValueError('CATALOG_NOT_VERIFIED') from None
