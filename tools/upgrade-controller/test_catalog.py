import base64
import http.server
import json
import shutil
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from catalog import refresh_catalog
from state import atomic_json


@unittest.skipUnless(shutil.which('openssl'), 'OpenSSL CLI is required for signed catalog integration tests')
class CatalogTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.private, self.public = self.root/'private.pem', self.root/'public.pem'
        subprocess.run(['openssl','genpkey','-algorithm','RSA','-pkeyopt','rsa_keygen_bits:3072','-out',str(self.private)],check=True,capture_output=True)
        subprocess.run(['openssl','pkey','-in',str(self.private),'-pubout','-out',str(self.public)],check=True,capture_output=True)
        self.body = b''
        owner = self
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200); self.end_headers(); self.wfile.write(owner.body)
            def log_message(self, *_args): pass
        self.server = http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
        threading.Thread(target=self.server.serve_forever,daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.control = SimpleNamespace(root=self.root/'controller-state', config_root=self.root/'config')
        self.cfg = {'stateDir':str(self.root/'state'),'catalogUrl':'http://127.0.0.1:'+str(self.server.server_port),
            'allowLoopbackCatalogForTests':True,'catalogPublicKeys':{'fixture':str(self.public)}}
        self.release = {'id':'fixture-release','version':'1.9.69','platform':'linux/amd64',
            'image':'registry.invalid/admin@sha256:'+'a'*64,'supportedFrom':['1.9.68'],'migrationPolicy':'same-schema',
            'htmlSha256':'b'*64,'schemaSha256':'c'*64,'migrationSha256':'d'*64}

    def signed(self, generation=1, release=None):
        release = release or self.release
        payload = json.dumps({'format':1,'generation':generation,'latest':release['id'],'releases':[release]}).encode()
        file, sig = self.root/'payload.json', self.root/'signature'
        file.write_bytes(payload)
        subprocess.run(['openssl','dgst','-sha256','-sign',str(self.private),'-sigopt','rsa_padding_mode:pss',
            '-sigopt','rsa_pss_saltlen:32','-out',str(sig),str(file)],check=True,capture_output=True)
        return {'algorithm':'RSA-PSS-SHA256','keyId':'fixture','payload':base64.b64encode(payload).decode(),
            'signature':base64.b64encode(sig.read_bytes()).decode()}

    def expire_cache(self):
        file = Path(self.cfg['stateDir'])/'verified-catalog.json'
        value=json.loads(file.read_text());value['fetchedAt']=0;atomic_json(file,value)

    def test_signed_metadata_is_verified_before_release_registration(self):
        self.body=json.dumps(self.signed()).encode()
        latest, warning=refresh_catalog(self.control,self.cfg)
        self.assertEqual(latest,self.release['id']);self.assertEqual(warning,'')
        self.assertEqual(json.loads((self.control.config_root/'releases/fixture-release.json').read_text()),self.release)

    def test_tampering_before_first_verification_registers_nothing(self):
        envelope=self.signed();envelope['payload']=base64.b64encode(b'{"format":999}').decode();self.body=json.dumps(envelope).encode()
        with self.assertRaisesRegex(ValueError,'CATALOG_NOT_VERIFIED'):refresh_catalog(self.control,self.cfg)
        self.assertFalse((self.control.config_root/'releases').exists())

    def test_replay_cannot_replace_a_newer_verified_catalog(self):
        first=self.signed(1);self.body=json.dumps(first).encode();refresh_catalog(self.control,self.cfg)
        self.expire_cache();second=dict(self.release,id='fixture-newer',version='1.9.70')
        self.body=json.dumps(self.signed(2,second)).encode();refresh_catalog(self.control,self.cfg)
        self.expire_cache();self.body=json.dumps(first).encode()
        latest, warning=refresh_catalog(self.control,self.cfg)
        self.assertEqual(latest,'fixture-newer');self.assertTrue(warning)

    def test_existing_release_digest_is_immutable_even_for_a_signed_replacement(self):
        self.body=json.dumps(self.signed()).encode();refresh_catalog(self.control,self.cfg);self.expire_cache()
        changed=dict(self.release,image='registry.invalid/admin@sha256:'+'e'*64)
        self.body=json.dumps(self.signed(2,changed)).encode();latest,warning=refresh_catalog(self.control,self.cfg)
        self.assertTrue(warning)
        self.assertEqual(json.loads((self.control.config_root/'releases/fixture-release.json').read_text())['image'],self.release['image'])
