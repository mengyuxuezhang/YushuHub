import json
import unittest
from unittest.mock import patch
from engine import Docker, EngineError
from scan import parse_pm2_list


class Pm2OutputTest(unittest.TestCase):
    def test_cold_start_banners_and_colors_do_not_hide_structured_processes(self):
        rows = [{'name':'fixture','pm_id':0,'pid':123,'pm2_env':{'pm_cwd':'/srv/fixture','status':'stopped'}}]
        output = '\x1b[32m[PM2] Spawning PM2 daemon\x1b[39m\n[PM2] Successfully daemonized\n' + json.dumps(rows) + '\n'
        self.assertEqual(parse_pm2_list(output), rows)
        self.assertEqual(parse_pm2_list('[PM2] Successfully daemonized\n[]\n'), [])

    def test_incomplete_or_non_pm2_arrays_are_not_interpreted_as_empty(self):
        for output in ('[PM2] daemon failed', '[{"name":"x"}]', '[]\nunknown trailing result', '[{"pm2_env":{}}]'):
            with self.subTest(case=output[:12]):
                with self.assertRaisesRegex(ValueError,'INVALID_PM2_PROCESS_LIST'):
                    parse_pm2_list(output)

    def test_recovery_bootstraps_daemon_once_before_jlist(self):
        calls=[]
        def run(args):
            calls.append(args)
            return '[PM2] daemon started\npong' if args[-1]=='ping' else '[PM2] startup message\n[]'
        engine=Docker()
        with patch.object(engine,'run',side_effect=run):
            self.assertEqual(engine.pm2_processes(start_daemon=True),[])
        self.assertEqual(calls,[['pm2','ping'],['pm2','jlist']])

    def test_uncertain_daemon_bootstrap_is_propagated_without_starting_old_writer(self):
        engine=Docker()
        with patch.object(engine,'run',side_effect=EngineError('COMMAND_OUTCOME_UNKNOWN')):
            with self.assertRaisesRegex(EngineError,'COMMAND_OUTCOME_UNKNOWN'):
                engine.pm2_processes(start_daemon=True)
