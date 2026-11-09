"""Registration boundary and actual HTTPS/test-key catalog, not a business migration."""
import base64
import http.server
import json
import os
import shutil
import ssl
import subprocess
import tempfile
import threading
import unittest
import urllib.request
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from controller import Controller, review_plan_digest
from delivery import public_fingerprint
from setup import registration_plan, register


@unittest.skipUnless(os.name == 'posix' and os.geteuid() == 0 and shutil.which('openssl'), 'Linux root/OpenSSL test fixture')
class SetupTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='controller-setup-fixture-', dir='/root')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.app = self.root/'app'; self.app.mkdir()
        (self.app/'.env').write_text('AI_DB_NAME=fixture_setup\nAI_AUTHORIZATION_MODE=center\n')
        self.package = self.root/'package'; (self.package/'keys').mkdir(parents=True)
        self.private, self.public = self.root/'update-private.pem', self.package/'keys/fixture.pem'
        self.openssl('genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:3072', '-out', str(self.private))
        self.openssl('pkey', '-in', str(self.private), '-pubout', '-out', str(self.public))
        fp = public_fingerprint(self.public.read_bytes())
        (self.package/'release-manifest.json').write_text(json.dumps({'keys': {'fixture': {'file': 'keys/fixture.pem', 'spkiSha256': fp}}}))
        cert, key = self.root/'tls.pem', self.root/'tls-key.pem'
        self.openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
                     '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', str(key), '-out', str(cert))
        self.body, self.requests = b'', 0
        owner = self
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                owner.requests += 1
                self.send_response(200); self.end_headers(); self.wfile.write(owner.body)
            def log_message(self, *_): pass
        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cert, key)
        self.server.socket = context.wrap_socket(self.server.socket, server_side=True)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close); self.addCleanup(self.server.shutdown)
        # Python may cache the default opener/context across tests. Bind this
        # fixture's CA to a fresh client and restore the previous opener afterwards.
        client = urllib.request.build_opener(urllib.request.HTTPSHandler(
            context=ssl.create_default_context(cafile=str(cert))))
        client_patch = patch('urllib.request._opener', client)
        client_patch.start(); self.addCleanup(client_patch.stop)
        self.old = {'version': '1.9.66', 'htmlSha256': 'a'*64, 'schemaSha256': 'b'*64, 'migrationSha256': 'c'*64}
        self.release = dict(self.old, id='same-1966', platform='linux/amd64', image='registry.fixture.invalid/admin@sha256:'+'d'*64,
                            migrationPolicy='same-schema', supportedFrom=['1.9.66'])
        payload = json.dumps({'format': 1, 'generation': 1, 'latest': 'same-1966', 'releases': [self.release]}).encode()
        (self.root/'payload').write_bytes(payload)
        self.openssl('dgst', '-sha256', '-sign', str(self.private), '-sigopt', 'rsa_padding_mode:pss',
                     '-sigopt', 'rsa_pss_saltlen:32', '-out', str(self.root/'signature'), str(self.root/'payload'))
        self.body = json.dumps({'algorithm': 'RSA-PSS-SHA256', 'keyId': 'fixture',
            'payload': base64.b64encode(payload).decode(), 'signature': base64.b64encode((self.root/'signature').read_bytes()).decode()}).encode()
        engine = SimpleNamespace(source_contract=lambda _: self.old,
            pm2_processes=lambda: [{'pid': os.getpid(), 'pm2_env': {'pm_cwd': str(self.app),
                'exec_mode': 'fork_mode', 'pm_exec_path': str(self.app/'cloud/ai-admin/server.mjs')}}],
            authorization_probe=lambda _: {'mode': 'center', 'verified': True, 'identityHash': 'e'*64})
        self.control = Controller(self.root/'state', self.root/'config', engine)
        from scan import database_lock_key, read_env
        self.scan = {'issues': ['CENTER_AUTHORIZATION_REQUIRES_RUNTIME_VALIDATION'], 'port': 17199,
            'pm2': [{'name': 'fixture', 'pid': os.getpid(), 'status': 'online'}], 'runningVersion': '1.9.66',
            'databaseLockKey': database_lock_key(read_env(self.app))}
        scan_patch = patch('setup.inventory', return_value=self.scan)
        scan_patch.start(); self.addCleanup(scan_patch.stop)
        runtime = patch('setup.runtime_paths')
        runtime.start(); self.addCleanup(runtime.stop)
        self.options = {'instance': 'fixture', 'appRoot': str(self.app),
            'catalogUrl': 'https://localhost:'+str(self.server.server_port)+'/catalog.json',
            'keyId': 'fixture', 'keyFingerprint': fp, 'initialRelease': 'same-1966',
            'mysqldump': shutil.which('true'), 'memoryMiB': 256, 'hostReserveMiB': 128}

    def openssl(self, *args):
        subprocess.run(['openssl', *args], capture_output=True, check=True)

    def plan(self):
        return registration_plan(self.control, self.options, self.package)

    def test_https_plan_is_read_only_and_center_identity_is_not_downgraded(self):
        before = (self.app/'.env').read_bytes()
        plan, cfg, releases, _ = self.plan()
        self.assertEqual(plan['authorizationMode'], 'center')
        self.assertTrue(plan['databaseOwnershipConfirmationRequired'])
        self.assertNotIn('desiredRelease', cfg)  # Later catalog latest must remain discoverable.
        self.assertEqual(releases['same-1966'], self.release)
        self.assertFalse(self.control.root.exists())
        self.assertFalse(self.control.config_root.exists())
        self.assertEqual((self.app/'.env').read_bytes(), before)

    def test_apply_requires_reviewed_database_and_same_plan_then_publishes_registration_last(self):
        plan = self.plan()[0]
        with self.assertRaisesRegex(ValueError, 'OWNERSHIP'):
            register(self.control, self.options, plan['reviewSha256'], False, self.package)
        with self.assertRaisesRegex(ValueError, 'PLAN_CHANGED'):
            register(self.control, self.options, 'f'*64, True, self.package)
        self.assertFalse((self.control.config_root/'instances/fixture.json').exists())
        result = register(self.control, self.options, plan['reviewSha256'], True, self.package)
        self.assertEqual(result['stage'], 'registered')
        self.assertTrue(json.loads((self.control.config_root/'instances/fixture.json').read_text())['databaseExclusive'])
        self.assertEqual(json.loads((self.control.root/'instances/fixture/verified-catalog.json').read_text())['generation'], 1)
        with self.assertRaisesRegex(ValueError, 'ALREADY_REGISTERED'):
            self.plan()

    def test_wrong_bootstrap_key_and_unsigned_or_http_catalog_are_rejected(self):
        self.options['keyFingerprint'] = '0'*64
        with self.assertRaisesRegex(ValueError, 'FINGERPRINT'):
            self.plan()
        self.assertEqual(self.requests, 0)
        self.options['keyFingerprint'] = public_fingerprint(self.public.read_bytes())
        self.options['catalogUrl'] = self.options['catalogUrl'].replace('https:', 'http:')
        with self.assertRaisesRegex(ValueError, 'HTTPS'):
            self.plan()
        self.options['catalogUrl'] = self.options['catalogUrl'].replace('http:', 'https:')
        self.body = b'{"algorithm":"none"}'
        before = self.requests
        with self.assertRaisesRegex(ValueError, 'NOT_VERIFIED'):
            self.plan()
        self.assertGreater(self.requests, before)  # TLS succeeded; envelope was rejected.

    def test_bad_signature_reaches_real_openssl_after_verified_https(self):
        envelope = json.loads(self.body)
        signature = bytearray(base64.b64decode(envelope['signature']))
        signature[0] ^= 1
        envelope['signature'] = base64.b64encode(signature).decode()
        self.body = json.dumps(envelope).encode()
        with patch('catalog.subprocess.run', wraps=subprocess.run) as verify:
            with self.assertRaisesRegex(ValueError, 'NOT_VERIFIED'):
                self.plan()
        self.assertTrue(any(call.args[0][:2] == ['openssl', 'dgst'] for call in verify.call_args_list))
        self.assertGreater(self.requests, 0)

    def test_source_configuration_changed_after_review_does_not_register(self):
        reviewed = self.plan()[0]['reviewSha256']
        with (self.app/'.env').open('a') as stream: stream.write('AI_FAKE_OPTION=changed\n')
        with self.assertRaisesRegex(ValueError, 'PLAN_CHANGED'):
            register(self.control, self.options, reviewed, True, self.package)
        self.assertFalse((self.control.config_root/'instances/fixture.json').exists())

    def test_tls_or_private_key_cannot_be_used_as_the_dedicated_update_public_key(self):
        small = self.root/'tls-public.pem'
        self.openssl('pkey', '-in', str(self.root/'tls-key.pem'), '-pubout', '-out', str(small))
        with self.assertRaisesRegex(ValueError, '3072_OR_4096'):
            public_fingerprint(small.read_bytes())
        with self.assertRaisesRegex(ValueError, 'PUBLIC_SPKI'):
            public_fingerprint(self.private.read_bytes())

    def test_public_origin_cannot_be_changed_during_registration(self):
        with (self.app/'.env').open('a') as stream:
            stream.write('AI_ADMIN_PUBLIC_URL=https://agent.fixture.invalid\n')
        self.options['publicUrl'] = 'https://different.fixture.invalid'
        with self.assertRaisesRegex(ValueError, 'ORIGIN_DIFFERS'):
            self.plan()
