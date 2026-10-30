// Explicit migration only. Identifiers are binary/case-sensitive on MySQL 5.7 and 8.
const table = (name, fields) => `CREATE TABLE IF NOT EXISTS accounting_${name} (${fields}) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`
const book = 'book VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL'
const id = 'VARCHAR(120) CHARACTER SET ascii COLLATE ascii_bin'
export const ACCOUNTING_SCHEMA = [
  table('books', `${book} PRIMARY KEY, kind VARCHAR(16) NOT NULL, source_id VARCHAR(80), source_hash CHAR(64), activated_at BIGINT NOT NULL`),
  table('locks', `${book}, resource VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, PRIMARY KEY(book,resource)`),
  table('wallets', `${book}, id ${id} NOT NULL, balance DECIMAL(18,6) NOT NULL, reserved DECIMAL(18,6) NOT NULL, payload JSON NOT NULL, PRIMARY KEY(book,id)`),
  table('requests', `${book}, id ${id} NOT NULL, wallet_id ${id}, state VARCHAR(16) NOT NULL, source VARCHAR(16) NOT NULL, updated_at BIGINT NOT NULL,
    next_recovery_at BIGINT NOT NULL DEFAULT 0, payload JSON NOT NULL,
    PRIMARY KEY(book,id), KEY recovery(book,state,source,next_recovery_at), KEY stalled(book,state,updated_at), KEY wallet_history(book,wallet_id,updated_at)`),
  table('holds', `${book}, request_id ${id} NOT NULL, wallet_id ${id}, amount DECIMAL(18,6) NOT NULL, points DECIMAL(18,6) NOT NULL,
    released TINYINT NOT NULL, PRIMARY KEY(book,request_id), KEY wallet_holds(book,wallet_id,released)`),
  table('entries', `${book}, id ${id} NOT NULL, wallet_id ${id} NOT NULL, request_id ${id}, kind VARCHAR(32) NOT NULL,
    amount DECIMAL(18,6) NOT NULL, receipt_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin, reverses ${id}, created_at BIGINT NOT NULL, payload JSON NOT NULL,
    PRIMARY KEY(book,id), UNIQUE KEY receipt_once(book,receipt_hash), UNIQUE KEY reverse_once(book,reverses), KEY wallet_entries(book,wallet_id,created_at)`),
  table('settlements', `${book}, request_id ${id} NOT NULL, amount DECIMAL(18,6) NOT NULL, payload JSON NOT NULL, PRIMARY KEY(book,request_id)`),
  table('commands', `${book}, id ${id} NOT NULL, payload JSON NOT NULL, PRIMARY KEY(book,id)`),
  table('outbox', `${book}, request_id ${id} NOT NULL, completed TINYINT NOT NULL, created_at BIGINT NOT NULL,
    next_attempt_at BIGINT NOT NULL DEFAULT 0, payload JSON NOT NULL,
    PRIMARY KEY(book,request_id), KEY undelivered(book,completed,next_attempt_at,created_at)`),
  table('settings', `${book}, id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, section VARCHAR(16) NOT NULL, payload JSON NOT NULL, PRIMARY KEY(book,id)`),
]
