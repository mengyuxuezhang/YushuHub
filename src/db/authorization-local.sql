-- Apply explicitly after backup. Never auto-run against a customer database.
CREATE TABLE IF NOT EXISTS ai_authorization_invitations (
  token_hash CHAR(64) PRIMARY KEY,
  user_id VARCHAR(120) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  used_at DATETIME(3) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX (user_id)
) ENGINE=InnoDB;
