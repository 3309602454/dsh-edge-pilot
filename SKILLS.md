# 技能（Skill）：把固化流程存一次，之后只填参数

## 为什么要这个

以前每次让 agent 做同一件事（比如「去某个网站搜一下 X」），它都得重新
`edge_observe` → 看元素 → `edge_click` → 再 observe，每步都在烧 token、还可能点歪。

技能把这些固化下来：**声明一次，之后一行调用**。

```
edge_skill action=list                      # 看到有哪些技能、要传什么参数
edge_skill action=run name=bing-search args={"query":"天气"}
```

agent 看到 `list` 的输出就知道「有这个功能、参数是 query」，不用再观察页面。

## 目录

技能就是普通的 JSON 文件，默认存在：

```
~/.dsh/edge-pilot/skills/<name>.json
```

可以直接手写，也可以让 agent 用 `edge_skill action=save` 生成。

## 结构

```json
{
  "name": "bing-search",
  "description": "在必应搜索一个词并返回首条结果",
  "params": {
    "query": { "required": true, "description": "搜索词" },
    "limit": { "default": 5, "description": "最多返回几条" }
  },
  "steps": [
    { "action": "goto", "url": "https://www.bing.com/" },
    { "action": "wait", "selector": "input[name=q]", "timeoutMs": 15000 },
    { "action": "type", "css": "input[name=q]", "text": "{{query}}", "enter": true },
    { "action": "wait", "urlContains": "search?q=", "timeoutMs": 15000 },
    { "action": "extract", "css": "#b_results .b_algo h2", "as": "firstResult" }
  ]
}
```

### 参数

`params` 里每个键：

| 字段 | 说明 |
|---|---|
| `required` | 必填，缺了直接报错，不会瞎跑 |
| `default` | 不传时的默认值 |
| `description` | 给 agent 看的说明（会出现在 `list` 里） |

### 变量

步骤里用 `{{变量名}}` 引用：

- `{{query}}` —— 来自 `params` / 调用时的 `args`
- `{{value}}` —— 前面 `extract` 步骤用 `as: "value"` 提取出来的

## 支持的步骤

| action | 必填字段 | 说明 |
|---|---|---|
| `goto` | `url` | 打开网址 |
| `wait` | `ms` 或 `selector`/`urlContains`/`titleContains`/`textContains` | 等条件成立；标 `optional: true` 则超时也不报错 |
| `click` | 选择器之一 | 点击 |
| `type` | 选择器之一 + `text` | 输入；`enter: true` 回车提交；`perChar: true` 逐字敲 |
| `press` | `key` | 按键，如 `Enter`、`Control+A` |
| `scroll` | `dy`（默认 700） | 滚动 |
| `sleep` | `ms` | 干等 |
| `screenshot` | 可选 `path` | 截图，落盘路径记进产物 |
| `extract` | 选择器之一 + `as` | 取文本（或 `attr` 指定属性），存进变量 |
| `eval` | `code` + `as` | 在页面执行 JS，结果存进变量 |
| `download` | `triggerText` 或 `ref` | 点一下并等文件真落盘 |
| `closeTab` | — | 关掉当前标签（至少留一个） |

### 选择器（四选一，按优先级）

```json
{ "css": "#submit" }
{ "role": "button", "name": "搜索" }
{ "placeholder": "搜索" }
{ "label": "用户名" }
{ "text": "立即购买", "exact": false }
```

> **不要写 `ref`**。ref 是 `edge_observe` 每次现编的编号，页面一变就失效。
> 除非技能只在单次会话内用，否则一律用上面这五种。

## 容错

- 任何一步都能加 `"optional": true`：失败就跳过，不中断整个技能。
- 步骤加 `"timeoutMs": 30000` 单独调超时（默认取 `actionTimeoutMs`）。
- 报错会精确指出「第几步、哪个动作、当前 url 和 title」，「方便对着修」。

## 示例：给常去的站建一个

假设你每天要去某个后台看一个数字：

```json
{
  "name": "daily-check",
  "description": "登录后台看今日数据",
  "params": {},
  "steps": [
    { "action": "goto", "url": "https://example.com/dashboard" },
    { "action": "wait", "textContains": "今日数据", "timeoutMs": 30000 },
    { "action": "extract", "css": ".today-count", "as": "count" },
    { "action": "screenshot", "path": "C:/Users/asus/Pictures/daily.png" }
  ]
}
```

之后只要 `edge_skill action=run name=daily-check` 一行。

## 和专用工具的关系

已经封装好的专用工具（`chatgpt_image`、`chatgpt_ask` 等）**不需要**再包成技能——
它们本身就是最优路径。技能面向的是「你自己常去、又需要点好几下」的站点。
