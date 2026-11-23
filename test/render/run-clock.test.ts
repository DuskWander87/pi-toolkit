/**
 * run-clock 验证：输入框上方计时行的文案、字形与跑马灯、思考耗时与计时生命周期。
 *
 * harness 的异步用例并行执行，事件驱动带状态，这里合成一条串行用例。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import extend, { clockText, glyphAt, marqueeAnsi, pickVerb } from "../../extensions/render/run-clock/index.ts";
import { check, finish } from "../harness.ts";

type Handler = (event: unknown, ctx: unknown) => void | Promise<void>;

const handlers = new Map<string, Handler>();
/** 每次 setWidget 渲染出的文本行；`undefined` 表示清掉 widget。 */
const widgets: Array<string[] | undefined> = [];
/** 同上，但保留颜色转义，用于校验渐变色与跑马灯。 */
const rawWidgets: string[][] = [];
/** setWorkingVisible 的入参，按调用顺序。 */
const workingVisible: boolean[] = [];
/** 只做去色，widget 的组件工厂按需调用；`appearance` 由用例切换，校验两套色标。 */
const theme = {
	fg: (_color: string, text: string) => text,
	appearance: "dark" as "dark" | "light",
	getColorMode: () => "truecolor",
} as any;
const ui = {
	setWidget(_key: string, content: unknown) {
		if (content === undefined) {
			widgets.push(undefined);
			rawWidgets.push([]);
			return;
		}
		const component = (content as (tui: unknown, theme: unknown) => { render(width: number): string[] })({}, theme);
		const lines = component.render(80);
		rawWidgets.push(lines);
		widgets.push(lines.map(stripTerminalSequences).map((line) => line.trim()));
	},
	setWorkingVisible(visible: boolean) {
		workingVisible.push(visible);
	},
};

extend({
	on(event: string, handler: Handler) {
		handlers.set(event, handler);
	},
} as any);

const emit = async (event: string, payload: Record<string, unknown> = {}, mode = "tui") => {
	const handler = handlers.get(event);
	assert.ok(handler, `没有注册 ${event}`);
	await handler({ type: event, ...payload }, { mode, ui });
};

/** 最后一次写入的计时行文案；没有写入时返回 `undefined`。 */
const lastWidget = (): string | undefined => {
	const content = widgets.at(-1);
	return content === undefined ? undefined : content.join("\n");
};

/** 最后一次写入的原始颜色文本。 */
const lastRaw = (): string => (rawWidgets.at(-1) ?? []).join("");

/** 一条带用量的助手消息。 */
const assistant = (output: number | undefined) => ({
	message: {
		role: "assistant",
		content: [],
		usage: output === undefined ? undefined : { input: 10, output, cacheRead: 0, cacheWrite: 0 },
	},
});

/** 流式事件：只带类型，够 run-clock 判断起止。 */
const streamEvent = (type: string) => ({ assistantMessageEvent: { type } });

/** 文案骨架：字形 + 空格 + 动词 + 省略号 + 括号。 */
const SHAPE = /^[·✢✱✶✻✽] [A-Z][a-z]+… \(/;

/** 深色色标的起点色与终点色。 */
const DARK_FROM = "\u001b[38;2;215;119;87m";
/** 浅色色标的起点色（压深一档）。 */
const LIGHT_FROM = "\u001b[38;2;168;73;47m";

/** 按给定序列依次返回随机数，用完回到开头。 */
function sequence(values: number[]): () => number {
	let index = 0;
	return () => values[index++ % values.length]!;
}

check("文案：耗时按分钟 / 小时换算，不足一分钟按秒", () => {
	const elapsed = (ms: number) => clockText("Brewing", ms, 0);
	assert.equal(elapsed(0), "Brewing… (1s)");
	assert.equal(elapsed(4200), "Brewing… (4s)");
	assert.equal(elapsed(59_000), "Brewing… (59s)");
	// 到分钟就换成 `5m 18s`，与 Pi 自己的工具耗时同一套换算。
	assert.equal(elapsed(60_000), "Brewing… (1m 0s)");
	assert.equal(elapsed(318_000), "Brewing… (5m 18s)");
	assert.equal(elapsed(3_599_000), "Brewing… (59m 59s)");
	assert.equal(elapsed(3_600_000), "Brewing… (1h 0m)");
	assert.equal(elapsed(9_840_000), "Brewing… (2h 44m)");
	// 思考耗时用同一套口径。
	assert.equal(clockText("Brewing", 100_000, 0, 90_000), "Brewing… (1m 40s · thinking for 1m 30s)");
});

check("文案：动词带省略号，括号里报秒数与生成量，秒数取整、token 带单复数", () => {
	assert.equal(clockText("Pollinating", 0, 0), "Pollinating… (1s)");
	assert.equal(clockText("Pollinating", 12_000, 0), "Pollinating… (12s)");
	assert.equal(clockText("Pollinating", 12_000, 1), "Pollinating… (12s · ↓ 1 token)");
	assert.equal(clockText("Pollinating", 12_000, 243), "Pollinating… (12s · ↓ 243 tokens)");
});

check("文案：思考耗时只在思考进行中出现，不足一秒按一秒算", () => {
	// 与参考图同形的完整一行（思考进行中）。
	assert.equal(
		clockText("Perusing", 5000, 564, 2000),
		"Perusing… (5s · ↓ 564 tokens · thinking for 2s)",
	);
	// 还没有用量时，思考耗时直接接在耗时后面。
	assert.equal(clockText("Brewing", 1000, 0, 2000), "Brewing… (1s · thinking for 2s)");
	assert.equal(clockText("Brewing", 1000, 0, 120), "Brewing… (1s · thinking for 1s)");
	// 不在思考中就没有这一格（思考结束后同样没有）。
	assert.equal(clockText("Brewing", 1000, 0), "Brewing… (1s)");
	assert.equal(clockText("Brewing", 1000, 564), "Brewing… (1s · ↓ 564 tokens)");
});

check("token 数按 Pi footer 的口径缩写", () => {
	const text = (count: number) => clockText("Brewing", 1000, count);
	assert.equal(text(999), "Brewing… (1s · ↓ 999 tokens)");
	assert.equal(text(1000), "Brewing… (1s · ↓ 1.0k tokens)");
	assert.equal(text(1234), "Brewing… (1s · ↓ 1.2k tokens)");
	assert.equal(text(9999), "Brewing… (1s · ↓ 10.0k tokens)");
	assert.equal(text(23_047), "Brewing… (1s · ↓ 23k tokens)");
	assert.equal(text(288_000), "Brewing… (1s · ↓ 288k tokens)");
	assert.equal(text(1_000_000), "Brewing… (1s · ↓ 1.0M tokens)");
	assert.equal(text(2_540_000), "Brewing… (1s · ↓ 2.5M tokens)");
	assert.equal(text(9_999_999), "Brewing… (1s · ↓ 10.0M tokens)");
	assert.equal(text(12_500_000), "Brewing… (1s · ↓ 13M tokens)");
	// 缩写后仍按原始数量决定单复数。
	assert.equal(text(1), "Brewing… (1s · ↓ 1 token)");
});

check("动词：从词表里按随机数抽取，边界值不越界，抽到上一个词时重抽一次", () => {
	assert.equal(pickVerb(undefined, () => 0), "Pollinating");
	assert.equal(pickVerb(undefined, () => 0.999999), "Perambulating");
	// 每个随机数对应一个词：30 个不同的随机数应拿走 30 个不同的动词。
	const drawn = Array.from({ length: 30 }, (_, i) => pickVerb(undefined, () => i / 30));
	assert.equal(new Set(drawn).size, 30, `词表应有 30 个动词：${drawn.join(",")}`);
	for (const verb of drawn) assert.match(verb, /^[A-Z][a-z]+$/, verb);
	// 抽到上一次那个词时重抽一次，避免连续两次请求出现同一个词。
	assert.equal(pickVerb("Pollinating", sequence([0, 0.5])), "Reticulating");
	assert.equal(pickVerb("Churning", () => 0), "Pollinating", "不重复时不重抽");
});

check("字形：6 个字符正走再倒走，120ms 一拍", () => {
	const frames = Array.from({ length: 12 }, (_, i) => glyphAt(i * 120));
	assert.deepEqual(frames, ["·", "✢", "✱", "✶", "✻", "✽", "✽", "✻", "✶", "✱", "✢", "·"]);
	// 同一拍内不跳字，一圈之后回到起点。
	assert.equal(glyphAt(0), glyphAt(119));
	assert.equal(glyphAt(120), "✢");
	assert.equal(glyphAt(12 * 120), "·");
});

check("跑马灯：亮带沿词扫过，省略号与动词同一条色带", () => {
	const text = "Perusing…";
	const line = (phase: number) => marqueeAnsi(text, phase, "dark", "truecolor");
	const chars = (raw: string) =>
		[...raw.matchAll(/\u001b\[38;2;(\d+);(\d+);(\d+)m(.)/gu)].map((m) => ({
			char: m[4]!,
			rgb: [Number(m[1]), Number(m[2]), Number(m[3])] as [number, number, number],
		}));
	const brightness = (rgb: [number, number, number]) => rgb[0] + rgb[1] + rgb[2];
	/** 亮带所在的列（最亮的一格；并列取先出现的）。 */
	const peakColumn = (raw: string) => {
		const list = chars(raw);
		return list.reduce((best, cell, index) => (brightness(cell.rgb) > brightness(list[best]!.rgb) ? index : best), 0);
	};

	const at0 = line(0);
	const cells = chars(at0);
	// 逐字符设色，省略号也在色带上；末尾复位默认前景色。
	assert.equal(cells.length, [...text].length, "逐字符设色，含省略号");
	assert.ok(at0.endsWith("\u001b[39m"), "末尾复位默认前景色");
	// 相位 0：首字取起点色，亮带（色标终点色）落在词中间，两端都在暗侧。
	assert.deepEqual(cells[0]!.rgb, [215, 119, 87], JSON.stringify(cells[0]));
	const peak0 = peakColumn(at0);
	assert.ok(Math.abs(peak0 - (cells.length - 1) / 2) <= 1, `亮带应在词中间，实际第 ${peak0} 列`);
	assert.ok(brightness(cells[peak0]!.rgb) > brightness(cells[0]!.rgb), "亮带应比首字亮");
	assert.ok(brightness(cells.at(-1)!.rgb) < brightness(cells[peak0]!.rgb), `词尾应仍在暗侧：${JSON.stringify(cells.at(-1))}`);

	// 相位推进半圈：亮带位置整体后移，首列不再是起点色。
	const atHalf = line(0.5);
	assert.notEqual(atHalf, at0, "相位推进后颜色应变化");
	assert.notDeepEqual(chars(atHalf)[0]!.rgb, [215, 119, 87], JSON.stringify(chars(atHalf)[0]));
	assert.notEqual(peakColumn(atHalf), peak0, "亮带应已移动");

	// 浅色主题换一套压深的色标。
	assert.deepEqual(chars(marqueeAnsi(text, 0, "light", "truecolor"))[0]!.rgb, [168, 73, 47]);
});

check("计时生命周期：字形与跑马灯在跑、思考耗时只在思考时出现", async () => {
	const cleared: unknown[] = [];
	const realClear = globalThis.clearInterval;
	globalThis.clearInterval = ((handle: number) => {
		cleared.push(handle);
		return realClear(handle);
	}) as typeof clearInterval;

	// 起表：关掉 Pi 的 working 行，立刻把计时行写进 widget。
	await emit("agent_start");
	assert.deepEqual(workingVisible, [false], "起表时应关掉 working 行");
	assert.ok(widgets.length >= 1, "起表时应立刻写出计时行");
	assert.match(lastWidget()!, SHAPE);
	assert.ok(lastWidget()!.endsWith("… (1s)"), lastWidget());
	const verb = lastWidget()!.split(" ")[1]!.replace("…", "");
	assert.equal(cleared.length, 0, "起表时不应清计时器");

	// 字形 1 列 + 动词与省略号逐字符着色。
	const raw = lastRaw();
	assert.ok(raw.trimStart().startsWith(DARK_FROM), `首列应为字形，取起点色：${JSON.stringify(raw.trimStart().slice(0, 24))}`);
	assert.equal((raw.match(/\u001b\[38;2;/g) ?? []).length, verb.length + 2, "字形 + 动词 + 省略号各一段颜色");

	// 每条助手消息结束时把它的生成量加进来。
	await emit("message_end", assistant(120));
	assert.ok(lastWidget()!.includes("↓ 120 tokens"), lastWidget());
	await emit("message_end", assistant(123));
	assert.ok(lastWidget()!.includes("↓ 243 tokens"), "多轮助手消息累加");
	assert.equal(lastWidget()!.split(" ")[1], `${verb}…`, "动词在请求期间不变");

	// 浅色主题换一套压深的色标，不再用暗色主题的亮暖色。
	theme.appearance = "light";
	await emit("message_end", assistant(1));
	const lightRaw = lastRaw();
	assert.ok(lightRaw.includes(LIGHT_FROM), `浅色主题应用深色标：${JSON.stringify(lightRaw.slice(0, 24))}`);
	assert.ok(!lightRaw.includes(DARK_FROM), "浅色主题不该用亮暖色");
	theme.appearance = "dark";

	// 思考：进行中报已思考时长，一结束这一格就撤掉。
	await emit("message_update", streamEvent("thinking_start"));
	assert.ok(lastWidget()!.includes("thinking for 1s"), lastWidget());
	// 非思考事件不改写这一行。
	const before = lastWidget();
	await emit("message_update", streamEvent("text_delta"));
	assert.equal(lastWidget(), before, "正文流式事件不该改写文案");

	await emit("message_update", streamEvent("thinking_end"));
	assert.ok(!lastWidget()!.includes("thinking for"), `思考结束后这一格应撤掉：${lastWidget()}`);
	assert.ok(lastWidget()!.endsWith("tokens)"), lastWidget());

	// 第二块思考重新出现，也不与上一块相加：结束后同样只剩耗时与用量。
	await emit("message_update", streamEvent("thinking_start"));
	assert.ok(lastWidget()!.includes("thinking for 1s"), "新的思考块从零起算");
	await emit("message_update", streamEvent("thinking_end"));
	assert.ok(lastWidget()!.endsWith("tokens)"), `不累加也不残留：${lastWidget()}`);

	// 没有用量的助手消息、非对话消息都不改这一行。
	const painted = widgets.length;
	await emit("message_end", assistant(undefined));
	await emit("message_end", { message: { role: "user", content: [] } });
	await emit("message_end", { message: { role: "toolResult", content: [] } });
	assert.equal(widgets.length, painted, "不该为这些消息改写文案");

	// 停表：清掉计时器，移除 widget，把 working 行还回去。
	await emit("agent_end");
	assert.equal(widgets.at(-1), undefined, "agent_end 应清掉计时行");
	assert.deepEqual(workingVisible, [false, true], "agent_end 应恢复 working 行");
	assert.equal(cleared.length, 1, "agent_end 应清掉计时器");

	// 停表之后的用量事件不再改写，下一次请求从零重新累加、思考格也清空。
	const stopped = widgets.length;
	await emit("message_end", assistant(50));
	assert.equal(widgets.length, stopped, "停表后不该再写入");
	await emit("agent_start");
	assert.ok(lastWidget()!.endsWith("… (1s)"), "新请求的用量与思考耗时重新起算");
	await emit("agent_end");

	// 非 TUI 模式完全不碰 widget 与 working 行。
	widgets.length = 0;
	workingVisible.length = 0;
	await emit("agent_start", {}, "print");
	await emit("message_update", streamEvent("thinking_start"), "print");
	await emit("message_end", assistant(80), "print");
	await emit("agent_end", {}, "print");
	assert.deepEqual(widgets, [], "print 模式不应写计时行");
	assert.deepEqual(workingVisible, [], "print 模式不应动 working 行");

	globalThis.clearInterval = realClear;
});

finish();
