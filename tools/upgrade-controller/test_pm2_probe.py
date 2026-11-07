import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from controller import Controller
from engine import Docker
from scan import pm2_daemon_available


class Pm2ProbeTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.home = Path(self.temporary.name)
        self.environment = patch.dict(os.environ, {'PM2_HOME': str(self.home)})
        self.environment.start(); self.addCleanup(self.environment.stop)

    def probe(self, error):
        with patch('scan.socket.socket') as factory:
            factory.return_value.__enter__.return_value.connect.side_effect = error
            return pm2_daemon_available()

    def test_timeout_permission_and_unknown_errors_are_not_absence(self):
        for error in (TimeoutError(), PermissionError(), OSError('unknown endpoint state')):
            with self.subTest(kind=type(error).__name__):
                with self.assertRaisesRegex(ValueError, '^PM2_DAEMON_STATE_UNKNOWN$'):
                    self.probe(error)

    def test_missing_or_refused_endpoint_without_daemon_is_known_absent(self):
        for error in (FileNotFoundError(), ConnectionRefusedError()):
            self.assertFalse(self.probe(error))

    def test_missing_or_refused_endpoint_with_live_pid_is_unknown(self):
        (self.home/'pm2.pid').write_text(str(os.getpid()))
        for error in (FileNotFoundError(), ConnectionRefusedError()):
            with self.assertRaisesRegex(ValueError, '^PM2_DAEMON_STATE_UNKNOWN$'):
                self.probe(error)

    def test_stale_pid_allows_confirmed_absence_but_invalid_pid_does_not(self):
        (self.home/'pm2.pid').write_text('123456789')
        with patch('scan.os.kill', side_effect=ProcessLookupError()):
            self.assertFalse(self.probe(ConnectionRefusedError()))
        (self.home/'pm2.pid').write_text('invalid')
        with self.assertRaisesRegex(ValueError, '^PM2_DAEMON_STATE_UNKNOWN$'):
            self.probe(FileNotFoundError())

    def test_unknown_probe_blocks_preflight_even_without_a_pm2_executable(self):
        engine = Docker()
        control = Controller(self.home/'state', self.home/'config', engine)
        with patch.object(engine, 'available'), patch.object(engine, 'run') as run, \
             patch('controller.shutil.which', return_value=None), \
             patch('engine.pm2_daemon_available', side_effect=ValueError('PM2_DAEMON_STATE_UNKNOWN')):
            with self.assertRaisesRegex(ValueError, '^PM2_DAEMON_STATE_UNKNOWN$'):
                control.preflight({'config': {}})
            run.assert_not_called()
