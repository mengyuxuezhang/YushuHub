"""Only argv-based Docker/Compose operations. No command or shell supplied by clients."""
import hashlib
import json
import os
import re
import subprocess
import time
import urllib.request
from pathlib import Path
from scan import parse_pm2_list, pm2_daemon_available


class EngineError(RuntimeError):
    pass


class Docker:
    def pm2_processes(self, start_daemon=False):
        if start_daemon:
            self.run(['pm2', 'ping'])
        elif not pm2_daemon_available():
            return []
        return parse_pm2_list(self.run(['pm2', 'jlist']))

    def run(self, args, timeout=60):
        try:
            environment = dict(os.environ)
            environment.pop('DOCKER_CONTEXT', None)
            environment.pop('DOCKER_TLS_VERIFY', None)
            environment.pop('DOCKER_CERT_PATH', None)
            environment['DOCKER_HOST'] = 'unix:///var/run/docker.sock'
            result = subprocess.run(args, capture_output=True, text=True, timeout=timeout, env=environment)
        except (subprocess.TimeoutExpired, OSError):
            raise EngineError('COMMAND_OUTCOME_UNKNOWN') from None
        if result.returncode:
            raise EngineError('COMMAND_FAILED:' + args[0])
        return result.stdout

    def available(self):
        try:
            if self.run(['docker', 'info', '--format', '{{.OSType}}']).strip() != 'linux':
                raise EngineError('WRONG_DOCKER_PLATFORM')
        except EngineError:
            raise EngineError('DOCKER_DAEMON_UNAVAILABLE') from None

    def inspect_image(self, reference, pull=False):
        self.available()
        if pull:
            self.run(['docker', 'pull', '--platform', 'linux/amd64', reference], timeout=900)
        image = json.loads(self.run(['docker', 'image', 'inspect', reference]))[0]
        if image.get('Architecture') != 'amd64' or image.get('Os') != 'linux':
            raise EngineError('WRONG_IMAGE_PLATFORM')
        if image.get('Config', {}).get('User') not in ('node', '1000', '1000:1000'):
            raise EngineError('IMAGE_MUST_RUN_AS_NONROOT')
        if reference not in image.get('RepoDigests', []):
            raise EngineError('IMAGE_DIGEST_NOT_VERIFIED')
        return image

    def image_contract(self, reference):
        script = (Path(__file__).parent / 'runtime-contract.mjs').read_text()
        return json.loads(self.run(['docker', 'run', '--rm', '--network', 'none', '--read-only',
            '--memory', '128m', '--pids-limit', '64', '--entrypoint', 'node', reference, '--input-type=module', '-e', script, '/app']))

    def source_contract(self, app_root):
        script = (Path(__file__).parent / 'runtime-contract.mjs').read_text()
        return json.loads(self.run(['node', '--input-type=module', '-e', script, app_root]))

    def authorization_probe(self, config, use_container=False):
        script = (Path(__file__).parent / 'authorization-probe.mjs').read_text()
        if use_container:
            args = ['docker', 'exec', config['containerName'], 'node', '--input-type=module', '-e', script, '/app']
        else:
            args = ['node', '--input-type=module', '-e', script, config['appRoot']]
        result = json.loads(self.run(args, timeout=15))
        if result.get('verified') is not True or not re.fullmatch(r'[a-f0-9]{64}', result.get('identityHash', '')):
            raise EngineError('AUTHORIZATION_IDENTITY_NOT_VERIFIED')
        return result

    def container(self, name):
        # Confirm daemon reachability first. A daemon failure must never mean "absent".
        self.available()
        ids = self.run(['docker', 'ps', '-a', '--filter', 'name=^/' + name + '$', '--format', '{{.ID}}']).strip().splitlines()
        if not ids:
            return None
        return json.loads(self.run(['docker', 'container', 'inspect', ids[0]]))[0]

    def compose(self, config, action):
        options = {'up': ['up', '--no-deps', '-d', '--force-recreate', 'app'],
                   'stop': ['stop', '--timeout', '45', 'app']}
        if action not in options:
            raise ValueError('UNSUPPORTED_COMPOSE_ACTION')
        self.run(['docker', 'compose', '-f', str(config)] + options[action], timeout=120)

    def port_owner(self, port, name=None, pid=None):
        sockets = self.run(['ss', '-ltnp', 'sport = :' + str(port)])
        if name:
            top = self.run(['docker', 'top', name, '-eo', 'pid'])
            pids = [int(value) for value in top.splitlines()[1:] if value.strip().isdigit()]
        else:
            pids = [pid]
        if not any(value and ('pid=' + str(value) + ',') in sockets for value in pids):
            raise EngineError('TARGET_PORT_OWNER_MISMATCH')

    def port_is_free(self, port):
        sockets = self.run(['ss', '-ltnH', 'sport = :' + str(port)])
        if sockets.strip():
            raise EngineError('OLD_WRITER_PORT_STILL_LISTENING')

    def pm2(self, app_root, action, process_id):
        if action not in ('stop', 'restart', 'delete') or not isinstance(process_id, int):
            raise ValueError('UNSUPPORTED_PM2_ACTION')
        self.run(['pm2', action, str(process_id)], timeout=60)

    def verify(self, config, release, deadline=120, require_container=True):
        stable = 0
        end = time.monotonic() + deadline
        while time.monotonic() < end:
            try:
                if require_container:
                    container = self.container(config['containerName'])
                    if not container or not container['State']['Running'] or container['Config']['Image'] != release['image']:
                        raise ValueError('WRONG_RUNNING_IMAGE')
                    self.port_owner(config['port'], name=config['containerName'])
                else:
                    processes = self.pm2_processes(start_daemon=True)
                    selected = [p for p in processes if p.get('pm2_env', {}).get('pm_cwd') == config['appRoot'] and p.get('pm2_env', {}).get('status') == 'online']
                    if len(selected) != 1:
                        raise ValueError('PM2_RECOVERY_PROCESS_MISMATCH')
                    self.port_owner(config['port'], pid=selected[0].get('pid'))
                base = 'http://127.0.0.1:' + str(config['port'])
                with urllib.request.urlopen(base + '/api/runtime-info', timeout=4) as response:
                    data = json.load(response)
                if not data.get('success') or data.get('data', {}).get('version') != release['version']:
                    raise ValueError('WRONG_RUNNING_VERSION')
                if config.get('expectedIdentityHash'):
                    identity = self.authorization_probe(config, use_container=require_container)
                    if identity['identityHash'] != config['expectedIdentityHash']:
                        raise ValueError('AUTHORIZATION_IDENTITY_CHANGED')
                script = "const root=process.argv[1];const req=require('node:module').createRequire(root+'/package.json');import(require('node:url').pathToFileURL(root+'/src/config/paths.mjs').href).then(async()=>{const e=process.env;const c=await req('mysql2/promise').createConnection({host:e.AI_DB_HOST||'127.0.0.1',port:Number(e.AI_DB_PORT||3306),user:e.AI_DB_USER||'root',password:e.AI_DB_PASSWORD||'',database:e.AI_DB_NAME||'agent_ai',connectTimeout:4000});try{const [r]=await c.query(\"SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name IN ('ai_users','ai_platform_settings','ai_credit_ledger')\");if(Number(r[0].n)!==3)throw Error('schema');}finally{await c.end()}}).catch(()=>process.exit(1))"
                if require_container:
                    self.run(['docker', 'exec', config['containerName'], 'node', '-e', script, '/app'], timeout=10)
                else:
                    self.run(['node', '-e', script, config['appRoot']], timeout=10)
                for site in [base] + ([config['publicUrl']] if config.get('publicUrl') else []):
                    with urllib.request.urlopen(site + '/admin/v2/', timeout=5) as response:
                        html = response.read()
                    if hashlib.sha256(html).hexdigest() != release['htmlSha256']:
                        raise ValueError('WRONG_FRONTEND')
                    assets = re.findall(rb'(?:src|href)="([^"?]+/assets/[^"?]+\.(?:js|css))"', html)
                    if len(assets) < 2:
                        raise ValueError('MISSING_FRONTEND_ASSETS')
                    for asset in assets:
                        url = asset.decode()
                        if not url.startswith('/admin/v2/assets/') or '..' in url:
                            raise ValueError('INVALID_ASSET_PATH')
                        with urllib.request.urlopen(site + url, timeout=5) as response:
                            content_type = response.headers.get('Content-Type', '')
                            if (url.endswith('.js') and 'javascript' not in content_type) or (url.endswith('.css') and 'text/css' not in content_type):
                                raise ValueError('WRONG_ASSET_CONTENT_TYPE')
                stable += 1
                if stable >= 3:
                    return
            except EngineError as error:
                if str(error) in ('DOCKER_DAEMON_UNAVAILABLE', 'COMMAND_OUTCOME_UNKNOWN'):
                    raise
                stable = 0
            except Exception:
                stable = 0
            time.sleep(1)
        raise EngineError('HEALTH_OR_VERSION_VERIFICATION_FAILED')
