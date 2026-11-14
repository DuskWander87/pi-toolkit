# pi-toolkit

Pi coding agent 的增强与改造扩展集合。

## 扩展

| 扩展 | 说明 | 状态 |
|---|---|---|
| `minimal-tools` | 工具调用两阶段显示（收起单行摘要 / 展开背景色块）；`edit` / `write` 默认展示改动内容；思考块收起标签为 ` Thinking...` | 可用 |

## 目录结构

```
pi-toolkit/
├── docs/                # 设计与实施方案
├── extensions/          # 扩展源码
└── README.md
```

## 文档

| 文档 | 说明 |
|---|---|
| [`docs/minimal-tools-plan.md`](docs/minimal-tools-plan.md) | `minimal-tools` 实施方案 |
| [`docs/edit-write-diff-plan.md`](docs/edit-write-diff-plan.md) | `edit` / `write` diff 展示方案 |
| [`docs/todo.md`](docs/todo.md) | 待办与已知问题 |

## 安装

Pi 从 `~/.pi/agent/extensions/` 自动发现 `<name>/index.ts`。

以 `minimal-tools` 为例：

```bash
ln -s /d/code/github/pi-toolkit/extensions/minimal-tools ~/.pi/agent/extensions/minimal-tools
```

在 WSL 下也可以用 Windows 路径：

```bash
ln -s /mnt/d/code/github/pi-toolkit/extensions/minimal-tools ~/.pi/agent/extensions/minimal-tools
```

安装后在 Pi 中执行 `/reload`，或重启会话。

## 开发

单个扩展临时测试，不必先建软链：

```bash
pi -e /mnt/d/code/github/pi-toolkit/extensions/minimal-tools/index.ts
```

## 参考

- Pi 扩展文档：`~/.pi/agent/install/releases/<version>/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
- 官方示例：同目录 `examples/extensions/`
