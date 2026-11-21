/**
 * subagent 的纯函数：定义发现与解析、启动参数、事件流聚合。
 *
 * 不碰网络与子进程；真实模型的行为不在覆盖范围内。
 */

import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { initTheme, getPackageDir } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import installSubagent, { bodyText, parallelSummary } from "../../extensions/agent/subagent/index.ts";
import {
	type AgentConfig,
	discoverAgents,
	findProjectAgentsDir,
	formatAgentCatalog,
	loadAgentsFromDirectory,
	parseAgent,
} from "../../extensions/agent/subagent/agents.ts";
import {
	DEFAULT_EXCLUDED_TOOLS,
	LineBuffer,
	ALWAYS_EXCLUDED_TOOLS,
	type TaskResult,
	addUsage,
	buildArgs,
	concludesWithText,
	emptyUsage,
	finalText,
	mapWithConcurrencyLimit,
	parseMessageEvent,
	piInvocation,
	runAgent,
	stopFailure,
} from "../../extensions/agent/subagent/run.ts";
import { check, finish } from "../harness.ts";

initTheme("dark", false);

/** 建一个临时目录，用完删掉。 */
function tempDir(): { path: string; cleanup: () => void } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-test-"));
	return { path: dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function writeFile(dir: string, name: string, content: string): string {
	const filePath = path.join(dir, name);
	fs.writeFileSync(filePath, content);
	return filePath;
}

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "scout",
		description: "快速调研",
		omitContext: false,
		allowWrite: false,
		systemPrompt: "你是侦察兵。",
		source: "user",
		filePath: "/tmp/scout.md",
		...overrides,
	};
}

// ============================================================================
// 定义解析
// ============================================================================

check("parseAgent：完整定义映射到字段", () => {
	const parsed = parseAgent(
		["---", "name: scout", "description: 快速调研代码库", "model: company/deepseek-v4.1-flash", "---", "", "你是侦察兵。"].join(
			"\n",
		),
		"/tmp/scout.md",
		"user",
	);
	assert.ok(parsed);
	assert.equal(parsed.name, "scout");
	assert.equal(parsed.description, "快速调研代码库");
	assert.equal(parsed.model, "company/deepseek-v4.1-flash");
	assert.equal(parsed.systemPrompt, "你是侦察兵。");
	assert.equal(parsed.omitContext, false);
	assert.equal(parsed.tools, undefined);
});

check("parseAgent：缺 name 或 description 时返回 undefined", () => {
	assert.equal(parseAgent("---\nname: scout\n---\n正文", "/tmp/a.md", "user"), undefined);
	assert.equal(parseAgent("---\ndescription: 只有描述\n---\n正文", "/tmp/a.md", "user"), undefined);
	assert.equal(parseAgent("---\nname: '  '\ndescription: x\n---\n正文", "/tmp/a.md", "user"), undefined);
});

check("parseAgent：tools 的字符串与数组写法等价", () => {
	const asString = parseAgent("---\nname: a\ndescription: d\ntools: read, bash\n---\n正文", "/tmp/a.md", "user");
	const asArray = parseAgent("---\nname: a\ndescription: d\ntools: [read, bash]\n---\n正文", "/tmp/a.md", "user");
	assert.deepEqual(asString?.tools, ["read", "bash"]);
	assert.deepEqual(asArray?.tools, ["read", "bash"]);
});

check("parseAgent：tools 的异常形态按未声明处理", () => {
	const parsed = parseAgent("---\nname: a\ndescription: d\ntools: 42\n---\n正文", "/tmp/a.md", "user");
	assert.equal(parsed?.tools, undefined);
});

check("parseAgent：tools 里的 +name / -name / * 被丢弃", () => {
	const tools = (yaml: string) =>
		parseAgent(`---\nname: a\ndescription: d\ntools: ${yaml}\n---\n正文`, "/tmp/a.md", "user")?.tools;

	// 修饰符会让 pi 关掉白名单、改按默认集加减，write / edit 的排除跟着失效：只收精确工具名。
	assert.deepEqual(tools("read, grep"), ["read", "grep"]);
	assert.deepEqual(tools("[read, -bash]"), ["read"]);
	assert.equal(tools('["-bash"]'), undefined);
	assert.equal(tools('["+codemode"]'), undefined);
	assert.equal(tools('["*"]'), undefined);
});

check("parseAgent：omitContext 只有 true 才生效", () => {
	const on = parseAgent("---\nname: a\ndescription: d\nomitContext: true\n---\n正文", "/tmp/a.md", "user");
	const off = parseAgent("---\nname: a\ndescription: d\nomitContext: yes\n---\n正文", "/tmp/a.md", "user");
	assert.equal(on?.omitContext, true);
	assert.equal(off?.omitContext, false);
});

// ============================================================================
// 目录扫描
// ============================================================================

check("loadAgentsFromDirectory：坏文件跳过，好文件照常加载", () => {
	const dir = tempDir();
	try {
		writeFile(dir.path, "good.md", "---\nname: good\ndescription: 可用\n---\n正文");
		writeFile(dir.path, "no-description.md", "---\nname: broken\n---\n正文");
		writeFile(dir.path, "bad-yaml.md", "---\nname: [unclosed\n---\n正文");
		writeFile(dir.path, "notes.txt", "不是 markdown");

		const agents = loadAgentsFromDirectory(dir.path, "user");
		assert.deepEqual(
			agents.map((entry) => entry.name),
			["good"],
		);
	} finally {
		dir.cleanup();
	}
});

check("loadAgentsFromDirectory：目录不存在时返回空数组", () => {
	assert.deepEqual(loadAgentsFromDirectory("/nonexistent/pi-subagent-test", "user"), []);
});

check("findProjectAgentsDir：从子目录向上找到最近的一个", () => {
	const root = tempDir();
	try {
		const projectAgents = path.join(root.path, ".pi", "agents");
		fs.mkdirSync(projectAgents, { recursive: true });
		const nested = path.join(root.path, "src", "deep");
		fs.mkdirSync(nested, { recursive: true });

		assert.equal(findProjectAgentsDir(nested), projectAgents);
	} finally {
		root.cleanup();
	}
});

check("discoverAgents：项目级同名定义覆盖用户级", () => {
	const root = tempDir();
	const agentDir = path.join(root.path, "agent");
	const projectAgents = path.join(root.path, "project", ".pi", "agents");
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
		fs.mkdirSync(projectAgents, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = agentDir;

		writeFile(path.join(agentDir, "agents"), "scout.md", "---\nname: scout\ndescription: 用户级\n---\n用户级正文");
		writeFile(projectAgents, "scout.md", "---\nname: scout\ndescription: 项目级\n---\n项目级正文");
		writeFile(projectAgents, "extra.md", "---\nname: extra\ndescription: 只在项目里\n---\n正文");

		const discovery = discoverAgents(path.join(root.path, "project"));
		assert.deepEqual(
			discovery.agents.map((entry) => [entry.name, entry.source]),
			[
				["explore", "builtin"],
				["general-purpose", "builtin"],
				["scout", "project"],
				["extra", "project"],
			],
		);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		root.cleanup();
	}
});

check("discoverAgents：没有磁盘定义时内置 agent 仍可用", () => {
	const dir = tempDir();
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = path.join(dir.path, "agent");
		const discovery = discoverAgents(dir.path);
		assert.deepEqual(
			discovery.agents.map((entry) => [entry.name, entry.source]),
			[
				["explore", "builtin"],
				["general-purpose", "builtin"],
			],
		);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		dir.cleanup();
	}
});

check("discoverAgents：磁盘上的同名定义覆盖内置 agent", () => {
	const dir = tempDir();
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		const agentsDir = path.join(dir.path, "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = dir.path;
		writeFile(agentsDir, "explore.md", "---\nname: explore\ndescription: 我自己的 explore\n---\n正文");

		const discovery = discoverAgents(dir.path);
		const explore = discovery.agents.filter((entry) => entry.name === "explore");
		assert.deepEqual(
			explore.map((entry) => [entry.source, entry.description]),
			[["user", "我自己的 explore"]],
		);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		dir.cleanup();
	}
});

check("formatAgentCatalog：标注来源，空列表返回 none", () => {
	assert.equal(formatAgentCatalog([]), "none");
	const text = formatAgentCatalog([agent({ name: "explore", source: "builtin", description: "只读调研" })]);
	assert.equal(text, "- explore (builtin): 只读调研");
});

// ============================================================================
// 启动参数
// ============================================================================

check("buildArgs：没写 tools 时继承默认工具集、补上调研三件套、减掉写入与自身", () => {
	const args = buildArgs(agent(), "调研这个仓库", { model: "company/flash", thinkingLevel: "high" });
	assert.deepEqual(args.slice(0, 4), ["--mode", "json", "-p", "--no-session"]);
	assert.ok(args.includes("--model"));
	assert.equal(args[args.indexOf("--model") + 1], "company/flash");
	assert.equal(args[args.indexOf("--thinking") + 1], "high");
	assert.equal(args[args.indexOf("--tools") + 1], "+grep,+find,+ls");
	assert.equal(args[args.indexOf("--exclude-tools") + 1], DEFAULT_EXCLUDED_TOOLS);
	assert.ok(!args.includes("--no-context-files"));
	assert.equal(args.at(-1), "Task: 调研这个仓库");
});

check("buildArgs：frontmatter 指定模型时用它，且不继承思考等级", () => {
	const args = buildArgs(agent({ model: "company/other" }), "任务", { model: "company/flash", thinkingLevel: "high" });
	assert.equal(args[args.indexOf("--model") + 1], "company/other");
	assert.ok(!args.includes("--thinking"));
});

check("buildArgs：allowWrite 只排除自身，放开 write / edit", () => {
	const args = buildArgs(agent({ allowWrite: true }), "任务", {});
	assert.equal(args[args.indexOf("--exclude-tools") + 1], ALWAYS_EXCLUDED_TOOLS);
	assert.ok(!(args[args.indexOf("--exclude-tools") + 1] as string).includes("write"));
});

check("buildArgs：tools 白名单整组替换，但仍排除自身防递归", () => {
	const args = buildArgs(agent({ tools: ["read", "grep", "bash"] }), "任务", {});
	assert.equal(args[args.indexOf("--tools") + 1], "read,grep,bash");
	assert.equal(args[args.indexOf("--exclude-tools") + 1], "subagent");
});

check("buildArgs：omitContext 关掉 AGENTS.md 发现", () => {
	const args = buildArgs(agent({ omitContext: true }), "任务", {});
	assert.ok(args.includes("--no-context-files"));
});

check("buildArgs：系统提示走临时文件参数", () => {
	const args = buildArgs(agent(), "任务", {}, "/tmp/system-prompt.md");
	assert.equal(args[args.indexOf("--append-system-prompt") + 1], "/tmp/system-prompt.md");
});

// ============================================================================
// 事件流
// ============================================================================

check("parseMessageEvent：只认 message_end 里的对话消息", () => {
	const assistant = { role: "assistant", content: [], usage: {} };
	assert.deepEqual(parseMessageEvent(JSON.stringify({ type: "message_end", message: assistant })), assistant);
	assert.equal(parseMessageEvent(JSON.stringify({ type: "turn_start" })), undefined);
	assert.equal(parseMessageEvent(JSON.stringify({ type: "message_end", message: { role: "system" } })), undefined);
	assert.equal(parseMessageEvent("not json"), undefined);
	assert.equal(parseMessageEvent(""), undefined);
});

check("parseMessageEvent：缺 usage 或正文不是数组的助手消息被丢弃", () => {
	// 子进程版本可能与宿主不同。这两种行在 addUsage / finalText 里会抛未捕获异常，
	// 而在事件回调里抛，赔上的是宿主进程。
	const line = (message: unknown) => JSON.stringify({ type: "message_end", message });
	assert.equal(parseMessageEvent(line({ role: "assistant" })), undefined);
	assert.equal(parseMessageEvent(line({ role: "assistant", content: [] })), undefined);
	assert.equal(parseMessageEvent(line({ role: "assistant", content: [], usage: null })), undefined);
	assert.equal(parseMessageEvent(line({ role: "assistant", content: "正文", usage: {} })), undefined);
});

check("addUsage：累加助手消息，非助手消息原样返回", () => {
	const first = addUsage(emptyUsage(), {
		role: "assistant",
		content: [],
		usage: { input: 100, output: 20, totalTokens: 120 },
	} as never);
	const second = addUsage(first, {
		role: "assistant",
		content: [],
		usage: { input: 50, output: 10, totalTokens: 180 },
	} as never);
	assert.deepEqual(second, { input: 150, output: 30, contextTokens: 180 });

	const untouched = addUsage(second, { role: "user", content: "hi" } as never);
	assert.equal(untouched, second);
});

check("LineBuffer：切在多字节字符中间的块不会变成替换字符", () => {
	const line = JSON.stringify({
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text: "结论：中文" }], usage: { input: 1, output: 1, totalTokens: 2 } },
	});
	const bytes = Buffer.from(`${line}\n`, "utf8");
	// 切在「结」的三个字节中间：逐块 toString() 会把两半各解成一个 U+FFFD。
	const cut = bytes.indexOf(Buffer.from("结", "utf8")) + 1;

	const buffer = new LineBuffer();
	assert.deepEqual(buffer.push(bytes.subarray(0, cut)), []);

	const lines = buffer.push(bytes.subarray(cut));
	assert.deepEqual(lines, [line]);
	assert.ok(!lines[0].includes("\uFFFD"), lines[0]);

	const message = parseMessageEvent(lines[0]);
	assert.ok(message && message.role === "assistant", JSON.stringify(message));
	const block = message.content[0];
	assert.equal(block.type === "text" ? block.text : undefined, "结论：中文");
});

check("LineBuffer：只交出完整行，没有换行收尾的最后一行留给 flush", () => {
	const buffer = new LineBuffer();
	assert.deepEqual(buffer.push(Buffer.from('{"a":1}\n{"b":2', "utf8")), ['{"a":1}']);
	assert.equal(buffer.flush(), '{"b":2');
	assert.equal(buffer.flush(), "");
});

check("finalText：取最后一条有文本的助手消息", () => {
	const messages = [
		{ role: "user", content: "调研这个仓库", timestamp: 0 },
		{ role: "assistant", content: [{ type: "text", text: "第一版" }] },
		{ role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: {} }] },
		{ role: "assistant", content: [{ type: "text", text: "最终结论" }] },
	];
	assert.equal(finalText(messages as never), "最终结论");
	assert.equal(finalText([]), "");
});

check("concludesWithText：收尾那一轮没有文本就不算有结论", () => {
	const text = (value: string) => ({ role: "assistant", content: [{ type: "text", text: value }], stopReason: "stop" });
	const toolOnly = {
		role: "assistant",
		content: [{ type: "toolCall", name: "read", arguments: {} }],
		stopReason: "toolUse",
	};

	assert.equal(concludesWithText([text("结论")] as never), true);
	// 过场话后面又调了一次工具：finalText 回溯拿到的是「先读文件」，那不是结论。
	assert.equal(concludesWithText([text("先读文件"), toolOnly] as never), false);
	assert.equal(concludesWithText([toolOnly, { role: "toolResult", content: [] }] as never), false);
	assert.equal(concludesWithText([]), false);
});

check("stopFailure：退出码为 0 也要把模型侧失败认出来", () => {
	const withLast = (stopReason: string, errorMessage?: string) =>
		[
			{ role: "assistant", content: [{ type: "text", text: "半成品" }], stopReason: "stop" },
			{ role: "assistant", content: [], stopReason, errorMessage },
		] as never[];

	assert.deepEqual(stopFailure(withLast("error", "provider 429")), {
		status: "failed",
		error: "模型侧报错：provider 429",
	});
	assert.equal(stopFailure(withLast("error"))?.error, "模型侧报错：未说明原因");
	assert.deepEqual(stopFailure(withLast("length")), { status: "failed", error: "输出达到 token 上限被截断" });
	assert.equal(stopFailure(withLast("aborted", "用户中断"))?.status, "aborted");

	// 正常收尾与「末条不是助手消息」都不算失败。
	assert.equal(stopFailure(withLast("stop")), undefined);
	assert.equal(stopFailure([{ role: "user", content: "x" }] as never[]), undefined);
	assert.equal(stopFailure([]), undefined);
});

// ============================================================================
// 正文截断
// ============================================================================

/** 截断提示之前的正文前缀。 */
function prefixOf(text: string): string {
	const at = text.indexOf("\n\n[输出被截断");
	return at === -1 ? text : text.slice(0, at);
}

check("bodyText：短正文原样返回", () => {
	assert.equal(bodyText(taskResult({ output: "三个渲染扩展都在模块加载时打补丁。" })), "三个渲染扩展都在模块加载时打补丁。");
});

check("bodyText：首行就超过上限时仍交回前缀，不能只剩一句「已截断」", () => {
	const oneLine = "结".repeat(20000); // 单行 60KB，超过默认 50KB
	const text = bodyText(taskResult({ output: oneLine }));

	const prefix = prefixOf(text);
	assert.ok(prefix.length > 0, text.slice(0, 200));
	assert.ok(text.includes("输出被截断"), text.slice(-120));
	assert.ok(!prefix.includes("\uFFFD"), "前缀切坏了多字节字符");
	assert.ok(Buffer.byteLength(prefix, "utf8") <= 50 * 1024, `前缀 ${Buffer.byteLength(prefix, "utf8")} 字节`);
});

check("bodyText：并行模式的均额上限同样有前缀兜底", () => {
	const oneLine = "x".repeat(20000);
	const text = bodyText(taskResult({ output: oneLine }), 12 * 1024);

	const prefix = prefixOf(text);
	assert.ok(prefix.length > 0, text.slice(0, 200));
	assert.ok(Buffer.byteLength(prefix, "utf8") <= 12 * 1024, `前缀 ${Buffer.byteLength(prefix, "utf8")} 字节`);
});

check("bodyText：失败时正文之后带上失败原因", () => {
	const text = bodyText(taskResult({ status: "failed", output: "半成品结论", error: "子进程退出码 3：boom" }));
	assert.ok(text.includes("半成品结论"), text);
	assert.ok(text.includes("子进程退出码 3：boom"), text);
	assert.ok(text.indexOf("半成品结论") < text.indexOf("子进程退出码 3"), text);
});

check("bodyText：正文超预算时失败原因仍然交回", () => {
	const text = bodyText(
		taskResult({ status: "failed", output: "结".repeat(20000), error: "子进程退出码 1：boom" }),
	);
	assert.ok(prefixOf(text).length > 0, text.slice(0, 120));
	assert.ok(text.includes("输出被截断"), text.slice(-160));
	// 原因在正文之后、又是最先被切掉的一段，但它才是判断「没跑成」的依据。
	assert.ok(text.includes("子进程退出码 1：boom"), text.slice(-160));
});

check("bodyText：2000 行上限生效", () => {
	const output = Array.from({ length: 2100 }, (_, index) => `第 ${index} 行`).join("\n");
	const text = bodyText(taskResult({ output }));

	assert.ok(text.includes("输出被截断"), text.slice(-120));
	assert.equal(prefixOf(text).split("\n").length, 2000);
	assert.ok(prefixOf(text).startsWith("第 0 行"), "保留开头");
});

check("parallelSummary：成功计数、每条任务一小节、按任务数均分预算", () => {
	const text = parallelSummary([
		taskResult({ agent: "scout", output: "第一条结论" }),
		taskResult({ agent: "planner", status: "failed", output: "", error: "子进程退出码 1" }),
	]);
	assert.ok(text.startsWith("并行：1/2 成功"), text);
	assert.ok(text.includes("### [scout] completed"), text);
	assert.ok(text.includes("### [planner] failed"), text);
	assert.ok(text.includes("第一条结论") && text.includes("子进程退出码 1"), text);

	// 8 条并行各得到 12.5KB 均额，超出的正文逐条截断，不让一次调用灌满主上下文。
	const eight = parallelSummary(Array.from({ length: 8 }, () => taskResult({ output: "y".repeat(20000) })));
	assert.equal((eight.match(/输出被截断/g) ?? []).length, 8, eight.slice(0, 200));
});

// ============================================================================
// 并发
// ============================================================================

check("mapWithConcurrencyLimit：结果保持顺序且并发不超限", async () => {
	let inFlight = 0;
	let peak = 0;
	const items = [30, 10, 20, 5, 15, 25];
	const results = await mapWithConcurrencyLimit(items, 2, async (delay, index) => {
		inFlight++;
		peak = Math.max(peak, inFlight);
		await new Promise((resolve) => setTimeout(resolve, delay));
		inFlight--;
		return index;
	});
	assert.deepEqual(results, [0, 1, 2, 3, 4, 5]);
	// 峰值必须是 2：串行实现也能通过 `peak <= 2`，那样这个用例证明不了限流。
	assert.equal(peak, 2, `并发峰值 ${peak}，应为 2`);
	assert.deepEqual(await mapWithConcurrencyLimit([] as number[], 4, async () => 0), []);
});

// ============================================================================
// 启动方式
// ============================================================================

check("piInvocation：宿主不是 pi 时不用它的 argv[1] 当子进程命令", () => {
	const dir = tempDir();
	try {
		const foreign = writeFile(dir.path, "app.js", "// 别人的 Node 程序");
		const invocation = piInvocation(["--mode", "json"], { script: foreign, execPath: "/usr/local/bin/node" });
		assert.deepEqual(invocation, { command: "pi", args: ["--mode", "json"] });
	} finally {
		dir.cleanup();
	}
});

check("piInvocation：argv[1] 属于 pi 包时复用它", () => {
	// 只要文件在 pi 包目录里就能当入口：不挑安装布局（npm 包的 dist/cli.js 或 Bun 单文件包）。
	const script = path.join(getPackageDir(), "package.json");
	const invocation = piInvocation(["-p"], { script, execPath: "/usr/local/bin/node" });
	assert.deepEqual(invocation, { command: "/usr/local/bin/node", args: [script, "-p"] });
});

check("piInvocation：自带运行时的可执行文件直接用 execPath", () => {
	const invocation = piInvocation(["-p"], { script: undefined, execPath: "/Users/me/.pi/agent/bin/pi" });
	assert.deepEqual(invocation, { command: "/Users/me/.pi/agent/bin/pi", args: ["-p"] });
});

check("piInvocation：argv[1] 不存在时退回 PATH 上的 pi", () => {
	assert.deepEqual(
		piInvocation(["-p"], { script: "/nonexistent/pi-subagent-test/cli.js", execPath: "/usr/local/bin/node" }),
		{ command: "pi", args: ["-p"] },
	);
});

// ============================================================================
// 进程路径
// ============================================================================

interface FakePi {
	command: string[];
	cleanup: () => void;
}

/** 用 bash 显式执行假 `pi`：Windows 上的 `spawn` 不能直接执行无扩展名的脚本。 */
function piCommand(file: string): string[] {
	return ["bash", file];
}

/** 写一个假 `pi`：它按脚本回放 JSONL，不跑模型。 */
function fakePi(body: string[]): FakePi {
	const dir = tempDir();
	const file = path.join(dir.path, "pi");
	fs.writeFileSync(file, ["#!/bin/sh", ...body, ""].join("\n"), { mode: 0o755 });
	return { command: piCommand(file), cleanup: dir.cleanup };
}

/**
 * 假 `pi`：除了回放 JSONL，还把收到的 argv 记下来，并把 `--append-system-prompt` 指向的
 * 文件内容抄到旁边——系统提示文件在子进程退出后就会被删，只能这样看它真的被传过。
 */
function recordingFakePi(body: string[]): FakePi & { argv: () => string[]; prompt: () => string | undefined } {
	const dir = tempDir();
	const file = path.join(dir.path, "pi");
	const argvLog = path.join(dir.path, "argv.log");
	const promptCopy = path.join(dir.path, "prompt.md");
	const script = [
		"#!/bin/sh",
		`: > "${argvLog}"`,
		'prev=""',
		'for arg in "$@"; do',
		`  printf '%s\\n' "$arg" >> "${argvLog}"`,
		`  if [ "$prev" = "--append-system-prompt" ]; then cp "$arg" "${promptCopy}" 2>/dev/null; fi`,
		'  prev="$arg"',
		"done",
		...body,
		"",
	].join("\n");
	fs.writeFileSync(file, script, { mode: 0o755 });
	return {
		command: piCommand(file),
		cleanup: dir.cleanup,
		argv: () => fs.readFileSync(argvLog, "utf-8").split("\n"),
		prompt: () => (fs.existsSync(promptCopy) ? fs.readFileSync(promptCopy, "utf-8") : undefined),
	};
}

/** 逐行回放 JSONL。 */
function echoLines(lines: string[]): string[] {
	return lines.map((line) => `printf '%s\\n' '${line}'`);
}

function assistantMessage(text: string, totalTokens: number): string {
	return JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0 }, totalTokens },
		},
	});
}

/** 系统提示临时目录的当前快照，用来检查有没有残留。 */
function promptTempDirs(): string[] {
	return fs.readdirSync(os.tmpdir()).filter((entry) => entry.startsWith("pi-subagent-"));
}

check("runAgent：正常退出时取最后一段文本，用量累加", async () => {
	const fake = fakePi(
		echoLines([
			assistantMessage("第一版", 12),
			JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", name: "read", arguments: {} }],
					usage: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 }, totalTokens: 16 },
				},
			}),
			assistantMessage("最终结论", 20),
		]),
	);
	try {
		const result = await runAgent({
			agent: agent(),
			task: "调研",
			defaults: {},
			cwd: process.cwd(),
			spawnCommand: fake.command,
		});
		assert.equal(result.status, "completed");
		assert.equal(result.output, "最终结论");
		assert.equal(result.usage.input, 23);
		assert.equal(result.usage.contextTokens, 20);
	} finally {
		fake.cleanup();
	}
});

check("runAgent：退出码 0 但末条消息 stopReason=error 算失败", async () => {
	const fake = fakePi(
		echoLines([
			assistantMessage("半截结论", 12),
			JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [],
					stopReason: "error",
					errorMessage: "provider 429: rate limited",
					usage: { input: 3, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 }, totalTokens: 15 },
				},
			}),
		]),
	);
	try {
		const result = await runAgent({
			agent: agent(),
			task: "调研",
			defaults: {},
			cwd: process.cwd(),
			spawnCommand: fake.command,
		});
		assert.equal(result.status, "failed");
		assert.equal(result.error, "模型侧报错：provider 429: rate limited");
		// 半成品正文保留，但状态不再是 completed。
		assert.equal(result.output, "半截结论");
	} finally {
		fake.cleanup();
	}
});

check("runAgent：非 0 退出时把退出码与 stderr 带进错误", async () => {
	const fake = fakePi([...echoLines([assistantMessage("半成品", 12)]), "printf '%s\\n' 'boom: 配置缺失' >&2", "exit 3"]);
	try {
		const result = await runAgent({
			agent: agent(),
			task: "调研",
			defaults: {},
			cwd: process.cwd(),
			spawnCommand: fake.command,
		});
		assert.equal(result.status, "failed");
		assert.ok(result.error?.includes("3"), result.error);
		assert.ok(result.error?.includes("boom: 配置缺失"), result.error);
		assert.equal(result.output, "半成品");
	} finally {
		fake.cleanup();
	}
});

check("runAgent：正常退出但没有文本算失败", async () => {
	const fake = fakePi(
		echoLines([
			JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", name: "read", arguments: {} }],
					usage: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 }, totalTokens: 16 },
				},
			}),
		]),
	);
	try {
		const result = await runAgent({
			agent: agent(),
			task: "调研",
			defaults: {},
			cwd: process.cwd(),
			spawnCommand: fake.command,
		});
		assert.equal(result.status, "failed");
		assert.equal(result.error, "子进程正常退出但没有返回文本");
	} finally {
		fake.cleanup();
	}
});

check("runAgent：形状不合约的事件被丢弃，任务以没有文本收尾失败", async () => {
	// 子进程可能不是被验证过的 pi（版本不同或 PATH 上另一个同名程序）。这种行以前在
	// stdout 回调里抛未捕获异常，赔上的是整个宿主进程。
	const fake = fakePi(echoLines([JSON.stringify({ type: "message_end", message: { role: "assistant" } })]));
	try {
		const result = await runAgent({
			agent: agent(),
			task: "调研",
			defaults: {},
			cwd: process.cwd(),
			spawnCommand: fake.command,
		});
		assert.equal(result.status, "failed");
		assert.equal(result.error, "子进程正常退出但没有返回文本");
	} finally {
		fake.cleanup();
	}
});

check("runAgent：收尾停在工具调用轮算失败，过场话不当结论", async () => {
	const fake = fakePi(
		echoLines([
			assistantMessage("先读文件", 12),
			JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", name: "read", arguments: {} }],
					stopReason: "toolUse",
					usage: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 }, totalTokens: 16 },
				},
			}),
		]),
	);
	try {
		const result = await runAgent({
			agent: agent(),
			task: "调研",
			defaults: {},
			cwd: process.cwd(),
			spawnCommand: fake.command,
		});
		assert.equal(result.status, "failed");
		assert.equal(result.error, "子代理停在工具调用轮，没有给出结论");
		// 正文仍是回溯到的那句，但状态不再是 completed。
		assert.equal(result.output, "先读文件");
	} finally {
		fake.cleanup();
	}
});

check("runAgent：系统提示确实通过 --append-system-prompt 传参", async () => {
	const fake = recordingFakePi(echoLines([assistantMessage("结论", 12)]));
	try {
		const result = await runAgent({
			agent: agent(),
			task: "调研",
			defaults: {},
			cwd: process.cwd(),
			spawnCommand: fake.command,
		});
		assert.equal(result.status, "completed");

		const argv = fake.argv();
		assert.ok(argv.includes("--append-system-prompt"), argv.join(" | "));
		// 只有文件在子进程运行时存在，cp 才拿得到内容。
		assert.equal(fake.prompt(), "你是侦察兵。");
	} finally {
		fake.cleanup();
	}
});

check("runAgent：启动不了子进程时把原因带回来", async () => {
	const result = await runAgent({
		agent: agent(),
		task: "调研",
		defaults: {},
		cwd: process.cwd(),
		spawnCommand: path.join(os.tmpdir(), "pi-subagent-missing-binary"),
	});
	assert.equal(result.status, "failed");
	assert.ok(result.error?.startsWith("无法启动子进程："), result.error);
});

check("runAgent：中止后标 aborted，系统提示临时目录不残留", async () => {
	const fake = fakePi(["exec sleep 30"]);
	const before = promptTempDirs();
	const controller = new AbortController();
	try {
		const pending = runAgent({
			agent: agent(),
			task: "长任务",
			defaults: {},
			cwd: process.cwd(),
			signal: controller.signal,
			spawnCommand: fake.command,
		});
		setTimeout(() => controller.abort(), 100);

		const result = await pending;
		assert.equal(result.status, "aborted");
		assert.deepEqual(
			promptTempDirs().filter((entry) => !before.includes(entry)),
			[],
		);
	} finally {
		fake.cleanup();
	}
});

// ============================================================================
// 渲染
// ============================================================================

interface RenderedTool {
	description: string;
	promptGuidelines?: string[];
	prepareLoadout?(loadout: { declared: { name: string }[] }): { descriptions?: Record<string, string> } | undefined;
	renderCall(args: unknown, theme: unknown): { render(width: number): string[] };
	renderResult(result: unknown, options: { expanded: boolean }, theme: unknown): { render(width: number): string[] };
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal: undefined,
		onUpdate: undefined,
		ctx: unknown,
	): Promise<ToolOutcome>;
}

interface ToolOutcome {
	content: Array<{ type: string; text?: string }>;
	details?: unknown;
	isError?: boolean;
}

function resultText(result: ToolOutcome): string {
	return result.content.map((block) => block.text ?? "").join("");
}

function captureTool(): RenderedTool {
	let captured: RenderedTool | undefined;
	installSubagent({
		on() {},
		registerTool(definition: RenderedTool) {
			captured = definition;
		},
	} as never);
	assert.ok(captured, "扩展没有注册 subagent 工具");
	return captured;
}

const renderTheme = {
	fg: (_token: string, text: string) => text,
	bold: (text: string) => text,
};

/** 渲染成不带转义序列的纯文本行。 */
function render(component: { render(width: number): string[] }): string {
	return component
		.render(80)
		.map((line) => stripTerminalSequences(line))
		.join("\n");
}

function taskResult(overrides: Partial<TaskResult> = {}): TaskResult {
	return {
		agent: "scout",
		source: "user",
		task: "调研扩展加载顺序",
		status: "completed",
		output: "三个渲染扩展都在模块加载时打补丁。",
		usage: emptyUsage(),
		...overrides,
	};
}

const subagentTool = captureTool();

check("renderCall：单任务显示 agent 名与任务预览", () => {
	const text = render(subagentTool.renderCall({ agent: "scout", task: "调研扩展加载顺序" }, renderTheme));
	assert.ok(text.includes("subagent"), text);
	assert.ok(text.includes("scout"), text);
	assert.ok(text.includes("调研扩展加载顺序"), text);
});

check("renderCall：并行模式逐条列出任务", () => {
	const text = render(
		subagentTool.renderCall(
			{
				tasks: [
					{ agent: "scout", task: "查渲染补丁" },
					{ agent: "planner", task: "出实现方案" },
				],
			},
			renderTheme,
		),
	);
	assert.ok(text.includes("2 个并行任务"), text);
	assert.ok(text.includes("scout"), text);
	assert.ok(text.includes("planner"), text);
	assert.ok(text.includes("└"), text);
});

check("renderResult：收起时只留状态与输出开头", () => {
	const text = render(
		subagentTool.renderResult({ details: { mode: "single", results: [taskResult()] }, content: [] }, { expanded: false }, renderTheme),
	);
	assert.ok(text.includes("✓"), text);
	assert.ok(text.includes("三个渲染扩展"), text);
});

check("renderResult：失败时显示错误原因", () => {
	const text = render(
		subagentTool.renderResult(
			{
				details: {
					mode: "single",
					results: [taskResult({ status: "failed", output: "", error: "子进程退出码 1" })],
				},
				content: [],
			},
			{ expanded: false },
			renderTheme,
		),
	);
	assert.ok(text.includes("✗"), text);
	assert.ok(text.includes("子进程退出码 1"), text);
});

check("renderResult：展开时保留完整输出", () => {
	const text = render(
		subagentTool.renderResult(
			{ details: { mode: "single", results: [taskResult()] }, content: [] },
			{ expanded: true },
			renderTheme,
		),
	);
	assert.ok(text.includes("scout"), text);
	assert.ok(text.includes("三个渲染扩展都在模块加载时打补丁。"), text);
});

check("renderResult：并行模式每个 agent 一行", () => {
	const text = render(
		subagentTool.renderResult(
			{
				details: {
					mode: "parallel",
					results: [
						taskResult({ agent: "scout", output: "第一条结论" }),
						taskResult({ agent: "planner", output: "第二条结论" }),
					],
				},
				content: [],
			},
			{ expanded: false },
			renderTheme,
		),
	);
	assert.ok(text.includes("scout"), text);
	assert.ok(text.includes("planner"), text);
	assert.ok(text.includes("第一条结论"), text);
	assert.ok(text.includes("第二条结论"), text);
});

check("工具描述：带上 agent 清单，模型才知道什么时候派谁", () => {
	assert.ok(subagentTool.description.includes("Available agents"), subagentTool.description);
	assert.ok(subagentTool.description.includes("explore"), subagentTool.description);
});

check("promptGuidelines：把委派判断条件写进 system prompt 的 rules 段", () => {
	const guidelines = subagentTool.promptGuidelines ?? [];
	assert.ok(guidelines.length > 0, "没有 promptGuidelines，模型只能靠工具描述触发");
	assert.ok(
		guidelines.every((line) => line.includes("subagent")),
		"rules 段是平铺的，每条都必须点名工具",
	);
});

check("prepareLoadout：活跃时用最新清单重写描述，不活跃时不动", () => {
	const changes = subagentTool.prepareLoadout?.({ declared: [{ name: "subagent" }] });
	assert.ok(changes?.descriptions?.subagent.includes("explore"), JSON.stringify(changes));
	assert.equal(subagentTool.prepareLoadout?.({ declared: [] }), undefined);
});

// ============================================================================
// execute：参数校验
// ============================================================================

interface ExecuteContext {
	cwd: string;
}

function context(overrides: Partial<ExecuteContext> = {}): ExecuteContext {
	return { cwd: process.cwd(), ...overrides };
}

/** 这些分支都在起子进程之前返回，所以调 execute 不会真的派子代理。 */
function ask(params: Record<string, unknown>, ctx: ExecuteContext): Promise<ToolOutcome> {
	return subagentTool.execute("call-1", params, undefined, undefined, ctx);
}

check("execute：agent+task 与 tasks 同时给会拒绝", async () => {
	const result = await ask(
		{ agent: "explore", task: "x", tasks: [{ agent: "explore", task: "y" }] },
		context(),
	);
	assert.equal(result.isError, true);
	assert.ok(resultText(result).includes("二选一"), resultText(result));
});

check("execute：并行任务超过上限会拒绝", async () => {
	const tasks = Array.from({ length: 9 }, () => ({ agent: "explore", task: "x" }));
	const result = await ask({ tasks }, context());
	assert.equal(result.isError, true);
	assert.ok(resultText(result).includes("上限 8"), resultText(result));
});

check("execute：agent 名不存在时列出可用清单", async () => {
	const dir = tempDir();
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = path.join(dir.path, "agent");
		const result = await ask({ agent: "nope", task: "x" }, context({ cwd: dir.path }));
		assert.equal(result.isError, true);
		assert.ok(resultText(result).includes("找不到 agent：nope"), resultText(result));
		assert.ok(resultText(result).includes("explore (builtin)"), resultText(result));
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		dir.cleanup();
	}
});

await finish();
