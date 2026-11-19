/**
 * minimal-tools 渲染逻辑验证：直接调用扩展注册的 renderCall / renderResult，断言渲染出的字符串。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { homedir } from "node:os";
import chalk from "chalk";
import { Box, stripTerminalSequences, Text, visibleWidth } from "@earendil-works/pi-tui";
import extend from "../extensions/render/minimal-tools/index.ts";
import { check, finish } from "./harness.ts";

const usedColors = new Set<string>();
const theme = {
	appearance: "dark",
	fg(name: string, text: string) {
		usedColors.add(`fg:${name}`);
		return text;
	},
	bg(name: string, text: string) {
		usedColors.add(`bg:${name}`);
		return text;
	},
	bold(text: string) {
		return text;
	},
	style(text: string, opts: { fg?: string }) {
		usedColors.add(`style:${opts.fg}`);
		return text;
	},
};

type Resolver = (name: string, next: () => unknown) => any;
let resolver: Resolver | undefined;
let hiddenThinkingLabel: string | undefined;

extend({
	registerToolRenderer(r: Resolver) {
		resolver = r;
	},
	on(event: string, handler: (...args: any[]) => void) {
		assert.equal(event, "session_start");
		handler(
			{},
			{
				ui: {
					setHiddenThinkingLabel: (v: string) => (hiddenThinkingLabel = v),
					theme: { getFgAnsi: () => "\x1b[38;2;153;153;153m" },
				},
			},
		);
	},
} as any);

function renderers(name: string, base?: unknown) {
	return resolver!(name, () => base);
}

/** outputPad 运行时默认值为 1（settings.outputPad 非 0）。 */
const PAD = 1;

function ctx(overrides: Record<string, unknown> = {}) {
	return {
		args: {},
		toolCallId: "call-1",
		invalidate() {},
		state: {},
		cwd: process.cwd(),
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: true,
		isError: false,
		durationMs: 163,
		outputPad: PAD,
		keyHint: (key: string, description: string) => `ctrl+o ${description}`,
		...overrides,
	};
}

/** 渲染并去掉行尾填充空格；保留行首缩进，用于校验对齐。 */
function text(component: any): string {
	return component
		.render(200)
		.map((line: string) => line.replace(/\s+$/, ""))
		.join("\n");
}

/** 去掉行首空白，便于断言内容。 */
function dedent(value: string): string {
	return value
		.split("\n")
		.map((line) => line.replace(/^\s+/, ""))
		.join("\n");
}

/** 把行首缩进量单独输出，便于人工核对对齐。 */
console.log("== 行首缩进（outputPad=1） ==");
{
	const r = renderers("bash");
	const done = ctx();
	console.log(
		JSON.stringify({
			summary: text(r.renderResult({ content: [] }, { expanded: false, isPartial: false }, theme, done)),
			running: text(r.renderResult({ content: [] }, { expanded: false, isPartial: true }, theme, ctx({ isPartial: true, durationMs: undefined }))),
			call: text(r.renderCall({ command: "echo hi" }, theme, ctx({ isPartial: true, durationMs: undefined }))),
		}),
	);
}

// ---------------------------------------------------------------- 1. 运行中占位
check("bash 执行中：显示命令行 + running 占位与已用时间", () => {
	const r = renderers("bash");
	const running = ctx({ isPartial: true, durationMs: undefined, state: { startedAt: Date.now() - 1500 } });
	assert.equal(dedent(text(r.renderCall({ command: "sleep 5" }, theme, running))), "$ sleep 5");
	const line = dedent(text(r.renderResult({ content: [] }, { expanded: false, isPartial: true }, theme, running)));
	assert.match(line, /^shell · running \(1\.[5-6]s\)$/, line);
});

check("运行中计时按秒重绘，结束后停止", () => {
	const r = renderers("bash");
	let redraws = 0;
	const running = ctx({
		isPartial: true,
		durationMs: undefined,
		state: { startedAt: Date.now() },
		invalidate: () => redraws++,
	});
	r.renderResult({ content: [] }, { expanded: false, isPartial: true }, theme, running);
	const interval = (running.state as { interval?: ReturnType<typeof setInterval> }).interval;
	assert.ok(interval !== undefined, "运行中未启动重绘计时器");

	const done = ctx({ durationMs: 163, state: running.state });
	r.renderResult({ content: [{ type: "text", text: "hi" }] }, { expanded: false, isPartial: false }, theme, done);
	assert.equal((done.state as { interval?: unknown }).interval, undefined, "结束后计时器未停止");
	clearInterval(interval);
	void redraws;
});

check("无计时起点时降级为无耗时占位", () => {
	const r = renderers("bash");
	const running = ctx({ isPartial: true, executionStarted: false, durationMs: undefined, state: {} });
	const line = dedent(text(r.renderResult({ content: [] }, { expanded: false, isPartial: true }, theme, running)));
	assert.equal(line, "shell · running");
});

// ---------------------------------------------------------------- 2. 超长命令截断
check("bash 超长命令（150 字符）截断为 100 字符 + 省略号", () => {
	const r = renderers("bash");
	const call = dedent(text(r.renderCall({ command: "x".repeat(150) }, theme, ctx({ isPartial: true, durationMs: undefined }))));
	assert.ok(call.endsWith("…"), `未截断: ...${call.slice(-6)}`);
	assert.equal(call.slice(2).length, 101, `正文长度 ${call.slice(2).length}`);
});

// ---------------------------------------------------------------- 3. 多行命令单行化
check("bash 多行命令压成单行", () => {
	const r = renderers("bash");
	const call = dedent(
		text(r.renderCall({ command: "echo 1\necho 2\n\n  echo 3\t" }, theme, ctx({ isPartial: true, durationMs: undefined }))),
	);
	assert.equal(call, "$ echo 1 echo 2 echo 3");
});

// ---------------------------------------------------------------- 4. 结束收起
check("bash 结束后收起为单行摘要，命令行消失", () => {
	const r = renderers("bash");
	const done = ctx({ durationMs: 163 });
	assert.equal(text(r.renderCall({ command: "echo hi" }, theme, done)), "", "renderCall 应收起为空");
	assert.equal(
		dedent(text(r.renderResult({ content: [{ type: "text", text: "hi" }] }, { expanded: false, isPartial: false }, theme, done))),
		"shell (163ms)",
	);
});

// ---------------------------------------------------------------- 5. 出错
check("bash 出错：命令行保留 + 错误块 + 空行压缩", () => {
	usedColors.clear();
	const r = renderers("bash");
	const failed = ctx({ isError: true, durationMs: 12 });
	assert.equal(dedent(text(r.renderCall({ command: "false" }, theme, failed))), "$ false");
	assert.ok(usedColors.has("fg:muted"), "出错命令行未用 muted 着色");

	usedColors.clear();
	const result = text(
		r.renderResult({ content: [{ type: "text", text: "boom\n\n\n\ntrailing" }] }, { expanded: false, isPartial: false }, theme, failed),
	);
	assert.ok(!/\n\s*\n\s*\n/.test(dedent(result)), `出现连续空行: ${JSON.stringify(result)}`);
	assert.equal(dedent(result).replace(/\n+/g, "\n"), "boom\ntrailing");
	assert.ok(usedColors.has("fg:error"), "错误输出未用 error 着色");
	assert.ok(usedColors.has("bg:toolPendingBg"), "错误块缺少背景色");
});

// ---------------------------------------------------------------- 6. 展开
check("bash 展开：命令行 + 输出同块，无耗时", () => {
	const r = renderers("bash");
	const expanded = ctx({ durationMs: 90, args: { command: "ls -la" } });
	assert.equal(text(r.renderCall({ command: "ls -la" }, theme, expanded)), "", "展开态 renderCall 应为空");
	const result = text(r.renderResult({ content: [{ type: "text", text: "a\nb" }] }, { expanded: true, isPartial: false }, theme, expanded));
	assert.equal(dedent(result), "$ ls -la\na\nb");
});

// ---------------------------------------------------------------- 7. 摘要文案
check("各工具收起摘要文案", () => {
	const cases: Array<[string, any, Record<string, unknown>, string]> = [
		["read", { content: [{ type: "text", text: "l1\nl2\nl3" }] }, {}, "read 3 lines (163ms)"],
		["read", { content: [{ type: "text", text: "only" }] }, {}, "read 1 line (163ms)"],
		["grep", { content: [{ type: "text", text: "m1\nm2" }] }, {}, "grep 2 matches (163ms)"],
		["grep", { content: [{ type: "text", text: "m1" }] }, {}, "grep 1 match (163ms)"],
		["find", { content: [{ type: "text", text: "f1" }] }, {}, "found 1 file (163ms)"],
		["ls", { content: [{ type: "text", text: "a\nb\nc" }] }, {}, "ls . · 3 entries (163ms)"],
		["ls", { content: [{ type: "text", text: "a" }] }, { args: { path: "src" } }, "ls src · 1 entry (163ms)"],
	];
	for (const [name, result, overrides, expected] of cases) {
		const r = renderers(name);
		const got = dedent(text(r.renderResult(result, { expanded: false, isPartial: false }, theme, ctx(overrides))));
		assert.equal(got, expected, `${name}: ${got}`);
	}
});

check("read 截断与空行按数据行计数", () => {
	const r = renderers("read");
	const cases: Array<[string, string]> = [
		["l1\nl2\nl3\n\n[120 more lines...]", "read 3 lines (163ms)"],
		["a\n\nb", "read 3 lines (163ms)"],
		["l1\nl2", "read 2 lines (163ms)"],
		["l1\nl2\n", "read 2 lines (163ms)"],
	];
	for (const [output, expected] of cases) {
		const got = dedent(
			text(r.renderResult({ content: [{ type: "text", text: output }] }, { expanded: false, isPartial: false }, theme, ctx())),
		);
		assert.equal(got, expected, JSON.stringify(output));
	}
});

// ---------------------------------------------------------------- 8. 尾部提示行
check("尾部上限/截断提示行不计入条目数", () => {
	const cases: Array<[string, string, string]> = [
		["ls", "a\nb\nc\n\n[500 entries limit reached. Use limit=1000 for more]", "ls . · 3 entries (163ms)"],
		["find", "a.ts\nb.ts\n\n[200 results limit reached. Use limit=400 for more, or refine pattern]", "found 2 files (163ms)"],
		["grep", "a.ts:1:x\nb.ts:2:y\n\n[Some lines truncated to 1000 chars. Use read tool to see full lines]", "grep 2 matches (163ms)"],
	];
	for (const [name, output, expected] of cases) {
		const r = renderers(name);
		const got = dedent(text(r.renderResult({ content: [{ type: "text", text: output }] }, { expanded: false, isPartial: false }, theme, ctx())));
		assert.equal(got, expected, `${name}: ${got}`);
	}
});

// ---------------------------------------------------------------- 9. 表外工具
check("表外工具无上游渲染时套用折叠", () => {
	const generic = renderers("weird-tool");
	const running = ctx({ isPartial: true, durationMs: undefined, state: { startedAt: Date.now() - 1200 }, args: { script: "Get-Process" } });
	assert.equal(dedent(text(generic.renderCall({ script: "Get-Process" }, theme, running))), "weird-tool Get-Process");
	assert.match(
		dedent(text(generic.renderResult({ content: [] }, { expanded: false, isPartial: true }, theme, running))),
		/^weird-tool · running \(1\.[2-3]s\)$/,
	);
	const done = ctx({ args: { script: "Get-Process" }, durationMs: 1200 });
	assert.equal(
		dedent(text(generic.renderResult({ content: [{ type: "text", text: "p1\np2" }] }, { expanded: false, isPartial: false }, theme, done))),
		"weird-tool · 2 lines (1.2s)",
	);
});

// ---------------------------------------------------------------- 10. 上游让位
const UPSTREAM = {
	renderCall: () => ({ render: () => ["UPSTREAM_CALL"], invalidate() {} }),
	renderResult: () => ({ render: () => ["UPSTREAM_RESULT"], invalidate() {} }),
};

check("上游提供任一渲染槽时整体让位", () => {
	assert.equal(renderers("powershell", UPSTREAM), UPSTREAM);
	const onlyCall = { renderCall: UPSTREAM.renderCall };
	assert.equal(renderers("powershell", onlyCall), onlyCall);
	const onlyResult = { renderResult: UPSTREAM.renderResult };
	assert.equal(renderers("powershell", onlyResult), onlyResult);
	const image = renderers("powershell", onlyResult);
	assert.equal(
		text(image.renderResult({ content: [{ type: "image", data: "x", mimeType: "image/png" }] }, { expanded: false, isPartial: false }, theme, ctx())),
		"UPSTREAM_RESULT",
	);
});

check("上游没有渲染槽时仍用折叠", () => {
	const generic = renderers("weird-tool", {});
	assert.equal(
		dedent(text(generic.renderResult({ content: [{ type: "text", text: "a\nb" }] }, { expanded: false, isPartial: false }, theme, ctx()))),
		"weird-tool · 2 lines (163ms)",
	);
	// next() 返回 undefined 时同样退化到折叠。
	assert.equal(
		dedent(text(renderers("another-tool").renderResult({ content: [] }, { expanded: false, isPartial: false }, theme, ctx()))),
		"another-tool · 0 lines (163ms)",
	);
});

check("定制表优先于上游渲染", () => {
	for (const name of ["bash", "read"]) {
		const custom = renderers(name, UPSTREAM);
		assert.notEqual(custom, UPSTREAM);
		assert.equal(typeof custom.renderResult, "function");
	}
});

check("无上游渲染槽的图片结果由 Pi 独立渲染", () => {
	const generic = renderers("image-tool");
	assert.equal(
		dedent(text(generic.renderResult({ content: [{ type: "image", data: "x", mimeType: "image/png" }] }, { expanded: false, isPartial: false }, theme, ctx()))),
		"image-tool · 0 lines (163ms)",
	);
});

// ---------------------------------------------------------------- 11. read 图片
check("read 读取图片时摘要显示 read image", () => {
	const r = renderers("read");
	assert.equal(
		dedent(
			text(
				r.renderResult(
					{ content: [{ type: "text", text: "Read image file [image/png]" }, { type: "image", data: "x", mimeType: "image/png" }] },
					{ expanded: false, isPartial: false },
					theme,
					ctx({ args: { path: "a.png" } }),
				),
			),
		),
		"read image (163ms)",
	);
	// 图片块与多行文本共存时仍按图片处理。
	assert.equal(
		dedent(
			text(
				r.renderResult(
					{ content: [{ type: "text", text: "a\nb\nc" }, { type: "image", data: "x", mimeType: "image/png" }] },
					{ expanded: false, isPartial: false },
					theme,
					ctx({ args: { path: "a.png" } }),
				),
			),
		),
		"read image (163ms)",
	);
});

// ---------------------------------------------------------------- 12. Ctrl+O 一致性
check("Ctrl+O 展开：各工具均显示命令行 + 内容", () => {
	const argsByName: Record<string, any> = {
		bash: { command: "cmd" },
		read: { path: "a.ts" },
		grep: { pattern: "p" },
		find: { pattern: "p" },
		ls: { path: "." },
	};
	for (const [name, args] of Object.entries(argsByName)) {
		const r = renderers(name);
		const expanded = ctx({ expanded: true, args });
		assert.equal(text(r.renderCall(args, theme, expanded)), "", `${name} 展开态 renderCall 应为空`);
		const got = dedent(text(r.renderResult({ content: [{ type: "text", text: "x" }] }, { expanded: true, isPartial: false }, theme, expanded)));
		assert.notEqual(got, "x", `${name} 展开块缺少命令行`);
	}
});

// ---------------------------------------------------------------- 13. edit / write
check("edit 展示 diff：统计 + 超过 30 行截断提示", () => {
	const edit = renderers("edit");
	const diff = `-1 old\n+1 new\n${Array.from({ length: 40 }, (_, i) => `+${i + 2} line`).join("\n")}\n`;
	const out = dedent(
		text(edit.renderResult({ content: [{ type: "text", text: "ok" }], details: { diff } }, { expanded: false, isPartial: false }, theme, ctx({ args: { path: "C:/tmp/a.ts" } }))),
	);
	assert.ok(out.startsWith("edit C:/tmp/a.ts"), out);
	assert.ok(out.includes("└ Added 41 lines, removed 1 line"), out);
	assert.ok(out.includes("more lines, ctrl+o to expand"), out);
});

check("展开提示使用 keybinding 配置", () => {
	const edit = renderers("edit");
	const diff = Array.from({ length: 35 }, (_, i) => `+${i + 1} line`).join("\n");
	const out = dedent(
		text(
			edit.renderResult(
				{ content: [{ type: "text", text: "ok" }], details: { diff } },
				{ expanded: false, isPartial: false },
				theme,
				ctx({ args: { path: "a.ts" }, keyHint: (_key: string, description: string) => `ctrl+shift+o ${description}` }),
			),
		),
	);
	assert.ok(out.includes("ctrl+shift+o to expand"), out);
});

check("diff 组件同宽度重复渲染结果一致", () => {
	const edit = renderers("edit");
	const component = edit.renderResult(
		{ content: [{ type: "text", text: "ok" }], details: { diff: "-1 old\n+1 new" } },
		{ expanded: false, isPartial: false },
		theme,
		ctx({ args: { path: "a.ts" } }),
	);
	assert.deepEqual(component.render(40), component.render(40));
});

check("工具输出清洗 ANSI 与回车", () => {
	const r = renderers("bash");
	const out = text(
		r.renderResult(
			{ content: [{ type: "text", text: "\x1b[31mboom\x1b[0m\r\nnext" }] },
			{ expanded: true, isPartial: false },
			theme,
			ctx({ expanded: true, args: { command: "false" } }),
		),
	);
	assert.equal(out.includes("\x1b[31m"), false, JSON.stringify(out));
	assert.equal(out.includes("\r"), false, JSON.stringify(out));
	assert.ok(out.includes("boom"), JSON.stringify(out));
	assert.ok(out.includes("next"), JSON.stringify(out));
});

check("outputPad=0 时展开块不额外缩进", () => {
	const r = renderers("bash");
	const lines = r
		.renderResult(
			{ content: [{ type: "text", text: "x" }] },
			{ expanded: true, isPartial: false },
			theme,
			ctx({ expanded: true, outputPad: 0, durationMs: 90, args: { command: "ls" } }),
		)
		.render(40)
		.map(stripTerminalSequences);
	assert.ok(lines[0]!.startsWith("$ ls"), JSON.stringify(lines[0]));
});

check("diff 长行折行后单行仍不超宽", () => {
	const edit = renderers("edit");
	const diff = `+1 ${"x".repeat(120)}`;
	const component = edit.renderResult(
		{ content: [{ type: "text", text: "ok" }], details: { diff } },
		{ expanded: false, isPartial: false },
		theme,
		ctx({ args: { path: "a.ts" } }),
	);
	for (const line of component.render(40)) {
		assert.ok(visibleWidth(line) <= 40, `${visibleWidth(line)}: ${JSON.stringify(stripTerminalSequences(line))}`);
	}
});

check("diff 超宽行折成多行，内容完整且续行对齐行号列", () => {
	const edit = renderers("edit");
	const diff = `+127 ${"x".repeat(120)}END`;
	const component = edit.renderResult(
		{ content: [{ type: "text", text: "ok" }], details: { diff } },
		{ expanded: false, isPartial: false },
		theme,
		ctx({ args: { path: "a.ts" } }),
	);
	const lines = component.render(40).map((line: string) => line.replace(/\s+$/, ""));
	const rows = lines.filter((line: string) => line.includes("x"));
	assert.ok(rows.length > 1, `长行应折成多行：${JSON.stringify(rows)}`);
	assert.ok(rows[0]!.trimStart().startsWith("+127 "), JSON.stringify(rows[0]));
	assert.equal(rows[1]!.indexOf("x"), rows[0]!.indexOf("x"), "续行应与首段内容列对齐");
	const body = lines.join("").replace(/\s+/g, "");
	assert.ok(body.includes(`${"x".repeat(120)}END`), "折行后不得丢字符");
});

check("diff 折行不劈开宽字符", () => {
	const edit = renderers("edit");
	const content = "中".repeat(60);
	const component = edit.renderResult(
		{ content: [{ type: "text", text: "ok" }], details: { diff: `+1 ${content}` } },
		{ expanded: false, isPartial: false },
		theme,
		ctx({ args: { path: "a.ts" } }),
	);
	const lines = component.render(41).map((line: string) => line.replace(/\s+$/, ""));
	for (const line of lines) assert.ok(visibleWidth(line) <= 41, `${visibleWidth(line)}`);
	for (const row of lines.filter((line: string) => line.includes("中"))) {
		assert.match(row.trim().replace(/^\+1 /, ""), /^中+$/, `每行只能是完整的宽字符：${JSON.stringify(row)}`);
	}
	assert.ok(lines.join("").replace(/\s+/g, "").includes(content), "宽字符不得被折行拆散");
});

check("折行宽度极窄时仍不越过渲染宽度", () => {
	const edit = renderers("edit");
	const component = edit.renderResult(
		{ content: [{ type: "text", text: "ok" }], details: { diff: `+1 ${"中".repeat(5)}` } },
		{ expanded: false, isPartial: false },
		theme,
		ctx({ args: { path: "a.ts" } }),
	);
	// component 宽 3 时 DiffLines 只剩 1 列，覆盖退化为截断的分支；组件宽 1 时 Pi 自己的盒内边距就放不下，不在本组断言内。
	for (const width of [2, 3, 4, 6]) {
		for (const line of component.render(width)) {
			assert.ok(visibleWidth(line) <= width, `width=${width} 渲染出 ${visibleWidth(line)} 列：${JSON.stringify(line)}`);
		}
	}
});

check("收起态单行折行有上限，末段以省略号收尾；展开后显示全文", () => {
	const edit = renderers("edit");
	const content = `${"w".repeat(60)} `.repeat(40);
	const rows = (expanded: boolean) => {
		const component = edit.renderResult(
			{ content: [{ type: "text", text: "ok" }], details: { diff: `+1 ${content}` } },
			{ expanded, isPartial: false },
			theme,
			ctx({ args: { path: "a.ts" } }),
		);
		return component.render(40).map((line: string) => line.replace(/\s+$/, ""));
	};
	const collapsed = rows(false).filter((line: string) => line.includes("w"));
	assert.equal(collapsed.length, 20, `收起态单行应限在 20 行：${collapsed.length}`);
	assert.ok(collapsed[19]!.endsWith("…"), JSON.stringify(collapsed[19]));
	for (const line of collapsed) assert.ok(visibleWidth(line) <= 40, `${visibleWidth(line)}`);
	const expanded = rows(true).filter((line: string) => line.includes("w"));
	assert.ok(expanded.length > 20, `展开后应显示全文：${expanded.length}`);
	assert.ok(!expanded.some((line: string) => line.endsWith("…")), "展开后不应再接截止标记");
	assert.ok(
		expanded.join("").replace(/\s+/g, "").includes(content.replace(/\s+/g, "")),
		"展开后不得丢字符",
	);
});

check("diff 折行时 context 行的续行对齐内容列", () => {
	const edit = renderers("edit");
	const content = "const value = someFunction(alpha, beta, gamma, delta, epsilon, zeta);";
	const component = edit.renderResult(
		{ content: [{ type: "text", text: "ok" }], details: { diff: ` 12 ${content}` } },
		{ expanded: false, isPartial: false },
		theme,
		ctx({ args: { path: "a.ts" } }),
	);
	const lines = component.render(40).map((line: string) => line.replace(/\s+$/, ""));
	const rows = lines.filter((line: string) => /someFunction|alpha|beta|gamma|delta|epsilon|zeta/.test(line));
	assert.ok(rows.length > 1, `context 长行应折成多行：${JSON.stringify(rows)}`);
	assert.ok(rows[0]!.includes(" 12 "), JSON.stringify(rows[0]));
	assert.equal(rows[1]!.search(/\S/), rows[0]!.indexOf("const"), "续行应与内容列对齐");
	const body = lines.join("").replace(/\s+/g, "");
	assert.ok(body.includes(content.replace(/\s+/g, "")), "折行后不得丢字符");
});

check("diff 折行后词级高亮仍落在变化片段上", () => {
	const edit = renderers("edit");
	const seen: Array<{ text: string; bg?: string }> = [];
	const markTheme = {
		appearance: "dark",
		fg: (_name: string, value: string) => value,
		bg: (_name: string, value: string) => value,
		bold: (value: string) => value,
		style(value: string, opts: { fg?: string; bg?: string }) {
			seen.push({ text: value, bg: opts.bg });
			return value;
		},
	};
	const diff = `-1 ${"a".repeat(100)}OLD\n+1 ${"a".repeat(100)}NEW`;
	const component = edit.renderResult(
		{ content: [{ type: "text", text: "ok" }], details: { diff } },
		{ expanded: false, isPartial: false },
		markTheme,
		ctx({ args: { path: "a.ts" } }),
	);
	const lines = component.render(40).map((line: string) => line.replace(/\s+$/, ""));
	const body = lines.join("").replace(/\s+/g, "");
	assert.ok(body.includes(`${"a".repeat(100)}OLD`), body);
	assert.ok(body.includes(`${"a".repeat(100)}NEW`), body);
	// 变化后缀单独成段且用更亮的底色；其余片段用行级底色。
	const changed = seen.find((entry) => entry.text === "NEW");
	assert.ok(changed, `变化片段应独立上色：${JSON.stringify(seen)}`);
	const plain = seen.find((entry) => entry.text.includes("aaa"));
	assert.ok(plain, "未变化片段应成段");
	assert.notEqual(changed!.bg, plain!.bg, "变化片段应使用更亮的底色");
});

check("diff 中的 tab 展开为 3 个空格", () => {
	const edit = renderers("edit");
	const diff = "-1 \told\n+1 \tnew";
	const out = dedent(
		text(edit.renderResult({ content: [{ type: "text", text: "ok" }], details: { diff } }, { expanded: false, isPartial: false }, theme, ctx({ args: { path: "a.ts" } }))),
	);
	assert.equal(out.includes("\t"), false, JSON.stringify(out));
	assert.match(out, /-1 {4}old/);
	assert.match(out, /\+1 {4}new/);
});

check("diff 长行带词级高亮时不超宽", () => {
	const edit = renderers("edit");
	const diff = `-1 ${"a".repeat(100)}OLD\n+1 ${"a".repeat(100)}NEW`;
	const component = edit.renderResult(
		{ content: [{ type: "text", text: "ok" }], details: { diff } },
		{ expanded: false, isPartial: false },
		theme,
		ctx({ args: { path: "a.ts" } }),
	);
	for (const line of component.render(40)) {
		assert.ok(visibleWidth(line) <= 40, `${visibleWidth(line)}: ${JSON.stringify(stripTerminalSequences(line))}`);
	}
});

check("shortenPath 只缩写完整的 home 前缀", () => {
	const edit = renderers("edit");
	const home = homedir().replace(/\\/g, "/").replace(/\/+$/, "");
	const inside = `${home}/project/a.ts`;
	const sibling = `${home}by/a.ts`;
	const title = (path: string) =>
		dedent(
			text(
				edit.renderResult(
					{ content: [{ type: "text", text: "ok" }], details: { diff: "" } },
					{ expanded: false, isPartial: false },
					theme,
					ctx({ args: { path } }),
				),
			),
		);
	assert.ok(title(inside).includes("~/project/a.ts"), title(inside));
	assert.ok(title(sibling).includes(sibling), title(sibling));
});

check("write 展示写入预览：行数 + 超过 10 行截断提示", () => {
	const write = renderers("write");
	const content = Array.from({ length: 15 }, (_, i) => `line${i}`).join("\n");
	const out = dedent(
		text(write.renderResult({ content: [{ type: "text", text: "ok" }] }, { expanded: false, isPartial: false }, theme, ctx({ args: { path: "C:/tmp/b.ts", content } }))),
	);
	assert.ok(out.startsWith("write C:/tmp/b.ts"), out);
	assert.ok(out.includes("└ Wrote 15 lines"), out);
	assert.ok(out.includes("(5 more lines, ctrl+o to expand)"), out);
});

check("write 预览同样折行显示全文", () => {
	const write = renderers("write");
	const long = `const meta = { key: "value", another: "${"a".repeat(80)}" };`;
	const component = write.renderResult(
		{ content: [{ type: "text", text: "ok" }] },
		{ expanded: false, isPartial: false },
		theme,
		ctx({ args: { path: "b.ts", content: long } }),
	);
	const lines = component.render(40).map((line: string) => line.replace(/\s+$/, ""));
	for (const line of lines) assert.ok(visibleWidth(line) <= 40, `${visibleWidth(line)}`);
	const rows = lines.filter((line: string) => line.includes("aaa"));
	assert.ok(rows.length > 1, `预览长行应折成多行：${JSON.stringify(rows)}`);
	// 续行缩进 = 盒内边距 1 + `+ ` 前缀 2。
	assert.equal(rows[1]!.length - rows[1]!.trimStart().length, 3, "续行应与内容列对齐");
	const body = lines.join("").replace(/\s+/g, "");
	assert.ok(body.includes("a".repeat(80)), "折行后不得丢字符");
});

// ---------------------------------------------------------------- 14. 中断
check("执行中中断（Esc）：转为错误块，不残留 running", () => {
	const r = renderers("bash");
	const aborted = ctx({ isError: true, durationMs: 2500, args: { command: "sleep 30" } });
	const out = dedent(
		text(r.renderResult({ content: [{ type: "text", text: "Operation aborted" }] }, { expanded: false, isPartial: false }, theme, aborted)),
	);
	assert.ok(!out.includes("running"), `残留 running: ${out}`);
	assert.ok(out.includes("Operation aborted"), out);
});

// ---------------------------------------------------------------- 15. args 未就绪
check("args 缺失时不抛错（会话重建场景）", () => {
	for (const name of ["bash", "read", "write", "edit", "grep", "find", "ls", "powershell"]) {
		const r = renderers(name);
		const c = ctx({ args: undefined });
		r.renderCall(undefined, theme, c);
		r.renderResult({ content: [] }, { expanded: false, isPartial: false }, theme, c);
	}
});

// ---------------------------------------------------------------- 16. 思考块标签
check("session_start 设置正体的隐藏思考标签", () => {
	const label = hiddenThinkingLabel!;
	assert.ok(label.startsWith("\x1b[0m"), JSON.stringify(label));
	assert.ok(label.endsWith("\x1b[38;2;153;153;153mThinking..."), JSON.stringify(label));
	assert.ok(label.includes("\x1b[38;2;153;153;153m"), JSON.stringify(label));
});

check("隐藏思考标签在 pi 的斜体包裹下不再显示为斜体", () => {
	chalk.level = 3;
	// 复现 assistant-message 的 theme.italic(theme.fg("thinkingText", label))。
	const composed = chalk.italic(`\x1b[38;2;153;153;153m${hiddenThinkingLabel!}\x1b[39m`);
	const labelStart = composed.indexOf("Thinking...");
	assert.ok(labelStart >= 0, JSON.stringify(composed));
	let italic = false;
	for (const match of composed.slice(0, labelStart).matchAll(/\x1b\[([0-9;]*)m/g)) {
		const codes = match[1].split(";").map(Number);
		if (codes.includes(0)) italic = false;
		if (codes.includes(3)) italic = true;
		if (codes.includes(23)) italic = false;
	}
	assert.equal(italic, false, JSON.stringify(composed));
});

// ---------------------------------------------------------------- 17. 上游渲染器换壳
check("搜索类工具沿用上游渲染、换成 self 壳并补回缩进", () => {
	for (const name of ["web_search", "fetch_content", "get_search_content"]) {
		const r = renderers(name, UPSTREAM);
		assert.notEqual(r, UPSTREAM);
		assert.equal(r.renderShell, "self");
		// Pi 的默认壳会给行套 toolPendingBg/SuccessBg/ErrorBg 背景；self 壳不再设置。
		assert.equal(text(r.renderCall({}, theme, ctx())), " UPSTREAM_CALL");
		assert.equal(
			text(r.renderResult({ content: [] }, { expanded: false, isPartial: false }, theme, ctx())),
			" UPSTREAM_RESULT",
		);
	}
	// 表外但不在列表内的工具仍整体让位，保持原有底色与上游排版。
	assert.equal(renderers("mcp__sqlite__query", UPSTREAM), UPSTREAM);
});

check("搜索类工具上游缺一个渲染槽时不换壳", () => {
	// 单槽下 self 壳拿不到缩进，展开并块也没有调用行可以补回，因此整体让位给上游。
	const onlyResult = { renderResult: UPSTREAM.renderResult };
	assert.equal(renderers("web_search", onlyResult), onlyResult);
	const onlyCall = { renderCall: UPSTREAM.renderCall };
	assert.equal(renderers("fetch_content", onlyCall), onlyCall);
});

check("搜索类工具上游返回 Box 时缩进叠加且不超宽", () => {
	// pi-web-access 的错误分支返回自带内边距与背景的 Box。
	const upstream = {
		renderCall: () => new Text("search 1 query", 0, 0),
		renderResult: () => {
			const box = new Box(1, 0, (line: string) => theme.bg("toolErrorBg", line));
			box.addChild(new Text(theme.fg("error", "Error: boom"), 0, 0));
			return box;
		},
	};
	const r = renderers("web_search", upstream);
	const out = text(r.renderResult({ content: [] }, { expanded: false, isPartial: false }, theme, ctx()));
	// 外层补 outputPad(1)，上游 Box 自带 1 格内边距。
	assert.equal(out, "  Error: boom");
	for (const line of out.split("\n")) assert.ok(visibleWidth(line) <= 200, JSON.stringify(line));
});

check("fetch_content answer 模式的长文本折行后不超宽", () => {
	const answer = "长答案文本".repeat(60);
	const upstream = {
		renderCall: () => new Text("fetch 1 URL", 0, 0),
		renderResult: () => new Text(answer, 0, 0),
	};
	const r = renderers("fetch_content", upstream);
	const lines = r
		.renderResult({ content: [] }, { expanded: false, isPartial: false }, theme, ctx())
		.render(80);
	assert.ok(lines.length > 1, "长文本应折行");
	for (const line of lines) assert.ok(visibleWidth(line.replace(/\s+$/, "")) <= 80, JSON.stringify(line));
	assert.equal(lines.map((line: string) => line.trim()).join(""), answer);
});

check("outputPad=0 时换壳后仍齐左", () => {
	const upstream = {
		renderCall: () => new Text("search 1 query", 0, 0),
		renderResult: () => new Text("status", 0, 0),
	};
	const r = renderers("web_search", upstream);
	assert.notEqual(r, upstream);
	assert.equal(text(r.renderCall({}, theme, ctx({ outputPad: 0 }))), "search 1 query");
});

check("搜索类工具只在展开且已结束时铺 toolPendingBg 块", () => {
	const upstream = {
		renderCall: () => new Text("fetch 1 URL", 0, 0),
		renderResult: () => new Text("status\npreview", 0, 0),
	};
	const r = renderers("fetch_content", upstream);
	const cases: Array<{ options: { expanded: boolean; isPartial: boolean }; expectsBg: boolean }> = [
		{ options: { expanded: true, isPartial: false }, expectsBg: true },
		{ options: { expanded: false, isPartial: false }, expectsBg: false },
		{ options: { expanded: true, isPartial: true }, expectsBg: false },
	];
	for (const { options, expectsBg } of cases) {
		usedColors.clear();
		text(r.renderResult({ content: [] }, options, theme, ctx(options)));
		assert.equal(usedColors.has("bg:toolPendingBg"), expectsBg, JSON.stringify(options));
	}
});

check("展开且成功时调用行并进结果块，只剩一块背景区域", () => {
	const r = renderers("web_search", UPSTREAM);
	const expanded = { expanded: true, isPartial: false };
	const context = ctx(expanded);
	// 调用行不再单独占一行，其内容由结果块里的上游 renderCall 提供。
	assert.equal(text(r.renderCall({}, theme, context)), "");
	usedColors.clear();
	assert.equal(text(r.renderResult({ content: [] }, expanded, theme, context)), " UPSTREAM_CALL\n UPSTREAM_RESULT");
	assert.ok(usedColors.has("bg:toolPendingBg"), "展开块缺少背景色");
});

check("展开且出错时调用行仍单独渲染，结果块仍铺底", () => {
	const r = renderers("web_search", UPSTREAM);
	const expanded = { expanded: true, isPartial: false };
	const context = ctx({ ...expanded, isError: true });
	assert.equal(text(r.renderCall({}, theme, context)), " UPSTREAM_CALL");
	usedColors.clear();
	assert.equal(text(r.renderResult({ content: [] }, expanded, theme, context)), " UPSTREAM_RESULT");
	assert.ok(usedColors.has("bg:toolPendingBg"), "错误展开块缺少背景色");
});

check("运行中不并块且不铺底", () => {
	const r = renderers("fetch_content", UPSTREAM);
	const running = { expanded: true, isPartial: true };
	const context = ctx(running);
	assert.equal(text(r.renderCall({}, theme, context)), " UPSTREAM_CALL");
	usedColors.clear();
	assert.equal(text(r.renderResult({ content: [] }, running, theme, context)), " UPSTREAM_RESULT");
	assert.equal(usedColors.size, 0, [...usedColors].join(","));
});

finish();
