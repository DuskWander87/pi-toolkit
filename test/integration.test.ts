/**
 * 三个扩展同时安装时的左缘对齐契约。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
	getMarkdownTheme,
	initTheme,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Text, stripTerminalSequences } from "@earendil-works/pi-tui";
import installMessageMarks from "../extensions/render/message-marks/index.ts";
import installMinimalTools from "../extensions/render/minimal-tools/index.ts";
import { ToolRunSummary, groupSilentTurns, groupToolRuns } from "../extensions/render/tool-run-groups/index.ts";
import { check, finish } from "./harness.ts";

initTheme("dark", false);

const WIDTH = 60;
const theme = {
	appearance: "dark" as const,
	fg: (_token: string, text: string) => text,
	bg: (_token: string, text: string) => text,
	bold: (text: string) => text,
	style: (text: string, _options: unknown) => text,
};

installMessageMarks({
	on(_event: string, handler: (event: unknown, ctx: unknown) => void) {
		handler({}, { hasUI: true, ui: { theme, setEditorComponent() {} } });
	},
} as any);

let resolver: ((name: string, next: () => unknown) => any) | undefined;
installMinimalTools({
	registerToolRenderer(r: (name: string, next: () => unknown) => any) {
		resolver = r;
	},
	on(_event: string, handler: (event: unknown, ctx: unknown) => void) {
		handler({}, { ui: { theme: { getFgAnsi: () => "" }, setHiddenThinkingLabel() {} } });
	},
} as any);

/**
 * 一条已完成并收起的 `bash` 工具行。
 *
 * `started: false` 复现 Pi 的历史回放路径：只补结果，不标记执行开始与参数齐全。
 */
function toolRow(id: string, command: string, options: { started?: boolean } = {}): ToolExecutionComponent {
	const renderers = { renderShell: "self" as const, ...resolver!("bash", () => undefined) };
	const row = new ToolExecutionComponent(
		"bash",
		id,
		{ command },
		{ outputPad: 1 },
		renderers,
		{ requestRender() {} } as any,
		process.cwd(),
	);
	if (options.started ?? true) {
		row.markExecutionStarted();
		row.setArgsComplete();
	}
	row.updateResult({ content: [{ type: "text", text: "ok" }], details: {}, durationMs: 300 } as any, false);
	return row;
}

function assistantRow(thinking: string, text?: string): AssistantMessageComponent {
	const content: Array<Record<string, unknown>> = [{ type: "thinking", thinking }];
	if (text !== undefined) content.push({ type: "text", text });
	// 默认显示思考正文，验证扩展在收起态不泄漏静默轮次的内容。
	return new AssistantMessageComponent(
		{ content, stopReason: "stop" } as any,
		false,
		getMarkdownTheme(),
		"Thinking...",
		1,
		[],
	);
}

function plain(lines: readonly string[]): string[] {
	return lines.map(stripTerminalSequences);
}

/** 每行的底色转义前缀；无底色时为 undefined。 */
function bgOf(line: string): string | undefined {
	return line.match(/^\x1b\[48;[0-9;]*m/)?.[0];
}

function bodyLines(lines: readonly string[]): string[] {
	return lines.filter((line) => stripTerminalSequences(line).trim() !== "");
}

/**
 * 与 `pi-web-access` 同形的上游渲染器：调用行 + 收起预览 `Box(1, 0)`、展开纯 `Text`。
 * 上游不铺底色（只有文本与 `fg`），因此行上的底色转义只可能来自外层壳。
 */
const SEARCH_UPSTREAM = {
	renderCall: () => new Text('search  "pi tui"', 0, 0),
	renderResult: (_result: unknown, options: { expanded: boolean }) => {
		if (!options.expanded) {
			const box = new Box(1, 0);
			box.addChild(new Text("3 sources · preview", 0, 0));
			return box;
		}
		return new Text("2 sources", 0, 0);
	},
};

/** 走 Pi 真实 tool-execution 组合，返回带底色转义的行。 */
function upstreamRow(
	toolName: string,
	options: { expanded?: boolean; isPartial?: boolean; isError?: boolean } = {},
) {
	const renderers = resolver!(toolName, () => SEARCH_UPSTREAM);
	const row = new ToolExecutionComponent(
		toolName,
		`${toolName}-${options.expanded ? "expanded" : "collapsed"}-${options.isError ? "error" : "ok"}`,
		{ query: "pi tui" },
		{ outputPad: 1 },
		renderers,
		{ requestRender() {} } as any,
		process.cwd(),
	);
	row.setExpanded(options.expanded ?? false);
	row.markExecutionStarted();
	row.setArgsComplete();
	row.updateResult(
		{ content: [{ type: "text", text: "ok" }], details: {}, isError: options.isError } as any,
		options.isPartial ?? false,
	);
	return bodyLines(row.render(WIDTH));
}

check("三扩展同时安装时用户、摘要与工具行左缘一致", () => {
	const chat = new Container();
	chat.addChild(new UserMessageComponent("跑一下测试", getMarkdownTheme(), 1));
	chat.addChild(assistantRow("先看看现状"));
	chat.addChild(toolRow("c1", "ls"));
	chat.addChild(toolRow("c2", "pwd"));

	const mode = { chatContainer: chat, toolOutputExpanded: false, ui: { requestRender() {} } };
	groupToolRuns(mode);
	groupSilentTurns(mode, { thoughtMsFor: () => 2000 });

	const summary = chat.children.find((child): child is ToolRunSummary => child instanceof ToolRunSummary);
	assert.ok(summary !== undefined, "应生成区间摘要");

	const collapsed = plain(chat.render(WIDTH));
	assert.equal(collapsed.some((line) => line.includes("先看看现状")), false, collapsed.join("\n"));
	for (const line of collapsed) {
		if (line.trim() === "") continue;
		assert.ok(
			line.startsWith("❯ ") || line.startsWith("  "),
			JSON.stringify(line),
		);
	}

	summary.setExpanded(true);
	const expanded = plain(chat.render(WIDTH));
	assert.ok(expanded.some((line) => line.includes("先看看现状")), expanded.join("\n"));
	for (const line of expanded) {
		if (line.trim() === "") continue;
		assert.ok(
			line.startsWith("❯ ") || line.startsWith("● ") || line.startsWith("  "),
			JSON.stringify(line),
		);
	}
	// 两个工具行各一个圆点，用户消息一个前缀，不重复。
	const joined = expanded.join("\n");
	assert.equal((joined.match(/●/g) ?? []).length, 2, joined);
	assert.equal((joined.match(/❯/g) ?? []).length, 1, joined);
});

check("历史回放的工具行收起后只剩一行", () => {
	const replayed = toolRow("replay-1", "npm test", { started: false });
	const lines = bodyLines(plain(replayed.render(WIDTH))).map((line) => line.trim());
	assert.deepEqual(lines, ["● bash npm test"], JSON.stringify(lines));
});

check("静默轮次的思考正文只在展开后出现", () => {
	const chat = new Container();
	chat.addChild(assistantRow("折叠里的思考"));
	chat.addChild(toolRow("d1", "ls"));
	chat.addChild(toolRow("d2", "pwd"));
	const mode = { chatContainer: chat, toolOutputExpanded: false, ui: { requestRender() {} } };
	groupToolRuns(mode);
	groupSilentTurns(mode);

	const summary = chat.children.find((child): child is ToolRunSummary => child instanceof ToolRunSummary);
	assert.ok(summary !== undefined);
	assert.equal(plain(chat.render(WIDTH)).join("\n").includes("折叠里的思考"), false);
	summary.setExpanded(true);
	assert.ok(plain(chat.render(WIDTH)).join("\n").includes("折叠里的思考"));
});

check("正文与摘要行按发生顺序排列，正文之前的思考由摘要行代表", () => {
	const chat = new Container();
	const first = assistantRow("先确认现状", "先看看当前的失败用例。");
	const last = assistantRow("收尾思考", "已经修好了。");
	chat.addChild(first);
	chat.addChild(toolRow("e1", "ls"));
	chat.addChild(toolRow("e2", "pwd"));
	chat.addChild(last);
	const mode = { chatContainer: chat, toolOutputExpanded: false, ui: { requestRender() {} } };
	groupToolRuns(mode);
	groupSilentTurns(mode, { thoughtMsFor: () => 3000 });

	const lines = plain(chat.render(WIDTH));
	const collapsed = lines.join("\n");
	const summaryY = lines.findIndex((line) => line.includes("Thought for 3s, ran 2 bash commands"));
	assert.ok(collapsed.includes("先看看当前的失败用例。"), collapsed);
	assert.ok(summaryY > 0, collapsed);
	// 正文之前的思考已计入摘要行，不再展开；收尾回复在摘要之外，按 Pi 的设置显示。
	assert.equal(collapsed.includes("先确认现状"), false, collapsed);
	assert.ok(collapsed.includes("收尾思考"), collapsed);
	assert.ok(
		lines.findIndex((line) => line.includes("先看看当前的失败用例。")) < summaryY,
		collapsed,
	);
	assert.ok(lines.findIndex((line) => line.includes("已经修好了。")) > summaryY, collapsed);
});

// ---------------------------------------------------------------- 上游渲染工具换壳
check("上游渲染的搜索工具换壳后无底色，未换壳的上游工具仍由 Pi 默认壳铺底", () => {
	const search = upstreamRow("web_search");
	// 对照组：同样走上游渲染、不在换壳名单里，仍然整块带底色——证明底色检测本身有效。
	const unswapped = upstreamRow("powershell");
	assert.ok(
		unswapped.every((line) => bgOf(line) !== undefined),
		JSON.stringify(plain(unswapped)),
	);
	assert.equal(
		search.some((line) => bgOf(line) !== undefined),
		false,
		JSON.stringify(plain(search)),
	);
	// 不是空渲染：调用行与上游收起预览都真的在行里。
	const visible = plain(search).join("\n");
	assert.ok(visible.includes('search  "pi tui"'), visible);
	assert.ok(visible.includes("3 sources · preview"), visible);
});

check("搜索工具只在展开且成功时把调用行并进同一块底色", () => {
	const running = upstreamRow("fetch_content", { isPartial: true });
	assert.equal(
		running.some((line) => bgOf(line) !== undefined),
		false,
		JSON.stringify(plain(running)),
	);

	const expanded = upstreamRow("web_search", { expanded: true });
	const tokens = new Set(expanded.map(bgOf));
	assert.equal(tokens.size, 1, JSON.stringify(plain(expanded)));
	const blockToken = [...tokens][0];
	assert.notEqual(blockToken, undefined, "展开块缺少底色");
	// 与 Pi 默认壳的成功底色不同：这块来自本扩展的展开块，不是沿用默认壳。
	assert.notEqual(blockToken, bgOf(upstreamRow("powershell", { expanded: true })[0]));
	// 调用行并进结果块，不再单独占一段。
	assert.equal(expanded.length, 2, JSON.stringify(plain(expanded)));
	assert.ok(plain(expanded)[0].includes('search  "pi tui"'), JSON.stringify(plain(expanded)));
});

check("搜索工具展开出错时调用行仍单独一段", () => {
	const lines = upstreamRow("web_search", { expanded: true, isError: true });
	assert.equal(lines.length, 2, JSON.stringify(plain(lines)));
	assert.equal(bgOf(lines[0]), undefined, JSON.stringify(plain(lines)));
	assert.ok(stripTerminalSequences(lines[0]!).includes('search  "pi tui"'), JSON.stringify(plain(lines)));
	assert.notEqual(bgOf(lines[1]), undefined, JSON.stringify(plain(lines)));
});

finish();
