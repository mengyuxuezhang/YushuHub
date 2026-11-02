import assert from 'node:assert/strict'
import test from 'node:test'
import { createOperatorAuth, passwordHash, totp } from './operator-auth.mjs'

function fixture(loginMode) {
  let timestamp = 1_800_000_000_000
  const state = { sessions: {}, otpCounters: {}, audit: [] }
  const store = { read: async () => structuredClone(state), transaction: async work => work(state) }
  const operators = [{ id: 'test-operator', passwordHash: passwordHash('test-password'), totpSecret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP' }]
  const now = () => timestamp
  const auth = createOperatorAuth({ store, operators, now, loginMode })
  const input = { username: operators[0].id, password: 'test-password' }
  const captcha = (address = 'test-client') => {
    const challenge = auth.challenge(address)
    const svg = Buffer.from(challenge.imageDataUrl.split(',')[1], 'base64').toString()
    const captchaAnswer = [...svg.matchAll(/<text[^>]*>([^<]+)<[/]text>/g)].map(match => match[1]).join('')
    return { ...input, challengeId: challenge.challengeId, captchaAnswer }
  }
  return { auth, input, captcha, state, store, operators, now, advance: ms => { timestamp += ms } }
}

test('operator login defaults to TOTP, rejects caller-selected captcha mode, and consumes OTP once', async () => {
  const f = fixture()
  assert.deepEqual(f.auth.challenge('test-client'), { mode: 'totp' })
  await assert.rejects(f.auth.login({ ...f.input, loginMode: 'captcha' }, 'test-client'), { code: 'LOGIN_FAILED' })
  const code = totp(f.operators[0].totpSecret, Math.floor(f.now() / 30_000))
  const session = await f.auth.login({ ...f.input, code }, 'test-client')
  assert.equal(await f.auth.authenticate(session.token), f.input.username)
  await assert.rejects(f.auth.login({ ...f.input, code }, 'test-client'), { code: 'OTP_REPLAY' })
})

test('captcha mode requires a valid one-use image challenge and a correct password', async () => {
  const f = fixture('captcha')
  await assert.rejects(f.auth.login(f.input, 'test-client'), { code: 'LOGIN_CAPTCHA_INVALID' })
  await assert.rejects(f.auth.login({ ...f.captcha(), password: 'wrong' }, 'test-client'), { code: 'LOGIN_FAILED' })
  const input = f.captcha()
  const session = await f.auth.login(input, 'test-client')
  assert.equal(await f.auth.authenticate(session.token), f.input.username)
  await assert.rejects(f.auth.login(input, 'test-client'), { code: 'LOGIN_CAPTCHA_INVALID' })
  assert.equal(f.state.audit[0].loginMode, 'captcha')
  assert.deepEqual(f.state.otpCounters, {})
})

test('captcha rejects wrong answers, another address, expiry and exhausted attempts', async () => {
  const wrong = fixture('captcha')
  await assert.rejects(wrong.auth.login({ ...wrong.captcha(), captchaAnswer: 'XXXXX' }, 'test-client'), { code: 'LOGIN_CAPTCHA_INVALID' })
  const bound = fixture('captcha')
  await assert.rejects(bound.auth.login(bound.captcha(), 'another-client'), { code: 'LOGIN_CAPTCHA_INVALID' })
  const expired = fixture('captcha'), input = expired.captcha()
  expired.advance(300_001)
  await assert.rejects(expired.auth.login(input, 'test-client'), { code: 'LOGIN_CAPTCHA_INVALID' })
  const blocked = fixture('captcha')
  for (let i = 0; i < 5; i++) await assert.rejects(blocked.auth.login(blocked.input, 'test-client'))
  await assert.rejects(blocked.auth.login(blocked.captcha(), 'test-client'), { code: 'RATE_LIMITED' })
})

test('switching login mode invalidates old sessions and restores the retained TOTP secret', async () => {
  const f = fixture('captcha'), captchaSession = await f.auth.login(f.captcha(), 'test-client')
  const restored = createOperatorAuth({ store: f.store, operators: f.operators, now: f.now })
  await assert.rejects(restored.authenticate(captchaSession.token), { code: 'OPERATOR_UNAUTHORIZED' })
  const code = totp(f.operators[0].totpSecret, Math.floor(f.now() / 30_000))
  const session = await restored.login({ ...f.input, code }, 'test-client')
  assert.equal(await restored.authenticate(session.token), f.input.username)
  await assert.rejects(f.auth.authenticate(session.token), { code: 'OPERATOR_UNAUTHORIZED' })
  assert.throws(() => createOperatorAuth({ store: f.store, operators: f.operators, loginMode: 'disabled' }), /login mode/)
})

test('only the bootstrapped owner creates or resets other admins; resetting invalidates their sessions', async () => {
  const f=fixture('captcha'), owner=f.input.username
  await f.auth.initialize()
  const created=await f.auth.createAccount(owner,{username:'test-admin',displayName:'测试管理员',password:'Test-password-123',role:'owner'})
  assert.equal(created.account.role,'admin');assert.equal(created.totpSecret.length,32)
  assert.equal((await f.auth.profile(owner)).canManageAccounts,true)
  await assert.rejects(f.auth.createAccount(owner,{username:'TEST-ADMIN',password:'Test-password-123'}),{code:'ACCOUNT_EXISTS'})
  for(const operation of [()=>f.auth.listAccounts('test-admin'),()=>f.auth.createAccount('test-admin',{username:'forged',password:'Test-password-123'}),()=>f.auth.resetPassword('test-admin',owner,{password:'Test-password-456'})])await assert.rejects(operation(),{code:'ACCOUNT_MANAGEMENT_DENIED'})
  const login=await f.auth.login({...f.captcha(),username:'test-admin',password:'Test-password-123'},'test-client')
  await f.auth.resetPassword(owner,'test-admin',{password:'Test-password-456'})
  await assert.rejects(f.auth.authenticate(login.token),{code:'OPERATOR_UNAUTHORIZED'})
  await assert.rejects(f.auth.login({...f.captcha(),username:'test-admin',password:'Test-password-123'},'test-client'),{code:'LOGIN_FAILED'})
  assert.equal(await f.auth.authenticate((await f.auth.login({...f.captcha(),username:'test-admin',password:'Test-password-456'},'test-client')).token),'test-admin')
  const listed=JSON.stringify(await f.auth.listAccounts(owner));assert(!listed.includes('passwordHash'));assert(!listed.includes(created.totpSecret))
})

test('self password changes require the old password, ignore target spoofing and survive restart without reseeding', async () => {
  const f=fixture('captcha'), session=await f.auth.login(f.captcha(),'test-client'),owner=f.input.username
  await assert.rejects(f.auth.changePassword(owner,{currentPassword:'wrong',newPassword:'Test-password-456'}),{code:'CURRENT_PASSWORD_INVALID'})
  await f.auth.changePassword(owner,{currentPassword:f.input.password,newPassword:'Test-password-456',username:'another-admin'})
  await assert.rejects(f.auth.authenticate(session.token),{code:'OPERATOR_UNAUTHORIZED'})
  const restarted=createOperatorAuth({store:f.store,operators:f.operators,now:f.now,loginMode:'captcha'});await restarted.initialize()
  await assert.rejects(f.auth.login(f.captcha(),'test-client'),{code:'LOGIN_FAILED'})
  const next=await f.auth.login({...f.captcha(),password:'Test-password-456'},'test-client');assert.equal(await restarted.authenticate(next.token),owner)
  assert(!JSON.stringify(f.state.audit).includes('Test-password-456'))
  await assert.rejects(f.auth.resetPassword(owner,owner,{password:'Test-password-789'}),{code:'USE_SELF_PASSWORD'})
  await assert.rejects(f.auth.changePassword(owner,{currentPassword:'Test-password-456',newPassword:'short'}),{code:'WEAK_PASSWORD'})
})
