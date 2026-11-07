"""Run ONLY inside the dedicated lab controller container, on its new named volume."""
import json
import os
import subprocess
import sys
import time
from pathlib import Path
sys.path.insert(0, '/controller')
from engine import Docker
from state import atomic_json
from scan import database_lock_key

root = Path(sys.argv[1])
instance = sys.argv[2] if len(sys.argv) > 2 else 'fixture'
db_port = sys.argv[3] if len(sys.argv) > 3 else '17087'
app_port = int(sys.argv[4]) if len(sys.argv) > 4 else 17089
if instance not in ('fixture', 'fixture57'):
    raise SystemExit('Disposable instance ID required')
if not str(root).startswith('/var/lib/docker/volumes/yushu-controller-e2e-') or root.name != '_data':
    raise SystemExit('Dedicated disposable volume required')
app = root / 'app'
if json.loads((app / 'package.json').read_text())['version'] != '1.9.66':
    raise SystemExit('Real 1.9.66 baseline required')
values = dict(AI_ADMIN_HOST='127.0.0.1', AI_ADMIN_PORT=str(app_port), AI_ADMIN_USER='fixture-admin',
    AI_ADMIN_PASSWORD='fixture-only-admin-password', AI_DB_HOST='127.0.0.1', AI_DB_PORT=db_port,
    AI_DB_USER='root', AI_DB_PASSWORD='fixture-only-local', AI_DB_NAME='fixture_controller',
    AI_AUTHORIZATION_MODE='legacy', AI_LICENSE_INSTANCE_ID='fixture-stable-instance',
    AI_WORKER_TOKEN='fixture-only-worker', AI_ADMIN_PUBLIC_URL='http://fixture.invalid',
    AI_UPDATE_ROOT=str(app / 'data/published'), AI_PREVIEW_ROOT=str(app / 'data/staging'))
(app / '.env').write_text(''.join(k+'='+v+'\n' for k,v in values.items()))
os.chmod(app / '.env', 0o600)
control = Docker()
for version, image_digest in [('1.9.66', '8da0f0a3acd48f699e9628e8c5c5fcc3130d34d52083689ba9e193c2777c6a85'),
                              ('1.9.68', '460e9796ef746625518da7b36a879bc59da4ffcbd3112a7e52627664c5df0428')]:
    image = 'localhost:14999/yushuhub-lab@sha256:' + image_digest
    control.inspect_image(image)
    contract = control.image_contract(image)
    contract.update(image=image, platform='linux/amd64', supportedFrom=['1.9.66','1.9.68'], migrationPolicy='same-schema')
    atomic_json(root / 'config/releases' / (version+'.json'), contract)
atomic_json(root / 'config/instances' / (instance+'.json'), {'instanceId':instance, 'appRoot':str(app),
    'port':app_port, 'mysqldump':'/usr/bin/mysqldump', 'memoryMiB':192, 'hostReserveMiB':128, 'databaseExclusive':True,
    'databaseLockKey':database_lock_key(values)})
probe = "const r=process.argv[1];import(require('node:url').pathToFileURL(r+'/src/config/paths.mjs').href).then(async()=>{const e=process.env;const c=await require('node:module').createRequire(r+'/package.json')('mysql2/promise').createConnection({host:e.AI_DB_HOST,port:Number(e.AI_DB_PORT),user:e.AI_DB_USER,password:e.AI_DB_PASSWORD,database:e.AI_DB_NAME,connectTimeout:2000});await c.end()}).catch(()=>process.exit(1))"
for attempt in range(60):
    if subprocess.run(['node','-e',probe,str(app)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode == 0:
        break
    time.sleep(1)
else:
    raise SystemExit('Disposable database did not become ready')
subprocess.run(['pm2','start',str(app / 'cloud/ai-admin/server.mjs'),'--name','controller-e2e-old-'+instance,'--cwd',str(app),'--interpreter','/usr/local/bin/node'],check=True,stdout=subprocess.DEVNULL)
subprocess.run(['pm2','save'],check=True,stdout=subprocess.DEVNULL)
print(json.dumps({'setup':True,'baseline':'1.9.66','fixtureDatabase':'fixture_controller'}))
