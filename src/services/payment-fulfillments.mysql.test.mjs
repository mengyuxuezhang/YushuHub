import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import mysql from 'mysql2/promise'
import { getPool, setPool } from '../db/pool.mjs'
import { migratePaymentFulfillments, readPaymentFulfillment } from '../repositories/payment-fulfillments.mjs'
import { fulfillPaidOrder } from './payments.mjs'
import { migratePaymentRefunds } from '../repositories/payment-refunds.mjs'

test('real MySQL payment fulfillment receipts preserve prior rights, serialize callbacks and survive rollback and lost commit replies', { skip: !process.env.LICENSING_TEST_DB }, async () => {
  const { gatewayDatabase, licenseDatabase, ...config } = JSON.parse(process.env.LICENSING_TEST_DB)
  if (config.host !== '127.0.0.1') throw new Error('Disposable local MySQL required')
  const name = `yushu_payment_receipt_${crypto.randomBytes(5).toString('hex')}`, admin = await mysql.createConnection(config)
  let pool, created = false, previousPool
  try { previousPool = getPool() } catch {}
  try {
    await admin.query('CREATE DATABASE ??', [name]); created = true
    // Existing membership date writers use local wall-clock MySQL dates.
    pool = mysql.createPool({ ...config, timezone: 'local', database: name, connectionLimit: 12 }); setPool(pool)
    await pool.query("CREATE TABLE ai_end_users(id VARCHAR(64) PRIMARY KEY, credit_balance DECIMAL(18,6),organization_id VARCHAR(64) DEFAULT 'test-payment-org')")
    await pool.query('CREATE TABLE ai_membership_cards(id VARCHAR(64) PRIMARY KEY,name VARCHAR(120),created_by VARCHAR(64))')
    await pool.query(`CREATE TABLE ai_end_user_memberships(id VARCHAR(64) PRIMARY KEY,user_id VARCHAR(64),card_id VARCHAR(64),package_name VARCHAR(120),
      started_at DATETIME(3),expires_at DATETIME(3),points_expires_at DATETIME(3),status VARCHAR(24),source VARCHAR(32),created_by VARCHAR(64),created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),organization_id VARCHAR(64))`)
    await pool.query(`CREATE TABLE ai_credit_ledger(id VARCHAR(64) PRIMARY KEY,user_id VARCHAR(64),change_type VARCHAR(32),points_delta DECIMAL(18,6),balance_after DECIMAL(18,6),note VARCHAR(255),request_id VARCHAR(80),organization_id VARCHAR(64))`)
    await pool.query(`CREATE TABLE ai_payment_orders(id VARCHAR(64) PRIMARY KEY,order_no VARCHAR(32),owner_user_id VARCHAR(64),user_id VARCHAR(64),config_id VARCHAR(64),provider VARCHAR(24),
      card_id VARCHAR(64),card_name VARCHAR(120),package_name VARCHAR(120),package_snapshot_json JSON,amount_fen BIGINT,currency VARCHAR(8),status VARCHAR(24),provider_trade_no VARCHAR(128),
      paid_at DATETIME(3),fulfilled_at DATETIME(3),fulfillment_membership_id VARCHAR(64),last_error VARCHAR(500))`)
    await migratePaymentFulfillments(pool)
    await migratePaymentRefunds(pool)
    await pool.query("INSERT INTO ai_membership_cards VALUES ('vip','虚构会员','owner')")
    for (const id of ['one', 'two', 'three', 'zero', 'legacy']) {
      await pool.query('INSERT INTO ai_end_users(id,credit_balance) VALUES (?,10)', [`user-${id}`])
      await pool.query("INSERT INTO ai_end_user_memberships(id,user_id,card_id,package_name,started_at,expires_at,status,source,created_by,organization_id) VALUES (?,?,'vip','原会员','2026-01-01','2070-01-01','active','payment','owner','test-payment-org')", [`prior-${id}`, `user-${id}`])
      await pool.query("INSERT INTO ai_payment_orders(id,order_no,owner_user_id,user_id,config_id,provider,card_id,card_name,package_name,package_snapshot_json,amount_fen,currency,status,provider_trade_no,fulfillment_membership_id,last_error) VALUES (?,?,'owner',?,'original-config','alipay','vip','虚构会员','新会员',?,990,'CNY','pending','','','')",
        [`order-${id}`, `ORDER_${id}`, `user-${id}`, JSON.stringify({ name: '新会员', durationDays: 30, bonusPoints: id === 'zero' ? 0 : 20.123456, pointsDurationDays: 30, _paymentMerchant: { version: 1, provider: 'alipay', appId: 'original-app', sellerId: 'original-seller', environment: 'sandbox' } })])
    }
    const order = async id => (await pool.query('SELECT * FROM ai_payment_orders WHERE id=?', [`order-${id}`]))[0][0]
    const balance = async id => (await pool.query('SELECT CAST(credit_balance AS CHAR) AS value FROM ai_end_users WHERE id=?', [`user-${id}`]))[0][0].value
    await Promise.all(Array.from({ length: 10 }, () => fulfillPaidOrder('order-one', 'TRADE_one', 990)))
    assert.equal(await balance('one'), '30.123456')
    const original = await order('one'), receipt = await readPaymentFulfillment(pool, original, { ownerUserId: 'owner', userId: 'user-one' })
    assert.equal(receipt.points, '20.123456'); assert.equal(receipt.membership.id, original.fulfillment_membership_id)
    assert.equal(receipt.merchantBinding.appId, 'original-app')
    assert.equal(receipt.previousMemberships.length, 1); assert.equal(receipt.previousMemberships[0].id, 'prior-one')
    assert.equal(receipt.previousMemberships[0].expiresAt, '2070-01-01 00:00:00.000')
    assert.equal(receipt.membership.expiresAt, '2070-01-31 00:00:00.000')
    const [[counts]] = await pool.query("SELECT (SELECT COUNT(*) FROM ai_payment_fulfillments) AS receipts,(SELECT COUNT(*) FROM ai_credit_ledger WHERE user_id='user-one') AS entries")
    assert.equal(Number(counts.receipts), 1); assert.equal(Number(counts.entries), 1)
    await assert.rejects(readPaymentFulfillment(pool, original, { ownerUserId: 'another-owner' }), { code: 'NOT_FOUND' })
    await assert.rejects(readPaymentFulfillment(pool, { ...original, amount_fen: 991 }), { code: 'PAYMENT_FULFILLMENT_CHANGED' })
    const changedPackage = typeof original.package_snapshot_json === 'string' ? JSON.parse(original.package_snapshot_json) : original.package_snapshot_json
    await assert.rejects(readPaymentFulfillment(pool, { ...original, package_snapshot_json: { ...changedPackage, _paymentMerchant: { ...changedPackage._paymentMerchant, appId: 'changed-merchant' } } }), { code: 'PAYMENT_FULFILLMENT_CHANGED' })
    await assert.rejects(readPaymentFulfillment(pool, await order('two')), { code: 'PAYMENT_FULFILLMENT_MISSING' })
    await assert.rejects(fulfillPaidOrder('order-two', 'TRADE_two', 1), /金额不一致/)
    assert.equal(await balance('two'), '10.000000')
    const originalConnection = pool.getConnection.bind(pool); let beforeCommit = true
    pool.getConnection = async () => {
      const connection = await originalConnection(), commit = connection.commit.bind(connection)
      connection.commit = async () => { if (beforeCommit) { beforeCommit = false; throw new Error('simulated failure before receipt commit') }; return commit() }
      return connection
    }
    await assert.rejects(fulfillPaidOrder('order-two', 'TRADE_two', 990), /before receipt commit/)
    assert.equal(await balance('two'), '10.000000'); assert.equal((await order('two')).status, 'pending')
    assert.equal((await pool.query("SELECT status FROM ai_end_user_memberships WHERE id='prior-two'"))[0][0].status, 'active')
    assert.equal(Number((await pool.query("SELECT COUNT(*) AS n FROM ai_payment_fulfillments WHERE order_id='order-two'"))[0][0].n), 0)
    pool.getConnection = originalConnection
    await fulfillPaidOrder('order-two', 'TRADE_two', 990)
    let afterCommit = true
    pool.getConnection = async () => {
      const connection = await originalConnection(), commit = connection.commit.bind(connection)
      connection.commit = async () => { await commit(); if (afterCommit) { afterCommit = false; throw new Error('simulated committed receipt reply loss') } }
      return connection
    }
    await assert.rejects(fulfillPaidOrder('order-three', 'TRADE_three', 990), /reply loss/)
    pool.getConnection = originalConnection
    await fulfillPaidOrder('order-three', 'TRADE_three', 990)
    assert.equal(await balance('three'), '30.123456')
    assert.equal((await readPaymentFulfillment(pool, await order('three'))).providerTradeNo, 'TRADE_three')
    await fulfillPaidOrder('order-zero', 'TRADE_zero', 990)
    const zero = await readPaymentFulfillment(pool, await order('zero')); assert.equal(zero.points, '0.000000'); assert.equal(zero.creditEntryId, '')
    await pool.query("UPDATE ai_payment_orders SET status='paid',fulfilled_at=CURRENT_TIMESTAMP(3),fulfillment_membership_id='prior-legacy',provider_trade_no='TRADE_legacy' WHERE id='order-legacy'")
    await fulfillPaidOrder('order-legacy', 'TRADE_legacy', 990)
    await assert.rejects(readPaymentFulfillment(pool, await order('legacy')), { code: 'PAYMENT_FULFILLMENT_MISSING' })
    for (const table of ['ai_credit_ledger', 'ai_end_user_memberships']) {
      const [[ownership]] = await pool.query(`SELECT COUNT(*) n FROM ${table} t JOIN ai_end_users u ON u.id=t.user_id WHERE t.organization_id IS NULL OR t.organization_id<>u.organization_id`)
      assert.equal(Number(ownership.n), 0, 'Payment rights and ledger ownership must be correct before any restart')
    }
    assert.equal(await balance('legacy'), '10.000000')
    await pool.query("UPDATE ai_payment_fulfillments SET payload=JSON_SET(payload,'$.points','99.000000') WHERE order_id='order-one'")
    await assert.rejects(readPaymentFulfillment(pool, original), { code: 'PAYMENT_FULFILLMENT_CHANGED' })
  } finally {
    setPool(previousPool || null); await pool?.end()
    if (created) { assert(/^yushu_payment_receipt_[a-f0-9]{10}$/.test(name)); await admin.query('DROP DATABASE ??', [name]) }
    await admin.end()
  }
})
