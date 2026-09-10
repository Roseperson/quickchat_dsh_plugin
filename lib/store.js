import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { safeChatId } from './project-domain.js'

const INDEX_VERSION = 1
const MAX_TITLE = 120

function storeError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function normalizeTitle(title) {
  if (title === undefined) return ''
  if (typeof title !== 'string') throw storeError('TITLE_INVALID', 'title must be a string')
  return title.trim().slice(0, MAX_TITLE)
}

function normalizeIndex(index) {
  if (!index || typeof index !== 'object') return { version: INDEX_VERSION, conversations: [] }
  const conversations = Array.isArray(index.conversations) ? index.conversations : []
  return {
    version: INDEX_VERSION,
    project: index.project,
    conversations: conversations.filter((item) => item && typeof item.id === 'string').map((item) => ({
      id: item.id,
      title: typeof item.title === 'string' ? item.title : '',
      createdAt: Number.isFinite(item.createdAt) ? item.createdAt : 0,
      updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : item.createdAt ?? 0,
      messageCount: Number.isFinite(item.messageCount) ? item.messageCount : 0,
    })),
  }
}

export function createProjectStore({ project, clock = () => Date.now(), idFactory = randomUUID } = {}) {
  if (!project?.id || !project?.dir || !project?.chatsDir) {
    throw new TypeError('project context is required')
  }

  const indexFile = join(project.dir, 'index.json')
  const projectFile = join(project.dir, 'project.json')

  function ensureLayout() {
    mkdirSync(project.chatsDir, { recursive: true })
    if (!existsSync(projectFile)) {
      writeFileSync(projectFile, JSON.stringify({ id: project.id, root: project.root, title: project.title }, null, 2) + '\n')
    }
    if (!existsSync(indexFile)) writeIndex({ version: INDEX_VERSION, project: project.id, conversations: [] })
  }

  function readIndex() {
    ensureLayout()
    try {
      return normalizeIndex(JSON.parse(readFileSync(indexFile, 'utf8')))
    } catch {
      return { version: INDEX_VERSION, project: project.id, conversations: [] }
    }
  }

  function writeIndex(index) {
    mkdirSync(project.dir, { recursive: true })
    const tmp = `${indexFile}.${process.pid}.${randomUUID()}.tmp`
    writeFileSync(tmp, JSON.stringify({ ...index, version: INDEX_VERSION }, null, 2) + '\n')
    renameSync(tmp, indexFile)
  }

  function fileFor(id) {
    return join(project.chatsDir, `${safeChatId(id)}.jsonl`)
  }

  function find(index, id) {
    safeChatId(id)
    const found = index.conversations.find((item) => item.id === id)
    if (!found) throw storeError('NOT_FOUND', 'conversation not found')
    return found
  }

  function readMessagesWithTail(file) {
    if (!existsSync(file)) return { messages: [], hasInvalidTail: false }
    const messages = []
    const lines = readFileSync(file, 'utf8').split('\n')
    let hasInvalidTail = false
    for (const line of lines) {
      if (line.trim() === '') continue
      try {
        const item = JSON.parse(line)
        if (item && typeof item === 'object') messages.push(item)
        else hasInvalidTail = true
      } catch {
        hasInvalidTail = true
        break
      }
    }
    return { messages, hasInvalidTail }
  }

  function rewriteMessages(file, messages) {
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
    const body = messages.length === 0 ? '' : messages.map((item) => JSON.stringify(item)).join('\n') + '\n'
    writeFileSync(tmp, body)
    renameSync(tmp, file)
  }

  function updateMetadata(index, id, updater) {
    const item = find(index, id)
    updater(item)
    writeIndex(index)
    return clone(item)
  }

  ensureLayout()

  return {
    list() {
      const index = readIndex()
      return clone(index.conversations.slice().sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt))
    },

    create(title = '') {
      const index = readIndex()
      const id = safeChatId(String(idFactory()))
      if (index.conversations.some((item) => item.id === id)) throw storeError('DUPLICATE_ID', 'conversation already exists')
      const now = clock()
      const conversation = { id, title: normalizeTitle(title), createdAt: now, updatedAt: now, messageCount: 0 }
      index.conversations.unshift(conversation)
      writeIndex(index)
      rewriteMessages(fileFor(id), [])
      return clone(conversation)
    },

    get(id) {
      return clone(find(readIndex(), id))
    },

    messages(id) {
      const index = readIndex()
      find(index, id)
      return clone(readMessagesWithTail(fileFor(id)).messages)
    },

    appendMessage(id, message) {
      if (!message || (message.role !== 'user' && message.role !== 'assistant')) {
        throw storeError('MESSAGE_INVALID', 'message role must be user or assistant')
      }
      if (typeof message.text !== 'string') throw storeError('MESSAGE_INVALID', 'message text must be a string')
      const index = readIndex()
      const item = find(index, id)
      const file = fileFor(id)
      const recovered = readMessagesWithTail(file)
      if (recovered.hasInvalidTail) rewriteMessages(file, recovered.messages)
      const record = { ...message, ts: Number.isFinite(message.ts) ? message.ts : clock() }
      appendFileSync(file, JSON.stringify(record) + '\n')
      item.messageCount = recovered.messages.length + 1
      item.updatedAt = clock()
      writeIndex(index)
      return clone(record)
    },

    rename(id, title) {
      const normalized = normalizeTitle(title)
      if (normalized === '') throw storeError('TITLE_REQUIRED', 'title required')
      const index = readIndex()
      return updateMetadata(index, id, (item) => {
        item.title = normalized
        item.updatedAt = clock()
      })
    },

    remove(id) {
      const index = readIndex()
      find(index, id)
      try {
        rmSync(fileFor(id), { force: true })
      } catch (error) {
        throw storeError('DELETE_FAILED', `conversation file could not be removed: ${error.message}`)
      }
      index.conversations = index.conversations.filter((item) => item.id !== id)
      writeIndex(index)
      return { ok: true }
    },
  }
}

