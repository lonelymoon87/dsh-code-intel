import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import type { JobHooks, JobStart } from '@deepseek-ai/dsh-jobs'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { CodeIndexer } from '../src/indexer.ts'
import type { IndexerConfig } from '../src/indexer.ts'
import { apply, resolveConfig } from '../src/index.ts'
import { extractCodeChunks, languageName } from '../src/languages.ts'
import { CodeIndexStore } from '../src/store.ts'

const temporaryDirectories: string[] = []

afterEach(() => {
  vi.unstubAllGlobals()
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function workspace(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-code-intel-'))
  temporaryDirectories.push(directory)
  return directory
}

function target(path: string): FsTarget {
  return { targetKey: path as never, displayPath: path }
}

function fakeContext(root: string, credential?: string) {
  let jobNumber = 0
  let latestDone: Promise<unknown> = Promise.resolve()
  const fs = {
    async resolve(path: string, options?: { cwd?: string }) {
      return target(resolve(options?.cwd ?? root, path))
    },
    processPath(value: FsTarget) { return value.displayPath },
    contains(parent: FsTarget, child: FsTarget) {
      const path = relative(parent.displayPath, child.displayPath)
      return path === '' || (!path.startsWith('..') && !path.startsWith('/'))
    },
    async stat(value: FsTarget) {
      try {
        const info = statSync(value.displayPath)
        return {
          version: `${info.mtimeMs}:${info.size}` as never,
          type: info.isFile() ? 'file' as const : info.isDirectory() ? 'directory' as const : 'other' as const,
          size: info.size,
        }
      } catch {
        return undefined
      }
    },
    async listDir(value: FsTarget) {
      return readdirSync(value.displayPath, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name)).map((entry) => {
        const path = join(value.displayPath, entry.name)
        const info = statSync(path)
        return {
          name: entry.name,
          type: entry.isFile() ? 'file' as const : entry.isDirectory() ? 'directory' as const : 'other' as const,
          target: target(path),
          version: `${info.mtimeMs}:${info.size}` as never,
          size: info.size,
        }
      })
    },
    async readText(value: FsTarget) { return readFileSync(value.displayPath, 'utf8') },
  }
  const jobs = {
    start(spec: JobStart) {
      jobNumber += 1
      const hooks: JobHooks = spec.run()
      latestDone = hooks.done
      return `code-index-${jobNumber}` as never
    },
  }
  const ctx = {
    fs,
    jobs,
    credentials: { resolve: vi.fn(async () => credential === undefined ? undefined : { value: credential, source: 'test' }) },
    logger: { warn: vi.fn(), info: vi.fn() },
  } as unknown as Context
  return { ctx, done: () => latestDone }
}

function execution(root: string): ToolExecution {
  return {
    name: 'code_search',
    arguments: {},
    signal: new AbortController().signal,
    agent: { session: { header: { cwd: root } } },
  } as unknown as ToolExecution
}

function config(overrides: Partial<IndexerConfig> = {}): IndexerConfig {
  return {
    indexDir: '.dsh/code-index',
    include: ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java'],
    exclude: ['.dsh', '.git', 'node_modules'],
    maxFileSize: 100_000,
    maxChunkChars: 4_000,
    maxResults: 20,
    watch: false,
    ...overrides,
  }
}

describe('language parsing', () => {
  it.each([
    ['a.ts', 'export function alpha() {}', 'alpha'],
    ['a.py', 'def alpha():\n    return 1', 'alpha'],
    ['a.go', 'package a\nfunc alpha() {}', 'alpha'],
    ['a.rs', 'fn alpha() {}', 'alpha'],
    ['A.java', 'class A { void alpha() {} }', 'alpha'],
  ])('extracts symbol boundaries from %s', async (path, source, symbol) => {
    const chunks = await extractCodeChunks(path, source, 1_000)
    expect(chunks).toEqual(expect.arrayContaining([expect.objectContaining({ symbol })]))
    expect(chunks).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'module' })]))
  })

  it('reports only supported language extensions and bounds large chunks', async () => {
    expect(languageName('a.txt')).toBeUndefined()
    const chunks = await extractCodeChunks('a.ts', `function huge() {\n${'x();\n'.repeat(100)}}`, 80)
    expect(chunks.find(chunk => chunk.symbol === 'huge')?.text).toContain('[symbol truncated]')
  })
})

describe('SQLite store', () => {
  it('atomically replaces and deletes file chunks', () => {
    const root = workspace()
    const store = new CodeIndexStore(join(root, 'index.sqlite'))
    store.reset('lexical:v1')
    expect(store.fingerprint()).toBe('lexical:v1')
    const chunk = { symbol: 'alpha', kind: 'function', startLine: 1, endLine: 2, text: 'function alpha() {}' }
    store.replaceFile('src/a.ts', 'v1', 20, 'typescript', [chunk], [[1, 0]])
    expect(store.stats()).toEqual({ files: 1, chunks: 1 })
    expect(store.fileVersion('src/a.ts')).toEqual({ version: 'v1', size: 20 })
    expect(store.symbols('src')).toEqual([expect.objectContaining({ symbol: 'alpha', embedding: [1, 0] })])
    store.replaceFile('src/a.ts', 'v2', 18, 'typescript', [{ ...chunk, symbol: 'beta' }], [undefined])
    expect(store.symbols().map(value => value.symbol)).toEqual(['beta'])
    store.deleteFile('src/a.ts')
    expect(store.stats()).toEqual({ files: 0, chunks: 0 })
    store.replaceFile('src/b.ts', 'v1', 10, 'typescript', [chunk], [undefined])
    store.reset('hybrid:v1')
    expect(store.fingerprint()).toBe('hybrid:v1')
    expect(store.stats()).toEqual({ files: 0, chunks: 0 })
    store.close()
  })
})

describe('index lifecycle and search', () => {
  it('builds in a background job, searches lexical chunks, outlines, and refreshes observed changes', async () => {
    const root = workspace()
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src/auth.ts'), 'export function authorizeUser(role: string) { return role === "admin" }\n')
    writeFileSync(join(root, 'src/ignored.txt'), 'authorizeUser')
    const fixture = fakeContext(root)
    const indexer = new CodeIndexer(fixture.ctx, config())
    const exec = execution(root)

    await expect(indexer.search('authorize user', 10, exec)).resolves.toMatchObject({ kind: 'indexing', mode: 'lexical' })
    await expect(fixture.done()).resolves.toMatchObject({ status: 'completed' })
    const search = await indexer.search('authorize user', 10, exec)
    expect(search).toMatchObject({ kind: 'results', mode: 'lexical', indexedFiles: 1 })
    if (search.kind !== 'results') throw new Error('expected results')
    expect(search.results[0]).toMatchObject({ path: 'src/auth.ts', symbol: 'authorizeUser', line: 1 })

    const outline = await indexer.outline('src/auth.ts', exec)
    expect(outline).toMatchObject({ path: 'src/auth.ts', symbols: [expect.objectContaining({ symbol: 'authorizeUser' })] })

    writeFileSync(join(root, 'src/auth.ts'), 'export function revokeAccess() { return true }\n')
    indexer.observe(target(join(root, 'src/auth.ts')), { kind: 'present', version: 'changed' as never })
    const refreshed = await indexer.search('revoke access', 10, exec)
    expect(refreshed).toMatchObject({ kind: 'results' })
    if (refreshed.kind !== 'results') throw new Error('expected refreshed results')
    expect(refreshed.results).toEqual(expect.arrayContaining([expect.objectContaining({ symbol: 'revokeAccess' })]))
    expect(join(root, '.dsh/code-index/index.sqlite')).toSatisfy(path => statSync(path).isFile())
    await indexer.close()
  })

  it('uses per-operation credentials and combines compatible embedding vectors', async () => {
    const root = workspace()
    writeFileSync(join(root, 'auth.ts'), 'export function authorizeUser() { return true }\n')
    writeFileSync(join(root, 'paint.ts'), 'export function paintCanvas() { return true }\n')
    const fixture = fakeContext(root, 'secret-value')
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer secret-value')
      const body = JSON.parse(String(init.body)) as { input: string[] }
      return new Response(JSON.stringify({
        data: body.input.map((text, index) => ({ index, embedding: /permission|authorize/iu.test(text) ? [1, 0] : [0, 1] })),
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const indexer = new CodeIndexer(fixture.ctx, config({
      embedding: {
        provider: 'openai-compatible',
        endpoint: 'https://embedding.example/v1/embeddings',
        model: 'embed-test',
        credentialRef: 'EMBEDDING_KEY',
        batchSize: 4,
      },
    }))
    const exec = execution(root)
    await indexer.search('permission checks', 5, exec)
    await fixture.done()
    const response = await indexer.search('permission checks', 5, exec)
    expect(response).toMatchObject({ kind: 'results', mode: 'hybrid' })
    if (response.kind !== 'results') throw new Error('expected hybrid results')
    expect(response.results).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'auth.ts' })]))
    expect(fetchMock).toHaveBeenCalled()
    await indexer.close()
  })

  it('fails loud when a configured embedding credential is absent', async () => {
    const root = workspace()
    writeFileSync(join(root, 'a.ts'), 'function a() {}')
    const fixture = fakeContext(root)
    const indexer = new CodeIndexer(fixture.ctx, config({
      embedding: {
        provider: 'openai-compatible',
        endpoint: 'https://embedding.example/v1/embeddings',
        model: 'embed-test',
        credentialRef: 'EMBEDDING_KEY',
        batchSize: 4,
      },
    }))
    await indexer.search('function', 5, execution(root))
    await expect(fixture.done()).resolves.toMatchObject({ status: 'failed', detail: expect.stringContaining('not configured') })
    await indexer.close()
  })
})

describe('configuration', () => {
  it('defaults to lexical mode and rejects unsafe or unsupported fields', () => {
    expect(resolveConfig()).toMatchObject({ indexDir: '.dsh/code-index', watch: true })
    expect(resolveConfig().embedding).toBeUndefined()
    expect(() => resolveConfig({ indexDir: '../outside' })).toThrow('workspace-relative')
    expect(() => resolveConfig({ include: ['.txt'] })).toThrow('unsupported include extension')
    expect(() => resolveConfig({ maxResults: 0 })).toThrow('positive safe integer')
    expect(() => resolveConfig({ embedding: { provider: 'openai-compatible', endpoint: 'file:///tmp/x', model: 'x', credentialRef: 'KEY' } }))
      .toThrow('HTTP(S)')
    expect(() => resolveConfig({ embedding: { provider: 'openai-compatible', endpoint: 'https://example.test/', model: '', credentialRef: 'KEY' } }))
      .toThrow('model')
  })

  it('registers both tools, prompt guidance, invalidation, and async cleanup', async () => {
    const tools: Array<{ name: string }> = []
    let observed: ((...args: never[]) => void) | undefined
    let dispose: (() => Promise<void>) | undefined
    const section = vi.fn()
    const ctx = {
      systemPrompt: { section },
      tools: { register: (tool: { name: string }) => { tools.push(tool); return () => {} } },
      on: (event: string, listener: (...args: never[]) => void) => {
        if (event === 'fs/observed') observed = listener
        return () => {}
      },
      effect: (mount: () => () => Promise<void>) => { dispose = mount() },
      logger: { warn: vi.fn() },
    } as unknown as Context
    apply(ctx)
    expect(tools.map(tool => tool.name)).toEqual(['code_search', 'code_outline'])
    expect(section).toHaveBeenCalledWith(expect.objectContaining({ name: 'tool:code-intel' }))
    expect(observed).toBeTypeOf('function')
    expect(dispose).toBeTypeOf('function')
    await dispose?.()
  })
})
