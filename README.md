# dsh-code-intel

Symbol-aware code outline, persistent workspace indexing, and explicit lexical or embedding-assisted search for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

> Early development: install from the GitHub release while npm publication is pending.

[简体中文](./README.zh-CN.md)

## MVP

- `code_search` ranks AST symbol chunks and bounded module windows, returning `path:line`, symbol metadata, snippets, scores, and the active retrieval mode.
- `code_outline` parses one file immediately or projects a directory from the persistent index.
- The first workspace search starts a cancellable `code-index` background job instead of blocking the agent turn.
- SQLite persistence under `.dsh/code-index/` uses DSH filesystem versions for incremental rebuilds.
- `fs/observed` marks successful DSH file operations dirty; a Chokidar watcher covers local shell, IDE, and external changes.
- TypeScript, TSX, JavaScript, JSX, Python, Go, Rust, and Java use the install-script-free Tree-sitter WASM grammars published for VS Code.
- An optional OpenAI-compatible embedding endpoint adds cosine similarity to lexical ranking. Without it, results explicitly say `mode: lexical`.

DeepSeek's official API does not currently expose a public embedding endpoint, so this plugin does not invent one or silently label lexical results as semantic.

## Index lifecycle

On the first `code_search` or directory `code_outline`, the tool returns an `indexing` result and a job id. Inspect or wait for that job with the built-in jobs tools, then call the code tool again. File outlines do not require a complete workspace index.

The cache contains derived source text and optional vectors. It stays inside the workspace, excludes `.dsh` from its own scan, and may be deleted at any time for a full rebuild. A retrieval-configuration fingerprint automatically invalidates vectors when the embedding endpoint or model changes.

Source traversal and reads use the mounted DSH filesystem service. SQLite and Chokidar require the provider's `processPath()` to be accessible from the plugin host, so the MVP targets the standard local filesystem execution world. If a remote filesystem exposes paths that are not host-accessible, cache creation fails loudly instead of indexing a different directory.

Node 22 currently labels the built-in SQLite module experimental. The on-disk cache is disposable and schema-versioned; source files remain the only source of truth.

## Retrieval modes

Lexical mode scores exact query matches, query tokens, symbol names, and paths. Hybrid mode combines that score with cosine similarity over endpoint-produced vectors. A configured endpoint or credential failure fails the indexing job or search; fallback occurs only when embedding is not configured.

Credentials are references, not secret values in YAML. The plugin resolves the reference through `ctx.credentials` for each indexing or query operation and never stores the credential.

## Install

The package currently targets DSH `0.1.0-rc.6` plugin APIs and Node.js `^22.19 || >=24`.

```sh
dsh plugin --profile default add ./dsh-code-intel-0.1.0.tgz
```

Download the tarball from the latest GitHub release. A pinned source install is also supported:

```sh
dsh plugin --profile default add github:lonelymoon87/dsh-code-intel#v0.1.0
```

The source install runs this package's `prepare` build. pnpm 10 and later reject it until the profile allowlists the exact package key printed by the failed command; apply that instruction and rerun the same `dsh plugin add` command. The release tarball is prebuilt and needs no build allowance.

## Configuration

Lexical mode needs no provider configuration:

```yaml
- id: code-intel
  name: dsh-code-intel
  config:
    indexDir: .dsh/code-index
    include: [.ts, .tsx, .js, .jsx, .py, .go, .rs, .java]
    exclude: [.dsh, .git, node_modules, dist, build, coverage, vendor]
    maxFileSize: 1000000
    maxChunkChars: 12000
    maxResults: 20
    watch: true
    embedding: false
```

Hybrid mode uses a complete OpenAI-compatible embeddings URL:

```yaml
    embedding:
      provider: openai-compatible
      endpoint: https://embedding.example/v1/embeddings
      model: your-embedding-model
      credentialRef: EMBEDDING_API_KEY
      batchSize: 32
```

`indexDir` and exclusions must stay workspace-relative. Only the listed, parser-backed extensions are accepted in MVP.

## Verification

Tests use real temporary workspaces and SQLite databases. They cover all parser families, background indexing, lexical retrieval, direct outline, `fs/observed` refresh, hybrid ranking, credential absence, vector persistence, cache replacement, and invalid configuration.

## License

[MIT](./LICENSE)
