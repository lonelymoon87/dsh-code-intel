# dsh-code-intel

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的符号级代码大纲、持久工作区索引，以及明确区分词法与 embedding 的代码检索插件。

> 目前处于早期开发阶段。npm 发布尚未完成，现阶段请从 GitHub Release 安装。

[English](./README.md)

## MVP

- `code_search` 对 AST 符号块和有界模块窗口排序，返回文件、行号、符号信息、片段、分数和实际检索模式；
- `code_outline` 可直接解析单个文件，也可从持久索引投影目录大纲；
- 工作区第一次检索会启动可取消的 `code-index` 后台 job，不阻塞当前 agent turn；
- 索引以 SQLite 保存到 `.dsh/code-index/`，并用 DSH 文件版本增量更新；
- `fs/observed` 标记 DSH 文件操作带来的变更，Chokidar watcher 覆盖本地 shell、IDE 和外部修改；
- TypeScript、TSX、JavaScript、JSX、Python、Go、Rust 和 Java 使用 VS Code 发布的免安装脚本 Tree-sitter WASM grammar；
- 可选的 OpenAI-compatible embedding 端点会把余弦相似度加入词法排序。未配置时结果会明确标记 `mode: lexical`。

DeepSeek 官方 API 目前没有公开 embedding endpoint。本插件不会虚构默认端点，也不会把纯词法结果包装成语义检索。

## 索引生命周期

第一次调用 `code_search` 或目录级 `code_outline` 时，工具会返回 `indexing` 状态和 job id。可用内置 jobs 工具查看或等待任务，完成后再次调用。单文件大纲不依赖完整工作区索引。

缓存只保存由源码派生的文本和可选向量，位于工作区内部，并排除 `.dsh` 自身。它随时可以删除并完整重建。embedding 端点或模型变化时，检索配置指纹会自动使旧向量失效。

源码遍历和读取都经过 DSH filesystem service。SQLite 和 Chokidar 要求 provider 的 `processPath()` 能由插件宿主访问，因此 MVP 面向标准本地 filesystem execution world。远程 provider 如果返回宿主无法访问的路径，缓存创建会明确失败，不会错误索引另一处目录。

Node 22 仍把内置 SQLite 模块标记为 experimental。索引缓存可丢弃并带有 schema version，源码始终是唯一事实源。

## 检索模式

词法模式根据完整查询、查询词、符号名和路径计分。混合模式再加入 endpoint 向量的余弦相似度。已经配置的 endpoint 或 credential 如果失效，索引 job 或查询会明确失败。只有完全未配置 embedding 时才运行词法模式。

YAML 中只保存 credential reference，不保存秘密值。插件会在每次索引或查询操作中通过 `ctx.credentials` 解析，并且不会持久化 credential。

## 安装

当前代码面向 DSH `0.1.0-rc.6` 插件 API，要求 Node.js `^22.19 || >=24`。

```sh
dsh plugin --profile default add ./dsh-code-intel-0.1.0.tgz
```

请先从最新 GitHub Release 下载 tarball。也可以固定版本从源码安装：

```sh
dsh plugin --profile default add github:lonelymoon87/dsh-code-intel#v0.1.0
```

源码安装会运行本包的 `prepare` 构建。pnpm 10 及以上版本默认拒绝执行，第一次安装失败时请按 DSH 输出的提示，将准确的包键加入 profile 的构建白名单，然后重新执行同一条命令。Release tarball 已预构建，不需要构建权限。

## 配置

词法模式不需要 provider：

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

混合模式使用完整的 OpenAI-compatible embeddings URL：

```yaml
    embedding:
      provider: openai-compatible
      endpoint: https://embedding.example/v1/embeddings
      model: your-embedding-model
      credentialRef: EMBEDDING_API_KEY
      batchSize: 32
```

`indexDir` 和排除项必须是工作区内的相对路径。MVP 只接受已经接入 parser 的扩展名。

## 许可证

[MIT](./LICENSE)
