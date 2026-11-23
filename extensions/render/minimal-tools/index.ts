/**
 * minimal-tools
 *
 * 工具调用的显示：
 * - 执行中：只有调用行（`bash npm test`）
 * - 结束后：收成一行 `调用行 · 量化`；edit / write 直接展示改动内容
 *
 * 展开（Ctrl+O）或出错时显示完整内容。
 */

import type { ExtensionAPI, ToolRenderers, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { formatReadLineRange } from "@earendil-works/pi-coding-agent";
import {
	Box,
	stripTerminalSequences,
	type Color,
	type Component,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { homedir } from "node:os";

/** 从 `pi.registerTool` 的参数推断出的渲染函数类型。 */
type RenderArgs = Parameters<NonNullable<Parameters<ExtensionAPI["registerTool"]>[0]["renderCall"]>>;
type RenderTheme = RenderArgs[1];
type RenderContext = RenderArgs[2];
type RenderResultArgs = Parameters<NonNullable<ToolRenderers["renderResult"]>>;

const MAX_COMMAND_CHARS = 100;
/** 默认展示的 diff 行数上限，超出部分靠 Ctrl+O 展开。 */
const EDIT_DIFF_MAX_LINES = 30;
/** 默认展示的写入内容预览行数。 */
const WRITE_PREVIEW_MAX_LINES = 10;
/** 收起态单行折行的行数上限，避免超长单行把折叠区撑成上千行；展开后不设上限。 */
const WRAP_MAX_ROWS = 20;
/** 折行时留给内容的最小列宽，保证一个宽字符能完整落在行内。 */
const WRAP_MIN_CONTENT_WIDTH = 2;
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
	const normalized = path.replace(/\\/g, "/");
	const home = homedir().replace(/\\/g, "/").replace(/\/+$/, "");
	if (home && (normalized === home || normalized.startsWith(`${home}/`))) {
		return `~${normalized.slice(home.length)}`;
	}
	return path;
}

/** 把多行命令压成单行并截断，避免占满屏幕。 */
function oneLine(text: string, max = MAX_COMMAND_CHARS): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 读取工具参数中的字符串；缺失或类型不符时返回空串。 */
function stringArg(args: unknown, key: string): string {
	const value = (args as Record<string, unknown> | undefined)?.[key];
	return typeof value === "string" ? value : "";
}

/** 读取工具参数中的数字；缺失或类型不符时返回 undefined。 */
function numberArg(args: unknown, key: string): number | undefined {
	const value = (args as Record<string, unknown> | undefined)?.[key];
	return typeof value === "number" ? value : undefined;
}

/** 去掉终端控制序列与回车，统计与展示都基于清洗后的文本。 */
function cleanToolOutput(text: string): string {
	return stripTerminalSequences(text).replace(/\r/g, "");
}

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
	const block = result.content.find((c) => c.type === "text");
	return cleanToolOutput(block?.text ?? "");
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

/** read 的行数：含空行，只剔除尾部提示与末尾换行造成的空段。 */
function countReadLines(text: string): number {
	const body = text.replace(TRAILING_NOTICE, "");
	if (body === "") return 0;
	const lines = body.split("\n");
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines.length;
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
/** 解析一行 diff；行号栏拆成 prefix，正文单独存放，折行时续行才能与内容列对齐。 */
function parseDiffLine(line: string): DiffLine {
	const match = /^([+-])(\s*\d*)\s(.*)$/.exec(line);
	if (match) {
		return {
			kind: match[1] === "+" ? "add" : "remove",
			prefix: line.slice(0, line.length - match[3].length),
			content: match[3],
		};
	}
	// context 行以空格起头（如 ` 12 code`），同样拆出行号栏；无行号时保持整行作正文。
	const context = /^(\s+\d*)\s(.*)$/.exec(line);
	if (context) {
		return {
			kind: "context",
			prefix: line.slice(0, line.length - context[2].length),
			content: context[2],
		};
	}
	return { kind: "context", prefix: "", content: line };
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
	// 与 Pi 内置 diff 一致，tab 按 3 个空格展开，避免终端按 8 列渲染导致错位。
	const parsed = lines.map((line) => parseDiffLine(line.replace(/\t/g, "   ")));
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

/**
 * 按显示宽度切分内容，返回字符区间；宽字符不跨段。
 *
 * 优先在空白与中日韩字符处断行（代码与英文句子不被劈开）；一段里没有可断点时硬切。
 * 首段行首的缩进不当作断点，避免续行被顶到行首。
 * `maxSegments` 用尽即停，`truncated` 表示后面还有未切出的内容。
 */
function wrapSegments(
	content: string,
	width: number,
	maxSegments = Number.POSITIVE_INFINITY,
): { segments: Array<[number, number]>; truncated: boolean } {
	const segments: Array<[number, number]> = [];
	let start = 0;
	while (start < content.length) {
		if (segments.length >= maxSegments) return { segments, truncated: true };
		let used = 0;
		let cursor = start;
		let breakAt = -1;
		let sawText = false;
		for (const char of content.slice(start)) {
			const charWidth = visibleWidth(char);
			if (used + charWidth > width) break;
			used += charWidth;
			cursor += char.length;
			// 中日韩字符可在字符间断行；西文只在空白处断，避免劈开单词。
			if (/\s/.test(char) || charWidth >= 2) {
				if (sawText) breakAt = cursor;
			} else {
				sawText = true;
			}
		}
		if (cursor >= content.length) {
			segments.push([start, content.length]);
			break;
		}
		// 单个字符就超出宽度：独占一段，保证不丢字符也不死循环。
		if (cursor === start) cursor = start + (content.codePointAt(start)! > 0xffff ? 2 : 1);
		const end = breakAt > start ? breakAt : cursor;
		segments.push([start, end]);
		start = end;
	}
	return { segments: segments.length > 0 ? segments : [[0, 0]], truncated: false };
}

/** 把整行的词级变化区间裁到当前片段，并换算成片段内偏移。 */
function clipRanges(
	ranges: Array<[number, number]> | undefined,
	start: number,
	end: number,
): Array<[number, number]> {
	if (!ranges) return [];
	const clipped: Array<[number, number]> = [];
	for (const [from, to] of ranges) {
		const low = Math.max(from, start);
		const high = Math.min(to, end);
		if (high > low) clipped.push([low - start, high - start]);
	}
	return clipped;
}

/** diff 正文：整行铺满宽度的行级底色，变化片段再叠一层更亮的底色。 */
class DiffLines implements Component {
	/** 同宽度重复渲染时直接复用，避免每帧重跑颜色与换行。 */
	private cache?: { width: number; lines: string[] };

	constructor(
		private readonly lines: DiffLine[],
		private readonly theme: RenderTheme,
		/** 单行折行上限；undefined 表示不限（展开态）。 */
		private readonly maxWrapRows?: number,
	) {}

	render(width: number): readonly string[] {
		if (this.cache?.width === width) return this.cache.lines;
		const lines: string[] = [];
		for (const line of this.lines) lines.push(...this.renderLine(line, width));
		this.cache = { width, lines };
		return lines;
	}

	invalidate(): void {
		this.cache = undefined;
	}

	/** 超宽行按显示宽度折成多段：行号列只在首段，续行用等宽空白对齐。 */
	private renderLine(line: DiffLine, width: number): string[] {
		// 一列行号栏加一个宽字符都放不下时，退回收起前的一行截断，保证不越过 width。
		if (width <= 0) return [""];
		if (width < WRAP_MIN_CONTENT_WIDTH) return [truncateToWidth(line.prefix + line.content, width, "")];
		const prefixWidth = Math.min(visibleWidth(line.prefix), width - WRAP_MIN_CONTENT_WIDTH);
		const head = truncateToWidth(line.prefix, prefixWidth, "");
		const continuation = " ".repeat(prefixWidth);
		const contentWidth = width - prefixWidth;
		const { segments, truncated } = wrapSegments(line.content, contentWidth, this.maxWrapRows ?? Number.POSITIVE_INFINITY);
		return segments.map(([start, end], index) =>
			this.renderSegment(
				line,
				width,
				index === 0 ? head : continuation,
				start,
				end,
				truncated && index === segments.length - 1,
			),
		);
	}

	/** 一段 diff：底色铺满整行，片段内的变化区间再叠一层更亮的底色。 */
	private renderSegment(
		line: DiffLine,
		width: number,
		head: string,
		start: number,
		end: number,
		/** 折行被上限截断的末段：留一列收口省略号。 */
		ellipsis = false,
	): string {
		const theme = this.theme;
		const raw = line.content.slice(start, end);
		const text = ellipsis
			? `${truncateToWidth(raw, Math.max(0, width - visibleWidth(head) - 1), "")}…`
			: raw;
		const padding = " ".repeat(Math.max(0, width - visibleWidth(head) - visibleWidth(text)));
		if (line.kind === "context") {
			return theme.fg("toolDiffContext", head + text + padding);
		}
		const fg = line.kind === "add" ? "toolDiffAdded" : "toolDiffRemoved";
		const palette = theme.appearance === "light" ? LIGHT_DIFF_PALETTE : DARK_DIFF_PALETTE;
		const bg = line.kind === "add" ? palette.added : palette.removed;
		const highlightBg = line.kind === "add" ? palette.addedHighlight : palette.removedHighlight;
		const changed = clipRanges(line.changed, start, end);
		if (changed.length === 0) {
			return theme.style(head + text + padding, { fg, bg });
		}
		const parts: string[] = [];
		if (head) parts.push(theme.style(head, { fg, bg }));
		let cursor = 0;
		for (const [from, to] of changed) {
			if (from >= text.length) break;
			if (from > cursor) parts.push(theme.style(text.slice(cursor, from), { fg, bg }));
			parts.push(theme.style(text.slice(from, to), { fg, bg: highlightBg }));
			cursor = to;
		}
		const tail = text.slice(cursor) + padding;
		if (tail) parts.push(theme.style(tail, { fg, bg }));
		return parts.join("");
	}
}

/** 标题行：工具名 + 参数；工具名取注册名，不另起别名。 */
function toolHeader(theme: RenderTheme, name: string, detail: string, suffix = ""): string {
	const head = theme.fg("toolTitle", theme.bold(name));
	const body = detail ? ` ${theme.fg("accent", detail)}` : "";
	return `${head}${body}${suffix}`;
}

/** 收起态的那一行：`标题 · 量化`，没有量化时只留标题。 */
function summaryLine(theme: RenderTheme, header: string, extra: string, pad: number): Text {
	const tail = extra ? theme.fg("dim", ` · ${extra}`) : "";
	return new Text(`${header}${tail}`, pad, 0);
}

/** 块尾统计行：`+2 −1` / `12 lines`，用 dim 与正文区分。 */
function statLine(theme: RenderTheme, text: string): Text {
	return new Text(theme.fg("dim", text), 0, 0);
}

/** 截断提示行，展开快捷键跟随 Pi 的 keybinding 配置。 */
function moreLinesLine(theme: RenderTheme, remaining: number, context: RenderContext): Text {
	const hint = context.keyHint("app.tools.expand", "to expand");
	return new Text(theme.fg("muted", `... (${remaining} more lines, ${hint})`), 0, 0);
}

/**
 * 调用行是否显示：运行中、出错、展开时显示，成功收起后由结果行代替标题。
 *
 * 「参数已齐、还没开始执行」是实时流程的过渡帧（`message_end` 调用 `setArgsComplete`，
 * `tool_execution_start` 才 `markExecutionStarted`），此时调用行必须在。Pi 的历史回放路径
 * 两个标记都不设，`executionStarted` 与 `argsComplete` 同为 `false`；回放行已有结果，
 * 标题由结果行给出，不能再显示调用行。
 */
function callVisible(context: RenderContext): boolean {
	if (context.isPartial) return true;
	if (!context.executionStarted && context.argsComplete) return true;
	return context.isError || context.expanded === true;
}

/** 标题行文案：工具名 + 参数。`renderCall` 与收起态的摘要行共用。 */
function headerOf(name: string, args: unknown, theme: RenderTheme): string {
	switch (name) {
		case "bash":
			return toolHeader(theme, "bash", oneLine(stringArg(args, "command")) || "...");
		case "read": {
			const range = formatReadLineRange(numberArg(args, "offset"), numberArg(args, "limit"));
			return toolHeader(theme, "read", shortenPath(stringArg(args, "path")) || "...", range ? theme.fg("warning", range) : "");
		}
		case "grep":
			return toolHeader(theme, "grep", `/${oneLine(stringArg(args, "pattern"), 40)}/`);
		case "find":
			return toolHeader(theme, "find", oneLine(stringArg(args, "pattern"), 40));
		case "ls":
			return toolHeader(theme, "ls", shortenPath(stringArg(args, "path") || "."));
		case "write":
		case "edit":
			return toolHeader(theme, name, shortenPath(stringArg(args, "path")) || "...");
		default:
			return toolHeader(theme, name, argsSummary(args));
	}
}

/** 文本类工具的调用行：成功收起后让位给结果行。 */
function callLine(name: string, args: unknown, theme: RenderTheme, context: RenderContext): Text {
	if (!callVisible(context)) return new Text("", context.outputPad, 0);
	return new Text(headerOf(name, args, theme), context.outputPad, 0);
}

/**
 * 展开态内容：命令与输出包在同一块背景区域内，无图标。
 */
function blockBox(theme: RenderTheme, pad: number): Box {
	return new Box(pad, 0, (text) => theme.bg("toolPendingBg", text));
}

function expandedBlock(
	body: string,
	theme: RenderTheme,
	isError: boolean,
	pad: number,
): Box {
	const box = blockBox(theme, pad);
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
 * 文本类工具（bash / read / grep / find / ls）的结果渲染。
 *
 * 收起且成功：一行 `调用行 · 量化`，标题在这一行里补回（`renderCall` 已让位）。
 * 运行中：不占行——“还在跑”由调用行与 `run-clock` 的计时行表达。
 * 展开或出错：正文进背景块，调用行留在块外。
 */
function renderToolResult(
	result: { content: Array<{ type: string; text?: string }> },
	options: ToolRenderResultOptions,
	theme: RenderTheme,
	context: RenderContext,
	header: string,
	describe: (output: string) => string,
): Text | Box {
	const output = firstText(result);
	if (context.isError) return expandedBlock(output, theme, true, context.outputPad);
	if (options.expanded) return expandedBlock(output, theme, false, context.outputPad);
	if (options.isPartial) return new Text("", context.outputPad, 0);
	return summaryLine(theme, header, describe(output), context.outputPad);
}

/**
 * edit 结果渲染：diff 正文 + 块尾增删统计。
 * diff 已在 Pi 的工具结果中算好，这里只负责配色与换行。
 */
function renderEditResult(
	result: { content: Array<{ type: string; text?: string }>; details?: { diff?: string } },
	options: ToolRenderResultOptions,
	theme: RenderTheme,
	context: RenderContext,
): Text | Box {
	if (options.isPartial) return new Text("", context.outputPad, 0);
	if (context.isError) return expandedBlock(firstText(result), theme, true, context.outputPad);

	const diff = result.details?.diff ?? "";
	const box = blockBox(theme, context.outputPad);
	if (diff.trim() === "") {
		box.addChild(statLine(theme, "no changes"));
		return box;
	}

	const stats = diffStats(diff);
	const lines = trimTrailingEmpty(diff.split("\n"));
	const limit = options.expanded ? lines.length : EDIT_DIFF_MAX_LINES;
	const shown = lines.slice(0, limit);
	box.addChild(new DiffLines(buildDiffLines(shown), theme, options.expanded ? undefined : WRAP_MAX_ROWS));
	if (shown.length < lines.length) {
		box.addChild(moreLinesLine(theme, lines.length - shown.length, context));
	}
	box.addChild(statLine(theme, `+${stats.added} −${stats.removed}`));
	return box;
}

/**
 * write 结果渲染：写入内容预览 + 块尾行数。
 * write 无 diff 详情，行数与预览均从 args.content 推导。
 */
function renderWriteResult(
	result: { content: Array<{ type: string; text?: string }> },
	options: ToolRenderResultOptions,
	theme: RenderTheme,
	context: RenderContext,
): Text | Box {
	if (options.isPartial) return new Text("", context.outputPad, 0);
	if (context.isError) return expandedBlock(firstText(result), theme, true, context.outputPad);

	const lines = trimTrailingEmpty(stringArg(context.args, "content").split("\n"));
	const box = blockBox(theme, context.outputPad);
	const limit = options.expanded ? lines.length : WRITE_PREVIEW_MAX_LINES;
	const shown = lines.slice(0, limit).map((text): DiffLine => ({ kind: "add", prefix: "+ ", content: text }));
	if (shown.length > 0) {
		box.addChild(new DiffLines(shown, theme, options.expanded ? undefined : WRAP_MAX_ROWS));
	}
	if (shown.length < lines.length) {
		box.addChild(moreLinesLine(theme, lines.length - shown.length, context));
	}
	box.addChild(statLine(theme, plural(lines.length, "line")));
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

/**
 * 表外工具的兜底渲染：与内置工具同一套渲染策略。
 * 新增工具无需改动本扩展即可获得调用行、收起态摘要行与展开块。
 */
function genericRenderers(toolName: string): ToolRenderers {
	return {
		renderShell: "self",
		renderCall(args, theme, context) {
			return callLine(toolName, args, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderToolResult(result, options, theme, context, headerOf(toolName, context.args, theme), (output) =>
				plural(countEntries(output), "line"),
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
			return callLine("bash", args, theme, context);
		},
		renderResult(result, options, theme, context) {
			// bash 没有比命令本身更有用的量化字段，收起态只留调用行。
			return renderToolResult(result, options, theme, context, headerOf("bash", context.args, theme), () => "");
		},
	},

	// ---------------------------------------------------------------- read
	read: {
		renderShell: "self",
		renderCall(args, theme, context) {
			return callLine("read", args, theme, context);
		},
		renderResult(result, options, theme, context) {
			const hasImage = result.content.some((part) => part.type === "image");
			return renderToolResult(result, options, theme, context, headerOf("read", context.args, theme), (output) =>
				hasImage ? "image" : plural(countReadLines(output), "line"),
			);
		},
	},

	// ---------------------------------------------------------------- write
	write: {
		renderShell: "self",
		// 写入内容逐条可见，不受聚合影响：标题行始终留在块外。
		renderCall(args, theme, context) {
			return new Text(headerOf("write", args, theme), context.outputPad, 0);
		},
		renderResult(result, options, theme, context) {
			return renderWriteResult(result, options, theme, context);
		},
	},

	// ---------------------------------------------------------------- edit
	edit: {
		renderShell: "self",
		// 改动永远看得到：标题行始终留在 diff 块外。
		renderCall(args, theme, context) {
			return new Text(headerOf("edit", args, theme), context.outputPad, 0);
		},
		renderResult(result, options, theme, context) {
			return renderEditResult(result, options, theme, context);
		},
	},

	// ---------------------------------------------------------------- grep
	grep: {
		renderShell: "self",
		renderCall(args, theme, context) {
			return callLine("grep", args, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderToolResult(result, options, theme, context, headerOf("grep", context.args, theme), (output) =>
				plural(countEntries(output), "match", "matches"),
			);
		},
	},

	// ---------------------------------------------------------------- find
	find: {
		renderShell: "self",
		renderCall(args, theme, context) {
			return callLine("find", args, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderToolResult(result, options, theme, context, headerOf("find", context.args, theme), (output) =>
				plural(countEntries(output), "file"),
			);
		},
	},

	// ---------------------------------------------------------------- ls
	ls: {
		renderShell: "self",
		renderCall(args, theme, context) {
			return callLine("ls", args, theme, context);
		},
		renderResult(result, options, theme, context) {
			return renderToolResult(result, options, theme, context, headerOf("ls", context.args, theme), (output) =>
				plural(countEntries(output), "entry", "entries"),
			);
		},
	},
};

/**
 * 保留上游渲染器、只替换外层壳的工具名。
 *
 * Pi 给走默认壳的工具行套一个带 `toolPendingBg` / `toolSuccessBg` / `toolErrorBg`
 * 背景的 Box，收起态也是整块底色；本扩展其余工具都是行级无底色。这几个工具由
 * `npm:pi-web-access` 注册，自带 renderCall / renderResult（查询列表、进度条、来源
 * 分组），内容需要保留，因此不改写渲染器，只换成 self 壳并补回缩进。展开后的成功结果
 * 把上游调用行与结果装进同一块 `toolPendingBg` 区域，与本扩展其它工具的展开块一致。
 *
 * 换壳要求两个渲染槽都在：只保留一个槽的工具沿用上游外壳与排版（单槽路径下 Pi 的
 * fallback 行不带 `outputPad` 缩进，展开并块也补不回被隐藏的调用行）。
 *
 * 依赖上游工具名（`pi-web-access` 也允许通过 `toolNames` 配置改名）：上游改名后这里
 * 会静默失效——表现是这些工具行重新出现整块底色，渲染内容本身不受影响。排查时先
 * 核对该包实际注册的工具名。
 */
const UPSTREAM_RENDERER_TOOLS = new Set(["web_search", "fetch_content", "get_search_content"]);

/** self 壳不再设置 paddingX：只补缩进，不铺底色。 */
function withPad(component: Component, pad: number): Box {
	const box = new Box(pad, 0);
	box.addChild(component);
	return box;
}

/**
 * 搜索类工具展开且成功时：上游调用行并进结果块，避免与块内内容重复。
 * 运行中与出错时保留分开的两段，调用行仍由上游渲染。
 */
function mergesIntoResultBlock(expanded: boolean, isPartial: boolean, isError: boolean): boolean {
	return expanded && !isPartial && !isError;
}

// ============================================================================
// 扩展入口
// ============================================================================

export default function (pi: ExtensionAPI) {
	// 标记栏的缩进由 message-marks 统一处理，标签本身不再留前导空格。
	// pi 固定用 chalk.italic() 包裹该标签，而 chalk 会在 \x1b[23m 之后重开斜体；
	// 因此用 \x1b[0m 重置样式，再补回主题色，得到正体标签。
	// 主题色在会话启动时取值，切换主题后需 /reload 才会跟随。
	pi.on("session_start", async (_event, ctx) => {
		const thinkingFg = ctx.ui.theme.getFgAnsi("thinkingText");
		ctx.ui.setHiddenThinkingLabel(`\x1b[0m${thinkingFg}Thinking...`);
	});

	// 先看定制表；表外工具里，`UPSTREAM_RENDERER_TOOLS` 换壳沿用上游渲染，其余尊重
	// 上游：任一渲染槽存在时整体让位，两者都没有才折叠。
	pi.registerToolRenderer((toolName, next) => {
		const custom = CUSTOM_RENDERERS[toolName] as ToolRenderers | undefined;
		if (custom) return custom;
		const upstream = next();
		if (!upstream?.renderCall && !upstream?.renderResult) return genericRenderers(toolName);
		if (!UPSTREAM_RENDERER_TOOLS.has(toolName)) return upstream;
		const { renderCall, renderResult } = upstream;
		// 两个槽都在才换壳：self 壳要自己补缩进，缺槽时 Pi 的 fallback 行不带缩进；
		// 展开并块也依赖调用行槽把被隐藏的调用行补回结果块内。
		if (!renderCall || !renderResult) return upstream;
		return {
			...upstream,
			renderShell: "self",
			renderCall: (...args: RenderArgs) => {
				const context = args[2];
				// 调用行已并进结果块，这里不再重复渲染。
				if (mergesIntoResultBlock(context.expanded, context.isPartial, context.isError)) {
					return new Text("", context.outputPad, 0);
				}
				return withPad(renderCall(...args), context.outputPad);
			},
			renderResult: (...args: RenderResultArgs) => {
				const options = args[1];
				const theme = args[2];
				const context = args[3];
				// 展开且已结束才铺底色，与 `expandedBlock` 一致；收起态和运行中保持行级无底色。
				if (!options.expanded || options.isPartial) {
					return withPad(renderResult(...args), context.outputPad);
				}
				const box = blockBox(theme, context.outputPad);
				if (mergesIntoResultBlock(options.expanded, options.isPartial, context.isError)) {
					box.addChild(renderCall(context.args, theme, context));
				}
				box.addChild(renderResult(...args));
				return box;
			},
		};
	});
}
