/** Language detection and symbol-boundary chunking backed by Tree-sitter WASM. */

import { Language, Parser } from 'web-tree-sitter'
import type { Node } from 'web-tree-sitter'
import { extname } from 'node:path'
import { fileURLToPath } from 'node:url'

/** One symbol or bounded module region persisted in the code index. */
export interface CodeChunk {
  readonly symbol: string
  readonly kind: string
  readonly startLine: number
  readonly endLine: number
  readonly text: string
}

interface LanguageSpec {
  readonly wasm: string
  readonly name: string
  readonly symbolKinds: Readonly<Record<string, string>>
}

const TYPESCRIPT_SYMBOLS = {
  function_declaration: 'function',
  class_declaration: 'class',
  method_definition: 'method',
  interface_declaration: 'interface',
  type_alias_declaration: 'type',
  enum_declaration: 'enum',
} as const

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, LanguageSpec>> = {
  '.js': {
    wasm: fileURLToPath(import.meta.resolve('@vscode/tree-sitter-wasm/wasm/tree-sitter-javascript.wasm')),
    name: 'javascript',
    symbolKinds: TYPESCRIPT_SYMBOLS,
  },
  '.jsx': {
    wasm: fileURLToPath(import.meta.resolve('@vscode/tree-sitter-wasm/wasm/tree-sitter-javascript.wasm')),
    name: 'javascript',
    symbolKinds: TYPESCRIPT_SYMBOLS,
  },
  '.ts': {
    wasm: fileURLToPath(import.meta.resolve('@vscode/tree-sitter-wasm/wasm/tree-sitter-typescript.wasm')),
    name: 'typescript',
    symbolKinds: TYPESCRIPT_SYMBOLS,
  },
  '.tsx': {
    wasm: fileURLToPath(import.meta.resolve('@vscode/tree-sitter-wasm/wasm/tree-sitter-tsx.wasm')),
    name: 'typescript',
    symbolKinds: TYPESCRIPT_SYMBOLS,
  },
  '.py': {
    wasm: fileURLToPath(import.meta.resolve('@vscode/tree-sitter-wasm/wasm/tree-sitter-python.wasm')),
    name: 'python',
    symbolKinds: { function_definition: 'function', class_definition: 'class' },
  },
  '.go': {
    wasm: fileURLToPath(import.meta.resolve('@vscode/tree-sitter-wasm/wasm/tree-sitter-go.wasm')),
    name: 'go',
    symbolKinds: { function_declaration: 'function', method_declaration: 'method', type_declaration: 'type' },
  },
  '.rs': {
    wasm: fileURLToPath(import.meta.resolve('@vscode/tree-sitter-wasm/wasm/tree-sitter-rust.wasm')),
    name: 'rust',
    symbolKinds: {
      function_item: 'function',
      struct_item: 'struct',
      enum_item: 'enum',
      trait_item: 'trait',
      impl_item: 'impl',
      type_item: 'type',
      const_item: 'constant',
    },
  },
  '.java': {
    wasm: fileURLToPath(import.meta.resolve('@vscode/tree-sitter-wasm/wasm/tree-sitter-java.wasm')),
    name: 'java',
    symbolKinds: {
      class_declaration: 'class',
      interface_declaration: 'interface',
      enum_declaration: 'enum',
      record_declaration: 'record',
      method_declaration: 'method',
      constructor_declaration: 'constructor',
    },
  },
}

/** Extensions parsed into symbol-aware chunks. */
export const SUPPORTED_EXTENSIONS = Object.freeze(Object.keys(LANGUAGE_BY_EXTENSION))

const parserReady = Parser.init()
const languageCache = new Map<string, Promise<Language>>()

/** Return the parser language name for a supported path. */
export function languageName(path: string): string | undefined {
  return LANGUAGE_BY_EXTENSION[extname(path).toLowerCase()]?.name
}

async function loadLanguage(wasm: string): Promise<Language> {
  await parserReady
  let pending = languageCache.get(wasm)
  if (pending === undefined) {
    pending = Language.load(wasm)
    languageCache.set(wasm, pending)
  }
  return pending
}

function symbolName(node: Node): string {
  const named = node.childForFieldName('name')
  if (named !== null) return named.text
  const type = node.childForFieldName('type')
  if (type !== null) return type.text
  return (node.text.split('\n', 1)[0]?.trim() ?? node.type).slice(0, 120)
}

function boundedText(text: string, maxChunkChars: number): string {
  return text.length <= maxChunkChars ? text : `${text.slice(0, maxChunkChars)}\n… [symbol truncated]`
}

function moduleChunks(source: string, maxChunkChars: number): CodeChunk[] {
  const lines = source.split('\n')
  const windowLines = 120
  const overlap = 12
  const chunks: CodeChunk[] = []
  for (let start = 0; start < lines.length; start += windowLines - overlap) {
    const end = Math.min(lines.length, start + windowLines)
    const text = boundedText(lines.slice(start, end).join('\n'), maxChunkChars)
    if (text.trim().length > 0) chunks.push({ symbol: '', kind: 'module', startLine: start + 1, endLine: end, text })
    if (end === lines.length) break
  }
  return chunks
}

/** Parse one supported source file into symbols plus bounded module windows. */
export async function extractCodeChunks(path: string, source: string, maxChunkChars: number): Promise<CodeChunk[]> {
  const spec = LANGUAGE_BY_EXTENSION[extname(path).toLowerCase()]
  if (spec === undefined) return []
  const parser = new Parser()
  parser.setLanguage(await loadLanguage(spec.wasm))
  const tree = parser.parse(source)
  if (tree === null) {
    parser.delete()
    throw new Error(`Tree-sitter did not produce a syntax tree for ${path}`)
  }
  try {
    const symbols: CodeChunk[] = []
    const visit = (node: Node): void => {
      const kind = spec.symbolKinds[node.type]
      if (kind !== undefined) {
        symbols.push({
          symbol: symbolName(node),
          kind,
          startLine: node.startPosition.row + 1,
          endLine: Math.max(node.startPosition.row + 1, node.endPosition.row + 1),
          text: boundedText(node.text, maxChunkChars),
        })
      }
      for (const child of node.namedChildren) visit(child)
    }
    visit(tree.rootNode)
    return [...symbols, ...moduleChunks(source, maxChunkChars)]
  } finally {
    tree.delete()
    parser.delete()
  }
}
