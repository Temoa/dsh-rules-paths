# dsh-rules-paths

Claude Code-style `paths:` rule injection for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness): when the model successfully `read`s a file that matches a rule's `paths:` glob, the rule body is injected into the model context at the next step boundary. It follows the official `@deepseek-ai/dsh-agent-instructions` mechanics (`tools/result` hook, `agent.inbox.nextStep` inbox, `agent/pre-step` folding, SHA-1 dedup, byte budget).

## Features

- **Path rules** — a rule file declares `paths:` glob patterns; a successful `read` of a matching file injects the rule body at the next step boundary.
- **Global rules** — a rule without `paths` (or with no frontmatter at all) is injected into the first entering step of the session, independent of any file read (like `AGENTS.md`).
- **Project rules** — optional scan of `<projectRoot>/.dsh/rules` **and** `<projectRoot>/.claude/rules` (Claude Code convention), keyed on the `.git` project root.
- **Dedup & budget** — each rule is injected once per session unless its content changes (SHA-1 digest → `replace`); the rendered message never exceeds `maxBytes` and reports `Rules budget …` when rules are dropped or truncated.
- **Guidance, not authority** — injected content is a user-role message that does not override system, developer, or direct user instructions; literal `</system-reminder>` is escaped.

## Install

> Requires DSH 0.1.0-rc.x (Web profile).

### From GitHub

```bash
dsh plugin --profile web add git+https://github.com/Temoa/dsh-rules-paths.git
```

pnpm pins the package by commit with a full integrity hash. Because the package declares `dsh.bundle.patch` (`cordis.patch.yml`), the reconciler appends it to the profile's `dsh.profile.bundles` automatically — the plugin mounts at the PROFILE level and rules apply to **every session on that profile**, no preset edit needed.

To scope the rules to one agent preset instead, add this row to a user preset (a copy of `standard`):

```yaml
- id: rules-paths
  name: '@temoa/dsh-rules-paths'
  config:
    rulesDir: "~/.dsh/rules"
    rulesDirProject: true
```

### From a local checkout

```bash
dsh plugin --profile web add ./dsh-rules-paths
```

> **After changing plugin code, fully restart the harness** — the module is cached per process URL; preset *config* is re-read per session mount, but the plugin *file* is not re-imported. Rule files themselves never need a restart. Never edit the shipped presets (`standard`/`code`/`minimal`/`cordis`); add the preset row above to a copy instead.

## Uninstall

```bash
dsh plugin --profile web remove @temoa/dsh-rules-paths
```

Restart dsh after removing. The hook is torn down with the plugin; rule files under `~/.dsh/rules` and the project rule directories are left untouched.

## How it works

Rules live in `~/.dsh/rules/*.md` (configurable via `rulesDir`), one rule per file:

````markdown
---
paths:
  - "**/*.dart"
  - "lib/**/*.ts"
description: Dart conventions (optional, metadata only)
---

Rule body: guidance the model follows after reading a matching file.
````

On every successful `read` (and once at session start for global rules), the plugin:

1. Lists the configured rule directories — the user-level `rulesDir`, plus `<projectRoot>/.dsh/rules` and `<projectRoot>/.claude/rules` when `rulesDirProject` is on.
2. Matches the read path against each rule's `paths` globs, against both the absolute path and the cwd-relative path (Windows `\` normalized to `/`), so `**/*.dart` matches both `D:/lab/proj/lib/main.dart` and `lib/main.dart`. Rules without `paths` (or without frontmatter) are treated as global.
3. Renders the matched bodies into a single user-role message — SHA-1 dedup per session, unchanged rules never re-sent, changed ones sent as `replace` — bounded by `maxBytes`, then folds it into the entering `agent/pre-step` right after the last claimed message.

`paths` present but neither a string nor a list skips the file with a warning; files over `maxSourceBytes` are skipped. Rule bodies are untrusted input: text only, delimiters escaped, never executed. No file watcher: rule edits take effect at the next reconciliation (global) or the next successful `read` (path rules).

| Key | Default | Meaning |
|---|---|---|
| `rulesDir` | `~/.dsh/rules` | User-level rules directory (`~` expands) |
| `maxBytes` | `65536` | Byte budget per injected message |
| `maxSourceBytes` | `1048576` | Max bytes read per rule file (larger files skipped) |
| `triggerTools` | `["read"]` | Tool names whose successful executions trigger matching |
| `rulesDirProject` | `false` | Also scan `<projectRoot>/.dsh/rules` and `<projectRoot>/.claude/rules` |

## Repository layout

```
dsh-rules-paths/
├── package.json        # dsh.bundle.patch manifest
├── cordis.patch.yml    # composition layer: appends the plugin to profile bundles
├── lib/
│   ├── index.js        # Host half: rule loading, matching, injection
│   └── types/index.d.ts
├── test/
│   └── index.mjs       # 50-assertion test suite
├── README.md
├── README.zh.md
└── LICENSE
```

## Development

```bash
npm install   # fetches the devDependencies (peers + js-yaml + picomatch)
npm test      # node test/index.mjs — 50 assertions
```

Tests cover: config validation, frontmatter parsing, budget rendering (omit/truncate/escape), message construction, dedup + `replace`, zero injection, global rules, project rules (`.dsh/rules` + `.claude/rules`), and the pre-step fold position.

## License

[MIT](LICENSE)
