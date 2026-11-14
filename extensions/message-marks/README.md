# message-marks

2 列标记栏：用户消息与输入框用 `›`，助手文本块与工具调用用 `●`，其余内容统一从第 2 列开始。

## 效果

```text
› 先看一下测试脚本
  续行与首行内容对齐

  思考正文从第 2 列开始
● 好，我先读一下测试。
  续行、思考行与工具块都在第 2 列
● $ npm test
  ...工具正文同样从第 2 列开始
```

输入框首行也以 `› ` 起头，多行输入在等宽留白后对齐。

## 标记规则

| 位置 | 标记 | 颜色 |
|---|---|---|
| 用户消息首个内容行 | `› ` | `getSelectListTheme().description` |
| 输入框首个内容行 | `› ` | 同上 |
| 助手消息首个文本块首行 | `●` | 同上 |
| 工具调用首行：进行中 | `●` | 同上（灰） |
| 工具调用首行：成功 | `●` | 固定蓝 `rgb(86,156,214)` |
| 工具调用首行：失败 | `●` | 主题 `error`（红） |

## 对齐方式

- 标记栏固定 2 列：第 1 列放标记，第 2 列为空格
- 助手消息与工具块的每一行都补到第 2 列；首行用标记替换原有的两格留白
- 用户消息只在首个内容行插入前缀，后续行补等量空格，使内容从同一列开始
- 插入空格后从行尾回收等量空格，整行可见宽度不变
- 代码块、列表等已有缩进保持相对结构；终端图片行（Kitty / iTerm2 协议）不参与缩进与标记

## 行为

### 用户消息

去掉原来的背景色，改用 `› ` 前缀区分用户输入与模型输出。代码块首行同样带前缀，围栏与正文的相对缩进不变。

### 助手消息

- 整条消息对齐到第 2 列，包括思考行与续行
- 只给第一个文本块的首行加 `●`；思考块、错误提示不算文本块，圆点不会落在 `Thinking...` 上
- 没有文本块的助手消息（例如只有思考）不加圆点

### 工具调用

- 整块对齐到第 2 列，首行加状态圆点
- 圆点颜色随执行状态变化：进行中灰、成功蓝、失败红
- 工具结果的正文、diff 与截断提示都在标记栏右侧

### 输入框

通过 `CustomEditor` 子类 `PromptPrefixEditor` 实现：

- `› ` 前缀占用左侧内边距，不叠加在文本上
- 换行宽度、光标位置与鼠标定位都按加宽后的内边距计算
- 对外仍是调用方设置的宽度：`getPaddingX()` 返回原值，`setPaddingX()` 自动加上 2
- 窄终端下内边距不足以容纳前缀时保持原样
- 保留 Pi 默认输入框的工作状态嵌入上边框

## 安装

```bash
ln -s /d/code/github/pi-toolkit/extensions/message-marks ~/.pi/agent/extensions/message-marks
```

WSL 下把路径换成 `/mnt/d/code/github/pi-toolkit/extensions/message-marks`。安装后在 Pi 中执行 `/reload`，或重启会话。卸载时删除该软链即可。

临时试用可以不建软链：

```bash
pi -e <仓库路径>/extensions/message-marks/index.ts
```

## 交互与配置

- 没有快捷键、命令或配置项，安装后直接生效
- 输入框的按键、自动补全与鼠标行为沿用 Pi 默认实现

## 与其他扩展

- 单独安装即可工作
- 与 `tool-run-groups` 共用 2 列标记栏宽度：摘要行由 `tool-run-groups` 自己缩进到第 2 列，本扩展不为它加圆点
- 与 `minimal-tools` 一起装时，本扩展负责工具行的缩进与圆点，`minimal-tools` 负责行内内容
- 输入框通过 `setEditorComponent` 接管；如果另一个扩展之后也调用 `setEditorComponent`，后注册的编辑器会覆盖本扩展，两者共存时需要包一层工厂

## 实现原理

Pi 没有普通消息的渲染钩子（`registerMessageRenderer` 只处理 `custom` 消息），因此本扩展包装导出的组件原型：

- `UserMessageComponent.render`：去背景色 + 首行前缀
- `AssistantMessageComponent.render`：整条消息对齐 + 首个文本块圆点
- `ToolExecutionComponent.render`：整块对齐 + 状态圆点
- `ctx.ui.setEditorComponent`：注册 `PromptPrefixEditor`

安装用 `Symbol.for` 标记，重复加载不会叠加。主题代理在 `session_start` 取得，切换主题后工具圆点颜色仍跟随。

## 限制

- **依赖组件内部结构**：助手圆点的位置读取 `contentContainer.mouseLayout` 与 `markdownSlots`；Pi 更新若改变这些字段，圆点会退化或错位
- **固定 2 列**：没有可配置的标记栏宽度
- **成功蓝是固定 RGB**：主题没有蓝色令牌，无法随自定义主题变化
- **只标第一个文本块**：一条助手消息中的后续文本块不加圆点
- **图片行不缩进**：终端图片自带单元格定位，保持原样
- **输入框可能被覆盖**：其他扩展后注册编辑器时会失效，见「与其他扩展」

## 测试

```bash
node_modules/.bin/jiti test/message-marks.test.ts
node_modules/.bin/jiti test/editor-prefix.test.ts
```

前者覆盖用户消息前缀、助手与工具圆点、颜色、行宽与重复安装；后者覆盖输入框前缀、宽度、光标与工作状态。

---

返回 [pi-toolkit 根 README](../../README.md)。
