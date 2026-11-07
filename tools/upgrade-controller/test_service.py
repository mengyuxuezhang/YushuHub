import http.client
import json
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path
from service import serve_instance
from state import atomic_json


class SocketHTTPConnection(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__('localhost',timeout=5); self.path=path
    def connect(self):
        self.sock=socket.socket(socket.AF_UNIX);self.sock.settimeout(5);self.sock.connect(self.path)


class ServiceTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.socket=str(self.root/'control.sock');self.stop=threading.Event();self.calls=[]
        outer=self
        class FakeControl:
            root=outer.root
            def config(self, instance):
                return {'instanceId':'fixture','stateDir':str(outer.root/'state'),'containerName':'fixture','desiredRelease':'approved'}
            def release(self, _name):return {'version':'1.9.69'}
            def apply(self, instance, release, operation):
                outer.calls.append((instance,release,operation));return {'stage':'committed','operationId':operation}
            def recover(self, instance, rollback_committed=False):return {'stage':'rolled_back'}
        self.thread=threading.Thread(target=serve_instance,args=(FakeControl(),'fixture',self.socket,self.stop),daemon=True)
        self.thread.start()
        for _ in range(200):
            if Path(self.socket).exists():break
            time.sleep(.01)
        self.addCleanup(self.shutdown)

    def shutdown(self):self.stop.set();self.thread.join(3)

    def request(self, method, endpoint, body=None, instance='fixture'):
        connection=SocketHTTPConnection(self.socket)
        encoded=json.dumps(body or {}).encode() if method=='POST' else None
        connection.request(method,endpoint,body=encoded,headers={'X-Yushuhub-Instance':instance,'Content-Type':'application/json'})
        response=connection.getresponse();result=(response.status,json.loads(response.read()));connection.close();return result

    def test_only_bound_instance_and_fixed_actions_are_accepted(self):
        self.assertEqual(self.request('GET','/v1/status',instance='other')[0],409)
        self.assertEqual(self.request('POST','/v1/upgrade',{'command':'rm anything'})[0],400)
        self.assertEqual(self.request('POST','/v1/shell',{})[0],404)
        self.assertEqual(self.calls,[])
        status,value=self.request('POST','/v1/upgrade',{'operationId':'fixture-request'})
        self.assertEqual(status,202)
        for _ in range(100):
            if self.calls:break
            time.sleep(.01)
        self.assertEqual(self.calls,[('fixture','approved','fixture-request')])

    def test_status_has_no_journal_plan_paths_or_secrets(self):
        atomic_json(self.root/'state/transaction.json',{'operationId':'fixture-task','stage':'needs_attention',
            'plan':{'password':'DO_NOT_EXPORT','appRoot':'/private/path'}})
        status,value=self.request('GET','/v1/status')
        self.assertEqual(status,200)
        self.assertNotIn('DO_NOT_EXPORT',json.dumps(value));self.assertNotIn('/private/path',json.dumps(value))
        self.assertEqual(value['transaction']['stage'],'needs_attention')

    @unittest.skipUnless(shutil.which('node'), 'Actual application Unix socket client requires Node')
    def test_actual_node_client_uses_the_scoped_unix_service(self):
        client = Path(__file__).resolve().parent.parent.parent / 'src/services/upgrade-controller-client.mjs'
        if not client.exists():
            self.skipTest('Requires full repository mount')
        code = "const {submitControllerUpgrade}=await import(process.argv[1]);const r=await submitControllerUpgrade({runningVersion:'1.9.68',env:{AI_ADMIN_UPGRADE_SOCKET:process.argv[2],AI_ADMIN_UPGRADE_INSTANCE_ID:'fixture'}});if(r.upgradeTask.stage!=='accepted'||r.inProgress!==true)process.exit(1)"
        result = subprocess.run(['node','--input-type=module','-e',code,client.as_uri(),self.socket],capture_output=True,text=True,timeout=15)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(len(self.calls),1)

    def test_stale_request_record_cannot_export_private_fields(self):
        atomic_json(self.root/'state/last-request.json',{'operationId':'fictional-rejected','stage':'failed',
            'password':'DO_NOT_EXPORT','error':'/private/path'})
        _, value = self.request('GET','/v1/status')
        self.assertNotIn('DO_NOT_EXPORT',json.dumps(value))
        self.assertNotIn('/private/path',json.dumps(value))
