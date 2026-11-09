import json
import os
import subprocess
import sys
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

    def pm2_processes(self, start_daemon=False):
        return json.loads(self.run(['pm2', 'jlist']))

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
        from scan import database_lock_key, read_env
        db_key = database_lock_key(read_env(self.app))
        atomic_json(self.base / 'config/instances/fixture.json', {'instanceId': 'fixture', 'appRoot': str(self.app), 'port': 7079, 'databaseExclusive': True, 'databaseLockKey':db_key})
        atomic_json(self.base / 'config/releases/same.json', self.release)
        from scan import PATH_DEFAULTS
        paths = [{'key': k, 'path': str(self.app / v), 'exists': (self.app / v).exists()} for k, v in PATH_DEFAULTS.items()]
        self.scan = {'issues': [], 'pm2': [{'name': 'fixture', 'pid': os.getpid(), 'status': 'online'}],
            'runningVersion': '1.9.66', 'port': 7079, 'paths': paths, 'databaseLockKey': db_key,
            'authorizationMode': 'legacy-marker', 'savedAuthorization': False}
        self.addCleanup(patch.stopall)
        patch('controller.inventory', return_value=self.scan).start()
        patch.object(self.control, 'preflight').start()
        patch('controller.os.chown').start()
        patch.object(self.control, 'backup_and_prepare').start()

    def journal(self):
        return Journal(self.base / 'state/instances/fixture')

    def test_mount_order_and_approval_inputs_are_stable_across_hash_seeds(self):
        script = "from controller import mounted_roots;import json,sys;print(json.dumps([str(p) for p in mounted_roots(sys.argv[1], {'paths': []})]))"
        values = [subprocess.check_output([sys.executable, '-B', '-c', script, str(self.app)],
            env=dict(os.environ, PYTHONHASHSEED=seed, PYTHONPATH=str(Path(__file__).parent)), text=True)
            for seed in ('1', '2', '17')]
        self.assertEqual(len(set(values)), 1)
        self.assertEqual(json.loads(values[0]), [str(self.app/'data'), str(self.app/'logs')])

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

    def test_env_drift_during_pull_aborts_before_stopping_old_writer(self):
        original = self.engine.inspect_image
        def drift(ref, pull=False):
            result = original(ref, pull)
            if pull:
                with (self.app / '.env').open('a') as stream:
                    stream.write('AI_DB_NAME=unregistered_drift_database\n')
            return result
        with patch.object(self.engine, 'inspect_image', side_effect=drift):
            with self.assertRaisesRegex(RuntimeError, 'REJECTED'):
                self.control.apply('fixture', 'same', 'drift-during-pull')
        self.assertNotIn('pm2:stop', self.engine.events)
        self.assertIn('unregistered_drift_database', (self.app / '.env').read_text())
        self.assertEqual(self.journal().read()['error'], 'SOURCE_CONFIGURATION_CHANGED_REPLAN_REQUIRED')

    def test_verified_snapshot_is_used_even_if_original_file_later_changes(self):
        plan = self.control.plan('fixture', 'same')
        self.control.capture_configuration(plan, 'snapshot-fixture')
        original = (self.app / '.env').read_bytes()
        with (self.app / '.env').open('a') as stream:
            stream.write('AI_DB_NAME=unreviewed_later_change\n')
        raw, env = self.control.snapshot_environment(plan)
        self.assertEqual(raw, original)
        self.assertNotEqual(env.get('AI_DB_NAME'), 'unreviewed_later_change')
        self.control.compose_file(plan, self.release)
        runtime = (Path(plan['config']['stateDir']) / 'runtime.env').read_bytes()
        self.assertNotIn(b'unreviewed_later_change', runtime)
        self.assertIn(b'unreviewed_later_change', (self.app / '.env').read_bytes())

    def test_reviewed_migration_rejects_config_drift_inside_host_lock_before_effects(self):
        from controller import review_plan_digest
        reviewed = review_plan_digest(self.control.plan('fixture', 'same'))
        with (self.app/'.env').open('a') as stream:
            stream.write('AI_FICTIONAL_CHANGED_AFTER_REVIEW=yes\n')
        with self.assertRaisesRegex(ValueError, 'MIGRATION_PLAN_CHANGED'):
            self.control.apply('fixture', 'same', 'reviewed-drift', approved_plan_sha256=reviewed)
        self.assertNotIn('pm2:stop', self.engine.events)
        self.assertFalse((Path(self.control.config('fixture')['stateDir'])/'snapshots/reviewed-drift').exists())

    def test_review_digest_does_not_pin_database_size_and_cached_apply_keeps_receipt(self):
        from controller import review_plan_digest
        plan = self.control.plan('fixture', 'same')
        reviewed = review_plan_digest(plan)
        plan['authorization']['databaseBytes'] = 123456789
        self.assertEqual(review_plan_digest(plan), reviewed)
        result = self.control.apply('fixture', 'same', 'reviewed-good', approved_plan_sha256=reviewed)
        self.assertEqual(result['stage'], 'committed')
        events = list(self.engine.events)
        self.assertEqual(self.control.apply('fixture', 'same', 'reviewed-good', approved_plan_sha256=reviewed), result)
        self.assertEqual(self.engine.events, events)
        with self.assertRaisesRegex(ValueError, 'DIFFERENT_INTENT'):
            self.control.apply('fixture', 'same', 'reviewed-good', approved_plan_sha256='f'*64)


if __name__ == '__main__':
    unittest.main()
