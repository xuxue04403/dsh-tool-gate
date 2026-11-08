/**
 * dsh-tool-gate —— 项目级工具门控（按项目裁剪每步下发的工具，降低请求体积）
 *
 * 背景：dsh 在每个 preStep 都会把「可见且 when 成立」的工具全量装配进请求
 * （dsh-agent-loop 的 preStep → tools.resolve → systemPrompt.assemble）。
 * 第三方插件注册工具时通常不声明 `when`，于是装多少就每步发多少。
 *
 * 做法：包装 `ToolsService.resolve(context)` —— 每一步装配的唯一入口，
 * 与「插件是谁、什么时候注册的」无关，因此不存在注册顺序问题。
 * 规则来自**当前会话工作目录**向上找到的 `.dsh/tool-gate.json`：
 *
 *   { "mode": "allow", "allow": ["fin_*", "astock_*"], "deny": ["web_*"] }
 *
 *   mode = off   全部放行（默认，零影响）
 *   mode = allow 只有 allow 命中的工具进入 prompt
 *   mode = deny  deny 命中的工具不进入 prompt，其余照常
 *
 * 命中规则支持精确名与 `前缀*` 通配。每步都重新向上查找并读取规则文件，
 * 因此「加规则、改规则、删规则」都是即时生效的，不需要重启。
 *
 * 边界：只影响「本步下发给模型的工具集合」，不改变工具注册与历史会话记录。
 * 本插件不依赖任何第三方包（连 @deepseek-ai/schemastery 都不用），
 * 因此放在 profile 的 vendor/ 目录里即可加载。
 */

import { readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'

export const name = 'tool-gate'
export const inject = ['tools', 'workingDirectory']

const PATCHED = Symbol.for('dsh-tool-gate.patched')

const match = (pattern, toolName) =>
  pattern.endsWith('*') ? toolName.startsWith(pattern.slice(0, -1)) : pattern === toolName

/** 从目录向上找规则文件路径；找不到返回 undefined。 */
function findRulesPath(startDir, relFile) {
  let dir = startDir
  for (let i = 0; i < 32 && dir; i++) {
    const candidate = join(dir, relFile)
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // 不存在：继续向上
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/** 读一次规则文件；内容坏了就返回 undefined，不让门控把会话搞挂。 */
function readRules(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return {
      mode: ['off', 'allow', 'deny'].includes(parsed.mode) ? parsed.mode : 'off',
      allow: Array.isArray(parsed.allow) ? parsed.allow.filter((x) => typeof x === 'string') : [],
      deny: Array.isArray(parsed.deny) ? parsed.deny.filter((x) => typeof x === 'string') : [],
    }
  } catch {
    return undefined
  }
}

const strArray = (value) => (Array.isArray(value) ? value.filter((x) => typeof x === 'string') : [])

export function apply(ctx, config) {
  try {
    setup(ctx, config)
  } catch (error) {
    // 门控插件绝不能让宿主起不来：任何异常都退化成「不门控」。
    process.stderr.write(`[tool-gate] disabled after error: ${error?.message ?? error}\n`)
  }
}

function setup(ctx, config) {
  const enabled = config?.enabled !== false
  if (process.env.DSH_TOOL_GATE_DEBUG) {
    process.stderr.write(
      `[tool-gate] applied, enabled=${enabled}, mode=${config?.mode ?? 'off'}\n`,
    )
  }
  if (!enabled) return

  const fallback = {
    mode: ['off', 'allow', 'deny'].includes(config?.mode) ? config.mode : 'off',
    allow: strArray(config?.allow),
    deny: strArray(config?.deny),
    source: '(profile config)',
  }
  const always = new Set(['tool_gate_status', ...strArray(config?.always)])
  const relFile = typeof config?.file === 'string' && config.file ? config.file : '.dsh/tool-gate.json'
  const log = config?.log === true

  /** 每步重新查找 + 重读：规则文件增删改都即时生效。 */
  const rulesFor = (cwd) => {
    if (!cwd) return fallback
    const path = findRulesPath(cwd, relFile)
    const rules = path ? readRules(path) : undefined
    return rules ? { ...rules, source: path } : fallback
  }

  /** 从 resolve 的 context（或工具执行上下文）里取会话工作目录。 */
  const cwdOf = (context) => {
    try {
      const session = context?.agent?.session
      if (session === undefined) return process.cwd()
      return ctx.workingDirectory.get(session) ?? process.cwd()
    } catch {
      return process.cwd()
    }
  }

  /** 给定规则，判断某工具本步是否下发。 */
  const evaluate = (toolName, rules) => {
    if (always.has(toolName)) return true
    if (rules.mode === 'allow') return rules.allow.some((p) => match(p, toolName))
    if (rules.mode === 'deny') return !rules.deny.some((p) => match(p, toolName))
    return true
  }

  // 最近一次装配的判定结果，供 tool_gate_status 如实汇报。
  const lastDecision = new Map()

  // 在「服务实例」上打补丁（而不是原型），避免同进程里多个实例互相污染。
  if (!ctx.tools[PATCHED]) {
    const originalResolve = ctx.tools.resolve
    ctx.tools[PATCHED] = true
    ctx.tools.resolve = async function resolve(context) {
      const selection = await originalResolve.call(this, context)
      const cwd = cwdOf(context)
      const rules = rulesFor(cwd)
      const key = context?.agent?.session ?? '(none)'
      if (rules.mode === 'off') {
        lastDecision.set(key, { cwd, mode: 'off', source: rules.source, kept: undefined, hidden: [] })
        return selection
      }
      const dropped = new Set()
      let kept
      const view = (scope) => {
        const visible = selection.view(scope)
        for (const toolName of [...visible.keys()]) {
          if (!evaluate(toolName, rules)) {
            visible.delete(toolName)
            dropped.add(toolName)
          }
        }
        kept = visible.size
        return visible
      }
      const filtered = {
        ...selection,
        view: (scope) => {
          const visible = view(scope)
          if (log) {
            process.stderr.write(
              `[tool-gate] step: mode=${rules.mode} kept=${visible.size} hidden=[${[...dropped].join(',')}] src=${rules.source}\n`,
            )
          }
          return visible
        },
      }
      // 宿主可能只调用一次 view()，也可能多次；判定结果在出现后立刻记账。
      const record = () => {
        lastDecision.set(key, {
          cwd,
          mode: rules.mode,
          source: rules.source,
          kept,
          hidden: [...dropped],
        })
      }
      const originalView = filtered.view
      filtered.view = (scope) => {
        const visible = originalView(scope)
        record()
        return visible
      }
      return filtered
    }
  }

  ctx.tools.register({
    name: 'tool_gate_status',
    description: '查看当前会话生效的工具门控规则：模式、规则来源、被放行/屏蔽的工具数。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute(_args, execCtx) {
      const cwd = cwdOf(execCtx)
      const rules = rulesFor(cwd)
      const key = execCtx?.agent?.session ?? '(none)'
      const decision = lastDecision.get(key)
      const hidden = decision?.hidden ?? []
      return {
        cwd,
        mode: rules.mode,
        source: rules.source,
        allow: rules.allow ?? [],
        deny: rules.deny ?? [],
        known: decision?.kept === undefined ? 0 : decision.kept + hidden.length,
        visible: decision?.kept ?? 0,
        hidden,
      }
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          cwd: { type: 'string' },
          mode: { type: 'string' },
          source: { type: 'string' },
          allow: { type: 'array', items: { type: 'string' } },
          deny: { type: 'array', items: { type: 'string' } },
          known: { type: 'integer' },
          visible: { type: 'integer' },
          hidden: { type: 'array', items: { type: 'string' } },
        },
        required: ['cwd', 'mode', 'source', 'allow', 'deny', 'known', 'visible', 'hidden'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
  })
}
