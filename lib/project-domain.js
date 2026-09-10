import { createHash } from 'node:crypto'
import { lstatSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

const DEFAULT_STORE_ROOT = join(process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh'), 'quickchat')
const CHAT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

function domainError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function validDirectory(path, code = 'CWD_INVALID') {
  let real
  try {
    real = realpathSync(path)
    if (!statSync(real).isDirectory()) throw new Error('not a directory')
  } catch {
    throw domainError(code, 'project path is not a valid directory')
  }
  return real
}

function hasGitMarker(path) {
  try {
    return lstatSync(join(path, '.git')).isDirectory() || lstatSync(join(path, '.git')).isFile()
  } catch {
    return false
  }
}

function repositoryRoot(cwd) {
  let current = cwd
  for (;;) {
    if (hasGitMarker(current)) return current
    const parent = dirname(current)
    if (parent === current) return cwd
    current = parent
  }
}

function isWithin(root, child) {
  const rest = relative(root, child)
  return rest === '' || (!rest.startsWith('..') && !isAbsolute(rest))
}

/** Return the stable project key for a canonical path. */
export function projectIdFor(projectRoot) {
  const root = validDirectory(projectRoot, 'PROJECT_INVALID')
  return createHash('sha256').update(root).digest('hex')
}

/**
 * Resolve the project storage context from the DSH workspace cwd.
 *
 * `projectRoot` is an optional host-provided workspace identity. When it is
 * absent, the nearest Git root is used; non-Git directories remain isolated.
 */
export function resolveProjectContext({ cwd, storeRoot = DEFAULT_STORE_ROOT, projectRoot } = {}) {
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    throw domainError('CWD_REQUIRED', 'project cwd is required')
  }
  const canonicalCwd = validDirectory(cwd)
  const root = projectRoot === undefined
    ? repositoryRoot(canonicalCwd)
    : validDirectory(projectRoot, 'PROJECT_INVALID')
  if (!isWithin(root, canonicalCwd)) {
    throw domainError('PROJECT_MISMATCH', 'project root does not contain cwd')
  }
  const id = projectIdFor(root)
  const base = resolve(storeRoot)
  return {
    id,
    root,
    title: basename(root) || root,
    dir: join(base, 'projects', id),
    chatsDir: join(base, 'projects', id, 'chats'),
  }
}

/** Accept only a single path-safe chat identifier. */
export function safeChatId(id) {
  if (typeof id !== 'string' || !CHAT_ID_RE.test(id)) {
    throw domainError('INVALID_CHAT_ID', 'invalid chat id')
  }
  return id
}

