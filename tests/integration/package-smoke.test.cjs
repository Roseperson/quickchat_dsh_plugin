const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.join(__dirname, '../..')
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

test('package manifest exposes the DSH host and WebUI client faces', () => {
  assert.equal(manifest.name, 'dsh-quickchat')
  assert.equal(manifest.exports['./client'], './client/client.js')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.dsh.client.immediately, true)
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-chat'))
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-layout'))
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-api-session-controller'))
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-api-workspace-controller'))
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings'))
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-api-remotes'))
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
})

test('bundle patch activates the package row named quickchat', () => {
  const patch = fs.readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /id:\s*quickchat/)
  assert.match(patch, /name:\s*['"]dsh-quickchat['"]$/m)
})
