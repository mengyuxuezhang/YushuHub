#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${AI_ADMIN_APP_DIR:?AI_ADMIN_APP_DIR is required}"
PM2_NAME="${AI_ADMIN_PM2_NAME:?AI_ADMIN_PM2_NAME is required}"
PORT="${AI_ADMIN_PORT:?AI_ADMIN_PORT is required}"
LOG_FILE="${AI_ADMIN_SUPERVISOR_LOG:-$APP_DIR/data/supervisor.log}"
INTERVAL="${AI_ADMIN_SUPERVISOR_INTERVAL:-15}"
FAILURES=0

mkdir -p "$(dirname "$LOG_FILE")"
log() { printf '[%s] %s\n' "$(date -Is)" "$*" >> "$LOG_FILE"; }

while true; do
  healthy=1
  pm2 describe "$PM2_NAME" >/dev/null 2>&1 || healthy=0
  curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/me" >/dev/null 2>&1 || healthy=0
  if [ "$healthy" -eq 0 ]; then
    FAILURES=$((FAILURES + 1))
    log "health check failed ($FAILURES/3)"
  else
    FAILURES=0
  fi
  if [ "$FAILURES" -ge 3 ]; then
    log "health check failed; restarting $PM2_NAME"
    pm2 restart "$PM2_NAME" --update-env >> "$LOG_FILE" 2>&1 || pm2 start "$APP_DIR/cloud/ai-admin/server.mjs" --name "$PM2_NAME" --cwd "$APP_DIR" --interpreter node --update-env >> "$LOG_FILE" 2>&1 || log "restart failed"
    FAILURES=0
    sleep 30
  fi
  sleep "$INTERVAL"
done
