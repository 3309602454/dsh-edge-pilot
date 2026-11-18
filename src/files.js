import { mkdir, writeFile, stat, copyFile } from 'node:fs/promises'
import { join, resolve, extname } from 'node:path'
import { assertInsideRoots, safeFileName } from './config.js'
import { locatorFromRef } from './act.js'

function stamp() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

function allowedRoots(session) {
  return [session.config.downloadsDir, process.cwd(), session.config.userDataDir]
}

async function resolveTarget(session, page, args, defaultStem, defaultExt) {
  if (args.path) {
    const resolved = assertInsideRoots(resolve(args.path), allowedRoots(session))
    await mkdir(resolved.replace(/[\\/][^\\/]+$/, ''), { recursive: true })
    return resolved
  }
  await mkdir(session.config.downloadsDir, { recursive: true })
  let stem = defaultStem
  if (args.usePageTitle !== false) {
    const title = await page.title().catch(() => '')
    if (title) stem = safeFileName(title, defaultStem)
  }
  const name = safeFileName(`${stem}-${stamp()}.${defaultExt}`)
  return join(session.config.downloadsDir, name)
}

async function report(path) {
  const info = await stat(path)
  return { path, bytes: info.size, kb: Math.round(info.size / 1024) }
}

async function cdpSnapshot(page) {
  const client = await page.context().newCDPSession(page)
  try {
    const { data } = await client.send('Page.captureSnapshot', { format: 'mhtml' })
    return data
  } finally {
    await client.detach().catch(() => {})
  }
}

function htmlToMarkdown(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level, text) => `\n${'#'.repeat(Number(level))} ${text.trim()}\n`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, text) => `- ${text.trim()}\n`)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export async function saveAs(session, args) {
  const page = await session.requirePage()
  const format = String(args.format || 'mhtml').toLowerCase()
  const extByFormat = { mhtml: 'mhtml', html: 'html', pdf: 'pdf', txt: 'txt', md: 'md', png: 'png', jpeg: 'jpg' }

  if (format === 'resource') {
    const target = args.ref
      ? await (async () => {
          const { locator } = locatorFromRef(session, args.ref)
          const href = await locator.evaluate((el) => el.currentSrc || el.src || el.href || '')
          if (!href) throw new Error(`ref ${args.ref} 上没有 src/href，拿不到资源地址`)
          return href
        })()
      : String(args.url || '')
    if (!target) throw new Error('format=resource 需要 ref 或 url')
    const absolute = new URL(target, page.url()).toString()
    const response = await page.context().request.get(absolute, { timeout: session.config.navTimeoutMs })
    if (!response.ok()) throw new Error(`资源下载失败：HTTP ${response.status()} ${absolute}`)
    const body = await response.body()
    const guessed = extname(new URL(absolute).pathname).replace('.', '') || 'bin'
    const path = await resolveTarget(session, page, args, 'resource', guessed)
    await writeFile(path, body)
    return { ok: true, format, ...(await report(path)), source: absolute }
  }

  const ext = extByFormat[format]
  if (!ext) throw new Error(`不支持的 format：${format}（可用 mhtml/html/pdf/txt/md/png/jpeg/resource）`)

  const path = await resolveTarget(session, page, args, 'page', ext)

  if (format === 'mhtml') {
    const data = await cdpSnapshot(page)
    await writeFile(path, data, 'utf8')
  } else if (format === 'html') {
    await writeFile(path, await page.content(), 'utf8')
  } else if (format === 'pdf') {
    const buffer = await page.pdf({
      format: args.paperSize || 'A4',
      printBackground: true,
      margin: { top: '12mm', bottom: '12mm', left: '10mm', right: '10mm' },
    })
    await writeFile(path, buffer)
  } else if (format === 'md') {
    await writeFile(path, htmlToMarkdown(await page.content()), 'utf8')
  } else if (format === 'txt') {
    const text = await page.evaluate(() => (document.body ? document.body.innerText : ''))
    await writeFile(path, text, 'utf8')
  } else {
    const buffer = await page.screenshot({ fullPage: args.fullPage !== false, type: format === 'jpeg' ? 'jpeg' : 'png' })
    await writeFile(path, buffer)
  }

  return { ok: true, format, url: page.url(), ...(await report(path)) }
}

export async function screenshot(session, args) {
  const page = await session.requirePage()
  const type = args.format === 'jpeg' ? 'jpeg' : 'png'
  const options = { type, fullPage: Boolean(args.fullPage) }
  if (type === 'jpeg') options.quality = 80

  let buffer
  let scope = 'page'
  if (args.ref) {
    const { locator } = locatorFromRef(session, args.ref)
    await locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {})
    buffer = await locator.screenshot({ type, quality: type === 'jpeg' ? 80 : undefined })
    scope = `element ${args.ref}`
  } else {
    buffer = await page.screenshot(options)
  }

  const ext = type === 'jpeg' ? 'jpg' : 'png'
  const path = await resolveTarget(session, page, { path: args.path, usePageTitle: true }, 'shot', ext)
  await writeFile(path, buffer)
  return { ok: true, buffer, path, scope, url: page.url(), ...(await report(path)) }
}

/**
 * Waits for a real download to land on disk. The session-level download handler
 * owns saveAs so there is exactly one writer per file.
 */
export async function download(session, args) {
  const page = await session.requirePage()
  const timeout = Number(args.timeoutMs) || 30000
  const since = Date.now()

  if (args.ref) {
    const { locator } = locatorFromRef(session, args.ref)
    await locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {})
    await locator.click({ timeout: Number(args.timeout) || session.config.actionTimeoutMs })
  } else if (args.url) {
    const target = String(args.url)
    const name = safeFileName(String(args.filename || target.split('/').pop() || 'download'), 'download')
    let httpError = null
    try {
      const response = await page.context().request.get(target, { timeout })
      if (!response.ok()) throw new Error(`直接下载失败：HTTP ${response.status()}`)
      const body = await response.body()
      const path = await resolveTarget(session, page, { path: args.path }, name, 'bin')
      await writeFile(path, body)
      return { ok: true, via: 'http', ...(await report(path)) }
    } catch (error) {
      // Playwright 的 request 走 Node 的 HTTP 栈，TLS 指纹和部分站点要求的
      // cookie/referer 与浏览器不一致，CDN 会直接 ECONNRESET 或超时。
      // 记下错误，回退到「在页面里 fetch → blob → a[download]」让浏览器自己下载。
      httpError = error
    }

    const requestedAt = Date.now()
    const injected = await page
      .evaluate(async ([url, fileName]) => {
        try {
          const response = await fetch(url, { credentials: 'include' })
          if (!response.ok) return { ok: false, message: `fetch 返回 HTTP ${response.status}` }
          const blob = await response.blob()
          const anchor = document.createElement('a')
          anchor.href = URL.createObjectURL(blob)
          anchor.download = fileName
          document.body.appendChild(anchor)
          anchor.click()
          anchor.remove()
          setTimeout(() => URL.revokeObjectURL(anchor.href), 60000)
          return { ok: true, type: blob.type, size: blob.size }
        } catch (error) {
          return { ok: false, message: String((error && error.message) || error) }
        }
      }, [target, name])
      .catch((error) => ({ ok: false, message: String((error && error.message) || error) }))

    if (!injected.ok) {
      throw new Error(
        `直接请求失败（${httpError && httpError.message}），页面内 fetch 也失败（${injected.message}）。`,
      )
    }

    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const hit = session.downloads.find((item) => item.at >= requestedAt)
      if (hit) {
        if (hit.failure) return { ok: false, error: hit.failure, via: 'browser-fallback', ...hit }
        let path = hit.path
        if (args.path) {
          const wanted = assertInsideRoots(resolve(args.path), allowedRoots(session))
          await mkdir(wanted.replace(/[\\/][^\\/]+$/, ''), { recursive: true })
          await copyFile(hit.path, wanted)
          path = wanted
        }
        return { ok: true, via: 'browser-fallback', name: hit.name, url: hit.url, ...(await report(path)) }
      }
      await page.waitForTimeout(250)
    }
    throw new Error(
      `直接请求失败（${httpError && httpError.message}），改用浏览器内下载后 ${timeout}ms 内也没有落盘。`,
    )
  } else if (args.triggerText) {
    await page.getByText(String(args.triggerText), { exact: false }).first().click({
      timeout: Number(args.timeout) || session.config.actionTimeoutMs,
    })
  } else {
    throw new Error('download 需要 ref、url 或 triggerText 之一')
  }

  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const hit = session.downloads.find((item) => item.at >= since)
    if (hit) {
      if (hit.failure) return { ok: false, error: hit.failure, ...hit }
      return { ok: true, via: 'browser-event', name: hit.name, path: hit.path, url: hit.url }
    }
    await page.waitForTimeout(250)
  }
  throw new Error(
    `点击后 ${timeout}ms 内没有观察到下载。可能这个元素不是下载链接，或浏览器弹出了新标签页而不是下载。请 edge_observe 确认页面状态。`,
  )
}

export async function tabs(session, args) {
  await session.ensure()
  const action = String(args.action || 'list')
  const index = Number.isFinite(Number(args.index)) ? Number(args.index) : -1

  if (action === 'list') return { ok: true, tabs: await session.tabs() }

  if (action === 'open') {
    if (!args.url) throw new Error('action=open 需要 url')
    const page = await session.openTab(String(args.url))
    return { ok: true, tabs: await session.tabs(), activeIndex: session.context.pages().indexOf(page) }
  }

  if (action === 'prune' || action === 'cleanup') {
    const result = await session.pruneTabs({
      maxTabs: Number.isFinite(Number(args.keep)) ? Number(args.keep) : undefined,
      keepActive: args.keepActive !== false,
      reason: '手动清理',
    })
    return { ok: true, ...result, tabs: await session.tabs() }
  }

  const pages = session.context.pages()
  if (index < 0 || index >= pages.length) throw new Error(`标签页索引 ${index} 越界，当前共 ${pages.length} 个`)

  if (action === 'switch') {
    const page = pages[index]
    session.activePage = page
    await page.bringToFront()
    await page.waitForTimeout(200)
    return { ok: true, activeIndex: index, url: page.url(), title: await page.title().catch(() => '') }
  }

  if (action === 'close') {
    const page = pages[index]
    await page.close()
    session.activePage = null
    return { ok: true, closed: index, tabs: await session.tabs() }
  }

  if (action === 'closeOthers') {
    const keep = pages[index]
    const closed = []
    for (const page of pages) {
      if (page === keep) continue
      try {
        await page.close()
        closed.push(page.url())
      } catch {
        /* 已经在关 */
      }
    }
    session.activePage = keep
    session.resetRefs()
    return { ok: true, closedCount: closed.length, tabs: await session.tabs() }
  }

  throw new Error(`不支持的 action：${action}（可用 list/open/switch/close/closeOthers/prune）`)
}
