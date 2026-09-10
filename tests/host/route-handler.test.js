import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createQuickChatService } from '../../lib/quickchat-service.js'
import { createRouteHandler } from '../../lib/route-handler.js'

function tempDir(prefix = 'dsh-quickchat-route-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

class FakeRequest extends EventEmitter {
  constructor({ method = 'GET', url = '/', headers = {}, body = '' } = {}) {
    super()
    this.method = method
    this.url = url
    this.headers = headers
    this.body = Buffer.from(body)
  }

  async *[Symbol.asyncIterator]() {
    if (this.body.length > 0) yield this.body
  }
}

class FakeResponse {
  constructor() {
    this.headersSent = false
    this.statusCode = 0
    this.headers = {}
    this.chunks = []
    this.flushCount = 0
    this.ended = false
  }

  writeHead(status, headers) {
    this.statusCode = status
    this.headers = headers
    this.headersSent = true
  }

  write(chunk) {
    this.chunks.push(String(chunk))
  }

  flush() {
    this.flushCount += 1
  }

  end(chunk = '') {
    if (chunk) this.chunks.push(String(chunk))
    this.ended = true
  }

  json() {
    return JSON.parse(this.chunks.join(''))
  }
}

function serviceFor(storeRoot) {
  const ctx = {
    llm: {
      listProviders: () => [{ id: 'demo' }],
      listModels: async () => [{ id: 'demo-model' }],
      stream: () => (async function* () {
        yield { type: 'text-delta', text: 'ok' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })(),
    },
  }
  return createQuickChatService({ ctx, storeRoot, clock: () => 100 })
}

test('current-project list and create routes never expose a global collection', async () => {
  const storeRoot = join(tempDir(), 'quickchat')
  const rootA = tempDir()
  const rootB = tempDir()
  const service = serviceFor(storeRoot)
  const handler = createRouteHandler(service)
  const created = new FakeResponse()

  await handler(new FakeRequest({
    method: 'POST',
    url: '/quickchat/api/conversations',
    headers: { origin: 'http://localhost', host: 'localhost', 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: rootA, title: 'A' }),
  }), created)
  assert.equal(created.statusCode, 200)

  const listA = new FakeResponse()
  await handler(new FakeRequest({ method: 'GET', url: `/quickchat/api/conversations?cwd=${encodeURIComponent(rootA)}`, headers: { host: 'localhost' } }), listA)
  const listB = new FakeResponse()
  await handler(new FakeRequest({ method: 'GET', url: `/quickchat/api/conversations?cwd=${encodeURIComponent(rootB)}`, headers: { host: 'localhost' } }), listB)

  assert.equal(listA.json().conversations.length, 1)
  assert.equal(listB.json().conversations.length, 0)
})

test('cross-origin route requests are rejected before reading or writing storage', async () => {
  const service = serviceFor(join(tempDir(), 'quickchat'))
  const handler = createRouteHandler(service)
  const response = new FakeResponse()

  await handler(new FakeRequest({
    method: 'POST',
    url: '/quickchat/api/conversations',
    headers: { origin: 'https://evil.example', host: 'localhost', 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: tempDir(), title: '不应写入' }),
  }), response)

  assert.equal(response.statusCode, 403)
  assert.equal(response.json().code, 'CROSS_ORIGIN')
})

test('stream responses opt out of proxy transforms so small deltas stay flushable', async () => {
  const root = tempDir()
  const service = serviceFor(join(tempDir(), 'quickchat'))
  const handler = createRouteHandler(service)
  const conversation = service.create({ cwd: root }).conversation
  const response = new FakeResponse()

  await handler(new FakeRequest({
    method: 'POST',
    url: `/quickchat/api/conversations/${conversation.id}/messages`,
    headers: { host: 'localhost', 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: root, text: '流式回答' }),
  }), response)

  assert.equal(response.headers['cache-control'], 'no-store, no-transform')
  assert.equal(response.flushCount, 4)
  assert.deepEqual(response.chunks.map((chunk) => JSON.parse(chunk).type), ['meta', 'delta', 'done', 'title'])
})
