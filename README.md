# pi-toolkit

Pi coding agent 的终端界面扩展集合。它不改模型、工具与会话数据，只重写对话记录的呈现：把一次请求里的工具调用收成一行摘要，把用户、助手与工具放进统一的 2 列标记栏，并让 `edit` / `write` 的改动默认可见。

目标是用更少的行数读完一轮对话，需要细节时再展开。

## 效果

```text
› 跑测试并修掉失败的用例
● 先定位失败的用例。
  Thought for 12s, ran 3 shell commands
● edit test/render.test.ts
  └ Added 2 lines, removed 1 line
  ... (4 more lines, ctrl+o to expand)
● 已修正，再跑一遍确认。
```

上面这一屏同时用到三个扩展：`message-marks` 提供标记栏，`tool-run-groups` 提供摘要行，`minimal-tools` 提供工具行与 diff 内容。

## 扩展

| 扩展 | 作用 |
|---|---|
| [minimal-tools](extensions/minimal-tools/README.md) | 工具调用两阶段显示：执行中可见，结束后收成一行；`edit` / `write` 默认展示改动 |
| [message-marks](extensions/message-marks/README.md) | 2 列标记栏：用户消息与输入框 `›`，助手与工具 `●` |
| [tool-run-groups](extensions/tool-run-groups/README.md) | 同一请求的工具调用折叠成一行摘要，含思考耗时；可点击或 `Ctrl+O` 展开 |

三个扩展彼此独立，可以只装其中一个。具体行为、快捷键、实现方式与限制见各目录下的 README。

## 安装

Pi 从 `~/.pi/agent/extensions/<name>/index.ts` 自动发现扩展。以本仓库放在 `/d/code/github/pi-toolkit` 为例：

```bash
ln -s /d/code/github/pi-toolkit/extensions/minimal-tools ~/.pi/agent/extensions/minimal-tools
ln -s /d/code/github/pi-toolkit/extensions/message-marks ~/.pi/agent/extensions/message-marks
ln -s /d/code/github/pi-toolkit/extensions/tool-run-groups ~/.pi/agent/extensions/tool-run-groups
```

WSL 下把路径换成 `/mnt/d/code/github/pi-toolkit/...`。

安装后在 Pi 中执行 `/reload`，或重启会话。卸载时删除对应的软链：

```bash
rm ~/.pi/agent/extensions/<name>
```

临时试用单个扩展，不必先建软链：

```bash
pi -e <仓库路径>/extensions/<name>/index.ts
```

## 目录结构

```text
pi-toolkit/
├── extensions/
│   ├── minimal-tools/
│   │   ├── README.md
│   │   └── index.ts
│   ├── message-marks/
│   │   ├── README.md
│   │   └── index.ts
│   └── tool-run-groups/
│       ├── README.md
│       └── index.ts
├── test/
├── package.json
└── README.md
```

扩展是纯 TypeScript，没有构建步骤，Pi 直接加载 `index.ts`。

## 测试

渲染逻辑的回归用例直接调用扩展注册的渲染函数并断言输出：

```bash
node_modules/.bin/jiti test/render.test.ts
node_modules/.bin/jiti test/message-marks.test.ts
node_modules/.bin/jiti test/editor-prefix.test.ts
node_modules/.bin/jiti test/tool-run-groups.test.ts
```

| 测试 | 覆盖 |
|---|---|
| `test/render.test.ts` | `minimal-tools`：工具行、摘要、展开、diff、表外工具、思考标签 |
| `test/message-marks.test.ts` | `message-marks`：用户消息、助手与工具圆点、颜色、行宽 |
| `test/editor-prefix.test.ts` | `message-marks`：输入框前缀、宽度与光标 |
| `test/tool-run-groups.test.ts` | `tool-run-groups`：聚合、边界、摘要文案、展开与点击 |

`jiti` 由 Pi 安装目录自带，无需额外依赖。测试从 `@earendil-works/*` 解析依赖，本机可通过目录联接把 `node_modules` 指向 Pi 的安装目录：

```powershell
cmd /c mklink /J D:\code\github\pi-toolkit\node_modules C:\Users\<user>\.pi\agent\install\releases\<version>\node_modules
```

## 兼容性

- 已在 Pi 1.5.2 验证，不承诺其他版本
- 三个扩展都依赖 Pi 的内部结构：`minimal-tools` 使用工具渲染 API，`message-marks` 包装导出的组件原型，`tool-run-groups` 接管 `InteractiveMode` 的私有方法。Pi 升级后可能退化或失效
- 思考正文默认显示；只有把 `hideThinkingBlock` 设为 `true` 时才会换成隐藏标签。扩展不修改该设置
- `tool-run-groups` 的点击展开依赖终端支持鼠标事件；`Ctrl+O` 始终可用
