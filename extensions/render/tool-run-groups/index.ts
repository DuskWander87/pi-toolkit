/**
 * tool-run-groups
 *
 * 两级聚合，把工具调用收成摘要行（Claude Code 风格）。
 *
 * 第一级——单轮工具行 `ToolRunGroup`：同一轮助手回复里连续且都已结束的工具行收成
 * 一行，`edit` / `write` 不参与，单条调用留给区间摘要行。
 *
 * 第二级——区间摘要 `ToolRunSummary`：一段工具调用只留一行摘要，耗时按轮累加。
 * 带正文的回复是硬边界：正文先于摘要行渲染，它之后的思考与工具调用另起一行摘要，
 * 不并入上面那一行；被中断或报错的轮次同样是硬边界。`edit` / `write` 行参与区间，
 * 但摘要行不统计它们，收起时仍逐条渲染——改动永远看得到。
 *
 * 收起时思考正文不占行：摘要行已经统计过耗时，区间内的静默轮次与区间前那条带正文
 * 的回复都只留正文；展开后显示思考正文，Pi 的 `hideThinkingBlock` 为 `true` 时这些
 * 轮次不显示任何思考内容（耗时只在摘要行上）。
 *
 * 收起：`Thought for 28s, ran 8 shell commands`；执行中的工具行不折叠，留在摘要
 * 下方，保留命令行、流式输出与实时计时，`tool_execution_end` 后并入同一行。
 * 有失败时只把计数片段标红（`· 1 failed`），摘要正文保持 dim——一两个调用失败
 * 不代表整段都失败。展开（Ctrl+O 或点击摘要行）显示每个调用各自的完整内容。
 * 思考结束后，隐藏思考的标签从流式占位 `Thinking...` 换成 `Thought for Ns`。
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
} from "@earendil-works/pi-tui";

/** 与 `Container.handleMouse` 的返回类型保持一致（该类型未从包入口导出）。 */
type MouseDispatchResult = NonNullable<ReturnType<Container["handleMouse"]>>;

/** 原型上保存的原始方法：`/reload` 重新安装时新 wrapper 仍调用它，不叠加。 */
const ORIGINAL_HANDLE_EVENT = Symbol.for("pi-toolkit.tool-run-groups.handle-event");
const ORIGINAL_RENDER_SESSION_ITEMS = Symbol.for("pi-toolkit.tool-run-groups.render-session-items");
const ORIGINAL_UPDATE_THINKING = Symbol.for("pi-toolkit.tool-run-groups.update-thinking-visibility");
/** 摘要行缩进量，与 message-marks 的标记栏同宽，使正文从同一列开始。 */
const GUTTER = 2;
/** 改动类工具必须逐条可见。 */
const SOLO_TOOLS = new Set(["edit", "write"]);
/** 第一级至少两个连续工具行才收紧；单条调用由第二级摘要行折叠。 */
const MIN_RUN = 2;
/** 内置工具名到展示名的映射，与 minimal-tools 保持一致。 */
const TOOL_LABELS: Record<string, string> = { bash: "shell" };

/** `session_start` 取得的主题代理：切换主题后仍然跟随。 */
let activeTheme: Theme | undefined;

/** 工具行暴露的内部状态，只读取。 */
interface ToolRow extends Component {
	toolName?: string;
	isPartial?: boolean;
	result?: { isError?: boolean };
	setExpanded?(expanded: boolean): void;
}

/** `AssistantMessageComponent` 中判断「这一轮有没有可见文本」用到的内部结构。 */
interface AssistantInternals extends Component {
	markdownSlots?: Array<{ kind: string }>;
	lastMessage?: { stopReason?: string };
	hiddenThinkingLabel?: string;
	hideThinkingBlock?: boolean;
	setHiddenThinkingLabel?(label: string): void;
	setHideThinkingBlock?(hide: boolean): void;
}

/** 聚合所需的最小 `InteractiveMode` 内部结构。 */
interface GroupableMode {
	chatContainer?: Container;
	toolOutputExpanded?: boolean;
	ui?: { requestRender?: () => void };
	handleEvent?: (event: unknown) => Promise<void>;
	renderSessionItems?: (...args: unknown[]) => unknown;
	/** Pi 1.5.2 的该方法不接收参数，开关状态在 `hideThinkingBlock` 上。 */
	updateThinkingBlockVisibility?: () => void;
	hideThinkingBlock?: boolean;
}

export interface ToolRunGroupOptions {
	rows: ToolRow[];
	toolNames: readonly string[];
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

/** 是否值得聚合：至少两个调用，且不含 `edit` / `write`。执行状态由调用方判断。 */
export function isGroupable(toolNames: readonly string[]): boolean {
	return toolNames.length >= MIN_RUN && toolNames.every((name) => !SOLO_TOOLS.has(name));
}

/** 毫秒折成整秒，至少 1s。 */
function seconds(thoughtMs: number): number {
	return Math.max(1, Math.round(thoughtMs / 1000));
}

/** 收起态的完整摘要：`Thought for 2s, ran 3 shell commands`。 */
export function describeRun(toolNames: readonly string[], thoughtMs?: number): string {
	const thought = thoughtMs === undefined ? "" : `Thought for ${seconds(thoughtMs)}s, `;
	return `${thought}ran ${summarize(toolNames)}`;
}

function isToolRow(value: unknown): value is ToolRow {
	return typeof ToolExecutionComponent === "function" && value instanceof ToolExecutionComponent;
}

/** 结束后的隐藏思考标签：正体 + 主题色，与流式中的 `Thinking...` 占位区分。 */
export function thoughtLabel(thoughtMs: number, theme?: Theme): string {
	const fg = theme ? theme.getFgAnsi("thinkingText") : "";
	return `\x1b[0m${fg}Thought for ${seconds(thoughtMs)}s`;
}

/** 把一条已结束消息的隐藏思考标签换成实际耗时。 */
export function applyThoughtLabel(assistant: Component, thoughtMs: number): void {
	(assistant as AssistantInternals).setHiddenThinkingLabel?.(thoughtLabel(thoughtMs, activeTheme));
}

/**
 * 收起或 Pi 隐藏思考时，正文照常、思考不参与渲染。
 *
 * `setHideThinkingBlock` 会清空逐段点击的临时开关，因此值未变时不动它。
 */
function setThinkingHidden(value: unknown, hidden: boolean): void {
	if (!(value instanceof AssistantMessageComponent)) return;
	const internals = value as unknown as AssistantInternals;
	if (internals.hideThinkingBlock === hidden) return;
	internals.setHideThinkingBlock?.(hidden);
}

/** 摘要行已经展示这段耗时，隐藏消息自己的标签，避免同一段思考显示两行。 */
export function clearThoughtLabel(assistant: Component): void {
	const internals = assistant as AssistantInternals;
	if (internals.hiddenThinkingLabel === "") return;
	internals.setHiddenThinkingLabel?.("");
}

/** 每条助手消息的思考耗时，在 `message_end` 时记录，多轮摘要从这里累加。 */
const thoughtByMessage = new WeakMap<Component, number>();

/** 读取一条助手消息的思考耗时，测试可注入替身。 */
export type ThoughtSource = (assistant: Component) => number | undefined;

const thoughtFromMessage: ThoughtSource = (assistant) => thoughtByMessage.get(assistant);

/** 摘要行已经统计过区间内轮次的耗时，收起与展开都不再显示各自的标签。 */
function clearAbsorbedThoughtLabels(items: readonly Component[]): void {
	for (const item of items) {
		if (item instanceof AssistantMessageComponent) clearThoughtLabel(item);
	}
}

/**
 * 该助手消息是否是一个「静默轮次」：没有任何可见文本，只思考并调工具。
 *
 * 中断、报错与截断的轮次自带提示文本，不能折叠。内部结构不可用时同样返回
 * `false` —— 退化到不合并，比错误地藏起内容安全。
 */
export function isSilentTurn(value: unknown): boolean {
	if (!isSettledAssistant(value)) return false;
	const internals = value as AssistantInternals;
	if (!Array.isArray(internals.markdownSlots)) return false;
	return !internals.markdownSlots.some((slot) => slot.kind === "text");
}

/** 已正常结束的助手消息：中断、报错与截断的轮次自带提示文本，不能折叠。 */
function isSettledAssistant(value: unknown): boolean {
	if (!(value instanceof AssistantMessageComponent)) return false;
	const stopReason = (value as unknown as AssistantInternals).lastMessage?.stopReason;
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
	private readonly themeSource: () => Theme | undefined;
	private readonly requestRender: () => void;
	private expandedState: boolean;

	constructor(options: ToolRunGroupOptions) {
		super();
		this.names = options.toolNames;
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

	handleMouse(event: TuiMouseEvent): MouseDispatchResult | undefined {
		// 两级摘要一致的规则：只有摘要行负责切换，其余行交给子组件。
		if (event.type === "click" && event.button === "left" && event.y === 1) {
			this.setExpanded(!this.expandedState);
			this.requestRender();
			return { handled: true } as MouseDispatchResult;
		}
		if (!this.expandedState) return undefined;
		return super.handleMouse({ ...event, y: event.y - 2, height: event.height - 2 });
	}

	private rows(): ToolRow[] {
		return this.children as ToolRow[];
	}

	private summaryLine(width: number): string {
		return styledSummaryLine(
			describeRun(this.names),
			this.stats().failed,
			width,
			this.themeSource(),
		);
	}
}

/**
 * 把 `chatContainer` 里相邻的工具行合并成 `ToolRunGroup`。
 *
 * 幂等：已成组的部分不是 `ToolExecutionComponent`，再次调用不会重复包装。
 * 执行中的工具段保留原行，结束后由 `tool_execution_end` 触发重新扫描。
 */
export function groupToolRuns(mode: GroupableMode): void {
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
		if (!isGroupable(toolNames) || run.some((item) => item.isPartial)) {
			next.push(...run);
			continue;
		}

		next.push(
			new ToolRunGroup({
				rows: run,
				toolNames,
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
	/** 区间里所有项的原始顺序（含留在摘要下方的执行中行），重扫时按它恢复调用顺序。 */
	sequence?: readonly Component[];
	expanded: boolean;
	theme: () => Theme | undefined;
	requestRender: () => void;
	thoughtMsFor?: ThoughtSource;
	/** 区间前那条带文本的回复：它不进入折叠，但思考耗时算进摘要。 */
	extraThought?: Component;
	/** Pi 实例上的 `hideThinkingBlock`：只影响展开态，收起态一律不渲染思考正文。 */
	piHidden?: boolean;
}

/**
 * 一段工具调用的摘要行 + 折叠内的时间线。
 *
 * 带可见文本的助手消息是区间边界：正文在摘要行之前渲染，不进入折叠。
 * 收起时思考正文一并隐去，展开后回到 Pi 的设置；区间前那条回复的思考同样收在
 * 摘要行里。`edit` / `write` 行参与区间但不被摘要行代表：摘要收起时它们仍逐条渲染。
 * 摘要内容每次渲染时从子组件重新累计，因此执行中/失败/主题切换都会即时反映；
 * 工具名与耗时随折叠区间增长而变化，不需要重建组件。
 */
export class ToolRunSummary extends Container {
	private readonly themeSource: () => Theme | undefined;
	private readonly requestRender: () => void;
	private readonly thoughtMsFor: ThoughtSource;
	private readonly extraThought: Component | undefined;
	/** 区间原始顺序：执行中的行不在 `children` 里，重扫要靠它把顺序还原。 */
	private readonly itemOrder: readonly Component[];
	private expandedState: boolean;
	private piHidden: boolean;
	/** 收起态下改动行的位置，点击要落到行上而不是整块折起摘要。 */
	private soloLayout: Array<{ child: Component; start: number; height: number }> = [];

	constructor(options: ToolRunSummaryOptions) {
		super();
		this.themeSource = options.theme;
		this.requestRender = options.requestRender;
		this.thoughtMsFor = options.thoughtMsFor ?? thoughtFromMessage;
		this.extraThought = options.extraThought;
		this.itemOrder = options.sequence ?? options.items;
		this.expandedState = options.expanded;
		this.piHidden = options.piHidden ?? false;
		for (const item of options.items) this.addChild(item);
		// 复活已展开的摘要时，新纳入的轮次也要铺开，否则展开的时间线里夹着一行收起。
		if (this.expandedState) this.setExpanded(true);
		this.syncThinkingVisibility();
	}

	get expanded(): boolean {
		return this.expandedState;
	}

	/** 区间里所有项的原始顺序，含留在摘要下方的执行中行。 */
	get sequence(): readonly Component[] {
		return this.itemOrder;
	}

	setExpanded(expanded: boolean): void {
		this.expandedState = expanded;
		for (const child of this.children) {
			(child as { setExpanded?: (value: boolean) => void }).setExpanded?.(expanded);
		}
		this.syncThinkingVisibility();
		this.invalidate();
	}

	/** Pi 实例上的思考开关变化：收起态仍隐去思考正文，展开态跟随这个值。 */
	setPiThinkingHidden(hidden: boolean): void {
		this.piHidden = hidden;
		this.syncThinkingVisibility();
	}

	/**
	 * 收起时思考由摘要行代表；展开后按 Pi 的设置显示。
	 * `extraThought` 在摘要之外渲染，思考可见性同样归这里管。
	 */
	private syncThinkingVisibility(): void {
		const hidden = !this.expandedState || this.piHidden;
		for (const child of this.children) setThinkingHidden(child, hidden);
		setThinkingHidden(this.extraThought, hidden);
	}

	render(width: number): string[] {
		const summary = this.summaryLine(width);
		if (this.expandedState) {
			this.soloLayout = [];
			return ["", summary, ...super.render(width)];
		}
		// 普通工具段由摘要行代表；改动行不靠摘要行代表，收起时也逐条渲染。
		const body: string[] = [];
		const layout: Array<{ child: Component; start: number; height: number }> = [];
		let top = 2; // 空行 + 摘要行
		for (const child of this.children) {
			if (isToolSegment(child) && !isSoloRow(child)) continue;
			// 静默轮次收起时不占行（D1）；展开后仍在时间线里看到思考正文。
			if (child instanceof AssistantMessageComponent && isSilentTurn(child)) continue;
			const lines = child.render(width);
			layout.push({ child, start: top, height: lines.length });
			top += lines.length;
			body.push(...lines);
		}
		this.soloLayout = layout;
		return ["", summary, ...body];
	}

	handleMouse(event: TuiMouseEvent): MouseDispatchResult | undefined {
		if (event.type === "click" && event.button === "left") {
			if (this.expandedState) {
				// 展开时只有摘要行负责折叠，其余行交给子组件。
				if (event.y !== 1) {
					return super.handleMouse({ ...event, y: event.y - 2, height: event.height - 2 });
				}
			} else if (event.y !== 1) {
				// 收起时只有摘要行负责展开；正文与改动行逐条可见，点击先落到行上。
				for (const { child, start, height } of this.soloLayout) {
					if (event.y < start || event.y >= start + height) continue;
					return child.handleMouse?.({ ...event, y: event.y - start, height }) as
						| MouseDispatchResult
						| undefined;
				}
				return undefined;
			}
			this.setExpanded(!this.expandedState);
			this.requestRender();
			return { handled: true } as MouseDispatchResult;
		}
		if (!this.expandedState) return undefined;
		return super.handleMouse({ ...event, y: event.y - 2, height: event.height - 2 });
	}

	private summaryLine(width: number): string {
		const names: string[] = [];
		let thoughtMs = 0;
		let failed = 0;
		for (const child of this.children) {
			if (child instanceof ToolRunGroup) {
				names.push(...child.toolNames);
				failed += child.stats().failed;
			} else if (isToolRow(child)) {
				// edit / write 自己逐条渲染，不重复计入摘要行。
				if (isSoloRow(child)) continue;
				names.push(String(child.toolName));
				if (child.result?.isError) failed++;
			} else if (child instanceof AssistantMessageComponent) {
				thoughtMs += this.thoughtMsFor(child) ?? 0;
			}
		}
		if (this.extraThought) thoughtMs += this.thoughtMsFor(this.extraThought) ?? 0;
		const text = describeRun(names, thoughtMs > 0 ? thoughtMs : undefined);
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

/**
 * 区间由工具段与静默轮次组成，两者都既可作为区间开头，也可接在区间中间。
 *
 * 带正文的回复是硬边界：它留在区间外，既作为 `extraThought` 贡献耗时，也让正文先于
 * 摘要行出现；它之后的思考与工具调用另起一行摘要，不会算进它上方那一行。
 * 中断、报错与截断的轮次同样不在区间内。
 */
function isAbsorbable(value: unknown): boolean {
	return isToolSegment(value) || isSilentTurn(value);
}

/**
 * 执行中的工具行：不进摘要，留在摘要下方——摘要行只有计数，看不到命令行、
 * 流式输出与实时计时。并行调用里已结束的部分照常计入，执行期间最多只多出
 * 正在跑的那几行。
 */
function isRunningSegment(item: Component): boolean {
	return isToolRow(item) && item.isPartial === true;
}

/**
 * 区间内普通工具段的数量：一段都没有时没有可摘要的内容。
 *
 * `edit` / `write` 不算在内：它们始终逐条渲染，不需要靠摘要行代表。
 */
function countedSegments(items: readonly Component[]): number {
	let count = 0;
	for (const item of items) if (isToolSegment(item) && !isSoloRow(item)) count++;
	return count;
}

/**
 * 从 `index` 读一段可折叠区间：连续的工具段与静默轮次。
 */
function readRegion(children: readonly Component[], index: number): Region | undefined {
	if (!isAbsorbable(children[index])) return undefined;
	const items: Component[] = [];
	let cursor = index;
	while (cursor < children.length && isAbsorbable(children[cursor])) items.push(children[cursor++]!);
	return { items, end: cursor };
}

function sameItems(left: readonly Component[], right: readonly Component[]): boolean {
	return left.length === right.length && left.every((item, index) => item === right[index]);
}

/**
 * 把 `chatContainer` 里可折叠的工具调用区间合并成 `ToolRunSummary`。
 *
 * 区间由连续的普通工具段与静默轮次组成，可以由工具段开头：回复正文留在区间外，
 * 它引发的调用收成一行摘要，下一条正文之后的调用另起一行。
 * `edit` / `write` 行与报错或中断的轮次是硬边界。
 *
 * 区间里已结束的部分（含并行调用中先结束的）收进摘要行，执行中的工具行留在
 * 摘要下方——命令行、流式输出与实时计时照常可见，执行结束后再由
 * `tool_execution_end` 并入同一行。
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
	/** 已通过摘要的原始顺序入队的项：执行中的行同时还在容器里，不能再插一次。 */
	const sequenced = new Set<Component>();
	for (const child of container.children) {
		if (child instanceof ToolRunSummary) {
			// 按原始顺序展开：执行中的行在摘要下方，只展开 children 会把顺序颠倒。
			for (const item of child.sequence) {
				flat.push(item);
				sequenced.add(item);
			}
			const first = child.sequence[0];
			if (first) previous.set(first, child);
			continue;
		}
		if (sequenced.has(child)) continue;
		flat.push(child);
	}

	const next: Component[] = [];
	for (let index = 0; index < flat.length; index++) {
		const region = readRegion(flat, index);
		if (!region) {
			next.push(flat[index]!);
			continue;
		}

		// 执行中的工具段留在摘要外，其余项（含并行调用里先结束的）一并收成摘要行。
		const absorbed = region.items.filter((item) => !isRunningSegment(item));
		const running = region.items.filter(isRunningSegment);
		if (countedSegments(absorbed) === 0) {
			// 还没有已完成的调用可摘要：整段保持原样，露出执行中的行。
			next.push(...region.items);
			index = region.end - 1;
			continue;
		}

		const reused = previous.get(flat[index]!);
		// 区间前那条带文本的回复留在外面，它的思考耗时仍计入这行摘要；
		// 报错 / 中断的轮次是硬边界，保留自己的耗时标签。
		const preceding = flat[index - 1];
		const extraThought =
			preceding instanceof AssistantMessageComponent && isSettledAssistant(preceding)
				? preceding
				: undefined;
		const thoughtFor = options.thoughtMsFor ?? thoughtFromMessage;
		const thoughtMs = extraThought ? thoughtFor(extraThought) : undefined;
		// 区间与吸收内容都没变才复用：执行中的行刚结束时要把它纳入摘要。
		const piHidden = mode.hideThinkingBlock === true;
		if (reused && sameItems(reused.sequence, region.items) && sameItems(reused.children, absorbed)) {
			reused.setPiThinkingHidden(piHidden);
			next.push(reused);
		} else {
			next.push(
				new ToolRunSummary({
					items: absorbed,
					sequence: region.items,
					expanded: reused?.expanded ?? mode.toolOutputExpanded === true,
					theme: () => activeTheme,
					requestRender: () => mode.ui?.requestRender?.(),
					thoughtMsFor: options.thoughtMsFor,
					extraThought,
					piHidden,
				}),
			);
		}
		// 耗时已在摘要行里，收起与展开都不再重复区间内轮次与前置回复各自的标签。
		clearAbsorbedThoughtLabels(absorbed);
		if (extraThought) clearThoughtLabel(extraThought);
		next.push(...running);
		index = region.end - 1;
	}

	if (!sameItems(next, container.children)) container.children = next;
}

/**
 * 把思考可见性同步到折叠内的助手消息。
 *
 * Pi 的顶层遍历只覆盖 `chatContainer` 的直接子组件，被收进摘要的轮次收不到更新；
 * 这里只进入摘要与工具组，其他容器不动。摘要收起时不显示思考正文，与传入的
 * Pi 设置无关；只有展开态跟随它。
 */
export function applyThinkingVisibility(root: Component, hidden: boolean): void {
	if (root instanceof AssistantMessageComponent) {
		setThinkingHidden(root, hidden);
		return;
	}
	if (root instanceof ToolRunSummary) {
		root.setPiThinkingHidden(hidden);
		return;
	}
	if (root instanceof ToolRunGroup) {
		for (const child of root.children) applyThinkingVisibility(child, hidden);
		return;
	}
	if (root instanceof Container) {
		for (const child of root.children) {
			if (child instanceof ToolRunSummary || child instanceof ToolRunGroup) {
				applyThinkingVisibility(child, hidden);
			}
		}
	}
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

export function trackThinking(event: unknown): void {
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

export function finishMessage(mode: GroupableMode, event: unknown): void {
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

	// 思考已结束：隐藏思考的标签从 `Thinking...` 换成实际耗时，正在流式的下一条消息不受影响。
	const assistant = lastAssistantChild(mode);
	const hasThinking = (message.content ?? []).some((part) => part?.type === "thinking");
	if (assistant && hasThinking && thoughtMs !== undefined) applyThoughtLabel(assistant, thoughtMs);

	// 失败或中断时保留逐条可见，便于判断是哪一次调用出的问题。
	if (message.stopReason === "error" || message.stopReason === "aborted") return;

	if (assistant && thoughtMs !== undefined) thoughtByMessage.set(assistant, thoughtMs);

	// 静默轮次的耗时一结束就计入所在摘要；带正文的回复是边界，重扫让它留在区间外。
	groupToolRuns(mode);
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

/** 重新扫描一次：先做单轮聚合，再做区间摘要。 */
export function refreshToolRuns(mode: GroupableMode): void {
	groupToolRuns(mode);
	groupSilentTurns(mode);
	mode.ui?.requestRender?.();
}

/**
 * 接管 `InteractiveMode` 的事件分发与历史回放。
 *
 * 原始方法只在首次安装时保存；重复安装（含同进程 `/reload`）用新 wrapper
 * 覆盖旧 wrapper，总是调用同一份原始实现，因此不会叠加。
 */
export function installToolRunGroups(): boolean {
	const prototype = InteractiveMode.prototype as unknown as Record<PropertyKey, unknown> & GroupableMode;
	if (typeof prototype.handleEvent !== "function" || typeof prototype.renderSessionItems !== "function") {
		return false;
	}

	const handleEvent = (prototype[ORIGINAL_HANDLE_EVENT] ??= prototype.handleEvent) as NonNullable<
		GroupableMode["handleEvent"]
	>;
	const renderSessionItems = (prototype[ORIGINAL_RENDER_SESSION_ITEMS] ??=
		prototype.renderSessionItems) as NonNullable<GroupableMode["renderSessionItems"]>;

	prototype.handleEvent = async function (this: GroupableMode, event: unknown) {
		trackThinking(event);
		await handleEvent.call(this, event);
		finishMessage(this, event);
		// 工具跑完后才能收成摘要行：执行中保留带实时计时的工具行。
		if ((event as { type?: string } | undefined)?.type === "tool_execution_end") refreshToolRuns(this);
	};

	prototype.renderSessionItems = function (this: GroupableMode, ...args: unknown[]) {
		const result = renderSessionItems.apply(this, args);
		refreshToolRuns(this);
		return result;
	};

	// 折叠内的消息收不到 Pi 的顶层遍历，这里补一次；方法缺失时保持原行为。
	const updateThinkingVisibility = (prototype[ORIGINAL_UPDATE_THINKING] ??= prototype
		.updateThinkingBlockVisibility) as GroupableMode["updateThinkingBlockVisibility"];
	if (typeof updateThinkingVisibility === "function") {
		prototype.updateThinkingBlockVisibility = function (this: GroupableMode) {
			updateThinkingVisibility.call(this);
			// Pi 调用时不传参数，真实开关在实例字段上；读参数会把 `undefined` 写进嵌套消息。
			if (this.chatContainer) {
				applyThinkingVisibility(this.chatContainer, this.hideThinkingBlock === true);
			}
		};
	}

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
