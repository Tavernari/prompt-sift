# Contributing to PromptSift

Thank you for helping improve PromptSift. Small, focused pull requests are easiest to review and safest to release.

## Before you start

- Search existing issues and pull requests before opening a duplicate.
- Open an issue first for large features, new providers, or behavior changes.
- Use GitHub's private vulnerability reporting process for security problems; do not create a public issue.
- Keep changes within the project's MIT-licensed scope.

## Development setup

Requirements: Node.js 22, 24, or 26 and npm using the committed lockfile; jq and POSIX shell utilities for plugin tests on macOS/Linux. Plugin end users do not need Node.js.

```bash
git clone https://github.com/Tavernari/prompt-sift.git
cd prompt-sift
npm ci --ignore-scripts
npm run check
```

No external worker or API key is needed for the test suite.

Run only the installed-package integration test with `npm run test:e2e`.

## Pull requests

1. Create a branch from `main`.
2. Add or update tests for behavior changes.
3. Run `npm run check` locally.
4. Update documentation when configuration, commands, or compatibility changes.
5. Add an entry under `Unreleased` in `CHANGELOG.md` for user-visible changes.
6. Open a pull request and complete its checklist.

Use Conventional Commit-style subjects where practical, such as `feat: support another worker endpoint` or `fix: allow bounded tail reads`. Maintainers may squash commits, so make the pull request title suitable as a changelog entry.

## Design constraints

- Keep runtime dependencies at zero unless a dependency removes materially more risk than it adds.
- Preserve Cursor and Copilot hook contracts independently.
- Keep the checked-in hook runner fail-open.
- Reject sensitive-looking and binary inputs before provider calls.
- Never overwrite generated targets without explicit `--force`.
- Treat model output as untrusted until reviewed and tested.
- Avoid token-saving claims that cannot be reproduced.

## Tests

Every parser, policy, cache, provider, installer, hook, or CLI fix needs a regression test. End-to-end tests must exercise the installed hook runner through its real stdin/stdout contract. CI runs the complete suite on all supported Node.js release lines and verifies package contents.

## Review and merge

At least one approving maintainer review and a green `CI / Required checks` result are recommended before merge. Resolve conversations and update branches that conflict with `main`.

By contributing, you agree that your contribution is licensed under the repository's MIT License.

## Plugin bundles

Edit `src/`, `templates/agents/` and `scripts/plugin/` as the source of truth. Run `npm run build:plugins` and commit the generated `plugins/` bundles and marketplace manifests. `npm run check` rejects stale bundles. `npm run test:plugins` executes hooks from isolated cache directories without npm installation or project configuration. Keep each bundle self-contained; never reference files outside its plugin root.
