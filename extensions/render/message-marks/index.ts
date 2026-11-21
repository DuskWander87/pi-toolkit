/**
 * message-marks
 *
 * Claude Code 式左侧标记栏（2 列）：
 * - 用户消息首行前加 `› `，其余行缩进对齐，便于区分用户输入与模型输出
 * - 助手消息首个文本块首行前加 `● `，其余行（含思考块）对齐到第 2 列
 * - 工具调用首行前加 `● `（进行中与成功蓝、失败红），整块对齐到第 2 列
 * - 技能调用与工具行同一套标记栏：去掉背景色，首行前加 `● `（蓝）
 * - 块与块之间统一留 1 行空行，不叠加 Pi 的 `Spacer(1)` 与组件自身的首尾留白
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
	BashExecutionComponent,
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	CustomEditor,
	CustomMessageComponent,
	SkillInvocationMessageComponent,
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
	truncateToWidth,
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
/** 原型上保存的原始 `render`：`/reload` 重新安装时新 wrapper 仍调用它，不叠加。 */
const ORIGINAL_USER = Symbol.for("pi-toolkit.message-marks.user.original");
const ORIGINAL_ASSISTANT = Symbol.for("pi-toolkit.message-marks.assistant.original");
const ORIGINAL_TOOL = Symbol.for("pi-toolkit.message-marks.tool.original");
/** 系统类组件只缩进、不加圆点；这些符号同时保存各自的原始 `render`。 */
const GUTTER_BASH = Symbol.for("pi-toolkit.message-marks.bash");
const GUTTER_COMPACTION = Symbol.for("pi-toolkit.message-marks.compaction");
const GUTTER_BRANCH = Symbol.for("pi-toolkit.message-marks.branch");
const GUTTER_CUSTOM = Symbol.for("pi-toolkit.message-marks.custom");
/** 技能调用按工具行渲染：去背景、首行加圆点，需要自己的原始 `render` 存档。 */
const ORIGINAL_SKILL = Symbol.for("pi-toolkit.message-marks.skill");
/** `session_start` 取得的主题代理：切换主题后仍然跟随。 */
let activeTheme: Theme | undefined;

interface PatchedPrototype {
	render(width: number): readonly string[];
}

/** `AssistantMessageComponent` 中渲染时用到的内部结构。 */
interface AssistantInternals extends PatchedPrototype {
	contentContainer?: {
		childLines?: { width: number; children: unknown[]; parts: string[][] };
	};
	markdownSlots?: Array<{ kind: string; markdown: unknown }>;
}

/** `ToolExecutionComponent` 中判断状态用到的字段。 */
interface ToolInternals extends PatchedPrototype {
	result?: { isError?: boolean };
}

/** OSC（`ESC ] ... BEL/ST`）与 CSI（`ESC [ ... final`）序列，用于跳过行首控制码。 */
const OSC_SEQUENCE = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/;
const CSI_SEQUENCE = /^\x1b\[[0-9;:?<=>]*[ -/]*[@-~]/;
/** 行尾控制码，调整宽度时需保留在末尾。 */
const TRAILING_SEQUENCE = /(?:\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;:?<=>]*[ -/]*[@-~])+$/;
/** 行内所有控制码（OSC / CSI），删除空行时用来把终端标记挂到相邻行。 */
const ANY_SEQUENCE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;:?<=>]*[ -/]*[@-~]/g;
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

/**
 * 收敛一个块的首尾空行。
 *
 * 块间距 = 上一块的尾随空行 + Pi 的 `Spacer(1)` + 本块的首行留白，两者叠加会出现
 * 2–3 行空隙。这里去掉尾随空行；`leadingBlanks` 是本块应保留的首行空行数：
 * 跟在 `Spacer(1)` 后面的块（用户消息、技能调用、压缩/分支摘要）为 0，其余为 1，
 * 于是相邻块的间距统一为 1 行。终端图片行及其占位空行属于图片自身的高度，
 * 不算块留白（见 `contentStart`）。
 */
export function normalizeBlockSpacing(lines: string[], leadingBlanks: 0 | 1): string[] {
	if (lines.length === 0) return lines;
	const firstContent = contentStart(lines);
	const lastContent = contentEnd(lines);
	// 整块都是空行，或首/尾挨着终端图片：没有可收敛的块留白，原样返回。
	if (firstContent < 0 || lastContent < 0) return lines;
	const start = Math.max(0, firstContent - leadingBlanks);
	const end = lastContent + 1;
	if (start === 0 && end === lines.length) return lines;
	const kept = lines.slice(start, end);
	if (start > 0) kept[0] = carrySequences(lines.slice(0, start)) + kept[0];
	if (end < lines.length) kept[kept.length - 1] = kept[kept.length - 1]! + carrySequences(lines.slice(end));
	return kept;
}

/**
 * 首个内容行的行号；整块都是空行、或空行后面紧接终端图片时返回 -1。
 *
 * 图片（Kitty / iTerm2 协议）的行里没有可见字符，`isBlankLine` 认不出来；
 * 它的序列行与相邻空行又是一个整体（序列行之后或之前的空行就是图片高度），
 * 删任何一行都会让图片压到相邻内容上，所以这一侧不收敛。
 */
function contentStart(lines: readonly string[]): number {
	for (let i = 0; i < lines.length; i++) {
		if (IMAGE_LINE.test(lines[i]!)) return -1;
		if (!isBlankLine(lines[i]!)) return i;
	}
	return -1;
}

/** 最后一个内容行的行号；规则同 `contentStart`，从尾部往前扫。 */
function contentEnd(lines: readonly string[]): number {
	for (let i = lines.length - 1; i >= 0; i--) {
		if (IMAGE_LINE.test(lines[i]!)) return -1;
		if (!isBlankLine(lines[i]!)) return i;
	}
	return -1;
}

/** 被删掉空行上的控制码（如 OSC 133 分区标记），保持原有顺序拼回相邻行。 */
function carrySequences(lines: readonly string[]): string {
	return lines.map((line) => line.match(ANY_SEQUENCE)?.join("") ?? "").join("");
}

interface TransformCache {
	key: string;
	source: readonly string[];
	result: string[];
}

/** 每个组件上一次的渲染结果：内容未变时省去逐行正则与宽度计算。 */
const transformCache = new WeakMap<object, TransformCache>();

/**
 * 按 `key` 与原始行内容缓存转换结果。
 *
 * 命中条件是宽度 / 标记等 `key` 相同，且底层 `render` 返回的行内容逐项引用不变。
 * 窗口 resize、主题或状态切换都会让 `key` 变化并自然 miss。
 */
function cachedTransform(
	component: object,
	lines: readonly string[],
	key: string,
	transform: (lines: readonly string[]) => string[],
): string[] {
	const cached = transformCache.get(component);
	if (cached && cached.key === key && cached.source.length === lines.length) {
		let same = true;
		for (let index = 0; index < lines.length; index++) {
			if (cached.source[index] !== lines[index]) {
				same = false;
				break;
			}
		}
		if (same) return cached.result;
	}
	const result = transform(lines);
	transformCache.set(component, { key, source: lines.slice(), result });
	return result;
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

/**
 * 接管 UserMessageComponent 的渲染：去掉背景色后加前缀。
 *
 * 原始方法只在首次安装时保存；重复安装（含同进程 `/reload`）用新 wrapper
 * 覆盖旧 wrapper，总是调用同一份原始实现，因此不会叠加。
 */
export function installUserMessagePrefix(component: typeof UserMessageComponent = UserMessageComponent): void {
	const prototype = component.prototype as unknown as PatchedPrototype & Record<PropertyKey, unknown>;
	const render = (prototype[ORIGINAL_USER] ??= prototype.render) as PatchedPrototype["render"];
	prototype.render = function (width: number): readonly string[] {
		const lines = render.call(this, width);
		const prefix = getSelectListTheme().description(PREFIX);
		return cachedTransform(this, lines, `${width}\0${prefix}`, (source) =>
			normalizeBlockSpacing(
				prefixFirstContentLine(
					source.map((line) => line.replace(BACKGROUND_SEQUENCE, "")),
					prefix,
				),
				0,
			),
		);
	};
}

/** 助手文本块的圆点，与 `›` 同色。 */
function assistantMarker(): string {
	return getSelectListTheme().description(MARKER);
}

/** 成功状态的圆点：主题没有蓝色令牌，取固定蓝。 */
function successMarker(): string {
	return activeTheme ? activeTheme.style(MARKER, { fg: SUCCESS_MARKER_COLOR }) : MARKER;
}

/** 工具行首圆点，颜色随执行状态：进行中与成功蓝，失败红。 */
function toolMarker(component: ToolInternals): string {
	if (component.result?.isError) return activeTheme?.fg("error", MARKER) ?? MARKER;
	return successMarker();
}

/**
 * 首个文本块第一行的行号。
 *
 * `Container.render` 会把每个子组件的行写进 `contentContainer.childLines`，
 * 再按 `markdownSlots` 的 kind 认出文本块；思考块与错误提示不算，因此圆点
 * 不会落在 `Thinking...` 上。
 */
function firstTextRow(component: AssistantInternals, lines: readonly string[]): number {
	const layout = component.contentContainer?.childLines;
	const slots = component.markdownSlots;
	if (!layout || !slots) return -1;
	let row = 0;
	for (let index = 0; index < layout.children.length; index++) {
		const child = layout.children[index];
		const inner = child instanceof MouseRegion ? (child as unknown as { child: unknown }).child : child;
		const height = layout.parts[index]?.length ?? 0;
		const slot = slots.find((entry) => entry.markdown === inner);
		if (slot?.kind === "text") {
			const end = Math.min(row + height, lines.length);
			for (let i = row; i < end; i++) {
				if (!isBlankLine(lines[i]!)) return i;
			}
			return -1;
		}
		row += height;
	}
	return -1;
}

/** 接管 AssistantMessageComponent 的渲染：整条消息对齐到标记栏，首个文本块行首加圆点。 */
export function installAssistantMarks(component: typeof AssistantMessageComponent = AssistantMessageComponent): void {
	const prototype = component.prototype as unknown as AssistantInternals & Record<PropertyKey, unknown>;
	const render = (prototype[ORIGINAL_ASSISTANT] ??= prototype.render) as PatchedPrototype["render"];
	prototype.render = function (this: AssistantInternals, width: number): readonly string[] {
		const lines = render.call(this, width);
		const marker = assistantMarker();
		const slots = this.markdownSlots?.length ?? -1;
		const rows = this.contentContainer?.childLines?.children.length ?? -1;
		const key = `${width}\0${marker}\0${slots}\0${rows}`;
		return cachedTransform(this, lines, key, (source) => {
			const guttered = source.map((line) => gutterLine(line));
			const row = firstTextRow(this, guttered);
			if (row !== -1) guttered[row] = markLine(guttered[row]!, marker);
			return normalizeBlockSpacing(guttered, 1);
		});
	};
}

interface MarkerGutterOptions {
	/** 保存原始 `render` 的键，同组件重复安装不会叠加。 */
	symbol: symbol;
	/** 首行圆点，可读取组件自身状态。 */
	marker: (component: PatchedPrototype) => string;
	/** 渲染前剥掉背景色（Box 自己铺满的背景）。 */
	stripBackground?: boolean;
	/** 本块保留的首行空行数，默认 1；跟在 Pi `Spacer(1)` 后面的块传 0。 */
	leadingBlanks?: 0 | 1;
}

/**
 * 接管组件的渲染：整块对齐到标记栏，首个内容行加圆点。
 *
 * 补缩进后仍超宽的行（满宽边框、自带留白的 Box）截回渲染宽度，
 * 否则 Pi 会因超宽行抛错。
 */
function installMarkerGutter(component: { prototype: object }, options: MarkerGutterOptions): void {
	const { symbol, marker: resolveMarker, stripBackground, leadingBlanks = 1 } = options;
	const prototype = component.prototype as PatchedPrototype & Record<PropertyKey, unknown>;
	const render = (prototype[symbol] ??= prototype.render) as PatchedPrototype["render"];
	prototype.render = function (this: PatchedPrototype, width: number): readonly string[] {
		const lines = render.call(this, width);
		const marker = resolveMarker(this);
		return cachedTransform(this, lines, `${width}\0${marker}`, (source) => {
			const guttered = source.map((line) => {
				const aligned = gutterLine(stripBackground ? line.replace(BACKGROUND_SEQUENCE, "") : line);
				return visibleWidth(aligned) > width ? truncateToWidth(aligned, width, "") : aligned;
			});
			const row = guttered.findIndex((line) => !isBlankLine(line) && !IMAGE_LINE.test(line));
			if (row !== -1) guttered[row] = markLine(guttered[row]!, marker);
			return normalizeBlockSpacing(guttered, leadingBlanks);
		});
	};
}

/** 接管 ToolExecutionComponent 的渲染：整块对齐到标记栏，首行加状态圆点。 */
export function installToolMarks(component: typeof ToolExecutionComponent = ToolExecutionComponent): void {
	installMarkerGutter(component, {
		symbol: ORIGINAL_TOOL,
		marker: (target) => toolMarker(target as unknown as ToolInternals),
	});
}

/**
 * 系统类组件只对齐左缘：整块补到第 2 列，不加圆点、不剥离背景色。
 *
 * 满宽行（如 bash 的上下边框）插入空格后会超出渲染宽度；从行尾回收不到空格时
 * 直接截回原宽度，否则 Pi 会因超宽行抛错。
 *
 * `leadingBlanks` 给 0 表示该组件紧跟在 Pi 的 `Spacer(1)` 后面（压缩/分支摘要）。
 */
export function installGutter(component: { prototype: object }, symbol: symbol, leadingBlanks: 0 | 1 = 1): void {
	const prototype = component.prototype as PatchedPrototype & Record<PropertyKey, unknown>;
	const render = (prototype[symbol] ??= prototype.render) as PatchedPrototype["render"];
	prototype.render = function (width: number): readonly string[] {
		const lines = render.call(this, width);
		return cachedTransform(this, lines, `${width}\0${String(symbol.description)}`, (source) =>
			normalizeBlockSpacing(
				source.map((line) => {
					const guttered = gutterLine(line);
					return visibleWidth(guttered) > width ? truncateToWidth(guttered, width, "") : guttered;
				}),
				leadingBlanks,
			),
		);
	};
}

/**
 * 接管 SkillInvocationMessageComponent 的渲染：去掉 Box 的背景色，
 * 与工具行一样对齐标记栏、首行加蓝色圆点。
 */
export function installSkillMark(
	component: typeof SkillInvocationMessageComponent = SkillInvocationMessageComponent,
): void {
	installMarkerGutter(component, {
		symbol: ORIGINAL_SKILL,
		marker: () => successMarker(),
		stripBackground: true,
		leadingBlanks: 0,
	});
}

/** 一次安装消息、工具与系统类组件的左缘对齐。 */
export function installMessageMarks(): void {
	installUserMessagePrefix();
	installAssistantMarks();
	installToolMarks();
	installSkillMark();
	installGutter(BashExecutionComponent, GUTTER_BASH);
	installGutter(CompactionSummaryMessageComponent, GUTTER_COMPACTION, 0);
	installGutter(BranchSummaryMessageComponent, GUTTER_BRANCH, 0);
	installGutter(CustomMessageComponent, GUTTER_CUSTOM);
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

	/** `Editor.render` 声明为可变数组，这里跟随父类签名；按 Component 约定（返回数组调用方不得修改）先复制再改。 */
	render(width: number): string[] {
		const source = super.render(width);
		if (source.length < 3) return source;
		// 窄终端下内边距会被压缩，前缀放不下时保持原样。
		const padding = Math.min(super.getPaddingX(), Math.max(0, Math.floor((width - 1) / 2)));
		if (padding < GUTTER) return source;
		// 索引 0 是上边框，首行内容固定在其后。
		const first = source[1]!;
		if (!first.startsWith(" ".repeat(GUTTER))) return source;
		// 先复制再改：父类的返回数组可能被它自己缓存，原地写会污染下一次渲染。
		const lines = [...source];
		lines[1] = getSelectListTheme().description(PREFIX) + first.slice(GUTTER);
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
