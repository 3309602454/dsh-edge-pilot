/** Element resolution plus real user-level actions, with before/after verification. */

export function locatorFromRef(session, ref) {
  const entry = session.refs.get(ref)
  if (!entry) {
    throw new Error(
      `ref ${ref} 不在当前快照里（页面可能已经变化）。请先调用 edge_observe 重新获取元素清单，再用新的 ref。`,
    )
  }
  const locator = entry.frame.locator(`[data-dsh-ref="${entry.localRef}"]`).first()
  return { locator, entry }
}

function resolveByText(page, text) {
  const value = String(text || '').trim()
  if (!value) throw new Error('text 不能为空')
  return page.getByText(value, { exact: false }).first()
}

async function probeObstruction(locator) {
  try {
    return await locator.evaluate((el) => {
      const rect = el.getBoundingClientRect()
      const x = rect.left + rect.width / 2
      const y = rect.top + rect.height / 2
      if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
        return { blocked: true, reason: '元素中心点不在视口内' }
      }
      const top = document.elementFromPoint(x, y)
      if (!top) return { blocked: false }
      if (top === el || el.contains(top) || top.contains(el)) return { blocked: false }
      const label = (top.innerText || top.getAttribute('aria-label') || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 40)
      const desc = top.tagName.toLowerCase() + (top.id ? '#' + top.id : '') + (label ? ` "${label}"` : '')
      return { blocked: true, reason: `被 ${desc} 遮挡` }
    })
  } catch {
    return { blocked: false }
  }
}

async function pageSignature(page) {
  try {
    return await page.evaluate(() => {
      const text = document.body ? document.body.innerText.replace(/\s+/g, ' ').trim() : ''
      return { length: text.length, head: text.slice(0, 300), tail: text.slice(-120) }
    })
  } catch {
    return null
  }
}

async function settle(page, session, before, pagesBefore) {
  await page.waitForTimeout(350)
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 })
  } catch {
    /* keep going */
  }
  const pagesNow = session.context ? session.context.pages() : []
  if (pagesNow.length > pagesBefore) {
    const active = session.currentPage()
    return { type: 'new_tab', detail: active ? active.url() : '' }
  }
  const urlNow = page.url()
  if (urlNow !== before.url) return { type: 'navigated', detail: urlNow }

  const after = await pageSignature(page)
  if (before.sig && after) {
    const changed =
      after.length !== before.sig.length || after.head !== before.sig.head || after.tail !== before.sig.tail
    if (changed) {
      return { type: 'dom_changed', detail: `正文长度 ${before.sig.length} → ${after.length}` }
    }
  }
  return { type: 'no_visible_change', detail: '未观察到地址或正文变化，可能需要等待、滚动或换一个元素' }
}

async function prepare(session, args) {
  const page = await session.requirePage()
  const before = { url: page.url(), sig: await pageSignature(page) }
  const pagesBefore = session.context ? session.context.pages().length : 0
  return { page, before, pagesBefore }
}

function actionOptions(session, args) {
  return {
    timeout: Number(args.timeout) || session.config.actionTimeoutMs,
    button: args.button === 'right' || args.button === 'middle' ? args.button : 'left',
    clickCount: args.doubleClick ? 2 : 1,
    modifiers: Array.isArray(args.modifiers) ? args.modifiers : undefined,
  }
}

export async function click(session, args) {
  const { page, before, pagesBefore } = await prepare(session, args)
  let warnings = []

  if (args.ref) {
    const { locator } = locatorFromRef(session, args.ref)
    try {
      await locator.scrollIntoViewIfNeeded({ timeout: 5000 })
    } catch {
      /* not fatal */
    }
    const check = await probeObstruction(locator)
    if (check.blocked) {
      warnings.push(`点击前检测到遮挡：${check.reason}。已尝试继续，若失败请先关闭弹窗/遮罩。`)
    }
    await locator.click(actionOptions(session, args))
  } else if (Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.y))) {
    await page.mouse.click(Number(args.x), Number(args.y), actionOptions(session, args))
  } else if (args.text) {
    await resolveByText(page, args.text).click(actionOptions(session, args))
  } else {
    throw new Error('click 需要 ref、text 或 x/y 三者之一')
  }

  const effect = await settle(page, session, before, pagesBefore)
  const active = session.currentPage()
  return {
    ok: effect.type !== 'no_visible_change',
    effect,
    url: active ? active.url() : page.url(),
    title: active ? await active.title().catch(() => '') : '',
    warnings,
    ...(effect.type === 'no_visible_change'
      ? { hint: '如果没有达到预期，先 edge_observe 看清当前状态再决定，不要重复盲点。' }
      : {}),
  }
}

export async function typeText(session, args) {
  if (!args.ref) throw new Error('type 需要 ref')
  const { locator } = locatorFromRef(session, args.ref)
  const text = String(args.text ?? '')
  await locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {})
  await locator.click({ timeout: Number(args.timeout) || session.config.actionTimeoutMs })

  const clearFirst = args.clear !== false
  if (args.perChar) {
    if (clearFirst) await locator.fill('')
    await locator.pressSequentially(text, { delay: Number(args.delayMs) || 40 })
  } else {
    await locator.fill(clearFirst ? text : (await locator.inputValue().catch(() => '')) + text)
  }

  if (args.enter) await locator.press('Enter')

  const actual = await locator.inputValue().catch(() => '')
  return {
    ok: true,
    typed: text.length,
    value: actual.slice(0, 120),
    submitted: Boolean(args.enter),
  }
}

export async function pressKey(session, args) {
  const page = await session.requirePage()
  const key = String(args.key || '').trim()
  if (!key) throw new Error('key 不能为空，例如 Enter / Tab / Control+A')
  if (args.ref) {
    const { locator } = locatorFromRef(session, args.ref)
    await locator.press(key, { timeout: Number(args.timeout) || session.config.actionTimeoutMs })
  } else {
    await page.keyboard.press(key)
  }
  await page.waitForTimeout(200)
  return { ok: true, key, url: page.url() }
}

export async function hover(session, args) {
  if (!args.ref) throw new Error('hover 需要 ref')
  const { locator } = locatorFromRef(session, args.ref)
  await locator.hover({ timeout: Number(args.timeout) || session.config.actionTimeoutMs })
  await session
    .requirePage()
    .then((page) => page.waitForTimeout(300))
    .catch(() => {})
  return { ok: true, hovered: args.ref, hint: '悬停后菜单可能展开，请 edge_observe 查看新出现的元素' }
}

export async function scrollPage(session, args) {
  const page = await session.requirePage()
  if (args.ref) {
    const { locator } = locatorFromRef(session, args.ref)
    await locator.scrollIntoViewIfNeeded({ timeout: Number(args.timeout) || session.config.actionTimeoutMs })
    return { ok: true, scrolledTo: args.ref, ...(await scrollState(page)) }
  }
  const dy = Number(args.dy ?? args.deltaY ?? 0)
  const dx = Number(args.dx ?? args.deltaX ?? 0)
  const amount = dy || dx ? { dy, dx } : { dy: 700, dx: 0 }
  await page.mouse.move(Number(args.x) || 720, Number(args.y) || 450)
  await page.mouse.wheel(amount.dx, amount.dy)
  await page.waitForTimeout(350)
  return { ok: true, ...(await scrollState(page)) }
}

async function scrollState(page) {
  const info = await page
    .evaluate(() => ({
      scrollY: Math.round(window.scrollY),
      innerHeight: window.innerHeight,
      scrollHeight: document.documentElement ? document.documentElement.scrollHeight : 0,
      atBottom:
        Math.round(window.scrollY) + window.innerHeight >=
        (document.documentElement ? document.documentElement.scrollHeight : 0) - 4,
    }))
    .catch(() => ({}))
  return info
}

export async function drag(session, args) {
  const page = await session.requirePage()
  const from = args.fromRef ? locatorFromRef(session, args.fromRef).locator : null
  if (!from) throw new Error('drag 需要 fromRef')
  await from.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {})
  const box = await from.boundingBox()
  if (!box) throw new Error('拿不到起点元素位置')
  const startX = box.x + box.width / 2
  const startY = box.y + box.height / 2
  let endX = startX + (Number(args.dx) || 200)
  let endY = startY + (Number(args.dy) || 0)
  if (args.toRef) {
    const to = locatorFromRef(session, args.toRef).locator
    const toBox = await to.boundingBox()
    if (toBox) {
      endX = toBox.x + toBox.width / 2
      endY = toBox.y + toBox.height / 2
    }
  }
  const steps = Math.max(8, Math.min(40, Number(args.steps) || 16))
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(startX + ((endX - startX) * i) / steps, startY + ((endY - startY) * i) / steps)
    await page.waitForTimeout(12)
  }
  await page.mouse.up()
  await page.waitForTimeout(300)
  return { ok: true, from: [Math.round(startX), Math.round(startY)], to: [Math.round(endX), Math.round(endY)] }
}

export async function selectOption(session, args) {
  if (!args.ref) throw new Error('select 需要 ref')
  const { locator } = locatorFromRef(session, args.ref)
  const payload = {}
  if (args.value != null) payload.value = String(args.value)
  else if (args.label != null) payload.label = String(args.label)
  else if (args.index != null) payload.index = Number(args.index)
  else throw new Error('select 需要 value / label / index 之一')
  const chosen = await locator.selectOption(payload, {
    timeout: Number(args.timeout) || session.config.actionTimeoutMs,
  })
  return { ok: true, selected: chosen }
}

export async function waitForState(session, args) {
  const page = await session.requirePage()
  const requestedMs = Number(args.ms) || 0
  const timeout = Number(args.timeoutMs) || Math.max(15000, requestedMs)
  const conditions = []
  if (args.urlContains) conditions.push({ kind: 'url', value: String(args.urlContains) })
  if (args.textContains) conditions.push({ kind: 'text', value: String(args.textContains) })

  const started = Date.now()
  if (conditions.length === 0) {
    const ms = Math.min(timeout, requestedMs || 1000)
    await page.waitForTimeout(ms)
    return { ok: true, waitedMs: ms }
  }

  while (Date.now() - started < timeout) {
    for (const condition of conditions) {
      if (condition.kind === 'url' && page.url().includes(condition.value)) {
        return { ok: true, matched: `url 包含 ${condition.value}`, waitedMs: Date.now() - started }
      }
      if (condition.kind === 'text') {
        const found = await page
          .evaluate((needle) => (document.body ? document.body.innerText.includes(needle) : false), condition.value)
          .catch(() => false)
        if (found) return { ok: true, matched: `正文包含 ${condition.value}`, waitedMs: Date.now() - started }
      }
    }
    await page.waitForTimeout(250)
  }
  return { ok: false, timedOut: true, waitedMs: Date.now() - started, hint: '条件未满足，请 edge_observe 看当前页面状态' }
}
