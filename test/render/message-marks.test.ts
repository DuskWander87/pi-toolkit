/**
 * message-marks 扩展验证：消息标记栏（用户消息前缀、助手与工具圆点、系统类组件缩进、块间距）
 * 与输入框（PromptPrefixEditor）渲染。
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
	getSelectListTheme,
	initTheme,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	Spacer,
	Text,
	stripTerminalSequences,
	setCapabilityOverrides,
	visibleWidth,
	type EditorTheme,
	type TUI,
} from "@earendil-works/pi-tui";
import extend, {
	PromptPrefixEditor,
	SUCCESS_MARKER_COLOR,
	installAssistantMarks,
	installGutter,
	installMessageMarks,
	installToolMarks,
	installUserMessagePrefix,
	prefixFirstContentLine,
} from "../../extensions/render/message-marks/index.ts";
import { check, finish } from "../harness.ts";

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

check("普通文本首行带 `❯ ` 前缀", () => {
	const lines = visibleLines("hello world").filter(Boolean);
	assert.equal(lines[0], "❯ hello world");
});

check("重复安装不叠加前缀", () => {
	const lines = visibleLines("hello world").filter(Boolean);
	assert.equal(lines[0], "❯ hello world");
});

check("代码块首行带前缀，正文与围栏保持完整", () => {
	const lines = visibleLines("```ts\nconst a = 1;\n```").filter(Boolean);
	assert.equal(lines[0], "❯ ```ts");
	assert.ok(lines.includes("const a = 1;"), lines.join("\n"));
	assert.equal(lines[lines.length - 1], "```");
});

check("多行消息只给首行加前缀", () => {
	const lines = visibleLines("line1\nline2").filter(Boolean);
	assert.deepEqual(lines, ["❯ line1", "line2"]);
});

check("换行后的内容与首行内容列对齐", () => {
	const lines = contentLines("一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十", 40);
	assert.ok(lines.length > 1, lines.join("\n"));
	assert.ok(lines[0]!.startsWith("❯ "), lines[0]);
	for (const line of lines.slice(1)) assert.equal(contentColumn(line), 2, line);
});

check("多行消息的所有内容列对齐", () => {
	const lines = contentLines("line1\nline2\nline3");
	assert.equal(lines[0]!.trim(), "❯ line1");
	assert.deepEqual(
		lines.slice(1).map((line) => contentColumn(line)),
		[2, 2],
	);
});

check("代码块整体右移，围栏与正文的相对缩进不变", () => {
	const lines = contentLines("```ts\nconst a = 1;\n```");
	const codeIndent = visibleWidth(getMarkdownTheme().codeBlockIndent ?? "  ");
	assert.equal(lines[0]!.trim(), "❯ ```ts");
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
	assert.deepEqual(lines, ["❯ │ quote", "- item"]);
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
	assert.deepEqual(prefixFirstContentLine(lines, "❯ "), lines);
});

check("行首无内边距时仍插入并回收行尾空格", () => {
	const line = "\x1b[48;2;1;2;3mhello   \x1b[49m";
	const [prefixed] = prefixFirstContentLine([line], "❯ ");
	assert.equal(stripTerminalSequences(prefixed).trim(), "❯ hello");
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
	assert.equal(lines[0], "❯ ```ts");
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

function assistantLines(content: unknown[], hideThinking = true, width = WIDTH): readonly string[] {
	return assistantComponent(content, hideThinking).render(width);
}

function plain(lines: readonly string[]): string[] {
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

function toolLines(result?: unknown, isPartial = false, width = WIDTH): readonly string[] {
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

/** 恰好在渲染宽度处断行、行尾没有留白的正文：标记栏借不到可回收的空格。 */
const FULL_WIDTH_BODY = "A".repeat(WIDTH - 4) + "END!";

const FULL_WIDTH_TOOL = {
	name: "full",
	renderShell: "self" as const,
	renderCall: (_args: unknown, theme: any) => new Text(theme.bold("full"), 0, 0),
	renderResult: (_result: unknown, _options: unknown, _theme: unknown, context: any) =>
		new Text(FULL_WIDTH_BODY, context.outputPad, 0),
};

function fullWidthToolLines(outputPad: number, width = WIDTH): readonly string[] {
	const component = new ToolExecutionComponent(
		"full",
		`call-full-${outputPad}`,
		{},
		{ outputPad },
		FULL_WIDTH_TOOL as any,
		{ requestRender() {} } as any,
		process.cwd(),
	);
	component.markExecutionStarted();
	component.setArgsComplete();
	component.updateResult({ content: [], isError: false } as any, false);
	return component.render(width);
}

check("行尾没有留白的满宽工具行不丢字", () => {
	for (const outputPad of [0, 1]) {
		const lines = fullWidthToolLines(outputPad);
		// 断行位置可以变，正文本身不能少一个字符。
		const joined = plain(lines).join("").replace(/\s+/g, "");
		assert.ok(joined.includes(FULL_WIDTH_BODY), `outputPad=${outputPad}：${plain(lines).join(" / ")}`);
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= WIDTH, `outputPad=${outputPad} 超宽：${visibleWidth(line)}`);
			if (isBlank(line)) continue;
			assert.equal(bodyColumn(plain([line])[0]!), 2, `outputPad=${outputPad}：${plain([line])[0]}`);
		}
	}
});

check("宽度不足以放下标记栏时退回原宽度，不把负宽度传给上游", () => {
	const widths: number[] = [];
	/** 上游桩：记录收到的宽度，并保证每一行都是可见字符（空输出就无法看出宽度）。 */
	class NarrowProbe {
		render(width: number): readonly string[] {
			widths.push(width);
			return ["N".repeat(width)];
		}
	}
	installGutter(NarrowProbe, Symbol.for("pi-toolkit.test.narrow-probe"));

	for (const width of [1, 2]) {
		const lines = new NarrowProbe().render(width);
		assert.ok(lines.length > 0, `width=${width}：输出不能为空`);
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= width, `width=${width} 超宽：${visibleWidth(line)}`);
			// 宽度放不下标记栏时只能截回，这里只要求不超宽、不把负宽度传给上游。
		}
		for (const line of fullWidthToolLines(0, width)) {
			assert.ok(visibleWidth(line) <= width, `width=${width} 工具行超宽：${JSON.stringify(stripTerminalSequences(line))}`);
		}
	}
	// 上游拿到的必须是原宽度，不能是 0 或负数（在 `" ".repeat(width)` 上抛 RangeError）。
	assert.deepEqual(widths, [1, 2], `上游收到的宽度：${JSON.stringify(widths)}`);
});

check("每次刷新只排版一遍，宽度固定为扣除标记栏后的值", () => {
	const widths: number[] = [];
	class PassProbe {
		render(width: number): readonly string[] {
			widths.push(width);
			return ["P".repeat(width)];
		}
	}
	installGutter(PassProbe, Symbol.for("pi-toolkit.test.pass-probe"));

	const component = new PassProbe();
	component.render(WIDTH);
	component.render(WIDTH);
	// 双渲染会记成 [WIDTH, WIDTH - 2, ...]，宽度来回摆还会让上游排版缓存全部失效。
	assert.deepEqual(widths, [WIDTH - 2, WIDTH - 2], `上游收到的宽度：${JSON.stringify(widths)}`);
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

function assertGutterAligned(lines: readonly string[], width = WIDTH): void {
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${JSON.stringify(stripTerminalSequences(line))}`);
		if (isBlank(line)) continue;
		assert.equal(contentColumn(stripTerminalSequences(line)), 2, JSON.stringify(stripTerminalSequences(line)));
	}
	const joined = plain(lines).join("\n");
	assert.equal(joined.includes("●"), false, joined);
	assert.equal(joined.includes("❯"), false, joined);
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

	const assertSkillLines = (lines: readonly string[]): void => {
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

check("customRenderer 满宽输出不超宽", () => {
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

/**
 * 宽度敏感组件的桩：`WIDTH` 下留 2 格行尾空白，其它宽度排满整行。
 * 用来检查缓存键跟着渲染宽度走：换个宽度渲染时不能复用上一次的结果。
 */
class ResizeStub {
	render(width: number): readonly string[] {
		return [width === WIDTH ? "X".repeat(WIDTH - 2) + "  " : "X".repeat(width)];
	}
}
installGutter(ResizeStub, Symbol.for("pi-toolkit.test.resize-gutter"));

check("加宽 2 列后不复用上一宽度的缓存", () => {
	const component = new ResizeStub();
	assert.equal(visibleWidth(component.render(WIDTH)[0]!), WIDTH, "初始宽度应铺满");
	const after = component.render(WIDTH + 2);
	assert.deepEqual(after, new ResizeStub().render(WIDTH + 2));
	assert.equal(visibleWidth(after[0]!), WIDTH + 2, JSON.stringify(after));
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

function leadingBlanks(lines: readonly string[]): number {
	let count = 0;
	while (count < lines.length && isBlank(lines[count]!)) count++;
	return count;
}

function trailingBlanks(lines: readonly string[]): number {
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

/** 1×1 PNG：让 `Image` 组件渲染出真正的终端图片行。 */
const PNG_1X1 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/wF/9HkAAAAASUVORK5CYII=";

check("工具块里的终端图片行与它占的高度不算块留白", () => {
	for (const images of ["kitty", "iterm2"] as const) {
		setCapabilityOverrides({ images });
		try {
			const lines = toolLines({ content: [{ type: "image", data: PNG_1X1, mimeType: "image/png" }], isError: false });
			const row = lines.findIndex((line) =>
				images === "kitty" ? line.includes("\x1b_G") : line.includes("\x1b]1337;File="),
			);
			assert.ok(row !== -1, `${images}：图片序列被当成空行删掉\n${plain(lines).join("\n")}`);
			// Kitty 把占位空行放在序列行之后，iTerm2 放在之前：图片高度必须留下
			const padding = images === "kitty" ? lines[row + 1] : lines[row - 1];
			assert.ok(padding !== undefined && isBlank(padding), `${images}：图片占位行被删掉\n${plain(lines).join("\n")}`);
		} finally {
			setCapabilityOverrides({});
		}
	}
});

// ── 输入框（PromptPrefixEditor） ──────────────────────────────────────

const editorTui = { terminal: { rows: 40 }, requestRender() {}, setFocus() {} } as unknown as TUI;
const editorKeybindings = { matches: () => false } as unknown as KeybindingsManager;
const editorTheme = {
	borderColor: (text: string) => text,
	selectList: getSelectListTheme(),
} as unknown as EditorTheme;

function renderEditorText(text: string, width = 40, paddingX = 0, focused = true): string[] {
	const editor = new PromptPrefixEditor(editorTui, editorTheme, editorKeybindings);
	editor.setPaddingX(paddingX);
	editor.setText(text);
	editor.focused = focused;
	return editor.render(width).map(stripTerminalSequences);
}

check("空输入框首行以 `❯ ` 起头", () => {
	const lines = renderEditorText("");
	assert.ok(lines[1]!.startsWith("❯ "), JSON.stringify(lines[1]));
});

check("首行文本紧跟 `❯ `", () => {
	const lines = renderEditorText("hello");
	assert.ok(lines[1]!.startsWith("❯ hello"), JSON.stringify(lines[1]));
});

check("多行输入后续行缩进到文本列", () => {
	const lines = renderEditorText("line1\nline2");
	assert.ok(lines[2]!.startsWith("  line2"), JSON.stringify(lines[2]));
});

check("换行后的内容列与首行文本列一致", () => {
	const lines = renderEditorText("一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十");
	const content = lines.slice(1, -1);
	assert.ok(content.length > 1, content.join("\n"));
	for (const line of content.slice(1)) assert.equal(contentColumn(line), 2, JSON.stringify(line));
});

check("输入框渲染行宽度保持不变", () => {
	const width = 40;
	for (const text of ["", "hello", "一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十"]) {
		for (const line of renderEditorText(text, width)) assert.equal(visibleWidth(line), width, JSON.stringify(text));
	}
});

check("setPaddingX 保留 `❯ ` 留白，getPaddingX 还原设置值", () => {
	const editor = new PromptPrefixEditor(editorTui, editorTheme, editorKeybindings);
	for (const padding of [0, 1, 3]) {
		editor.setPaddingX(padding);
		assert.equal(editor.getPaddingX(), padding);
		editor.setText("line1\nline2");
		const lines = editor.render(40).map(stripTerminalSequences);
		assert.ok(lines[1]!.startsWith("❯"), `${padding}: ${JSON.stringify(lines[1])}`);
		assert.equal(contentColumn(lines[2]!), 2 + padding, `${padding}: ${JSON.stringify(lines[2])}`);
	}
});

check("窄终端下不插入输入框前缀且宽度不变", () => {
	const lines = renderEditorText("hello", 4);
	assert.ok(!lines[1]!.includes("❯"), JSON.stringify(lines[1]));
	for (const line of lines) assert.equal(visibleWidth(line), 4);
});

check("输入框上下边框保持原样", () => {
	const lines = renderEditorText("hello");
	assert.equal(lines[0]!.trim(), "─".repeat(40));
	assert.equal(lines[lines.length - 1]!.trim(), "─".repeat(40));
});

check("输入框与默认一致，工作状态嵌入上边框", () => {
	const editor = new PromptPrefixEditor(editorTui, editorTheme, editorKeybindings);
	assert.equal(editor.embedWorkingStatus, true);
});

finish();
