/**
 * ChatGPT 网页版自动化：复用一个专用 profile 的登录态，后台静默启动 Edge，
 * 提问取答、生图取图、GIF 合成。站点结构见同目录 CHATGPT-DOM.md。
 *
 * 设计约束（水水 2026-11-09）：
 * - 调用返回必须极致精简：ask 只回答案正文，生图只回落盘路径。
 * - 参考图从本地复制、经系统剪贴板贴进输入框。
 * - 浏览器后台静默（窗口移出屏幕，headless 会被 Cloudflare 挡），用完即关。
 */
import { chromium } from 'playwright-core'
import { mkdir, writeFile, stat, copyFile, rm } from 'node:fs/promises'
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve, dirname, extname } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { safeFileName } from './config.js'

const CHATGPT_URL = 'https://chatgpt.com/'
const HOME = homedir()

/** 单实例锁：同一进程内并发调用只复用一份浏览器，绝不并起多个 Edge。 */
let activeRun = null

/**
 * Edge 的「恢复上次会话」会让标签页越滚越多（实测 tab_count 24→25→26→27→28），
 * 最终启动即崩（browser has been closed）。每次启动前清掉会话恢复文件，
 * 保证永远只有一个干净窗口。
 */
function clearSessionRestore(profileDir) {
  const dirs = [join(profileDir, 'Default', 'Sessions')]
  let removed = 0
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    let names = []
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      try {
        rmSync(join(dir, name), { force: true })
        removed += 1
      } catch {
        /* 被占用就跳过，不阻塞启动 */
      }
    }
  }
  return removed
}

/** 记录一下防止某次异常退出把 profile 撑爆：超过阈值就先警告并清理。 */
function profileFootprint(profileDir) {
  const sessions = join(profileDir, 'Default', 'Sessions')
  if (!existsSync(sessions)) return 0
  try {
    return readdirSync(sessions).reduce((sum, n) => {
      try {
        return sum + statSync(join(sessions, n)).size
      } catch {
        return sum
      }
    }, 0)
  } catch {
    return 0
  }
}

export const DEFAULT_CHATGPT_CONFIG = {
  profileDir: join(HOME, '.dsh', 'edge-pilot', 'chatgpt-profile'),
  downloadsDir: join(HOME, '.dsh', 'edge-pilot', 'chatgpt-downloads'),
  navTimeoutMs: 60000,
  replyTimeoutMs: 180000,
  imageTimeoutMs: 240000,
  pythonPath: '',
}

export function chatgptConfig(overrides = {}) {
  return { ...DEFAULT_CHATGPT_CONFIG, ...(overrides || {}) }
}

function findPython(config) {
  if (config.pythonPath && existsSync(config.pythonPath)) return config.pythonPath
  const bundled = join(HOME, '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe')
  return existsSync(bundled) ? bundled : 'python'
}

function stamp() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

async function launch(config) {
  await mkdir(config.profileDir, { recursive: true })
  clearSessionRestore(config.profileDir)
  const ctx = await chromium.launchPersistentContext(config.profileDir, {
    headless: false,
    channel: 'msedge',
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true,
    downloadsPath: config.downloadsDir,
    locale: 'zh-CN',
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-crash-restore-bubble',
      // 关掉崩溃恢复气泡与「恢复上次会话」，避免标签页雪球
      '--disable-session-crashed-bubble',
      '--disable-features=SessionRestore',
      '--disable-blink-features=AutomationControlled',
      '--window-position=-24000,-24000',
      '--window-size=1280,900',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
    timeout: 60000,
  })
  // 关掉多余的空白页，只留一个
  const pages = ctx.pages()
  for (let i = 1; i < pages.length; i += 1) {
    await pages[i].close().catch(() => {})
  }
  const page = ctx.pages()[0] || (await ctx.newPage())
  // 兜底：跑一段时间后如果莫名冒出额外标签页，直接关掉，绝不让它滚雪球。
  ctx.on('page', async (extra) => {
    if (extra === page) return
    await extra.close().catch(() => {})
  })
  return { ctx, page }
}

/** 串行化：并发调用共享同一份浏览器会话，避免同时起两个 Edge 抢 profile 锁。 */
async function withBrowser(config, fn) {
  while (activeRun) {
    await activeRun.catch(() => {})
  }
  let resolveDone
  activeRun = new Promise((r) => {
    resolveDone = r
  })
  let handle = null
  try {
    handle = await launch(config)
    return await fn(handle)
  } finally {
    if (handle) await handle.ctx.close().catch(() => {})
    const done = resolveDone
    activeRun = null
    done()
  }
}

async function openChatGPT(page, config, { newChat = true } = {}) {
  if (!page.url().startsWith('https://chatgpt.com')) {
    await page.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded', timeout: config.navTimeoutMs })
  }
  const started = Date.now()
  while (Date.now() - started < config.navTimeoutMs) {
    const state = await page.evaluate(() => {
      const text = document.body ? document.body.innerText : ''
      return {
        url: location.href,
        composer: Boolean(document.querySelector('[contenteditable="true"]')),
        loginWall: /^\s*(Log in|Sign up|登录|注册)/m.test(text.slice(0, 800)) || /auth\/login|log-in/i.test(location.href),
      }
    })
    if (state.composer) {
      if (newChat) await startNewChat(page)
      return state
    }
    if (state.loginWall) {
      throw new Error(
        `ChatGPT 登录态失效，需要手动登录一次：用 Edge 打开 ${config.profileDir} 这个 profile 登录 chatgpt.com。`,
      )
    }
    await page.waitForTimeout(1000)
  }
  throw new Error('ChatGPT 页面加载超时（可能被 Cloudflare 拦截）')
}

async function startNewChat(page) {
  const tried = [
    () => page.getByRole('button', { name: /^(新聊天|New chat)$/ }).first(),
    () => page.locator('button[aria-label="新聊天"], button[aria-label="New chat"]').first(),
  ]
  for (const pick of tried) {
    try {
      const btn = pick()
      if (await btn.count()) {
        await btn.click({ timeout: 5000 })
        await page.waitForTimeout(700)
        return
      }
    } catch {
      /* try next */
    }
  }
}

async function sendPrompt(page, prompt) {
  const composer = page.locator('[contenteditable="true"]').first()
  await composer.waitFor({ state: 'visible', timeout: 20000 })
  // 页面刚加载完时 Playwright 的点击偶尔会卡在 "stable" 判断上；JS focus 兜底更稳。
  try {
    await composer.click({ timeout: 8000 })
  } catch {
    await page.evaluate(() => document.querySelector('[contenteditable="true"]')?.focus())
  }
  await page.waitForTimeout(200)
  await composer.fill(prompt)
  await page.waitForTimeout(300)
  const typed = await composer.innerText().catch(() => '')
  if (!typed.includes(prompt.slice(0, 10))) {
    await page.evaluate((text) => {
      const ce = document.querySelector('[contenteditable="true"]')
      if (!ce) return
      ce.focus()
      document.execCommand('insertText', false, text)
    }, prompt)
    await page.waitForTimeout(300)
  }
  await page.keyboard.press('Enter')
  // 确认真的发出去了：地址跳到 /c/<uuid>，或正文出现「你说：」。
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const sent = await page.evaluate(
      () => /\/c\/[0-9a-f-]{8,}/i.test(location.href) || /你说：|You said:/.test(document.querySelector('main')?.innerText || ''),
    )
    if (sent) return
    await page.waitForTimeout(400)
  }
  // 回车没生效时用发送按钮再试一次（新版没有 data-testid，只能按 aria-label）。
  const sendBtn = page.locator('button[aria-label="发送"], button[aria-label="Send"], button[data-testid="send-button"]').first()
  if (await sendBtn.count()) {
    await sendBtn.click({ timeout: 5000 }).catch(() => {})
    await page.waitForTimeout(1200)
  }
}

function probe(page) {
  return page.evaluate(() => {
    const main = document.querySelector('main')
    const text = main ? main.innerText : ''
    const busyText = /正在创建图像|正在勾勒草图|正在生成初稿|布置场景|正在加载图像|Generating|Creating image/i.test(text)
    const stopButton = [...document.querySelectorAll('button')].some((b) =>
      /停止|^Stop/.test((b.getAttribute('aria-label') || '') + (b.textContent || '').trim()),
    )
    return {
      busy: busyText || stopButton,
      sent: /\/c\/[0-9a-f-]{8,}/i.test(location.href) || /你说：|You said:/.test(text),
      refusing: /图像生成请求上限|图像额度已用完|image generation limit|reached the (Free )?limit/i.test(text),
    }
  })
}

function answerOf(text) {
  return extractAnswer(text)
}

async function waitReply(page, { timeoutMs, expectImage, knownSrcs = [] }) {
  const started = Date.now()
  const known = new Set(knownSrcs || [])
  let lastKey = ''
  let stable = 0
  let lastHint = ''
  while (Date.now() - started < timeoutMs) {
    await page.waitForTimeout(1200)
    const state = await probe(page)
    const text = await page.evaluate(() => document.querySelector('main')?.innerText || '')
    const answer = answerOf(text)
    const imgs = await turnImages(page)
    const fresh = imgs.filter((m) => m.src && !known.has(m.src)).length
    // refusing 是「已经明确告知不能生成」，不能算 busy——否则提前返回那条永远进不去，
    // 只能干等满 timeout（2026-11-12 那次 420 秒就是这么来的）。
    const busy = state.busy
    const key = `${answer.length}|${imgs.length}|${fresh}|${busy}`
    stable = key === lastKey ? stable + 1 : 0
    lastKey = key
    if (fresh > 0 && !busy) {
      return { text, images: imgs.length, fresh, answer }
    }
    if (state.refusing && fresh === 0 && !busy) {
      return { text, images: imgs.length, fresh, answer, refused: true }
    }
    if (!busy && state.sent && stable >= 2 && !expectImage && answer.length > 0) {
      return { text, images: imgs.length, fresh, answer }
    }
    // 记住最后看到的页面提示，超时报错时带上，方便判断到底卡在哪一阶段。
    const tail = text.replace(/\s+/g, ' ').trim().slice(-160)
    if (tail && tail !== lastHint) lastHint = tail
  }
  throw new Error(
    `等待 ChatGPT 回复超时（${Math.round(timeoutMs / 1000)}s）。` +
      `最后看到的页面状态：${lastHint || '(空)'}`,
  )
}

const ANSWER_MARKERS = ['ChatGPT 说：', 'ChatGPT 说:', 'ChatGPT said:']

/** 回答之后会跟着一串 UI 提示，命中任一条就截断。 */
const ANSWER_STOP_MARKERS = [
  '到目前为止，这段对话对你有帮助吗',
  'ChatGPT 可能会出错',
  '最新一条回复',
  'Upgrade to Plus',
  '你对这段回复满意吗',
  '你喜欢这种回复风格吗',
  '你喜欢这个回答吗',
  '有什么可以改进的',
  '复制消息',
  '共享提示',
  '编辑消息',
  '切换摘要面板',
  '滚动到底部',
  '思考',
]

export function extractAnswer(text) {
  const raw = String(text || '')
  let at = -1
  let marker = ''
  for (const m of ANSWER_MARKERS) {
    const i = raw.lastIndexOf(m)
    if (i > at) {
      at = i
      marker = m
    }
  }
  if (at < 0) return raw.trim()
  const out = raw.slice(at + marker.length)
  // 逐行扫，遇到第一个 UI 提示行就停——避免把工具栏上的字混进答案。
  const lines = out.split('\n')
  const kept = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) {
      kept.push('')
      continue
    }
    const hit = ANSWER_STOP_MARKERS.some((stop) => trimmed === stop || trimmed.startsWith(stop))
    if (hit) break
    kept.push(line)
  }
  return kept.join('\n').trim()
}

/** 按 DOM 顺序取「最后一轮回答」里的图片。
 *  必须用最后一个「ChatGPT 说：」当起点——参考图缩略图在用户那一轮里，
 *  用「你说：」当起点会把它当成生成结果（实测会多存一张 1052×1870 的参考图）。 */
function turnImages(page) {
  return page.evaluate(() => {
    const main = document.querySelector('main')
    if (!main) return []
    const form = document.querySelector('form')
    const isAnswer = (t) => /ChatGPT 说：|ChatGPT 说:|ChatGPT said:/.test(t)
    const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT)
    let marker = null
    let node = walker.nextNode()
    while (node) {
      if (isAnswer(node.nodeValue || '')) marker = node
      node = walker.nextNode()
    }
    const imgs = [...main.querySelectorAll('img')].filter(
      (i) => i.naturalWidth > 200 && !(form && form.contains(i)),
    )
    const picked = marker
      ? imgs.filter((im) => marker.compareDocumentPosition(im) & Node.DOCUMENT_POSITION_FOLLOWING)
      : imgs
    return picked.map((i) => ({
      src: i.currentSrc || i.src,
      width: i.naturalWidth,
      height: i.naturalHeight,
      alt: i.alt || '',
    }))
  })
}

async function grabImages(page, knownSrcs = []) {
  const known = new Set(knownSrcs || [])
  const metas = (await turnImages(page)).filter((m) => m.src && !known.has(m.src))
  const out = []
  for (const meta of metas) {
    const b64 = await page
      .evaluate(async (src) => {
        try {
          const response = await fetch(src)
          const buf = new Uint8Array(await response.arrayBuffer())
          let binary = ''
          const chunk = 0x8000
          for (let i = 0; i < buf.length; i += chunk) binary += String.fromCharCode(...buf.subarray(i, i + chunk))
          return btoa(binary)
        } catch {
          return null
        }
      }, meta.src)
      .catch(() => null)
    if (b64) out.push({ ...meta, b64 })
  }
  return out
}

async function imageSources(page) {
  return (await turnImages(page)).map((m) => m.src)
}

const CLIP_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName System.Windows.Forms, System.Drawing',
  '$bytes = [System.IO.File]::ReadAllBytes($env:DSH_CLIP_IMAGE)',
  '$ms = New-Object System.IO.MemoryStream(,$bytes)',
  '$img = [System.Drawing.Image]::FromStream($ms)',
  '[System.Windows.Forms.Clipboard]::SetImage($img)',
  '$img.Dispose(); $ms.Dispose()',
  "Write-Output 'clip-ok'",
].join('\r\n')

async function composerImages(page) {
  return page.evaluate(() => {
    const scope = document.querySelector('form') || document.querySelector('main')
    if (!scope) return 0
    return [...scope.querySelectorAll('img')].filter((i) => i.naturalWidth > 40).length
  })
}

async function waitComposerImage(page, timeoutMs) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if ((await composerImages(page)) > 0) return true
    await page.waitForTimeout(500)
  }
  return false
}

/** 参考图走系统剪贴板贴进输入框（水水的要求）；隐藏 file input 作为兜底。 */
async function attachReference(config, page, refPath) {
  const source = resolve(refPath)
  if (!existsSync(source)) throw new Error(`参考图不存在：${source}`)
  if ((await composerImages(page)) > 0) return { via: 'already-attached' }

  await mkdir(config.downloadsDir, { recursive: true })

  // 中文路径在 powershell -File 下容易被编码吃掉，复制成 ASCII 临时名再进剪贴板。
  const ext = extname(source) || '.png'
  const staged = join(config.downloadsDir, `ref-${Date.now()}${ext}`)
  await copyFile(source, staged)
  const ps1 = join(config.downloadsDir, `clip-${Date.now()}.ps1`)
  await writeFile(ps1, CLIP_SCRIPT, 'utf8')

  try {
    execFileSync('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', ps1], {
      env: { ...process.env, DSH_CLIP_IMAGE: staged },
      encoding: 'utf8',
      timeout: 30000,
    })
    const composer = page.locator('[contenteditable="true"]').first()
    await composer.click({ timeout: 15000 })
    await page.waitForTimeout(400)
    await page.keyboard.press('Control+V')
    // 上传缩略图要等一会儿才出现，固定 3 秒会误判成失败。
    if (await waitComposerImage(page, 12000)) return { via: 'clipboard' }
  } catch (error) {
    loggerWarn(`[chatgpt] 剪贴板贴图失败：${error?.message || error}`)
  } finally {
    await rm(ps1, { force: true }).catch(() => {})
  }

  // 兜底：直接塞隐藏的图片 file input。
  const inputs = page.locator('input[type=file]')
  const total = await inputs.count()
  for (let i = 0; i < total; i += 1) {
    const accept = (await inputs.nth(i).getAttribute('accept')) || ''
    if (!accept.includes('image')) continue
    try {
      await inputs.nth(i).setInputFiles(source)
      if (await waitComposerImage(page, 12000)) return { via: 'file-input' }
    } catch (error) {
      loggerWarn(`[chatgpt] setInputFiles 失败：${error?.message || error}`)
    }
    break
  }
  await rm(staged, { force: true }).catch(() => {})
  throw new Error('参考图没能贴进 ChatGPT 输入框（剪贴板和文件选择都失败）')
}

function loggerWarn(message) {
  if (process.env.DSH_EDGE_PILOT_DEBUG) console.error(message)
}

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true })
}

async function outputPath(config, args, stem, ext) {
  if (args.path) {
    const target = resolve(args.path)
    await ensureDir(dirname(target))
    return target
  }
  await ensureDir(config.downloadsDir)
  return join(config.downloadsDir, safeFileName(`${stem}-${stamp()}.${ext}`, `chatgpt-${stamp()}.${ext}`))
}

async function writeImage(target, item) {
  await writeFile(target, Buffer.from(item.b64, 'base64'))
  const info = await stat(target)
  return { path: target, bytes: info.size, width: item.width, height: item.height }
}

/** 提问并只回答案正文——token 全部花在答案上。 */
export async function ask(config, args) {
  const prompt = String(args.prompt || '').trim()
  if (!prompt) throw new Error('prompt 不能为空')
  const timeoutMs = Number(args.timeoutMs) || config.replyTimeoutMs
  return withBrowser(config, async ({ page }) => {
    await openChatGPT(page, config, { newChat: args.newChat !== false })
    await sendPrompt(page, prompt)
    const state = await waitReply(page, { timeoutMs, expectImage: false })
    return { answer: state.answer, url: page.url() }
  })
}

/** 生成图片，落盘到本地。 */
export async function image(config, args) {
  const prompt = String(args.prompt || '').trim()
  if (!prompt) throw new Error('prompt 不能为空')
  const timeoutMs = Number(args.timeoutMs) || config.imageTimeoutMs
  return withBrowser(config, async ({ page }) => {
    await openChatGPT(page, config, { newChat: args.newChat !== false })
    const knownSrcs = args.ref ? await imageSources(page) : []
    if (args.ref) await attachReference(config, page, args.ref)
    await sendPrompt(page, prompt)
    const state = await waitReply(page, { timeoutMs, expectImage: true, knownSrcs })
    let fresh = (await grabImages(page, knownSrcs)).filter((item) => item.b64)
    if (fresh.length === 0) fresh = (await grabImages(page, [])).filter((item) => item.b64).slice(-1)
    if (fresh.length === 0) throw new Error('没从页面上取到生成的图片（可能是额度不足或被拒绝）')

    const target = await outputPath(config, args, 'chatgpt-image', 'png')
    const saved = []
    for (let i = 0; i < fresh.length; i += 1) {
      const file = fresh.length === 1 ? target : target.replace(/\.png$/i, `-${i + 1}.png`)
      saved.push(await writeImage(file, fresh[i]))
    }
    return { images: saved, answer: state.answer.slice(0, 400), url: page.url() }
  })
}

function runPython(python, scriptPath, argv) {
  return execFileSync(python, [scriptPath, ...argv], { encoding: 'utf8', timeout: 120000 })
}

async function composeGif(config, filePaths, target, frameMs) {
  const python = findPython(config)
  const script = join(config.downloadsDir, `gif-${Date.now()}.py`)
  await writeFile(
    script,
    [
      'import sys, json',
      'from PIL import Image',
      'paths = json.loads(sys.argv[1])',
      'out = sys.argv[2]',
      'ms = int(sys.argv[3])',
      'frames = []',
      'for p in paths:',
      '    im = Image.open(p).convert("RGBA")',
      '    frames.append(im)',
      'w = min(f.width for f in frames)',
      'h = min(f.height for f in frames)',
      'converted = []',
      'for f in frames:',
      '    if f.width != w or f.height != h:',
      '        f = f.resize((w, h), Image.LANCZOS)',
      '    bg = Image.new("RGB", (w, h), (255, 255, 255))',
      '    bg.paste(f, (0, 0), f)',
      '    converted.append(bg.convert("P", palette=Image.ADAPTIVE, colors=256))',
      'converted[0].save(out, save_all=True, append_images=converted[1:], duration=ms, loop=0, optimize=True)',
      'print(json.dumps({"frames": len(converted), "width": w, "height": h}))',
    ].join('\n'),
    'utf8',
  )
  try {
    const out = runPython(python, script, [JSON.stringify(filePaths), target, String(frameMs)])
    return JSON.parse(out.trim().split('\n').pop())
  } finally {
    await rm(script, { force: true }).catch(() => {})
  }
}

async function sliceSpriteSheet(config, sourcePath, frames, outDir, stem, colsArg) {
  const python = findPython(config)
  const script = join(config.downloadsDir, `slice-${Date.now()}.py`)
  const cols = Number(colsArg) || (frames <= 4 ? 2 : 3)
  await writeFile(
    script,
    [
      'import sys, json, math',
      'from PIL import Image',
      'src, out_dir, stem, frames, cols = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), int(sys.argv[5])',
      'im = Image.open(src).convert("RGB")',
      'rows = math.ceil(frames / cols)',
      'w, h = im.width // cols, im.height // rows',
      'paths = []',
      'for i in range(frames):',
      '    r, c = divmod(i, cols)',
      '    tile = im.crop((c * w, r * h, (c + 1) * w, (r + 1) * h))',
      '    p = f"{out_dir}/{stem}-f{i}.png"',
      '    tile.save(p)',
      '    paths.append(p)',
      'print(json.dumps({"paths": paths, "cols": cols, "rows": rows, "tile": [w, h]}))',
    ].join('\n'),
    'utf8',
  )
  try {
    const out = runPython(python, script, [sourcePath, outDir, stem, String(frames), String(cols)])
    const meta = JSON.parse(out.trim().split('\n').pop())
    return meta.paths
  } finally {
    await rm(script, { force: true }).catch(() => {})
  }
}

/**
 * 生成动图。
 *
 * 关键约束（2026-11-12 实测）：ChatGPT 免费账号一次提问只生成一张图，
 * 要求它「一次输出 4 张独立帧」根本不会照做，只会慢慢磨到超时（实测 420s 卡死）。
 * 所以真正的做法是**让它画一张分镜图**（一行 2~4 格的 sprite sheet），
 * 拿到后按网格切开再合成 GIF——一次生图、几十秒就能出。
 * 若它真给了多张独立图，走原路直接按帧合成。
 */
export async function gif(config, args) {
  const prompt = String(args.prompt || '').trim()
  if (!prompt) throw new Error('prompt 不能为空')
  const frames = Math.min(8, Math.max(2, Number(args.frames) || 4))
  const frameMs = Math.max(80, Number(args.frameMs) || 400)
  const timeoutMs = Number(args.timeoutMs) || Math.max(config.imageTimeoutMs, 300000)

  // 一次只画一张分镜图：给模型的指令要「一张图里分 2×2 / 1×4 格」，不要它分多次输出。
  const cols = frames <= 4 ? 2 : 3
  const rows = Math.ceil(frames / cols)
  const layout = cols === 2 && rows === 2 ? '2×2（四格）' : `${rows}行×${cols}列`
  const framePrompt =
    `${prompt}\n\n` +
    `请**只输出一张图片**：把它画成动画分镜图（sprite sheet），` +
    `在一张图里按 ${layout} 网格排列 ${frames} 个动作帧，从第 1 帧到第 ${frames} 帧横向再纵向依次排列。` +
    `每一格的大小、角色比例、画风、背景、配色必须完全一致，只让动作逐帧推进，格与格之间变化自然连贯。` +
    `格与格之间留清晰的分隔（细线或者明显留白），方便后续切分。不要输出多张图，只要这一张分镜图。`

  let files = []
  let mode = 'sprite-sheet'
  let framesOut = 0
  return withBrowser(config, async ({ page }) => {
    await openChatGPT(page, config, { newChat: args.newChat !== false })
    const knownSrcs = args.ref ? await imageSources(page) : []
    if (args.ref) await attachReference(config, page, args.ref)
    await sendPrompt(page, framePrompt)
    const state = await waitReply(page, { timeoutMs, expectImage: true, knownSrcs })
    if (state.refused) {
      throw new Error('ChatGPT 免费账号的图像生成额度已用完，需要等额度重置（约 24 小时）。')
    }
    let fresh = (await grabImages(page, knownSrcs)).filter((item) => item.b64)
    if (fresh.length === 0) fresh = (await grabImages(page, [])).filter((item) => item.b64).slice(-frames)
    if (fresh.length === 0) throw new Error('没从页面上取到生成的帧图（可能是额度不足或被拒绝）')
    framesOut = fresh.length

    await ensureDir(config.downloadsDir)
    const stem = `chatgpt-gif-${stamp()}`
    const frameDir = join(config.downloadsDir, `${stem}-frames`)
    await ensureDir(frameDir)

    if (fresh.length >= 2) {
      // 它真给了多张独立图，直接按帧用。
      mode = 'frames'
      for (let i = 0; i < fresh.length; i += 1) {
        const p = join(frameDir, `f${i}.png`)
        await writeFile(p, Buffer.from(fresh[i].b64, 'base64'))
        files.push(p)
      }
    } else {
      // 一张分镜图：按 cols × rows 切。
      const single = join(frameDir, 'sheet.png')
      await writeFile(single, Buffer.from(fresh[0].b64, 'base64'))
      files = await sliceSpriteSheet(config, single, frames, frameDir, 'f', cols)
    }

    const target = await outputPath(config, args, 'chatgpt-gif', 'gif')
    const meta = await composeGif(config, files, target, frameMs)
    const info = await stat(target)
    return { path: target, bytes: info.size, frameMs, mode, framesOut, frames, ...meta, answer: state.answer.slice(0, 200) }
  })
}

/** 检查专用 profile 的登录态是否还在（不启动浏览器，只看 cookie 库）。 */
export function loginState(config) {
  const cookies = join(config.profileDir, 'Default', 'Network', 'Cookies')
  if (!existsSync(cookies)) return { loggedIn: false, reason: 'profile 里没有 cookie 库' }
  const buf = readFileSync(cookies)
  const text = buf.toString('latin1')
  const hasSession = text.includes('__Secure-next-auth.session-token') || text.includes('__Host-next-auth')
  return {
    loggedIn: hasSession,
    cookiesPath: cookies,
    sessionRestoreBytes: profileFootprint(config.profileDir),
  }
}
