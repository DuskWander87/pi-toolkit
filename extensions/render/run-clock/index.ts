/**
 * run-clock
 *
 * 把「这次请求跑了多久、生成了多少 token、这一轮思考了多久」显示在输入框上方一行：
 * `✳ Perusing… (5s · ↓ 564 tokens · thinking for 4s)`。
 *
 * 一行计时贯穿整段请求：`agent_start` 起表，`agent_end` 停表，中间思考与工具执行都不停表。
 * 位置由 Pi 的扩展 widget 提供（`aboveEditor`），请求期间把 Pi 的 working 行整行关掉，
 * 不留 spinner 与默认文案；请求结束后清掉 widget，把 working 行的可见性交还 Pi 的默认设置。
 *
 * 动画取 Claude Code spinner 的参数：词首字形在 6 个字符间来回走，120ms 一步；
 * 动词与省略号共用一条随时钟滚动的渐变色标，像跑马灯一样循环。
 *
 * 思考耗时只在思考进行中出现：思考一开始 `thinking for Ns` 就跟着每秒走，`thinking_end` 一到
 * 这一格整个消失，因此不存在跨轮累加。
 *
 * 工具调用条数交给 `tool-run-groups` 的摘要行，这一行只报耗时与生成量。
 */

import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Text, foregroundAnsi, rgbColor, type TerminalColorMode } from "@earendil-works/pi-tui";

/** 重绘与字形步进的节拍：120ms 一拍，与 Claude Code 的 spinner 同频。 */
const TICK_MS = 120;

/** widget 的键，请求结束时按同一个键清除。 */
const WIDGET_KEY = "run-clock";

/**
 * 词首字形的帧序列：6 个字符正着走一遍，再倒着走回来，回头时首尾各停一拍。
 *
 * 字符取自 Claude Code 的同一组。它用 `✱`（U+2731）而不是 `✳`（U+2733）：
 * 后者会被 emoji 规则判成双宽，逐帧切换时整行横向抖动。
 */
const GLYPH_BASE = ["·", "✢", "✱", "✶", "✻", "✽"];
const GLYPH_FRAMES = [...GLYPH_BASE, ...[...GLYPH_BASE].reverse()];

/** 跑马灯扫过词一次的时长：亮带从词首走到词尾再进来。 */
const MARQUEE_PERIOD_MS = 1400;

/** 计时行的动词词表：每次请求抽一个，读起来比固定的 `Working` 更像在干活。 */
const VERBS = [
	"Pollinating",
	"Pondering",
	"Percolating",
	"Noodling",
	"Tinkering",
	"Brewing",
	"Conjuring",
	"Mulling",
	"Whirring",
	"Scheming",
	"Spelunking",
	"Churning",
	"Cogitating",
	"Deliberating",
	"Marinating",
	"Reticulating",
	"Simmering",
	"Whisking",
	"Foraging",
	"Sifting",
	"Weaving",
	"Drafting",
	"Sketching",
	"Probing",
	"Surveying",
	"Charting",
	"Untangling",
	"Assembling",
	"Combobulating",
	"Perambulating",
];

/**
 * 从词表里抽一个动词，避开上一次用过的那一个；`random` 只为测试注入。
 * 冲突时只重抽一次，词表非空即可终止。
 */
export function pickVerb(previous?: string, random: () => number = Math.random): string {
	const draw = (): string => VERBS[Math.min(VERBS.length - 1, Math.floor(random() * VERBS.length))]!;
	const first = draw();
	return first === previous && VERBS.length > 1 ? draw() : first;
}

/**
 * token 数的缩写口径，与 Pi footer 的 `formatTokens` 一致：千以下原样，万以下一位小数，
 * 百万以下四舍五入到千，千万以下一位小数，再往上取整换 `M`。位数固定后，逐拍重绘不会
 * 因数字变长而抖动。
 */
function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/** 当前节拍的字形；按节拍取整，同一拍内不跳字。 */
export function glyphAt(elapsedMs: number): string {
	return GLYPH_FRAMES[Math.floor(elapsedMs / TICK_MS) % GLYPH_FRAMES.length]!;
}

/**
 * 耗时：不足一分钟按秒（`42s`），到分钟换成 `5m 18s`，到小时换成 `1h 5m`。
 *
 * 与 Pi 自己的工具耗时同一套换算，只把秒以下的小数去掉：这一行每秒都在变，
 * 小数位会让整段文案持续闪动。
 */
export function formatDuration(ms: number): string {
	const total = Math.max(1, Math.round(ms / 1000));
	if (total < 60) return `${total}s`;
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	if (minutes < 60) return `${minutes}m ${seconds}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** 计时行的纯文本：`Perusing… (5s · ↓ 564 tokens · thinking for 2s)`，缺少的段自动省略。 */
export function clockText(
	verb: string,
	elapsedMs: number,
	outputTokens: number,
	thinkingMs?: number,
): string {
	const parts = [formatDuration(elapsedMs)];
	if (outputTokens > 0) {
		parts.push(`↓ ${formatTokens(outputTokens)} token${outputTokens === 1 ? "" : "s"}`);
	}
	if (thinkingMs !== undefined) {
		parts.push(`thinking for ${formatDuration(thinkingMs)}`);
	}
	return `${verb}… (${parts.join(" · ")})`;
}

type Rgb = readonly [number, number, number];
/** 主题的明暗外观，与 Pi 的 `theme.appearance` 同一取值。 */
type Appearance = "dark" | "light";

/**
 * 动词渐变色标，按主题外观分两套：暗色主题用设计稿里的亮暖色，
 * 浅色主题压深一档，保证浅底上仍然清楚（终点色对白底约 4.5:1）。
 */
const VERB_GRADIENT: Record<Appearance, readonly [Rgb, Rgb]> = {
	dark: [
		[0xd7, 0x77, 0x57],
		[0xe3, 0x99, 0x7a],
	],
	light: [
		[0xa8, 0x49, 0x2f],
		[0xb8, 0x5c, 0x3a],
	],
};

/** 在色标上取第 `t`（0~1）个位置的颜色；出界的一点点夹到两端。 */
function gradientColor(appearance: Appearance, t: number): Rgb {
	const [from, to] = VERB_GRADIENT[appearance];
	const k = t < 0 ? 0 : t > 1 ? 1 : t;
	return [
		Math.round(from[0] + (to[0] - from[0]) * k),
		Math.round(from[1] + (to[1] - from[1]) * k),
		Math.round(from[2] + (to[2] - from[2]) * k),
	];
}

/**
 * 跑马灯：每个字符在三角形色带上取一个位置，带上只有一个波峰，随相位在词内扫过。
 *
 * 波峰取色标的终点色、两端回落到起点色，因此既保留词的渐变观感，又能看出亮带在跑。
 * 相位按连续时间取，节拍只决定重绘频率；波峰走到词尾后从词首重新进入。
 *
 * 颜色按主题的终端色彩模式生成，256 色终端下自动降级；末尾复位到默认前景色。
 */
export function marqueeAnsi(
	text: string,
	phase: number,
	appearance: Appearance,
	mode: TerminalColorMode,
): string {
	const chars = [...text];
	const count = chars.length;
	const painted = chars.map((char, index) => {
		const position = (index + phase * count) / count;
		const wrapped = ((position % 1) + 1) % 1;
		// 三角波：0 → 1 → 0，波峰随相位移动。
		const [r, g, b] = gradientColor(appearance, 1 - Math.abs(2 * wrapped - 1));
		return `${foregroundAnsi(rgbColor(r, g, b), mode)}${char}`;
	});
	return `${painted.join("")}\x1b[39m`;
}

/** 词首字形取色标的起点色，与动词连成一体。 */
function glyphAnsi(glyph: string, appearance: Appearance, mode: TerminalColorMode): string {
	const [r, g, b] = gradientColor(appearance, 0);
	return `${foregroundAnsi(rgbColor(r, g, b), mode)}${glyph}\x1b[39m`;
}

export default function (pi: ExtensionAPI) {
	/** 本次请求的起表时间；`undefined` 表示没有在计时。 */
	let startedAt: number | undefined;
	/** 本次请求挑中的动词，请求期间不变。 */
	let verb = VERBS[0]!;
	/** 本次请求累计的生成 token 数，按助手消息累加。 */
	let outputTokens = 0;
	/** 当前这块思考的起点；`undefined` 表示不在思考中，这一格也就不在。 */
	let thinkingStartedAt: number | undefined;
	let tick: ReturnType<typeof setInterval> | undefined;
	/** 上一次写入的内容指纹：同一拍内文案与字形都没变就不重绘。 */
	let painted: string | undefined;
	let ui: ExtensionUIContext | undefined;

	const paint = (): void => {
		if (startedAt === undefined) return;
		const elapsed = Date.now() - startedAt;
		const thinkingMs = thinkingStartedAt === undefined ? undefined : Date.now() - thinkingStartedAt;
		const text = clockText(verb, elapsed, outputTokens, thinkingMs);
		// 字形与相位都按节拍量化，同一拍内重复触发直接跳过。
		const beat = Math.floor(elapsed / TICK_MS);
		const fingerprint = `${beat}|${text}`;
		if (fingerprint === painted) return;
		painted = fingerprint;

		const head = `${verb}…`;
		const rest = text.slice(head.length);
		ui?.setWidget(WIDGET_KEY, (_tui, theme) => {
			const mode = theme.getColorMode();
			const phase = (elapsed % MARQUEE_PERIOD_MS) / MARQUEE_PERIOD_MS;
			return new Text(
				`${glyphAnsi(glyphAt(elapsed), theme.appearance, mode)} ${marqueeAnsi(head, phase, theme.appearance, mode)}${theme.fg("muted", rest)}`,
				1,
				0,
			);
		});
	};

	const stopClock = (): void => {
		if (tick !== undefined) clearInterval(tick);
		tick = undefined;
		startedAt = undefined;
		outputTokens = 0;
		thinkingStartedAt = undefined;
		painted = undefined;
	};

	// 墙钟覆盖整个 agent run：思考与工具执行都算在内，不逐条计时。
	pi.on("agent_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ui = ctx.ui;
		stopClock();
		verb = pickVerb(verb);
		startedAt = Date.now();
		// 耗时与用量独占输入框上方一行，Pi 的 working 行整行让位。
		ctx.ui.setWorkingVisible(false);
		paint();
		tick = setInterval(paint, TICK_MS);
	});

	// 用量只在每条助手消息结束时到齐，流式过程中不变；工具结果消息不计入。
	pi.on("message_end", async (event) => {
		if (startedAt === undefined || event.message.role !== "assistant") return;
		const output = event.message.usage?.output;
		if (!output) return;
		outputTokens += output;
		paint();
	});

	// 思考耗时按流式事件取：起表显示、结束就撤掉这一格，中途不看正文。
	pi.on("message_update", async (event) => {
		if (startedAt === undefined) return;
		const kind = event.assistantMessageEvent?.type;
		if (kind === "thinking_start") {
			thinkingStartedAt = Date.now();
		} else if (kind === "thinking_end") {
			if (thinkingStartedAt === undefined) return;
			thinkingStartedAt = undefined;
		} else {
			return;
		}
		paint();
	});

	pi.on("agent_end", async (_event, ctx) => {
		const wasRunning = startedAt !== undefined;
		stopClock();
		if (!wasRunning || ctx.mode !== "tui") return;
		// 清掉计时行，把 working 行的可见性交还 Pi 的默认设置；下一次请求开始时再关。
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		ctx.ui.setWorkingVisible(true);
	});
}
