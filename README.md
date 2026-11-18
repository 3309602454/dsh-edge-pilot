# dsh-edge-pilot

让 DeepSeek Harness 直接操控**系统自带的 Microsoft Edge** 完成网页任务：打开页面、看清页面上有什么、自己决定点哪个按钮、输入文字、滑动、截图、另存为、下载。

不下载 Chromium，不装浏览器内核，复用系统 `msedge.exe`。

## 它怎么解决"自己判断点哪个"

模型不看 HTML 源码，也不写 CSS 选择器。插件把页面压成一份带编号的元素清单：

```
页面：搜索 - Microsoft 必应
地址：https://www.bing.com/
视口：1440×900，纵向已滚动 0（可滚动范围 0~542）
可交互元素：57 个
* [e17] combobox "在此处输入你的搜索" (可输入)
* [e18] button "语音搜索"
* [e2] menuitem "图片"
  [e51] link "隐私与 Cookie" -> //go.microsoft.com/fwlink/?LinkId=521839
```

`*` 表示在视口内。模型只需要回答"点 e18"，插件负责滚入视口、检测遮挡、发真实鼠标事件，点完再对比 URL 和正文，判断到底有没有生效。选择器猜错、元素幻觉这类问题从根上被拿掉了。

## 安装（位置决定成败）

插件必须放在 **profile 的 node_modules 下**，并用 `insert` 形式挂载。原因是 `@deepseek-ai/dsh-tools` 并不在磁盘上，它是宿主在那一层注入的虚拟模块；换到 `~/.dsh/vendor/` 之类的位置会直接报 `ERR_MODULE_NOT_FOUND`，而那行配置只会得到一句 `1 entry did not activate`，不会告诉你为什么。

```bash
# 1. 复制到 profile
cp -r ~/.dsh/vendor/dsh-edge-pilot ~/.dsh/profiles/desktop/node_modules/dsh-edge-pilot
```

```yaml
# 2. 追加到 ~/.dsh/profiles/desktop/cordis.patch.yml 末尾
#    注意必须是 insert，不能用 - id: 形式（那只用于覆盖已存在的行）
- insert:
    - id: dsh-edge-pilot
      name: 'dsh-edge-pilot'
      config:
        headless: false
        maxElements: 200
```

3. 重启 DSH（Electron 主进程不热加载新插件）

验证方式：让助手调一次 `edge_status`。返回"浏览器尚未启动"就说明装好了；如果说没有这个工具，说明没加载。

想确认加载情况又不想猜，可以用临时 profile 跑一次真实加载：

```bash
dsh --profile web --port 0 --no-open 2>&1 | grep -i edge-pilot
```

输出里没有 `did not activate` 就是成功。

## 工具

| 工具 | 作用 |
|---|---|
| `edge_open` | 打开网址，可新开标签页 |
| `edge_observe` | 读元素清单 + 正文摘要（入口工具） |
| `edge_screenshot` | 截图，图片直接回传模型 |
| `edge_click` | 点击（ref / 文字 / 坐标），带遮挡预检和效果校验 |
| `edge_type` | 输入文字，可逐字输入、可回车提交 |
| `edge_key` | 按键，如 Enter / Control+A |
| `edge_scroll` | 滚动，或把某个元素滚进视口 |
| `edge_drag` | 拖拽：轮播、滑块验证、拖拽排序 |
| `edge_select` | 原生下拉框选择 |
| `edge_hover` | 悬停展开二级菜单 |
| `edge_wait` | 等地址/文字出现，比反复观察省 token |
| `edge_tabs` | 标签页 list / open / switch / close / closeOthers / prune（自动回收） |
| `edge_skill` | **固化流程技能**：把重复操作存成 JSON，下次只填参数一行跑完 |
| `edge_save` | **另存为**：mhtml / html / pdf / txt / md / png / jpeg / resource |
| `edge_download` | **下载**：触发并等文件真正落盘 |
| `edge_eval` | 兜底执行一小段 JS |
| `edge_status` | 浏览器状态、标签页、下载目录 |
| `edge_close` | 关闭并释放 |
| `chatgpt_ask` | 问网页版 ChatGPT，**只回答案正文** |
| `chatgpt_image` | 让 ChatGPT 生图并存本地，只回路径（可带参考图） |
| `chatgpt_gif` | 让 ChatGPT 生成动画并合成 GIF |
| `chatgpt_login_status` | 查 ChatGPT 专用 profile 登录态（不开浏览器） |

## 固化流程技能（2026-11-19 新增）

同一个流程做第二遍时，不该再让模型从头 `observe` → 推理 → 点击。
把固化步骤存成一份 JSON，之后一行调用。

```bash
# 看有哪些技能、要传什么参数
edge_skill action=list

# 填参数直接跑
edge_skill action=run name=bing-search args={"query":"Playwright"}
```

技能存在 `~/.dsh/edge-pilot/skills/<name>.json`，**一个技能一个文件**——
坏了不互相影响，可以直接手改，也能单独分享给别人。

```json
{
  "name": "bing-search",
  "description": "在必应搜索一个词，返回前几条结果",
  "params": { "query": { "required": true, "description": "搜索词" } },
  "steps": [
    { "action": "goto", "url": "https://www.bing.com/" },
    { "action": "wait", "css": "#sb_form_q" },
    { "action": "type", "css": "#sb_form_q", "text": "{{query}}", "enter": true },
    { "action": "wait", "urlContains": "search?q=" },
    { "action": "eval", "as": "results", "code": "..." }
  ]
}
```

支持的步骤：`goto` / `wait` / `click` / `type` / `press` / `scroll` / `sleep` /
`screenshot` / `extract` / `eval` / `download` / `closeTab`。

设计要点：

- **只写语义选择器**（`css` / `role` / `placeholder` / `label` / `text`），
  **不写 `ref`**——ref 是 `edge_observe` 每次现编的编号，页面一变就失效。
- 任何一步可标 `"optional": true`，失败就跳过，不中断整个技能。
- 变量用 `{{名字}}` 占位；`extract` 步骤的 `as` 结果可供后续步骤引用。
- 报错会精确指出「第几步、哪个动作、当前 url 和 title」。

完整说明见 [SKILLS.md](./SKILLS.md)。

## 标签页自动清理（2026-11-19 新增）

Edge 的「恢复上次会话」会让插件开的标签页越攒越多，
最终启动变慢甚至直接崩。现在有五道防线：

| 时机 | 动作 |
|---|---|
| 启动前 | 删 `Default/Sessions` 下的 `Tabs_*` 与 `Session_*` |
| 启动后 | `pruneTabs(maxTabs:1)` 清场，只留一个 |
| 开新标签 | 立刻按 `maxTabs` 限额，开再多也不涨 |
| 空闲超时 | `idleCleanupMs`（默认 3 分钟）到点自动回收 |
| `edge_close` | 先全关页面再关浏览器，落盘会话为空 |

启动参数同时带 `--disable-features=SessionRestore` 从源头掐断还原。
接管模式（`cdpUrl`）不会动你自己的标签页。

## ChatGPT 网页版工具（2026-11-09 新增）

复用一份**专用 profile** `~/.dsh/edge-pilot/chatgpt-profile` 的登录态，每次调用后台
静默启动 Edge（窗口移到屏幕外），用完立刻关，不碰用户正在看的浏览器。

- `chatgpt_ask(prompt, timeoutMs?, newChat?)` → 只返回答案正文，不返回任何页面结构。
- `chatgpt_image(prompt, ref?, path?, timeoutMs?)` → 返回落盘路径 + 尺寸。
- `chatgpt_gif(prompt, ref?, frames?, frameMs?, path?)` → 返回 GIF 路径与帧信息。
- `chatgpt_login_status()` → 只读 cookie 库判断登录态。

`ref` 是本地图片绝对路径：先复制成 ASCII 临时名，再通过系统剪贴板
（`powershell -STA` + `Clipboard::SetImage`）粘贴进输入框；失败时回退到隐藏的
`input[type=file]`。

站点选择器与实测坑见 [CHATGPT-DOM.md](./CHATGPT-DOM.md)。要点：

- `headless: true` 会被 Cloudflare 卡在「请稍候…」，必须用有头 + 窗口移出屏幕。
- 回答靠正文里的 `ChatGPT 说：` 标记切；页面没有 `data-message-author-role` / `article`。
- 图片 `src` 是 `blob:`，`fetch → base64` 直接取原始 PNG，页面没有下载按钮。
- 免费账号有图像额度上限，超了会明确提示（24 小时后重置）。

### 另存为的格式对应关系

| format | 实现 | 等同于 Edge 菜单里的 |
|---|---|---|
| `mhtml` | CDP `Page.captureSnapshot` | 网页，单个文件 |
| `html` | `page.content()` | 网页，仅 HTML |
| `pdf` | `page.pdf()` | 另存为 PDF |
| `txt` / `md` | `innerText` / HTML 转 Markdown | 无 |
| `png` / `jpeg` | 整页或元素截图 | 无 |
| `resource` | 取图片/文件的原始字节落盘 | 右键图片另存为 |

系统级"另存为"对话框会让自动化阻塞，所以这里全部走应用层实现，不会弹窗。

## 浏览器模式

默认启动一个**独立实例**：单独的数据目录 `~/.dsh/edge-pilot/profile`，不碰你日常用的 Edge，也不需要关掉它。

- 登录态是持久的：在这个窗口里手动登录一次，以后都还在。
- 想接管你正在用的 Edge（继承全部登录态），把 `cdpUrl` 设成 `http://127.0.0.1:9222`，并先用
  `msedge.exe --remote-debugging-port=9222 --user-data-dir=<另一个目录>` 启动浏览器。
  注意：同一数据目录的 Edge 已经在跑时，调试端口不会生效，必须先完全退出。

## 配置

在 `cordis.patch.yml` 的行里改：

| 键 | 默认 | 说明 |
|---|---|---|
| `headless` | `false` | 默认有头，你能看见它在点什么 |
| `userDataDir` | `~/.dsh/edge-pilot/profile` | 独立数据目录 |
| `cdpUrl` | 空 | 填了就接管已有浏览器 |
| `downloadsDir` | `<工作目录>/downloads` | 下载与另存为的默认目录 |
| `maxElements` | `200` | 单次观察的元素上限，主要控制 token |
| `textDigestChars` | `1200` | 正文摘要长度 |
| `actionTimeoutMs` | `15000` | 单步动作超时 |
| `allowDomains` | `[]` | 非空时只允许这些域名 |
| `denyDomains` | `[]` | 禁止访问的域名 |

## 已知限制

- 跨域 iframe 会逐个框架观察，ref 全局唯一，但框架内的滚动容器不一定能自动滚到。
- 验证码、滑块、人机校验不做绕过：截图交给人工。
- 强反爬站点（部分电商、搜索引擎）会给自动化浏览器降级页面，属于预期内。
- `edge_eval` 能执行任意脚本，等同于给了模型页面内的代码执行权限，慎用。
- 一次观察的元素清单会占 token，页面很乱时把 `maxElements` 调到 80 左右。

## 目录

```
src/config.js    配置、Edge 路径探测、域名与路径校验
src/session.js   浏览器实例、标签页、下载与弹窗事件
src/observe.js   元素抽取与清单渲染（核心）
src/act.js       定位、遮挡检测、动作与效果校验
src/files.js     另存为、截图、下载、标签页
src/chatgpt.js   ChatGPT 网页版问答 / 生图 / GIF（静默实例 + 剪贴板参考图）
src/index.js     插件入口与前缀工具注册
scripts/         独立冒烟测试（不依赖 DSH）
CHATGPT-DOM.md   ChatGPT 页面结构实测记录（选择器、坑、额度）
```

## 自测

```bash
node scripts/smoke.mjs --headless   # 22 项断言，覆盖观察/点击/输入/下拉/遮挡/滚动/截图/另存为/下载/标签页/真实站点
node scripts/demo.mjs --headed      # 有头模式跑一次真实搜索任务
```
