import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, inject, name, QUICKCHAT_SETTINGS_NAMESPACE } from '../../lib/index.js'

test('plugin entry registers the project-scoped HTTP prefix with DSH services', () => {
  const storeRoot = join(mkdtempSync(join(tmpdir(), 'dsh-quickchat-entry-')), 'quickchat')
  let route
  let disposed = false
  const ctx = {
    llm: {
      stream: () => (async function* () {})(),
    },
    webServer: {
      register(candidate) {
        route = candidate
        return () => { disposed = true }
      },
    },
    effect(callback) {
      return callback()
    },
  }

  apply(ctx, { storeRoot })

  assert.equal(name, 'quickchat')
  assert.deepEqual(inject, ['webServer', 'llm', 'agentDefaultModel'])
  assert.equal(route.kind, 'prefix')
  assert.equal(route.path, '/quickchat/api')
  assert.equal(typeof route.handler, 'function')
  assert.equal(disposed, false)
})

test('plugin entry exposes a live model route settings namespace when settings exists', () => {
  const storeRoot = join(mkdtempSync(join(tmpdir(), 'dsh-quickchat-settings-')), 'quickchat')
  const registrations = []
  const ctx = {
    llm: {
      stream: () => (async function* () {})(),
    },
    webServer: {
      register() {},
    },
    effect(callback) {
      return callback()
    },
    inject(names, callback) {
      assert.deepEqual(names, ['settings'])
      callback({
        settings: {
          installSection(owner, namespace, schema, entry, hooks) {
            registrations.push({ owner, namespace, schema, entry, hooks })
            hooks.setSource({ provider: 'configured-provider', model: 'configured-model' })
          },
        },
      })
    },
  }

  apply(ctx, { storeRoot })

  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].namespace, QUICKCHAT_SETTINGS_NAMESPACE)
  assert.equal(typeof registrations[0].schema, 'function')
  assert.equal(registrations[0].entry.provider, '')
  assert.equal('maxTokens' in registrations[0].entry, false)
  assert.equal('sidebarByDefault' in registrations[0].entry, false)
  assert.equal(registrations[0].hooks.onChange instanceof Function, true)
})
