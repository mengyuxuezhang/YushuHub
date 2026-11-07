import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from scan import inventory


class InventoryTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        (self.root / 'package.json').write_text(json.dumps({'name': 'agent-ai-admin', 'version': '1.9.66'}))
        (self.root / '.env').write_text('AI_DB_PASSWORD=DO_NOT_EXPORT\nAI_ADMIN_PORT=7079\n')
        self.rows = [{'name': 'fixture', 'pid': 5, 'pm2_env': {'pm_cwd': str(self.root), 'status': 'online'}}]

    def scan(self, **kwargs):
        with patch('platform.system', return_value='Linux'), patch('platform.machine', return_value='x86_64'):
            return inventory(self.root, self.rows, kwargs.get('reader', lambda _: {'version': '1.9.66'}))

    def test_never_exports_credentials_and_detects_running_mismatch(self):
        result = self.scan(reader=lambda _: {'version': '1.9.65'})
        self.assertNotIn('DO_NOT_EXPORT', json.dumps(result))
        self.assertIn('DISK_RUNTIME_VERSION_MISMATCH', result['issues'])
        self.assertFalse(result['readyForPlan'])

    def test_multiple_pm2_and_environment_overrides_block(self):
        self.rows[0]['pm2_env']['AI_DB_PASSWORD'] = 'another-secret'
        self.rows.append(dict(self.rows[0]))
        self.assertIn('EXPECTED_ONE_ONLINE_PM2_PROCESS', self.scan()['issues'])
        self.rows.pop()
        result = self.scan()
        self.assertIn('PM2_ENV_DIFFERS_FROM_ENV_FILE', result['issues'])
        self.assertNotIn('another-secret', json.dumps(result))

    def test_custom_missing_key_and_unknown_paths_block(self):
        with (self.root / '.env').open('a') as stream:
            stream.write('AI_MODEL_CREDENTIAL_KEY_PATH=absent.key\nAI_FUTURE_FILE=secret.location\n')
        result = self.scan()
        self.assertIn('CONFIGURED_FILE_MISSING:AI_MODEL_CREDENTIAL_KEY_PATH', result['issues'])
        self.assertIn('UNREVIEWED_PATH_CONFIGURATION', result['issues'])

    def test_shared_database_locator_produces_same_lock_across_roots(self):
        first = self.scan()['databaseLockKey']
        with (self.root / '.env').open('a') as stream:
            stream.write('AI_DB_PASSWORD=changed\n')
        self.assertEqual(first, self.scan()['databaseLockKey'])
        with (self.root / '.env').open('a') as stream:
            stream.write('AI_DB_NAME=other\n')
        self.assertNotEqual(first, self.scan()['databaseLockKey'])


if __name__ == '__main__':
    unittest.main()
