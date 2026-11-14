/**
 * tool-run-groups
 *
 * 两级聚合，把工具调用收成摘要行（Claude Code 风格）。
 *
 * 第一级——单轮工具行 `ToolRunGroup`：同一轮助手回复里的连续工具行收成一行，
 * `edit` / `write` 不参与，单条调用保持原样。
 *
 * 第二级——请求摘要 `ToolRunSummary`：两条带可见文本的回复之间（或用户消息与首条
 * 回复之间）的工具调用只留一行摘要，耗时按轮累加。带可见文本的回复本身不进折叠、
 * 照常显示；被中断或报错的轮次同样是硬边界。`edit` / `write` 行参与区间，但摘要行
 * 不统计它们，收起时仍逐条渲染——改动永远看得到。
 *
 * 收起：`Thought for 28s, ran 8 shell commands`；执行中 `Running 3 shell commands…`。
 * 有失败时只把计数片段标红（`· 1 failed`），摘要正文保持 dim——一两个调用失败
 * 不代表整段都失敗。展开（Ctrl+O 或点击摘要行）显示每个调用各自的完整内容。
 *
 * Pi 没有消息级的渲染钩子（`registerMessageRenderer` 只处理 custom 消息），
 * 因此这里接管 `InteractiveMode` 的两个私有方法：`message_end` 之后，以及历史
 * 回放结束后，把相邻的工具行移入折叠组件。工具执行、结果回填与会话数据都不受
 * 影响——被移入组件的仍是 Pi 自己创建并持续更新的 `ToolExecutionComponent`。
 */

import {
	AssistantMessageComponent,
	InteractiveMode,
	ToolExecutionComponent,
	type ExtensionAPI,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	truncateToWidth,
	type Component,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

const PATCHED = Symbol.for("pi-toolkit.tool-run-groups");
/** 摘要行缩进量，与 message-marks 的标记栏同宽，使正文从同一列开始。 */
const GUTTER = 2;
/** 改动类工具必须逐条可见。 */
const SOLO_TOOLS = new Set(["edit", "write"]);
/** 单条调用保持原样：命令行比「ran 1 shell command」更有用。 */
const MIN_RUN = 2;
/** 内置工具名到展示名的映射，与 minimal-tools 保持一致。 */
const TOOL_LABELS: Record<string, string> = { bash: "shell" };

/** `session_start` 取得的主题代理：切换主题后仍然跟随。 */
let activeTheme: Theme | undefined;

/** 工具行暴露的内部状态，只读取。 */
interface ToolRow extends Component {
	toolName?: string;
	toolCallId?: string;
	isPartial?: boolean;
	result?: { isError?: boolean };
	setExpanded?(expanded: boolean): void;
}

/** `AssistantMessageComponent` 中判断「这一轮有没有可见文本」用到的内部结构。 */
interface AssistantInternals extends Component {
	markdownSlots?: Array<{ kind: string }>;
	lastMessage?: { stopReason?: string };
}

/** 聚合所需的最小 `InteractiveMode` 内部结构。 */
interface GroupableMode {
	chatContainer?: Container;
	toolOutputExpanded?: boolean;
	ui?: { requestRender?: () => void };
	handleEvent?: (event: unknown) => Promise<void>;
	renderSessionItems?: (...args: unknown[]) => unknown;
}

export interface ToolRunGroupOptions {
	rows: ToolRow[];
	toolNames: readonly string[];
	thoughtMs?: number;
	expanded: boolean;
	theme: () => Theme | undefined;
	requestRender: () => void;
}

/** 把工具名序列汇总成 `2 shell commands, 1 read call`。 */
export function summarize(toolNames: readonly string[]): string {
	const order: string[] = [];
	const counts = new Map<string, number>();
	for (const name of toolNames) {
		const label = TOOL_LABELS[name] ?? name;
		if (!counts.has(label)) order.push(label);
		counts.set(label, (counts.get(label) ?? 0) + 1);
	}
	return order
		.map((label) => {
			const count = counts.get(label)!;
			const plural = count > 1 ? "s" : "";
			return label === "shell"
				? `${count} shell command${plural}`
				: `${count} ${label} call${plural}`;
		})
		.join(", ");
}

/** 是否值得聚合：至少两个调用，且不含 `edit` / `write`。 */
export function isGroupable(toolNames: readonly string[]): boolean {
	return toolNames.length >= MIN_RUN && toolNames.every((name) => !SOLO_TOOLS.has(name));
}

/** 收起态的完整摘要：`Thought for 2s, ran 3 shell commands`。 */
export function describeRun(toolNames: readonly string[], thoughtMs?: number): string {
	const thought =
		thoughtMs === undefined ? "" : `Thought for ${Math.max(1, Math.round(thoughtMs / 1000))}s, `;
	return `${thought}ran ${summarize(toolNames)}`;
}

function isToolRow(value: unknown): value is ToolRow {
	return typeof ToolExecutionComponent === "function" && value instanceof ToolExecutionComponent;
}

/** 每条助手消息的思考耗时，在 `message_end` 时记录，多轮摘要从这里累加。 */
const thoughtByMessage = new WeakMap<Component, number>();

/** 读取一条助手消息的思考耗时，测试可注入替身。 */
export type ThoughtSource = (assistant: Component) => number | undefined;

const thoughtFromMessage: ThoughtSource = (assistant) => thoughtByMessage.get(assistant);

/**
 * 该助手消息是否是一个「静默轮次」：没有任何可见文本，只思考并调工具。
 *
 * 中断、报错与截断的轮次自带提示文本，不能折叠。内部结构不可用时同样返回
 * `false` —— 退化到不合并，比错误地藏起内容安全。
 */
export function isSilentTurn(value: unknown): boolean {
	if (!(value instanceof AssistantMessageComponent)) return false;
	const internals = value as AssistantInternals;
	if (!Array.isArray(internals.markdownSlots)) return false;
	if (internals.markdownSlots.some((slot) => slot.kind === "text")) return false;
	const stopReason = internals.lastMessage?.stopReason;
	return stopReason !== "error" && stopReason !== "aborted" && stopReason !== "length";
}

/**
 * 一行摘要 + 折叠内的原始工具行。
 *
 * 收起时只渲染摘要；展开时摘要行之后直接铺开所有工具行的完整内容。
 * 摘要内容每次渲染时重新读取子组件状态，因此执行中/失败/主题切换都会即时反映。
 */
export class ToolRunGroup extends Container {
	private readonly names: readonly string[];
	private readonly thoughtMs: number | undefined;
	private readonly themeSource: () => Theme | undefined;
	private readonly requestRender: () => void;
	private expandedState: boolean;

	constructor(options: ToolRunGroupOptions) {
		super();
		this.names = options.toolNames;
		this.thoughtMs = options.thoughtMs;
		this.themeSource = options.theme;
		this.requestRender = options.requestRender;
		this.expandedState = options.expanded;
		for (const row of options.rows) this.addChild(row);
	}

	get expanded(): boolean {
		return this.expandedState;
	}

	/** 组内工具名，按调用顺序，多轮摘要据此累加。 */
	get toolNames(): readonly string[] {
		return this.names;
	}

	/** 当前状态，每次调用重新读取子工具行。 */
	stats(): { running: boolean; failed: number } {
		const rows = this.rows();
		return {
			running: rows.some((row) => row.isPartial),
			failed: rows.filter((row) => row.result?.isError).length,
		};
	}

	setExpanded(expanded: boolean): void {
		this.expandedState = expanded;
		for (const row of this.rows()) row.setExpanded?.(expanded);
		this.invalidate();
	}

	/**
	 * 收起时是一行空行 + 摘要行，位置与被替换掉的首个工具行一致（工具行自带前导空行）。
	 * 展开时摘要行之后直接铺开子组件，子组件各自的前导空行提供间隔。
	 */
	render(width: number): string[] {
		const summary = this.summaryLine(width);
		return this.expandedState ? ["", summary, ...super.render(width)] : ["", summary];
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		// 收起时整块可点；展开时只有摘要行负责折叠，其余行交给工具行自己处理。
		if (
			event.type === "click" &&
			event.button === "left" &&
			(!this.expandedState || event.y === 1)
		) {
			this.setExpanded(!this.expandedState);
			this.requestRender();
			return { handled: true };
		}
		if (!this.expandedState) return undefined;
		return super.handleMouse({ ...event, y: event.y - 2, height: event.height - 2 });
	}

	private rows(): ToolRow[] {
		return this.children as ToolRow[];
	}

	private summaryLine(width: number): string {
		const { running, failed } = this.stats();
		const text = running
			? `Running ${summarize(this.names)}…`
			: describeRun(this.names, this.thoughtMs);
		return styledSummaryLine(text, failed, width, this.themeSource());
	}
}

/**
 * 把 `chatContainer` 里相邻的工具行合并成 `ToolRunGroup`。
 *
 * 幂等：已成组的部分不是 `ToolExecutionComponent`，再次调用不会重复包装。
 * `ids` 为刚结束那条助手消息的工具调用 id；全部命中时才把 `thoughtMs` 计入摘要，
 * 避免历史回放或跨消息合并时显示错误的思考耗时。
 */
export function groupToolRuns(
	mode: GroupableMode,
	options: { ids?: ReadonlySet<string>; thoughtMs?: number } = {},
): void {
	const container = mode.chatContainer;
	if (!container || !Array.isArray(container.children)) return;

	const children = container.children as unknown[];
	const next: Component[] = [];
	let grouped = false;
	// 同一条消息被拆成多段时，思考耗时只计在第一段，避免重复显示。
	let thoughtAssigned = false;

	for (let index = 0; index < children.length; index++) {
		const row = children[index];
		if (!isToolRow(row)) {
			next.push(row as Component);
			continue;
		}
		let end = index;
		while (end + 1 < children.length && isToolRow(children[end + 1])) end++;
		const run = children.slice(index, end + 1) as ToolRow[];
		index = end;

		const toolNames = run.map((item) => String(item.toolName));
		if (!isGroupable(toolNames)) {
			next.push(...run);
			continue;
		}

		const ids = options.ids;
		// 只要每个调用都属于这条消息就计入耗时：同一消息可能被非工具行切成多段。
		const belongsToMessage =
			!thoughtAssigned &&
			ids !== undefined &&
			run.every((item) => ids.has(String(item.toolCallId)));
		if (belongsToMessage) thoughtAssigned = true;
		next.push(
			new ToolRunGroup({
				rows: run,
				toolNames,
				thoughtMs: belongsToMessage ? options.thoughtMs : undefined,
				expanded: mode.toolOutputExpanded === true,
				theme: () => activeTheme,
				requestRender: () => mode.ui?.requestRender?.(),
			}),
		);
		grouped = true;
	}

	if (grouped) container.children = next;
}

export interface ToolRunSummaryOptions {
	/** 按发生顺序排列：助手消息、工具行/组交替出现。 */
	items: Component[];
	expanded: boolean;
	theme: () => Theme | undefined;
	requestRender: () => void;
	thoughtMsFor?: ThoughtSource;
	/** 区间前那条带文本的回复：它不进入折叠，但思考耗时算进摘要。 */
	extraThought?: Component;
}

/**
 * 一次请求里工具调用的摘要行 + 折叠内的时间线。
 *
 * 带可见文本的助手消息不进区间，照常显示在外面；区间内是静默助手消息与工具段。
 * `edit` / `write` 行参与区间但不被摘要行代表：摘要收起时它们仍逐条渲染。
 * 摘要内容每次渲染时从子组件重新累计，因此执行中/失败/主题切换都会即时反映；
 * 工具名与耗时随折叠区间增长而变化，不需要重建组件。
 */
export class ToolRunSummary extends Container {
	private readonly themeSource: () => Theme | undefined;
	private readonly requestRender: () => void;
	private readonly thoughtMsFor: ThoughtSource;
	private readonly extraThought: Component | undefined;
	private expandedState: boolean;

	constructor(options: ToolRunSummaryOptions) {
		super();
		this.themeSource = options.theme;
		this.requestRender = options.requestRender;
		this.thoughtMsFor = options.thoughtMsFor ?? thoughtFromMessage;
		this.extraThought = options.extraThought;
		this.expandedState = options.expanded;
		for (const item of options.items) this.addChild(item);
	}

	get expanded(): boolean {
		return this.expandedState;
	}

	setExpanded(expanded: boolean): void {
		this.expandedState = expanded;
		for (const child of this.children) {
			(child as { setExpanded?: (value: boolean) => void }).setExpanded?.(expanded);
		}
		this.invalidate();
	}

	render(width: number): string[] {
		const summary = this.summaryLine(width);
		if (this.expandedState) return ["", summary, ...super.render(width)];
		// 改动类工具行不靠摘要行代表，收起时也逐条渲染。
		const solo: string[] = [];
		for (const child of this.children) {
			if (isSoloRow(child)) solo.push(...child.render(width));
		}
		return ["", summary, ...solo];
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (
			event.type === "click" &&
			event.button === "left" &&
			(!this.expandedState || event.y === 1)
		) {
			this.setExpanded(!this.expandedState);
			this.requestRender();
			return { handled: true };
		}
		if (!this.expandedState) return undefined;
		return super.handleMouse({ ...event, y: event.y - 2, height: event.height - 2 });
	}

	private summaryLine(width: number): string {
		const names: string[] = [];
		let thoughtMs = 0;
		let running = false;
		let failed = 0;
		for (const child of this.children) {
			if (child instanceof ToolRunGroup) {
				names.push(...child.toolNames);
				const state = child.stats();
				running ||= state.running;
				failed += state.failed;
			} else if (isToolRow(child)) {
				// edit / write 自己逐条渲染，不重复计入摘要行。
				if (isSoloRow(child)) continue;
				names.push(String(child.toolName));
				if (child.isPartial) running = true;
				if (child.result?.isError) failed++;
			} else if (child instanceof AssistantMessageComponent) {
				thoughtMs += this.thoughtMsFor(child) ?? 0;
			}
		}
		if (this.extraThought) thoughtMs += this.thoughtMsFor(this.extraThought) ?? 0;
		const text = running
			? `Running ${summarize(names)}…`
			: describeRun(names, thoughtMs > 0 ? thoughtMs : undefined);
		return styledSummaryLine(text, failed, width, this.themeSource());
	}
}

/**
 * 摘要行：正文 dim，失败计数单独标红。
 *
 * 一段运行里只有个别调用失败时，整行变红会让人误以为整段失败；颜色只给计数片段。
 */
function styledSummaryLine(
	text: string,
	failed: number,
	width: number,
	theme: Theme | undefined,
): string {
	const note = failed > 0 ? ` · ${failed} failed` : "";
	const styled = theme ? theme.fg("dim", text) + theme.fg("error", note) : text + note;
	return truncateToWidth(" ".repeat(GUTTER) + styled, width);
}

interface Region {
	items: Component[];
	/** 该区间之后的下标。 */
	end: number;
}

/** 连续工具行与已成组的工具行都属于工具段。 */
function isToolSegment(value: unknown): boolean {
	return value instanceof ToolRunGroup || isToolRow(value);
}

/** `edit` / `write` 行始终逐条可见，即使夹在静默轮次里也把折叠区间截断。 */
function isSoloRow(value: unknown): boolean {
	return isToolRow(value) && SOLO_TOOLS.has(String(value.toolName));
}

/** 折叠区间里允许出现的项：任何工具段，以及没有可见文本的助手消息。 */
function isAbsorbable(value: unknown): boolean {
	return isToolSegment(value) || isSilentTurn(value);
}

/**
 * 区间内普通工具段的数量：不到两段时交给第一级，合并没有意义。
 *
 * `edit` / `write` 不算在内：它们始终逐条渲染，不需要靠摘要行代表。
 */
function countedSegments(items: readonly Component[]): number {
	let count = 0;
	for (const item of items) if (isToolSegment(item) && !isSoloRow(item)) count++;
	return count;
}

/**
 * 从 `index` 读一段可折叠区间：连续的工具段与静默助手消息。
 *
 * 带可见文本的助手消息、中断报错的轮次与其他组件都是硬边界。区间可以由工具段
 * 开头——请求开头那条带文本的回复留在区间外，它引发的工具调用仍并入同一个摘要，
 * 因此同一条回复与下一条回复之间只有一行摘要。
 */
function readRegion(children: readonly Component[], index: number): Region | undefined {
	if (!isAbsorbable(children[index])) return undefined;
	const items: Component[] = [];
	let cursor = index;
	while (cursor < children.length && isAbsorbable(children[cursor])) items.push(children[cursor++]!);
	if (countedSegments(items) < 2) return undefined;
	return { items, end: cursor };
}

function sameItems(left: readonly Component[], right: readonly Component[]): boolean {
	return left.length === right.length && left.every((item, index) => item === right[index]);
}

/**
 * 把 `chatContainer` 里可折叠的工具调用区间合并成 `ToolRunSummary`。
 *
 * 区间由连续的普通工具段与静默助手消息组成，可以由工具段开头：请求开头那条带文本
 * 的回复留在区间外，它引发的调用仍并入同一行，所以一个请求只留一行摘要。带可见文本
 * 的回复、`edit` / `write` 行、报错或中断的轮次都是硬边界。
 *
 * 已有的摘要会先拆回子组件再重新扫描，因此幂等；区间未变化时复用原实例，
 * 保留用户的折叠状态。
 */
export function groupSilentTurns(
	mode: GroupableMode,
	options: { thoughtMsFor?: ThoughtSource } = {},
): void {
	const container = mode.chatContainer;
	if (!container || !Array.isArray(container.children)) return;

	const flat: Component[] = [];
	const previous = new Map<Component, ToolRunSummary>();
	for (const child of container.children) {
		if (child instanceof ToolRunSummary) {
			for (const item of child.children) flat.push(item);
			const first = child.children[0];
			if (first) previous.set(first, child);
			continue;
		}
		flat.push(child);
	}

	const next: Component[] = [];
	for (let index = 0; index < flat.length; index++) {
		const region = readRegion(flat, index);
		if (!region) {
			next.push(flat[index]!);
			continue;
		}

		const items = region.items;
		const reused = previous.get(flat[index]!);
		if (reused && sameItems(reused.children, items)) {
			next.push(reused);
		} else {
			// 区间前那条带文本的回复留在外面，它的思考耗时仍计入这行摘要。
			const preceding = flat[index - 1];
			next.push(
				new ToolRunSummary({
					items,
					expanded: reused?.expanded ?? mode.toolOutputExpanded === true,
					theme: () => activeTheme,
					requestRender: () => mode.ui?.requestRender?.(),
					thoughtMsFor: options.thoughtMsFor,
					extraThought: preceding instanceof AssistantMessageComponent ? preceding : undefined,
				}),
			);
		}
		index = region.end - 1;
	}

	if (!sameItems(next, container.children)) container.children = next;
}

/** 累计当前流式消息里的思考字符数，用于判断思考是否仍在继续。 */
interface ThinkingClock {
	startedAt: number;
	lastThinkingAt: number;
	chars: number;
	sawThinking: boolean;
}

let clock: ThinkingClock | undefined;

function thinkingLength(message: { content?: Array<{ type?: string; thinking?: string }> }): number {
	let total = 0;
	for (const part of message.content ?? []) {
		if (part?.type === "thinking" && typeof part.thinking === "string") total += part.thinking.length;
	}
	return total;
}

function trackThinking(event: unknown): void {
	const { type, message } = event as {
		type?: string;
		message?: { role?: string; content?: Array<{ type?: string; thinking?: string }> };
	};
	if (message?.role !== "assistant") return;
	if (type === "message_start") {
		clock = { startedAt: Date.now(), lastThinkingAt: 0, chars: 0, sawThinking: false };
		return;
	}
	if (type !== "message_update" || !clock) return;
	const length = thinkingLength(message);
	if (length <= clock.chars) return;
	clock.chars = length;
	clock.lastThinkingAt = Date.now();
	clock.sawThinking = true;
}

function finishMessage(mode: GroupableMode, event: unknown): void {
	const { type, message } = event as {
		type?: string;
		message?: {
			role?: string;
			stopReason?: string;
			content?: Array<{ type?: string; id?: string }>;
		};
	};
	if (type !== "message_end" || message?.role !== "assistant") return;

	const thoughtMs = clock?.sawThinking ? clock.lastThinkingAt - clock.startedAt : undefined;
	clock = undefined;

	const ids = new Set<string>();
	for (const part of message.content ?? []) {
		if (part?.type === "toolCall" && typeof part.id === "string") ids.add(part.id);
	}
	// 失败或中断时保留逐条可见，便于判断是哪一次调用出的问题。
	if (ids.size === 0 || message.stopReason === "error" || message.stopReason === "aborted") return;

	const assistant = lastAssistantChild(mode);
	if (assistant && thoughtMs !== undefined) thoughtByMessage.set(assistant, thoughtMs);

	groupToolRuns(mode, { ids, thoughtMs });
	groupSilentTurns(mode);
	mode.ui?.requestRender?.();
}

/** 刚结束那条消息对应的助手组件：`message_end` 时它是容器里最后一个助手组件。 */
function lastAssistantChild(mode: GroupableMode): Component | undefined {
	const children = mode.chatContainer?.children;
	if (!Array.isArray(children)) return undefined;
	for (let index = children.length - 1; index >= 0; index--) {
		if (children[index] instanceof AssistantMessageComponent) return children[index];
	}
	return undefined;
}

/** 接管 `InteractiveMode` 的事件分发与历史回放，重复加载不会叠加。 */
export function installToolRunGroups(): boolean {
	const prototype = InteractiveMode.prototype as unknown as Record<PropertyKey, unknown> & GroupableMode;
	if (prototype[PATCHED]) return true;

	const handleEvent = prototype.handleEvent;
	const renderSessionItems = prototype.renderSessionItems;
	if (typeof handleEvent !== "function" || typeof renderSessionItems !== "function") return false;
	prototype[PATCHED] = true;

	prototype.handleEvent = async function (this: GroupableMode, event: unknown) {
		trackThinking(event);
		await handleEvent.call(this, event);
		finishMessage(this, event);
	};

	prototype.renderSessionItems = function (this: GroupableMode, ...args: unknown[]) {
		const result = renderSessionItems.apply(this, args);
		groupToolRuns(this);
		groupSilentTurns(this);
		this.ui?.requestRender?.();
		return result;
	};

	return true;
}

export default function (pi: ExtensionAPI) {
	const installed = installToolRunGroups();
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		activeTheme = ctx.ui.theme;
		if (!installed) {
			ctx.ui.notify(
				"tool-run-groups: InteractiveMode internals not found; tool calls stay ungrouped.",
				"error",
			);
		}
	});
}
