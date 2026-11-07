"""Cross-entry replay/ordering regressions: no business or external services."""
import json
import tempfile
import unittest
import threading
import time
from pathlib import Path
from unittest.mock import patch
from controller import Controller
from pm2_zip import Pm2ZipController, public_record
from service import public_status, serve_instance
from test_service import SocketHTTPConnection
from state import (Journal, atomic_json, execute_request, find_request,
                   latest_record, reserve_request)


class RequestsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.directory = self.root / 'instances/a'
        self.control = Controller(self.root, self.root / 'config')
        atomic_json(self.root / 'config/instances/a.json',
                    {'instanceId': 'a', 'appRoot': '/fictional/a', 'port': 17099})

    def test_rollback_replay_after_newer_commit_and_restart_never_selects_again(self):
        with patch.object(self.control, '_recover_locked', return_value={'stage': 'rolled_back', 'operationId': 'upgrade-new'}) as restore:
            first = self.control.recover('a', True, 'http-rollback')
            self.assertEqual(first['operationId'], 'http-rollback')
            self.assertEqual(first['targetOperationId'], 'upgrade-new')
            Journal(self.directory).save({'operationId': 'cli-newer'}, 'committed')
            fresh = Controller(self.root, self.root / 'config')
            with patch.object(fresh, '_recover_locked', side_effect=AssertionError('second rollback')):
                self.assertEqual(fresh.recover('a', True, 'http-rollback'), first)
            self.assertEqual(restore.call_count, 1)
        self.assertEqual(Journal(self.directory).read()['operationId'], 'cli-newer')

    def test_same_id_different_action_or_release_conflicts(self):
        with patch.object(self.control, '_apply_locked', return_value={'stage': 'committed', 'operationId': 'same'}):
            self.control.apply('a', 'old', 'same')
        with self.assertRaisesRegex(ValueError, 'DIFFERENT_INTENT'):
            self.control.apply('a', 'new', 'same')
        with self.assertRaisesRegex(ValueError, 'DIFFERENT_INTENT'):
            self.control.recover('a', True, 'same')

    def test_recover_replay_is_durable_and_failed_requests_do_not_retry(self):
        with patch.object(self.control, '_recover_locked', return_value={'stage': 'rejected', 'operationId': 'interrupted'}) as recover:
            first = self.control.recover('a', False, 'recover-once')
            self.assertEqual(self.control.recover('a', False, 'recover-once'), first)
            self.assertEqual(recover.call_count, 1)
        with patch.object(self.control, '_recover_locked', side_effect=RuntimeError('RECOVERY_NEEDS_ATTENTION')) as recover:
            with self.assertRaises(RuntimeError):
                self.control.recover('a', False, 'failed-once')
            self.assertEqual(self.control.recover('a', False, 'failed-once')['stage'], 'failed')
            self.assertEqual(recover.call_count, 1)

    def test_crash_after_side_effect_cannot_repeat_against_new_current(self):
        class Crash(BaseException): pass
        def interrupted():
            Journal(self.directory).save({'operationId': 'restored-version'}, 'rolled_back')
            raise Crash()
        with self.assertRaises(Crash):
            execute_request(self.directory, 'lost-reply', {'action': 'rollback'}, interrupted)
        Journal(self.directory).save({'operationId': 'newer-cli'}, 'committed')
        result = execute_request(self.directory, 'lost-reply', {'action': 'rollback'},
                                 lambda: self.fail('rollback repeated'))
        self.assertEqual(result['stage'], 'needs_attention')
        latest = json.loads((self.directory / 'last-request.json').read_text())
        self.assertEqual(latest_record(Journal(self.directory).read(), latest)['operationId'], 'newer-cli')

    def test_newer_cli_status_wins_and_newer_http_result_wins_back(self):
        execute_request(self.directory, 'old-http', {'action': 'rollback'}, lambda: {'stage': 'rolled_back'})
        journal = Journal(self.directory)
        journal.save({'operationId': 'new-cli'}, 'committed')
        with patch('service.refresh_catalog', return_value=(None, None)):
            self.assertEqual(public_status(self.control, 'a')['transaction']['operationId'], 'new-cli')
            execute_request(self.directory, 'new-http', {'action': 'recover'}, lambda: {'stage': 'rejected'})
            self.assertEqual(public_status(self.control, 'a')['transaction']['operationId'], 'new-http')
            journal.save({'operationId': 'active-cli'}, 'verifying')
            reserve_request(self.directory, 'new-accepted', {'action': 'recover'})
            self.assertEqual(public_status(self.control, 'a')['transaction']['operationId'], 'active-cli')

    def test_legacy_missing_time_request_does_not_hide_cli(self):
        self.assertEqual(latest_record({'stage': 'committed', 'operationId': 'cli'},
                                      {'stage': 'failed', 'operationId': 'old'})['operationId'], 'cli')

    def test_pm2_actions_share_receipts_and_status_ordering(self):
        control = Pm2ZipController(self.root, self.root / 'config')
        with patch.object(control, '_recover_zip_locked', return_value={'stage': 'rolled_back', 'operationId': 'zip-new'}) as restore:
            first = control.recover_zip('/fictional/a', True, 'zip-rollback')
            self.assertEqual(control.recover_zip('/fictional/a', True, 'zip-rollback'), first)
            self.assertEqual(restore.call_count, 1)
        with self.assertRaisesRegex(ValueError, 'DIFFERENT_INTENT'):
            control.recover_zip('/fictional/a', False, 'zip-rollback')
        Journal(control.directory('/fictional/a')).save({'operationId': 'new-cli'}, 'committed')
        self.assertEqual(public_record(control, '/fictional/a')['operationId'], 'new-cli')

    def test_accepted_request_binds_release_and_cannot_be_changed_by_cli(self):
        reserve_request(self.directory, 'pending', {'action': 'upgrade', 'releaseId': 'old'})
        with self.assertRaisesRegex(ValueError, 'DIFFERENT_INTENT'):
            self.control.apply('a', 'new', 'pending')
        self.assertEqual(find_request(self.directory, 'pending', {'action': 'upgrade', 'releaseId': 'old'})['stage'], 'accepted')

    def test_actual_uds_duplicate_after_service_restart_returns_original_result(self):
        socket = str(self.root / 'control.sock')
        calls = []
        def restore(*args):
            calls.append(args)
            return {'stage': 'rolled_back', 'operationId': 'new-version'}
        def start():
            stop = threading.Event()
            thread = threading.Thread(target=serve_instance, args=(self.control, 'a', socket, stop), daemon=True)
            thread.start()
            for _ in range(200):
                if Path(socket).exists(): break
                time.sleep(.01)
            return stop, thread
        def post(action):
            connection = SocketHTTPConnection(socket)
            connection.request('POST', '/v1/' + action, json.dumps({'operationId': 'http-replay'}),
                               {'X-Yushuhub-Instance': 'a'})
            response = connection.getresponse()
            result = response.status, json.loads(response.read())
            connection.close()
            return result
        with patch.object(self.control, '_recover_locked', side_effect=restore):
            stop, thread = start()
            try:
                self.assertEqual(post('rollback')[0], 202)
                for _ in range(200):
                    receipt = find_request(self.directory, 'http-replay', {'action': 'rollback'})
                    if receipt['stage'] == 'rolled_back': break
                    time.sleep(.01)
                original = receipt['result']
                self.assertEqual(post('rollback'), (200, original))
            finally:
                stop.set(); thread.join(3)
            Journal(self.directory).save({'operationId': 'cli-newer'}, 'committed')
            stop, thread = start()
            try:
                self.assertEqual(post('rollback'), (200, original))
                self.assertEqual(post('recover')[0], 409)
                self.assertEqual(len(calls), 1)
                self.assertEqual(Journal(self.directory).read()['operationId'], 'cli-newer')
            finally:
                stop.set(); thread.join(3)
