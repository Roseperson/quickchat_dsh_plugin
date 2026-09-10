import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createQuickChatService } from '../../lib/quickchat-service.js'
import { createProjectStore } from '../../lib/store.js'
import { resolveProjectContext } from '../../lib/project-domain.js'

function tempDir(prefix = 'dsh-quickchat-host-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

function fakeContext({ stream } = {}) {
  const calls = []
  const llm = {
    listProviders: () => [{ id: 'demo', name: 'Demo' }],
    listModels: async () => [{ id: 'demo-model' }],
    resolveModelInfo: async () => ({ context: { contextWindow: 4000 } }),
    stream: (options) => {
      calls.push(options)
      return stream ? stream(options) : (async function* () {
        if (options.purpose === 'session-title') return
        yield { type: 'text-delta', text: '回答' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  return { llm, calls }
}

test('main quick chat follows the DSH default model and keeps reasoning and plugin overrides out of the request', async () => {
  const root = tempDir()
  const storeRoot = join(tempDir(), 'quickchat')
  const ctx = fakeContext({
    stream: async function* (options) {
      if (options.purpose === 'session-title') return
      yield { type: 'reasoning-delta', text: '这段内容不应显示' }
      yield { type: 'text-delta', text: '回答' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  ctx.agentDefaultModel = {
    currentSelection: () => ({ provider: 'preferred', model: 'preferred-model' }),
  }
  const resolvedRoutes = []
  ctx.llm.resolveCallConfig = async (route) => {
    resolvedRoutes.push(route)
    return { ...route, maxTokens: 777 }
  }
  const service = createQuickChatService({ ctx, storeRoot })
  const conversation = service.create({ cwd: root }).conversation
  const events = []

  const result = await service.streamMessage({
    context: { cwd: root },
    id: conversation.id,
    text: '请回答',
    onEvent: (event) => events.push(event),
  })

  assert.equal(result.status, 'ok')
  assert.deepEqual(events.map((event) => event.type), ['meta', 'delta', 'done'])
  assert.equal(ctx.calls[0].provider, 'preferred')
  assert.equal(ctx.calls[0].model, 'preferred-model')
  assert.equal(ctx.calls[0].system, undefined)
  assert.equal(ctx.calls[0].maxTokens, undefined)
  assert.equal(ctx.calls[0].purpose, undefined)
  assert.deepEqual(resolvedRoutes[0], { provider: 'preferred', model: 'preferred-model' })
  assert.equal('reasoning' in service.messages({ cwd: root }, conversation.id).at(-1), false)
})

test('legacy persisted reasoning is omitted from the public message API', () => {
  const root = tempDir()
  const storeRoot = join(tempDir(), 'quickchat')
  const project = resolveProjectContext({ cwd: root, storeRoot })
  const rawStore = createProjectStore({ project, clock: () => 100 })
  const conversation = rawStore.create()
  rawStore.appendMessage(conversation.id, { role: 'assistant', text: '可见回答', reasoning: '不应暴露', ts: 100, status: 'ok' })

  const service = createQuickChatService({ ctx: fakeContext(), storeRoot })
  assert.deepEqual(service.messages({ cwd: root }, conversation.id), [{ role: 'assistant', text: '可见回答', ts: 100, status: 'ok' }])
})

test('streamMessage persists a project-local exchange and emits ordered events', async () => {
  const root = tempDir()
  const storeRoot = join(tempDir(), 'quickchat')
  const ctx = fakeContext()
  const service = createQuickChatService({ ctx, storeRoot, clock: () => 100 })
  const conversation = service.create({ cwd: root }, '临时问题').conversation
  const events = []

  const result = await service.streamMessage({
    context: { cwd: root },
    id: conversation.id,
    text: '请回答',
    onEvent: (event) => events.push(event),
  })

  assert.equal(result.status, 'ok')
  assert.deepEqual(events.map((event) => event.type), ['meta', 'delta', 'done'])
  assert.equal(events[1].text, '回答')
  assert.equal(service.messages({ cwd: root }, conversation.id).length, 2)
  assert.equal(service.get({ cwd: root }, conversation.id).title, '临时问题')
  assert.equal(ctx.calls[0].provider, 'demo')
  assert.equal(ctx.calls[0].model, 'demo-model')
  assert.equal(ctx.calls[0].tools, undefined)
  assert.equal(ctx.calls[0].messages[0].role, 'user')
})

test('provider finish failures preserve the normalized provider error', async () => {
  const root = tempDir()
  const storeRoot = join(tempDir(), 'quickchat')
  const ctx = fakeContext({
    stream: async function* () {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'INVALID_CREDENTIAL', message: 'credential rejected' } } }
    },
  })
  const service = createQuickChatService({ ctx, storeRoot, clock: () => 100 })
  const conversation = service.create({ cwd: root }).conversation
  const events = []

  const result = await service.streamMessage({
    context: { cwd: root },
    id: conversation.id,
    text: '会失败',
    onEvent: (event) => events.push(event),
  })

  assert.equal(result.status, 'error')
  assert.deepEqual(events.find((event) => event.type === 'error'), {
    type: 'error',
    code: 'INVALID_CREDENTIAL',
    message: 'credential rejected',
  })
  assert.equal(service.messages({ cwd: root }, conversation.id).at(-1).error, 'credential rejected')
})

test('first user message derives a title without moving chats into a global list', async () => {
  const storeRoot = join(tempDir(), 'quickchat')
  const rootA = tempDir()
  const rootB = tempDir()
  const ctx = fakeContext()
  const service = createQuickChatService({ ctx, storeRoot, clock: () => 100 })
  const conversationA = service.create({ cwd: rootA }).conversation
  const conversationB = service.create({ cwd: rootB }).conversation

  await service.streamMessage({ context: { cwd: rootA }, id: conversationA.id, text: '项目 A 的问题', onEvent: () => {} })

  assert.equal(service.list({ cwd: rootA }).conversations.length, 1)
  assert.equal(service.list({ cwd: rootB }).conversations.length, 1)
  assert.equal(service.list({ cwd: rootA }).conversations[0].title, '项目 A 的问题')
  assert.throws(() => service.get({ cwd: rootB }, conversationA.id), (error) => error.code === 'NOT_FOUND')
  assert.equal(service.get({ cwd: rootB }, conversationB.id).title, '')
})

test('first quick chat prompt receives a best-effort LLM title summary', async () => {
  const root = tempDir()
  const storeRoot = join(tempDir(), 'quickchat')
  const ctx = fakeContext({
    stream: async function* (options) {
      if (options.purpose === 'session-title') {
        yield { type: 'text-delta', text: '项目问题概览' }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      yield { type: 'text-delta', text: '回答' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  const service = createQuickChatService({ ctx, storeRoot, clock: () => 100 })
  const conversation = service.create({ cwd: root }).conversation
  const events = []

  await service.streamMessage({ context: { cwd: root }, id: conversation.id, text: '请总结这个项目的构建问题', onEvent: (event) => events.push(event) })

  assert.equal(service.get({ cwd: root }, conversation.id).title, '项目问题概览')
  assert.deepEqual(events.map((event) => event.type), ['meta', 'delta', 'done', 'title'])
  const titleCall = ctx.calls.find((call) => call.purpose === 'session-title')
  assert.equal(Boolean(titleCall), true)
  assert.equal(titleCall.maxTokens, 64)
  assert.match(titleCall.system, /concise title/i)
  assert.match(titleCall.messages[0].content[0].text, /请总结这个项目的构建问题/)
})

test('title generation is detached from main completion and uses an independent native-style request', async () => {
  const root = tempDir()
  const storeRoot = join(tempDir(), 'quickchat')
  let releaseTitle
  let markTitleStarted
  const titleStarted = new Promise((resolve) => { markTitleStarted = resolve })
  const titleGate = new Promise((resolve) => { releaseTitle = resolve })
  const ctx = fakeContext({
    stream: (options) => {
      if (options.purpose === 'session-title') {
        return (async function* () {
          markTitleStarted()
          await titleGate
          yield { type: 'text-delta', text: '异步标题' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      }
      return (async function* () {
        yield { type: 'text-delta', text: '回答' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  })
  const service = createQuickChatService({ ctx, storeRoot })
  const conversation = service.create({ cwd: root }).conversation
  const events = []
  const pending = service.streamMessage({
    context: { cwd: root },
    id: conversation.id,
    text: '请为这段 Quick Chat 生成标题',
    onEvent: (event) => events.push(event),
  })

  await titleStarted
  assert.deepEqual(events.map((event) => event.type), ['meta', 'delta', 'done'])
  const mainCall = ctx.calls.find((call) => !call.purpose)
  const titleCall = ctx.calls.find((call) => call.purpose === 'session-title')
  assert.notEqual(titleCall.signal, mainCall.signal)
  assert.equal(titleCall.maxTokens, 64)
  assert.match(titleCall.messages[0].content[0].text, /JSON array of human messages/i)
  assert.match(titleCall.messages[0].content[0].text, /请为这段 Quick Chat 生成标题/)

  releaseTitle()
  await pending
  assert.deepEqual(events.map((event) => event.type), ['meta', 'delta', 'done', 'title'])
  assert.equal(service.get({ cwd: root }, conversation.id).title, '异步标题')
})

test('explicit rename pins the fallback and cancels an in-flight automatic title', async () => {
  const root = tempDir()
  const storeRoot = join(tempDir(), 'quickchat')
  let releaseTitle
  let markTitleStarted
  const titleStarted = new Promise((resolve) => { markTitleStarted = resolve })
  const titleGate = new Promise((resolve) => { releaseTitle = resolve })
  const ctx = fakeContext({
    stream: (options) => options.purpose === 'session-title'
      ? (async function* () {
        markTitleStarted()
        await titleGate
        yield { type: 'text-delta', text: '不应覆盖手动标题' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
      : (async function* () {
        yield { type: 'text-delta', text: '回答' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })(),
  })
  const service = createQuickChatService({ ctx, storeRoot })
  const conversation = service.create({ cwd: root }).conversation
  const events = []
  const pending = service.streamMessage({ context: { cwd: root }, id: conversation.id, text: '首条问题', onEvent: (event) => events.push(event) })

  await titleStarted
  service.rename({ cwd: root }, conversation.id, '手动标题')
  releaseTitle()
  await pending

  assert.equal(service.get({ cwd: root }, conversation.id).title, '手动标题')
  assert.equal(events.some((event) => event.type === 'title'), false)
})

test('cancel only aborts the active generation in the current project', async () => {
  const root = tempDir()
  const storeRoot = join(tempDir(), 'quickchat')
  let release
  const waiting = new Promise((resolve) => { release = resolve })
  const ctx = fakeContext({
    stream: async function* (options) {
      yield { type: 'text-delta', text: '部分' }
      await Promise.race([waiting, new Promise((resolve) => options.signal.addEventListener('abort', resolve, { once: true }))])
      yield { type: 'finish', reason: { kind: 'aborted' } }
    },
  })
  const service = createQuickChatService({ ctx, storeRoot, clock: () => 100 })
  const conversation = service.create({ cwd: root }).conversation
  const events = []
  const pending = service.streamMessage({ context: { cwd: root }, id: conversation.id, text: '取消我', onEvent: (event) => events.push(event) })

  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(service.cancel({ cwd: root }, conversation.id), { ok: true, active: true })
  release()
  const result = await pending

  assert.equal(result.status, 'aborted')
  assert.equal(events.at(-1).type, 'done')
  assert.equal(events.at(-1).aborted, true)
})
