---
name: fetch-webpage
description: Fetch a web page and convert it to clean markdown text for reading. Use when you need the full content of a URL — a long article, a docs section, a changelog, an issue discussion — beyond what web_search snippets provide.
argument-hint: "URL to fetch (add --article to extract the main article body)"
---

# fetch-webpage

抓取任意网页并把 HTML 转成 markdown 正文。弥补 web_search（只有 snippet）与 Context7（只有库文档）之间的空白。

## 何时使用

- 用户直接给出 URL，要求读内容 / 总结 / 提取信息
- web_search 的 snippet 不够，需要读长文、文档某节、issue 全文
- 需要比对某网页的完整内容（changelog、规格、API 参考）

## 用法

```pwsh
node skills/fetch-webpage/scripts/fetch-webpage.mjs <url> [选项]
```

| 选项 | 默认 | 说明 |
|---|---|---|
| `--article` | 关 | 提取正文（`article`/`main`/`[role=main]`），丢弃导航/页脚噪音 |
| `--max-chars N` | 120000 | 输出上限；`0` = 不截断 |
| `--timeout-ms N` | 20000 | 请求超时 |
| `--ua <string>` | Chrome UA | 自定义 User-Agent（个别站点反爬时可换） |
| `--out <file>` | 无 | 同时把 markdown 写入文件（供后续 read 分页） |

输出格式：`# 标题` + `Source: <url>` + markdown 正文。相对链接已绝对化。

## 执行步骤

1. 直接运行脚本（后台任务不需要，正常 URL 秒级返回）
2. 正文过长被截断时：先读截断部分判断重点；确需全文就 `--max-chars 0 --out <临时文件>` 落盘后分页 read
3. 页面噪音大（导航/推荐混入正文）→ 重跑加 `--article`
4. 抓取失败（HTTP 非 2xx / 超时 / 反爬）→ 换 `--ua` 重试一次；仍失败则如实告知用户，不要编造内容

## 实现说明（维护者）

- Node ≥ 18 内置 fetch；HTML→markdown 优先复用全局 npm 的 `turndown`（DSH 自带），缺失时退化到内置最小转换器（质量低，仅保底，且 stderr 会提示）
- **Windows 陷阱 1**：`execFileSync('npm')` 解析不了 `npm.cmd`，必须经 `ComSpec /c` 或直接候选路径（`%APPDATA%\npm\node_modules`、node 目录同级）
- **Windows 陷阱 2（实测铁证）**：node 24 下 `fetch()` 之后调用 `process.exit()` 会触发 libuv 断言崩溃（`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c`）——无论 body 是否完整消费。**所有路径必须 `process.exitCode` + 自然退出**，配合 `connection: close` 防 keep-alive 挂住
- 编码：从 `Content-Type` / `<meta charset>` 检测，`TextDecoder` 支持 gbk/gb18030 等（依赖 Node full-ICU）
- 20MB 响应上限防内存爆炸；退出码：0 成功 / 1 抓取解析失败 / 2 参数错误
- 链接绝对化：domino 解析后遍历 `a/img/link/source`，相对 href/src 用 `new URL(v, baseUrl)` 转绝对
