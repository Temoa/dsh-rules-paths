# dsh-rules-paths

Claude Code-style `paths:` rule injection for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness).

Read a file → matching rules are injected into the model context at the next step boundary. The plugin follows the official `@deepseek-ai/dsh-agent-instructions` mechanics (`tools/result` hook, `agent.inbox.nextStep` inbox, `agent/pre-step` folding, SHA-1 dedup, byte budget).

English | [中文](README.zh.md)

## Features

- **Path rules** — a rule file declares `paths:` glob patterns; when the model successfully `read`s a matching file, the rule body is injected at the next step boundary.
- **Global rules** — a rule without `paths` (or without frontmatter at all) is injected into the first entering step of the session, independent of any file read (like `AGENTS.md`).
- **Project rules** — optional scan of `<projectRoot>/.dsh/rules` **and** `<projectRoot>/.claude/rules` (Claude Code convention), keyed on the `.git` project root.
- **Dedup & budget** — each rule is injected once per session unless its content changes (SHA-1 digest → `replace`); the rendered message never exceeds `maxBytes` and reports `Rules budget …` when it drops/truncates rules.
- **Guidance, not authority** — injected content is a user-role message that does not override system, developer, or direct user instructions; literal `</system-reminder>` is escaped.

## Install

### Option A — install as a package (`dsh plugin add`), no npm needed

Install straight from GitHub — pnpm pins the package by commit with a full
integrity hash:

```bash
dsh plugin --profile web add git+https://github.com/Temoa/dsh-rules-paths.git

# (installs into $DSH_HOME/profiles/<profile>/node_modules; preset rows
#  resolve bare package names from the profile base, whose parent walk
#  covers $DSH_HOME/profiles/node_modules with the in-box packages)
```

Because the package declares `dsh.bundle.patch` (`cordis.patch.yml`), the
reconciler appends it to the profile's `dsh.profile.bundles` automatically —
the plugin then mounts at the PROFILE level and rules apply to **every
session on that profile**, no preset edit needed. If you prefer rules only in
one agent preset, add the row to a user preset (copy of `standard`) instead:

```yaml
- id: rules-paths
  name: '@temoa/dsh-rules-paths'
  config:
    rulesDir: "~/.dsh/rules"
    rulesDirProject: true
```

To uninstall: `dsh plugin --profile web remove @temoa/dsh-rules-paths`.

> **After changing plugin code, fully restart the harness** — the module is
> cached per process URL; preset *config* is re-read per session mount, but the
> plugin *file* is not re-imported. Rule files themselves never need a restart.
> Never edit the shipped presets (`standard`/`code`/`minimal`/`cordis`); add
> the preset row above to a copy instead.

## Rule files

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

- **With `paths:`** → path rule, injected after a successful read of a matching file. Matching runs against both the absolute path and the cwd-relative path (Windows `\` normalized to `/`), so `**/*.dart` matches both `D:/lab/proj/lib/main.dart` and `lib/main.dart`.
- **Without `paths:` (or no frontmatter)** → global rule, whole file is the body, injected at the first entering step.
- `paths` present but neither a string nor a list → file skipped with a warning. Files over `maxSourceBytes` are skipped.
- Project rules (with `rulesDirProject: true`): `<projectRoot>/.dsh/rules` and `<projectRoot>/.claude/rules`, same semantics, displayed relative to the project root.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `rulesDir` | `~/.dsh/rules` | User-level rules directory (`~` expands) |
| `maxBytes` | `65536` | Byte budget per injected message |
| `maxSourceBytes` | `1048576` | Max bytes read per rule file (larger files skipped) |
| `triggerTools` | `["read"]` | Tool names whose successful executions trigger matching |
| `rulesDirProject` | `false` | Also scan `<projectRoot>/.dsh/rules` and `<projectRoot>/.claude/rules` |

## Development

```bash
npm install     # fetches the devDependencies (peers + js-yaml + picomatch)
npm test        # node test/index.mjs — 50 assertions
```

Tests cover: Config validation, frontmatter parsing, budget rendering
(omit/truncate/escape), message construction, dedup + `replace`, zero
injection, global rules, project rules (`.dsh/rules` + `.claude/rules`), and
the pre-step fold position.

## Boundaries

- Injected content is **user-role guidance**, not system authority.
- Rule files are **untrusted input**: body is text only, delimiters escaped, never executed.
- Injection is "next step after read", not synchronous with the read.
- KV-cache: dedup and "unchanged → not re-sent" are required; the plugin never re-injects unchanged rules.
- No file watcher: rule edits take effect at the next step reconciliation (global) or the next successful `read` (path rules).

## License

MIT
