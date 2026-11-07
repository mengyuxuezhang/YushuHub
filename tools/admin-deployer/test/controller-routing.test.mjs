import test from 'node:test'
import assert from 'node:assert/strict'
import { controllerCommand, deploymentProbeScript } from '../src/controller-routing.mjs'

test('controller actions cannot become shell arguments or invoke PM2 and ZIP installers', () => {
  for (const action of ['info', 'status', 'upgrade', 'recover', 'rollback']) {
    const command = controllerCommand('fictional-instance', action)
    assert.match(command, /^\/usr\/local\/sbin\/yushuhub-upgrade /)
    assert.equal(command.includes('--apply'), ['upgrade', 'recover', 'rollback'].includes(action))
    assert.doesNotMatch(command, /npm|pm2|unzip|\.zip/)
  }
  assert.throws(() => controllerCommand('instance;touch-anything', 'upgrade'))
  assert.throws(() => controllerCommand('instance', 'arbitrary-command'))
  assert.throws(() => deploymentProbeScript('relative/app'))
})
