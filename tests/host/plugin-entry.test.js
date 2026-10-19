import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, Config, inject, name } from '../../lib/index.js'

function tempDir(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-quickchat-entry-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

async function post(handler, path, body) {
  const chunks = []
  const response = {
    headersSent: false,
    writeHead(status) {
      this.statusCode = status
      this.headersSent = true
    },
    write(chunk) { chunks.push(chunk) },
    end(chunk) { if (chunk) chunks.push(chunk) },
  }
  await handler({
    method: 'POST',
    url: `/quickchat/api/${path}`,
    headers: { host: 'localhost' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) },
  }, response)
  assert.equal(response.statusCode, 200)
  return chunks.join('').trim().split('\n').map((line) => JSON.parse(line))
}

test('Config 仅将 provider/model 声明为 volatile，并保留普通 storeRoot', () => {
  for (const key of ['provider', 'model']) {
    assert.equal(Config.dict[key].meta.volatile, true)
    assert.equal(Config.dict[key].meta.default, '')
  }
  assert.notEqual(Config.dict.storeRoot.meta.volatile, true)
  const defaults = Config()
  assert.equal(defaults.provider.get(), '')
  assert.equal(defaults.model.get(), '')
  assert.equal(defaults.storeRoot, undefined)
  const configured = Config({ provider: 'demo', model: 'model', storeRoot: '/tmp/quickchat' })
  assert.equal(configured.provider.get(), 'demo')
  assert.equal(configured.model.get(), 'model')
  assert.equal(configured.storeRoot, '/tmp/quickchat')
  assert.throws(() => Config({ provider: 42 }))
})

test('plugin entry registers the project-scoped HTTP prefix with DSH services', (t) => {
  const storeRoot = join(tempDir(t), 'quickchat')
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

  apply(ctx, Config({ storeRoot }))

  assert.equal(name, 'quickchat')
  assert.deepEqual(inject, ['webServer', 'llm', 'agentDefaultModel'])
  assert.equal(route.kind, 'prefix')
  assert.equal(route.path, '/quickchat/api')
  assert.equal(typeof route.handler, 'function')
  assert.equal(disposed, false)
})

test('可选 settings 晚绑定父 fiber 的策略，路由每次请求读取当前 Config', async (t) => {
  const root = tempDir(t)
  const storeRoot = join(root, 'quickchat')
  const registrations = []
  const calls = []
  const disposers = []
  const routeRegistrations = []
  let settingsChild
  let current = { provider: '', model: '' }
  let reads = 0
  const ctx = {
    fiber: { id: 'quickchat-owner' },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'host', model: 'host-model', reasoningEffort: 'max' }),
    },
    llm: {
      stream: (options) => {
        calls.push(options)
        return (async function* () {
          yield { type: 'text-delta', text: '回答' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
    webServer: {
      register(route) { routeRegistrations.push(route) },
    },
    effect(callback) {
      return callback()
    },
    inject(names, callback) {
      assert.deepEqual(names, ['settings'])
      settingsChild = callback
    },
  }

  // 用可变读取器模拟 Loader 对同一 Config 引用的原地更新。
  apply(ctx, {
    storeRoot,
    provider: { get() { reads += 1; return current.provider } },
    model: { get() { reads += 1; return current.model } },
  })

  assert.equal(reads, 0)
  assert.equal(registrations.length, 0)
  assert.deepEqual(inject, ['webServer', 'llm', 'agentDefaultModel'])
  const { handler } = routeRegistrations[0]
  const [created] = await post(handler, 'conversations', { cwd: root, title: '路由测试' })
  const path = `conversations/${created.conversation.id}/messages`
  const send = () => post(handler, path, { cwd: root, text: '测试' })
  const hostRoute = { provider: 'host', model: 'host-model', reasoningEffort: 'max' }
  assert.deepEqual((await send())[0].route, hostRoute)

  let disposed = 0
  const child = {
    fiber: { id: 'settings-child' },
    effect(callback) { disposers.push(callback()) },
    settings: {
      get installSection() { assert.fail('不得访问已移除的 installSection') },
      configure(presentation, owner) {
        registrations.push({ presentation, owner })
        return () => { disposed += 1 }
      },
    },
  }
  settingsChild(child)
  assert.deepEqual(registrations, [{ presentation: { auto: false }, owner: ctx.fiber }])
  current = { provider: 'configured-provider', model: 'configured-model' }
  assert.deepEqual((await send())[0].route, current)
  assert.equal(calls[1].provider, current.provider)
  assert.equal(calls[1].model, current.model)

  current = { provider: 'changed-provider', model: 'changed-model' }
  assert.deepEqual((await send())[0].route, current)
  assert.equal(calls[2].provider, current.provider)
  assert.equal(calls[2].model, current.model)
  current = { provider: '', model: '' }
  assert.deepEqual((await send())[0].route, hostRoute)
  assert.equal(reads, 8)
  assert.equal(routeRegistrations.length, 1)

  disposers.pop()()
  assert.equal(disposed, 1)
  assert.deepEqual((await send())[0].route, hostRoute)
  // Settings 服务替换后，子 fiber 可重新登记同一父插件的展示策略。
  settingsChild(child)
  assert.equal(registrations.length, 2)
  disposers.pop()()
  assert.equal(disposed, 2)
})
