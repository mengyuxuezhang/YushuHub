"""Startup trust is an explicit public certificate snapshot, never arbitrary Node env."""
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from controller import Controller, node_extra_ca, source_configuration_closure


@unittest.skipUnless(os.name == 'posix' and os.geteuid() == 0 and shutil.which('openssl'), 'root/OpenSSL fixture')
class NodeCaTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir='/root', prefix='node-ca-fixture-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.app = self.root/'app'; self.app.mkdir()
        self.ca = self.root/'ca.pem'; self.key = self.root/'private.pem'
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
            '-subj', '/CN=fixture', '-keyout', str(self.key), '-out', str(self.ca)], capture_output=True, check=True)
        (self.app/'.env').write_text('NODE_EXTRA_CA_CERTS='+str(self.ca)+'\nNODE_OPTIONS=--inspect=0.0.0.0\n')
        self.control = Controller(self.root/'state', self.root/'config')

    def test_snapshot_maps_ca_before_start_and_rejects_snapshot_drift(self):
        closure = source_configuration_closure(self.app)
        plan = {'instanceId': 'fixture', 'config': {'appRoot': str(self.app), 'stateDir': str(self.root/'state/instance'),
                'containerName': 'fixture', 'port': 17099}, 'configurationClosure': closure,
                'inventory': {'paths': []}, 'mountRoots': []}
        with patch.object(self.control, 'validate_plan_inputs'):
            self.control.capture_configuration(plan, 'ca-review')
        path = self.control.compose_file(plan, {'image': 'fixture@sha256:'+'a'*64})
        service = json.loads(path.read_text())['services']['app']
        self.assertEqual(service['environment']['NODE_EXTRA_CA_CERTS'], '/run/yushuhub-node-ca.pem')
        self.assertNotIn('NODE_OPTIONS', service['environment'])
        self.assertNotIn('NODE_TLS_REJECT_UNAUTHORIZED', service['environment'])
        mount = next(m for m in service['volumes'] if m['target'] == '/run/yushuhub-node-ca.pem')
        self.assertTrue(mount['read_only'])
        self.assertFalse(mount['bind']['create_host_path'])
        self.assertEqual(Path(mount['source']).read_bytes(), self.ca.read_bytes())
        self.assertEqual(Path(mount['source']).stat().st_mode & 0o777, 0o444)
        self.ca.write_bytes(self.ca.read_bytes()+b'\n')
        with self.assertRaisesRegex(ValueError, 'SOURCE_CONFIGURATION_CHANGED'):
            self.control.validate_plan_inputs(plan)
        snapshot = Path(plan['sourceEnvSnapshotDir'])/'node-extra-ca.pem'
        snapshot.write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'VERIFIED_NODE_CA_SNAPSHOT'):
            self.control.compose_file(plan, {'image': 'fixture@sha256:'+'a'*64})

    def test_private_key_symlink_and_writable_ca_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'CERTIFICATE_BUNDLE'):
            node_extra_ca(self.app, {'NODE_EXTRA_CA_CERTS': str(self.key)})
        link = self.root/'link.pem'; link.symlink_to(self.ca)
        with self.assertRaisesRegex(ValueError, 'ROOT_CONTROLLED'):
            node_extra_ca(self.app, {'NODE_EXTRA_CA_CERTS': str(link)})
        self.ca.chmod(0o666)
        with self.assertRaisesRegex(ValueError, 'ROOT_CONTROLLED'):
            node_extra_ca(self.app, {'NODE_EXTRA_CA_CERTS': str(self.ca)})

    def test_absent_extra_ca_keeps_default_node_trust(self):
        self.assertIsNone(node_extra_ca(self.app, {}))
