import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadLocalEnvFile } from './load-local-env.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export const repoRoot = path.resolve(__dirname, '..', '..')

loadLocalEnvFile(repoRoot)

export const APP_LOG_DIR = path.join(repoRoot, 'logs')
export const APP_LOG_FILE = path.join(APP_LOG_DIR, 'app.log')

export const LEGACY_UPLOAD_DIR = path.join(repoRoot, 'cloud', 'ai-admin', 'uploads')
export const UPLOAD_DIR = process.env.AI_UPLOAD_DIR || path.join(repoRoot, 'data', 'uploads')

export const PUBLIC_UPDATE_ROOT = process.env.AI_UPDATE_ROOT || path.join(repoRoot, 'release', 'published-ai')
export const PUBLIC_PREVIEW_ROOT = process.env.AI_PREVIEW_ROOT || path.join(path.dirname(PUBLIC_UPDATE_ROOT), 'ai-staging')

export const SELF_UPDATE_WORK_DIR = process.env.AI_ADMIN_UPDATE_WORK_DIR || path.join(repoRoot, 'data', 'self-update')
export const CURATED_SKILL_ROOT = process.env.AI_CURATED_SKILL_ROOT || path.join(repoRoot, 'data', 'curated-skills')
export const CURATED_SKILL_KEK_PATH = process.env.AI_CURATED_SKILL_KEK_PATH || path.join(repoRoot, 'data', 'curated-skill-market.key')
export const CURATED_SKILL_SIGNING_PRIVATE_PATH = process.env.AI_CURATED_SKILL_SIGNING_PRIVATE_PATH || path.join(repoRoot, 'data', 'curated-skill-signing-private.pem')
export const CURATED_SKILL_SIGNING_PUBLIC_PATH = process.env.AI_CURATED_SKILL_SIGNING_PUBLIC_PATH || path.join(repoRoot, 'data', 'curated-skill-signing-public.pem')
export const CUSTOM_HOMEPAGE_ROOT = process.env.AI_CUSTOM_HOMEPAGE_ROOT || path.join(repoRoot, 'data', 'custom-homepage')
export const CUSTOM_HOMEPAGE_SITE_DIR = path.join(CUSTOM_HOMEPAGE_ROOT, 'site')
export const CUSTOM_HOMEPAGE_CONFIG_PATH = path.join(CUSTOM_HOMEPAGE_ROOT, 'config.json')
export const MODEL_CREDENTIAL_KEY_PATH = process.env.AI_MODEL_CREDENTIAL_KEY_PATH || path.join(repoRoot, 'data', 'model-credentials.key')
export const VOICE_ARTIFACT_ROOT = process.env.AI_VOICE_ARTIFACT_ROOT || path.join(repoRoot, 'data', 'voice-artifacts')

export const WEB_INDEX_PATH = path.join(repoRoot, 'web', 'index.html')
export const ADMIN_V2_INDEX_PATH = path.join(repoRoot, 'web', 'admin-v2', 'index.html')
export const SITE_INDEX_PATH = path.join(repoRoot, 'web', 'site', 'index.html')
