# subagent

把任务交给跑在独立上下文里的子代理，主会话只收回结论。只隔离上下文，不隔离文件系统。

## 为什么要子代理

调研类工作会把主上下文淹掉：几十次 `read`、几百行 `grep` 输出、一堆日志，全部留在对话里。等你真正开始动手时，上下文已经被这些过程占满，而且它们对你之后的操作毫无用处。

子代理把这类工作关在另一个上下文窗口里跑完，只把结论递回来。过程留在它那边，结论进你这边。

```text
主会话
  subagent({ agent: "scout", task: "调研这个仓库的扩展加载顺序" })
      ↓
  子进程（独立上下文）：read → grep → bash → … → 结论
      ↓
主会话只收到「结论」
```

## 特性

### 单个任务与并行

工具名 `subagent`，两种模式。

单个任务：

```json
{ "agent": "scout", "task": "调研 extensions/render 下三个扩展的补丁注入点" }
```

并行多个任务（同一次调用里并发跑，上限与并发数见「限制」）：

```json
{
  "tasks": [
    { "agent": "scout", "task": "调研渲染类扩展如何拿到 theme" },
    { "agent": "scout", "task": "调研 skill-tool 如何改 system prompt" }
  ]
}
```

并行的收益是延迟：三个互不依赖的调研同时跑，总耗时接近最慢的那个，而不是三个相加。

失败会连同原因一起交回：正文与失败原因都进结果，主模型能分辨「没跑成」和「跑成了但结论是坏的」。

### 内置 agent

装好就能用，不需要写任何文件。要定制（换模型、限制工具、改提示词）再落盘成定义文件。

| | `explore` | `general-purpose` |
|---|---|---|
| 适用 | 只读调研：搜索代码、读文件、跑只读命令，返回压缩后的结论。需要改文件的任务不要用它 | 通用子代理：联网查资料、调用接口、多步取数与整理，也能改文件。不属于单纯代码调研的任务用它 |
| 工具 | `read` `bash` `grep` `find` `ls` + 已装扩展工具 | 同上，另外放开 `write` `edit` |
| `omitContext` | `true`：纯搜索不需要项目规矩 | `false`：要改文件就得知道项目规矩 |
| 模型 | 跟随调用方 | 跟随调用方 |

模型按描述自己选。例如「查询上海天气」这类任务派 `general-purpose`，「调研 extensions 目录」派 `explore`。

磁盘上写一个同名文件（如 `~/.pi/agent/agents/explore.md`）会覆盖内置。

### 自定义 agent 定义

一个带 YAML frontmatter 的 Markdown 文件，正文即子代理的系统提示。

```markdown
---
name: scout
description: 快速调研代码库，返回压缩后的上下文
tools: read, grep, find, ls, bash
model: company/deepseek-v4.1-flash
omitContext: true
---

你是一个侦察兵。快速调研并返回结构化发现，不要复述文件全文。

调研完成后的输出格式：

## 文件清单
列出关键文件与行范围。

## 关键代码
贴上类型定义与关键函数。

## 从一个文件开始
先看哪个文件，为什么。
```

| 字段 | 必填 | 作用 |
|---|---|---|
| `name` | 是 | 调用时用的名字 |
| `description` | 是 | **模型靠这句话决定什么时候派它**。写清楚适用场景 |
| `tools` | 否 | 工具名单，只写工具名。不写则继承（见下） |
| `model` | 否 | 不写则跟随调用方模型 |
| `omitContext` | 否 | `true` 时子代理不带 `AGENTS.md` / `CLAUDE.md` 启动 |
| `allowWrite` | 否 | 只在没写 `tools` 时生效：`true` 时放开 `write` / `edit`。默认关闭，理由见「子代理拿到哪些工具」 |

同名时优先级：项目级 > 用户级 > 内置。

| 存放位置 | 作用域 |
|---|---|
| `~/.pi/agent/agents/` | 全局，所有项目可用 |
| `<cwd 向上的最近一个>/.pi/agents/` | 项目级，同名时覆盖全局 |

两处一起扫。项目级定义属于项目本身，进项目就生效；查找方式与 `AGENTS.md` 相同，从当前目录逐级向上找最近的一个。

### 子代理拿到哪些工具

默认继承 pi 的默认工具集（没改过 `defaultTools` 时是 `read` `bash` `edit` `write`）**再补上 `grep` `find` `ls`**，然后减掉三项：

| 减掉的 | 原因 |
|---|---|
| `edit` `write` | 子代理的写入不进主上下文，主模型只看到一句摘要。文件被改了，你既不知道改了什么，也不知道改得对不对 |
| `subagent` | 防递归。子进程会加载同一个扩展，不排除就能无限嵌套 |

第一项可以用 `allowWrite: true` 单独放开（内置的 `general-purpose` 就是这么配置的），同时要求它把改动写进结论。`allowWrite` 只在没写 `tools` 时参与判定；写了 `tools`，能否写入由名单本身决定。`subagent` 永远减掉，`tools` 白名单也拦不住。

扩展工具（`skill`、web 搜索、MCP 等）照常继承。写了 `tools` 则整组替换，只剩你列的那些。名单是精确列表，不是追加。

名单只收精确工具名：`+name` / `-name` / `*` 是 pi 命令行的写法，写在定义文件里会被忽略。那几种形态会让 pi 关掉白名单、改按默认集加减，`--exclude-tools` 里的 `write` / `edit` 跟着失效。

`codemode` 也在继承范围内，但它绕不过上面的排除：被 `--exclude-tools` 移除的工具不会进入 `codemode` 脚本的 `ALL_TOOLS`。

边界一句话：`bash` 照样能改文件（`> f`、`sed -i`），MCP 工具也不受名单约束。pi 只在名单为空或出现 `mcp__*` 时才筛 MCP，而这里只写工具名，所以带写入或联网的 MCP 工具照常可用。这是**约定不是沙箱**，事后用 `git status` 校验。

### 委派的触发条件

模型会自己发起委派。两件事共同起作用：

1. **工具描述里的 agent 清单**：每条带 `description`，模型靠它决定派谁
2. **`promptGuidelines`**：工具活跃时，一条判断条件被写进 system prompt 的 `<rules>` 段

```text
- Use subagent for research that would otherwise flood the conversation: surveying
  an unfamiliar area, reading several files to answer one question, or searching
  repeatedly. Do that work yourself only when one or two targeted reads answer it.
```

工具描述只对已经想到这个工具的模型起作用：调研类任务里，模型往往一上来就自己 `bash` 扫。把判断条件写进 `<rules>` 段之后，「调研 extensions 下每个扩展做什么」这类请求会由模型自己拆成 `tasks` 数组，并行派两个 `explore`，不需要在请求里点名。

**规则提高触发率，不保证每次都先委派**：模型也可能先自己 `bash` 扫几轮，再把剩下的部分交给子代理。

## 安装

```bash
git clone https://github.com/DuskWander87/pi-toolkit
pi install ./pi-toolkit/extensions/agent/subagent   # 安装
pi -e ./pi-toolkit/extensions/agent/subagent        # 只试用一次，不写入配置
pi remove ./pi-toolkit/extensions/agent/subagent    # 卸载
```

在 clone 的上级目录执行，已经有仓库时跳过 `git clone`。更新时在 clone 目录执行 `git pull`，然后在 Pi 中 `/reload`。装齐全部扩展见[根 README](../../../README.md#快速开始)。

## 用法

- 直接在请求里点名（「派 explore 去调研 X」）最稳定；不点名时模型按 agent 的 `description` 自己选
- 主模型看不见过程，只有最终文本回来。要看细节，`Ctrl+O` 展开工具结果
- 没有扩展自己的配置项

## 限制

### 依赖

- 启动方式按 `argv[1]` 判定：它落在 pi 包目录里才复用（`node <cli.js>` / `bun <main.ts>` 启动）。运行时是 node 或 bun 时退回 PATH 上的 `pi`，Bun 单文件包这类自带运行时的可执行文件直接用自身路径
- 渲染依赖 pi-tui：调用行与展开视图是普通 `Text` / `Markdown` 组件，没有常驻状态面板

### 已知问题

- **只隔离上下文，不隔离文件系统**：子代理固定在主会话的工作目录里跑，与主会话共享同一份 git 状态
- **自主触发不稳定**：规则能提高概率，不保证每次都先委派。想稳定用，就在请求里直接点名
- **并行上限 8 个任务、4 个并发**：每个任务是一个完整 `pi` 进程，并发数直接决定内存占用
- **正文有体积上限**：单任务 50KB / 2000 行；`parallel` 按 100KB 均分给各任务，任务越少每条分得越多，避免一次调用灌满主上下文
- **没有超时**：子代理跑多久，这次工具调用就等多久，要停只能 `Ctrl+C`
- **定义在调用时现扫，描述里的清单另算**：中途改 agent 文件，下一次调用的子代理能读到新内容；模型看到的清单则等下一次 `prepareLoadout`（切工具或 `/reload`）才更新

### 非目标

- 后台任务、任务列表看板、`SendMessage` 续聊：工具执行是阻塞的，子代理跑完这一轮才继续，做不到「主线程继续、子代理后台跑、跑完汇报」
- chain 模式：串行流水线模型自己连着调两次即可，不值得为它多一套 `{previous}` 占位符语义
- `.claude/agents/` 兼容与工具名映射（`Read`→`read`、`Glob`→`find` 语义并不完全对等）
- `isolation: worktree`、持久记忆目录
- per-agent 的 `disallowedTools` 黑名单：`tools` 白名单已经够用
- 按名字排除某个扩展：pi 只有「全开」与 `--no-extensions`（连 `builtin:mcp` 一起关）两种，渲染类扩展会跟着加载，不值得为它维护一份能力类扩展清单

## 实现原理

每次调用起一个子进程：

```bash
pi --mode json -p --no-session
   --tools +grep,+find,+ls
   --exclude-tools write,edit,subagent      # allowWrite: false（默认）
   # --exclude-tools subagent               # allowWrite: true
   [--model <frontmatter 或调用方模型>]
   [--no-context-files]                     # omitContext: true
   --append-system-prompt <临时文件>          # agent 的 body
   "Task: <任务>"
```

- `--mode json` 下每行一条 JSONL 事件，取 `message_end` 累积消息与用量；`--no-session` 不写会话文件
- 成功判定不只看退出码：`--mode json` 下模型侧报错与输出超限也退出 0。收尾看最后一条助手消息，`stopReason` 为 `error` / `length` 算失败，`aborted` 算中止，收尾一轮没有文本的也算失败
- 系统提示写进临时文件，正文可以任意长，不受 argv 长度限制
- 思考等级只在跟随调用方模型时继承，frontmatter 换了模型就不传：调用方的等级未必落在新模型的区间里
- `Ctrl+C` 发 `SIGTERM`，5 秒后 `SIGKILL`

## 测试

`test/agent/subagent.test.ts` 覆盖定义解析、启动参数、JSONL 事件聚合、收尾判定、截断与并发限流。碰进程的部分用回放固定 JSONL 的假 `pi` 注入 `spawnCommand`，覆盖退出码、非 0 退出带 stderr、`stopReason` 为 `error`、收尾停在工具调用轮、形状不合约的事件被丢弃，以及系统提示临时目录不残留。运行方式见[根 README](../../../README.md#测试)。

---

返回 [pi-toolkit 根 README](../../../README.md)。
