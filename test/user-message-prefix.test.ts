/**
 * user-message-prefix 渲染逻辑验证。
 *
 * 运行：node_modules/.bin/jiti test/user-message-prefix.test.ts
 */
import assert from "node:assert";
import { UserMessageComponent, getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { installUserMessagePrefix, prefixFirstContentLine } from "../extensions/user-message-prefix/index.ts";

initTheme("dark", false);
installUserMessagePrefix();
installUserMessagePrefix();

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, fn: () => void) {
	try {
		fn();
		results.push({ name, ok: true });
	} catch (error) {
		results.push({ name, ok: false, detail: (error as Error).message });
	}
}

function visibleLines(text: string, width = 40): string[] {
	return new UserMessageComponent(text, getMarkdownTheme(), 1)
		.render(width)
		.map((line) => stripTerminalSequences(line).trim());
}

function rawLines(text: string, width = 40): string[] {
	return new UserMessageComponent(text, getMarkdownTheme(), 1)
		.render(width)
		.map(stripTerminalSequences);
}

/** 首个可见字符所在的列。 */
function contentColumn(line: string): number {
	return line.length - line.trimStart().length;
}

function contentLines(text: string, width = 40): string[] {
	return rawLines(text, width).filter((line) => line.trim() !== "");
}

check("普通文本首行带 `› ` 前缀", () => {
	const lines = visibleLines("hello world").filter(Boolean);
	assert.equal(lines[0], "› hello world");
});

check("重复安装不叠加前缀", () => {
	const lines = visibleLines("hello world").filter(Boolean);
	assert.equal(lines[0], "› hello world");
});

check("代码块首行带前缀，正文与围栏保持完整", () => {
	const lines = visibleLines("```ts\nconst a = 1;\n```").filter(Boolean);
	assert.equal(lines[0], "› ```ts");
	assert.ok(lines.includes("const a = 1;"), lines.join("\n"));
	assert.equal(lines[lines.length - 1], "```");
});

check("多行消息只给首行加前缀", () => {
	const lines = visibleLines("line1\nline2").filter(Boolean);
	assert.deepEqual(lines, ["› line1", "line2"]);
});

check("换行后的内容与首行内容列对齐", () => {
	const lines = contentLines("一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十", 40);
	assert.ok(lines.length > 1, lines.join("\n"));
	assert.ok(lines[0]!.startsWith("› "), lines[0]);
	for (const line of lines.slice(1)) assert.equal(contentColumn(line), 2, line);
});

check("多行消息的所有内容列对齐", () => {
	const lines = contentLines("line1\nline2\nline3");
	assert.equal(lines[0]!.trim(), "› line1");
	assert.deepEqual(
		lines.slice(1).map((line) => contentColumn(line)),
		[2, 2],
	);
});

check("代码块整体右移，围栏与正文的相对缩进不变", () => {
	const lines = contentLines("```ts\nconst a = 1;\n```");
	const codeIndent = visibleWidth(getMarkdownTheme().codeBlockIndent ?? "  ");
	assert.equal(lines[0]!.trim(), "› ```ts");
	assert.equal(contentColumn(lines[1]!), 2 + codeIndent);
	assert.equal(contentColumn(lines[2]!), 2);
});

check("缩进后每行宽度不超过目标宽度", () => {
	const width = 40;
	const text = "一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十";
	for (const line of rawLines(text, width)) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`);
});

check("原有引用块与列表结构不变", () => {
	const lines = visibleLines("> quote\n\n- item").filter(Boolean);
	assert.deepEqual(lines, ["› │ quote", "- item"]);
});

check("前缀不改变渲染宽度", () => {
	const width = 40;
	for (const text of ["hello world", "```ts\nconst a = 1;\n```", "\n\nhello"]) {
		for (const line of new UserMessageComponent(text, getMarkdownTheme(), 1).render(width)) {
			assert.ok(visibleWidth(line) <= width, `${JSON.stringify(text)}: ${visibleWidth(line)} > ${width}`);
		}
	}
});

check("没有可见内容时保持原样", () => {
	const lines = ["   ", "\x1b[48;2;1;2;3m   \x1b[49m"];
	assert.deepEqual(prefixFirstContentLine(lines, "› "), lines);
});

check("行首无内边距时仍插入并回收行尾空格", () => {
	const line = "\x1b[48;2;1;2;3mhello   \x1b[49m";
	const [prefixed] = prefixFirstContentLine([line], "› ");
	assert.equal(stripTerminalSequences(prefixed).trim(), "› hello");
	assert.equal(visibleWidth(prefixed), visibleWidth(line));
});

check("用户消息不再铺背景色", () => {
	for (const text of ["hello world", "```ts\nconst a = 1;\n```"]) {
		for (const line of new UserMessageComponent(text, getMarkdownTheme(), 1).render(40)) {
			assert.ok(!/\x1b\[(?:4[0-7]|10[0-7]|48;|49m)/.test(line), JSON.stringify(line));
		}
	}
});

check("去掉背景色后行宽与内容不变", () => {
	for (const line of rawLines("hello world", 40)) assert.equal(visibleWidth(line), 40, JSON.stringify(line));
	const lines = visibleLines("```ts\nconst a = 1;\n```").filter(Boolean);
	assert.equal(lines[0], "› ```ts");
	assert.ok(lines.includes("const a = 1;"), lines.join("\n"));
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
	console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `\n      ${r.detail}` : ""}`);
}
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
