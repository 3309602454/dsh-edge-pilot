/**
 * dsh-edge-pilot — 用系统自带的 Microsoft Edge 完成网页操控。
 *
 * 模型看到的是"带 ref 的元素清单"，回答的是"点 e7"，不需要写 CSS 选择器。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defaultConfig, normalizeUrl, assertDomainAllowed } from './config.js'
import { EdgeSession } from './session.js'
import { observe } from './observe.js'
import { click, typeText, pressKey, hover, scrollPage, drag, selectOption, waitForState } from './act.js'
import { saveAs, screenshot, download, tabs } from './files.js'
import { runSkill, listSkills, loadSkill, saveSkill, removeSkill, describeSkill } from './skill.js'
import {
  chatgptConfig,
  ask as chatgptAsk,
  image as chatgptImage,
  gif as chatgptGif,
  loginState as chatgptLoginState,
} from './chatgpt.js'

export const name = 'dsh-edge-pilot'
export const inject = ['tools']

const DISCIPLINE = [
  '',
  '—— 操作纪律 ——',
  '1. 动手前先 edge_observe，看清现在页面上有什么；不要凭记忆猜元素。',
  '2. 一次只做一步动作；动作后看返回的 effect，no_visible_change 就重新 observe，不要连续盲点。',
  '3. ref 只在最近一次 observe 内有效，页面变了就重新观察。',
  '4. 找不到元素时先 edge_scroll 或 edge_observe，而不是反复点同一个 ref。',
]

function fmt(value, depth = 0) {
  const lines = []
  for (const [key, item] of Object.entries(value || {})) {
    if (key.startsWith('__')) continue
    if (item == null || item === '') continue
    if (Array.isArray(item)) {
      if (item.length === 0) continue
      if (item.every((entry) => typeof entry !== 'object')) {
        lines.push(`${key}: ${item.join(', ')}`)
        continue
      }
      lines.push(`${key}:`)
      for (const entry of item) lines.push('  - ' + JSON.stringify(entry))
      continue
    }
    if (typeof item === 'object') {
      lines.push(`${key}: ${JSON.stringify(item)}`)
      continue
    }
    lines.push(`${key}: ${item}`)
  }
  return lines.join('\n')
}

function textRender(value) {
  const blocks = []
  const text = value && typeof value === 'object' && value.__text ? value.__text : fmt(value)
  blocks.push({ type: 'text', text: text || '完成' })
  if (value && value.__image) blocks.push({ type: 'image', attachment: value.__image })
  return blocks
}

const jsonOut = {
  output: {
    schema: { type: 'json' },
    render: (_args, value) => textRender(value),
  },
}

function summarizeAction(result) {
  const parts = []
  if (result.effect) parts.push(`effect: ${result.effect.type}${result.effect.detail ? ` (${result.effect.detail})` : ''}`)
  if (result.url) parts.push(`当前地址: ${result.url}`)
  if (result.title) parts.push(`标题: ${result.title}`)
  if (result.warnings && result.warnings.length) parts.push('注意: ' + result.warnings.join('；'))
  if (result.hint) parts.push('建议: ' + result.hint)
  return parts.join('\n')
}

export function apply(ctx, rawConfig = {}) {
  const settings = defaultConfig(rawConfig || {})
  const chatgpt = chatgptConfig(rawConfig ? rawConfig.chatgpt || {} : {})
  const logger = ctx?.logger || console
  let session = null

  // 每次取会话都敲一下空闲计时器：久没人用就自动回收标签页。
  // touch() 内部会先 clearTimeout 再重设，重复调用是安全的。
  const getSession = () => {
    if (!session) session = new EdgeSession(settings, logger)
    session.touch()
    return session
  }

  const getSessionTouched = getSession

  const attachImage = async (buffer, mediaType, fileName) => {
    try {
      const service = ctx?.get ? ctx.get('attachments') : null
      if (service && typeof service.saveImage === 'function') {
        return await service.saveImage({ data: buffer, mediaType, name: fileName })
      }
    } catch (error) {
      logger?.warn?.(`[dsh-edge-pilot] 截图无法转附件: ${error?.message || error}`)
    }
    return null
  }

  const tools = [
    {
      name: 'edge_open',
      description:
        '在系统 Edge 里打开一个网址并等待页面可交互（首次调用会自动启动浏览器）。返回标题、地址、HTTP 状态。' +
        '需要另开标签页做对比时把 newTab 设为 true。',
      parameters: {
        url: { type: 'string', required: true, description: '要打开的地址，可省略 https://' },
        newTab: { type: 'boolean', description: '是否在新标签页打开（默认 false，在当前页导航）' },
      },
      ...jsonOut,
      async execute(args) {
        const s = getSession()
        const target = normalizeUrl(args.url)
        assertDomainAllowed(target, settings)
        await s.ensure()
        let page
        if (args.newTab && s.context) {
          // 开新标签后立刻按 maxTabs 限额，防止一次任务越开越多
          page = await s.openTab(null)
        } else {
          page = await s.requirePage()
        }
        const response = await page.goto(target, {
          waitUntil: 'domcontentloaded',
          timeout: settings.navTimeoutMs,
        })
        s.activePage = page
        await page.waitForTimeout(300)
        const title = await page.title().catch(() => '')
        return {
          ok: true,
          url: page.url(),
          title,
          status: response ? response.status() : 'n/a',
          tabs: (await s.tabs()).length,
          __text: `已打开：${title}\n地址：${page.url()}\n状态码：${response ? response.status() : 'n/a'}\n下一步：edge_observe 看页面上有哪些可点元素。`,
        }
      },
    },
    {
      name: 'edge_observe',
      description:
        '读取当前页面的可交互元素清单：每个元素带 ref、角色、名称、状态、是否在视口内，外加地址、标题和正文摘要。' +
        '后续所有点击/输入都用这里给出的 ref。页面变化后 ref 会失效，需要重新观察。' +
        '这是网页操控的入口工具——不确定页面上有什么时，先调它。',
      parameters: {
        maxElements: { type: 'number', description: '最多返回多少个元素（默认 200，页面很乱时可调小到 80）' },
        digestChars: { type: 'number', description: '正文摘要最多多少字（默认 1200）' },
      },
      ...jsonOut,
      async execute(args) {
        const s = getSession()
        await s.ensure()
        const result = await observe(s, {
          maxElements: args.maxElements,
          digestChars: args.digestChars,
        })
        return {
          ok: true,
          url: result.data.url,
          title: result.data.title,
          totalElements: result.data.totalElements,
          __text: result.markdown + '\n' + DISCIPLINE.join('\n'),
        }
      },
    },
    {
      name: 'edge_screenshot',
      description:
        '对当前页面或某个元素截图，图片会直接返回给你看，同时保存成文件。' +
        '元素清单读不出结构、需要看视觉效果（验证码、图表、排版错乱、弹窗位置）时用。',
      parameters: {
        ref: { type: 'string', description: '只截某个元素，传 observe 给的 ref（可选）' },
        fullPage: { type: 'boolean', description: '是否截整页（默认 false，只截视口）' },
        format: { type: 'string', description: 'png（默认）或 jpeg' },
        path: { type: 'string', description: '保存路径（可选，默认存到下载目录）' },
      },
      ...jsonOut,
      async execute(args) {
        const s = getSession()
        const result = await screenshot(s, args)
        const attachment = await attachImage(result.buffer, result.scope === 'page' ? 'image/png' : 'image/png', 'edge-shot.png')
        const clone = { ...result }
        delete clone.buffer
        return {
          ...clone,
          __image: attachment,
          __text: `截图已保存：${result.path}（${result.kb} KB，范围：${result.scope}）\n地址：${result.url}`,
        }
      },
    },
    {
      name: 'edge_click',
      description:
        '点击页面元素。优先传 ref（来自最近一次 observe）；也可传 text 按可见文字点击，或传 x/y 按坐标点击。' +
        '会先把元素滚进视口、检查是否被遮挡，点击后再判断页面是否真的发生了变化。',
      parameters: {
        ref: { type: 'string', description: '元素 ref，例如 e7（推荐）' },
        text: { type: 'string', description: '按可见文字点击（ref 不可用时备选）' },
        x: { type: 'number', description: '坐标点击的 x（与 y 配对）' },
        y: { type: 'number', description: '坐标点击的 y' },
        button: { type: 'string', description: 'left（默认）/ right / middle' },
        doubleClick: { type: 'boolean', description: '是否双击' },
        modifiers: { type: 'array', description: '修饰键，如 ["Control"] 表示 Ctrl+点击' },
      },
      ...jsonOut,
      async execute(args) {
        const s = getSession()
        const result = await click(s, args)
        return { ...result, __text: summarizeAction(result) }
      },
    },
    {
      name: 'edge_type',
      description:
        '在输入框里输入文字。默认先清空原有内容再输入；enter=true 会在输入后回车提交。' +
        '需要模拟真人逐字输入（某些搜索联想框需要）时把 perChar 设为 true。',
      parameters: {
        ref: { type: 'string', required: true, description: '输入框的 ref' },
        text: { type: 'string', required: true, description: '要输入的文字' },
        clear: { type: 'boolean', description: '是否先清空（默认 true）' },
        enter: { type: 'boolean', description: '输入后是否回车' },
        perChar: { type: 'boolean', description: '是否逐字输入（默认 false，直接填入）' },
      },
      ...jsonOut,
      async execute(args) {
        const s = getSession()
        const result = await typeText(s, args)
        return {
          ...result,
          __text: `已输入 ${result.typed} 个字符，当前值：${JSON.stringify(result.value)}${result.submitted ? '（已回车）' : ''}`,
        }
      },
    },
    {
      name: 'edge_key',
      description: '按键盘按键，例如 Enter、Tab、Escape、Control+A、ArrowDown、PageDown。',
      parameters: {
        key: { type: 'string', required: true, description: '按键组合，例如 Enter 或 Control+A' },
        ref: { type: 'string', description: '先聚焦到某个元素再按键（可选）' },
      },
      ...jsonOut,
      async execute(args) {
        const s = getSession()
        const result = await pressKey(s, args)
        return { ...result, __text: `已按键 ${result.key}，当前地址：${result.url}` }
      },
    },
    {
      name: 'edge_scroll',
      description:
        '滚动页面。传 ref 会把该元素滚到视口中间；不传则按 dy 滚动（默认向下 700px，负数向上）。' +
        '返回滚动位置和是否已到底，用于判断"还有没有更多内容"。',
      parameters: {
        ref: { type: 'string', description: '滚到某个元素（可选）' },
        dy: { type: 'number', description: '纵向滚动像素，正数向下（默认 700）' },
        dx: { type: 'number', description: '横向滚动像素' },
      },
      ...jsonOut,
      async execute(args) {
        const s = getSession()
        const result = await scrollPage(s, args)
        const where = result.scrolledTo
          ? `已把 ${result.scrolledTo} 滚到视口内`
          : `已滚动，当前 scrollY=${result.scrollY}/${Math.max(0, (result.scrollHeight || 0) - (result.innerHeight || 0))}`
        return { ...result, __text: `${where}${result.atBottom ? '（已到页面底部）' : ''}\n需要新元素请重新 edge_observe。` }
      },
    },
    {
      name: 'edge_drag',
      description:
        '按住元素拖动：用于轮播图翻页、滑块验证、拖拽排序。传 toRef 拖到目标元素，或传 dx/dy 拖固定距离。',
      parameters: {
        fromRef: { type: 'string', required: true, description: '起点元素 ref' },
        toRef: { type: 'string', description: '终点元素 ref（可选）' },
        dx: { type: 'number', description: '横向拖动距离（默认 200）' },
        dy: { type: 'number', description: '纵向拖动距离（默认 0）' },
      },
      ...jsonOut,
      async execute(args) {
        const s = getSession()
        const result = await drag(s, args)
        return { ...result, __text: `已拖动：(${result.from.join(',')}) → (${result.to.join(',')})` }
      },
    },
    {
      name: 'edge_select',
      description: '操作原生下拉框（select）。按可见文字 label、value 或序号 index 选择一项。',
      parameters: {
        ref: { type: 'string', required: true, description: '下拉框的 ref' },
        label: { type: 'string', description: '按可见文字选择' },
        value: { type: 'string', description: '按 value 选择' },
        index: { type: 'number', description: '按序号选择（从 0 开始）' },
      },
      ...jsonOut,
      async execute(args) {
        const s = getSession()
        const result = await selectOption(s, args)
        return { ...result, __text: `已选择：${result.selected.join(', ')}` }
      },
    },
    {
      name: 'edge_hover',
      description: '鼠标悬停到元素上，用于展开二级菜单、显示提示框。悬停后请重新 observe 看新出现的元素。',
      parameters: { ref: { type: 'string', required: true, description: '元素 ref' } },
      ...jsonOut,
      async execute(args) {
        const s = getSession()
        const result = await hover(s, args)
        return { ...result, __text: `已悬停 ${result.hovered}。${result.hint}` }
      },
    },
    {
      name: 'edge_wait',
      description:
        '等待条件成立：地址包含某段文字、页面出现某段文字，或不带条件地等待若干毫秒。' +
        '比反复 observe 更省 token，适合等加载、等跳转。' +
        '等 AI 出图、视频、长任务结果时优先用 textContains（例如等页面出现「下载图片」），' +
        '不要让模型用固定毫秒反复硬等。ms 只是"无条件下等多少毫秒"，可等待时长由 timeoutMs 决定，' +
        '想等更久就把数值写进 timeoutMs。',
      parameters: {
        urlContains: { type: 'string', description: '等待地址包含这段文字' },
        textContains: { type: 'string', description: '等待页面正文包含这段文字' },
        ms: { type: 'number', description: '单纯等待的毫秒数（没有条件时使用）' },
        timeoutMs: { type: 'number', description: '最长等待时间（默认 15000）' },
      },
      ...jsonOut,
      async execute(args) {
        const s = getSession()
        const result = await waitForState(s, args)
        return {
          ...result,
          __text: result.ok ? `条件满足：${result.matched || '已等待 ' + result.waitedMs + 'ms'}` : `等待超时（${result.waitedMs}ms）：${result.hint}`,
        }
      },
    },
    {
      name: 'edge_tabs',
      description:
        '管理标签页：列出所有标签、打开新标签、切换、关闭、关掉其它所有标签，或按限额回收（prune）。' +
        '插件默认会在启动时清场、开新标签后限额、空闲超时后回收、退出前全关，正常不用手动清；需要立刻收拾时用 action=prune。',
      parameters: {
        action: { type: 'string', required: true, description: 'list（默认）/ open / switch / close / closeOthers / prune' },
        index: { type: 'number', description: '标签页序号，从 0 开始（switch/close/closeOthers 用）' },
        url: { type: 'string', description: 'open 时要打开的地址' },
        keep: { type: 'number', description: 'prune 时保留几个（默认取插件配置 maxTabs）' },
        keepActive: { type: 'boolean', description: 'prune 时是否保留当前活动页（默认 true）' },
      },
      ...jsonOut,
      async execute(args) {
        const s = getSession()
        const result = await tabs(s, args)
        const list = (result.tabs || [])
          .map((tab) => `${tab.active ? '*' : ' '} [${tab.index}] ${tab.title || '(无标题)'} — ${tab.url}`)
          .join('\n')
        return { ...result, __text: `标签页：\n${list}` }
      },
    },
    {
      name: 'edge_skill',
      description:
        '固化流程技能：把重复的网页操作（如「打开 GPT 新对话→填提示词→发送→等出图」）存成一份技能，' +
        '下次只填参数直接跑，不用再一步步 observe/click 重新思考。' +
        'action=list 看有哪些技能及其参数；action=run 执行（传 name + args）；' +
        'action=show 看完整定义；action=save 保存/覆盖；action=remove 删除。' +
        '步骤用语义选择器（text/role/css/placeholder），不写 ref——ref 每次 observe 都会重编。',
      parameters: {
        action: {
          type: 'string',
          required: true,
          description: 'list / run / show / save / remove',
        },
        name: { type: 'string', description: '技能名（run/show/save/remove 用）' },
        args: {
          type: 'object',
          description: 'action=run 时的参数对象，键名对应技能的 params',
        },
        description: { type: 'string', description: 'action=save 时的技能描述' },
        params: {
          type: 'object',
          description: 'action=save 时的参数声明，如 {prompt:{required:true,description:"提示词"}}',
        },
        steps: {
          type: 'array',
          description: 'action=save 时的步骤数组，每步 {action, ...选择器/参数}',
        },
      },
      ...jsonOut,
      async execute(args) {
        const action = String(args.action || 'list').toLowerCase()

        if (action === 'list') {
          const skills = listSkills(settings)
          if (skills.length === 0) {
            return {
              ok: true,
              skills: [],
              __text:
                `还没有保存任何技能（目录：${settings.skillsDir || '~/.dsh/edge-pilot/skills'}）。\n` +
                '用 edge_skill action=save 把一套固化流程存下来。',
            }
          }
          return {
            ok: true,
            skills: skills.map((s) => ({ name: s.name, description: s.description, params: s.params, steps: s.steps.length })),
            __text: '已保存的技能：\n' + skills.map((s) => '· ' + describeSkill(s)).join('\n\n'),
          }
        }

        if (action === 'show') {
          if (!args.name) throw new Error('action=show 需要 name')
          const def = loadSkill(settings, args.name)
          return {
            ok: true,
            skill: def,
            __text:
              `技能：${def.name}\n描述：${def.description || '(无)'}\n` +
              `参数：${JSON.stringify(def.params || {})}\n步骤：\n` +
              def.steps
                .map((step, i) => `  ${i + 1}. ${JSON.stringify(step)}`)
                .join('\n'),
          }
        }

        if (action === 'save') {
          if (!args.name) throw new Error('action=save 需要 name')
          if (!Array.isArray(args.steps) || args.steps.length === 0) {
            throw new Error('action=save 需要 steps 数组（至少一步）')
          }
          let params = args.params
          if (typeof params === 'string') {
            try {
              params = JSON.parse(params)
            } catch {
              throw new Error('params 需要是对象，或能解析成对象的 JSON 字符串')
            }
          }
          let steps = args.steps
          if (typeof steps === 'string') {
            try {
              steps = JSON.parse(steps)
            } catch {
              throw new Error('steps 需要是数组，或能解析成数组的 JSON 字符串')
            }
          }
          const def = saveSkill(settings, args.name, {
            description: args.description,
            params,
            steps,
          })
          return {
            ok: true,
            skill: { name: def.name, steps: def.steps.length },
            __text: `技能已保存：${def.name}（${def.steps.length} 步）\n用 edge_skill action=run name=${def.name} args={...} 调用。`,
          }
        }

        if (action === 'remove') {
          if (!args.name) throw new Error('action=remove 需要 name')
          removeSkill(settings, args.name)
          return { ok: true, __text: `技能已删除：${args.name}` }
        }

        if (action === 'run') {
          if (!args.name) throw new Error('action=run 需要 name')
          const s = getSession()
          await s.ensure()
          let runArgs = args.args
          if (typeof runArgs === 'string') {
            try {
              runArgs = JSON.parse(runArgs)
            } catch {
              throw new Error('args 需要是对象，或能解析成对象的 JSON 字符串')
            }
          }
          const result = await runSkill(s, settings, args.name, runArgs || {}, logger)
          const outLines = (result.outputs || []).map((o) => `${o.type}: ${o.path}`)
          const varLines = Object.entries(result.vars || {}).map(([k, v]) => `${k} = ${String(v).slice(0, 200)}`)
          const missingLines = (result.missingVars || []).length
            ? '\n⚠ 这些模板变量没取到值（已当空串处理）：' + result.missingVars.join(', ')
            : ''
          return {
            ...result,
            __text:
              `技能 "${result.name}" 执行完成，共 ${result.steps} 步。\n` +
              `当前地址：${result.url}` +
              (outLines.length ? '\n产物：\n' + outLines.map((l) => '  ' + l).join('\n') : '') +
              (varLines.length ? '\n提取的变量：\n' + varLines.map((l) => '  ' + l).join('\n') : '') +
              missingLines,
          }
        }

        throw new Error(`不支持的 action：${action}（可用 list/run/show/save/remove）`)
      },
    },
    {
      name: 'edge_save',
      description:
        '把当前页面另存为文件。format 可选：' +
        'mhtml（网页单个文件，最完整，默认）、html（仅 HTML）、pdf、txt、md、png/jpeg（整页截图）、resource（另存某个图片/文件）。' +
        '需要"另存为"整个网页时用 mhtml。',
      parameters: {
        format: { type: 'string', description: 'mhtml / html / pdf / txt / md / png / jpeg / resource' },
        path: { type: 'string', description: '保存路径（可选，默认存到下载目录并按标题命名）' },
        ref: { type: 'string', description: 'format=resource 时，要保存的图片/链接元素 ref' },
        url: { type: 'string', description: 'format=resource 时，直接指定资源地址' },
        fullPage: { type: 'boolean', description: '图片格式下是否截整页（默认 true）' },
      },
      ...jsonOut,
      async execute(args) {
        const s = getSession()
        const result = await saveAs(s, args)
        return {
          ...result,
          __text: `已另存为 ${result.format}：${result.path}（${result.kb} KB）${result.source ? '\n来源：' + result.source : ''}`,
        }
      },
    },
    {
      name: 'edge_download',
      description:
        '触发并等待真实下载完成，返回落盘路径和文件名。传 ref 点击下载按钮/链接，或传 url 直接下载，或传 triggerText 按文字点击。' +
        '会一直等到文件真的写进磁盘才算成功——不要用 edge_click 代替它来"点击下载按钮"。',
      parameters: {
        ref: { type: 'string', description: '下载按钮或链接的 ref' },
        triggerText: { type: 'string', description: '按可见文字点击来触发下载' },
        url: { type: 'string', description: '直接按地址下载文件' },
        path: { type: 'string', description: '保存路径（可选）' },
        timeoutMs: { type: 'number', description: '等待超时毫秒数（默认 30000）' },
      },
      ...jsonOut,
      async execute(args) {
        const s = getSession()
        const result = await download(s, args)
        return {
          ...result,
          __text: result.ok ? `下载完成：${result.path}（${result.kb} KB）` : `下载失败：${result.error}`,
        }
      },
    },
    {
      name: 'edge_eval',
      description:
        '在页面里执行一小段 JavaScript 并返回结果，用于上面工具都覆盖不了的边角情况（读某个变量、批量取数据）。' +
        '普通操作不要用它，优先用 ref。',
      parameters: {
        code: { type: 'string', required: true, description: '要执行的 JS 表达式，例如 document.title' },
      },
      ...jsonOut,
      async execute(args) {
        const s = getSession()
        const page = await s.requirePage()
        let result
        try {
          result = await page.evaluate(String(args.code))
        } catch (error) {
          throw new Error(`脚本执行失败：${error?.message || error}`)
        }
        const text = typeof result === 'string' ? result : JSON.stringify(result)
        return {
          ok: true,
          result: text && text.length > 4000 ? text.slice(0, 4000) + '...(截断)' : text,
          __text: text && text.length > 4000 ? text.slice(0, 4000) + '...(截断)' : String(text),
        }
      },
    },
    {
      name: 'edge_status',
      description: '查看浏览器状态：是否已启动、当前地址、标签页列表、下载目录、最近的标签页/下载事件。',
      parameters: {},
      ...jsonOut,
      async execute() {
        const s = getSession()
        if (!session || !s.context) {
          return {
            ok: true,
            launched: false,
            __text: `浏览器尚未启动。首次调用 edge_open 会自动启动系统 Edge（数据目录：${settings.userDataDir}）。`,
          }
        }
        const state = await s.state()
        const tabsText = state.tabs
          .map((tab) => `${tab.active ? '*' : ' '} [${tab.index}] ${tab.title || '(无标题)'} — ${tab.url}`)
          .join('\n')
        return {
          ok: true,
          ...state,
          __text: [
            `模式：${state.mode === 'attach' ? '接管已有浏览器（CDP）' : '独立实例'}`,
            `有头显示：${state.headless ? '否（headless）' : '是'}`,
            `当前页面：${state.title || '(无标题)'} — ${state.url || '(空白)'}`,
            `数据目录：${state.userDataDir}`,
            `下载目录：${state.downloadsDir}`,
            '标签页：',
            tabsText || '（无）',
            state.recentEvents.length ? '最近事件：\n' + state.recentEvents.map((e) => '- ' + e.text).join('\n') : '',
          ]
            .filter(Boolean)
            .join('\n'),
        }
      },
    },
    {
      name: 'edge_close',
      description:
        '关闭浏览器并释放资源。任务结束时调用；用户还想继续看页面就不要关。' +
        '关闭前会自动清空插件自己开的标签页，下次启动不会再被还原。',
      parameters: {
        kill: { type: 'boolean', description: '接管模式下是否强制关闭对方浏览器（默认 false，只断开连接）' },
      },
      ...jsonOut,
      async execute(args) {
        if (!session) return { ok: true, __text: '浏览器未启动，无需关闭。' }
        const result = await session.close({ kill: Boolean(args.kill) })
        session = null
        const swept = result?.swept
        return {
          ok: true,
          __text:
            '浏览器已关闭，资源已释放。' +
            (swept && swept.closed ? `\n退出前清理了 ${swept.closed} 个标签页（原本 ${swept.before} 个）。` : ''),
        }
      },
    },
    {
      name: 'chatgpt_ask',
      description:
        '把问题发给网页版 ChatGPT 并只拿回答案正文（不返回页面结构，省 token）。' +
        '后台静默启动专用 Edge 实例，问完自动关掉，不占用用户正在看的浏览器。' +
        '默认新开一个对话；想接着上一个话题就传 newChat=false。',
      parameters: {
        prompt: { type: 'string', required: true, description: '要问的问题（中文即可）' },
        timeoutMs: { type: 'number', description: '最长等待回复毫秒数（默认 180000）' },
        newChat: { type: 'boolean', description: '是否新开对话（默认 true）' },
      },
      ...jsonOut,
      async execute(args) {
        const result = await chatgptAsk(chatgpt, args)
        const answer = result.answer || '(空回复)'
        return {
          ok: true,
          answer,
          url: result.url,
          __text: answer.length > 6000 ? answer.slice(0, 6000) + '\n…(已截断)' : answer,
        }
      },
    },
    {
      name: 'chatgpt_image',
      description:
        '让网页版 ChatGPT 生成图片并存到本地，只返回文件路径和尺寸。' +
        '可传 ref 指定参考图（本地路径，自动复制、经系统剪贴板贴进输入框）。' +
        '后台静默运行，生成完自动关闭浏览器。',
      parameters: {
        prompt: { type: 'string', required: true, description: '画面描述（中文即可）' },
        ref: { type: 'string', description: '参考图本地绝对路径（可选）' },
        path: { type: 'string', description: '保存路径（可选，默认存到 chatgpt-downloads）' },
        timeoutMs: { type: 'number', description: '最长等待毫秒数（默认 240000）' },
      },
      ...jsonOut,
      async execute(args) {
        const result = await chatgptImage(chatgpt, args)
        const lines = result.images.map(
          (img, i) => `${i + 1}. ${img.path}（${img.width}×${img.height}，${Math.round(img.bytes / 1024)} KB）`,
        )
        return {
          ok: true,
          ...result,
          __text: `已生成 ${result.images.length} 张：\n${lines.join('\n')}`,
        }
      },
    },
    {
      name: 'chatgpt_gif',
      description:
        '让网页版 ChatGPT 画一段动画，合成 GIF 存到本地，只返回文件路径。' +
        'frames 是帧数（2-8，默认 4），frameMs 是每帧毫秒（默认 400）。' +
        '可传 ref 指定参考图（本地路径，走剪贴板粘贴）。后台静默运行，用完自动关闭。' +
        '注意：一次完整调用约 60 秒（启动浏览器 ~9s + 生图 ~40s + 切帧合成）。' +
        '免费账号一次只出一张图，所以内部让它画「一张分镜图」再本地切分，不要期望它真的输出多张。',
      parameters: {
        prompt: { type: 'string', required: true, description: '动画描述（中文即可）' },
        ref: { type: 'string', description: '参考图本地绝对路径（可选）' },
        frames: { type: 'number', description: '帧数，2-8（默认 4）' },
        frameMs: { type: 'number', description: '每帧毫秒（默认 400）' },
        path: { type: 'string', description: '保存路径（可选）' },
        timeoutMs: { type: 'number', description: '最长等待毫秒数（默认 300000）' },
      },
      ...jsonOut,
      async execute(args) {
        const result = await chatgptGif(chatgpt, args)
        return {
          ok: true,
          ...result,
          __text:
            `GIF 已生成：${result.path}\n` +
            `${result.frames} 帧 · ${result.width}×${result.height} · ${result.frameMs}ms/帧 · ${Math.round(result.bytes / 1024)} KB` +
            `\n取帧方式：${result.mode === 'sprite-sheet' ? '分镜网格切图' : '逐张帧图'}`,
        }
      },
    },
    {
      name: 'chatgpt_login_status',
      description: '检查 ChatGPT 专用 profile 的登录态是否还在（不启动浏览器，只读 cookie 库）。',
      parameters: {},
      ...jsonOut,
      async execute() {
        const state = chatgptLoginState(chatgpt)
        return {
          ok: true,
          ...state,
          __text: state.loggedIn
            ? `登录态还在：${state.cookiesPath}`
            : `登录态没了（${state.reason}）。需要手动用 Edge 打开 ${chatgpt.profileDir} 这个 profile 登录一次 chatgpt.com。`,
        }
      },
    },
  ]

  // 自诊断状态：重启后直接读 loaded.json 就知道卡在哪一步。
  const diag = {
    at: new Date().toISOString(),
    tools: tools.length,
    toolNames: tools.map((tool) => tool.name),
    node: process.version,
    pid: process.pid,
    injectSupported: typeof ctx.inject === 'function',
    toolsAtApply: typeof ctx.tools,
    injectFired: false,
    toolsService: null,
    registered: 0,
    failures: [],
  }
  const flush = () => {
    try {
      const dir = join(homedir(), '.dsh', 'edge-pilot')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'loaded.json'), JSON.stringify(diag, null, 2), 'utf8')
    } catch {
      /* 标记失败不影响插件本身 */
    }
  }

  flush() // apply 进入即留痕：能区分"插件没执行"和"执行了但工具没注册"

  const register = (host) => {
    const service = host ?? ctx.tools
    diag.toolsService = service ? 'ok' : 'missing'
    if (!service) {
      diag.failures.push({ name: '*', error: 'ctx.tools is undefined' })
      flush()
      return
    }
    for (const definition of tools) {
      try {
        service.register(defineTool(definition))
        diag.registered += 1
      } catch (error) {
        diag.failures.push({ name: definition.name, error: String(error?.message || error) })
      }
    }
    logger?.info?.(`[dsh-edge-pilot] 已注册 ${diag.registered}/${tools.length} 个工具`)
    flush()
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['tools'], (child) => {
      diag.injectFired = true
      try {
        register(child?.tools)
      } catch (error) {
        diag.failures.push({ name: '*', error: String(error?.message || error) })
        logger?.error?.(`[dsh-edge-pilot] 工具注册失败：${error?.message || error}`)
        flush()
      }
    })
  } else {
    register()
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(
      () => () => {
        if (session) {
          session.stopIdleTimer?.()
          session.close({ kill: true }).catch(() => {})
        }
        session = null
      },
      'dsh-edge-pilot',
    )
  }

  // 加载标记：重启后直接看这个文件就知道插件有没有被装进去，不用猜。
  try {
    const dir = join(homedir(), '.dsh', 'edge-pilot')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'loaded.json'),
      JSON.stringify(
        {
          at: new Date().toISOString(),
          tools: tools.length,
          toolNames: tools.map((tool) => tool.name),
          node: process.version,
          pid: process.pid,
        },
        null,
        2,
      ),
      'utf8',
    )
  } catch {
    /* 标记失败不影响插件本身 */
  }

  logger?.info?.('[dsh-edge-pilot] 插件已加载')
}
