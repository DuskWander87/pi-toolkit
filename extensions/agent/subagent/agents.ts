/**
 * agent 定义的发现与解析。
 *
 * 定义是带 YAML frontmatter 的 Markdown：frontmatter 声明身份，正文是子代理的系统提示。
 * 两级目录 —— 用户级 `${agentDir}/agents`，项目级 `<cwd 向上最近的>/.pi/agents`；
 * 两处一起扫，同名时项目级覆盖用户级。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export interface AgentConfig {
	name: string;
	description: string;
	/** 工具白名单。未给时继承默认，减去 write / edit / subagent。 */
	tools?: string[];
	/** 模型。未给时跟随调用方会话的模型与思考等级。 */
	model?: string;
	/** true 时子进程不带 AGENTS.md / CLAUDE.md 启动。 */
	omitContext: boolean;
	/** true 时放开 write / edit。默认关闭：子代理的改动不进主上下文。 */
	allowWrite: boolean;
	systemPrompt: string;
	source: "user" | "project" | "builtin";
	/** 内置 agent 没有文件，为空串。 */
	filePath: string;
}

export interface AgentDiscovery {
	agents: AgentConfig[];
}

/**
 * 内置 agent：不落盘也能用，免得装了工具却因为没写定义文件而跑不起来。
 * 磁盘上的同名定义会覆盖它。
 */
export const BUILTIN_AGENTS: readonly AgentConfig[] = [
	{
		name: "explore",
		description: "只读调研：搜索代码、读文件、跑只读命令，返回压缩后的结论。需要改文件的任务不要用它。",
		omitContext: true,
		allowWrite: false,
		source: "builtin",
		filePath: "",
		systemPrompt: [
			"你是一个只读调研代理。你的结论会交给一个没看过你读过的文件的主代理。",
			"",
			"工作方式：",
			"1. 用 grep / find / ls 定位，不要一上来通读整个目录",
			"2. 只读关键行区间，不要复述文件全文",
			"3. 记下文件路径与行范围，让主代理能直接跳过去",
			"",
			"输出格式：",
			"## 结论",
			"一两句话说清答案。",
			"",
			"## 依据",
			"- `path/to/file.ts` (行 10-50)：这里是什么",
			"",
			"## 未确认的部分",
			"没有就省略这一节。",
		].join("\n"),
	},
	{
		name: "general-purpose",
		description:
			"通用子代理：联网查资料、调用接口、多步取数与整理，也能改文件。不属于单纯代码调研的任务用它。",
		omitContext: false,
		allowWrite: true,
		source: "builtin",
		filePath: "",
		systemPrompt: [
			"你是一个通用子代理，在独立上下文里独立把任务做完。主代理看不到你的过程，只收到你的结论。",
			"",
			"工作方式：",
			"1. 能查证的就去查（网络、接口、命令行），不要凭记忆回答",
			"2. 一次查不到的换个源再试，不要空手而归",
			"3. 能改文件，但改了什么必须在结论里写清：主代理只看到你的结论，看不到你的编辑",
			"",
			"输出格式：",
			"## 结论",
			"直接回答任务。带上下数据的时间点与来源。",
			"",
			"## 改动",
			"- `path/to/file.ts`：改了什么。没改文件就省略这一节。",
			"",
			"## 未确认的部分",
			"查不到或互相矛盾的信息写在这里，不要自己编。",
		].join("\n"),
	},
];

/**
 * frontmatter 的原始形状。`parseFrontmatter` 跑真正的 YAML 解析，任何标量或集合都可能
 * 出现，所以字段一律 `unknown`，逐个校验后再用。
 *
 * 用 type 而非 interface：`parseFrontmatter` 的参数约束为 `Record<string, unknown>`，
 * 只有 type 会自动带上索引签名。
 */
type AgentFrontmatter = {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	model?: unknown;
	omitContext?: unknown;
	allowWrite?: unknown;
};

/**
 * 把 frontmatter 的 `tools` 归一成工具名列表。
 *
 * 两种写法都是合法 YAML，也都在用：
 *
 *     tools: read, bash        # 字符串
 *     tools: [read, bash]      # 数组
 *
 * 所以两种都收。其余形态（数字、映射、嵌套列表）按「没有 tools」处理而不抛错：
 * 这里跑在目录扫描中，一个坏文件不该带走同目录的其他 agent。
 *
 * 只收精确工具名。pi 的 `--tools` 还认 `+name` / `-name` 修饰符与 `*` 通配，但那两种写法会让
 * pi 关掉白名单、改按默认集加减（`allowedTools` 置空），`--exclude-tools` 里的 write / edit
 * 随之失效——一个写着 `-bash` 的只读 agent 反而拿到写权限。定义文件只写名字，修饰符不留口子。
 */
function parseToolList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const tools = raw
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => entry.trim())
		.filter(Boolean)
		.filter((entry) => !entry.startsWith("+") && !entry.startsWith("-") && !entry.includes("*"));
	return tools.length > 0 ? tools : undefined;
}

/** 解析单个定义文件的内容。`name` 与 `description` 缺任一即视为无效定义。 */
export function parseAgent(content: string, filePath: string, source: "user" | "project"): AgentConfig | undefined {
	const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content);
	if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") return undefined;

	const name = frontmatter.name.trim();
	const description = frontmatter.description.trim();
	if (!name || !description) return undefined;

	const model = typeof frontmatter.model === "string" ? frontmatter.model.trim() : "";
	return {
		name,
		description,
		tools: parseToolList(frontmatter.tools),
		model: model || undefined,
		omitContext: frontmatter.omitContext === true,
		allowWrite: frontmatter.allowWrite === true,
		systemPrompt: body.trim(),
		source,
		filePath,
	};
}

/** 扫描一个目录下的 `*.md`。读不动、解析失败、字段不全的文件跳过，不中断整轮扫描。 */
export function loadAgentsFromDirectory(dir: string, source: "user" | "project"): AgentConfig[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	const agents: AgentConfig[] = [];
	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		try {
			const agent = parseAgent(fs.readFileSync(filePath, "utf-8"), filePath, source);
			if (agent) agents.push(agent);
		} catch {
			// 坏文件（读不动、YAML 不合法）跳过；同目录其余定义照常可用。
		}
	}
	return agents;
}

function isDirectory(candidate: string): boolean {
	try {
		return fs.statSync(candidate).isDirectory();
	} catch {
		return false;
	}
}

/** 从 cwd 逐级向上找最近的 `.pi/agents`。 */
export function findProjectAgentsDir(cwd: string): string | null {
	let current = path.resolve(cwd);
	while (true) {
		const candidate = path.join(current, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

export function discoverAgents(cwd: string): AgentDiscovery {
	const projectDir = findProjectAgentsDir(cwd);
	const byName = new Map<string, AgentConfig>();

	// 优先级由低到高：内置 → 用户级 → 项目级，后者覆盖前者。
	for (const agent of BUILTIN_AGENTS) byName.set(agent.name, agent);
	for (const agent of loadAgentsFromDirectory(path.join(getAgentDir(), "agents"), "user")) {
		byName.set(agent.name, agent);
	}
	if (projectDir) {
		for (const agent of loadAgentsFromDirectory(projectDir, "project")) {
			byName.set(agent.name, agent);
		}
	}

	return { agents: [...byName.values()] };
}

/** 工具描述里的清单：一行一个 agent，标注来源与适用场景。 */
export function formatAgentCatalog(agents: AgentConfig[]): string {
	if (agents.length === 0) return "none";
	return agents.map((agent) => `- ${agent.name} (${agent.source}): ${agent.description}`).join("\n");
}
