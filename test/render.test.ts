/**
 * minimal-tools 渲染逻辑验证：直接调用扩展注册的 renderCall / renderResult，断言渲染出的字符串。
 *
 * 运行：npx tsx test/render.test.ts
 */
import assert from "node:assert";
import extend from "../extensions/minimal-tools/index.ts";

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
		handler({}, { ui: { setHiddenThinkingLabel: (v: string) => (hiddenThinkingLabel = v) } });
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

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, fn: () => void) {
	try {
		fn();
		results.push({ name, ok: true });
	} catch (error) {
		results.push({ name, ok: false, detail: (error as Error).message });
	}
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
check("bash 执行中：显示命令行 + running 占位", () => {
	const r = renderers("bash");
	const running = ctx({ isPartial: true, durationMs: undefined });
	assert.equal(dedent(text(r.renderCall({ command: "sleep 5" }, theme, running))), "$ sleep 5");
	assert.equal(dedent(text(r.renderResult({ content: [] }, { expanded: false, isPartial: true }, theme, running))), "shell · running");
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
check("表外工具（powershell）套用折叠渲染", () => {
	const generic = renderers("powershell");
	const running = ctx({ isPartial: true, durationMs: undefined, args: { script: "Get-Process" } });
	assert.equal(dedent(text(generic.renderCall({ script: "Get-Process" }, theme, running))), "powershell Get-Process");
	assert.equal(dedent(text(generic.renderResult({ content: [] }, { expanded: false, isPartial: true }, theme, running))), "powershell · running");
	const done = ctx({ args: { script: "Get-Process" }, durationMs: 1200 });
	assert.equal(
		dedent(text(generic.renderResult({ content: [{ type: "text", text: "p1\np2" }] }, { expanded: false, isPartial: false }, theme, done))),
		"powershell · 2 lines (1.2s)",
	);
});

// ---------------------------------------------------------------- 10. 富内容回退
check("表外工具含图片时回交内置渲染", () => {
	const base = {
		renderResult: () => ({
			render: () => ["BASE_RENDER"],
			invalidate() {},
		}),
	};
	const generic = renderers("weird-tool", base);
	assert.equal(
		text(generic.renderResult({ content: [{ type: "image", data: "x", mimeType: "image/png" }] }, { expanded: false, isPartial: false }, theme, ctx())),
		"BASE_RENDER",
	);
});

// ---------------------------------------------------------------- 11. read 图片
check("read 读取图片时摘要可用（图片由 Pi 独立渲染）", () => {
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
		"read 1 line (163ms)",
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
check("session_start 设置隐藏思考标签为 ' Thinking...'", () => {
	assert.equal(hiddenThinkingLabel, " Thinking...");
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
	console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `\n      ${r.detail}` : ""}`);
}
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
