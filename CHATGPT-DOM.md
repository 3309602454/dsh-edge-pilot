# ChatGPT 网页结构备忘（2026-11-09 实测）

> 供 `chatgpt.js` 的选择器使用。ChatGPT 前端改版频繁，类名（`ProseMirror`、`ComposerLayout*`）
> 一律不可依赖；下面的锚点优先用 `aria-label` / 可见文字 / 结构位置。

## 登录态

- 专用 profile：`~/.dsh/edge-pilot/chatgpt-profile`（由 `~/.dsh/edge-pilot/profile` 复制
  `Local State` + `Default/Network/Cookies` + `Default/Preferences` 播种而来）。
- 判定已登录：页面存在 `[contenteditable="true"]`（输入框）。
- 判定掉登录：URL 匹配 `auth/login|log-in`，或正文开头出现 `Log in / Sign up / 登录`。
- 关键 cookie：`__Secure-next-auth.session-token`、`__Host-next-auth.*`（在
  `Default/Network/Cookies` 里能搜到明文域名，值本身加密）。

## Headless 会被挡

`headless: true` 直接卡在标题「请稍候…」，正文空 —— Cloudflare 拦。
解决：`headless: false` + `--window-position=-24000,-24000`（窗口移到屏幕外），
实测正常登录、正常生成，用户看不见窗口。

## 会话恢复会滚雪球（2026-11-12 事故）

**症状**：QQ bot 调 `chatgpt_gif` 连报
`browserType.launchPersistentContext: Target page, context or browser has been closed`
和 `page.waitForTimeout: Target page... has been closed`，
用户看到「打开了很多网页」，怀疑死循环。

**真因不是死循环**，是 Edge 的「恢复上次会话」在累积标签页。证据在
`<profile>/Default/Preferences` 的 `sessions.event_log`：

```
{"type":1,"tab_count":24} → {"type":2,"tab_count":25} →
{"type":1,"tab_count":25} → {"type":2,"tab_count":26} → ... → 28
```

每次启动都把上次的 24 个 chatgpt 标签页恢复回来，再加 1 个，滚到 28 个后
Edge 启动即崩。同时 `Default/Sessions/` 里 `Tabs_*` 文件涨到 1.5–2 MB。
注意 `ctx.pages()` 看不到这些恢复的页（只报 1–2 个 about:blank），
要用 CDP `Target.getTargets` 才看得见那 10 个 chatgpt.com。

**修复**（`src/chatgpt.js`）：
1. 每次启动前 `clearSessionRestore()` 删掉 `Default/Sessions/` 下的文件；
2. 启动参数加 `--disable-session-crashed-bubble`、`--disable-features=SessionRestore`；
3. 启动后关掉多余页，并挂 `ctx.on('page')` 自动关掉后来冒出来的标签页；
4. `withBrowser()` 串行化，并发调用不会同时起两个 Edge 抢 profile 锁。

修复后：连打两次 ask 稳定 15–20 秒，Sessions 文件只剩 12–19 KB。

## 输入框 / 发送

- 输入框：`[contenteditable="true"]`，第一个即是。`ProseMirror` div，用
  `locator.fill(text)` 可写入（不要用 textarea 选择器，没有）。
- 发送：写入后 `keyboard.press('Enter')`。
- 发送按钮无 `data-testid="send-button"`（新版已移除），只能按 Enter。

## 会话正文

- 容器：`main`。
- 正文里带说话人标记：`你说：` / `ChatGPT 说：`（中文界面）。
- 回答位置：最后出现的 `ChatGPT 说：` 之后，到下面任一结束标记之前：
  `到目前为止，这段对话对你有帮助吗` / `ChatGPT 可能会出错` / `最新一条回复`。
- 没有 `[data-message-author-role]`、没有 `article`、没有 `data-testid*="conversation-turn"`
  —— 旧版锚点全部失效，别再找。

## 生成图片

- 生成中会显示百分比 + 文案：`正在创建图像` / `正在勾勒草图` / `正在生成初稿` / `布置场景` /
  `正在加载图像`；同时有 `停止` 按钮。
- 完成后图片：`main img` 里 `naturalWidth > 200` 的那些；`alt` 形如 `已生成图像 1`。
- 图片 `src` 是 `blob:https://chatgpt.com/...` —— 直接
  `fetch(src) → arrayBuffer → base64` 就能拿到 PNG 原始字节，**不需要下载按钮**
  （页面没有下载按钮，`aria-label*="下载"` 数量为 0）。
- 生成耗时实测约 30-40 秒（4 帧动画提示词会稍长）。

## 参考图上传

两条路，都实测可用：

1. **剪贴板（优先，水水要求）**：`powershell.exe -NoProfile -STA` 里
   `[System.Windows.Forms.Clipboard]::SetImage($img)`，然后聚焦输入框 `Control+V`。
   - 坑：`-File` 执行时中文路径会被编码吃掉 → 先复制成 ASCII 临时名，用环境变量传路径。
   - 坑：`[System.Drawing.Image]::FromFile()` 后调用 `Clipboard.SetImage` 会报
     `ArgumentNullException`，要改成 `ReadAllBytes → MemoryStream → Image.FromStream`。
   - 粘上后输入框内出现缩略图（`form img` 里 `naturalWidth > 40`），ChatGPT 显示 `image.png`。
2. **file input 兜底**：`input[type=file]` 有 4 个（隐藏），其中 `accept` 含 `image` 的可用
   `setInputFiles(path)` 直接塞。插件原本没有这个能力，这是新增的。

## 新开对话

- 按钮 `role=button` 且名称为 `新聊天` / `New chat`（侧边栏顶部与列表头各一个，取第一个）。
- 点完 URL 会变成 `https://chatgpt.com/`（空白新对话），发消息后才变成 `/c/<uuid>`。

## 额度提示

免费账号生图会插播 `想要画面细节更丰富、更准确？试试 Plus。订阅 Plus` —— 不影响出图，
但连续生图可能被限速。
