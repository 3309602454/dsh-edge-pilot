import { mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { detectEdgePath, safeFileName } from './config.js'

const MAX_EVENTS = 40
const MAX_DOWNLOADS = 30

function uniquePath(dir, fileName) {
  const dot = fileName.lastIndexOf('.')
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName
  const ext = dot > 0 ? fileName.slice(dot) : ''
  let candidate = join(dir, fileName)
  let i = 1
  while (existsSync(candidate)) {
    candidate = join(dir, `${stem}-${i}${ext}`)
    i += 1
    if (i > 500) break
  }
  return candidate
}

/**
 * One Edge instance per plugin lifetime. Headful by default so the user can see
 * what the agent is doing; profile is persisted so a single manual login lasts.
 */
export class EdgeSession {
  constructor(config, logger = console) {
    this.config = config
    this.logger = logger
    this.context = null
    this.browser = null
    this.mode = '' // 'launch' | 'attach'
    this.activePage = null
    /** @type {Map<string, {frameIndex:number, ref:string, role:string, name:string}>} */
    this.refs = new Map()
    this.refSeq = 0
    this.downloads = []
    this.events = []
    this.dialogs = []
    this.consoleErrors = []
    this.launching = null
    this.idleTimer = null
  }

  get isAttached() {
    return Boolean(this.config.cdpUrl)
  }

  pushEvent(text) {
    this.events.push({ at: Date.now(), text })
    if (this.events.length > MAX_EVENTS) this.events.shift()
  }

  async ensure() {
    if (this.context) return this
    if (this.launching) {
      await this.launching
      return this
    }
    this.launching = this.isAttached ? this.attach() : this.launch()
    try {
      await this.launching
    } finally {
      this.launching = null
    }
    return this
  }

  /**
   * 删掉 Edge 的会话还原文件（Default/Sessions/Tabs_* 与 Session_*）。
   * 这些文件是「上次开过哪些标签页」的唯一来源，删了就不会被还原。
   * 只在浏览器未运行时才安全——launch() 之前调用正合适。
   */
  async purgeSessionFiles() {
    const sessionsDir = join(this.config.userDataDir, 'Default', 'Sessions')
    let removed = 0
    try {
      if (!existsSync(sessionsDir)) return { removed: 0, dir: sessionsDir }
      const entries = await readdir(sessionsDir).catch(() => [])
      for (const fileName of entries) {
        if (!/^(Tabs|Session)_/.test(fileName)) continue
        try {
          await unlink(join(sessionsDir, fileName))
          removed += 1
        } catch {
          /* 被占用就跳过，靠启动后的 pruneTabs 兜底 */
        }
      }
    } catch {
      /* 读不到就算了，不影响启动 */
    }
    if (removed > 0) this.pushEvent(`已清理 ${removed} 个会话还原文件`)
    return { removed, dir: sessionsDir }
  }

  async launch() {
    await mkdir(this.config.userDataDir, { recursive: true })
    await mkdir(this.config.downloadsDir, { recursive: true })
    // 关键：先清掉上次残留的会话文件，否则 Edge 会把上次开的标签页全还原出来。
    const purged = await this.purgeSessionFiles()
    const options = {
      headless: Boolean(this.config.headless),
      viewport: {
        width: Number(this.config.viewportWidth) || 1440,
        height: Number(this.config.viewportHeight) || 900,
      },
      acceptDownloads: true,
      downloadsPath: this.config.downloadsDir,
      locale: this.config.locale || 'zh-CN',
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-blink-features=AutomationControlled',
        '--hide-crash-restore-bubble',
        // 与 chatgpt.js 保持一致：从 feature 层面关掉会话还原，比软开关彻底
        '--disable-session-crashed-bubble',
        '--disable-features=SessionRestore',
        '--no-restore-last-session',
      ],
      ignoreDefaultArgs: ['--enable-automation'],
      timeout: 60000,
    }

    let context
    const explicit = this.config.executablePath
    const detected = explicit || detectEdgePath()
    const attempts = []
    if (explicit) attempts.push({ executablePath: explicit })
    attempts.push({ channel: 'msedge' })
    if (detected) attempts.push({ executablePath: detected })

    let lastError = null
    for (const attempt of attempts) {
      try {
        context = await chromium.launchPersistentContext(this.config.userDataDir, { ...options, ...attempt })
        lastError = null
        break
      } catch (error) {
        lastError = error
        const message = String(error?.message || error)
        if (/ProcessSingleton|already in use|being used by another/i.test(message)) {
          throw new Error(
            `Edge 数据目录被占用（${this.config.userDataDir}）。请关闭由此插件启动的 Edge 窗口后重试，或改用 cdpUrl 接管已有浏览器。`,
          )
        }
      }
    }
    if (!context) {
      throw new Error(`无法启动系统 Edge：${lastError?.message || '未知错误'}`)
    }

    this.context = context
    this.mode = 'launch'
    this.bind(context)

    // 上次遗留的标签页会被 Edge 的「继续上次会话」还原出来，
    // 启动后立刻清场，避免越攒越多。
    const swept = await this.pruneTabs({ maxTabs: 1, reason: '启动清场' })
    if (swept.closed > 0) {
      this.pushEvent(`清理了 ${swept.closed} 个上次遗留的标签页（${swept.before} → ${swept.after}）`)
    }

    this.pushEvent(`Edge 已启动（headless=${Boolean(this.config.headless)}）`)
    return this
  }

  async attach() {
    const browser = await chromium.connectOverCDP(this.config.cdpUrl, { timeout: 20000 })
    const context = browser.contexts()[0] || (await browser.newContext())
    this.browser = browser
    this.context = context
    this.mode = 'attach'
    this.bind(context)
    this.pushEvent(`已接管 CDP ${this.config.cdpUrl}`)
    return this
  }

  bind(context) {
    context.on('close', () => {
      this.context = null
      this.activePage = null
      this.pushEvent('浏览器已关闭')
    })
    for (const page of context.pages()) this.attachPage(page)
    context.on('page', (page) => {
      this.attachPage(page)
      this.activePage = page
      this.pushEvent(`新标签页：${page.url()}`)
    })
  }

  attachPage(page) {
    if (page.__dshEdgeBound) return
    page.__dshEdgeBound = true
    page.on('dialog', async (dialog) => {
      this.dialogs.push({ at: Date.now(), type: dialog.type(), message: dialog.message() })
      this.pushEvent(`弹窗(${dialog.type()})：${dialog.message()}`)
      try {
        if (this.config.autoAcceptDialogs) await dialog.accept()
        else await dialog.dismiss()
      } catch {
        /* dialog already gone */
      }
    })
    page.on('download', async (download) => {
      try {
        const suggested = safeFileName(download.suggestedFilename(), 'download')
        const target = uniquePath(this.config.downloadsDir, suggested)
        await download.saveAs(target)
        const record = {
          at: Date.now(),
          name: suggested,
          path: target,
          url: download.url(),
          failure: await download.failure(),
        }
        this.downloads.push(record)
        if (this.downloads.length > MAX_DOWNLOADS) this.downloads.shift()
        this.pushEvent(`下载完成：${suggested}`)
      } catch (error) {
        this.pushEvent(`下载失败：${error?.message || error}`)
      }
    })
    page.on('console', (message) => {
      if (message.type() !== 'error') return
      this.consoleErrors.push({ at: Date.now(), url: page.url(), text: message.text().slice(0, 300) })
      if (this.consoleErrors.length > MAX_EVENTS) this.consoleErrors.shift()
    })
    page.on('close', () => {
      if (this.activePage === page) this.activePage = null
    })
  }

  async tabs() {
    const pages = this.context ? this.context.pages() : []
    const active = this.currentPage()
    const out = []
    for (let index = 0; index < pages.length; index += 1) {
      const page = pages[index]
      let title = ''
      try {
        title = await page.title()
      } catch {
        /* page may be closing */
      }
      out.push({ index, url: page.url(), title, active: page === active })
    }
    return out
  }

  currentPage() {
    if (this.activePage && !this.activePage.isClosed()) return this.activePage
    const pages = this.context ? this.context.pages() : []
    if (pages.length === 0) return null
    this.activePage = pages[pages.length - 1]
    return this.activePage
  }

  async requirePage() {
    await this.ensure()
    const page = this.currentPage()
    if (!page) {
      const created = await this.context.newPage()
      this.attachPage(created)
      this.activePage = created
      return created
    }
    return page
  }

  resetRefs() {
    this.refs.clear()
    this.refSeq = 0
  }

  /**
   * 标签页回收。keep 规则（按优先级）：
   *   1. 地址命中 keepTabPatterns 的一律保留（用户可能正在看）
   *   2. about:blank / edge://newtab 这类空白页优先关
   *   3. 其余按「最久没被当前会话碰过」从旧到新关
   * 永远至少留 1 个标签页，否则 context 会被浏览器判为关闭。
   *
   * @param {{maxTabs?:number, keepActive?:boolean, reason?:string}} options
   */
  async pruneTabs(options = {}) {
    const pages = this.context ? this.context.pages() : []
    const before = pages.length
    if (before === 0) return { before: 0, after: 0, closed: 0, kept: [] }

    const limit = Math.max(1, Number(options.maxTabs ?? this.config.maxTabs) || 1)
    const active = this.currentPage()
    const patterns = (this.config.keepTabPatterns || []).filter(Boolean)

    const isProtected = (page) => {
      if (options.keepActive !== false && page === active) return true
      const url = String(page.url() || '')
      return patterns.some((rule) => url.includes(String(rule)))
    }
    const isBlank = (page) => {
      const url = String(page.url() || '')
      return url === '' || url === 'about:blank' || /^edge:\/\/(newtab|startup)/i.test(url)
    }

    const candidates = pages.filter((page) => !isProtected(page))

    // 要关掉多少：除了受保护页面，还得多关到总数 <= limit
    const protectedCount = pages.length - candidates.length
    let needClose = Math.max(0, pages.length - limit)
    needClose = Math.min(needClose, candidates.length)
    if (needClose === 0) {
      return { before, after: before, closed: 0, kept: pages.map((p) => p.url()), reason: options.reason }
    }

    // 排序：空白页最先关，其余保持原顺序（越靠前越旧）
    const ordered = [...candidates].sort((a, b) => Number(isBlank(b)) - Number(isBlank(a)))
    const toClose = ordered.slice(0, needClose)

    let closed = 0
    const failures = []
    for (const page of toClose) {
      try {
        await page.close()
        closed += 1
      } catch (error) {
        failures.push(String(error?.message || error))
      }
    }

    if (this.activePage && this.activePage.isClosed()) this.activePage = null
    this.resetRefs()

    const after = this.context ? this.context.pages().length : 0
    this.pushEvent(
      `标签页回收${options.reason ? `（${options.reason}）` : ''}：${before} → ${after}，关闭 ${closed} 个` +
        (failures.length ? `，${failures.length} 个失败` : ''),
    )
    return { before, after, closed, keptProtected: protectedCount, failures, reason: options.reason }
  }

  /** 打开新标签页后立刻做一次限额，避免一次任务开几十个。 */
  async openTab(url) {
    const page = await this.context.newPage()
    this.attachPage(page)
    this.activePage = page
    if (url) {
      await page.goto(String(url), { timeout: this.config.navTimeoutMs, waitUntil: 'domcontentloaded' })
    }
    await this.pruneTabs({ reason: '新标签页限额' })
    return page
  }

  /**
   * 每次工具调用都敲一下，重置空闲计时器。
   * 空闲有头浏览器留着给人看是合理的，但标签页不该无限攒——
   * 空闲到点后自动回收，免得下次启动又摊一堆。
   */
  touch() {
    const ms = Number(this.config.idleCleanupMs) || 0
    if (ms <= 0) return
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (!this.context) return
      this.pruneTabs({ reason: `空闲 ${Math.round(ms / 1000)}s 自动回收` })
        .then((result) => {
          if (result.closed > 0) {
            this.logger?.info?.(`[dsh-edge-pilot] 空闲回收了 ${result.closed} 个标签页`)
          }
        })
        .catch(() => {
          /* 空闲清理失败不影响下次调用 */
        })
    }, ms)
    // 不要因为这个定时器把宿主进程吊住不退出
    if (typeof this.idleTimer.unref === 'function') this.idleTimer.unref()
  }

  stopIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  nextRef() {
    this.refSeq += 1
    return `e${this.refSeq}`
  }

  recentDownloads(sinceMs = 0) {
    return this.downloads.filter((item) => item.at >= sinceMs)
  }

  async state() {
    const page = this.currentPage()
    return {
      launched: Boolean(this.context),
      mode: this.mode,
      headless: Boolean(this.config.headless),
      userDataDir: this.config.userDataDir,
      downloadsDir: this.config.downloadsDir,
      url: page ? page.url() : '',
      title: page ? await pageTitle(page) : '',
      tabs: await this.tabs(),
      recentEvents: this.events.slice(-8),
    }
  }

  async close({ kill = false } = {}) {
    this.resetRefs()
    this.stopIdleTimer()
    if (!this.context) return { closed: false }
    const context = this.context

    // 关浏览器前先把标签页清干净，这样 Edge 落盘的会话是空的，
    // 下次启动就没有东西可还原。接管模式（attach）不动用户的标签页。
    let swept = null
    if (this.mode !== 'attach' && this.config.closeAllOnExit !== false) {
      try {
        const pages = context.pages()
        let closedCount = 0
        for (const page of pages) {
          try {
            await page.close()
            closedCount += 1
          } catch {
            /* 已经在关 */
          }
        }
        swept = { before: pages.length, closed: closedCount }
        if (closedCount > 0) this.pushEvent(`退出前关闭了 ${closedCount} 个标签页`)
      } catch {
        /* 清不动就正常关 */
      }
    }
    this.context = null
    this.activePage = null
    try {
      if (this.mode === 'attach') {
        // 接管模式：默认只是断开 CDP，不动用户正在用的浏览器；
        // kill=true 才通过 CDP 的 Browser.close 真把它关掉。
        if (this.browser) {
          if (kill) {
            const cdp = await this.browser.newBrowserCDPSession().catch(() => null)
            if (cdp) await cdp.send('Browser.close').catch(() => {})
          }
          await this.browser.close().catch(() => {})
        }
      } else {
        // 独立实例：context.close() 就把整个浏览器关掉了，不用再动 browser。
        await context.close()
      }
    } catch (error) {
      this.logger?.warn?.(`[dsh-edge-pilot] close failed: ${error?.message || error}`)
    }
    this.browser = null
    this.pushEvent('会话已释放')
    return { closed: true, swept }
  }
}

export async function pageTitle(page) {
  try {
    return await page.title()
  } catch {
    return ''
  }
}
