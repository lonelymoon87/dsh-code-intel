# Contributing

This repository is an independent DeepSeek Harness plugin, not part of the official monorepo.

1. Open an issue before changing the cache schema, ranking weights, filesystem assumptions, or embedding wire behavior.
2. Add a parser fixture for every language or symbol kind change.
3. Keep retrieval mode explicit; never conceal an embedding failure behind lexical fallback.
4. Update tools, tests, package metadata, and bilingual documentation together.
5. Run `pnpm run check` and report only the commands actually run.

Never add credentials, indexed source caches, generated tarballs, or private repository fixtures to a contribution.
