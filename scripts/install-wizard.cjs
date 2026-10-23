#!/usr/bin/env node
'use strict'

function majorVersion(version) {
  var match = String(version || '').match(/^v?(\d+)/)
  return match ? Number(match[1]) : 0
}

if (majorVersion(process.version) < 20) {
  console.error('')
  console.error('Agent AI 安装向导需要 Node.js 20 或更高版本。')
  console.error('当前命令行使用的是：' + process.version)
  console.error('')
  console.error('如果你使用宝塔或服务器面板，请注意：面板里的 Node 版本和 SSH 命令行里的 node 可能不是同一个。')
  console.error('请先在当前 SSH 终端执行 node -v、which node，确认 npm run install:wizard 使用的是 Node 20+。')
  console.error('')
  console.error('常见处理方式：')
  console.error('1. 在宝塔 Node.js 版本管理中切换当前站点/终端使用的 Node 20+。')
  console.error('2. 或使用 nvm 安装并切换：nvm install 20 && nvm use 20 && nvm alias default 20。')
  console.error('')
  process.exit(1)
}

import('./install-wizard.mjs').catch(function (err) {
  console.error(err && err.stack ? err.stack : err)
  process.exit(1)
})
