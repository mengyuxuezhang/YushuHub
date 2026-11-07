const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`

// This runs before ZIP reads/uploads or PM2 selection, including interrupted cutovers.
export function deploymentProbeScript(appDir) {
  if (!String(appDir).startsWith('/')) throw new Error('应用目录必须为绝对路径')
  const script = `import json,os,pathlib,re,stat,sys
r=pathlib.Path(sys.argv[1]); p=r/'.yushuhub-deployment.json'
if not p.exists() and not p.is_symlink():
 print(json.dumps({'mode':'pm2'}));sys.exit(0)
if r.is_symlink() or r.resolve()!=r or p.is_symlink(): raise ValueError('DEPLOYMENT_MARKER_REQUIRES_REVIEW')
s=p.stat()
if s.st_uid!=0 or s.st_mode & 0o022: raise ValueError('DEPLOYMENT_MARKER_REQUIRES_REVIEW')
d=json.loads(p.read_text())
if d.get('format')!=1 or d.get('mode')!='docker-controller' or not re.fullmatch('[a-z][a-z0-9-]{0,47}',d.get('instanceId','')): raise ValueError('DEPLOYMENT_MARKER_REQUIRES_REVIEW')
c=pathlib.Path('/etc/yushuhub-upgrade/instances')/(d['instanceId']+'.json')
if c.is_symlink() or c.stat().st_uid!=0 or c.stat().st_mode & 0o022 or json.loads(c.read_text()).get('appRoot')!=str(r): raise ValueError('CONTROLLER_REGISTRATION_MISMATCH')
print(json.dumps({'mode':'docker-controller','instanceId':d['instanceId']}))`
  return `python3 -c ${quote(script)} ${quote(appDir)}`
}

export function controllerCommand(instance, action) {
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(instance || '') || !['info', 'status', 'upgrade', 'recover', 'rollback'].includes(action)) throw new Error('无效的独立升级操作')
  return `/usr/local/sbin/yushuhub-upgrade ${action} --instance ${quote(instance)}${['upgrade', 'recover', 'rollback'].includes(action) ? ' --apply' : ''}`
}
