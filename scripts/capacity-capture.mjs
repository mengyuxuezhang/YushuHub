import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
const name=process.argv[2]
if(!/^yushu-capacity-[a-z0-9]+$/.test(name||''))throw Error('Unexpected test container')
const p=spawnSync('docker',['exec',name,'sh','-c','MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot -e "SHOW ENGINE INNODB STATUS\\G"'],{encoding:'utf8',windowsHide:true})
if(p.status)throw Error(p.stderr)
fs.writeFileSync(new URL('../capacity-results/innodb-cold.txt',import.meta.url),p.stdout)
console.log('Saved isolated InnoDB lock evidence')
