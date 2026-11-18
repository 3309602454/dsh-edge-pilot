/**
 * Turn a live page into a compact, ref-addressable element list.
 *
 * The model never writes CSS selectors. It reads a numbered list and answers
 * with a single ref, which keeps hallucinated selectors out of the loop.
 */

const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  'summary',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="option"]',
  '[role="switch"]',
  '[role="combobox"]',
  '[role="textbox"]',
  '[role="searchbox"]',
  '[role="slider"]',
  '[onclick]',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/** Runs inside the page. Must be self-contained: no closures over module scope. */
function collectInPage(options) {
  const opts = options || {}
  const maxElements = Number(opts.maxElements) || 200
  const startRef = Number(opts.startRef) || 0
  const rootSelector = opts.rootSelector || ''
  const SELECTOR = opts.selector || ''

  document.querySelectorAll('[data-dsh-ref]').forEach((el) => el.removeAttribute('data-dsh-ref'))

  const root = rootSelector ? document.querySelector(rootSelector) || document.body : document.body
  if (!root) {
    return { elements: [], total: 0, nextRef: startRef, viewport: null, title: document.title, url: location.href }
  }

  const isVisible = (el) => {
    if (!el.isConnected) return false
    const style = getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false
    if (Number(style.opacity) < 0.05) return false
    const rect = el.getBoundingClientRect()
    if (rect.width < 2 || rect.height < 2) return false
    return true
  }

  const textOf = (el) => {
    const raw = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()
    return raw.length > 80 ? raw.slice(0, 77) + '...' : raw
  }

  const nameOf = (el) => {
    const aria = el.getAttribute('aria-label')
    if (aria && aria.trim()) return aria.trim().slice(0, 80)
    const labelledBy = el.getAttribute('aria-labelledby')
    if (labelledBy) {
      const joined = labelledBy
        .split(/\s+/)
        .map((id) => {
          const node = document.getElementById(id)
          return node ? node.innerText || '' : ''
        })
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
      if (joined) return joined.slice(0, 80)
    }
    const tag = el.tagName
    if (tag === 'INPUT') {
      const type = String(el.getAttribute('type') || 'text').toLowerCase()
      if (type === 'button' || type === 'submit' || type === 'reset') return String(el.value || type).slice(0, 80)
      if (el.labels && el.labels.length > 0) {
        const labelText = textOf(el.labels[0])
        if (labelText) return labelText
      }
      return String(el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '').slice(0, 80)
    }
    if (tag === 'IMG') return String(el.getAttribute('alt') || '').slice(0, 80)
    const own = textOf(el)
    if (own) return own
    return String(
      el.getAttribute('title') ||
        el.getAttribute('placeholder') ||
        el.getAttribute('name') ||
        el.getAttribute('value') ||
        '',
    ).slice(0, 80)
  }

  const roleOf = (el) => {
    const explicit = el.getAttribute('role')
    if (explicit) return explicit.toLowerCase()
    const tag = el.tagName.toLowerCase()
    if (tag === 'a') return 'link'
    if (tag === 'button') return 'button'
    if (tag === 'select') return 'combobox'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'summary') return 'button'
    if (tag === 'input') {
      const type = String(el.getAttribute('type') || 'text').toLowerCase()
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      if (type === 'range') return 'slider'
      if (type === 'file') return 'file'
      if (type === 'button' || type === 'submit' || type === 'reset') return 'button'
      return 'textbox'
    }
    return tag
  }

  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  const scrollX = window.scrollX
  const scrollY = window.scrollY

  const seen = new Set()
  const candidates = []
  for (const el of root.querySelectorAll(SELECTOR || 'a[href],button,input,select,textarea')) {
    if (seen.has(el)) continue
    seen.add(el)
    if (!isVisible(el)) continue
    candidates.push(el)
  }

  const describe = (el) => {
    const rect = el.getBoundingClientRect()
    const inViewport =
      rect.bottom > 0 && rect.top < viewportHeight && rect.right > 0 && rect.left < viewportWidth
    const tag = el.tagName.toLowerCase()
    const type = tag === 'input' ? String(el.getAttribute('type') || 'text').toLowerCase() : ''
    const nonTextTypes = ['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'range', 'color', 'hidden', 'image']
    const editable = tag === 'textarea' || el.isContentEditable || (tag === 'input' && !nonTextTypes.includes(type || 'text'))
    const item = {
      ref: '',
      tag,
      role: roleOf(el),
      name: nameOf(el),
      inViewport,
      bbox: [
        Math.round(rect.left + scrollX),
        Math.round(rect.top + scrollY),
        Math.round(rect.width),
        Math.round(rect.height),
      ],
    }
    if (editable) item.editable = true
    if (type && type !== 'text') item.type = type
    if (el.disabled) item.disabled = true
    if (el.getAttribute('aria-expanded')) item.expanded = el.getAttribute('aria-expanded')
    const href = tag === 'a' ? String(el.getAttribute('href') || '') : ''
    if (href && !/^javascript:/i.test(href.trim())) item.href = href.slice(0, 200)
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const sensitive = type === 'password'
      const value = sensitive ? (el.value ? '******' : '') : String(el.value || '')
      if (value) item.value = value.slice(0, 120)
      if (type === 'checkbox' || type === 'radio') item.checked = Boolean(el.checked)
      if (el.getAttribute('placeholder')) item.placeholder = String(el.getAttribute('placeholder')).slice(0, 60)
      if (tag === 'select') {
        item.options = Array.from(el.options || [])
          .slice(0, 12)
          .map((opt) => ({ text: (opt.text || '').trim().slice(0, 40), selected: opt.selected }))
      }
    }
    return item
  }

  let kept = candidates
  let truncated = false
  if (candidates.length > maxElements) {
    truncated = true
    const inView = []
    const rest = []
    for (const el of candidates) {
      const rect = el.getBoundingClientRect()
      const visibleNow =
        rect.bottom > 0 && rect.top < viewportHeight && rect.right > 0 && rect.left < viewportWidth
      if (visibleNow) inView.push(el)
      else rest.push(el)
    }
    kept = inView.slice(0, maxElements)
    if (kept.length < maxElements) kept = kept.concat(rest.slice(0, maxElements - kept.length))
  }

  const elements = kept.map((el, index) => {
    const ref = 'e' + (startRef + index + 1)
    el.setAttribute('data-dsh-ref', ref)
    const item = describe(el)
    item.ref = ref
    return item
  })

  const digest = (document.body ? document.body.innerText || '' : '').replace(/\s+/g, ' ').trim()

  return {
    url: location.href,
    title: document.title,
    viewport: {
      width: viewportWidth,
      height: viewportHeight,
      scrollX: Math.round(scrollX),
      scrollY: Math.round(scrollY),
      scrollHeight: document.documentElement ? document.documentElement.scrollHeight : 0,
      scrollWidth: document.documentElement ? document.documentElement.scrollWidth : 0,
    },
    total: candidates.length,
    truncated,
    nextRef: startRef + elements.length,
    digest,
    elements,
  }
}

function formatElement(item) {
  const parts = [`${item.inViewport ? '*' : ' '} [${item.ref}] ${item.role}`]
  if (item.name) parts.push(JSON.stringify(item.name))
  const extra = []
  if (item.editable) extra.push('可输入')
  if (item.type) extra.push(item.type)
  if (item.disabled) extra.push('disabled')
  if (typeof item.checked === 'boolean') extra.push(item.checked ? 'checked' : 'unchecked')
  if (item.expanded) extra.push(`expanded=${item.expanded}`)
  if (item.value) extra.push(`value=${JSON.stringify(item.value)}`)
  if (extra.length) parts.push('(' + extra.join(', ') + ')')
  if (item.href) parts.push('-> ' + item.href)
  if (Array.isArray(item.options) && item.options.length) {
    parts.push('[选项: ' + item.options.map((o) => (o.selected ? o.text + '(已选)' : o.text)).join(' | ') + ']')
  }
  return parts.join(' ')
}

/**
 * @returns {Promise<{markdown:string, data:object}>}
 */
export async function observe(session, options = {}) {
  const page = await session.requirePage()
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 8000 })
  } catch {
    /* slow page, observe what we have */
  }

  session.resetRefs()
  const frames = page.frames()
  const frameReports = []
  let failedFrames = 0

  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index]
    let result = null
    try {
      result = await frame.evaluate(collectInPage, {
        maxElements: Number(options.maxElements) || session.config.maxElements,
        startRef: 0,
        rootSelector: options.rootSelector || '',
        selector: INTERACTIVE_SELECTOR,
      })
    } catch {
      failedFrames += 1
      continue
    }
    if (!result || !Array.isArray(result.elements)) continue

    const elements = []
    let nextRef = 0
    for (const raw of result.elements) {
      const globalRef = session.nextRef()
      const localRef = raw.ref
      elements.push({ ...raw, ref: globalRef })
      session.refs.set(globalRef, {
        frame,
        localRef,
        role: raw.role,
        name: raw.name,
        frameIndex: index,
      })
      const numeric = Number(String(localRef).replace(/[^0-9]/g, ''))
      if (numeric > nextRef) nextRef = numeric
    }
    frameReports.push({ frameIndex: index, url: result.url, elements, result })
  }

  const main = frameReports[0]?.result || { title: '', url: page.url(), viewport: null, total: 0, digest: '' }
  const lines = []
  lines.push(`页面：${main.title || '(无标题)'}`)
  lines.push(`地址：${main.url || page.url()}`)
  if (main.viewport) {
    const scrolled = main.viewport.scrollHeight - main.viewport.height
    lines.push(
      `视口：${main.viewport.width}×${main.viewport.height}，纵向已滚动 ${main.viewport.scrollY}` +
        (scrolled > 0 ? `（可滚动范围 0~${scrolled}）` : '（整页可见）'),
    )
  }

  const totalElements = frameReports.reduce((sum, item) => sum + item.elements.length, 0)
  const truncated = frameReports.some((item) => item.result.truncated)
  lines.push(
    `可交互元素：${totalElements} 个` + (truncated ? '（已截断，先操作视口内的；需要更多可滚动后再看）' : ''),
  )

  const dialogText = session.dialogs.slice(-2).map((d) => `${d.type}: ${d.message}`)
  if (dialogText.length) lines.push(`最近的弹窗：${dialogText.join(' | ')}`)

  const recentPages = session.events.filter((e) => e.text.startsWith('新标签页')).slice(-2)
  if (recentPages.length) lines.push(`最近的标签页事件：${recentPages.map((e) => e.text).join(' | ')}`)

  for (const report of frameReports) {
    if (report.frameIndex > 0) {
      lines.push('')
      lines.push(`—— 内嵌框架 #${report.frameIndex}（${report.result.url}）——`)
    }
    if (report.elements.length === 0) {
      lines.push(report.frameIndex === 0 ? '(主框架没有可交互元素)' : '(无)')
      continue
    }
    for (const item of report.elements) lines.push(formatElement(item))
  }

  const digestLimit = Number(options.digestChars) || session.config.textDigestChars
  const digest = (main.digest || '').slice(0, digestLimit)
  if (digest) {
    lines.push('')
    lines.push('正文摘要：')
    lines.push(digest)
  }

  if (session.consoleErrors.length) {
    const last = session.consoleErrors.slice(-3)
    lines.push('')
    lines.push('页面控制台报错：' + last.map((e) => e.text.slice(0, 120)).join(' | '))
  }

  return {
    markdown: lines.join('\n'),
    data: {
      url: main.url || page.url(),
      title: main.title || '',
      viewport: main.viewport,
      totalElements,
      frameCount: frames.length,
      failedFrames,
      elements: frameReports.flatMap((item) => item.elements),
    },
  }
}
