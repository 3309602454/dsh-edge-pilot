import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  join(process.env.LOCALAPPDATA || '', 'Microsoft\\Edge\\Application\\msedge.exe'),
]

export function defaultConfig(overrides = {}) {
  const home = homedir()
  const merged = {
    executablePath: '',
    userDataDir: join(home, '.dsh', 'edge-pilot', 'profile'),
    cdpUrl: '',
    headless: false,
    viewportWidth: 1440,
    viewportHeight: 900,
    downloadsDir: '',
    maxElements: 200,
    actionTimeoutMs: 15000,
    navTimeoutMs: 45000,
    textDigestChars: 1200,
    autoAcceptDialogs: true,
    allowDomains: [],
    denyDomains: [],
    // 标签页清理：插件自己开的标签页用「保留最近 N 个」的策略回收，
    // closeAllOnExit 在关闭浏览器前把插件开过的页面全关掉，避免下次启动被还原。
    maxTabs: 5,
    closeAllOnExit: true,
    // 空闲多久后自动回收标签页（毫秒）。0 = 关闭空闲回收。
    idleCleanupMs: 180000,
    // 这些标签页不参与自动回收（用户可能正在看）。
    keepTabPatterns: [],
    // 技能（固化流程）存放目录，留空用 ~/.dsh/edge-pilot/skills。
    skillsDir: '',
    locale: 'zh-CN',
    ...overrides,
  }
  if (!merged.downloadsDir) merged.downloadsDir = resolve(process.cwd(), 'downloads')
  if (!merged.userDataDir) merged.userDataDir = join(home, '.dsh', 'edge-pilot', 'profile')
  return merged
}

export function detectEdgePath() {
  for (const candidate of EDGE_CANDIDATES) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return ''
}

function hostMatches(host, rule) {
  const clean = String(rule || '').trim().toLowerCase().replace(/^\./, '')
  if (!clean) return false
  return host === clean || host.endsWith('.' + clean)
}

/** Domain policy check. Empty allowDomains means "allow every domain". */
export function assertDomainAllowed(rawUrl, config) {
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    return
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return
  const host = url.hostname.toLowerCase()
  const deny = (config.denyDomains || []).filter(Boolean)
  const allow = (config.allowDomains || []).filter(Boolean)
  if (deny.some((rule) => hostMatches(host, rule))) {
    throw new Error(`域名 ${host} 在 denyDomains 黑名单中，已拦截`)
  }
  if (allow.length > 0 && !allow.some((rule) => hostMatches(host, rule))) {
    throw new Error(`域名 ${host} 不在 allowDomains 白名单中，已拦截`)
  }
}

export function normalizeUrl(input) {
  const raw = String(input || '').trim()
  if (!raw) throw new Error('url 不能为空')
  if (/^(https?|file|about|data|chrome|edge):/i.test(raw)) return raw
  if (/^localhost(:\d+)?(\/|$)/i.test(raw) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(raw)) {
    return 'http://' + raw
  }
  if (raw.startsWith('//')) return 'https:' + raw
  return 'https://' + raw
}

/** Safe file name for downloads and save-as targets. */
export function safeFileName(name, fallback = 'file') {
  const base = String(name || '')
    .split(/[\\/]/)
    .pop()
    .replace(/[<>:"|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
  const cleaned = base.replace(/^\.+/, '').slice(0, 120)
  return cleaned || fallback
}

/** Reject path traversal: every explicit path must stay inside the allowed roots. */
export function assertInsideRoots(targetPath, roots) {
  const target = resolve(targetPath)
  const allowed = roots.filter(Boolean).map((root) => resolve(root))
  const ok = allowed.some((root) => {
    const withSep = root.endsWith(sep) ? root : root + sep
    return target === root || target.startsWith(withSep)
  })
  if (!ok) {
    throw new Error(`目标路径 ${target} 不在允许的目录内：${allowed.join(' | ')}`)
  }
  return target
}
