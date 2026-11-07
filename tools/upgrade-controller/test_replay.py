"""S3-03: real child process locks/SIGKILL; isolated state, no business calls."""
import json
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch
from controller import Controller
from pm2_zip import Pm2ZipController
from service import serve_instance, public_status
from state import Journal, atomic_json, find_request, reserve_request, save_request, replay_request
from test_service import SocketHTTPConnection


class ReplayTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / 'state'
        self.config = self.base / 'config'
        self.control = Controller(self.root, self.config)
        atomic_json(self.config / 'instances/a.json', {'instanceId': 'a', 'appRoot': '/fictional/a', 'port': 17199})
        self.directory = self.root / 'instances/a'
        self.module = str(Path(__file__).resolve().parent)
        self.socket = str(self.base / 'control.sock')

    def child(self, directory, operation):
        ready = self.base / (operation + '.ready')
        code = '''
import sys,time
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from state import locks,execute_request,Journal
root,directory,operation,ready=sys.argv[2:]
def effect():
    Journal(directory).save({'operationId':'original-upgrade'}, 'rolled_back')
    Path(ready).touch()
    while True:time.sleep(.05)
with locks(root,['host-cutover']):
    execute_request(directory,operation,{'action':'rollback'},effect,root=root)
'''
        process = subprocess.Popen([sys.executable, '-B', '-c', code, self.module,
                                    str(self.root), str(directory), operation, str(ready)],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.addCleanup(lambda: self.kill(process))
        for _ in range(300):
            if ready.exists(): return process
            if process.poll() is not None:
                self.fail(process.communicate()[1].decode())
            time.sleep(.01)
        self.fail('Child did not acquire its execution lock')

    def kill(self, process):
        if process.poll() is None:
            process.kill()  # SIGKILL on the Linux test host releases kernel locks.
        process.communicate(timeout=5)

    def start_service(self):
        stop = threading.Event()
        thread = threading.Thread(target=serve_instance,
            args=(self.control, 'a', self.socket, stop), daemon=True)
        thread.start()
        for _ in range(200):
            if Path(self.socket).exists(): break
            time.sleep(.01)
        def close():
            stop.set(); thread.join(3)
        self.addCleanup(close)
        return close

    def post(self, operation):
        client = SocketHTTPConnection(self.socket)
        client.request('POST', '/v1/rollback', json.dumps({'operationId': operation}),
                       {'X-Yushuhub-Instance': 'a'})
        response = client.getresponse()
        value = response.status, json.loads(response.read())
        client.close()
        return value

    def test_http_and_controller_live_then_killed_then_new_recovery_and_restart(self):
        process = self.child(self.directory, 'old-unknown')
        close = self.start_service()  # Startup must not reclassify a live CLI worker.
        self.assertEqual(self.post('old-unknown')[1]['stage'], 'running')
        self.assertEqual(self.control.recover('a', True, 'old-unknown')['stage'], 'running')
        self.assertEqual(find_request(self.directory, 'old-unknown', {'action': 'rollback'})['stage'], 'running')
        self.kill(process)
        def recover(*args):
            Journal(self.directory).save({'operationId': 'original-upgrade'}, 'rolled_back')
            return {'operationId': 'original-upgrade', 'stage': 'rolled_back'}
        with patch.object(self.control, '_recover_locked', side_effect=recover) as backend:
            self.control.recover('a', False, 'new-explicit-recover')
            self.assertEqual(backend.call_count, 1)
        journal = (self.directory / 'transaction.json').read_bytes()
        last = (self.directory / 'last-request.json').read_bytes()
        sequence = (self.directory / 'event-order.json').read_bytes()
        close(); self.start_service()
        with patch.object(self.control, '_recover_locked', side_effect=AssertionError('old callback executed')):
            status, http = self.post('old-unknown')
            self.assertEqual(status, 200)
            self.assertEqual(http['stage'], 'needs_attention')
            self.assertEqual(http, self.control.recover('a', True, 'old-unknown'))
        self.assertEqual((self.directory / 'transaction.json').read_bytes(), journal)
        self.assertEqual((self.directory / 'last-request.json').read_bytes(), last)
        self.assertEqual((self.directory / 'event-order.json').read_bytes(), sequence)
        with patch('service.refresh_catalog', return_value=(None, None)):
            self.assertEqual(public_status(self.control, 'a')['transaction']['operationId'], 'new-explicit-recover')

    def zip_main(self, app, operation):
        request = self.base / 'zip-request.json'
        atomic_json(request, {'appRoot': app, 'operationId': operation})
        # Execute the real main dispatcher in a separate interpreter. Only its root
        # factory is mapped into this test's temporary state; no shared /var/lib.
        code = '''
import sys
sys.path.insert(0,sys.argv[1])
import pm2_zip
original=pm2_zip.Pm2ZipController
root,config=sys.argv[2:4]
pm2_zip.Pm2ZipController=lambda:original(root,config)
sys.argv=['pm2_zip.py','rollback','--request',sys.argv[4]]
pm2_zip.main()
'''
        result = subprocess.run([sys.executable, '-B', '-c', code, self.module,
            str(self.root), str(self.config), str(request)], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_zip_executable_and_controller_agree_while_live_and_after_sigkill(self):
        control = Pm2ZipController(self.root, self.config)
        app = '/fictional/zip-a'
        directory = control.directory(app)
        process = self.child(directory, 'zip-unknown')
        self.assertEqual(self.zip_main(app, 'zip-unknown')['stage'], 'running')
        self.assertEqual(control.recover_zip(app, True, 'zip-unknown')['stage'], 'running')
        self.kill(process)
        with patch.object(control, '_recover_zip_locked', return_value={'stage': 'rolled_back', 'operationId': 'original-upgrade'}):
            control.recover_zip(app, False, 'new-zip-recover')
        before = [(directory / name).read_bytes() for name in ('transaction.json', 'last-request.json', 'event-order.json')]
        with patch.object(control, '_recover_zip_locked', side_effect=AssertionError('ZIP callback repeated')):
            executable = self.zip_main(app, 'zip-unknown')
            self.assertEqual(executable['stage'], 'needs_attention')
            self.assertEqual(executable, control.recover_zip(app, True, 'zip-unknown'))
        self.assertEqual(before, [(directory / name).read_bytes() for name in ('transaction.json', 'last-request.json', 'event-order.json')])

    def test_another_live_host_operation_does_not_make_old_receipt_live(self):
        receipt = reserve_request(self.directory, 'orphan', {'action': 'rollback'})
        receipt['stage'] = 'running'
        save_request(self.directory, receipt)
        process = self.child(self.directory, 'actually-running')
        result = replay_request(self.root, self.directory, 'orphan', {'action': 'rollback'})
        self.assertEqual(result['stage'], 'needs_attention')
        self.assertEqual(replay_request(self.root, self.directory, 'actually-running', {'action': 'rollback'})['stage'], 'running')
        self.kill(process)

    def test_parallel_replays_are_not_mistaken_for_a_live_executor(self):
        receipt = reserve_request(self.directory, 'orphan', {'action': 'rollback'})
        receipt['stage'] = 'running'
        save_request(self.directory, receipt)
        sequence = (self.directory / 'event-order.json').read_bytes()
        with ThreadPoolExecutor(max_workers=12) as pool:
            replies = list(pool.map(lambda _: replay_request(self.root, self.directory,
                'orphan', {'action': 'rollback'}), range(48)))
        self.assertTrue(all(r['stage'] == 'needs_attention' for r in replies))
        self.assertEqual((self.directory / 'event-order.json').read_bytes(), sequence)
