/**
 * 技能（skill）：把固化下来的网页操作流程存成一份 JSON，下次只填参数直接跑。
 *
 * 设计目标（水水 2026-11-19）：
 * 「我想要调用 gpt 网页去生成一个图片，除了提示词输入需要自定义，其他的操作
 *  （新建对话、点击发送按钮）都是比较固化的操作，我希望能把固化操作尽可能
 *  做成一个功能保存，能快速调用，不需要每一次都让 agent 去重新思考，
 *  看到保存的功能就知道接下来的操作。」
 *
 * 所以：
 * - 技能存盘 → 模型通过 edge_skill list 一眼看到「有这个功能、要传什么参数」；
 * - 执行时走纯代码，不经过模型思考，一步不差地重放；
 * - 步骤只允许引用「语义选择器」（text/role/placeholder/css），不写死 ref，
 *   因为 ref 每次 observe 都会重编；
 * - 变量用 {{param}} 占位，运行前替换。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const SKILL_EXT = '.json'

export function defaultSkillsDir(config) {
  return config.skillsDir || join(homedir(), '.dsh', 'edge-pilot', 'skills')
}

/** 技能名只允许安全字符，顺带挡住 ../ 这类路径穿越。 */
export function safeSkillName(name) {
  const clean = String(name || '').trim()
  if (!clean) throw new Error('技能名不能为空')
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(clean)) {
    throw new Error(`技能名 "${clean}" 不合法：只能用字母数字和 . _ -，且以字母数字开头`)
  }
  return clean
}

function skillPath(config, name) {
  return join(defaultSkillsDir(config), safeSkillName(name) + SKILL_EXT)
}

export function listSkills(config) {
  const dir = defaultSkillsDir(config)
  if (!existsSync(dir)) return []
  const out = []
  for (const fileName of readdirSync(dir)) {
    if (!fileName.endsWith(SKILL_EXT)) continue
    try {
      const def = JSON.parse(readFileSync(join(dir, fileName), 'utf8'))
      out.push({ ...def, name: def.name || fileName.slice(0, -SKILL_EXT.length) })
    } catch {
      /* 坏文件跳过，不阻塞其它技能 */
    }
  }
  return out.sort((a, b) => String(a.name).localeCompare(String(b.name)))
}

export function loadSkill(config, name) {
  const path = skillPath(config, name)
  if (!existsSync(path)) {
    const known = listSkills(config).map((s) => s.name)
    throw new Error(`技能 "${name}" 不存在。现有技能：${known.length ? known.join(', ') : '（无）'}`)
  }
  const def = JSON.parse(readFileSync(path, 'utf8'))
  def.name = def.name || safeSkillName(name)
  if (!Array.isArray(def.steps) || def.steps.length === 0) {
    throw new Error(`技能 "${name}" 没有定义 steps`)
  }
  return def
}

export function saveSkill(config, name, definition) {
  const clean = safeSkillName(name)
  const dir = defaultSkillsDir(config)
  mkdirSync(dir, { recursive: true })
  const def = {
    name: clean,
    description: String(definition.description || ''),
    params: definition.params || {},
    steps: Array.isArray(definition.steps) ? definition.steps : [],
    createdAt: definition.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  if (def.steps.length === 0) throw new Error('保存技能失败：steps 不能为空')
  writeFileSync(skillPath(config, clean), JSON.stringify(def, null, 2), 'utf8')
  return def
}

export function removeSkill(config, name) {
  const path = skillPath(config, name)
  if (!existsSync(path)) throw new Error(`技能 "${name}" 不存在`)
  rmSync(path, { force: true })
  return { removed: name }
}

/** {{param}} / {{var.xxx}} 替换。找不到的变量替换成空串并记一笔。 */
function render(template, vars, missing) {
  return String(template == null ? '' : template).replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_m, key) => {
    const value = key.split('.').reduce((obj, part) => (obj == null ? obj : obj[part]), vars)
    if (value == null) {
      if (missing) missing.add(key)
      return ''
    }
    return String(value)
  })
}

/** 语义选择器 → Playwright locator。技能里不写 ref，避免快照失效。 */
function pickLocator(page, step) {
  if (step.css) return page.locator(step.css).first()
  if (step.placeholder) return page.getByPlaceholder(step.placeholder, { exact: false }).first()
  if (step.role) return page.getByRole(step.role, step.name ? { name: step.name } : {}).first()
  if (step.label) return page.getByLabel(step.label, { exact: false }).first()
  if (step.text) return page.getByText(step.text, { exact: Boolean(step.exact) }).first()
  // 兼容：允许技能里直接用 ref（仅当同一次 observe 内有效）
  if (step.ref) return page.locator(`[data-dsh-ref="${step.ref}"]`).first()
  return null
}

function describeLocator(step) {
  if (step.css) return `css=${step.css}`
  if (step.placeholder) return `placeholder=${step.placeholder}`
  if (step.role) return `role=${step.role}${step.name ? `[name=${step.name}]` : ''}`
  if (step.label) return `label=${step.label}`
  if (step.text) return `text=${step.text}`
  if (step.ref) return `ref=${step.ref}`
  return '(未指定选择器)'
}

/**
 * 校验并补齐参数：必填缺失直接报错，可选给默认值。
 */
function resolveArgs(def, rawArgs) {
  const vars = {}
  const missing = []
  for (const [key, spec] of Object.entries(def.params || {})) {
    let value = rawArgs ? rawArgs[key] : undefined
    if (value == null || value === '') {
      if (spec && spec.default !== undefined) {
        value = spec.default
      } else if (spec && spec.required) {
        missing.push(key)
        continue
      }
    }
    if (value !== undefined && value !== null) vars[key] = value
  }
  if (missing.length) {
    const shape = Object.entries(def.params || {})
      .map(([k, s]) => `${k}${s && s.required ? '(必填)' : ''}`)
      .join(', ')
    throw new Error(`技能 "${def.name}" 缺少必填参数：${missing.join(', ')}。可用参数：${shape || '（无）'}`)
  }
  return vars
}

function defaultTimeout(config, step) {
  return Number(step.timeoutMs) || Number(config.actionTimeoutMs) || 15000
}

async function runStep(page, session, config, step, vars, ctx, missing) {
  const timeout = defaultTimeout(config, step)
  // 渲染模板时把未解析的变量记进 missing，便于事后告警（不是致命错误）。
  const r = (template) => render(template, vars, missing)
  switch (step.action) {
    case 'goto': {
      const url = r(step.url)
      if (!url) throw new Error('goto 步骤缺少 url')
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.navTimeoutMs })
      return { url: page.url(), status: response ? response.status() : 'n/a' }
    }
    case 'wait': {
      const deadline = Date.now() + timeout
      if (!step.urlContains && !step.textContains && !step.selector && !step.titleContains) {
        const ms = Number(step.ms) || 1000
        await page.waitForTimeout(ms)
        return { waitedMs: ms }
      }
      while (Date.now() < deadline) {
        if (step.selector) {
          const hit = await page.locator(r(step.selector)).count().catch(() => 0)
          if (hit > 0) return { matched: `selector=${step.selector}` }
        }
        if (step.urlContains) {
          const want = r(step.urlContains)
          if (page.url().includes(want)) return { matched: `url 包含 ${want}` }
        }
        if (step.titleContains) {
          const want = r(step.titleContains)
          const title = await page.title().catch(() => '')
          if (title.includes(want)) return { matched: `标题包含 ${want}` }
        }
        if (step.textContains) {
          const want = r(step.textContains)
          const found = await page
            .evaluate((needle) => (document.body ? document.body.innerText.includes(needle) : false), want)
            .catch(() => false)
          if (found) return { matched: `正文包含 ${want}` }
        }
        await page.waitForTimeout(250)
      }
      if (step.optional) return { skipped: '等待超时（步骤标了 optional，继续）' }
      throw new Error(
        `等待超时（${timeout}ms）：条件 ${JSON.stringify({
          urlContains: step.urlContains,
          titleContains: step.titleContains,
          textContains: step.textContains,
          selector: step.selector,
        })}；当前 url=${page.url()} title=${await page.title().catch(() => '')}`,
      )
    }
    case 'click': {
      const locator = pickLocator(page, step)
      if (!locator) throw new Error('click 步骤需要 text/role/css/placeholder/label/ref 之一')
      await locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {})
      await locator.click({ timeout })
      await page.waitForTimeout(Number(step.settleMs) || 350)
      return { clicked: describeLocator(step), url: page.url() }
    }
    case 'type': {
      const locator = pickLocator(page, step)
      if (!locator) throw new Error('type 步骤需要 text/role/css/placeholder/label 之一')
      const value = r(step.text)
      await locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {})
      try {
        await locator.click({ timeout: 8000 })
      } catch {
        /* contenteditable 偶发点不动，直接 fill 兜底 */
      }
      if (step.perChar) {
        if (step.clear !== false) await locator.fill('')
        await locator.pressSequentially(value, { delay: Number(step.delayMs) || 40 })
      } else {
        await locator.fill(step.clear === false ? (await locator.inputValue().catch(() => '')) + value : value)
      }
      if (step.enter) await page.keyboard.press('Enter')
      await page.waitForTimeout(Number(step.settleMs) || 250)
      return { typed: value.length, enter: Boolean(step.enter) }
    }
    case 'press': {
      const key = r(step.key)
      if (!key) throw new Error('press 步骤缺少 key')
      await page.keyboard.press(key)
      await page.waitForTimeout(200)
      return { key }
    }
    case 'scroll': {
      const dy = Number(step.dy ?? 700)
      await page.mouse.move(Number(step.x) || 720, Number(step.y) || 450)
      await page.mouse.wheel(Number(step.dx) || 0, dy)
      await page.waitForTimeout(350)
      return { dy }
    }
    case 'sleep': {
      const ms = Number(step.ms) || 1000
      await page.waitForTimeout(ms)
      return { sleptMs: ms }
    }
    case 'screenshot': {
      const target = r(step.path) || join(config.downloadsDir, `skill-${Date.now()}.png`)
      mkdirSync(target.replace(/[\\/][^\\/]+$/, ''), { recursive: true })
      const locator = step.css || step.text ? pickLocator(page, step) : null
      const buffer = locator
        ? await locator.screenshot({ type: 'png' })
        : await page.screenshot({ fullPage: step.fullPage !== false, type: 'png' })
      writeFileSync(target, buffer)
      ctx.outputs.push({ type: 'image', path: target })
      return { path: target }
    }
    case 'extract': {
      const locator = pickLocator(page, step)
      if (!locator) throw new Error('extract 步骤需要 text/role/css 之一')
      const value = step.attr
        ? await locator.getAttribute(String(step.attr), { timeout }).catch(() => '')
        : await locator.innerText({ timeout }).catch(() => '')
      const as = String(step.as || 'value')
      ctx.vars[as] = value
      if (step.maxLength && typeof value === 'string' && value.length > Number(step.maxLength)) {
        ctx.vars[as] = value.slice(0, Number(step.maxLength))
      }
      return { [as]: ctx.vars[as] }
    }
    case 'eval': {
      const code = r(step.code)
      const value = await page.evaluate(code)
      const as = String(step.as || 'value')
      ctx.vars[as] = value
      return { [as]: typeof value === 'string' ? value.slice(0, 500) : value }
    }
    case 'download': {
      const since = Date.now()
      if (step.triggerText) {
        await page.getByText(r(step.triggerText), { exact: false }).first().click({ timeout })
      } else if (step.ref) {
        await page.locator(`[data-dsh-ref="${step.ref}"]`).first().click({ timeout })
      } else {
        throw new Error('download 步骤需要 triggerText 或 ref')
      }
      const deadline = Date.now() + timeout
      while (Date.now() < deadline) {
        const hit = session.downloads.find((item) => item.at >= since)
        if (hit) {
          ctx.outputs.push({ type: 'file', path: hit.path })
          return { path: hit.path, name: hit.name }
        }
        await page.waitForTimeout(250)
      }
      throw new Error(`download 步骤等待 ${timeout}ms 仍未落盘`)
    }
    case 'closeTab': {
      const pages = session.context ? session.context.pages() : []
      if (pages.length > 1) {
        await page.close().catch(() => {})
        const rest = session.context.pages()
        session.activePage = rest[rest.length - 1] || null
      }
      return { tabs: session.context ? session.context.pages().length : 0 }
    }
    default:
      throw new Error(`不支持的 action：${step.action}`)
  }
}

/**
 * 跑一个技能。返回逐步结果，失败时抛错并带上「第几步、哪个动作」。
 */
export async function runSkill(session, config, name, rawArgs, logger) {
  const def = loadSkill(config, name)
  const vars = resolveArgs(def, rawArgs)
  const ctx = { vars: {}, outputs: [] }
  await session.requirePage()
  const missing = new Set()
  const trace = []

  for (let i = 0; i < def.steps.length; i += 1) {
    const step = def.steps[i]
    if (!step || !step.action) throw new Error(`技能 "${name}" 第 ${i + 1} 步缺少 action`)
    const label = `第 ${i + 1} 步（${step.action}${step.description ? '：' + step.description : ''}）`
    try {
      // 每步重新取当前页：上一步可能关掉标签、或被 target=_blank 换了现场。
      const page = await session.requirePage()
      // 每步都把变量表重算一次，让 extract 出来的值能被后续步骤引用
      const merged = { ...vars, ...ctx.vars, var: ctx.vars }
      const result = await runStep(page, session, config, step, merged, ctx, missing)
      trace.push({ step: i + 1, action: step.action, ok: true, result })
      if (!step.optional) logger?.debug?.(`[dsh-edge-pilot] ${name} ${label} ok`)
    } catch (error) {
      trace.push({ step: i + 1, action: step.action, ok: false, error: String(error?.message || error) })
      if (step.optional) {
        trace[trace.length - 1].ok = true
        trace[trace.length - 1].skipped = true
        continue
      }
      const err = new Error(
        `技能 "${name}" 在 ${label} 失败：${error?.message || error}\n用 edge_skill action=show name=${name} 看定义；` +
          `如果页面结构变了，用 edge_observe 看清现状再修技能。`,
      )
      err.trace = trace
      throw err
    }
  }

  const lastPage = session.currentPage()
  return {
    name,
    ok: true,
    steps: trace.length,
    url: lastPage ? lastPage.url() : '',
    outputs: ctx.outputs,
    vars: ctx.vars,
    missingVars: [...missing],
    trace,
  }
}

/** 给模型看的一行摘要：看到就知道这个技能能干什么、要传什么参数。 */
export function describeSkill(def) {
  const params = Object.entries(def.params || {})
  const paramText = params.length
    ? params
        .map(([key, spec]) => {
          const bits = []
          if (spec && spec.required) bits.push('必填')
          if (spec && spec.type) bits.push(spec.type)
          if (spec && spec.description) bits.push(spec.description)
          return `${key}${bits.length ? '(' + bits.join(', ') + ')' : ''}`
        })
        .join(' | ')
    : '无'
  return `${def.name} — ${def.description || '(无描述)'}\n  参数：${paramText}\n  ${def.steps ? def.steps.length : 0} 步`
}