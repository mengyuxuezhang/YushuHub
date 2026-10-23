export function slugify(value, fallback = 'ai') {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return slug || fallback
}

export function safeProjectId(value) {
  const id = String(value || '').trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9_-]{1,62}$/.test(id)) {
    throw new Error('项目 ID 只能使用小写字母、数字、短横线或下划线，长度 2-63 位')
  }
  return id
}

export function safeUsername(value) {
  const username = String(value || '').trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9_.-]{2,62}$/.test(username)) {
    throw new Error('账号只能使用小写字母、数字、点、短横线或下划线，长度 3-63 位')
  }
  return username
}

export function safeCenterId(value, label = 'ID') {
  const id = slugify(value, '').slice(0, 64)
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(id)) {
    throw new Error(`${label} 只能使用小写字母、数字、短横线或下划线，长度 2-64 位`)
  }
  return id
}

export function safeEndUsername(value) {
  const username = String(value || '').trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9_.@-]{2,119}$/.test(username)) {
    throw new Error('注册账号只能使用字母、数字、点、短横线、下划线或 @，长度 3-120 位')
  }
  return username
}
