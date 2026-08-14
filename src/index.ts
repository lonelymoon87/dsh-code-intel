/** DeepSeek Harness tools for symbol outlines and hybrid code search. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { isAbsolute } from 'node:path'
import { CodeIndexer } from './indexer.ts'
import type { EmbeddingConfig, IndexerConfig, IndexingResponse, SearchResponse } from './indexer.ts'
import { SUPPORTED_EXTENSIONS } from './languages.ts'

/** Loader-facing plugin name. */
export const name = 'code-intel'

/** Runtime services required for indexing and model-facing tools. */
export const inject = ['credentials', 'fs', 'jobs', 'systemPrompt', 'tools']

/** Optional OpenAI-compatible embedding configuration. */
export interface EmbeddingConfigInput {
  readonly provider: 'openai-compatible'
  readonly endpoint: string
  readonly model: string
  readonly credentialRef: string
  readonly batchSize?: number
}

/** Deployment configuration for code intelligence. */
export interface Config {
  readonly indexDir?: string
  readonly include?: string[]
  readonly exclude?: string[]
  readonly maxFileSize?: number
  readonly maxChunkChars?: number
  readonly maxResults?: number
  readonly watch?: boolean
  readonly embedding?: false | EmbeddingConfigInput
}

const DEFAULT_INCLUDE = [...SUPPORTED_EXTENSIONS]
const DEFAULT_EXCLUDE = ['.dsh', '.git', 'node_modules', 'dist', 'build', 'coverage', 'vendor']

/** Loader validation for code-intelligence configuration. */
export const Config: z<Config> = z.object({
  indexDir: z.string().default('.dsh/code-index'),
  include: z.array(z.string()).default(DEFAULT_INCLUDE),
  exclude: z.array(z.string()).default(DEFAULT_EXCLUDE),
  maxFileSize: z.number().default(1_000_000),
  maxChunkChars: z.number().default(12_000),
  maxResults: z.number().default(20),
  watch: z.boolean().default(true),
  embedding: z.union([
    z.const(false),
    z.object({
      provider: z.const('openai-compatible'),
      endpoint: z.string(),
      model: z.string(),
      credentialRef: z.string(),
      batchSize: z.number().default(32),
    }),
  ]).default(false),
})

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`)
  return value
}

function safeRelative(name: string, value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/$/u, '')
  if (normalized.length === 0 || isAbsolute(value) || normalized.split('/').includes('..')) {
    throw new TypeError(`${name} must be a non-empty workspace-relative path without ..`)
  }
  return normalized
}

function resolveEmbedding(input: false | EmbeddingConfigInput | undefined): EmbeddingConfig | undefined {
  if (input === undefined || input === false) return undefined
  let endpoint: URL
  try {
    endpoint = new URL(input.endpoint)
  } catch {
    throw new TypeError('embedding.endpoint must be an absolute HTTP(S) URL')
  }
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
    throw new TypeError('embedding.endpoint must be an absolute HTTP(S) URL')
  }
  if (input.model.trim().length === 0) throw new TypeError('embedding.model must be non-empty')
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(input.credentialRef)) throw new TypeError('embedding.credentialRef must be a credential reference name')
  return {
    provider: input.provider,
    endpoint: endpoint.href,
    model: input.model,
    credentialRef: input.credentialRef,
    batchSize: positiveInteger('embedding.batchSize', input.batchSize ?? 32),
  }
}

/** Resolve defaults and reject unsafe or unsupported indexing configuration. */
export function resolveConfig(config: Config = {}): IndexerConfig {
  const include = (config.include ?? DEFAULT_INCLUDE).map(extension => extension.toLowerCase())
  for (const extension of include) {
    if (!extension.startsWith('.') || !SUPPORTED_EXTENSIONS.includes(extension)) {
      throw new TypeError(`unsupported include extension ${JSON.stringify(extension)}; supported: ${SUPPORTED_EXTENSIONS.join(', ')}`)
    }
  }
  const embedding = resolveEmbedding(config.embedding)
  return {
    indexDir: safeRelative('indexDir', config.indexDir ?? '.dsh/code-index'),
    include: [...new Set(include)],
    exclude: [...new Set((config.exclude ?? DEFAULT_EXCLUDE).map(value => safeRelative('exclude entry', value)))],
    maxFileSize: positiveInteger('maxFileSize', config.maxFileSize ?? 1_000_000),
    maxChunkChars: positiveInteger('maxChunkChars', config.maxChunkChars ?? 12_000),
    maxResults: positiveInteger('maxResults', config.maxResults ?? 20),
    watch: config.watch ?? true,
    ...embedding === undefined ? {} : { embedding },
  }
}

const INDEXING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', required: true, const: 'indexing' },
    jobId: { type: 'string', required: true },
    mode: { type: 'string', required: true, enum: ['lexical', 'hybrid'] },
    message: { type: 'string', required: true },
  },
} as const

const SEARCH_HIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', required: true },
    line: { type: 'integer', required: true },
    endLine: { type: 'integer', required: true },
    symbol: { type: 'string', required: true },
    kind: { type: 'string', required: true },
    score: { type: 'number', required: true },
    snippet: { type: 'string', required: true },
  },
} as const

function renderIndexing(value: IndexingResponse): string {
  return `${value.message}\njob: ${value.jobId}\nmode: ${value.mode}`
}

function renderSearch(value: SearchResponse | IndexingResponse): string {
  if (value.kind === 'indexing') return renderIndexing(value)
  if (value.results.length === 0) return `No code matches.\nmode: ${value.mode}\nindexed files: ${value.indexedFiles}`
  const lines = value.results.map((result) => {
    const symbol = result.symbol.length === 0 ? '' : ` [${result.kind}] ${result.symbol}`
    return `${result.path}:${result.line}-${result.endLine}${symbol} (score ${result.score})\n${result.snippet}`
  })
  return `${lines.join('\n\n')}\n\nmode: ${value.mode}; indexed files: ${value.indexedFiles}`
}

function renderOutline(value: Awaited<ReturnType<CodeIndexer['outline']>>): string {
  if ('kind' in value) return renderIndexing(value)
  if (value.symbols.length === 0) return `No supported symbols found under ${value.path}.`
  return value.symbols.map(symbol => `${symbol.path}:${symbol.line}-${symbol.endLine} [${symbol.kind}] ${symbol.symbol}`).join('\n')
}

/** Register search, outline, invalidation, and lifecycle cleanup. */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  const indexer = new CodeIndexer(ctx, resolved)

  ctx.systemPrompt.section({
    name: 'tool:code-intel',
    order: 111,
    text: 'Use code_search for concept or symbol discovery across the workspace. Its mode field says whether ranking is lexical or embedding-assisted. Use code_outline to inspect declarations in one file or directory before broad reads.',
  })

  ctx.on('fs/observed', (target, observation) => {
    try {
      indexer.observe(target, observation)
    } catch (error) {
      ctx.logger.warn(`[code-intel] ignored a filesystem invalidation that could not be mapped: ${String(error)}`)
    }
  })

  ctx.effect(() => () => indexer.close())

  ctx.tools.register(defineTool({
    name: 'code_search',
    description: 'Search workspace code using symbol-aware chunks. Returns explicit lexical or hybrid mode and starts the first index build as a background job.',
    parameters: {
      query: { type: 'string', required: true, description: 'Concept, behavior, API, or symbol to find.' },
      limit: { type: 'number', description: 'Maximum results, capped by plugin configuration.' },
    },
    output: {
      schema: {
        oneOf: [
          INDEXING_SCHEMA,
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'results' },
              mode: { type: 'string', required: true, enum: ['lexical', 'hybrid'] },
              indexedFiles: { type: 'integer', required: true },
              results: { type: 'array', required: true, items: SEARCH_HIT_SCHEMA },
            },
          },
        ],
      },
      render: (_args, value) => [{ type: 'text', text: renderSearch(value) }],
    },
    async execute(args, exec) {
      const query = args.query.trim()
      if (query.length === 0) throw new TypeError('code_search query must be non-empty')
      const limit = args.limit === undefined ? resolved.maxResults : positiveInteger('limit', args.limit)
      return indexer.search(query, limit, exec)
    },
    presentCall: args => ({ card: 'generic', kind: 'search', title: `Search code: ${args.query}` }),
  }))

  ctx.tools.register(defineTool({
    name: 'code_outline',
    description: 'List AST declarations for one supported source file or an indexed workspace directory.',
    parameters: {
      path: { type: 'string', required: true, description: 'Workspace-relative source file or directory.' },
    },
    output: {
      schema: {
        oneOf: [
          INDEXING_SCHEMA,
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string', required: true },
              symbols: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    path: { type: 'string', required: true },
                    line: { type: 'integer', required: true },
                    endLine: { type: 'integer', required: true },
                    symbol: { type: 'string', required: true },
                    kind: { type: 'string', required: true },
                    snippet: { type: 'string', required: true },
                  },
                },
              },
            },
          },
        ],
      },
      render: (_args, value) => [{ type: 'text', text: renderOutline(value) }],
    },
    async execute(args, exec) {
      const path = args.path.trim()
      if (path.length === 0) throw new TypeError('code_outline path must be non-empty')
      return indexer.outline(path, exec)
    },
    presentCall: args => ({ card: 'generic', kind: 'read', title: `Outline ${args.path}`, locations: [{ path: args.path }] }),
  }))
}

export { CodeIndexer } from './indexer.ts'
export type { IndexerConfig, IndexingResponse, SearchHit, SearchResponse } from './indexer.ts'
export { extractCodeChunks, languageName, SUPPORTED_EXTENSIONS } from './languages.ts'
export type { CodeChunk } from './languages.ts'
