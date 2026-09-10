import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import {
  projectIdFor,
  resolveProjectContext,
  safeChatId,
} from '../../lib/project-domain.js'

function tempDir(prefix = 'dsh-quickchat-domain-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

test('project id is stable for the canonical project root', () => {
  const root = tempDir()
  const alias = join(root, 'alias')
  symlinkSync(root, alias, 'dir')

  const first = projectIdFor(root)
  const second = projectIdFor(alias)

  assert.match(first, /^[0-9a-f]{64}$/)
  assert.equal(second, first)
})

test('workspace inside a git project resolves to the repository root', () => {
  const root = tempDir()
  const nested = join(root, 'packages', 'web')
  mkdirSync(join(root, '.git'), { recursive: true })
  mkdirSync(nested, { recursive: true })
  const storeRoot = join(tempDir(), 'quickchat')

  const project = resolveProjectContext({ cwd: nested, storeRoot })

  const canonicalRoot = realpathSync(root)
  assert.equal(project.root, canonicalRoot)
  assert.equal(project.title, basename(canonicalRoot))
  assert.equal(project.id, projectIdFor(canonicalRoot))
  assert.equal(project.dir, join(storeRoot, 'projects', project.id))
  assert.equal(project.chatsDir, join(storeRoot, 'projects', project.id, 'chats'))
})

test('non-git directory is its own project boundary', () => {
  const root = tempDir()
  const storeRoot = join(tempDir(), 'quickchat')

  const project = resolveProjectContext({ cwd: root, storeRoot })

  const canonicalRoot = realpathSync(root)
  assert.equal(project.root, canonicalRoot)
  assert.equal(project.id, projectIdFor(canonicalRoot))
})

test('explicit workspace root keeps nested session cwd in the workspace domain', () => {
  const root = tempDir()
  const nested = join(root, 'packages', 'ui')
  mkdirSync(nested, { recursive: true })
  const storeRoot = join(tempDir(), 'quickchat')

  const project = resolveProjectContext({ cwd: nested, projectRoot: root, storeRoot })

  assert.equal(project.root, realpathSync(root))
  assert.equal(project.id, projectIdFor(root))
  assert.throws(() => resolveProjectContext({ cwd: root, projectRoot: tempDir(), storeRoot }), (error) => error.code === 'PROJECT_MISMATCH')
})

test('invalid project context is rejected before storage is selected', () => {
  const missing = join(tempDir(), 'missing')
  const storeRoot = join(tempDir(), 'quickchat')

  assert.throws(
    () => resolveProjectContext({ cwd: missing, storeRoot }),
    (error) => error.code === 'CWD_INVALID'
  )
})

test('chat ids cannot escape the project chat directory', () => {
  assert.equal(safeChatId('chat_01-abc'), 'chat_01-abc')
  assert.throws(() => safeChatId('../other-project/chat'), /invalid chat id/)
  assert.throws(() => safeChatId('chat/../../escape'), /invalid chat id/)
  assert.throws(() => safeChatId(''), /invalid chat id/)
})
