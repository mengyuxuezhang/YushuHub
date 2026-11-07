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
        (self.root / '.env').write_text('AI_DB_PASSWORD=DO_NOT_EXPORT\nAI_ADMIN_PORT=7079\nAI_AUTHORIZATION_MODE=legacy\n')
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

    def test_first_dotenv_value_wins_and_pm2_only_values_are_not_omitted(self):
        from scan import read_env
        with (self.root / '.env').open('a') as stream:
            stream.write('AI_DB_NAME=first_db\nAI_DB_NAME=last_db\n')
        self.assertEqual(read_env(self.root)['AI_DB_NAME'], 'first_db')
        original = self.scan()['databaseLockKey']
        self.rows[0]['pm2_env'].update(AI_DB_NAME='pm2_actual', AI_UPLOAD_DIR=str(self.root.parent / 'external-fixture'))
        result = self.scan()
        self.assertNotEqual(original, result['databaseLockKey'])
        self.assertIn('AI_UPLOAD_DIR', result['pm2OverrideKeys'])
        upload = next(p for p in result['paths'] if p['key'] == 'AI_UPLOAD_DIR')
        self.assertTrue(upload['external'])
        self.assertFalse(result['readyForPlan'])

    def test_nested_pm2_environment_is_effective_and_conflicts_block(self):
        self.rows[0]['pm2_env']['env'] = {'AI_DB_NAME': 'nested_fixture'}
        first = self.scan()['databaseLockKey']
        self.rows[0]['pm2_env']['AI_DB_NAME'] = 'flat_fixture'
        result = self.scan()
        self.assertNotEqual(first, result['databaseLockKey'])
        self.assertIn('AMBIGUOUS_PM2_ENVIRONMENT', result['issues'])

    def test_corrupt_marker_and_unknown_mode_are_blocked_and_redacted(self):
        (self.root / 'data').mkdir()
        (self.root / 'data/legacy-upgrade-mode.json').write_text('NOT_JSON')
        with (self.root / '.env').open('a') as stream:
            # Remove the valid first occurrence to exercise an unknown effective mode.
            pass
        (self.root / '.env').write_text('AI_AUTHORIZATION_MODE=DO_NOT_EXPORT_UNKNOWN_MODE\n')
        result = self.scan()
        self.assertEqual(result['authorizationMode'], 'invalid')
        self.assertIn('INVALID_LEGACY_AUTHORIZATION_MARKER', result['issues'])
        self.assertNotIn('DO_NOT_EXPORT_UNKNOWN_MODE', json.dumps(result))
        self.assertFalse(result['readyForPlan'])

    def test_explicit_center_without_identity_or_with_only_url_cannot_bypass_review(self):
        for extra in ('', 'AI_LICENSE_CENTER_URL=https://fixture.invalid\n'):
            with self.subTest(extraConfigured=bool(extra)):
                (self.root / '.env').write_text('AI_AUTHORIZATION_MODE=center\n' + extra)
                result = self.scan()
                self.assertIn('CENTER_AUTHORIZATION_REQUIRES_RUNTIME_VALIDATION', result['issues'])
                self.assertFalse(result['readyForPlan'])


if __name__ == '__main__':
    unittest.main()
