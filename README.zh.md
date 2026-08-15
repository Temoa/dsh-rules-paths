# dsh-rules-paths

面向 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 的 Claude Code 风格 `paths:` 规则注入插件：模型**成功 `read`** 到命中规则 `paths:` glob 的文件后，规则正文在**下一步边界**注入模型上下文。机制与官方 `@deepseek-ai/dsh-agent-instructions` 同构（`tools/result` 挂钩、`agent.inbox.nextStep` 收件箱、`agent/pre-step` 折叠、SHA-1 去重、字节预算）。

## 功能

- **路径规则**——规则文件用 `paths:` 声明 glob；成功 `read` 命中文件后，在下一步边界注入规则正文。
- **全局规则**——没有 `paths`（或完全没有 frontmatter）的规则，在会话**第一个进入的 step** 即注入，不依赖任何文件读取（时机同 `AGENTS.md`）。
- **项目级规则**——可选扫描 `<项目根>/.dsh/rules` **和** `<项目根>/.claude/rules`（Claude Code 约定），以 `.git` 标记项目根。
- **去重与预算**——同一规则每会话只注入一次，内容变化时以 `replace` 更新；注入消息恒不超过 `maxBytes`，省略/截断时给出 `Rules budget …` 提示。
- **指导，不是强制**——注入内容是 user 角色消息，不覆盖 system/developer/用户直接指令；字面 `</system-reminder>` 会被转义。

## 安装

> 需要 DSH 0.1.0-rc.x（Web profile）。

### 从 GitHub

```bash
dsh plugin --profile web add git+https://github.com/Temoa/dsh-rules-paths.git
```

pnpm 按 commit 固定包并带完整 integrity 哈希。包声明了 `dsh.bundle.patch`（`cordis.patch.yml`），reconciler 会自动把它加入 profile 的 `dsh.profile.bundles`——插件挂到 **profile（host）级**，该 profile 上**所有会话**都启用规则注入，无需改任何 preset。

若只想在某个 agent preset 启用，改为在用户 preset（`standard` 的副本）里加一行：

```yaml
- id: rules-paths
  name: '@temoa/dsh-rules-paths'
  config:
    rulesDir: "~/.dsh/rules"
    rulesDirProject: true
```

### 本地 checkout

```bash
dsh plugin --profile web add ./dsh-rules-paths
```

> **改插件代码后必须完整重启 harness**：模块按 URL 在进程内缓存，preset **配置**每次挂载会重读，但插件**文件**不会重新 import；规则文件本身永远不用重启。不要改随附 preset（`standard`/`code`/`minimal`/`cordis`）——复制一个再改。

## 卸载

```bash
dsh plugin --profile web remove @temoa/dsh-rules-paths
```

重启 dsh 即完成卸载。挂钩随插件一起拆除；`~/.dsh/rules` 与项目规则目录下的文件原样保留。

## 工作原理

规则放在 `~/.dsh/rules/*.md`（可用 `rulesDir` 配置），**每个文件一条规则**：

````markdown
---
paths:
  - "**/*.dart"
  - "lib/**/*.ts"
description: Dart 编码规范（可选，仅元数据）
---

规则正文：指导模型在读取匹配文件后遵守的约定。
````

每次成功 `read`（全局规则则在会话开始时），插件做三件事：

1. 枚举配置的规则目录——用户级 `rulesDir`，以及 `rulesDirProject` 开启时的 `<项目根>/.dsh/rules` 与 `<项目根>/.claude/rules`。
2. 把读取路径与每条规则的 `paths` glob 匹配，同时作用于绝对路径和相对 cwd 路径（Windows `\` 归一化为 `/`），`**/*.dart` 既能命中 `D:/lab/proj/lib/main.dart` 也能命中 `lib/main.dart`；没有 `paths`（或无 frontmatter）的规则视为全局规则。
3. 把命中的正文渲染成一条 user 角色消息——按会话 SHA-1 去重、未变化的规则绝不重发、变化时以 `replace` 更新——受 `maxBytes` 约束，然后折叠进进入中的 `agent/pre-step`，插在最后一条已认领消息之后。

`paths` 存在但既不是字符串也不是列表 → 跳过并告警；超过 `maxSourceBytes` 的文件跳过。规则正文是不受信任输入：仅作为文本，定界标签转义，不会被执行。无文件监听：规则修改在下一步对账（全局）或下一次成功 `read`（路径规则）时生效。

| 键 | 默认 | 说明 |
|---|---|---|
| `rulesDir` | `~/.dsh/rules` | 用户级规则目录（支持 `~` 展开） |
| `maxBytes` | `65536` | 每条注入消息字节预算 |
| `maxSourceBytes` | `1048576` | 单个规则文件读取上限（超限跳过） |
| `triggerTools` | `["read"]` | 触发匹配的工具名列表 |
| `rulesDirProject` | `false` | 是否扫描 `<项目根>/.dsh/rules` 与 `<项目根>/.claude/rules` |

## 仓库结构

```
dsh-rules-paths/
├── package.json        # dsh.bundle.patch manifest
├── cordis.patch.yml    # 组合层：把插件追加进 profile bundles
├── lib/
│   ├── index.js        # Host 半：规则加载、匹配、注入
│   └── types/index.d.ts
├── test/
│   └── index.mjs       # 50 项断言测试
├── README.md
├── README.zh.md
└── LICENSE
```

## 开发

```bash
npm install   # 拉取 devDependencies（peers + js-yaml + picomatch）
npm test      # node test/index.mjs — 50 项断言
```

测试覆盖：Config 校验、frontmatter 解析、预算渲染（省略/截断/转义）、消息构造、去重与 `replace`、零注入、全局规则、项目规则（`.dsh/rules` + `.claude/rules`）、pre-step 折叠位置。

## License

[MIT](LICENSE)
