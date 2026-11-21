# skill-tool

把技能的加载动作从 `read` 一个绝对路径换成 `skill` 工具，技能清单从 system prompt 下沉到工具描述。只移动清单与调用入口，不改技能文件本身。

## 两种加载方式

Pi 原生：清单在 system prompt 里，加载等于自己抄一个绝对路径再调通用 `read`。

```text
system prompt
  <skills>
  - write: Rewrites and polishes prose. …
    file: /Users/…/.agents/skills/write/SKILL.md
  </skills>

模型的动作
  read({ path: "/Users/…/.agents/skills/write/SKILL.md" })
```

本扩展：`<skills>` 段消失，同一份清单写进 `skill` 工具的描述。

```text
system prompt
  （没有 <skills> 段）

skill 工具的描述
  Load a skill's full instructions by exact name.
  <available_skills>
  - write: Rewrites and polishes prose. …
  </available_skills>

模型的动作
  skill({ name: "write" })
```

## 特性

### 差异

| | Pi 原生 | 本扩展 |
|---|---|---|
| 加载动作 | `read(<绝对路径>)` | `skill({ name })` |
| 清单载体 | system prompt 的 `<skills>` 段 | `skill` 工具的描述 |
| 模型的路径负担 | 调用前要抄一个绝对路径 | 只记名字，路径由扩展解析 |

### 清单与返回

`<skills>` 段不再出现在 system prompt 里，清单改由 `skill` 工具的描述携带；工具按名字返回技能正文，形状与 Pi 原生 `/skill:name` 一致。顺带省下 `<skills>` 段占的约 4000 字符。

## 安装

```bash
git clone https://github.com/DuskWander87/pi-toolkit
pi install ./pi-toolkit/extensions/agent/skill-tool   # 安装
pi -e ./pi-toolkit/extensions/agent/skill-tool        # 只试用一次，不写入配置
pi remove ./pi-toolkit/extensions/agent/skill-tool    # 卸载
```

在 clone 的上级目录执行，已经有仓库时跳过 `git clone`。更新时在 clone 目录执行 `git pull`，然后在 Pi 中 `/reload`。装齐全部扩展见[根 README](../../../README.md#快速开始)。

## 用法

- 模型自主调用 `skill({ name })`
- 开头的 `/skill:name` 仍由 Pi 原生支持，可以显式触发
- 没有扩展自己的配置项

## 与其他扩展

- 单独安装即可工作
- 没有自定义渲染：`skill` 工具行由 `minimal-tools` 的兜底渲染收成一行摘要

## 限制

### 依赖

- Pi 的内部结构：靠 `before_agent_start` 的 `systemPromptOptions` 是可写对象、`stripFrontmatter` 从包根导出。已在 Pi 1.6.0 验证，升级后可能失效

### 已知问题

- **这不是自动触发**：清单换了位置，决定权仍在模型：它得先想到技能存在、再看描述、再发起调用。原来那份清单在 system prompt 里，位置更显眼；现在在工具描述里，位置变了不等于注意力变了。工具化假设是否成立，只能靠行为验收来判断
- **会话内快照**：工具描述与目录在首次注册时固定，会话中途增删技能不反映，需要 `/new` 或 `/reload`
- **描述按一行渲染**：frontmatter 描述里的换行折叠成空格，`<`、`>`、`&` 转义后再写进清单，技能自己写的标记不会提前闭合 `<available_skills>`
- **`<tools>` 段不含 `skill`**：工具在 `before_agent_start` 内注册，晚于 prompt 的工具清单段落；工具声明与描述完整，模型仍可调用
- **`disableModelInvocation` 的技能**：既不给模型看，也加载不了，只能用 `/skill:name` 显式调用
- **工具没进活跃集合时不接管**：`skill` 被 `--tools`、`--exclude-tools` 或 `pi config` 过滤掉时，system prompt 的 `<skills>` 段与 `read` 路径照旧保留，不会出现「清单没了、工具也没了」
- **没有可见技能时不注册工具**：此时也不改 prompt，Pi 本来就不会生成空的 `<skills>` 段
- **工具名可能冲突**：`skill` 与未来 Pi 内置或第三方扩展重名时，以 Pi 的注册规则为准

### 非目标

- `skill_search` / 分页检索：当前技能数量少，不需要
- `$skill` / 内联 `/skill:` 解析：Pi 原生已支持开头的 `/skill:name`
- 可见性开关、权限策略
- 每轮额外注入提醒消息：一次只改一个变量，否则无法归因
- 把 `when_to_use` 拼进目录：同上，且要额外解析 frontmatter
- 修改任何技能的 frontmatter

## 实现原理

1. `before_agent_start` 里清空 `systemPromptOptions.skills`，Pi 重渲染时不再生成 `<skills>` 段
2. 同一份清单按「名字 + 一行描述」写进 `skill` 工具的描述
3. 工具执行时按名字查表，读出 `SKILL.md`、去掉 frontmatter
4. 按 Pi 原生 `/skill:name` 的形状返回正文

## 测试

`test/agent/skill-tool.test.ts` 覆盖目录文本：过滤、逐行格式、空输入、超长截断与被省略技能的名字、换行折叠与转义。注册路径覆盖 `before_agent_start` 的清空与单次注册、无可见技能时不注册，以及工具未启用与运行时被停用时的降级。工具执行覆盖未命中与命中的返回内容、读文件失败的错误标记。加载结果形状另有用例。运行方式见[根 README](../../../README.md#测试)。

---

返回 [pi-toolkit 根 README](../../../README.md)。
