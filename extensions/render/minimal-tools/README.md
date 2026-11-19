# minimal-tools

工具调用的两阶段显示：执行中保留调用信息，成功结束后收成一行摘要；`edit` / `write` 默认展示改动内容。

## 效果

![工具行的执行中与收起态](../../../assets/minimal-tools.png)

```text
执行中
  shell · running (1.2s)

成功后收起
  shell (1.5s)

失败时保留命令行与完整错误输出
  $ npm test
  ...完整错误输出（红色）
```

行首缩进做了简化，实际由 Pi 的 `outputPad` 与 `message-marks` 决定。`Ctrl+O` 展开后，命令行与完整输出放在同一块 `toolPendingBg` 背景区域内。

## 行为

| 工具 | 执行中 | 收起（成功） |
|---|---|---|
| `bash` | 命令行 + `shell · running (1.2s)` | `shell (1.5s)` |
| `read` | 调用行 | `read 120 lines`；图片为 `read image` |
| `grep` | 调用行 | `grep 3 matches` |
| `find` | 调用行 | `found 2 files` |
| `ls` | 调用行 | `ls . · 4 entries` |
| `edit` | 调用行 | 标题 + 增删统计 + diff（默认最多 30 行） |
| `write` | 调用行 | 标题 + 写入行数 + 预览（默认最多 10 行） |
| 其他工具 | 调用行 | `<工具名> · N lines` |

文本类工具的摘要末尾会附执行耗时（如 `read 120 lines (0.3s)`），不足 1 秒时显示毫秒。

### 执行中

调用行始终可见。只有 `bash` 会持续发送部分结果，因此额外显示 `· running (已用时间)` 并每秒刷新；其他内置工具不发送部分结果，执行期间只有调用行。

### 失败

错误不会被折叠：保留调用行，并显示完整错误输出。

### 展开

`Ctrl+O` 切换 Pi 的全局工具展开状态：

- `bash`：`$ command` + 完整输出
- `read`：`read <path>[:range]` + 完整输出
- `grep`：`grep /pattern/` + 完整输出
- `find`：`find <pattern>` + 完整输出
- `ls`：`ls <path>` + 完整输出
- 其他工具：`<工具名> <参数摘要>` + 完整输出

### `edit`

- 标题行：`edit <path>`，路径中的 home 目录缩写为 `~`
- 统计行：`└ Added 2 lines, removed 1 line`；无改动时显示 `└ No changes`
- diff 默认最多 30 行，超出显示 `... (N more lines, ctrl+o to expand)`
- 行级底色区分增删，整行铺满渲染宽度；单行删除 + 单行新增时，再叠加词级高亮标出真正变化的字符
- 超宽行折成多行，续行与首段内容列对齐：西文在空白处断行，中日韩字符逐字断行，一行内没有可断点时硬切

### `write`

- 标题行：`write <path>`
- 统计行：`└ Wrote 12 lines`
- 预览默认最多 10 行，每行以 `+ ` 起头；超出显示截断提示；超宽行与 `edit` 一样折行

### 表外工具

未单独适配的工具尊重上游渲染：

- 上游提供 `renderCall` 或 `renderResult` 任一槽时，整体使用上游渲染（例如 Pi 内置的 `powershell`）
- 例外是 `web_search` / `fetch_content` / `get_search_content`（两个渲染槽都在时）：保留上游的调用行、进度条与结果分组，但套无底色的行级外壳，缩进由 `outputPad` 补回；收起态保持行级无底色，行数与内容仍由上游决定（调用行 + 上游自己的摘要 / 预览），不是单行摘要。展开且成功时调用行与结果并进同一块 `toolPendingBg` 区域（运行中、出错时仍分两段，与其它工具相同）
- 两者都没有时自动套用同一套两阶段渲染：调用行取第一个非空字符串参数（截断到 40 字符），结果收起为 `<工具名> · N lines`
- 上游只提供 `renderShell`、没有调用行 / 结果行时，仍由本扩展折叠
- 没有上游渲染槽的工具返回图片时，摘要只统计文本行（可能显示 `0 lines`），图片由 Pi 独立渲染

### 思考标签

`session_start` 时把隐藏思考的标签设为正体 `Thinking...`，颜色取主题的 `thinkingText`。该标签只在 `settings.json` 的 `hideThinkingBlock` 为 `true` 时可见；Pi 默认 `false`，显示思考正文。

## 安装

安装、更新与卸载见[根 README](../../../README.md#快速开始)。

## 交互与配置

- `Ctrl+O`：在收起 / 展开之间切换
- 没有扩展自己的配置项
- 是否显示思考正文仍由 Pi 的 `hideThinkingBlock` 决定，扩展只负责标签样式

## 与其他扩展

- 单独安装即可工作
- 与 `message-marks` 一起装时，工具行会被对齐到 2 列标记栏，首行带状态圆点；此时本扩展按 `outputPad` 补的缩进被标记栏吸收，`outputPad` 只剩影响换行宽度的作用
- 与 `tool-run-groups` 一起装时，本扩展渲染出的工具行会被折叠进摘要；展开后仍是同样的内容

## 实现原理

- 通过 `pi.registerToolRenderer` 提供 `renderCall` / `renderResult`；先查定制表，再让位给上游，两者都没有时使用通用折叠。表外工具里，`UPSTREAM_RENDERER_TOOLS` 列出的搜索类工具在上游同时提供两个渲染槽时保留上游渲染器、只换成 self 壳并补 `outputPad` 缩进；缺一个槽时仍整体让位
- 只替换渲染，不替换执行：`bash` 的 `shellPath`、`PI_*` 环境变量等仍由 Pi 内置定义处理
- 运行中计时保存在 `context.state`，每秒调用一次 `invalidate()`，结束时清除 interval
- diff 配色按 `theme.appearance` 在深色 / 浅色两套 RGB 底色中切换

## 限制

- **实时耗时只覆盖 `bash`**：其余内置工具不发送部分结果，执行期间没有每秒刷新
- **diff 与预览默认按行数截断**：`edit` 30 行、`write` 10 行，完整内容需要 `Ctrl+O`；超宽行会折行，因此窄终端下一行可能占多行高度
- **收起态单行折行有上限**：一行最多折 20 行，末行以 `…` 收尾；展开后不限，超长行（如压缩后的单行文件）也能看到全文
- **词级高亮有前提**：只处理「单行删除 + 单行新增」的配对；变化字符超过行内容 70% 时退化为行级底色，单行超过 300 字符时改用公共前后缀定位
- **主题切换**：思考标签颜色在 `session_start` 时取值，切换主题后需要 `/reload`；diff 底色只看明暗外观，自定义主题的配色可能与扩展不一致
- **依赖 Pi 的渲染 API**：`registerToolRenderer`、`ToolRenderers`、`context.state`、`context.outputPad` 等结构变化时需要同步调整
- **搜索类工具名是硬编码的**：`pi-web-access` 改名（含它的 `toolNames` 配置）后换壳静默失效，这些工具行会重新出现整块底色，渲染内容本身不受影响
- **搜索类工具的错误底色由上游决定**：`pi-web-access` 的结果渲染只看 `details.error`，不看 `isError`；工具抛异常这类没有 `details.error` 的错误会渲染成正常状态行。本扩展不另铺底色——上游多数错误分支自带 `toolErrorBg` 块，再套一层会让一行出现两段底色

## 测试

`test/render/minimal-tools.test.ts` 覆盖调用行、running 计时、成功摘要、错误块、展开、edit / write 行数截断与超宽折行（含续行对齐、折行上限与极窄宽度）、表外工具、图片回退、缺失参数与隐藏思考标签。运行方式见[根 README](../../../README.md#测试)。

---

返回 [pi-toolkit 根 README](../../../README.md)。
