/**
 * tool-run-groups 渲染与聚合逻辑验证。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import {
	AssistantMessageComponent,
	InteractiveMode,
	ToolExecutionComponent,
	UserMessageComponent,
	getMarkdownTheme,
	initTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences } from "@earendil-works/pi-tui";
import extend, {
	ToolRunGroup,
	ToolRunSummary,
	applyThoughtLabel,
	describeRun,
	finishMessage,
	groupSilentTurns,
	groupToolRuns,
	installToolRunGroups,
	isGroupable,
	isSilentTurn,
	refreshToolRuns,
	summarize,
	thoughtLabel,
	trackThinking,
} from "../../extensions/render/tool-run-groups/index.ts";
import { check, finish as finishSuite } from "../harness.ts";

initTheme("dark", false);
extend({ on() {}, registerTool() {} } as any);

const WIDTH = 70;

/** 构造真实的工具行，渲染与折叠行为与 Pi 内部一致。 */
function toolRow(toolName: string, toolCallId: string, args: Record<string, unknown> = {}) {
	return new ToolExecutionComponent(
		toolName,
		toolCallId,
		args,
		{},
		{},
		{ requestRender() {} } as any,
		process.cwd(),
	);
}

function bashRow(id: string, command: string) {
	return toolRow("bash", id, { command });
}

/** 回填结果，让工具行进入结束态（默认构造出来的是执行中）。 */
function finish(row: ToolExecutionComponent, isError = false): ToolExecutionComponent {
	row.updateResult(
		{ content: [{ type: "text", text: isError ? "boom" : "ok" }], isError, details: {} } as any,
		false,
	);
	return row;
}

function finishedBash(id: string, command: string): ToolExecutionComponent {
	return finish(bashRow(id, command));
}

function plain(lines: readonly string[]): string[] {
	return lines.map((line) => stripTerminalSequences(line));
}

function fakeMode(rows: unknown[], expanded = false) {
	const container = new Container();
	for (const row of rows) container.addChild(row as any);
	return { chatContainer: container, toolOutputExpanded: expanded, ui: { requestRender() {} } };
}

function groupOf(mode: { chatContainer: Container }): ToolRunGroup {
	const groups = mode.chatContainer.children.filter((child) => child instanceof ToolRunGroup);
	assert.equal(groups.length, 1, "应恰好生成一个聚合组件");
	return groups[0] as ToolRunGroup;
}

check("按首次出现顺序汇总，shell 用 command 作量词", () => {
	assert.equal(summarize(["bash", "read", "bash"]), "2 shell commands, 1 read call");
	assert.equal(summarize(["bash"]), "1 shell command");
	assert.equal(summarize(["read", "read"]), "2 read calls");
	assert.equal(summarize(["grep", "find", "ls"]), "1 grep call, 1 find call, 1 ls call");
});

check("edit / write 与单条调用不聚合", () => {
	assert.equal(isGroupable(["bash", "edit"]), false);
	assert.equal(isGroupable(["write", "read"]), false);
	assert.equal(isGroupable(["bash"]), false);
	assert.equal(isGroupable(["bash", "grep"]), true);
});

check("摘要带思考耗时时四舍五入到秒", () => {
	assert.equal(describeRun(["bash", "bash"], 2400), "Thought for 2s, ran 2 shell commands");
	assert.equal(describeRun(["bash", "bash"], 40), "Thought for 1s, ran 2 shell commands");
	assert.equal(describeRun(["bash", "bash"]), "ran 2 shell commands");
});

check("相邻工具行合并为一个聚合组件", () => {
	const mode = fakeMode([
		finishedBash("c1", "ls"),
		finishedBash("c2", "pwd"),
		finishedBash("c3", "whoami"),
	]);
	groupToolRuns(mode);
	assert.equal(mode.chatContainer.children.length, 1);
	const group = groupOf(mode);
	assert.equal(group.children.length, 3);
});

check("单条调用与含 edit 的连续行保持原样", () => {
	const single = fakeMode([bashRow("c1", "ls")]);
	groupToolRuns(single);
	assert.equal(single.chatContainer.children.length, 1);
	assert.ok(single.chatContainer.children[0] instanceof ToolExecutionComponent);

	const mixed = fakeMode([bashRow("c1", "ls"), toolRow("edit", "c2", { path: "a.ts" })]);
	groupToolRuns(mixed);
	assert.equal(mixed.chatContainer.children.length, 2);
	assert.ok(mixed.chatContainer.children.every((child) => child instanceof ToolExecutionComponent));
});

check("被非工具行分隔的连续段各自聚合", () => {
	const mode = fakeMode([
		finishedBash("c1", "ls"),
		finishedBash("c2", "pwd"),
		new Container(),
		finishedBash("c3", "id"),
		finishedBash("c4", "date"),
	]);
	groupToolRuns(mode);
	assert.equal(mode.chatContainer.children.length, 3);
	const groups = mode.chatContainer.children.filter((child) => child instanceof ToolRunGroup);
	assert.equal(groups.length, 2);
});

check("执行中的工具行不聚合，保留带实时计时的原行", () => {
	const mode = fakeMode([bashRow("c1", "sleep 5"), finishedBash("c2", "pwd")]);
	groupToolRuns(mode);
	assert.equal(mode.chatContainer.children.length, 2);
	assert.equal(
		mode.chatContainer.children.filter((child) => child instanceof ToolRunGroup).length,
		0,
	);
});

check("收起态是空行 + 一行摘要，缩进到标记栏所在列", () => {
	const mode = fakeMode([finishedBash("c1", "ls"), finishedBash("c2", "pwd")]);
	groupToolRuns(mode);
	const lines = plain(groupOf(mode).render(WIDTH));
	assert.equal(lines.length, 2);
	assert.equal(lines[0], "");
	assert.equal(lines[1]!.trimStart(), "ran 2 shell commands");
	assert.equal(lines[1]!.length - lines[1]!.trimStart().length, 2);
});

check("展开态先摘要行，再铺开每个工具行的完整内容", () => {
	const rows = [finishedBash("c1", "ls"), finishedBash("c2", "pwd")];
	const mode = fakeMode(rows);
	groupToolRuns(mode);
	const group = groupOf(mode);
	const expected = new Container();
	for (const row of rows) expected.addChild(row);

	group.setExpanded(true);
	const lines = plain(group.render(WIDTH));
	assert.equal(lines[0], "");
	assert.equal(lines[1]!.trimStart(), "ran 2 shell commands");
	assert.equal(lines.length, 2 + expected.render(WIDTH).length);
	// 展开态下 Pi 把参数铺成 `command: ls` 这样的多行，这里只校验内容已铺开。
	assert.ok(lines.slice(2).some((line) => line.includes("command")), JSON.stringify(lines));
});

check("失败时标注数量", () => {
	const failed = fakeMode([finishedBash("c1", "ls"), finish(bashRow("c2", "pwd"), true)]);
	groupToolRuns(failed);
	const line = plain(groupOf(failed).render(WIDTH))[1]!;
	assert.ok(line.includes("ran 2 shell commands"), line);
	assert.ok(line.includes("1 failed"), line);
});

check("失败只把计数片段标红，摘要正文保持 dim", () => {
	const themed = () => ({ fg: (name: string, text: string) => `{${name}|${text}}` }) as any;
	const rows = [finishedBash("c1", "ls"), finish(bashRow("c2", "pwd"), true)];
	const group = new ToolRunGroup({
		rows: rows as any,
		toolNames: ["bash", "bash"],
		expanded: false,
		theme: themed,
		requestRender() {},
	});
	const groupLine = group.render(200)[1]!;
	assert.ok(groupLine.includes("{dim|ran 2 shell commands}"), groupLine);
	assert.ok(groupLine.includes("{error| · 1 failed}"), groupLine);

	const summary = new ToolRunSummary({
		items: [group],
		expanded: false,
		theme: themed,
		requestRender() {},
	});
	const summaryLine = summary.render(200)[1]!;
	assert.ok(summaryLine.includes("{dim|ran 2 shell commands}"), summaryLine);
	assert.ok(summaryLine.includes("{error| · 1 failed}"), summaryLine);
});

check("重复聚合不叠加", () => {
	const mode = fakeMode([finishedBash("c1", "ls"), finishedBash("c2", "pwd")]);
	groupToolRuns(mode);
	const group = groupOf(mode);
	groupToolRuns(mode);
	assert.equal(mode.chatContainer.children.length, 1);
	assert.equal(mode.chatContainer.children[0], group);
});

check("Ctrl+O 的展开态传递到组内工具行", () => {
	const mode = fakeMode([finishedBash("c1", "ls"), finishedBash("c2", "pwd")]);
	groupToolRuns(mode);
	const group = groupOf(mode);
	assert.equal(group.expanded, false);
	group.setExpanded(true);
	assert.ok((group.children as ToolExecutionComponent[]).every((row) => (row as any).expanded === true));
});

check("摘要行不超过渲染宽度", () => {
	const mode = fakeMode([finishedBash("c1", "ls"), finishedBash("c2", "pwd"), finishedBash("c3", "id")]);
	groupToolRuns(mode);
	const narrow = plain(groupOf(mode).render(12));
	assert.equal(narrow.length, 2);
	assert.ok(narrow[1]!.length <= 12, JSON.stringify(narrow[1]));
});

/** 助手消息：默认隐藏思考正文；`text` 才是可见文本。 */
function assistantRow(
	options: {
		text?: string;
		thinking?: string;
		stopReason?: string;
		hideThinkingBlock?: boolean;
	} = {},
) {
	const content: Array<Record<string, unknown>> = [];
	if (options.thinking !== undefined) content.push({ type: "thinking", thinking: options.thinking });
	if (options.text !== undefined) content.push({ type: "text", text: options.text });
	return new AssistantMessageComponent(
		{ content, stopReason: options.stopReason ?? "stop" } as never,
		options.hideThinkingBlock ?? true,
		getMarkdownTheme(),
		"Thinking...",
		1,
		[],
	);
}

function summariesOf(mode: { chatContainer: Container }): ToolRunSummary[] {
	return mode.chatContainer.children.filter(
		(child) => child instanceof ToolRunSummary,
	) as ToolRunSummary[];
}

check("静默轮次判定：隐藏思考或空内容算静默，可见文本与中断报错不算", () => {
	assert.equal(isSilentTurn(assistantRow({ thinking: "想一想" })), true);
	assert.equal(isSilentTurn(assistantRow({})), true);
	assert.equal(isSilentTurn(assistantRow({ text: "我发现了问题" })), false);
	assert.equal(isSilentTurn(assistantRow({ stopReason: "error" })), false);
	assert.equal(isSilentTurn(assistantRow({ stopReason: "aborted" })), false);
	assert.equal(isSilentTurn(assistantRow({ stopReason: "length" })), false);
	assert.equal(isSilentTurn(finishedBash("c1", "ls")), false);
});

check("显示思考时，收起态也不渲染静默轮次的思考正文", () => {
	const think = assistantRow({ thinking: "这是一段很长的思考正文", hideThinkingBlock: false });
	const mode = fakeMode([think, finishedBash("c1", "ls"), finishedBash("c2", "pwd")]);
	groupToolRuns(mode);
	groupSilentTurns(mode, { thoughtMsFor: () => 1500 });
	const summary = summariesOf(mode)[0]!;

	const collapsed = plain(summary.render(WIDTH));
	assert.equal(collapsed.length, 2, JSON.stringify(collapsed));
	assert.equal(collapsed[1]!.trimStart(), "Thought for 2s, ran 2 shell commands");
	assert.equal(collapsed.join("\n").includes("这是一段很长的思考正文"), false, JSON.stringify(collapsed));

	summary.setExpanded(true);
	const expanded = plain(summary.render(WIDTH));
	assert.ok(expanded.join("\n").includes("这是一段很长的思考正文"), JSON.stringify(expanded));
});

check("带正文的回复把区间分成两行摘要，正文留在两行之间", () => {
	const answer = assistantRow({
		thinking: "思考正文",
		text: "我发现了问题",
		hideThinkingBlock: false,
	});
	const mode = fakeMode([
		assistantRow({ thinking: "先看看" }),
		finishedBash("c1", "ls"),
		finishedBash("c2", "pwd"),
		answer,
		finishedBash("c3", "cat a"),
		finishedBash("c4", "cat b"),
	]);
	groupToolRuns(mode);
	groupSilentTurns(mode);
	const [before, after] = summariesOf(mode);

	assert.equal(mode.chatContainer.children.indexOf(before!), 0);
	assert.equal(mode.chatContainer.children.indexOf(answer), 1, "正文紧跟在它上方那行摘要后");
	assert.equal(mode.chatContainer.children.indexOf(after!), 2, "正文之后的调用另起一行摘要");
	assert.equal(plain(before!.render(WIDTH))[1]!.trimStart(), "ran 2 shell commands");
	assert.equal(plain(after!.render(WIDTH))[1]!.trimStart(), "ran 2 shell commands");

	const rendered = () => plain(mode.chatContainer.render(WIDTH)).join("\n");
	assert.ok(rendered().includes("我发现了问题"), rendered());
	// 收起时由下面那行摘要代表思考：正文保留，思考正文不占行。
	assert.equal(rendered().includes("思考正文"), false, rendered());

	after!.setExpanded(true);
	assert.ok(rendered().includes("思考正文"), rendered());
});

check("区间前那条带正文的回复收起时同样隐去思考", () => {
	const first = assistantRow({ thinking: "区间外的思考", text: "先定位失败的用例", hideThinkingBlock: false });
	const mode = fakeMode([first, finishedBash("c1", "ls"), finishedBash("c2", "pwd")]);
	groupToolRuns(mode);
	groupSilentTurns(mode);
	const summary = summariesOf(mode)[0]!;
	const rendered = () => plain(mode.chatContainer.render(WIDTH)).join("\n");

	assert.ok(rendered().includes("先定位失败的用例"));
	assert.equal(rendered().includes("区间外的思考"), false);
	summary.setExpanded(true);
	assert.ok(rendered().includes("区间外的思考"));
});

check("收起时被隐去的思考不残留 Thinking... 占位", () => {
	const mode = fakeMode([
		assistantRow({ thinking: "思考正文", text: "正文", hideThinkingBlock: false }),
		finishedBash("c1", "ls"),
		finishedBash("c2", "pwd"),
	]);
	groupToolRuns(mode);
	groupSilentTurns(mode);
	const lines = plain(summariesOf(mode)[0]!.render(WIDTH)).join("\n");
	assert.equal(lines.includes("Thinking..."), false, lines);
});

check("最终纯文本回复留在摘要外，保留自己的耗时标签", () => {
	const realNow = Date.now;
	let now = 1000;
	Date.now = () => now;
	try {
		const mode = fakeMode([assistantRow({ thinking: "先看看" }), finishedBash("c1", "ls"), finishedBash("c2", "pwd")]);
		groupToolRuns(mode);
		groupSilentTurns(mode);

		const final = assistantRow({ thinking: "补充说明", text: "已经修好了。" });
		mode.chatContainer.addChild(final);

		trackThinking({ type: "message_start", message: { role: "assistant" } });
		now = 1500;
		trackThinking({
			type: "message_update",
			message: { role: "assistant", content: [{ type: "thinking", thinking: "补充说明" }] },
		});
		now = 2400;
		finishMessage(mode, {
			type: "message_end",
			message: {
				role: "assistant",
				stopReason: "stop",
				content: [
					{ type: "thinking", thinking: "补充说明" },
					{ type: "text", text: "已经修好了。" },
				],
			},
		});

		const summaries = summariesOf(mode);
		assert.equal(summaries.length, 1);
		assert.equal(summaries[0]!.children.includes(final), false, "最终回复不并入摘要");
		assert.equal(mode.chatContainer.children.at(-1), final, "最终回复留在摘要下方");
		const lines = plain(summaries[0]!.render(WIDTH));
		assert.equal(lines[1]!.trimStart(), "ran 2 shell commands", "最终回复的耗时不算进上方摘要");
		const reply = plain(final.render(WIDTH)).join("\n");
		assert.ok(reply.includes("已经修好了。"), reply);
		assert.ok(reply.includes("Thought for 1s"), reply);
	} finally {
		Date.now = realNow;
	}
});

check("连续静默轮次合并成一行摘要，耗时按轮累加", () => {
	const mode = fakeMode([
		assistantRow({ thinking: "看看目录" }),
		finishedBash("c1", "ls"),
		finishedBash("c2", "pwd"),
		assistantRow({ thinking: "再看看文件" }),
		finishedBash("c3", "cat a"),
		finishedBash("c4", "cat b"),
	]);
	groupToolRuns(mode);
	groupSilentTurns(mode, { thoughtMsFor: () => 1500 });

	assert.equal(mode.chatContainer.children.length, 1);
	const summary = summariesOf(mode)[0]!;
	const lines = plain(summary.render(WIDTH));
	assert.equal(lines.length, 2);
	assert.equal(lines[1]!.trimStart(), "Thought for 3s, ran 4 shell commands");
});

check("多轮摘要展开后是完整时间线", () => {
	const mode = fakeMode([
		assistantRow({ thinking: "第一轮" }),
		finishedBash("c1", "ls"),
		finishedBash("c2", "pwd"),
		assistantRow({ thinking: "第二轮" }),
		finishedBash("c3", "cat a"),
		finishedBash("c4", "cat b"),
	]);
	groupToolRuns(mode);
	groupSilentTurns(mode);
	const summary = summariesOf(mode)[0]!;
	summary.setExpanded(true);

	const lines = plain(summary.render(WIDTH));
	assert.equal(lines[0], "");
	assert.equal(lines[1]!.trimStart(), "ran 4 shell commands");
	// 耗时已在摘要行，展开的静默轮次不再重复显示占位标签。
	assert.equal(lines.filter((line) => line.includes("Thinking...")).length, 0, JSON.stringify(lines));
	// 折叠内仍有两组各自的摘要行。
	assert.equal(lines.filter((line) => line.trimStart().startsWith("ran 2 shell commands")).length, 2);
	assert.ok(lines.length > 8, JSON.stringify(lines));
});

check("展开摘要不为已计入的静默轮次重复显示耗时标签", () => {
	const silent = assistantRow({ thinking: "想一想" });
	applyThoughtLabel(silent, 1500);
	const mode = fakeMode([
		silent,
		finishedBash("c1", "ls"),
		assistantRow({}),
		finishedBash("c2", "pwd"),
	]);
	groupToolRuns(mode);
	groupSilentTurns(mode, { thoughtMsFor: (item) => (item === silent ? 1500 : undefined) });

	const summary = summariesOf(mode)[0]!;
	summary.setExpanded(true);
	const lines = plain(summary.render(WIDTH));
	assert.equal(lines[1]!.trimStart(), "Thought for 2s, ran 2 shell commands");
	assert.equal(lines.filter((line) => line.includes("Thought for 2s")).length, 1, JSON.stringify(lines));
});

check("请求开头带文本的回复留在摘要外，它引发的工具并入同一行", () => {
	const text = assistantRow({ text: "我先看看目录" });
	const mode = fakeMode([
		text,
		finishedBash("c1", "ls"),
		finishedBash("c2", "pwd"),
		assistantRow({}),
		finishedBash("c3", "cat a"),
		finishedBash("c4", "cat b"),
	]);
	groupToolRuns(mode);
	groupSilentTurns(mode, { thoughtMsFor: (item) => (item === text ? 2000 : 3000) });

	assert.equal(mode.chatContainer.children.length, 2);
	assert.equal(mode.chatContainer.children[0], text);
	const summary = summariesOf(mode)[0]!;
	assert.equal(summary.children.includes(text), false, "带文本的回复不进入折叠");
	assert.equal(plain(summary.render(WIDTH))[1]!.trimStart(), "Thought for 5s, ran 4 shell commands");
});

check("带文本回复的耗时并入摘要后，不再单独显示耗时标签", () => {
	const text = assistantRow({ thinking: "想一想", text: "我先看看目录" });
	applyThoughtLabel(text, 2000);
	const mode = fakeMode([
		text,
		finishedBash("c1", "ls"),
		assistantRow({}),
		finishedBash("c2", "pwd"),
	]);
	groupToolRuns(mode);
	groupSilentTurns(mode, { thoughtMsFor: (item) => (item === text ? 2000 : undefined) });

	const summary = summariesOf(mode)[0]!;
	assert.equal(plain(summary.render(WIDTH))[1]!.trimStart(), "Thought for 2s, ran 2 shell commands");
	assert.equal(plain(text.render(WIDTH)).join("\n").includes("Thought for 2s"), false, "标签不应与摘要行重复");
});

check("只有一条工具调用时也合成一行摘要", () => {
	const text = assistantRow({ thinking: "想一想", text: "我先看看目录" });
	applyThoughtLabel(text, 2000);
	const mode = fakeMode([text, finishedBash("c1", "ls")]);
	groupToolRuns(mode);
	groupSilentTurns(mode, { thoughtMsFor: (item) => (item === text ? 2000 : undefined) });

	assert.equal(summariesOf(mode).length, 1);
	assert.equal(
		plain(summariesOf(mode)[0]!.render(WIDTH))[1]!.trimStart(),
		"Thought for 2s, ran 1 shell command",
	);
	assert.equal(plain(text.render(WIDTH)).join("\n").includes("Thought for 2s"), false);
});

check("单条工具调用与思考合成一行摘要，消息标记不再单独占行", () => {
	const think = assistantRow({ thinking: "看一眼图片" });
	applyThoughtLabel(think, 1000);
	const row = finish(toolRow("read", "r1", { path: "a.png" }));
	const mode = fakeMode([think, row]);
	groupToolRuns(mode);
	groupSilentTurns(mode, { thoughtMsFor: (item) => (item === think ? 1000 : undefined) });

	const summaries = summariesOf(mode);
	assert.equal(summaries.length, 1);
	const lines = plain(summaries[0]!.render(WIDTH));
	assert.equal(lines.length, 2, JSON.stringify(lines));
	assert.equal(lines[1]!.trimStart(), "Thought for 1s, ran 1 read call");
});

check("同一请求的工具段随轮次增长合入同一行摘要", () => {
	const text = assistantRow({ text: "我先看看目录" });
	const elapsed = (item: unknown) => (item === text ? 1000 : undefined);
	const mode = fakeMode([text, finishedBash("c1", "ls"), finishedBash("c2", "pwd")]);
	groupToolRuns(mode);
	groupSilentTurns(mode, { thoughtMsFor: elapsed });
	assert.equal(summariesOf(mode).length, 1);
	assert.equal(
		plain(summariesOf(mode)[0]!.render(WIDTH))[1]!.trimStart(),
		"Thought for 1s, ran 2 shell commands",
	);

	mode.chatContainer.addChild(assistantRow({}));
	mode.chatContainer.addChild(finishedBash("c3", "id"));
	mode.chatContainer.addChild(finishedBash("c4", "date"));
	groupToolRuns(mode);
	groupSilentTurns(mode, { thoughtMsFor: elapsed });

	assert.equal(summariesOf(mode).length, 1);
	assert.equal(mode.chatContainer.children[0], text);
	assert.equal(
		plain(summariesOf(mode)[0]!.render(WIDTH))[1]!.trimStart(),
		"Thought for 1s, ran 4 shell commands",
	);
});

check("执行中：已完成部分收成摘要，执行中的工具行留在摘要下方", () => {
	const running = bashRow("c3", "sleep 5");
	const mode = fakeMode([
		assistantRow({ thinking: "先看目录" }),
		finishedBash("c1", "ls"),
		finishedBash("c2", "pwd"),
		assistantRow({}),
		running,
	]);
	groupToolRuns(mode);
	groupSilentTurns(mode, { thoughtMsFor: () => 1500 });

	const summaries = summariesOf(mode);
	assert.equal(summaries.length, 1);
	assert.equal(summaries[0]!.children.includes(running), false, "执行中的行不进入摘要");
	assert.equal(mode.chatContainer.children.length, 2);
	assert.equal(mode.chatContainer.children[1], running, "执行中的行紧跟在摘要下方");
	assert.equal(
		plain(summaries[0]!.render(WIDTH))[1]!.trimStart(),
		"Thought for 3s, ran 2 shell commands",
	);
});

check("执行中重扫不拆散已有摘要，展开状态跟到新实例", () => {
	const mode = fakeMode([assistantRow({}), finishedBash("c1", "ls"), finishedBash("c2", "pwd")]);
	groupToolRuns(mode);
	groupSilentTurns(mode);
	summariesOf(mode)[0]!.setExpanded(true);

	const running = bashRow("c3", "npm test");
	mode.chatContainer.addChild(assistantRow({}));
	mode.chatContainer.addChild(running);
	groupToolRuns(mode);
	groupSilentTurns(mode);

	const rebuilt = summariesOf(mode);
	assert.equal(rebuilt.length, 1, "摘要不应被拆回组与散行");
	assert.equal(rebuilt[0]!.expanded, true, "重建后保留展开状态");
	assert.equal(rebuilt[0]!.children.includes(running), false);

	groupSilentTurns(mode);
	assert.equal(summariesOf(mode)[0], rebuilt[0], "区间未变化时复用实例");
});

check("区间里还没有已完成的调用时，执行中的工具行保持原样", () => {
	const running = bashRow("c1", "npm test");
	const mode = fakeMode([assistantRow({}), running]);
	groupToolRuns(mode);
	groupSilentTurns(mode);

	assert.equal(summariesOf(mode).length, 0);
	assert.equal(mode.chatContainer.children[1], running);
});

check("执行中的改动行留在摘要之外，摘要只覆盖已完成部分", () => {
	const edit = toolRow("edit", "e1", { path: "a.ts" });
	const mode = fakeMode([
		assistantRow({}),
		finishedBash("c1", "ls"),
		finishedBash("c2", "pwd"),
		assistantRow({}),
		edit,
	]);
	groupToolRuns(mode);
	groupSilentTurns(mode);

	const summaries = summariesOf(mode);
	assert.equal(summaries.length, 1);
	assert.equal(mode.chatContainer.children.includes(edit), true);
	assert.equal(plain(summaries[0]!.render(WIDTH))[1]!.trimStart(), "ran 2 shell commands");
});

check("并行调用中先结束的调用并入摘要，仍在执行的留在下方", () => {
	const slow = bashRow("c3", "sleep 5");
	const fast = bashRow("c4", "ls");
	const mode = fakeMode([
		assistantRow({}),
		finishedBash("c1", "ls"),
		finishedBash("c2", "pwd"),
		assistantRow({}),
		slow,
		fast,
	]);
	groupToolRuns(mode);
	groupSilentTurns(mode);

	assert.equal(summariesOf(mode).length, 1);
	assert.equal(mode.chatContainer.children.length, 3, "摘要 + 两条执行中的行");

	finish(fast);
	groupToolRuns(mode);
	groupSilentTurns(mode);
	const summaries = summariesOf(mode);
	assert.equal(summaries.length, 1);
	assert.equal(
		plain(summaries[0]!.render(WIDTH))[1]!.trimStart(),
		"ran 3 shell commands",
		"先结束的调用计入摘要",
	);
	assert.equal(summaries[0]!.children.includes(fast), true);
	assert.equal(summaries[0]!.children.includes(slow), false);
	assert.deepEqual(mode.chatContainer.children, [summaries[0], slow], "仍在执行的跟在摘要下方");

	finish(slow);
	groupToolRuns(mode);
	groupSilentTurns(mode);
	assert.equal(mode.chatContainer.children.length, 1);
	assert.equal(plain(summariesOf(mode)[0]!.render(WIDTH))[1]!.trimStart(), "ran 4 shell commands");
});

check("并行调用按发起顺序汇总，先结束的调用不改变顺序", () => {
	const read = toolRow("read", "r1", { path: "a.ts" });
	const bash = finish(bashRow("b1", "ls"));
	const mode = fakeMode([assistantRow({}), read, bash]);
	groupToolRuns(mode);
	groupSilentTurns(mode);
	assert.equal(
		plain(summariesOf(mode)[0]!.render(WIDTH))[1]!.trimStart(),
		"ran 1 shell command",
		"先结束的调用先计入摘要",
	);

	finish(read);
	groupToolRuns(mode);
	groupSilentTurns(mode);
	const summary = summariesOf(mode)[0]!;
	assert.equal(
		plain(summary.render(WIDTH))[1]!.trimStart(),
		"ran 1 read call, 1 shell command",
		"摘要按发起顺序汇总",
	);
	assert.ok(
		summary.children.indexOf(read) < summary.children.indexOf(bash),
		"展开时间线保持发起顺序",
	);
});

check("三条并行调用逆序结束时，摘要仍按发起顺序汇总", () => {
	const read = toolRow("read", "r1", { path: "a.ts" });
	const grep = toolRow("grep", "g1", { pattern: "x" });
	const bash = finish(bashRow("b1", "ls"));
	const mode = fakeMode([assistantRow({}), read, grep, bash]);
	groupToolRuns(mode);
	groupSilentTurns(mode);
	assert.equal(
		plain(summariesOf(mode)[0]!.render(WIDTH))[1]!.trimStart(),
		"ran 1 shell command",
		"只有已结束的调用计入摘要",
	);

	// 结束顺序与发起顺序相反：bash 已结束，接着 grep，最后 read。
	for (const row of [grep, read]) {
		finish(row);
		groupToolRuns(mode);
		groupSilentTurns(mode);
	}
	const summary = summariesOf(mode)[0]!;
	assert.equal(
		plain(summary.render(WIDTH))[1]!.trimStart(),
		"ran 1 read call, 1 grep call, 1 shell command",
	);
	assert.deepEqual(summary.children.slice(1), [read, grep, bash], "展开时间线保持发起顺序");
});

check("执行中的改动行与已完成的工具行并存", () => {
	const bash = finish(bashRow("b1", "ls"));
	const edit = toolRow("edit", "e1", { path: "a.ts" });
	const mode = fakeMode([assistantRow({}), bash, edit]);
	groupToolRuns(mode);
	groupSilentTurns(mode);

	const summary = summariesOf(mode)[0]!;
	assert.equal(plain(summary.render(WIDTH))[1]!.trimStart(), "ran 1 shell command");
	assert.equal(summary.children.includes(edit), false, "执行中的改动行不进摘要");
	assert.deepEqual(mode.chatContainer.children, [summary, edit]);

	finish(edit);
	groupToolRuns(mode);
	groupSilentTurns(mode);
	const rebuilt = summariesOf(mode)[0]!;
	assert.equal(rebuilt.children.includes(edit), true);
	assert.deepEqual(mode.chatContainer.children, [rebuilt]);
});

check("摘要之后追加的执行中行被重扫保留在摘要下方", () => {
	const bash = finish(bashRow("b1", "ls"));
	const mode = fakeMode([assistantRow({}), bash]);
	groupToolRuns(mode);
	groupSilentTurns(mode);
	assert.equal(plain(summariesOf(mode)[0]!.render(WIDTH))[1]!.trimStart(), "ran 1 shell command");

	// 模拟 Pi 在 `tool_execution_start` 时把新工具行追加到容器末尾。
	const next = toolRow("read", "r1", { path: "a.ts" });
	mode.chatContainer.addChild(assistantRow({}));
	mode.chatContainer.addChild(next);
	groupToolRuns(mode);
	groupSilentTurns(mode);

	const rebuilt = summariesOf(mode)[0]!;
	assert.equal(rebuilt.children.includes(next), false, "执行中的行不进摘要");
	assert.equal(mode.chatContainer.children.at(-1), next, "执行中的行留在摘要下方");
	assert.equal(plain(rebuilt.render(WIDTH))[1]!.trimStart(), "ran 1 shell command");
});

check("执行中切到展开后，工具结束重建仍按发起顺序且保持展开", () => {
	const bash = finish(bashRow("b1", "ls"));
	const read = toolRow("read", "r1", { path: "a.ts" });
	const mode = fakeMode([assistantRow({}), bash, read]);
	groupToolRuns(mode);
	groupSilentTurns(mode);
	summariesOf(mode)[0]!.setExpanded(true);

	finish(read);
	groupToolRuns(mode);
	groupSilentTurns(mode);

	const summary = summariesOf(mode)[0]!;
	assert.equal(summary.expanded, true);
	assert.deepEqual(summary.children.slice(1), [bash, read], "按发起顺序铺开");
});

check("多个摘要并存时，执行中行留在自己的区间下方", () => {
	const firstRun = finish(bashRow("b1", "ls"));
	const running = bashRow("b2", "pwd");
	const user = () => new UserMessageComponent("继续", getMarkdownTheme(), 1);
	const mode = fakeMode([assistantRow({}), firstRun, user(), assistantRow({}), running]);
	groupToolRuns(mode);
	groupSilentTurns(mode);

	const first = summariesOf(mode)[0]!;
	assert.equal(plain(first.render(WIDTH))[1]!.trimStart(), "ran 1 shell command");
	assert.equal(mode.chatContainer.children.at(-1), running);

	finish(running);
	groupToolRuns(mode);
	groupSilentTurns(mode);

	const summaries = summariesOf(mode);
	assert.equal(summaries.length, 2, "两个请求各一行摘要");
	assert.equal(summaries[0], first, "前一个区间未变化，实例复用");
	assert.equal(plain(summaries[1]!.render(WIDTH))[1]!.trimStart(), "ran 1 shell command");
	assert.equal(mode.chatContainer.children.at(-1), summaries[1], "后一个区间收成一行");
});

check("工具结束后并入同一行摘要", () => {
	const running = bashRow("c3", "npm test");
	const mode = fakeMode([
		assistantRow({}),
		finishedBash("c1", "ls"),
		finishedBash("c2", "pwd"),
		assistantRow({}),
		running,
	]);
	groupToolRuns(mode);
	groupSilentTurns(mode);

	finish(running);
	groupToolRuns(mode);
	groupSilentTurns(mode);

	const summaries = summariesOf(mode);
	assert.equal(summaries.length, 1);
	assert.equal(mode.chatContainer.children.length, 1);
	assert.equal(plain(summaries[0]!.render(WIDTH))[1]!.trimStart(), "ran 3 shell commands");
});

check("请求中间的正文把区间分段，每段各一行摘要", () => {
	const answer = assistantRow({ text: "我发现了问题" });
	const mode = fakeMode([
		assistantRow({}),
		finishedBash("c1", "ls"),
		finishedBash("c2", "pwd"),
		assistantRow({}),
		finishedBash("c3", "id"),
		finishedBash("c4", "date"),
		answer,
		assistantRow({}),
		finishedBash("c5", "cat a"),
		finishedBash("c6", "cat b"),
		assistantRow({}),
		finishedBash("c7", "grep x"),
		finishedBash("c8", "grep y"),
	]);
	groupToolRuns(mode);
	groupSilentTurns(mode);

	const summaries = summariesOf(mode);
	assert.equal(summaries.length, 2, "正文之后的调用另起一行摘要");
	assert.equal(plain(summaries[0]!.render(WIDTH))[1]!.trimStart(), "ran 4 shell commands");
	assert.equal(
		plain(summaries[1]!.render(WIDTH))[1]!.trimStart(),
		"ran 4 shell commands",
		"正文之后的两段静默轮次仍合入同一行",
	);
	assert.deepEqual(mode.chatContainer.children, [summaries[0], answer, summaries[1]], "正文留在两行摘要之间");
	assert.ok(
		plain(mode.chatContainer.render(WIDTH)).join("\n").includes("我发现了问题"),
		"正文在收起态可见",
	);
});

check("正文之后的调用另起摘要，正文的耗时只计入下面那一行", () => {
	const text = assistantRow({ thinking: "想一想", text: "我发现了问题" });
	applyThoughtLabel(text, 2000);
	const mode = fakeMode([
		assistantRow({}),
		finishedBash("c1", "ls"),
		finishedBash("c2", "pwd"),
		text,
		finishedBash("c3", "cat a"),
		finishedBash("c4", "cat b"),
	]);
	groupToolRuns(mode);
	groupSilentTurns(mode, { thoughtMsFor: (item) => (item === text ? 2000 : undefined) });

	const [before, after] = summariesOf(mode);
	assert.equal(plain(before!.render(WIDTH))[1]!.trimStart(), "ran 2 shell commands");
	assert.equal(plain(after!.render(WIDTH))[1]!.trimStart(), "Thought for 2s, ran 2 shell commands");
	assert.equal(plain(text.render(WIDTH)).join("\n").includes("Thought for"), false, "耗时只出现在下面那行摘要");
});

check("用户消息作为边界，两侧各自折叠", () => {
	const user = () => new UserMessageComponent("继续", getMarkdownTheme(), 1);
	const mode = fakeMode([
		assistantRow({}),
		finishedBash("c1", "ls"),
		finishedBash("c2", "pwd"),
		assistantRow({}),
		finishedBash("c3", "id"),
		finishedBash("c4", "date"),
		user(),
		assistantRow({}),
		finishedBash("c5", "ls"),
		finishedBash("c6", "pwd"),
		assistantRow({}),
		finishedBash("c7", "id"),
		finishedBash("c8", "date"),
	]);
	groupToolRuns(mode);
	groupSilentTurns(mode);

	assert.equal(summariesOf(mode).length, 2);
	assert.equal(mode.chatContainer.children.length, 3);
});

check("报错与中断的轮次留在摘要外，工具段仍各自折叠", () => {
	const failed = assistantRow({ stopReason: "error" });
	const aborted = assistantRow({ stopReason: "aborted" });
	const mode = fakeMode([
		failed,
		finishedBash("c1", "ls"),
		finishedBash("c2", "pwd"),
		aborted,
		finishedBash("c3", "id"),
		finishedBash("c4", "date"),
	]);
	groupToolRuns(mode);
	groupSilentTurns(mode);

	const summaries = summariesOf(mode);
	assert.equal(summaries.length, 2);
	assert.ok(summaries.every((summary) => !summary.children.includes(failed)));
	assert.ok(summaries.every((summary) => !summary.children.includes(aborted)));
	assert.equal(mode.chatContainer.children.includes(failed), true);
	assert.equal(mode.chatContainer.children.includes(aborted), true);
});

check("报错与中断的前置消息保留自己的耗时标签", () => {
	for (const stopReason of ["error", "aborted"]) {
		const failed = assistantRow({ stopReason, thinking: "出错了" });
		applyThoughtLabel(failed, 3000);
		const mode = fakeMode([failed, finishedBash("c1", "ls"), finishedBash("c2", "pwd")]);
		groupToolRuns(mode);
		groupSilentTurns(mode, { thoughtMsFor: (item) => (item === failed ? 3000 : undefined) });

		const summary = summariesOf(mode)[0]!;
		assert.equal(plain(summary.render(WIDTH))[1]!.trimStart(), "ran 2 shell commands", stopReason);
		assert.ok(
			plain(failed.render(WIDTH)).join("\n").includes("Thought for 3s"),
			`${stopReason}: 标签应保留`,
		);
	}
});

check("单条工具行组成的静默轮次同样折叠", () => {
	const mode = fakeMode([
		assistantRow({}),
		finishedBash("c1", "ls"),
		assistantRow({}),
		finishedBash("c2", "pwd"),
	]);
	groupToolRuns(mode);
	groupSilentTurns(mode);

	const summaries = summariesOf(mode);
	assert.equal(summaries.length, 1);
	assert.equal(plain(summaries[0]!.render(WIDTH))[1]!.trimStart(), "ran 2 shell commands");
});

check("edit 不计入摘要行的工具段，仍逐条渲染", () => {
	const edit = finish(toolRow("edit", "e1", { path: "a.ts" }));
	const mode = fakeMode([
		assistantRow({}),
		edit,
		assistantRow({}),
		finishedBash("c1", "ls"),
		finishedBash("c2", "pwd"),
	]);
	groupToolRuns(mode);
	groupSilentTurns(mode);

	const summaries = summariesOf(mode);
	assert.equal(summaries.length, 1);
	assert.equal(plain(summaries[0]!.render(WIDTH))[1]!.trimStart(), "ran 2 shell commands");
	assert.equal(summaries[0]!.children.includes(edit), true);
});

check("edit / write 参与区间但不被摘要行代表，收起时逐条渲染", () => {
	const edit = finish(toolRow("edit", "e1", { path: "a.ts" }));
	const mode = fakeMode([
		assistantRow({}),
		finishedBash("c1", "ls"),
		finishedBash("c2", "pwd"),
		edit,
		assistantRow({}),
		finishedBash("c3", "id"),
		finishedBash("c4", "date"),
	]);
	groupToolRuns(mode);
	groupSilentTurns(mode);

	const summaries = summariesOf(mode);
	assert.equal(summaries.length, 1);
	assert.equal(summaries[0]!.children.includes(edit), true);
	const lines = plain(summaries[0]!.render(WIDTH));
	// 摘要行只统计普通调用，改动内容在下面逐条显式。
	assert.equal(lines[1]!.trimStart(), "ran 4 shell commands");
	assert.ok(
		lines.some((line) => line.includes("path=\"a.ts\"")),
		JSON.stringify(lines),
	);
});

check("重复折叠复用实例并保留展开状态", () => {
	const mode = fakeMode([
		assistantRow({}),
		finishedBash("c1", "ls"),
		finishedBash("c2", "pwd"),
		assistantRow({}),
		finishedBash("c3", "id"),
		finishedBash("c4", "date"),
	]);
	groupToolRuns(mode);
	groupSilentTurns(mode);
	const first = summariesOf(mode)[0]!;
	first.setExpanded(true);

	groupSilentTurns(mode);
	assert.equal(summariesOf(mode)[0], first);
	assert.equal(first.expanded, true);

	mode.chatContainer.addChild(assistantRow({}));
	mode.chatContainer.addChild(finishedBash("c5", "ls"));
	mode.chatContainer.addChild(finishedBash("c6", "pwd"));
	groupSilentTurns(mode);

	const second = summariesOf(mode)[0]!;
	assert.notEqual(second, first);
	assert.equal(second.expanded, true);
	assert.ok(plain(second.render(WIDTH))[1]!.includes("6 shell commands"));
});

check("Ctrl+O 的展开态传递到多轮摘要内的工具行", () => {
	const mode = fakeMode([
		assistantRow({}),
		finishedBash("c1", "ls"),
		finishedBash("c2", "pwd"),
		assistantRow({}),
		finishedBash("c3", "id"),
		finishedBash("c4", "date"),
	]);
	groupToolRuns(mode);
	groupSilentTurns(mode);
	const summary = summariesOf(mode)[0]!;
	summary.setExpanded(true);

	for (const child of summary.children) {
		if (child instanceof ToolRunGroup) assert.equal(child.expanded, true);
	}
});

check("思考结束后隐藏思考标签显示实际耗时", () => {
	// 与摘要行同一套秒数换算。
	assert.equal(thoughtLabel(1500).endsWith("Thought for 2s"), true, thoughtLabel(1500));
	assert.equal(thoughtLabel(200).endsWith("Thought for 1s"), true, thoughtLabel(200));
	assert.ok(thoughtLabel(1500).startsWith("\x1b[0m"), "需重置 pi 的斜体包裹");
	assert.equal(describeRun(["bash", "bash"], 1500), "Thought for 2s, ran 2 shell commands");

	const assistant = assistantRow({ thinking: "想一想" });
	assert.ok(plain(assistant.render(WIDTH)).join("\n").includes("Thinking..."), "初始为占位标签");
	applyThoughtLabel(assistant, 1500);
	const lines = plain(assistant.render(WIDTH)).join("\n");
	assert.ok(lines.includes("Thought for 2s"), lines);
	assert.equal(lines.includes("Thinking..."), false, lines);
});

check("收起态点击改动行交给行自己处理", () => {
	const edit = finish(toolRow("edit", "e1", { path: "a.ts" }));
	let forwarded: number | undefined;
	(edit as any).handleMouse = (event: any) => {
		forwarded = event.y;
		return { handled: true };
	};
	const mode = fakeMode([
		assistantRow({}),
		finishedBash("c1", "ls"),
		finishedBash("c2", "pwd"),
		edit,
		assistantRow({}),
		finishedBash("c3", "id"),
		finishedBash("c4", "date"),
	]);
	groupToolRuns(mode);
	groupSilentTurns(mode);
	const summary = summariesOf(mode)[0]!;

	// 行内坐标：空行(0) + 摘要行(1) 之后是改动行。
	const lines = plain(summary.render(WIDTH));
	const editY = lines.findIndex((line) => line.includes("a.ts"));
	assert.ok(editY > 1, JSON.stringify(lines));
	summary.handleMouse({ type: "click", button: "left", x: 3, y: editY, height: 1 } as any);
	assert.equal(forwarded, editY - 2, "应转发到改动行自身坐标");
	assert.equal(summary.expanded, false, "摘要不应跟着折起");

	// 只有摘要行负责折起。
	summary.handleMouse({ type: "click", button: "left", x: 3, y: 1, height: 1 } as any);
	assert.equal(summary.expanded, true);
});

check("收起态点击空行不切换摘要，只有摘要行切换", () => {
	const mode = fakeMode([assistantRow({}), finishedBash("c1", "ls"), finishedBash("c2", "pwd")]);
	groupToolRuns(mode);
	groupSilentTurns(mode);
	const summary = summariesOf(mode)[0]!;

	const lines = plain(summary.render(WIDTH));
	assert.equal(lines.length, 2, JSON.stringify(lines));
	summary.handleMouse({ type: "click", button: "left", x: 3, y: 0, height: 1 } as any);
	assert.equal(summary.expanded, false, "点击空行不应展开摘要");

	summary.handleMouse({ type: "click", button: "left", x: 3, y: 1, height: 1 } as any);
	assert.equal(summary.expanded, true, "点击摘要行应展开");
});

check("单轮工具组同样只有摘要行负责切换", () => {
	let renders = 0;
	const group = new ToolRunGroup({
		rows: [finishedBash("c1", "ls"), finishedBash("c2", "pwd")] as any,
		toolNames: ["bash", "bash"],
		expanded: false,
		theme: () => undefined,
		requestRender: () => renders++,
	});

	group.render(WIDTH);
	group.handleMouse({ type: "click", button: "left", x: 3, y: 0, height: 2 } as any);
	assert.equal(group.expanded, false, "点击空行不应展开");

	group.handleMouse({ type: "click", button: "left", x: 3, y: 1, height: 2 } as any);
	assert.equal(group.expanded, true, "点击摘要行应展开");
	assert.equal(renders, 1);
});

check("展开态重建后新纳入的工具组也展开", () => {
	const group = (ids: [string, string], expanded: boolean) =>
		new ToolRunGroup({
			rows: [finishedBash(ids[0], ids[0]), finishedBash(ids[1], ids[1])] as any,
			toolNames: ["bash", "bash"],
			expanded,
			theme: () => undefined,
			requestRender() {},
		});

	const next = group(["y1", "y2"], false);
	const summary = new ToolRunSummary({
		items: [group(["x1", "x2"], true), next],
		expanded: true,
		theme: () => undefined,
		requestRender() {},
	});
	assert.equal(next.expanded, true, "新纳入的组应继承展开态");
	const lines = plain(summary.render(WIDTH));
	for (const id of ["x1", "y1"]) {
		assert.equal(lines.filter((line) => line.includes(`command: ${id}`)).length, 1, JSON.stringify(lines));
	}

	// 收起态的摘要不传播展开。
	const collapsed = group(["z1", "z2"], false);
	new ToolRunSummary({ items: [collapsed], expanded: false, theme: () => undefined, requestRender() {} });
	assert.equal(collapsed.expanded, false);
});

check("正文之后的调用另起一行摘要，耗时按段累加", () => {
	const first = assistantRow({ thinking: "先确认", text: "主人，先确认源目录和技能目录的现状。" });
	const silent = assistantRow({ thinking: "查一下" });
	const second = assistantRow({ thinking: "再看", text: "主人，创建符号链接需要管理员权限。" });
	applyThoughtLabel(first, 2000);
	applyThoughtLabel(silent, 900);
	applyThoughtLabel(second, 900);
	const mode = fakeMode([
		first,
		finishedBash("c1", "ls"),
		silent,
		finishedBash("c2", "mklink"),
		second,
	]);
	groupToolRuns(mode);
	const elapsed = new Map<unknown, number>([
		[first, 2000],
		[silent, 900],
		[second, 900],
	]);
	groupSilentTurns(mode, { thoughtMsFor: (item) => elapsed.get(item) });

	const summary = summariesOf(mode)[0]!;
	assert.deepEqual(mode.chatContainer.children, [first, summary, second], "正文把两行摘要分开");
	// 第一段摘要累加区间前那条回复与区间内静默轮次的耗时。
	assert.equal(plain(summary.render(WIDTH))[1]!.trimStart(), "Thought for 3s, ran 2 shell commands");
	assert.equal(plain(first.render(WIDTH)).join("\n").includes("Thought for"), false, "耗时已在摘要行");
	// 收尾回复不再被吸收，保留自己的耗时标签。
	assert.ok(plain(second.render(WIDTH)).join("\n").includes("Thought for 1s"));
});

check("收起时隐去思考正文，展开后按 Pi 设置显示", () => {
	const answer = assistantRow({ thinking: "折叠里的思考", text: "正文", hideThinkingBlock: false });
	const summary = new ToolRunSummary({
		items: [answer],
		expanded: false,
		theme: () => undefined,
		requestRender() {},
	});
	const shown = () => plain(summary.render(WIDTH)).join("\n").includes("折叠里的思考");

	assert.equal(shown(), false);
	assert.ok(plain(summary.render(WIDTH)).join("\n").includes("正文"));
	summary.setExpanded(true);
	assert.equal(shown(), true);
	summary.setExpanded(false);
	assert.equal(shown(), false);
});

check("Pi 切换隐藏思考时，展开态跟随实例开关、收起态始终隐去", () => {
	assert.equal(installToolRunGroups(), true);
	const answer = assistantRow({ thinking: "折叠里的思考", text: "正文", hideThinkingBlock: false });
	const chat = new Container();
	const summary = new ToolRunSummary({
		items: [answer],
		expanded: true,
		theme: () => undefined,
		requestRender() {},
	});
	chat.addChild(summary);

	// Pi 1.6.0 调 `updateThinkingBlockVisibility()` 时不传参数；开关在实例字段上。
	const mode = { hideThinkingBlock: true, chatContainer: chat, ui: { requestRender() {} } };
	const update = (
		InteractiveMode.prototype as unknown as { updateThinkingBlockVisibility: (this: typeof mode) => void }
	).updateThinkingBlockVisibility;
	const shown = () => plain(summary.render(WIDTH)).join("\n").includes("折叠里的思考");

	update.call(mode);
	assert.equal(
		(answer as unknown as { hideThinkingBlock: boolean }).hideThinkingBlock,
		true,
		"展开态应跟随 Pi 的隐藏设置",
	);
	assert.equal(shown(), false);

	mode.hideThinkingBlock = false;
	update.call(mode);
	assert.equal((answer as unknown as { hideThinkingBlock: boolean }).hideThinkingBlock, false);
	assert.equal(shown(), true);

	// 收起后与 Pi 的设置无关：摘要行代表思考。
	summary.setExpanded(false);
	assert.equal(shown(), false);
	mode.hideThinkingBlock = false;
	update.call(mode);
	assert.equal(shown(), false);
});

check("重复安装接管仍成功且不叠加处理", () => {
	assert.equal(installToolRunGroups(), true);
	assert.equal(installToolRunGroups(), true);
	const mode = fakeMode([finishedBash("r1", "ls"), finishedBash("r2", "pwd")]);
	refreshToolRuns(mode);

	assert.equal(mode.chatContainer.children.length, 1);
	assert.equal(plain(summariesOf(mode)[0]!.render(WIDTH))[1]!.trimStart(), "ran 2 shell commands");
});

finishSuite();
