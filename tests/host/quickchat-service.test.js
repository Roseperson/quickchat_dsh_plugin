import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createQuickChatService, TITLE_TIMEOUT_MS } from '../../lib/quickchat-service.js'
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

test('setRouteSettings 延迟到请求时读取，更新、清空或暂时失效均无需重启', async () => {
  const root = tempDir()
  const ctx = fakeContext()
  const hostRoute = { provider: 'host', model: 'host-model', reasoningEffort: 'max' }
  ctx.agentDefaultModel = { currentSelection: () => hostRoute }
  const service = createQuickChatService({ ctx, storeRoot: join(tempDir(), 'quickchat') })
  const conversation = service.create({ cwd: root }, '固定标题').conversation
  let current = {}
  let reads = 0
  service.setRouteSettings(() => {
    reads += 1
    if (current instanceof Error) throw current
    return current
  })
  assert.equal(reads, 0)

  const cases = [
    [{}, hostRoute],
    [{ provider: ' chosen ', model: ' model-a ' }, { provider: 'chosen', model: 'model-a' }],
    [{ provider: 'second', model: 'model-b' }, { provider: 'second', model: 'model-b' }],
    [{ provider: 'second', model: '' }, hostRoute],
    [new Error('配置源暂时不可用'), hostRoute],
    [{ provider: 'recovered', model: 'model-c' }, { provider: 'recovered', model: 'model-c' }],
    [{ provider: '', model: '' }, hostRoute],
  ]
  for (const [settings, expected] of cases) {
    current = settings
    const events = []
    const result = await service.streamMessage({
      context: { cwd: root }, id: conversation.id, text: '请求时读取', onEvent: (event) => events.push(event),
    })
    assert.equal(result.status, 'ok')
    assert.deepEqual(result.route, expected)
    assert.deepEqual(events[0].route, expected)
    const call = ctx.calls.at(-1)
    assert.equal(call.provider, expected.provider)
    assert.equal(call.model, expected.model)
    assert.equal(call.reasoningEffort, expected.reasoningEffort)
  }
  assert.equal(reads, cases.length)
  assert.equal(ctx.calls.length, cases.length)
  // 主回答历史的 source 符合 0.2.1-rc.2 的 user / ModelMessageSource 契约。
  assert.deepEqual(ctx.calls[0].messages[0].source, { kind: 'user' })
  assert.deepEqual(ctx.calls[1].messages.map((message) => message.source), [
    { kind: 'user' },
    { kind: 'model', provider: 'chosen', model: 'host-model' },
    { kind: 'user' },
  ])
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
        yield { type: 'block-start', index: 0, blockType: 'reasoning' }
        yield { type: 'reasoning-delta', index: 0, text: '推理不进入标题' }
        yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: '推理不进入标题' } }
        yield { type: 'block-start', index: 1, blockType: 'text' }
        yield { type: 'text-delta', text: '项目问题概览' }
        yield { type: 'block-end', index: 1, block: { type: 'text', text: '项目问题概览' } }
        yield { type: 'usage', usage: { inputTokens: 30, outputTokens: 140, reasoningTokens: 128 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      yield { type: 'text-delta', text: '回答' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  ctx.agentDefaultModel = {
    currentSelection: () => ({ provider: 'reasoning-provider', model: 'reasoning-model', reasoningEffort: 'max' }),
  }
  const service = createQuickChatService({ ctx, storeRoot, clock: () => 100 })
  const conversation = service.create({ cwd: root }).conversation
  const events = []

  await service.streamMessage({ context: { cwd: root }, id: conversation.id, text: '请总结这个项目的构建问题', onEvent: (event) => events.push(event) })

  assert.equal(service.get({ cwd: root }, conversation.id).title, '项目问题概览')
  assert.deepEqual(events.map((event) => event.type), ['meta', 'delta', 'done', 'title'])
  const titleCall = ctx.calls.find((call) => call.purpose === 'session-title')
  assert.equal(Boolean(titleCall), true)
  assert.equal(titleCall.maxTokens, 4096)
  assert.equal(titleCall.reasoningEffort, 'max')
  assert.equal(ctx.calls[0].maxTokens, undefined)
  assert.deepEqual(titleCall.messages[0].source, { kind: 'user' })
  assert.match(titleCall.system, /concise title/i)
  assert.match(titleCall.messages[0].content[0].text, /请总结这个项目的构建问题/)
})

test('标题遇到工具调用、不完整流或失败时保留回退标题且不影响主回答', async (t) => {
  const stop = { type: 'finish', reason: { kind: 'stop' } }
  const cases = [
    ['工具调用增量', [{ type: 'tool-call-delta', index: 1, id: 'call', name: 'tool', argumentsDelta: '{}' }, stop]],
    ['工具调用块开始', [{ type: 'block-start', index: 1, blockType: 'tool-call' }, stop]],
    ['工具调用块结束', [{ type: 'block-end', index: 1, block: { type: 'tool-call', id: 'call', name: 'tool', arguments: '{}' } }, stop]],
    ['工具调用终止', [{ type: 'finish', reason: { kind: 'tool-calls' } }]],
    ['输出预算耗尽', [{ type: 'finish', reason: { kind: 'max-tokens' } }]],
    ['提供方错误', [{ type: 'finish', reason: { kind: 'error', failure: { code: 'TITLE_ERROR', message: '标题失败' } } }]],
    ['提供方取消', [{ type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: '已取消' } } }]],
    ['缺少 finish', []],
    ['流迭代异常', [new Error('标题服务暂时不可用')]],
  ]
  for (const [label, chunks] of cases) {
    await t.test(label, async () => {
      const root = tempDir()
      const ctx = fakeContext({
        stream: async function* (options) {
          if (options.purpose === 'session-title') {
            yield { type: 'text-delta', index: 0, text: '不应采用的标题' }
            for (const chunk of chunks) {
              if (chunk instanceof Error) throw chunk
              yield chunk
            }
            return
          }
          yield { type: 'text-delta', text: '主回答' }
          yield stop
        },
      })
      const service = createQuickChatService({ ctx, storeRoot: join(tempDir(), 'quickchat') })
      const conversation = service.create({ cwd: root }).conversation
      const events = []
      const result = await service.streamMessage({
        context: { cwd: root }, id: conversation.id, text: '本地回退', onEvent: (event) => events.push(event),
      })
      assert.equal(result.status, 'ok')
      assert.equal(result.message.text, '主回答')
      assert.deepEqual(events.map((event) => event.type), ['meta', 'delta', 'done'])
      assert.equal(service.get({ cwd: root }, conversation.id).title, '本地回退')
    })
  }
})

test('标题达到 60 秒期限后放弃迟到结果，主回答提前完成且不被取消', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const root = tempDir()
  let markTitleStarted
  const titleStarted = new Promise((resolve) => { markTitleStarted = resolve })
  const ctx = fakeContext({
    stream: async function* (options) {
      if (options.purpose === 'session-title') {
        const aborted = new Promise((resolve) => options.signal.addEventListener('abort', resolve, { once: true }))
        markTitleStarted()
        await aborted
        yield { type: 'text-delta', text: '迟到的标题' }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      yield { type: 'text-delta', text: '主回答' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  const service = createQuickChatService({ ctx, storeRoot: join(tempDir(), 'quickchat') })
  const conversation = service.create({ cwd: root }).conversation
  const events = []
  const pending = service.streamMessage({
    context: { cwd: root }, id: conversation.id, text: '超时回退', onEvent: (event) => events.push(event),
  })
  await titleStarted
  const beforeTimeout = events.map((event) => event.type)
  assert.equal(TITLE_TIMEOUT_MS, 60000)
  t.mock.timers.tick(TITLE_TIMEOUT_MS)
  const result = await pending
  assert.deepEqual(beforeTimeout, ['meta', 'delta', 'done'])
  assert.equal(result.status, 'ok')
  assert.equal(ctx.calls[0].signal.aborted, false)
  assert.equal(ctx.calls[1].signal.aborted, true)
  assert.equal(service.get({ cwd: root }, conversation.id).title, '超时回退')
  assert.deepEqual(events.map((event) => event.type), ['meta', 'delta', 'done'])
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
  assert.equal(titleCall.maxTokens, 4096)
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
