/**
 * minimal-tools
 *
 * 工具调用两阶段显示：
 * - 执行中：显示完整命令与运行耗时
 * - 结束后：折叠为一行摘要；edit / write 直接展示改动内容
 *
 * 展开（Ctrl+O）或出错时显示完整内容。
 */

import type { ExtensionAPI, ToolRenderers, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { formatReadLineRange } from "@earendil-works/pi-coding-agent";
import { Box, type Color, type Component, Text, visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";

/** 从 `pi.registerTool` 的参数推断出的渲染函数类型。 */
type RenderArgs = Parameters<NonNullable<Parameters<ExtensionAPI["registerTool"]>[0]["renderCall"]>>;
type RenderResultArgs = Parameters<
	NonNullable<Parameters<ExtensionAPI["registerTool"]>[0]["renderResult"]>
>;
type RenderTheme = RenderArgs[1];
type RenderContext = RenderArgs[2];

const MAX_COMMAND_CHARS = 100;
/** 默认展示的 diff 行数上限，超出部分靠 Ctrl+O 展开。 */
const EDIT_DIFF_MAX_LINES = 30;
/** 默认展示的写入内容预览行数。 */
const WRITE_PREVIEW_MAX_LINES = 10;
/** 运行中计时的重绘间隔，与 Pi 内置工具计时一致。 */
const TIMER_REFRESH_MS = 1000;

/** 保存在 `context.state` 中的计时状态，renderCall 与 renderResult 共享。 */
interface ToolTimerState {
	startedAt?: number;
	interval?: ReturnType<typeof setInterval>;
}

/** diff 行与变化片段的底色，随主题明暗切换。 */
interface DiffPalette {
	removed: Color;
	removedHighlight: Color;
	added: Color;
	addedHighlight: Color;
}

/** 深色主题：深底 + 亮字。 */
const DARK_DIFF_PALETTE: DiffPalette = {
	removed: { kind: "rgb", r: 60, g: 25, b: 25 },
	removedHighlight: { kind: "rgb", r: 120, g: 45, b: 45 },
	added: { kind: "rgb", r: 20, g: 45, b: 60 },
	addedHighlight: { kind: "rgb", r: 45, g: 90, b: 120 },
};

/** 浅色主题：浅底 + 主题自带的深色前景。 */
const LIGHT_DIFF_PALETTE: DiffPalette = {
	removed: { kind: "rgb", r: 255, g: 235, b: 235 },
	removedHighlight: { kind: "rgb", r: 255, g: 205, b: 205 },
	added: { kind: "rgb", r: 232, g: 243, b: 250 },
	addedHighlight: { kind: "rgb", r: 200, g: 225, b: 245 },
};
/** 变化片段超过行内容的该比例时放弃词级高亮，避免整行发亮。 */
const MAX_INLINE_CHANGE_RATIO = 0.7;
/** 参与词级比对的字符数上限，超过则退化为公共前后缀定位。 */
const MAX_INLINE_CHARS = 300;

// ============================================================================
// 工具函数
// ============================================================================

function shortenPath(path: string): string {
	const home = homedir();
	if (home && path.startsWith(home)) {
		return `~${path.slice(home.length)}`;
	}
	return path;
}

/** 把多行命令压成单行并截断，避免占满屏幕。 */
function oneLine(text: string, max = MAX_COMMAND_CHARS): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function baseName(path: string): string {
	const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
	const index = normalized.lastIndexOf("/");
	return index === -1 ? normalized || "." : normalized.slice(index + 1) || "/";
}

function formatDuration(ms: number | undefined): string {
	if (ms === undefined) return "";
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
	const block = result.content.find((c) => c.type === "text");
	return block?.text ?? "";
}

function countLines(text: string): number {
	return text.trim().split("\n").filter(Boolean).length;
}

/** 结果末尾的 `[...]` 提示行（达到上限、被截断等）不是数据行，统计时剔除。 */
const TRAILING_NOTICE = /\n\n\[[^\]\n]*\]\s*$/;

/** 统计结果数据行数，忽略工具附加的尾部提示。 */
function countEntries(text: string): number {
	return countLines(text.replace(TRAILING_NOTICE, ""));
}

/** 把连续空行压成一个，避免展开区域出现大片留白。 */
function collapseBlankLines(lines: string[]): string[] {
	const result: string[] = [];
	for (const line of lines) {
		const blank = line.trim() === "";
		if (blank && result.length > 0 && result[result.length - 1].trim() === "") continue;
		result.push(line);
	}
	while (result.length > 0 && result[0].trim() === "") result.shift();
	while (result.length > 0 && result[result.length - 1].trim() === "") result.pop();
	return result;
}

/** 统计 diff 的增删行数：Pi 的 diff 以 `+` / `-` 作为行首标记。 */
function diffStats(diff: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}

/** 英文单复数：`1 line` / `3 lines`。 */
function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** 去掉结尾的空行，避免预览出现无意义的空白行。 */
function trimTrailingEmpty(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1] === "") end--;
	return lines.slice(0, end);
}

/** diff 正文的一行：行级底色由 kind 决定，changed 为词级变化区间。 */
interface DiffLine {
	kind: "add" | "remove" | "context";
	/** 行首标记与行号，如 `-16 `；上下文行为空。 */
	prefix: string;
	content: string;
	/** 基于 content 的变化区间，仅单行配对修改时有值。 */
	changed?: Array<[number, number]>;
}

/** 拆出行首标记与行号，格式同 Pi 的 diff：`-16 内容`。 */
function parseDiffLine(line: string): DiffLine {
	const match = /^([+-])(\s*\d*)\s(.*)$/.exec(line);
	if (!match) {
		return { kind: "context", prefix: "", content: line };
	}
	return {
		kind: match[1] === "+" ? "add" : "remove",
		prefix: line.slice(0, line.length - match[3].length),
		content: match[3],
	};
}

interface Token {
	text: string;
	start: number;
	end: number;
}

/** 逐字符切分（按码点），字符级比对对齐最精确；中文与标点同为单元。 */
function tokenize(text: string): Token[] {
	const tokens: Token[] = [];
	let start = 0;
	for (const char of text) {
		tokens.push({ text: char, start, end: start + char.length });
		start += char.length;
	}
	return tokens;
}

/** 合并相邻的未匹配 token，得到字符偏移区间。 */
function mergedRanges(tokens: Token[], matched: boolean[]): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	let start: number | undefined;
	for (let i = 0; i < tokens.length; i++) {
		if (!matched[i]) {
			start ??= tokens[i].start;
			continue;
		}
		if (start !== undefined) {
			ranges.push([start, tokens[i].start]);
			start = undefined;
		}
	}
	if (start !== undefined) ranges.push([start, tokens[tokens.length - 1].end]);
	return ranges;
}

/** 两段 token 序列的最长公共子序列，返回各自被匹配到的下标。 */
function lcsMatches(
	oldTokens: Token[],
	newTokens: Token[],
): { oldMatched: boolean[]; newMatched: boolean[] } {
	const rows = oldTokens.length;
	const cols = newTokens.length;
	const dp: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(cols + 1).fill(0));
	for (let i = rows - 1; i >= 0; i--) {
		for (let j = cols - 1; j >= 0; j--) {
			dp[i][j] =
				oldTokens[i].text === newTokens[j].text
					? dp[i + 1][j + 1] + 1
					: Math.max(dp[i + 1][j], dp[i][j + 1]);
		}
	}
	const oldMatched = new Array<boolean>(rows).fill(false);
	const newMatched = new Array<boolean>(cols).fill(false);
	let i = 0;
	let j = 0;
	while (i < rows && j < cols) {
		if (oldTokens[i].text === newTokens[j].text) {
			oldMatched[i++] = true;
			newMatched[j++] = true;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) {
			i++;
		} else {
			j++;
		}
	}
	return { oldMatched, newMatched };
}

/** 用公共前缀/后缀定位变化中段，用于 token 过多时的降级。 */
function edgeRanges(oldText: string, newText: string): { removed: Array<[number, number]>; added: Array<[number, number]> } {
	let prefix = 0;
	while (prefix < oldText.length && prefix < newText.length && oldText[prefix] === newText[prefix]) {
		prefix++;
	}
	let suffix = 0;
	while (
		suffix < oldText.length - prefix &&
		suffix < newText.length - prefix &&
		oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
	) {
		suffix++;
	}
	const removed: [number, number] = [prefix, oldText.length - suffix];
	const added: [number, number] = [prefix, newText.length - suffix];
	return { removed: [removed], added: [added] };
}

/** 定位两行真正变化的字符区间，变化过大时返回 undefined。 */
function changedRanges(
	oldText: string,
	newText: string,
): { removed: Array<[number, number]>; added: Array<[number, number]> } | undefined {
	const oldTokens = tokenize(oldText);
	const newTokens = tokenize(newText);
	let ranges: { removed: Array<[number, number]>; added: Array<[number, number]> };
	if (oldTokens.length > MAX_INLINE_CHARS || newTokens.length > MAX_INLINE_CHARS) {
		ranges = edgeRanges(oldText, newText);
	} else {
		const { oldMatched, newMatched } = lcsMatches(oldTokens, newTokens);
		ranges = { removed: mergedRanges(oldTokens, oldMatched), added: mergedRanges(newTokens, newMatched) };
	}
	const changedLength = Math.max(
		ranges.removed.reduce((sum, [start, end]) => sum + (end - start), 0),
		ranges.added.reduce((sum, [start, end]) => sum + (end - start), 0),
	);
	if (changedLength === 0) return undefined;
	const longest = Math.max(oldText.length, newText.length);
	if (longest === 0 || changedLength > longest * MAX_INLINE_CHANGE_RATIO) return undefined;
	return ranges;
}

/** 解析 diff 文本，并为「单行删除 + 单行新增」配对算出词级变化区间。 */
function buildDiffLines(lines: string[]): DiffLine[] {
	const parsed = lines.map(parseDiffLine);
	const result: DiffLine[] = [];
	let index = 0;
	while (index < parsed.length) {
		if (parsed[index].kind !== "remove") {
			result.push(parsed[index]);
			index++;
			continue;
		}
		const removed: DiffLine[] = [];
		while (index < parsed.length && parsed[index].kind === "remove") removed.push(parsed[index++]);
		const added: DiffLine[] = [];
		while (index < parsed.length && parsed[index].kind === "add") added.push(parsed[index++]);
		const ranges =
			removed.length === 1 && added.length === 1
				? changedRanges(removed[0].content, added[0].content)
				: undefined;
		if (ranges) {
			result.push({ ...removed[0], changed: ranges.removed });
			result.push({ ...added[0], changed: ranges.added });
			continue;
		}
		result.push(...removed, ...added);
	}
	return result;
}

/** diff 正文：整行铺满宽度的行级底色，变化片段再叠一层更亮的底色。 */
class DiffLines implements Component {
	constructor(
		private readonly lines: DiffLine[],
		private readonly theme: RenderTheme,
	) {}

	render(width: number): string[] {
		return this.lines.map((line) => this.renderLine(line, width));
	}

	invalidate(): void {}

	private renderLine(line: DiffLine, width: number): string {
		const theme = this.theme;
		const text = line.prefix + line.content;
		const padding = " ".repeat(Math.max(0, width - visibleWidth(text)));
		if (line.kind === "context") {
			return theme.fg("toolDiffContext", text + padding);
		}
		const fg = line.kind === "add" ? "toolDiffAdded" : "toolDiffRemoved";
		const palette = theme.appearance === "light" ? LIGHT_DIFF_PALETTE : DARK_DIFF_PALETTE;
		const bg = line.kind === "add" ? palette.added : palette.removed;
		const highlightBg = line.kind === "add" ? palette.addedHighlight : palette.removedHighlight;
		if (!line.changed) {
			return theme.style(text + padding, { fg, bg });
		}
		const parts: string[] = [];
		if (line.prefix) parts.push(theme.style(line.prefix, { fg, bg }));
		let cursor = 0;
		for (const [start, end] of line.changed) {
			const before = line.content.slice(cursor, start);
			if (before) parts.push(theme.style(before, { fg, bg }));
			if (end > start) parts.push(theme.style(line.content.slice(start, end), { fg, bg: highlightBg }));
			cursor = end;
		}
		const tail = line.content.slice(cursor) + padding;
		if (tail) parts.push(theme.style(tail, { fg, bg }));
		return parts.join("");
	}
}

/** 标题行：工具名 + 路径。 */
function titleLine(theme: RenderTheme, name: string, path: string): string {
	return `${theme.fg("toolTitle", theme.bold(name))} ${theme.fg("accent", path || "...")}`;
}

/** 统计行：`  └ Added 2 lines, removed 1 line`。 */
function statLine(theme: RenderTheme, text: string): Text {
	return new Text(theme.fg("muted", `  └ ${text}`), 0, 0);
}

/** 截断提示行。 */
function moreLinesLine(theme: RenderTheme, remaining: number): Text {
	return new Text(
		theme.fg("muted", `... (${remaining} more lines, ctrl+o to expand)`),
		0,
		0,
	);
}

/** 摘要行：描述 + 耗时，前缀与图标等宽的空白。 */
function summaryLine(
	context: RenderContext,
	theme: RenderTheme,
	description: string,
): Text {
	const ok = !context.isError;
	const duration = formatDuration(context.durationMs);
	const tail = duration ? theme.fg("muted", ` (${duration})`) : "";
	const body = ok
		? theme.fg("toolOutput", description)
		: theme.fg("error", description);
	const prefix = ok ? " " : `${theme.fg("error", "✗")} `;
	return new Text(`${prefix}${body}${tail}`, context.outputPad, 0);
}

/** 运行中占位，前缀与思考块标签对齐；有起点时附带已用时间。 */
function runningLine(theme: RenderTheme, label: string, pad: number, elapsed: string): Text {
	const suffix = elapsed ? ` (${elapsed})` : "";
	return new Text(theme.fg("muted", ` ${label} · running${suffix}`), pad, 0);
}

/** 执行开始时记下计时起点，只记录一次。 */
function startTimer(context: RenderContext): void {
	const state = context.state as ToolTimerState | undefined;
	if (!state) return;
	if (context.executionStarted && state.startedAt === undefined) {
		state.startedAt = Date.now();
	}
}

/**
 * 同步计时状态并返回运行中已用时间。
 * 运行中按秒触发重绘，结束时停止计时，避免后台残留 interval。
 */
function syncTimer(context: RenderContext, isPartial: boolean): string {
	const state = context.state as ToolTimerState | undefined;
	if (!state) return "";
	if (!isPartial) {
		if (state.interval !== undefined) {
			clearInterval(state.interval);
			state.interval = undefined;
		}
		return "";
	}
	startTimer(context);
	if (state.startedAt !== undefined && state.interval === undefined) {
		state.interval = setInterval(() => context.invalidate(), TIMER_REFRESH_MS);
	}
	return state.startedAt === undefined ? "" : formatDuration(Date.now() - state.startedAt);
}

/**
 * 展开态内容：命令与输出包在同一块背景区域内，无图标。
 */
function blockBox(theme: RenderTheme, pad: number): Box {
	return new Box(Math.max(pad, 1), 0, (text) => theme.bg("toolPendingBg", text));
}

function expandedBlock(
	header: string | undefined,
	body: string,
	theme: RenderTheme,
	isError: boolean,
	pad: number,
): Box {
	const box = blockBox(theme, pad);
	if (header) {
		box.addChild(new Text(theme.fg("toolTitle", header), 0, 0));
	}
	const lines = collapseBlankLines(body.split("\n"));
	if (lines.length > 0) {
		const style = isError
			? (line: string) => theme.fg("error", line)
			: (line: string) => theme.fg("toolOutput", line);
		box.addChild(new Text(lines.map(style).join("\n"), 0, 0));
	}
	return box;
}

/**
 * 调用行：仅在执行中与出错时显示，成功结束且收起时由摘要行代替。
 * 每次渲染调用行都会经过这里，因此顺带记录计时起点。
 */
function prepareCall(context: RenderContext): boolean {
	startTimer(context);
	if (context.isPartial || !context.executionStarted) return true;
	return context.isError;
}

/**
 * 文本类工具（bash / read / grep / find / ls）的结果渲染策略。
 *
 * 收起：摘要行，前缀为空白。
 * 展开或出错：带背景的整块区域。
 */
function renderResultText(
	result: { content: Array<{ type: string; text?: string }> },
	options: ToolRenderResultOptions,
	theme: RenderTheme,
	context: RenderContext,
	describe: (output: string) => string,
	runningLabel: string,
	callHeader: string,
): Text | Box {
	const output = firstText(result);

	if (options.isPartial) {
		return runningLine(theme, runningLabel, context.outputPad, syncTimer(context, true));
	}
	syncTimer(context, false);
	if (context.isError) {
		// 出错时 renderCall 已保留命令行，这里不再重复。
		return expandedBlock(undefined, output, theme, true, context.outputPad);
	}
	if (options.expanded) {
		return expandedBlock(callHeader, output, theme, false, context.outputPad);
	}
	return summaryLine(context, theme, describe(output));
}

/**
 * edit 结果渲染：标题 + 增删统计 + diff 正文。
 * diff 已在 Pi 的工具结果中算好，这里只负责配色与截断。
 */
function renderEditResult(
	result: { content: Array<{ type: string; text?: string }>; details?: { diff?: string } },
	options: ToolRenderResultOptions,
	theme: RenderTheme,
	context: RenderContext,
): Text | Box {
	if (options.isPartial) {
		return runningLine(theme, "edit", context.outputPad, syncTimer(context, true));
	}
	syncTimer(context, false);
	if (context.isError) {
		return expandedBlock(undefined, firstText(result), theme, true, context.outputPad);
	}

	const path = shortenPath(typeof context.args?.path === "string" ? context.args.path : "");
	const diff = result.details?.diff ?? "";
	const box = blockBox(theme, context.outputPad);
	box.addChild(new Text(titleLine(theme, "edit", path), 0, 0));

	if (diff.trim() === "") {
		box.addChild(statLine(theme, "No changes"));
		return box;
	}

	const stats = diffStats(diff);
	box.addChild(
		statLine(theme, `Added ${plural(stats.added, "line")}, removed ${plural(stats.removed, "line")}`),
	);

	const lines = trimTrailingEmpty(diff.split("\n"));
	const limit = options.expanded ? lines.length : EDIT_DIFF_MAX_LINES;
	const shown = lines.slice(0, limit);
	box.addChild(new DiffLines(buildDiffLines(shown), theme));
	if (shown.length < lines.length) {
		box.addChild(moreLinesLine(theme, lines.length - shown.length));
	}
	return box;
}

/**
 * write 结果渲染：标题 + 写入行数 + 内容预览。
 * write 无 diff 详情，行数与预览均从 args.content 推导。
 */
function renderWriteResult(
	result: { content: Array<{ type: string; text?: string }> },
	options: ToolRenderResultOptions,
	theme: RenderTheme,
	context: RenderContext,
): Text | Box {
	if (options.isPartial) {
		return runningLine(theme, "write", context.outputPad, syncTimer(context, true));
	}
	syncTimer(context, false);
	if (context.isError) {
		return expandedBlock(undefined, firstText(result), theme, true, context.outputPad);
	}

	const path = shortenPath(typeof context.args?.path === "string" ? context.args.path : "");
	const content = typeof context.args?.content === "string" ? context.args.content : "";
	const lines = trimTrailingEmpty(content.split("\n"));

	const box = blockBox(theme, context.outputPad);
	box.addChild(new Text(titleLine(theme, "write", path), 0, 0));
	box.addChild(statLine(theme, `Wrote ${plural(lines.length, "line")}`));

	const limit = options.expanded ? lines.length : WRITE_PREVIEW_MAX_LINES;
	const shown = lines.slice(0, limit).map((content): DiffLine => ({ kind: "add", prefix: "+ ", content }));
	if (shown.length > 0) {
		box.addChild(new DiffLines(shown, theme));
	}
	if (shown.length < lines.length) {
		box.addChild(moreLinesLine(theme, lines.length - shown.length));
	}
	return box;
}

// ============================================================================
// 表外工具的通用折叠
// ============================================================================

/** 调用摘要：取第一个非空字符串参数，退化为 JSON 单行。 */
function argsSummary(args: unknown): string {
	if (args && typeof args === "object") {
		for (const value of Object.values(args as Record<string, unknown>)) {
			if (typeof value === "string" && value.trim() !== "") return oneLine(value, 40);
		}
		const json = JSON.stringify(args);
		if (json && json !== "{}") return oneLine(json, 40);
	}
	return "";
}

/** 结果含非文本片段（如图片）时，交回 Pi 内置渲染，避免折叠丢内容。 */
function hasRichContent(result: { content: Array<{ type: string }> }): boolean {
	return result.content.some((part) => part.type !== "text");
}

/**
 * 表外工具的兜底渲染：与内置工具同一套两阶段策略。
 * 新增工具无需改动本扩展即可获得折叠显示。
 */
function genericRenderers(toolName: string, base: ToolRenderers | undefined): ToolRenderers {
	return {
		renderShell: "self",
		renderCall(args, theme, context) {
			if (!prepareCall(context)) {
				return new Text("", context.outputPad, 0);
			}
			const title = theme.fg("toolTitle", theme.bold(toolName));
			const summary = argsSummary(args);
			const detail = summary ? ` ${theme.fg("accent", summary)}` : "";
			return new Text(`${title}${detail}`, context.outputPad, 0);
		},
		renderResult(result, options, theme, context) {
			if (base?.renderResult && hasRichContent(result)) {
				return base.renderResult(result, options, theme, context);
			}
			const summary = argsSummary(context.args);
			return renderResultText(
				result,
				options,
				theme,
				context,
				(output) => `${toolName} · ${plural(countEntries(output), "line")}`,
				toolName,
				summary ? `${toolName} ${summary}` : toolName,
			);
		},
	};
}

// ============================================================================
// 定制渲染表
// ============================================================================

// 只覆盖渲染槽：执行仍走 Pi 内置定义，shellPath 与 PI_* 变量照常生效。
const CUSTOM_RENDERERS: Record<string, ToolRenderers> = {
	// ---------------------------------------------------------------- bash
	bash: {
		renderShell: "self",
		renderCall(args, theme, context) {
			const command = typeof args?.command === "string" ? args.command : "";
			if (!prepareCall(context)) {
				return new Text("", context.outputPad, 0);
			}
			const line = oneLine(command) || "...";
			const title = context.isError
				? theme.fg("muted", `$ ${line}`)
				: theme.fg("toolTitle", theme.bold(`$ ${line}`));
			return new Text(title, context.outputPad, 0);
		},
		renderResult(result, options, theme, context) {
			return renderResultText(
				result,
				options,
				theme,
				context,
				() => "shell",
				"shell",
				`$ ${oneLine(typeof context.args?.command === "string" ? context.args.command : "") || "..."}`,
			);
		},
	},

	// ---------------------------------------------------------------- read
	read: {
		renderShell: "self",
		renderCall(args, theme, context) {
			if (!prepareCall(context)) {
				return new Text("", context.outputPad, 0);
			}
			const path = shortenPath(typeof args?.path === "string" ? args.path : "");
			const range = formatReadLineRange(args?.offset, args?.limit);
			const suffix = range ? theme.fg("warning", range) : "";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("read"))} ${theme.fg("accent", path || "...")}${suffix}`,
				context.outputPad,
				0,
			);
		},
		renderResult(result, options, theme, context) {
			return renderResultText(
				result,
				options,
				theme,
				context,
				(output) => `read ${plural(countLines(output), "line")}`,
				"read",
				`read ${shortenPath(typeof context.args?.path === "string" ? context.args.path : "")}${formatReadLineRange(context.args?.offset, context.args?.limit) ?? ""}`,
			);
		},
	},

	// ---------------------------------------------------------------- write
	write: {
		renderShell: "self",
		renderCall(args, theme, context) {
			if (!prepareCall(context)) {
				return new Text("", context.outputPad, 0);
			}
			const path = shortenPath(typeof args?.path === "string" ? args.path : "");
			return new Text(
				`${theme.fg("toolTitle", theme.bold("write"))} ${theme.fg("accent", path || "...")}`,
				context.outputPad,
				0,
			);
		},
		renderResult(result, options, theme, context) {
			return renderWriteResult(result, options, theme, context);
		},
	},

	// ---------------------------------------------------------------- edit
	edit: {
		renderShell: "self",
		renderCall(args, theme, context) {
			if (!prepareCall(context)) {
				return new Text("", context.outputPad, 0);
			}
			const path = shortenPath(typeof args?.path === "string" ? args.path : "");
			return new Text(
				`${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", path || "...")}`,
				context.outputPad,
				0,
			);
		},
		renderResult(result, options, theme, context) {
			return renderEditResult(result, options, theme, context);
		},
	},

	// ---------------------------------------------------------------- grep
	grep: {
		renderShell: "self",
		renderCall(args, theme, context) {
			if (!prepareCall(context)) {
				return new Text("", context.outputPad, 0);
			}
			const pattern = typeof args?.pattern === "string" ? args.pattern : "";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("grep"))} ${theme.fg("accent", `/${oneLine(pattern, 40)}/`)}`,
				context.outputPad,
				0,
			);
		},
		renderResult(result, options, theme, context) {
			return renderResultText(
				result,
				options,
				theme,
				context,
				(output) => `grep ${plural(countEntries(output), "match", "matches")}`,
				"grep",
				`grep /${oneLine(typeof context.args?.pattern === "string" ? context.args.pattern : "", 40)}/`,
			);
		},
	},

	// ---------------------------------------------------------------- find
	find: {
		renderShell: "self",
		renderCall(args, theme, context) {
			if (!prepareCall(context)) {
				return new Text("", context.outputPad, 0);
			}
			const pattern = typeof args?.pattern === "string" ? args.pattern : "";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("find"))} ${theme.fg("accent", oneLine(pattern, 40))}`,
				context.outputPad,
				0,
			);
		},
		renderResult(result, options, theme, context) {
			return renderResultText(
				result,
				options,
				theme,
				context,
				(output) => `found ${plural(countEntries(output), "file")}`,
				"find",
				`find ${oneLine(typeof context.args?.pattern === "string" ? context.args.pattern : "", 40)}`,
			);
		},
	},

	// ---------------------------------------------------------------- ls
	ls: {
		renderShell: "self",
		renderCall(args, theme, context) {
			if (!prepareCall(context)) {
				return new Text("", context.outputPad, 0);
			}
			const path = shortenPath(typeof args?.path === "string" ? args.path : ".");
			return new Text(
				`${theme.fg("toolTitle", theme.bold("ls"))} ${theme.fg("accent", path || ".")}`,
				context.outputPad,
				0,
			);
		},
		renderResult(result, options, theme, context) {
			const path = shortenPath(typeof context.args?.path === "string" ? context.args.path : ".");
			return renderResultText(
				result,
				options,
				theme,
				context,
				(output) => `ls ${path} · ${plural(countEntries(output), "entry", "entries")}`,
				"ls",
				`ls ${path}`,
			);
		},
	},
};

// ============================================================================
// 扩展入口
// ============================================================================

export default function (pi: ExtensionAPI) {
	// 思考块标签前补一个空格，与工具块的缩进对齐。
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setHiddenThinkingLabel(" Thinking...");
	});

	// 表内工具用定制渲染；表外工具自动套用同一套两阶段折叠。
	pi.registerToolRenderer((toolName, next) => {
		const custom = CUSTOM_RENDERERS[toolName];
		return custom ?? genericRenderers(toolName, next());
	});
}
