# minimal-tools

工具调用的两阶段显示：执行中保留调用信息，成功结束后收成一行摘要；`edit` / `write` 默认展示改动内容。只替换渲染，不改工具的执行方式。

## 预览

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

图中行首缩进由 Pi 的 `outputPad` 与 `message-marks` 决定。

## 特性

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

文本类工具的摘要末尾附执行耗时（如 `read 120 lines (0.3s)`），不足 1 秒时显示毫秒。

### 执行中

调用行始终可见。只有 `bash` 会持续发送部分结果，因此额外显示 `· running (已用时间)` 并每秒刷新；其他内置工具不发送部分结果，执行期间只有调用行。

### 失败

错误不会被折叠：保留调用行，并显示完整错误输出。

### 展开

`Ctrl+O` 展开后，命令行与完整输出放在同一块 `toolPendingBg` 背景区域内。

- `bash`：`$ command` + 完整输出
- `read`：`read <path>[:range]` + 完整输出
- `grep`：`grep /pattern/` + 完整输出
- `find`：`find <pattern>` + 完整输出
- `ls`：`ls <path>` + 完整输出
- 其他工具：`<工具名> <参数摘要>` + 完整输出

### edit

- 标题行：`edit <path>`，路径中的 home 目录缩写为 `~`
- 统计行：`└ Added 2 lines, removed 1 line`；无改动时显示 `└ No changes`
- diff 默认最多 30 行，超出显示 `... (N more lines, ctrl+o to expand)`
- 行级底色区分增删，整行铺满渲染宽度；单行删除 + 单行新增时，再叠加词级高亮标出真正变化的字符
- 超宽行折成多行，续行与首段内容列对齐：西文在空白处断行，中日韩字符逐字断行，一行内没有可断点时硬切

### write

- 标题行：`write <path>`
- 统计行：`└ Wrote 12 lines`
- 预览默认最多 10 行，每行以 `+ ` 起头；超出显示截断提示；超宽行与 `edit` 一样折行

### 其他工具

未单独适配的工具尊重上游渲染：

- 上游提供 `renderCall` 或 `renderResult` 任一槽时整体让位（例如 Pi 内置的 `powershell`）；上游只提供 `renderShell`、没有调用行 / 结果行时，仍由本扩展折叠
- `web_search` / `fetch_content` / `get_search_content` 例外：两个渲染槽都在时保留上游的调用行、进度条与结果分组，只套无底色的行级外壳，缩进由 `outputPad` 补回。收起态的行数与内容仍由上游决定，不是单行摘要
- 两个槽都没有时套用同一套两阶段渲染：调用行取第一个非空字符串参数（截断到 40 字符），结果收起为 `<工具名> · N lines`
- 没有上游渲染槽的工具返回图片时，摘要只统计文本行（可能显示 `0 lines`），图片由 Pi 独立渲染

### 思考标签

`session_start` 时把隐藏思考的标签设为正体 `Thinking...`，颜色取主题的 `thinkingText`。该标签只在 `settings.json` 的 `hideThinkingBlock` 为 `true` 时可见；Pi 默认 `false`，显示思考正文。

## 安装

```bash
git clone https://github.com/DuskWander87/pi-toolkit
pi install ./pi-toolkit/extensions/render/minimal-tools   # 安装
pi -e ./pi-toolkit/extensions/render/minimal-tools        # 只试用一次，不写入配置
pi remove ./pi-toolkit/extensions/render/minimal-tools    # 卸载
```

在 clone 的上级目录执行，已经有仓库时跳过 `git clone`。更新时在 clone 目录执行 `git pull`，然后在 Pi 中 `/reload`。装齐全部扩展见[根 README](../../../README.md#快速开始)。

## 用法

- `Ctrl+O`：在收起与展开之间切换
- 没有扩展自己的配置项

## 与其他扩展

- 单独安装即可工作
- 与 `message-marks` 一起装时，工具行对齐到 2 列标记栏，首行带状态圆点；本扩展按 `outputPad` 补的缩进被标记栏吸收，`outputPad` 只剩影响换行宽度
- 与 `tool-run-groups` 一起装时，本扩展渲染出的工具行会被折叠进摘要；展开后仍是同样的内容

## 限制

### 依赖

- Pi 的渲染 API：`registerToolRenderer`、`ToolRenderers`、`context.state`、`context.outputPad`。结构变化时需要同步调整
- 搜索类工具名硬编码在 `UPSTREAM_RENDERER_TOOLS`：`pi-web-access` 改名（含它的 `toolNames` 配置）后换壳静默失效，这些工具行会重新出现整块底色，渲染内容本身不受影响
- 搜索类工具的错误底色由上游决定：`pi-web-access` 的结果渲染只看 `details.error`，不看 `isError`，工具抛异常这类错误会渲染成正常状态行。本扩展不另铺底色：上游多数错误分支自带 `toolErrorBg` 块，再套一层会让一行出现两段底色

### 已知问题

- 实时耗时只覆盖 `bash`：其余内置工具不发送部分结果，执行期间没有每秒刷新
- 截断与折行：`edit` 30 行、`write` 10 行；收起态单行最多折 20 行，末行以 `…` 收尾，展开后不限
- 词级高亮只处理「单行删除 + 单行新增」的配对：变化字符超过行内容 70% 时退化为行级底色，单行超过 300 字符时改用公共前后缀定位
- 主题切换：思考标签颜色在 `session_start` 时取值，切换主题后需要 `/reload`；diff 底色只看明暗外观，自定义主题的配色可能与扩展不一致

### 非目标

- 不做配置项：截断行数、颜色、耗时格式都写死

## 实现原理

- 通过 `pi.registerToolRenderer` 提供 `renderCall` / `renderResult`：先查定制表，再让位给上游，两者都没有时使用通用折叠
- 运行中计时保存在 `context.state`，每秒调用一次 `invalidate()`，结束时清除 interval
- diff 配色按 `theme.appearance` 在深色 / 浅色两套 RGB 底色中切换

## 测试

`test/render/minimal-tools.test.ts` 覆盖调用行、running 计时、成功摘要、错误块与展开，以及 diff / 预览的截断、折行对齐与极窄宽度。其他工具、图片回退、缺失参数、隐藏思考标签与搜索类工具的换壳各有用例。运行方式见[根 README](../../../README.md#测试)。

---

返回 [pi-toolkit 根 README](../../../README.md)。
