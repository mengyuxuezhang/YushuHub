import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import net from 'node:net'

function localStream(command) {
  const stream = new EventEmitter()
  stream.stderr = new EventEmitter()
  const child = spawn('/bin/bash', ['-lc', command], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', (data) => stream.emit('data', data))
  child.stderr.on('data', (data) => stream.stderr.emit('data', data))
  child.once('error', (error) => {
    stream.stderr.emit('data', Buffer.from(`${error.message}\n`))
  })
  child.once('close', (code) => stream.emit('close', code ?? 1))
  return stream
}

function localSftp() {
  return {
    readFile(file, callback) {
      fs.readFile(file, callback)
    },
    writeFile(file, content, options, callback) {
      fs.writeFile(file, content, options, callback)
    },
    fastPut(source, destination, callback) {
      fs.copyFile(source, destination, callback)
    }
  }
}

export function createLocalConnection() {
  if (process.platform !== 'linux') throw new Error('服务器本地模式只能在 Linux 环境运行')
  return {
    exec(command, callback) {
      callback(null, localStream(command))
    },
    sftp(callback) {
      callback(null, localSftp())
    },
    forwardOut(_sourceHost, _sourcePort, destinationHost, destinationPort, callback) {
      const socket = net.createConnection({ host: destinationHost, port: destinationPort })
      const fail = (error) => callback(error)
      socket.once('error', fail)
      socket.once('connect', () => {
        socket.off('error', fail)
        callback(null, socket)
      })
    },
    end() {}
  }
}
