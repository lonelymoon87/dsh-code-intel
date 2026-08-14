/** SQLite persistence for file versions, symbol chunks, and optional embeddings. */

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { CodeChunk } from './languages.ts'

/** Persisted chunk returned to ranking and outline callers. */
export interface StoredChunk extends CodeChunk {
  readonly id: number
  readonly path: string
  readonly language: string
  readonly embedding?: readonly number[]
}

interface FileVersion {
  readonly version: string
  readonly size: number
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('code index contains an invalid SQLite row')
  }
  return value as Record<string, unknown>
}

function stringField(row: Record<string, unknown>, field: string): string {
  const value = row[field]
  if (typeof value !== 'string') throw new TypeError(`code index row has invalid ${field}`)
  return value
}

function integerField(row: Record<string, unknown>, field: string): number {
  const value = row[field]
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new TypeError(`code index row has invalid ${field}`)
  return value
}

function parseEmbedding(value: unknown): readonly number[] | undefined {
  if (value === null) return undefined
  if (typeof value !== 'string') throw new TypeError('code index row has invalid embedding')
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some(item => typeof item !== 'number' || !Number.isFinite(item))) {
    throw new TypeError('code index row has invalid embedding vector')
  }
  return parsed as number[]
}

function parseChunk(value: unknown): StoredChunk {
  const row = record(value)
  const embedding = parseEmbedding(row.embedding)
  return {
    id: integerField(row, 'id'),
    path: stringField(row, 'path'),
    language: stringField(row, 'language'),
    symbol: stringField(row, 'symbol'),
    kind: stringField(row, 'kind'),
    startLine: integerField(row, 'start_line'),
    endLine: integerField(row, 'end_line'),
    text: stringField(row, 'text'),
    ...embedding === undefined ? {} : { embedding },
  }
}

function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
}

/** Synchronous local cache store; all source reads remain on the DSH filesystem seam. */
export class CodeIndexStore {
  readonly #database: DatabaseSync

  /** Open or initialize an index database at an already validated local cache path. */
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.#database = new DatabaseSync(path)
    this.#database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    const version = this.#database.prepare('PRAGMA user_version').get() as Record<string, unknown> | undefined
    const current = version?.user_version
    if (current !== 0 && current !== 2) throw new Error(`unsupported code index schema version ${String(current)}`)
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        size INTEGER NOT NULL,
        language TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
        language TEXT NOT NULL,
        symbol TEXT NOT NULL,
        kind TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        text TEXT NOT NULL,
        embedding TEXT
      );
      CREATE INDEX IF NOT EXISTS chunks_path ON chunks(path);
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      PRAGMA user_version = 2;
    `)
  }

  /** Return the retrieval configuration fingerprint stored with this cache. */
  fingerprint(): string | undefined {
    const value = this.#database.prepare("SELECT value FROM metadata WHERE key = 'fingerprint'").get()
    return value === undefined ? undefined : stringField(record(value), 'value')
  }

  /** Clear derived data and bind the empty cache to one retrieval configuration. */
  reset(fingerprint: string): void {
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      this.#database.exec('DELETE FROM files; DELETE FROM metadata;')
      this.#database.prepare("INSERT INTO metadata(key, value) VALUES ('fingerprint', ?)").run(fingerprint)
      this.#database.exec('COMMIT')
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  /** Return the stored version and size for one workspace-relative path. */
  fileVersion(path: string): FileVersion | undefined {
    const value = this.#database.prepare('SELECT version, size FROM files WHERE path = ?').get(path)
    if (value === undefined) return undefined
    const row = record(value)
    return { version: stringField(row, 'version'), size: integerField(row, 'size') }
  }

  /** Return every indexed workspace-relative file path. */
  filePaths(): string[] {
    return this.#database.prepare('SELECT path FROM files ORDER BY path').all().map((value) => {
      return stringField(record(value), 'path')
    })
  }

  /** Atomically replace one file and all of its derived chunks. */
  replaceFile(
    path: string,
    version: string,
    size: number,
    language: string,
    chunks: readonly CodeChunk[],
    embeddings: readonly (readonly number[] | undefined)[],
  ): void {
    if (chunks.length !== embeddings.length) throw new TypeError('chunk and embedding counts differ')
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      this.#database.prepare(`
        INSERT INTO files(path, version, size, language) VALUES (?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET version=excluded.version, size=excluded.size, language=excluded.language
      `).run(path, version, size, language)
      this.#database.prepare('DELETE FROM chunks WHERE path = ?').run(path)
      const insert = this.#database.prepare(`
        INSERT INTO chunks(path, language, symbol, kind, start_line, end_line, text, embedding)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index]
        if (chunk === undefined) continue
        const embedding = embeddings[index]
        insert.run(
          path,
          language,
          chunk.symbol,
          chunk.kind,
          chunk.startLine,
          chunk.endLine,
          chunk.text,
          embedding === undefined ? null : JSON.stringify(embedding),
        )
      }
      this.#database.exec('COMMIT')
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  /** Remove one absent or excluded file and its chunks. */
  deleteFile(path: string): void {
    this.#database.prepare('DELETE FROM files WHERE path = ?').run(path)
  }

  /** Return all chunks, optionally constrained to a file or directory prefix. */
  chunks(pathPrefix?: string): StoredChunk[] {
    const rows = pathPrefix === undefined || pathPrefix === '' || pathPrefix === '.'
      ? this.#database.prepare('SELECT * FROM chunks').all()
      : this.#database.prepare("SELECT * FROM chunks WHERE path = ? OR path LIKE ? ESCAPE '\\'")
          .all(pathPrefix, `${escapeLike(pathPrefix.replace(/\/$/u, ''))}/%`)
    return rows.map(parseChunk)
  }

  /** Return symbol chunks only for an outline projection. */
  symbols(pathPrefix?: string): StoredChunk[] {
    return this.chunks(pathPrefix)
      .filter(chunk => chunk.kind !== 'module')
      .sort((left, right) => left.path.localeCompare(right.path) || left.startLine - right.startLine)
  }

  /** Return persisted file and chunk counts. */
  stats(): { readonly files: number; readonly chunks: number } {
    const files = record(this.#database.prepare('SELECT COUNT(*) AS count FROM files').get())
    const chunks = record(this.#database.prepare('SELECT COUNT(*) AS count FROM chunks').get())
    return { files: integerField(files, 'count'), chunks: integerField(chunks, 'count') }
  }

  /** Close the SQLite handle. */
  close(): void {
    this.#database.close()
  }
}
