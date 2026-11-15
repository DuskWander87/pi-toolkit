/**
 * message-marks 渲染逻辑验证。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import {
	AssistantMessageComponent,
	BashExecutionComponent,
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	CustomMessageComponent,
	SkillInvocationMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
	getMarkdownTheme,
	initTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import extend, {
	SUCCESS_MARKER_COLOR,
	installAssistantMarks,
	installMessageMarks,
	installToolMarks,
	installUserMessagePrefix,
	prefixFirstContentLine,
} from "../extensions/message-marks/index.ts";
import { check, finish } from "./harness.ts";

initTheme("dark", false);
installUserMessagePrefix();
installUserMessagePrefix();

/** 测试用主题桩：扩展只用到 `fg()` 与 `style()` 两个方法。 */
const testTheme = {
	fg: (token: string, text: string) => `[38;2;255;85;85m${text}[39m`,
	style: (text: string, options: { fg?: any }) =>
		options.fg ? `[38;2;${options.fg.r};${options.fg.g};${options.fg.b}m${text}[39m` : text,
};

function visibleLines(text: string, width = 40): string[] {
	return new UserMessageComponent(text, getMarkdownTheme(), 1)
		.render(width)
		.map((line) => stripTerminalSequences(line).trim());
}

function rawLines(text: string, width = 40): string[] {
	return new UserMessageComponent(text, getMarkdownTheme(), 1)
		.render(width)
		.map(stripTerminalSequences);
}

/** 首个可见字符所在的列。 */
function contentColumn(line: string): number {
	return line.length - line.trimStart().length;
}

function contentLines(text: string, width = 40): string[] {
	return rawLines(text, width).filter((line) => line.trim() !== "");
}

check("普通文本首行带 `› ` 前缀", () => {
	const lines = visibleLines("hello world").filter(Boolean);
	assert.equal(lines[0], "› hello world");
});

check("重复安装不叠加前缀", () => {
	const lines = visibleLines("hello world").filter(Boolean);
	assert.equal(lines[0], "› hello world");
});

check("代码块首行带前缀，正文与围栏保持完整", () => {
	const lines = visibleLines("```ts\nconst a = 1;\n```").filter(Boolean);
	assert.equal(lines[0], "› ```ts");
	assert.ok(lines.includes("const a = 1;"), lines.join("\n"));
	assert.equal(lines[lines.length - 1], "```");
});

check("多行消息只给首行加前缀", () => {
	const lines = visibleLines("line1\nline2").filter(Boolean);
	assert.deepEqual(lines, ["› line1", "line2"]);
});

check("换行后的内容与首行内容列对齐", () => {
	const lines = contentLines("一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十", 40);
	assert.ok(lines.length > 1, lines.join("\n"));
	assert.ok(lines[0]!.startsWith("› "), lines[0]);
	for (const line of lines.slice(1)) assert.equal(contentColumn(line), 2, line);
});

check("多行消息的所有内容列对齐", () => {
	const lines = contentLines("line1\nline2\nline3");
	assert.equal(lines[0]!.trim(), "› line1");
	assert.deepEqual(
		lines.slice(1).map((line) => contentColumn(line)),
		[2, 2],
	);
});

check("代码块整体右移，围栏与正文的相对缩进不变", () => {
	const lines = contentLines("```ts\nconst a = 1;\n```");
	const codeIndent = visibleWidth(getMarkdownTheme().codeBlockIndent ?? "  ");
	assert.equal(lines[0]!.trim(), "› ```ts");
	assert.equal(contentColumn(lines[1]!), 2 + codeIndent);
	assert.equal(contentColumn(lines[2]!), 2);
});

check("缩进后每行宽度不超过目标宽度", () => {
	const width = 40;
	const text = "一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十";
	for (const line of rawLines(text, width)) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`);
});

check("原有引用块与列表结构不变", () => {
	const lines = visibleLines("> quote\n\n- item").filter(Boolean);
	assert.deepEqual(lines, ["› │ quote", "- item"]);
});

check("前缀不改变渲染宽度", () => {
	const width = 40;
	for (const text of ["hello world", "```ts\nconst a = 1;\n```", "\n\nhello"]) {
		for (const line of new UserMessageComponent(text, getMarkdownTheme(), 1).render(width)) {
			assert.ok(visibleWidth(line) <= width, `${JSON.stringify(text)}: ${visibleWidth(line)} > ${width}`);
		}
	}
});

check("没有可见内容时保持原样", () => {
	const lines = ["   ", "\x1b[48;2;1;2;3m   \x1b[49m"];
	assert.deepEqual(prefixFirstContentLine(lines, "› "), lines);
});

check("行首无内边距时仍插入并回收行尾空格", () => {
	const line = "\x1b[48;2;1;2;3mhello   \x1b[49m";
	const [prefixed] = prefixFirstContentLine([line], "› ");
	assert.equal(stripTerminalSequences(prefixed).trim(), "› hello");
	assert.equal(visibleWidth(prefixed), visibleWidth(line));
});

check("用户消息不再铺背景色", () => {
	for (const text of ["hello world", "```ts\nconst a = 1;\n```"]) {
		for (const line of new UserMessageComponent(text, getMarkdownTheme(), 1).render(40)) {
			assert.ok(!/\x1b\[(?:4[0-7]|10[0-7]|48;|49m)/.test(line), JSON.stringify(line));
		}
	}
});

check("去掉背景色后行宽与内容不变", () => {
	for (const line of rawLines("hello world", 40)) assert.equal(visibleWidth(line), 40, JSON.stringify(line));
	const lines = visibleLines("```ts\nconst a = 1;\n```").filter(Boolean);
	assert.equal(lines[0], "› ```ts");
	assert.ok(lines.includes("const a = 1;"), lines.join("\n"));
});

// ---------------------------------------------------------------- 助手与工具标记
const WIDTH = 46;

/** 运行一次默认导出，拿到 `session_start` 里的主题代理并装好三处接管。 */
extend({
	on(_event: string, handler: (...args: any[]) => void) {
		handler({}, { hasUI: true, ui: { theme: testTheme, setEditorComponent() {} } });
	},
} as any);

extend({
	on(_event: string, handler: (...args: any[]) => void) {
		handler({}, { hasUI: true, ui: { theme: testTheme, setEditorComponent() {} } });
	},
} as any);

function assistantComponent(content: unknown[], hideThinking = true): AssistantMessageComponent {
	return new AssistantMessageComponent(
		{ content, stopReason: "endTurn" } as any,
		hideThinking,
		getMarkdownTheme(),
		"Thinking...",
		1,
		[],
	);
}

function assistantLines(content: unknown[], hideThinking = true, width = WIDTH): string[] {
	return assistantComponent(content, hideThinking).render(width);
}

function plain(lines: string[]): string[] {
	return lines.map(stripTerminalSequences);
}

function isBlank(line: string): boolean {
	return stripTerminalSequences(line).trim() === "";
}

/** 内容列：行首标记算 2 列留白，返回正文第一个可见字符所在的列。 */
function bodyColumn(line: string): number {
	return contentColumn(line.startsWith("● ") ? `  ${line.slice(2)}` : line);
}

const DEMO_TOOL = {
	name: "demo",
	renderShell: "self" as const,
	renderCall: (_args: unknown, theme: any, context: any) =>
		new Text(`${theme.bold("demo")} ${context.args?.path ?? ""}`, context.outputPad, 0),
	renderResult: () => new Text("done", 1, 0),
};

function toolLines(result?: unknown, isPartial = false, width = WIDTH): string[] {
	const component = new ToolExecutionComponent(
		"demo",
		"call-1",
		{ path: "a.ts" },
		{ outputPad: 1 },
		DEMO_TOOL as any,
		{ requestRender() {} } as any,
		process.cwd(),
	);
	component.markExecutionStarted();
	component.setArgsComplete();
	if (result !== undefined) component.updateResult(result as any, isPartial);
	return component.render(width);
}

check("助手文本块首行带 `● `，圆点不落在思考行上", () => {
	const lines = plain(assistantLines([
		{ type: "thinking", thinking: "想一下" },
		{ type: "text", text: "第一段落。\n\n第二段落。" },
	]));
	const thinkingRow = lines.findIndex((line) => line.includes("Thinking..."));
	const textRow = lines.findIndex((line) => line.includes("第一段落"));
	assert.ok(thinkingRow >= 0 && textRow > thinkingRow, JSON.stringify(lines));
	assert.ok(!lines[thinkingRow]!.includes("●"), JSON.stringify(lines[thinkingRow]));
	assert.ok(lines[textRow]!.startsWith("● 第一段落"), JSON.stringify(lines[textRow]));
});

check("助手续行与首行首字同列，思考行同列", () => {
	const lines = plain(assistantLines([
		{ type: "thinking", thinking: "想一下" },
		{ type: "text", text: "第一段落。\n\n第二段落。" },
	]));
	const thinkingRow = lines.findIndex((line) => line.includes("Thinking..."));
	const textRow = lines.findIndex((line) => line.includes("第一段落"));
	const secondRow = lines.findIndex((line) => line.includes("第二段落"));
	for (const row of [thinkingRow, textRow, secondRow]) assert.equal(bodyColumn(lines[row]!), 2, JSON.stringify(lines[row]));
});

check("助手行宽保持不变", () => {
	const lines = assistantLines([
		{ type: "thinking", thinking: "想一下" },
		{ type: "text", text: "第一段落。\n\n第二段落。" },
	]);
	for (const line of lines) {
		if (isBlank(line)) continue;
		assert.equal(visibleWidth(line), WIDTH, JSON.stringify(stripTerminalSequences(line)));
	}
});

check("没有文本块的助手消息不加圆点", () => {
	const lines = plain(assistantLines([{ type: "thinking", thinking: "只有思考" }]));
	assert.ok(!lines.some((line) => line.includes("●")), lines.join("\n"));
});

check("重复安装不叠加助手圆点", () => {
	const lines = plain(assistantLines([{ type: "text", text: "一段话。" }]));
	const row = lines.findIndex((line) => line.includes("一段话"));
	assert.equal((lines[row]!.match(/●/g) ?? []).length, 1, JSON.stringify(lines[row]));
});

check("重复安装后的输出与单次安装一致", () => {
	const content = [{ type: "text", text: "一段话。" }];
	const before = plain(assistantLines(content));
	installAssistantMarks();
	installToolMarks();
	assert.deepEqual(plain(assistantLines(content)), before);
});

check("工具行首圆点成功为蓝色", () => {
	const lines = toolLines({ content: [], isError: false, durationMs: 12 });
	const marker = testTheme.style("●", { fg: SUCCESS_MARKER_COLOR });
	assert.ok(lines.some((line) => line.includes(marker)), JSON.stringify(plain(lines)));
});

check("工具行首圆点失败为红色", () => {
	const lines = toolLines({ content: [{ type: "text", text: "boom" }], isError: true, durationMs: 12 });
	const marker = testTheme.fg("error", "●");
	const row = lines.findIndex((line) => stripTerminalSequences(line).includes("●"));
	assert.ok(row !== -1, JSON.stringify(plain(lines)));
	assert.ok(lines[row]!.includes(marker), JSON.stringify(plain(lines)[row]));
});

check("运行中的工具行首圆点与成功同为蓝色", () => {
	const lines = toolLines();
	const marker = testTheme.style("●", { fg: SUCCESS_MARKER_COLOR });
	const row = lines.findIndex((line) => stripTerminalSequences(line).includes("●"));
	assert.ok(row !== -1, JSON.stringify(plain(lines)));
	assert.ok(lines[row]!.includes(marker), JSON.stringify(plain(lines)[row]));
});

check("工具块所有行内容列对齐到第 2 列，行宽不变", () => {
	for (const lines of [
		toolLines(),
		toolLines({ content: [], isError: false }),
		toolLines({ content: [{ type: "text", text: "boom" }], isError: true }),
	]) {
		for (const line of lines) {
			if (isBlank(line)) continue;
			assert.equal(visibleWidth(line), WIDTH, JSON.stringify(stripTerminalSequences(line)));
		}
		for (const line of plain(lines)) {
			if (line.trim() === "") continue;
			assert.equal(bodyColumn(line), 2, JSON.stringify(line));
		}
	}
});

check("重复安装不叠加工具圆点", () => {
	const lines = plain(toolLines({ content: [], isError: false }));
	assert.equal((lines.join("").match(/●/g) ?? []).length, 1, lines.join("\n"));
});

check("主题变化后工具圆点更新（缓存按 marker 失效）", () => {
	const component = new ToolExecutionComponent(
		"demo",
		"call-theme",
		{ path: "a.ts" },
		{ outputPad: 1 },
		DEMO_TOOL as any,
		{ requestRender() {} } as any,
		process.cwd(),
	);
	component.markExecutionStarted();
	component.setArgsComplete();
	component.updateResult({ content: [], isError: false } as any, false);
	const before = plain(component.render(WIDTH));

	const altTheme = {
		fg: (token: string, text: string) => `<${token}>${text}</${token}>`,
		style: (text: string) => `[${text}]`,
	};
	try {
		extend({
			on(_event: string, handler: (...args: any[]) => void) {
				handler({}, { hasUI: true, ui: { theme: altTheme, setEditorComponent() {} } });
			},
		} as any);
		const after = plain(component.render(WIDTH));
		assert.notDeepEqual(after, before, "主题变化后应重新渲染圆点");
		assert.equal((after.join("").match(/●/g) ?? []).length, 1, after.join("\n"));
	} finally {
		extend({
			on(_event: string, handler: (...args: any[]) => void) {
				handler({}, { hasUI: true, ui: { theme: testTheme, setEditorComponent() {} } });
			},
		} as any);
	}
});

// ---------------------------------------------------------------- 系统类组件缩进
const fakeUI = { requestRender() {} } as any;
const systemMarkdown = getMarkdownTheme();

function assertGutterAligned(lines: string[], width = WIDTH): void {
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${JSON.stringify(stripTerminalSequences(line))}`);
		if (isBlank(line)) continue;
		assert.equal(contentColumn(stripTerminalSequences(line)), 2, JSON.stringify(stripTerminalSequences(line)));
	}
	const joined = plain(lines).join("\n");
	assert.equal(joined.includes("●"), false, joined);
	assert.equal(joined.includes("›"), false, joined);
}

function bashComponent(outputPad = 1): BashExecutionComponent {
	return new BashExecutionComponent("echo hi", fakeUI, false, outputPad);
}

function skillComponent(): SkillInvocationMessageComponent {
	return new SkillInvocationMessageComponent(
		{ name: "demo", location: "/skills/demo", content: "技能内容。", userMessage: undefined } as any,
		systemMarkdown,
		1,
	);
}

check("系统类组件左缘对齐到第 2 列", () => {
	const compaction = new CompactionSummaryMessageComponent(
		{ role: "compactionSummary", summary: "压缩前的摘要内容。", tokensBefore: 12000, timestamp: 0 } as any,
		systemMarkdown,
		1,
	);
	const branch = new BranchSummaryMessageComponent(
		{ role: "branchSummary", summary: "分支摘要内容。", fromId: null, timestamp: 0 } as any,
		systemMarkdown,
		1,
	);
	const custom = new CustomMessageComponent(
		{ role: "custom", customType: "demo", content: "自定义消息内容。", display: true, timestamp: 0 } as any,
		undefined,
		systemMarkdown,
		1,
	);
	const bash = bashComponent();

	assertGutterAligned(compaction.render(WIDTH));
	assertGutterAligned(branch.render(WIDTH));
	assertGutterAligned(custom.render(WIDTH));
	assertGutterAligned(bash.render(WIDTH));
	bash.setComplete(0, false);
});

check("skill 调用与工具行同一套标记栏：去背景、首行蓝圆点", () => {
	const marker = testTheme.style("●", { fg: SUCCESS_MARKER_COLOR });
	const skill = skillComponent();

	const assertSkillLines = (lines: string[]): void => {
		const joined = lines.join("\n");
		assert.equal(joined.includes("\x1b[48;"), false, "不应保留背景色");
		assert.equal(joined.includes("\x1b[49m"), false, "不应保留背景复位");
		const visible = plain(lines);
		const row = visible.findIndex((line) => line.includes("[skill]"));
		assert.ok(row !== -1, visible.join("\n"));
		assert.ok(visible[row]!.startsWith("● [skill]"), JSON.stringify(visible[row]));
		assert.ok(lines[row]!.includes(marker), JSON.stringify(visible[row]));
		for (const [index, line] of lines.entries()) {
			assert.ok(visibleWidth(line) <= WIDTH, `${visibleWidth(line)} > ${WIDTH}`);
			if (index === row || isBlank(visible[index]!)) continue;
			assert.equal(contentColumn(visible[index]!), 2, JSON.stringify(visible[index]));
		}
	};

	assertSkillLines(skill.render(WIDTH));
	skill.setExpanded(true);
	assertSkillLines(skill.render(WIDTH));
});

check("bash 运行态与满宽边框不超宽", () => {
	const bash = bashComponent();
	const lines = bash.render(WIDTH);
	assertGutterAligned(lines);
	const border = plain(lines).find((line) => line.includes("─"));
	assert.ok(border !== undefined, JSON.stringify(plain(lines)));
	assert.equal(visibleWidth(lines[plain(lines).indexOf(border!)]!), WIDTH);
	bash.setComplete(0, false);
});

check("bash 在 outputPad=0 与 2 下都对齐到第 2 列", () => {
	for (const pad of [0, 2]) {
		const bash = bashComponent(pad);
		assertGutterAligned(bash.render(WIDTH));
		bash.setComplete(0, false);
	}
});

check("customRenderer 满宽输出被截回原宽度", () => {
	const custom = new CustomMessageComponent(
		{ role: "custom", customType: "demo", content: "x", display: true, timestamp: 0 } as any,
		() => new Text("X".repeat(WIDTH), 0, 0),
		systemMarkdown,
		1,
	);
	const lines = custom.render(WIDTH);
	const row = plain(lines).find((line) => line.includes("X"));
	assert.ok(row !== undefined, JSON.stringify(plain(lines)));
	assert.equal(row!.startsWith("  "), true, JSON.stringify(row));
	assert.equal(visibleWidth(lines[plain(lines).indexOf(row!)]!), WIDTH);
});

check("重复安装系统组件不叠加缩进", () => {
	installMessageMarks();
	const compaction = new CompactionSummaryMessageComponent(
		{ role: "compactionSummary", summary: "重复安装后的内容。", tokensBefore: 100, timestamp: 0 } as any,
		systemMarkdown,
		1,
	);
	assertGutterAligned(compaction.render(WIDTH));

	const skillLines = skillComponent().render(WIDTH);
	assert.equal((plain(skillLines).join("").match(/●/g) ?? []).length, 1, "重复安装不叠加圆点");
	assert.equal(skillLines.join("").includes("\x1b[48;"), false, "重复安装不恢复背景色");
});

function leadingBlanks(lines: string[]): number {
	let count = 0;
	while (count < lines.length && isBlank(lines[count]!)) count++;
	return count;
}

function trailingBlanks(lines: string[]): number {
	let count = 0;
	while (count < lines.length && isBlank(lines[lines.length - 1 - count]!)) count++;
	return count;
}

check("块间距：跟在 Spacer 后面的块不留首行空行，其余块只留 1 行", () => {
	// Pi 在用户消息、技能调用、压缩/分支摘要前插入 Spacer(1)，这些块不能再带首行留白。
	for (const [id, lines] of [
		["skill", skillComponent().render(WIDTH)],
		["user", new UserMessageComponent("用户消息内容。", systemMarkdown, 1).render(WIDTH)],
		[
			"compaction",
			new CompactionSummaryMessageComponent(
				{ role: "compactionSummary", summary: "压缩摘要。", tokensBefore: 100, timestamp: 0 } as any,
				systemMarkdown,
				1,
			).render(WIDTH),
		],
	] as const) {
		assert.equal(leadingBlanks(plain(lines)), 0, `${id} 首行留白：${plain(lines).join("\n")}`);
		assert.equal(trailingBlanks(plain(lines)), 0, `${id} 尾随空行：${plain(lines).join("\n")}`);
	}

	for (const [id, lines] of [
		["assistant", assistantLines([{ type: "text", text: "一段话。" }])],
		["tool", toolLines({ content: [], isError: false })],
		["bash", bashComponent().render(WIDTH)],
	] as const) {
		assert.equal(leadingBlanks(plain(lines)), 1, `${id} 首行留白：${plain(lines).join("\n")}`);
		assert.equal(trailingBlanks(plain(lines)), 0, `${id} 尾随空行：${plain(lines).join("\n")}`);
	}
});

check("用户消息去掉留白后仍保留 OSC 133 分区标记", () => {
	const lines = new UserMessageComponent("用户消息内容。", systemMarkdown, 1).render(WIDTH);
	assert.ok(lines[0]!.includes("\x1b]133;A\x07"), JSON.stringify(lines[0]));
	assert.ok(
		lines[lines.length - 1]!.includes("\x1b]133;B\x07\x1b]133;C\x07"),
		JSON.stringify(lines[lines.length - 1]),
	);
});

check("助手、技能、用户相邻块之间恰好 1 行空行", () => {
	const container = new Container();
	// 与 Pi 的 addMessageToChat 一致：技能调用与用户消息前各有 Spacer(1)
	container.addChild(assistantComponent([{ type: "text", text: "先前的回复。" }]));
	container.addChild(new Spacer(1));
	container.addChild(skillComponent());
	container.addChild(new Spacer(1));
	container.addChild(new UserMessageComponent("检查最近一次的提交。", systemMarkdown, 1));
	container.addChild(assistantComponent([{ type: "text", text: "先读改动内容。" }]));

	const visible = plain(container.render(WIDTH));
	const gaps: number[] = [];
	for (let row = 0; row < visible.length; ) {
		if (!isBlank(visible[row]!)) {
			row++;
			continue;
		}
		const start = row;
		while (row < visible.length && isBlank(visible[row]!)) row++;
		if (start > 0) gaps.push(row - start);
	}
	assert.deepEqual(gaps, [1, 1, 1], visible.join("\n"));
});

finish();
