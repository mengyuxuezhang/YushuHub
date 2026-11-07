import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from controller import Controller
from engine import EngineError
from state import Journal, atomic_json, locks


class FakeEngine:
    def __init__(self):
        self.events = []
        self.active = None
        self.fail_pull = False
        self.fail_health_once = False
        self.unknown = False
        self.contract = {}

    def available(self):
        if self.unknown:
            raise EngineError('COMMAND_OUTCOME_UNKNOWN')

    def port_owner(self, port, **kwargs):
        pass

    def port_is_free(self, port):
        pass

    def inspect_image(self, ref, pull=False):
        self.events.append('pull' if pull else 'inspect')
        if pull and self.fail_pull:
            raise EngineError('COMMAND_FAILED:docker')

    def image_contract(self, ref):
        return self.contract

    def source_contract(self, app_root):
        return self.contract

    def authorization_probe(self, config, use_container=False):
        return {'verified': True, 'mode': 'legacy', 'identityHash': 'c' * 64}

    def run(self, args):
        if args[:3] == ['docker', 'compose', 'version']:
            return '2.35.1'
        return json.dumps([{'pm_id': 42, 'name': 'fixture', 'pid': os.getpid(), 'pm2_env': {'pm_cwd': self.app_root,
            'pm_exec_path': self.app_root + '/cloud/ai-admin/server.mjs', 'env': {}}}])

    def pm2(self, root, action, process_id):
        self.events.append('pm2:' + action)
        if process_id != 42:
            raise AssertionError('wrong PM2 instance')

    def container(self, name):
        self.available()
        return self.active

    def compose(self, path, action):
        self.events.append('compose:' + action)
        if action == 'up':
            release = json.loads(Path(path).read_text())['services']['app']['image']
            self.active = {'State': {'Running': True}, 'Config': {'Image': release}}
        elif self.active:
            self.active['State']['Running'] = False

    def verify(self, cfg, release, **kwargs):
        self.events.append('verify:' + release['version'])
        if self.fail_health_once:
            self.fail_health_once = False
            raise EngineError('HEALTH_OR_VERSION_VERIFICATION_FAILED')


class ControllerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.app = self.base / 'app'
        (self.app / 'web/admin-v2').mkdir(parents=True)
        (self.app / 'src/db').mkdir(parents=True)
        (self.app / 'data').mkdir()
        (self.app / 'web/admin-v2/index.html').write_text('html')
        (self.app / 'src/db/schema.mjs').write_text('schema')
        (self.app / '.env').write_text('AI_ADMIN_PORT=7079\nAI_AUTHORIZATION_MODE=legacy\n')
        import hashlib
        h = lambda value: hashlib.sha256(value.encode()).hexdigest()
        self.release = {'version': '1.9.66', 'image': 'registry.invalid/admin@sha256:' + 'a' * 64,
                        'schemaSha256': h('schema'), 'htmlSha256': h('html'), 'platform': 'linux/amd64',
                        'supportedFrom': ['1.9.66'], 'migrationPolicy': 'same-schema', 'migrationSha256': 'd'*64}
        self.engine = FakeEngine()
        self.engine.app_root = str(self.app)
        self.engine.contract = self.release
        self.control = Controller(self.base / 'state', self.base / 'config', self.engine)
        atomic_json(self.base / 'config/instances/fixture.json', {'instanceId': 'fixture', 'appRoot': str(self.app), 'port': 7079, 'databaseExclusive': True, 'databaseLockKey':'same-database'})
        atomic_json(self.base / 'config/releases/same.json', self.release)
        from scan import PATH_DEFAULTS
        paths = [{'key': k, 'path': str(self.app / v), 'exists': (self.app / v).exists()} for k, v in PATH_DEFAULTS.items()]
        self.scan = {'issues': [], 'pm2': [{'name': 'fixture', 'pid': os.getpid(), 'status': 'online'}],
            'runningVersion': '1.9.66', 'port': 7079, 'paths': paths, 'databaseLockKey': 'same-database',
            'authorizationMode': 'legacy-marker', 'savedAuthorization': False}
        self.addCleanup(patch.stopall)
        patch('controller.inventory', return_value=self.scan).start()
        patch.object(self.control, 'preflight').start()
        patch('controller.os.chown').start()
        patch.object(self.control, 'backup_and_prepare').start()

    def journal(self):
        return Journal(self.base / 'state/instances/fixture')

    def test_pre_pull_failure_leaves_old_writer_untouched(self):
        self.engine.fail_pull = True
        with self.assertRaisesRegex(RuntimeError, 'REJECTED'):
            self.control.apply('fixture', 'same', 'request-1')
        self.assertNotIn('pm2:stop', self.engine.events)
        self.assertEqual(self.journal().read()['stage'], 'rejected')

    def test_health_failure_restores_exact_old_process_and_preserves_new_data(self):
        self.engine.fail_health_once = True
        marker = self.app / 'data/new-order.json'
        marker.write_text('{"paid":true}')
        with self.assertRaisesRegex(RuntimeError, 'ROLLED_BACK'):
            self.control.apply('fixture', 'same', 'request-2')
        self.assertEqual(marker.read_text(), '{"paid":true}')
        self.assertIn('pm2:restart', self.engine.events)
        self.assertEqual(self.journal().read()['stage'], 'rolled_back')

    def test_success_then_explicit_rollback_does_not_restore_database_backup(self):
        self.control.apply('fixture', 'same', 'request-3')
        self.assertEqual(self.journal().read()['stage'], 'committed')
        marker = self.app / 'data/after-upgrade.json'
        marker.write_text('keep-me')
        self.control.recover('fixture', rollback_committed=True)
        self.assertEqual(marker.read_text(), 'keep-me')
        self.assertEqual(self.journal().read()['stage'], 'rolled_back')
        self.assertFalse((self.base / 'state/instances/fixture/current.json').exists())

    def test_idempotent_operation_is_not_executed_twice(self):
        self.control.apply('fixture', 'same', 'request-4')
        before = list(self.engine.events)
        self.control.apply('fixture', 'same', 'request-4')
        self.assertEqual(before, self.engine.events)

    def test_incompatible_database_contract_blocks_before_any_stop(self):
        release = dict(self.release, schemaSha256='b' * 64)
        atomic_json(self.base / 'config/releases/same.json', release)
        with self.assertRaisesRegex(ValueError, 'DATABASE_MIGRATION'):
            self.control.apply('fixture', 'same')
        self.assertEqual(self.engine.events, [])

    def test_changed_migration_dependency_is_blocked_even_when_schema_entry_is_equal(self):
        atomic_json(self.base / 'config/releases/same.json', dict(self.release, migrationSha256='e' * 64))
        with self.assertRaisesRegex(ValueError, 'DATABASE_MIGRATION'):
            self.control.apply('fixture', 'same')
        self.assertNotIn('pm2:stop', self.engine.events)

    def test_unknown_daemon_during_recovery_never_starts_second_writer(self):
        self.control.apply('fixture', 'same', 'request-5')
        self.engine.unknown = True
        with self.assertRaisesRegex(RuntimeError, 'NEEDS_ATTENTION'):
            self.control.recover('fixture', rollback_committed=True)
        self.assertNotIn('pm2:restart', self.engine.events)
        self.assertEqual(self.journal().read()['stage'], 'needs_attention')

    def test_process_kill_after_start_can_recover_from_persisted_plan(self):
        original = self.engine.compose
        def interrupted(path, action):
            original(path, action)
            if action == 'up':
                raise KeyboardInterrupt()
        with patch.object(self.engine, 'compose', side_effect=interrupted):
            with self.assertRaises(KeyboardInterrupt):
                self.control.apply('fixture', 'same', 'request-6')
        self.assertEqual(self.journal().read()['stage'], 'starting')
        self.control.recover('fixture')
        self.assertEqual(self.journal().read()['stage'], 'rolled_back')

    def test_shared_database_and_host_locks_reject_concurrent_mutation(self):
        with locks(self.control.root, ['host-cutover']):
            with self.assertRaisesRegex(RuntimeError, 'BUSY'):
                self.control.apply('fixture', 'same')

    def test_failed_later_attempt_does_not_hide_last_committed_rollback(self):
        self.control.apply('fixture', 'same', 'success-before-failure')
        self.engine.fail_pull = True
        with self.assertRaises(RuntimeError):
            self.control.apply('fixture', 'same', 'later-network-failure')
        self.engine.fail_pull = False
        self.control.recover('fixture', rollback_committed=True)
        self.assertEqual(self.journal().read()['operationId'], 'success-before-failure')
        self.assertEqual(self.journal().read()['stage'], 'rolled_back')

    def test_old_operation_receipt_remains_idempotent_after_another_request(self):
        self.control.apply('fixture', 'same', 'old-idempotent-request')
        self.engine.fail_pull = True
        with self.assertRaises(RuntimeError):
            self.control.apply('fixture', 'same', 'different-request')
        before = list(self.engine.events)
        result = self.control.apply('fixture', 'same', 'old-idempotent-request')
        self.assertEqual(result['stage'], 'committed')
        self.assertEqual(before, self.engine.events)

    def test_insufficient_space_is_rejected_before_any_writer_stop(self):
        # Exercise actual preflight logic rather than the suite's fake preflight method.
        plan = self.control.plan('fixture', 'same')
        import collections
        import sys
        plan['config']['mysqldump'] = sys.executable  # Only executable presence is used by this preflight test.
        usage = collections.namedtuple('Usage', 'total used free')(100, 100, 0)
        with patch('controller.available_memory', return_value=10 * 1024**3), patch('controller.shutil.disk_usage', return_value=usage):
            with self.assertRaisesRegex(ValueError, 'INSUFFICIENT_DISK'):
                Controller.preflight(self.control, plan)
        self.assertNotIn('pm2:stop', self.engine.events)

    def test_pm2_autostart_only_changes_target_and_keeps_other_instances_edits(self):
        target = {'name': 'fixture', 'pm_cwd': str(self.app), 'status': 'online'}
        other = {'name': 'other-instance', 'pm_cwd': '/srv/other-instance', 'revision': 1}
        dump = self.base / 'dump.pm2'
        receipt = self.base / 'autostart-receipt.json'
        atomic_json(dump, [target, other])
        atomic_json(receipt, [{'path': str(dump), 'targetRows': [target]}])
        plan = {'config': {'appRoot': str(self.app)}, 'pm2AutostartFile': str(receipt)}
        self.control.edit_pm2_autostart(plan)
        self.assertEqual(json.loads(dump.read_text()), [other])
        other['revision'] = 2
        atomic_json(dump, [other])
        self.control.edit_pm2_autostart(plan, restore=True)
        self.assertEqual(json.loads(dump.read_text()), [other, target])


if __name__ == '__main__':
    unittest.main()
