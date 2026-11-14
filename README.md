# pi-toolkit

Pi coding agent 的增强与改造扩展集合。

## 扩展

| 扩展 | 说明 | 状态 |
|---|---|---|
| `minimal-tools` | 工具调用两阶段显示（收起单行摘要 / 展开背景色块）；`edit` / `write` 默认展示改动内容；运行中显示实时耗时；思考块收起标签为 `Thinking...` | 可用 |
| `message-marks` | Claude Code 式 2 列标记栏：用户消息与输入框 `›`；助手文本块 `●`；工具调用 `●`（进行中灰、成功蓝、失败红）。续行、思考行与工具块统一对齐到第 2 列 | 可用 |
| `tool-run-groups` | 两级聚合：同一轮的工具行收成一行；两条带文本的回复之间（或用户消息与首条回复之间）的工具调用只留一行摘要（`Thought for 28s, ran 8 shell commands`）；思考结束后隐藏思考的标签从 `Thinking...` 换成 `Thought for Ns`；带文本的回复照常显示、不进折叠，中斷/报错的轮次是边界；`edit` / `write` 不计入摘要行，收起时也逐条渲染；Ctrl+O 或点击摘要行展开为完整时间线 | 可用 |

## 目录结构

```
pi-toolkit/
├── docs/                # 设计与实施方案
├── extensions/          # 扩展源码
├── test/                # 渲染逻辑回归用例
└── README.md
```

## 安装

Pi 从 `~/.pi/agent/extensions/` 自动发现 `<name>/index.ts`。

以三个扩展为例：

```bash
ln -s /d/code/github/pi-toolkit/extensions/minimal-tools ~/.pi/agent/extensions/minimal-tools
ln -s /d/code/github/pi-toolkit/extensions/message-marks ~/.pi/agent/extensions/message-marks
ln -s /d/code/github/pi-toolkit/extensions/tool-run-groups ~/.pi/agent/extensions/tool-run-groups
```

在 WSL 下也可以用 Windows 路径：

```bash
ln -s /mnt/d/code/github/pi-toolkit/extensions/minimal-tools ~/.pi/agent/extensions/minimal-tools
ln -s /mnt/d/code/github/pi-toolkit/extensions/message-marks ~/.pi/agent/extensions/message-marks
ln -s /mnt/d/code/github/pi-toolkit/extensions/tool-run-groups ~/.pi/agent/extensions/tool-run-groups
```

安装后在 Pi 中执行 `/reload`，或重启会话。

## 开发

单个扩展临时测试，不必先建软链：

```bash
pi -e /mnt/d/code/github/pi-toolkit/extensions/minimal-tools/index.ts
```

## 测试

渲染逻辑的回归用例放在 `test/`，直接调用扩展注册的 `renderCall` / `renderResult` 并断言渲染字符串：

```bash
node_modules/.bin/jiti test/render.test.ts
node_modules/.bin/jiti test/message-marks.test.ts
node_modules/.bin/jiti test/editor-prefix.test.ts
node_modules/.bin/jiti test/tool-run-groups.test.ts
```

`jiti` 由 Pi 安装目录自带，无需额外依赖。

依赖可从 `@earendil-works/*` 解析：本机（Pi 安装在 `~/.pi/agent/install`）用目录联接即可：

```powershell
cmd /c mklink /J D:\code\github\pi-toolkit\node_modules C:\Users\<user>\.pi\agent\install\releases\<version>\node_modules
```

## 参考

- Pi 扩展文档：`~/.pi/agent/install/releases/<version>/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
- 官方示例：同目录 `examples/extensions/`
