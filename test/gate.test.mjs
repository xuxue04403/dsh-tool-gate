/**
 * dsh-tool-gate 单元测试（不依赖宿主，纯 node 跑）
 *
 *   node test/gate.test.mjs
 *
 * 思路：用假的 ctx 模拟 ToolsService —— 关键只有 resolve(context)，
 * 它返回 { dispose, view(scope) }，view 给出本步可下发的工具名。
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const pluginPath = new URL('../lib/index.js', import.meta.url).href
const { apply } = await import(pluginPath)

const SESSION = { id: 'test-session' }

/** 造一个最小可用的 ToolsService 替身。 */
class FakeToolsService {
  constructor(names) {
    this.names = names
  }

  async resolve(_context) {
    const visible = new Map(this.names.map((n) => [n, { name: n }]))
    return { dispose: () => {}, view: () => new Map(visible) }
  }

  view(_scope) {
    return { visible: new Map(this.names.map((n) => [n, { name: n }])) }
  }

  register(_definition, _options) {}
}

function makeCtx(names, cwd) {
  const tools = new FakeToolsService(names)
  return {
    tools,
    workingDirectory: { get: (session) => (session === SESSION ? cwd : undefined) },
  }
}

async function visibleTools(tools, context = { agent: { session: SESSION } }) {
  const selection = await tools.resolve(context)
  return [...selection.view(context.agent).keys()]
}

const TOOLS = ['fin_quote', 'fin_backtest', 'todos_list', 'web_fetch', 'astock_kline']
let pass = 0
let fail = 0
function check(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    pass++
    console.log(`PASS  ${label}  → ${a}`)
  } else {
    fail++
    console.log(`FAIL  ${label}\n      期望 ${e}\n      实际 ${a}`)
  }
}

const root = mkdtempSync(join(tmpdir(), 'gate-'))
const proj = join(root, 'proj')
const sub = join(proj, 'sub')
mkdirSync(join(proj, '.dsh'), { recursive: true })
mkdirSync(sub, { recursive: true })

const writeRules = (mode, allow = [], deny = []) =>
  writeFileSync(join(proj, '.dsh', 'tool-gate.json'), JSON.stringify({ mode, allow, deny }))

// 1. 没有规则文件 → 兜底 off，全放行
{
  const ctx = makeCtx(TOOLS, join(root, 'empty-proj'))
  mkdirSync(join(root, 'empty-proj'), { recursive: true })
  apply(ctx, { mode: 'off' })
  check('无规则文件回落到 off（全放行）', await visibleTools(ctx.tools), TOOLS)
}

// 2. mode=allow + 前缀通配
{
  writeRules('allow', ['fin_*'])
  const ctx = makeCtx(TOOLS, proj)
  apply(ctx, {})
  check('allow 前缀通配', await visibleTools(ctx.tools), ['fin_quote', 'fin_backtest'])
}

// 3. mode=deny + 前缀通配
{
  writeRules('deny', [], ['todos_*', 'web_fetch'])
  const ctx = makeCtx(TOOLS, proj)
  apply(ctx, {})
  check('deny 前缀通配', await visibleTools(ctx.tools), ['fin_quote', 'fin_backtest', 'astock_kline'])
}

// 4. 子目录继承父级规则
{
  writeRules('allow', ['astock_*'])
  const ctx = makeCtx(TOOLS, sub)
  apply(ctx, {})
  check('子目录继承父级规则', await visibleTools(ctx.tools), ['astock_kline'])
}

// 5. mode=off 时不动任何工具
{
  writeRules('off')
  const ctx = makeCtx(TOOLS, proj)
  apply(ctx, {})
  check('mode=off 不干预', await visibleTools(ctx.tools), TOOLS)
}

// 6. tool_gate_status 自己永不被门控
{
  writeRules('allow', [])
  const ctx = makeCtx([...TOOLS, 'tool_gate_status'], proj)
  apply(ctx, {})
  check('tool_gate_status 不被门控', await visibleTools(ctx.tools), ['tool_gate_status'])
}

// 7. 坏 JSON 不炸，回落 profile 兜底
{
  writeFileSync(join(proj, '.dsh', 'tool-gate.json'), '{ this is not json')
  const ctx = makeCtx(TOOLS, proj)
  apply(ctx, { mode: 'off' })
  check('坏 JSON 回落兜底（全放行）', await visibleTools(ctx.tools), TOOLS)
}

// 8. 改规则文件后立即生效（不需要重启）
{
  writeRules('allow', ['fin_*'])
  const ctx = makeCtx(TOOLS, proj)
  apply(ctx, {})
  const before = await visibleTools(ctx.tools)
  writeRules('allow', ['todos_*'])
  const after = await visibleTools(ctx.tools)
  check('改规则即时生效', [before, after], [['fin_quote', 'fin_backtest'], ['todos_list']])
}

// 9. always 名单里的工具不受 deny 影响
{
  writeRules('deny', [], ['*'])
  const ctx = makeCtx(TOOLS, proj)
  apply(ctx, { always: ['web_fetch'] })
  check('always 白名单绕过', await visibleTools(ctx.tools), ['web_fetch'])
}

// 10. 启动之后才创建规则文件，也要生效（不再缓存「没有规则文件」这个结论）
{
  const late = join(root, 'late-proj')
  mkdirSync(join(late, '.dsh'), { recursive: true })
  const ctx = makeCtx(TOOLS, late)
  apply(ctx, {})
  const before = await visibleTools(ctx.tools)
  writeFileSync(
    join(late, '.dsh', 'tool-gate.json'),
    JSON.stringify({ mode: 'allow', allow: ['web_*'] }),
  )
  const after = await visibleTools(ctx.tools)
  check('后加规则文件即时生效', [before.length, after], [TOOLS.length, ['web_fetch']])
}

// 11. tool_gate_status 汇报的数字与真实装配一致
{
  writeRules('deny', [], ['todos_*'])
  const ctx = makeCtx([...TOOLS, 'tool_gate_status'], proj)
  let captured
  ctx.tools.register = (definition) => {
    captured = definition
  }
  apply(ctx, {})
  const selection = await ctx.tools.resolve({ agent: { session: SESSION } })
  selection.view({})
  const value = await captured.execute({}, { agent: { session: SESSION } })
  check('status 数字与装配一致', [value.known, value.visible, value.hidden], [6, 5, ['todos_list']])
}

rmSync(root, { recursive: true, force: true })

console.log(`\n${pass}/${pass + fail} 通过`)
process.exit(fail === 0 ? 0 : 1)
