# pi-toolkit

Pi coding agent 的增强与改造扩展集合。

## 扩展

| 扩展 | 说明 | 状态 |
|---|---|---|
| `minimal-tools` | 工具调用两阶段显示（收起单行摘要 / 展开背景色块）；`edit` / `write` 默认展示改动内容；运行中显示实时耗时；思考块收起标签为 ` Thinking...` | 可用 |
| `user-message-prefix` | `›` 标记：用户消息首行前缀、续行对齐；输入框首行同样以 `› ` 起头 | 可用 |

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

以 `minimal-tools` 与 `user-message-prefix` 为例：

```bash
ln -s /d/code/github/pi-toolkit/extensions/minimal-tools ~/.pi/agent/extensions/minimal-tools
ln -s /d/code/github/pi-toolkit/extensions/user-message-prefix ~/.pi/agent/extensions/user-message-prefix
```

在 WSL 下也可以用 Windows 路径：

```bash
ln -s /mnt/d/code/github/pi-toolkit/extensions/minimal-tools ~/.pi/agent/extensions/minimal-tools
ln -s /mnt/d/code/github/pi-toolkit/extensions/user-message-prefix ~/.pi/agent/extensions/user-message-prefix
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
node_modules/.bin/jiti test/user-message-prefix.test.ts
node_modules/.bin/jiti test/editor-prefix.test.ts
```

`jiti` 由 Pi 安装目录自带，无需额外依赖。

依赖可从 `@earendil-works/*` 解析：本机（Pi 安装在 `~/.pi/agent/install`）用目录联接即可：

```powershell
cmd /c mklink /J D:\code\github\pi-toolkit\node_modules C:\Users\<user>\.pi\agent\install\releases\<version>\node_modules
```

## 参考

- Pi 扩展文档：`~/.pi/agent/install/releases/<version>/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
- 官方示例：同目录 `examples/extensions/`
