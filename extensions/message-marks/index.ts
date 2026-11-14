/**
 * message-marks
 *
 * Claude Code 式左侧标记栏（2 列）：
 * - 用户消息首行前加 `› `，其余行缩进对齐，便于区分用户输入与模型输出
 * - 助手消息首个文本块首行前加 `● `，其余行（含思考块）对齐到第 2 列
 * - 工具调用首行前加 `● `（进行中灰、成功蓝、失败红），整块对齐到第 2 列
 * - 输入框首行以 `› ` 起头，多行输入在等宽空白后对齐
 *
 * Pi 未暴露普通消息的渲染钩子（`registerMessageRenderer` 只处理 custom 消息），
 * 这里接管导出的组件 `render`：在渲染完成后插入标记，
 * 因此不改变 Markdown 解析、消息内容与会话数据。
 * 输入框通过 `ctx.ui.setEditorComponent` 提供的 `CustomEditor` 子类实现，
 * 前缀占用左侧内边距，不改变文本换行宽度以外的任何编辑行为。
 */

import {
	AssistantMessageComponent,
	CustomEditor,
	ToolExecutionComponent,
	UserMessageComponent,
	getSelectListTheme,
	type CustomEditorOptions,
	type ExtensionAPI,
	type KeybindingsManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	MouseRegion,
	stripTerminalSequences,
	visibleWidth,
	type Color,
	type EditorTheme,
	type TUI,
} from "@earendil-works/pi-tui";

const PREFIX = "› ";
/** 助手与工具行首的圆点。 */
const MARKER = "●";
/** 标记栏宽度：圆点占第 1 列，第 2 列为空格。 */
const GUTTER = 2;
/** 成功工具的圆点颜色：主题没有蓝色令牌，取固定蓝。 */
export const SUCCESS_MARKER_COLOR: Color = { kind: "rgb", r: 86, g: 156, b: 214 };
const PATCHED_USER = Symbol.for("pi-toolkit.message-marks.user");
const PATCHED_ASSISTANT = Symbol.for("pi-toolkit.message-marks.assistant");
const PATCHED_TOOL = Symbol.for("pi-toolkit.message-marks.tool");
/** `session_start` 取得的主题代理：切换主题后仍然跟随。 */
let activeTheme: Theme | undefined;

interface PatchedPrototype {
	render(width: number): string[];
}

/** `AssistantMessageComponent` 中渲染时用到的内部结构。 */
interface AssistantInternals extends PatchedPrototype {
	contentContainer?: {
		mouseLayout?: { width: number; children: Array<{ component: unknown; height: number }> };
	};
	markdownSlots?: Array<{ kind: string; markdown: unknown }>;
}

/** `ToolExecutionComponent` 中判断状态用到的字段。 */
interface ToolInternals extends PatchedPrototype {
	isPartial?: boolean;
	result?: { isError?: boolean };
}

/** OSC（`ESC ] ... BEL/ST`）与 CSI（`ESC [ ... final`）序列，用于跳过行首控制码。 */
const OSC_SEQUENCE = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/;
const CSI_SEQUENCE = /^\x1b\[[0-9;:?<=>]*[ -/]*[@-~]/;
/** 行尾控制码，调整宽度时需保留在末尾。 */
const TRAILING_SEQUENCE = /(?:\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;:?<=>]*[ -/]*[@-~])+$/;
/** 背景色 SGR（`40`–`47`、`100`–`107`、`48;…`）与其复位 `49`。 */
const BACKGROUND_SEQUENCE = /\x1b\[(?:4[0-7]|10[0-7]|48;[0-9;]*|49)m/g;

/** 行首控制码的长度，第一个可见字符从此处开始。 */
function leadingSequenceLength(text: string): number {
	let index = 0;
	while (index < text.length) {
		const rest = text.slice(index);
		const match = OSC_SEQUENCE.exec(rest) ?? CSI_SEQUENCE.exec(rest);
		if (!match) break;
		index += match[0].length;
	}
	return index;
}

/** 从可见内容末尾移除指定数量的空格，保留行尾控制码。 */
function trimTrailingSpaces(line: string, count: number): string {
	const match = TRAILING_SEQUENCE.exec(line);
	const suffix = match?.[0] ?? "";
	let body = match ? line.slice(0, match.index) : line;
	let remaining = count;
	while (remaining > 0 && body.endsWith(" ")) {
		body = body.slice(0, -1);
		remaining--;
	}
	return body + suffix;
}

/** 在行首控制码之后插入空格，并从行尾回收等量空格，保持整行宽度不变。 */
function indentLine(line: string, count: number): string {
	const start = leadingSequenceLength(line);
	return trimTrailingSpaces(line.slice(0, start) + " ".repeat(count) + line.slice(start), count);
}

/** 该行是否只有空白内容（含 Markdown 的空行填充）。 */
function isBlankLine(line: string): boolean {
	return stripTerminalSequences(line).trim() === "";
}

/** 终端图片行（Kitty / iTerm2 协议）：自带单元格定位，不参与缩进。 */
const IMAGE_LINE = /\x1b\][^\x07\x1b]*1337;|\x1b_G/;

/** 行首可见内容之前有多少个空格。 */
function leadingSpaces(line: string): number {
	const start = leadingSequenceLength(line);
	let spaces = 0;
	while (line[start + spaces] === " ") spaces++;
	return spaces;
}

/**
 * 行首内容不足 `GUTTER` 列时补齐，并从行尾回收等量空格，整行宽度不变。
 * 已缩进更深的行（代码块、续行）保持原样。
 */
export function gutterLine(line: string): string {
	if (isBlankLine(line) || IMAGE_LINE.test(line)) return line;
	const missing = GUTTER - leadingSpaces(line);
	if (missing <= 0) return line;
	const start = leadingSequenceLength(line);
	return trimTrailingSpaces(line.slice(0, start) + " ".repeat(missing) + line.slice(start), missing);
}

/** 用标记替换行首的两格留白，行宽不变。 */
function markLine(line: string, marker: string): string {
	const start = leadingSequenceLength(line);
	const drop = Math.min(leadingSpaces(line), GUTTER);
	const marked = line.slice(0, start) + marker + " ".repeat(GUTTER - 1) + line.slice(start + drop);
	const overflow = visibleWidth(marked) - visibleWidth(line);
	return overflow > 0 ? trimTrailingSpaces(marked, overflow) : marked;
}

/**
 * 在首个非空可见行的行首插入前缀，其后各行缩进等量空格，使所有内容从同一列开始。
 * 前缀替换 Markdown 的左侧内边距，并从行尾等量回收空格，保持整行宽度不变。
 */
export function prefixFirstContentLine(lines: string[], prefix: string): string[] {
	const index = lines.findIndex((line) => stripTerminalSequences(line).trim() !== "");
	if (index === -1) return lines;

	const line = lines[index];
	const start = leadingSequenceLength(line);
	const padding = line[start] === " " ? 1 : 0;
	const prefixed = line.slice(0, start) + prefix + line.slice(start + padding);
	const overflow = visibleWidth(prefixed) - visibleWidth(line);

	const result = [...lines];
	result[index] = trimTrailingSpaces(prefixed, overflow);
	for (let i = index + 1; overflow > 0 && i < result.length; i++) {
		result[i] = indentLine(result[i], overflow);
	}
	return result;
}

/** 接管 UserMessageComponent 的渲染：去掉背景色后加前缀，重复加载不会叠加。 */
export function installUserMessagePrefix(component: typeof UserMessageComponent = UserMessageComponent): void {
	const prototype = component.prototype as unknown as PatchedPrototype & Record<PropertyKey, unknown>;
	if (prototype[PATCHED_USER]) return;
	prototype[PATCHED_USER] = true;

	const render = prototype.render;
	prototype.render = function (width: number): string[] {
		const lines = render.call(this, width).map((line) => line.replace(BACKGROUND_SEQUENCE, ""));
		return prefixFirstContentLine(lines, getSelectListTheme().description(PREFIX));
	};
}

/** 助手文本块的圆点，与 `›` 同色。 */
function assistantMarker(): string {
	return getSelectListTheme().description(MARKER);
}

/** 工具行首圆点，颜色随执行状态：进行中灰、失败红、成功蓝。 */
function toolMarker(component: ToolInternals): string {
	if (component.isPartial) return getSelectListTheme().description(MARKER);
	if (component.result?.isError) return activeTheme?.fg("error", MARKER) ?? MARKER;
	return activeTheme ? activeTheme.style(MARKER, { fg: SUCCESS_MARKER_COLOR }) : MARKER;
}

/**
 * 首个文本块第一行的行号。
 *
 * `Container.render` 会把子组件高度写进 `contentContainer.mouseLayout`，
 * 再按 `markdownSlots` 的 kind 认出文本块；思考块与错误提示不算，因此圆点
 * 不会落在 `Thinking...` 上。
 */
function firstTextRow(component: AssistantInternals, lines: string[]): number {
	const layout = component.contentContainer?.mouseLayout;
	const slots = component.markdownSlots;
	if (!layout || !slots) return -1;
	let row = 0;
	for (const child of layout.children) {
		const inner = child.component instanceof MouseRegion ? child.component.child : child.component;
		const slot = slots.find((entry) => entry.markdown === inner);
		if (slot?.kind === "text") {
			const end = Math.min(row + child.height, lines.length);
			for (let i = row; i < end; i++) {
				if (!isBlankLine(lines[i]!)) return i;
			}
			return -1;
		}
		row += child.height;
	}
	return -1;
}

/** 接管 AssistantMessageComponent 的渲染：整条消息对齐到标记栏，首个文本块行首加圆点。 */
export function installAssistantMarks(component: typeof AssistantMessageComponent = AssistantMessageComponent): void {
	const prototype = component.prototype as unknown as AssistantInternals & Record<PropertyKey, unknown>;
	if (prototype[PATCHED_ASSISTANT]) return;
	prototype[PATCHED_ASSISTANT] = true;

	const render = prototype.render;
	prototype.render = function (this: AssistantInternals, width: number): string[] {
		const lines = render.call(this, width);
		for (let i = 0; i < lines.length; i++) lines[i] = gutterLine(lines[i]!);
		const row = firstTextRow(this, lines);
		if (row !== -1) lines[row] = markLine(lines[row]!, assistantMarker());
		return lines;
	};
}

/** 接管 ToolExecutionComponent 的渲染：整块对齐到标记栏，首行加状态圆点。 */
export function installToolMarks(component: typeof ToolExecutionComponent = ToolExecutionComponent): void {
	const prototype = component.prototype as unknown as ToolInternals & Record<PropertyKey, unknown>;
	if (prototype[PATCHED_TOOL]) return;
	prototype[PATCHED_TOOL] = true;

	const render = prototype.render;
	prototype.render = function (this: ToolInternals, width: number): string[] {
		const lines = render.call(this, width);
		for (let i = 0; i < lines.length; i++) lines[i] = gutterLine(lines[i]!);
		const row = lines.findIndex((line) => !isBlankLine(line) && !IMAGE_LINE.test(line));
		if (row !== -1) lines[row] = markLine(lines[row]!, toolMarker(this));
		return lines;
	};
}

/** 一次安装用户消息、助手消息与工具调用三处标记。 */
export function installMessageMarks(): void {
	installUserMessagePrefix();
	installAssistantMarks();
	installToolMarks();
}

/**
 * 首行以 `› ` 起头的输入框。
 *
 * 前缀占用左侧内边距而不是叠加在文本上：换行宽度、鼠标定位、光标位置都按
 * 加宽后的内边距计算，文本在所有行上从同一列开始。
 */
export class PromptPrefixEditor extends CustomEditor {
	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options?: CustomEditorOptions) {
		super(tui, theme, keybindings, { ...options, embedWorkingStatus: true });
	}

	/** 对外仍是调用方设置的宽度；内部保留 `› ` 的左侧留白。 */
	getPaddingX(): number {
		return Math.max(0, super.getPaddingX() - GUTTER);
	}

	setPaddingX(padding: number): void {
		super.setPaddingX(padding + GUTTER);
	}

	render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length < 3) return lines;
		// 窄终端下内边距会被压缩，前缀放不下时保持原样。
		const padding = Math.min(super.getPaddingX(), Math.max(0, Math.floor((width - 1) / 2)));
		if (padding < GUTTER) return lines;
		// 索引 0 是上边框，首行内容固定在其后。
		const first = lines[1]!;
		if (first.startsWith(" ".repeat(GUTTER))) {
			lines[1] = getSelectListTheme().description(PREFIX) + first.slice(GUTTER);
		}
		return lines;
	}
}

export default function (pi: ExtensionAPI) {
	installMessageMarks();
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		// 主题代理跨主题切换有效，工具圆点的红/蓝由它取当前主题色。
		activeTheme = ctx.ui.theme;
		ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => new PromptPrefixEditor(tui, editorTheme, keybindings));
	});
}
