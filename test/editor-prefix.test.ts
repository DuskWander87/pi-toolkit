/**
 * message-marks 输入框部分（PromptPrefixEditor）渲染逻辑验证。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { getSelectListTheme, initTheme, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { PromptPrefixEditor } from "../extensions/render/message-marks/index.ts";
import { check, finish } from "./harness.ts";

initTheme("dark", false);

const tui = { terminal: { rows: 40 }, requestRender() {}, setFocus() {} } as unknown as TUI;
const keybindings = { matches: () => false } as unknown as KeybindingsManager;
const editorTheme = { borderColor: (text: string) => text, selectList: getSelectListTheme() } as unknown as EditorTheme;

function renderText(text: string, width = 40, paddingX = 0, focused = true): string[] {
	const editor = new PromptPrefixEditor(tui, editorTheme, keybindings);
	editor.setPaddingX(paddingX);
	editor.setText(text);
	editor.focused = focused;
	return editor.render(width).map(stripTerminalSequences);
}

function contentColumn(line: string): number {
	return line.length - line.trimStart().length;
}

check("空输入框首行以 `› ` 起头", () => {
	const lines = renderText("");
	assert.ok(lines[1]!.startsWith("› "), JSON.stringify(lines[1]));
});

check("首行文本紧跟 `› `", () => {
	const lines = renderText("hello");
	assert.ok(lines[1]!.startsWith("› hello"), JSON.stringify(lines[1]));
});

check("多行输入后续行缩进到文本列", () => {
	const lines = renderText("line1\nline2");
	assert.ok(lines[2]!.startsWith("  line2"), JSON.stringify(lines[2]));
});

check("换行后的内容列与首行文本列一致", () => {
	const lines = renderText("一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十");
	const content = lines.slice(1, -1);
	assert.ok(content.length > 1, content.join("\n"));
	for (const line of content.slice(1)) assert.equal(contentColumn(line), 2, JSON.stringify(line));
});

check("渲染行宽度保持不变", () => {
	const width = 40;
	for (const text of ["", "hello", "一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十"]) {
		for (const line of renderText(text, width)) assert.equal(visibleWidth(line), width, JSON.stringify(text));
	}
});

check("setPaddingX 保留 `› ` 留白，getPaddingX 还原设置值", () => {
	const editor = new PromptPrefixEditor(tui, editorTheme, keybindings);
	for (const padding of [0, 1, 3]) {
		editor.setPaddingX(padding);
		assert.equal(editor.getPaddingX(), padding);
		editor.setText("line1\nline2");
		const lines = editor.render(40).map(stripTerminalSequences);
		assert.ok(lines[1]!.startsWith("›"), `${padding}: ${JSON.stringify(lines[1])}`);
		assert.equal(contentColumn(lines[2]!), 2 + padding, `${padding}: ${JSON.stringify(lines[2])}`);
	}
});

check("窄终端下不插入前缀且宽度不变", () => {
	const lines = renderText("hello", 4);
	assert.ok(!lines[1]!.includes("›"), JSON.stringify(lines[1]));
	for (const line of lines) assert.equal(visibleWidth(line), 4);
});

check("上下边框保持原样", () => {
	const lines = renderText("hello");
	assert.equal(lines[0]!.trim(), "─".repeat(40));
	assert.equal(lines[lines.length - 1]!.trim(), "─".repeat(40));
});

check("与默认输入框一致，工作状态嵌入上边框", () => {
	const editor = new PromptPrefixEditor(tui, editorTheme, keybindings);
	assert.equal(editor.embedWorkingStatus, true);
});

finish();
