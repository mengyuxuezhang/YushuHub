import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import mysql from 'mysql2/promise'

// Read-only snapshot; this tool never switches authorization or rewrites keys/balances.
const [configFile, outputFile] = process.argv.slice(2)
if (!configFile || !outputFile) throw new Error('Usage: node scripts/authorization-upgrade-inspect.mjs <protected-mysql-config.json> <new-private-report.json>')
const config = JSON.parse(await fs.readFile(configFile, 'utf8'))
if (!config.database) throw new Error('Explicit database required')
const connection = await mysql.createConnection(config)
try {
  await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
  const [organizations] = await connection.query('SELECT id,agent_level AS agentLevel,status,expires_at AS expiresAt FROM ai_organizations ORDER BY id')
  if (organizations.some(org => Number(org.agentLevel) === 2)) throw Object.assign(new Error('SECOND_LEVEL_DATA_FOUND: 检测到二级记录，停止升级；不转换或删除'), { code: 'SECOND_LEVEL_DATA_FOUND' })
  const [projects] = await connection.query('SELECT id,organization_id AS organizationId,owner_user_id AS ownerUserId,status FROM ai_projects ORDER BY id')
  const [[builds]] = await connection.query('SELECT COUNT(*) count FROM ai_builds')
  const [[users]] = await connection.query('SELECT COUNT(*) count,COALESCE(SUM(credit_balance),0) points FROM ai_end_users')
  const [[orders]] = await connection.query('SELECT COUNT(*) count FROM ai_payment_orders')
  const [[keys]] = await connection.query("SELECT COUNT(*) count,SUM(secret_ciphertext IS NOT NULL AND secret_ciphertext<>'') encryptedCount FROM ai_model_provider_keys")
  const [models] = await connection.query("SELECT id,provider_id AS providerId,model_type AS modelType,status FROM ai_provider_models WHERE archived_at IS NULL ORDER BY id")
  await connection.commit()
  const exceptions = []
  if (projects.some(p => !p.organizationId)) exceptions.push('存在无组织项目；核对旧归属，禁止静默转换')
  if (projects.length > 2000) exceptions.push('项目超过单次授权导入上限2000；需分批工具，禁止截断')
  if (organizations.filter(o => Number(o.agentLevel) === 1).length !== 1) exceptions.push('须核实独立部署唯一经营主体')
  const report = { generatedAt: new Date().toISOString(), readOnly: true, organizations, projects, models, endUserCount: Number(users.count), terminalPoints: String(users.points), orderCount: Number(orders.count), keyCount: Number(keys.count), encryptedKeyCount: Number(keys.encryptedCount || 0),
    exceptions, historicalBuildSource: 'ai_builds 当前保留记录；若旧系统曾删除构建，须用原审计/中心凭证核实累计数后调整期初值，不能把缺失历史认作0',
    issueFragment: { initialUsage: { projects: projects.length, builds: Number(builds.count) }, initialResourceIds: { projects: projects.map(p => p.id) } },
    requiredBackups: ['完整数据库','支付密钥文件','模型凭据密钥文件','保护资源密钥与部署配置'],
    next: '冻结经营写入后重新导出并核验。审核异常与期初额度后，将issueFragment合入中心签发请求；不要将旧供应商Key用作New API Key。' }
  report.digest = crypto.createHash('sha256').update(JSON.stringify(report)).digest('hex')
  await fs.mkdir(path.dirname(path.resolve(outputFile)), { recursive: true })
  await fs.writeFile(outputFile, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 })
  console.log(`Read-only upgrade report written; exceptions=${exceptions.length}. No credentials exported.`)
} catch (error) { await connection.rollback(); throw error } finally { await connection.end() }
