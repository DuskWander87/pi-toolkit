/**
 * user-message-prefix
 *
 * `›` 视觉标记：
 * - 用户消息首行前加 `› `，其余行缩进对齐，便于区分用户输入与模型输出
 * - 输入框首行以 `› ` 起头，多行输入在等宽空白后对齐
 *
 * Pi 未暴露普通用户消息的渲染钩子（`registerMessageRenderer` 只处理 custom 消息），
 * 这里接管导出的 `UserMessageComponent.render`：在 Markdown 渲染完成后插入前缀，
 * 因此不改变 Markdown 解析、消息内容与会话数据。
 * 输入框通过 `ctx.ui.setEditorComponent` 提供的 `CustomEditor` 子类实现，
 * 前缀占用左侧内边距，不改变文本换行宽度以外的任何编辑行为。
 */

import {
	CustomEditor,
	UserMessageComponent,
	getSelectListTheme,
	type CustomEditorOptions,
	type ExtensionAPI,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

const PREFIX = "› ";
const PATCHED = Symbol.for("pi-toolkit.user-message-prefix");

interface PatchedPrototype {
	render(width: number): string[];
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
	if (prototype[PATCHED]) return;
	prototype[PATCHED] = true;

	const render = prototype.render;
	prototype.render = function (width: number): string[] {
		const lines = render.call(this, width).map((line) => line.replace(BACKGROUND_SEQUENCE, ""));
		return prefixFirstContentLine(lines, getSelectListTheme().description(PREFIX));
	};
}

/** 输入框左侧留白宽度，与 `› ` 等宽。 */
const GUTTER = visibleWidth(PREFIX);

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
	installUserMessagePrefix();
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setEditorComponent((tui, theme, keybindings) => new PromptPrefixEditor(tui, theme, keybindings));
	});
}
