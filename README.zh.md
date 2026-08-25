# dsh-rules-paths

面向 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 的 Claude Code 风格 `paths:` 规则注入插件：模型**成功 `read`** 到命中规则 `paths:` glob 的文件后，规则正文在**下一步边界**注入模型上下文。机制与官方 `@deepseek-ai/dsh-agent-instructions` 同构（`tools/result` 挂钩、`agent.inbox.nextStep` 收件箱、`agent/pre-step` 折叠、SHA-1 去重、字节预算）。

## 功能

- **按 preset 启用，opt-in**——插件**不挂到 profile 级**。只有引用它的 agent preset 才会激活；DSH 随附的四个 preset（`standard` / `code` / `minimal` / `cordis`）一律不加载。**只有会话选用的 preset 携带那一行**才会注入规则。
- **路径规则**——规则文件用 `paths:` 声明 glob；成功 `read` 命中文件后，在下一步边界注入规则正文。
- **全局规则**——没有 `paths`（或完全没有 frontmatter）的规则，在会话**第一个进入的 step** 即注入，不依赖任何文件读取（时机同 `AGENTS.md`）。
- **项目级规则**——可选扫描 `<项目根>/.dsh/rules` **和** `<项目根>/.claude/rules`（Claude Code 约定），以 `.git` 标记项目根。
- **去重与预算**——同一规则每会话只注入一次，内容变化时以 `replace` 更新；注入消息恒不超过 `maxBytes`，省略/截断时给出 `Rules budget …` 提示。
- **指导，不是强制**——注入内容是 user 角色消息，不覆盖 system/developer/用户直接指令；字面 `</system-reminder>` 会被转义。

## 安装

> 需要 DSH 0.1.0-rc.x（Web profile）。

插件不挂到 profile 级。装包分两件独立的事：(1) 把包装到 DSH 能解析的位置；(2) 在用户 preset 里主动启用。`dsh plugin --profile web add` 仍可装包，但**不会**再把插件挂到任何位置——挂载必须由 preset row 完成。

### 第一步——装包

```bash
dsh plugin --profile web add git+https://github.com/Temoa/dsh-rules-paths.git
```

或本地 checkout 迭代：

```bash
# 在 profile 目录下（典型是 ~/.dsh/profiles/web）
pnpm add ./path/to/dsh-rules-paths
```

包会落到 `node_modules/@temoa/dsh-rules-paths/`，但**不会**激活——既没有 preset 引用它，manifest 也不再声明 bundle patch。

### 第二步——在自己创建的 preset 里启用

随附 preset 是只读的，所以先复制一份。在 Web UI 里打开 **Settings → Agent Presets**，对 `standard`（或任何其他随附 preset）使用复制对话框得到新 preset。然后在新 preset 的 `agent.cordis.yml` 末尾加这一行：

```yaml
- id: rules-paths
  name: '@temoa/dsh-rules-paths'
  config:
    rulesDir: "~/.dsh/rules"
    rulesDirProject: true
```

重启 DSH，把新 preset 选给一个**空白**会话（DSH 锁定已产出内容的会话以防切换），插件才会生效。其他走随附 preset 的会话照旧不挂载。

> **编辑 preset 后必须重启 harness**：preset **配置**每次挂载重读，但插件**文件**按 URL 在进程内缓存；规则文件本身永远不用重启。

## 卸载

```bash
dsh plugin --profile web remove @temoa/dsh-rules-paths
```

然后打开用户 preset 的 `agent.cordis.yml`，删掉 `- id: rules-paths` 整块。重启 DSH 即可。`~/.dsh/rules` 与项目规则目录下的文件均原样保留。

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
├── package.json        # manifest
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
pnpm install   # 或 npm install ——拉取 devDependencies（peers + js-yaml + picomatch）
pnpm test      # node test/index.mjs —— 50 项断言
```

测试覆盖：Config 校验、frontmatter 解析、预算渲染（省略/截断/转义）、消息构造、去重与 `replace`、零注入、全局规则、项目规则（`.dsh/rules` + `.claude/rules`）、pre-step 折叠位置。

## License

[MIT](LICENSE)
