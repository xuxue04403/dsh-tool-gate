# dsh-tool-gate

按**项目**门控 DeepSeek Harness 的工具集合：当前项目不需要的工具，其定义不会在每一步随请求下发，
从而缩小每步上下文、加快首个 token、降低长会话成本。

- 规则文件放在项目里：`.dsh/tool-gate.json`
- 三种模式：`off`（默认，零影响）/ `allow`（白名单）/ `deny`（黑名单）
- 规则支持 `前缀*` 通配，从会话目录向上查找，子目录继承父目录
- 改规则文件**即时生效**，不需要重启会话
- 自带 `tool_gate_status` 工具，可随时自查「现在屏蔽了哪些工具」

## 为什么

dsh 每一步（`preStep`）都会把「可见且 `when` 成立」的工具全量装配进请求。第三方插件几乎都不声明
`when`，于是装多少就每步发多少 —— 插件一多，每步的 tool schema 就把上下文吃掉一大截。

本插件在 `ToolsService.resolve()`（每步装配的唯一入口）外面包一层，按项目规则裁剪返回的工具集合。
因为拦在装配口而不是注册口，它和「插件是谁、什么时候注册的」无关，不存在顺序问题。

## 安装

前置：dsh ≥ `0.2.2-rc.0`；已有一个 profile（`~/.dsh/profiles/<name>`）。

```powershell
# 在解压后的插件目录里执行
pwsh -File .\install.ps1 -Profile quant
```

脚本做三件事：

1. 把插件复制到 `<profile>/vendor/dsh-tool-gate`
2. `dsh plugin --profile <profile> add file:vendor/dsh-tool-gate`
3. 把 `dsh-tool-gate` 写进 `<profile>/package.json` 的 `dsh.profile.bundles`，位置紧跟 `@deepseek-ai/dsh-base`

> 为什么不用 `npm i`：宿主只加载出现在 `dsh.profile.bundles` 里的包；直接 `dsh plugin add` 只会装成依赖，
> 图层不生效。且 `file:` 依赖指向 profile 之外时会静默不加载，所以必须落在 `vendor/` 里。

### 桌面客户端（DeepSeek Harness Desktop）

桌面端**只认 `~/.dsh/profiles/desktop`**（源码里写死：`resolveDesktopPaths()` → `join(dshHome,"profiles","desktop")`），
没有 profile 选择入口，`dsh --profile desktop` 也会被拒绝（`profile "desktop" is managed exclusively by the Electron application`）。

所以装到 `desktop`：

```powershell
pwsh -File .\install.ps1 -Profile desktop
```

这一步不起 pnpm，只做：复制到 `profiles/desktop/vendor/dsh-tool-gate` → 在 `profiles/desktop/node_modules`
建一个目录联接 → 写进 `desktop` 的 `dsh.profile.bundles`。然后**完全退出并重开**桌面端（插件在启动时加载）。

挂上之后，「按项目自动裁剪工具」就不需要任何命令或切换动作了：

```text
D:\quant-lab\.dsh\tool-gate.json   -> 量化项目只下发 fin_*/astock_* 等
D:\IDE\dsh\.dsh\tool-gate.json     -> 开发项目去掉 trading_* 等
（没有规则文件的项目）              -> off，一切照旧
```

卸载：`pwsh -File .\install.ps1 -Profile desktop -Uninstall`。

安装后重启 dsh（补丁层在启动时加载）。想确认装载成功：

```powershell
$env:DSH_TOOL_GATE_DEBUG='1'
dsh --profile quant        # stderr 应出现: [tool-gate] applied, enabled=true, mode=off
```

## 使用

在项目根建规则文件：

```powershell
New-Item -ItemType Directory -Force .dsh | Out-Null
'{"mode":"allow","allow":["fin_*","astock_*","web_fetch","web_search"]}' |
  Set-Content .dsh/tool-gate.json -Encoding utf8
```

```json
{
  "mode": "deny",
  "allow": [],
  "deny": ["todos_*", "market_*"]
}
```

| 字段 | 说明 |
|---|---|
| `mode` | `off` 全放行（默认）；`allow` 只有命中的下发；`deny` 命中的不下发 |
| `allow` / `deny` | 工具名数组，支持精确名与 `前缀*` |
| 找不到规则文件 | 回落到 profile 配置里的兜底规则（默认 `off`） |

会话中随时自查：

> 调用 `tool_gate_status`，看 `hidden` 列表。

输出形如：

```json
{
  "cwd": "D:\\quant-lab",
  "mode": "allow",
  "source": "D:\\quant-lab\\.dsh\\tool-gate.json",
  "known": 32,
  "visible": 8,
  "hidden": ["read", "write", "edit", "shell", "subagent", "..."]
}
```

### 典型组合

| 场景 | 规则 |
|---|---|
| 量化研究项目 | `allow: ["fin_*", "astock_*", "backtest_*"]` |
| 日常写代码 | `deny: ["trading_*", "market_*", "pet_*"]` |
| 只想安静聊天 | `allow: ["web_fetch", "web_search"]` |

## 配置项（profile 级）

在 `<profile>/cordis.patch.yml` 里改 `tool-gate` 那一行：

```yaml
- id: tool-gate
  name: dsh-tool-gate
  config:
    enabled: true
    file: .dsh/tool-gate.json   # 规则文件相对路径
    mode: off                   # 没有规则文件时的兜底
    allow: []
    deny: []
    always: []                  # 永不门控的工具
    log: false                  # true = 每次装配打印判定结果
```

## 卸载

```powershell
pwsh -File .\install.ps1 -Profile quant -Uninstall
```

## 已知边界

- 只影响「本步下发给模型的工具集合」，不改注册、不改历史会话记录；被屏蔽的工具当步不可调用，放开后立刻恢复。
- 只包住 profile 级 `ToolsService`；同一 profile 内所有会话共用这套规则（按各自工作目录解析）。
- 每步都重新向上查找并读取规则文件：**增删改规则都是即时生效的**（只是每次多几十次 `stat`，可忽略）。

## 开发

```powershell
node test/gate.test.mjs        # 11 个用例，纯 node，不需要 dsh
pwsh -File .\sync.ps1          # 改完代码同步到 quant / dev / desktop
```

`sync.ps1` 里那句 `remove` + `add` 是必须的：pnpm 对 `file:` 依赖是**复制**且 spec 不变时不会重新复制，
只覆盖 `vendor/` 目录不会生效。

## License

MIT
