import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveProjectContext } from '../../lib/project-domain.js'
import { createProjectStore } from '../../lib/store.js'

function tempDir(prefix = 'dsh-quickchat-store-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

function projectFor(root, storeRoot) {
  return resolveProjectContext({ cwd: root, storeRoot })
}

test('fresh project store returns an empty list and creates project layout lazily', () => {
  const root = tempDir()
  const storeRoot = join(tempDir(), 'quickchat')
  const project = projectFor(root, storeRoot)
  const store = createProjectStore({ project, idFactory: () => 'chat_001', clock: () => 100 })

  assert.deepEqual(store.list(), [])
  assert.equal(existsSync(project.dir), true)
  assert.equal(existsSync(project.chatsDir), true)
})

test('create and list keep project-local metadata in newest-first order', () => {
  const root = tempDir()
  const storeRoot = join(tempDir(), 'quickchat')
  const project = projectFor(root, storeRoot)
  let now = 100
  let nextId = 0
  const store = createProjectStore({ project, clock: () => now, idFactory: () => `chat_${++nextId}` })

  const first = store.create()
  now = 200
  const second = store.create('  设计浮层  ')

  assert.equal(first.title, '')
  assert.equal(second.title, '设计浮层')
  assert.deepEqual(store.list().map((item) => item.id), [second.id, first.id])
  assert.equal(store.get(second.id).title, '设计浮层')
})

test('messages survive a new store instance and update message count', () => {
  const root = tempDir()
  const storeRoot = join(tempDir(), 'quickchat')
  const project = projectFor(root, storeRoot)
  const first = createProjectStore({ project, idFactory: () => 'chat_001', clock: () => 100 }).create()
  const store = createProjectStore({ project, clock: () => 200 })

  store.appendMessage(first.id, { role: 'user', text: '你好', ts: 200, status: 'ok' })
  store.appendMessage(first.id, { role: 'assistant', text: '你好！', ts: 201, status: 'ok', model: 'demo' })

  const recovered = createProjectStore({ project, clock: () => 300 })
  assert.deepEqual(recovered.messages(first.id), [
    { role: 'user', text: '你好', ts: 200, status: 'ok' },
    { role: 'assistant', text: '你好！', ts: 201, status: 'ok', model: 'demo' },
  ])
  assert.equal(recovered.get(first.id).messageCount, 2)
})

test('malformed trailing JSONL does not hide valid project messages', () => {
  const root = tempDir()
  const storeRoot = join(tempDir(), 'quickchat')
  const project = projectFor(root, storeRoot)
  const store = createProjectStore({ project, idFactory: () => 'chat_001', clock: () => 100 })
  const conversation = store.create()
  store.appendMessage(conversation.id, { role: 'user', text: 'valid', ts: 100, status: 'ok' })

  appendFileSync(join(project.chatsDir, `${conversation.id}.jsonl`), '{"role":"assistant"')

  assert.deepEqual(store.messages(conversation.id), [
    { role: 'user', text: 'valid', ts: 100, status: 'ok' },
  ])
})

test('rename and remove update the index and remove the exact chat file', () => {
  const root = tempDir()
  const storeRoot = join(tempDir(), 'quickchat')
  const project = projectFor(root, storeRoot)
  const store = createProjectStore({ project, idFactory: () => 'chat_001', clock: () => 100 })
  const conversation = store.create()
  store.rename(conversation.id, '新的标题')

  assert.equal(store.get(conversation.id).title, '新的标题')
  store.appendMessage(conversation.id, { role: 'user', text: '保留前缀', ts: 101, status: 'ok' })
  store.remove(conversation.id)

  assert.deepEqual(store.list(), [])
  assert.throws(() => store.get(conversation.id), (error) => error.code === 'NOT_FOUND')
  assert.equal(existsSync(join(project.chatsDir, `${conversation.id}.jsonl`)), false)
  assert.deepEqual(readdirSync(project.chatsDir), [])
})

test('a chat id from another project is not readable or removable', () => {
  const storeRoot = join(tempDir(), 'quickchat')
  const projectA = projectFor(tempDir(), storeRoot)
  const projectB = projectFor(tempDir(), storeRoot)
  const storeA = createProjectStore({ project: projectA, idFactory: () => 'same-id', clock: () => 100 })
  const storeB = createProjectStore({ project: projectB, clock: () => 200 })
  const conversation = storeA.create('A only')
  storeA.appendMessage(conversation.id, { role: 'user', text: 'A', ts: 100, status: 'ok' })

  assert.throws(() => storeB.get(conversation.id), (error) => error.code === 'NOT_FOUND')
  assert.throws(() => storeB.messages(conversation.id), (error) => error.code === 'NOT_FOUND')
  assert.throws(() => storeB.remove(conversation.id), (error) => error.code === 'NOT_FOUND')
  assert.equal(storeA.get(conversation.id).title, 'A only')
})

