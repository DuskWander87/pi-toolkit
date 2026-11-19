# skill-tool

把技能的加载动作从「read 一个绝对路径」换成「调一个专用工具」，让模型更容易想起来用技能。

## 之前

Pi 1.5.2 把技能清单放在 system prompt 的 `<skills>` 段里，只给一句软提示：任务匹配时用 `read` 读技能文件。

```text
system prompt
  <skills>
  - write: Rewrites and polishes prose. …
    file: /Users/…/.agents/skills/write/SKILL.md
  </skills>

模型的动作
  read({ path: "/Users/…/.agents/skills/write/SKILL.md" })
```

加载动作等于「自己抄一个绝对路径，再调通用 `read`」。本地 19 个会话的实测：模型自主加载技能文件 0 次；用户显式 `/skill:xxx` 3 次，全部成功。机制能用，自主触发没有发生。

## 之后

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

扩展在 `before_agent_start` 里清空 `systemPromptOptions.skills`，Pi 重渲染时 `<skills>` 段不再出现；同一份清单写进 `skill` 工具的描述。工具执行时按名字查表，读出 `SKILL.md`、去掉 frontmatter，按 Pi 原生 `/skill:name` 的形状返回正文。

## 差别

| | 之前 | 之后 |
|---|---|---|
| 加载动作 | `read(<绝对路径>)` | `skill({ name })` |
| 清单载体 | system prompt 的 `<skills>` 段 | `skill` 工具的描述 |
| 模型的路径负担 | 调用前要抄一个绝对路径 | 只记名字，路径由扩展解析 |

顺带省下 `<skills>` 段占的约 4000 字符。

## 它没有解决什么

这不是自动触发。清单换了位置，决定权仍在模型：它得先想到技能存在、再看描述、再发起调用。原来那份清单在 system prompt 里，位置更显眼；现在在工具描述里，位置变了不等于注意力变了。工具化假设是否成立，只能靠下面的行为验收来判断。

## 安装

安装、更新与卸载见[根 README](../../../README.md#快速开始)。只试用一次：

```bash
pi -e ./extensions/agent/skill-tool
```

## 验证

```bash
npm run typecheck
npm test
```

`--print` 不落盘，所以验收跑在一个临时会话目录里，跑完可以整目录删掉。

反证 `<skills>` 段已消失：

```bash
rm -rf /tmp/skill-check
pi -e ./extensions/agent/skill-tool --session-dir /tmp/skill-check --print "列出你当前能看到的工具名" >/dev/null
python3 -c "
import json, glob
for line in open(sorted(glob.glob('/tmp/skill-check/*.jsonl'))[-1]):
    message = json.loads(line).get('message') or {}
    if message.get('role') == 'system':
        print(sorted((message.get('sections') or {}).keys()))
"
```

期望：第一行的段键里没有 `skills`，仍有 `tools`、`rules`、`project_context`；后面的行是 Pi 的增量补丁，只列变化的段。

行为验收（唯一能证明触发发生了的证据）：

```bash
rm -rf /tmp/skill-check
pi -e ./extensions/agent/skill-tool --session-dir /tmp/skill-check --print "帮我润色这段文案：这个功能非常强大，可以有效地提升效率。"
grep -o '"name":"skill","arguments":{[^}]*}' /tmp/skill-check/*.jsonl | head -3
```

期望出现 `"name":"skill","arguments":{"name":"write"}`。

## 边界

- **会话内快照**：工具描述与目录在首次注册时固定，会话中途增删技能不反映，需要 `/new` 或 `/reload`
- **描述按一行渲染**：frontmatter 描述里的换行折叠成空格，`<`、`>`、`&` 转义后再写进清单，技能自己写的标记不会提前闭合 `<available_skills>`
- **`<tools>` 段不含 `skill`**：工具在 `before_agent_start` 内注册，晚于 prompt 的工具清单段落；工具声明与描述完整，模型仍可调用
- **`disableModelInvocation` 的技能**：既不给模型看，也加载不了，只能用 `/skill:name` 显式调用
- **工具没进活跃集合时不接管**：`skill` 被 `--tools`、`--exclude-tools` 或 `pi config` 过滤掉时，system prompt 的 `<skills>` 段与 `read` 路径照旧保留，不会出现「清单没了、工具也没了」
- **没有可见技能时不注册工具**：此时也不改 prompt，Pi 本来就不会生成空的 `<skills>` 段
- **工具名可能冲突**：`skill` 与未来 Pi 内置或第三方扩展重名时，以 Pi 的注册规则为准
- **依赖 Pi 的内部结构**：靠 `before_agent_start` 的 `systemPromptOptions` 是可写对象、`stripFrontmatter` 从包根导出。已在 Pi 1.5.2 验证，升级后可能失效
- **无自定义渲染**：`skill` 工具行由 `minimal-tools` 的兜底渲染收成一行摘要

## 不做

- `skill_search` / 分页检索：技能数在个位数，不需要
- `$skill` / 内联 `/skill:` 解析：Pi 原生已支持开头的 `/skill:name`
- 可见性开关、权限策略
- 每轮额外注入提醒消息：一次只改一个变量，否则无法归因
- 把 `when_to_use` 拼进目录：同上，且要额外解析 frontmatter
- 修改任何技能的 frontmatter

## 测试

`test/skill-tool.test.ts` 覆盖目录文本（过滤、逐行格式、空输入、超长截断与被省略技能的名字、换行折叠与转义）、加载结果形状、`before_agent_start` 的
清空与单次注册、无可见技能时不注册、工具未启用与运行时被停用时的降级、工具未命中与命中的返回内容、读文件失败的错误标记。运行方式见[根 README](../../../README.md#测试)。

---

返回 [pi-toolkit 根 README](../../../README.md)。
