const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

test('client bundle registers a lazy module factory without DOM work', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../client/client.js'), 'utf8')
  let captured
  const context = {
    window: { __ModuleLoader__: { load(entry) { captured = entry } } },
    console,
  }
  vm.runInNewContext(source, context, { filename: 'client.js' })

  assert.equal(captured.id, 'dsh-quickchat')
  assert.equal(typeof captured.factory, 'function')
})

