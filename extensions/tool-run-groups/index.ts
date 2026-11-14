/**
 * tool-run-groups
 *
 * 把同一轮助手回复里的连续工具调用收成一行摘要（Claude Code 风格）：
 * - 收起：`Thought for 2s, ran 3 shell commands`
 * - 展开（Ctrl+O 或点击摘要行）：摘要行 + 每个调用各自的完整内容
 * - 执行中：`Running 3 shell commands…`，有失败时摘要行转红并标注数量
 * `edit` / `write` 不参与聚合，始终逐条展示。
 *
 * Pi 没有消息级的渲染钩子（`registerMessageRenderer` 只处理 custom 消息），
 * 因此这里接管 `InteractiveMode` 的两个私有方法：`message_end` 之后，以及历史
 * 回放结束后，把相邻的工具行移入同一个折叠组件。工具执行、结果回填与会话数据
 * 都不受影响——被移入组件的仍是 Pi 自己创建并持续更新的 `ToolExecutionComponent`。
 */

import {
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

/**
 * 一行摘要 + 折叠内的原始工具行。
 *
 * 收起时只渲染摘要；展开时摘要行之后直接铺开所有工具行的完整内容。
 * 摘要内容每次渲染时重新读取子组件状态，因此执行中/失败/主题切换都会即时反映。
 */
export class ToolRunGroup extends Container {
	private readonly toolNames: readonly string[];
	private readonly thoughtMs: number | undefined;
	private readonly themeSource: () => Theme | undefined;
	private readonly requestRender: () => void;
	private expandedState: boolean;

	constructor(options: ToolRunGroupOptions) {
		super();
		this.toolNames = options.toolNames;
		this.thoughtMs = options.thoughtMs;
		this.themeSource = options.theme;
		this.requestRender = options.requestRender;
		this.expandedState = options.expanded;
		for (const row of options.rows) this.addChild(row);
	}

	get expanded(): boolean {
		return this.expandedState;
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
		const rows = this.rows();
		const running = rows.some((row) => row.isPartial);
		const failed = rows.filter((row) => row.result?.isError).length;
		let text = running
			? `Running ${summarize(this.toolNames)}…`
			: describeRun(this.toolNames, this.thoughtMs);
		if (failed > 0) text += ` · ${failed} failed`;
		const theme = this.themeSource();
		const styled = theme ? theme.fg(failed > 0 ? "error" : "dim", text) : text;
		return truncateToWidth(" ".repeat(GUTTER) + styled, width);
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
		const belongsToMessage =
			ids !== undefined &&
			run.length === ids.size &&
			run.every((item) => ids.has(String(item.toolCallId)));
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

	groupToolRuns(mode, { ids, thoughtMs });
	mode.ui?.requestRender?.();
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
