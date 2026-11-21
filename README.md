# pi-toolkit

Pi coding agent 的扩展集合，按改动位置分两类：渲染类只改对话怎么显示，agent 类改 agent 的工具、提示词与行为。每个扩展占一个目录，彼此独立，可以只装其中一个。会话数据、配置与工具实现都不改。

渲染类扩展的目标是用更少的行数读完一轮对话，需要细节时再展开。

版本与依赖范围见[兼容性](#兼容性)。

中文 | [English](README.en.md)

## 效果

![工具调用收起后只剩一行摘要](assets/hero-collapsed.png)

上面这一屏是三个渲染类扩展叠加的结果：`minimal-tools`、`message-marks`、`tool-run-groups`。

<details>
<summary>展开后的时间线</summary>

![Ctrl+O 展开后逐条显示工具调用](assets/hero-expanded.png)

</details>

## 扩展

### 渲染类

`extensions/render/`，只改对话怎么显示。

| 扩展 | 作用 |
|---|---|
| [minimal-tools](extensions/render/minimal-tools/README.md) | 工具调用的显示：执行中可见，结束后收成一行 |
| [message-marks](extensions/render/message-marks/README.md) | 用户、助手与工具共用的 2 列标记栏 |
| [tool-run-groups](extensions/render/tool-run-groups/README.md) | 工具调用折叠成一行摘要，回复正文之后另起一行摘要 |

### agent 类

`extensions/agent/`，改 agent 的工具、提示词与行为。

| 扩展 | 作用 |
|---|---|
| [skill-tool](extensions/agent/skill-tool/README.md) | 技能的加载动作换成专用工具，清单随之挪进工具描述 |
| [subagent](extensions/agent/subagent/README.md) | 把调研任务交给独立上下文的子代理，主会话只收回结论 |

归类判据：只改显示就是渲染类；改 agent 的工具、提示词或行为就是 agent 类。

行为、快捷键、实现方式与限制都写在各自目录的 README 里，这里不重复。新分类目录需要在该目录下放 `package.json`，用 `pi.extensions` 列出入口，并写明 `"type": "module"`：Pi 的扩展发现只往下认一层，没有清单的分类目录会被整个跳过；缺 `type` 会让 `moduleResolution: NodeNext` 把该目录当 CommonJS 解析。

## 快速开始

### 安装

```bash
pi install git:github.com/DuskWander87/pi-toolkit
```

一条命令装好 `extensions/` 下的全部扩展，`pi list` 确认，然后在 Pi 中执行 `/reload` 或重启会话。

已经 clone 到本地时，装本地副本：

```bash
git clone https://github.com/DuskWander87/pi-toolkit
pi install ./pi-toolkit
```

第二条命令在 clone 的上级目录执行，路径也可以写成绝对路径。

### 只保留部分扩展

```bash
pi config
```

在列表里关掉不需要的扩展，下次启动生效。

### 试用后不留配置

```bash
pi -e ./pi-toolkit
```

`-e` 只对这一次启动生效，Pi 会把它缓存在 `~/.pi/agent/tmp/extensions/` 下。同样在 clone 的上级目录执行。

### 更新与卸载

```bash
pi update --extensions
pi remove git:github.com/DuskWander87/pi-toolkit
```

## 兼容性

- 已在 Pi 1.6.0 验证，不承诺其他版本
- 每个扩展都在不同位置依赖 Pi 的内部结构，Pi 升级后可能退化或失效。具体依赖点写在各自 README 的「边界」或「限制」章节

## 测试

```bash
npm test
npm run typecheck
```

`npm run typecheck` 用 npx 临时运行 TypeScript，首次需要联网，不写入 `node_modules`。

测试依赖 `jiti`、`chalk` 与两个 host 包；`typebox` 是 `package.json` 里的 devDependency，装 host 包时会一并落到 `node_modules` 顶层。类型检查另需 `@types/node`（它在 host 包的开发依赖里，不会随上面这些包一起装上）。新 clone 且没有 `node_modules` 时，先装一份不写入 `package.json` 的依赖：

```bash
npm install --no-save --no-package-lock @earendil-works/pi-coding-agent@1.6.0 @earendil-works/pi-tui@1.6.0 jiti chalk @types/node
```

本机已经把 `node_modules` 指向 Pi 安装目录时，跳过这一步。

测试放在 `test/` 下，按 `extensions/` 的目录分组：`test/render/*.test.ts`、`test/agent/*.test.ts`，一个扩展一个测试文件，覆盖项写在用例名里。`test/integration.test.ts` 覆盖多个扩展同时安装。`test/agent/subagent.test.ts` 的进程用例启动假 `pi` 跑子进程，需要 PATH 上有 `bash`（Windows 下由 Git Bash 或 WSL 提供）。

## 许可

[MIT](LICENSE)
