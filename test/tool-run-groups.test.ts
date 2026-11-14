/**
 * tool-run-groups 渲染与聚合逻辑验证。
 *
 * 运行：node_modules/.bin/jiti test/tool-run-groups.test.ts
 */
import assert from "node:assert";
import { ToolExecutionComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences } from "@earendil-works/pi-tui";
import extend, {
	ToolRunGroup,
	describeRun,
	groupToolRuns,
	isGroupable,
	summarize,
} from "../extensions/tool-run-groups/index.ts";

initTheme("dark", false);
extend({ on() {}, registerTool() {} } as any);

const WIDTH = 70;

/** 构造真实的工具行，渲染与折叠行为与 Pi 内部一致。 */
function toolRow(toolName: string, toolCallId: string, args: Record<string, unknown> = {}) {
	return new ToolExecutionComponent(
		toolName,
		toolCallId,
		args,
		{},
		{},
		{ requestRender() {} },
		process.cwd(),
	);
}

function bashRow(id: string, command: string) {
	return toolRow("bash", id, { command });
}

/** 回填结果，让工具行进入结束态（默认构造出来的是执行中）。 */
function finish(row: ToolExecutionComponent, isError = false): ToolExecutionComponent {
	row.updateResult(
		{ content: [{ type: "text", text: isError ? "boom" : "ok" }], isError, details: {} } as any,
		false,
	);
	return row;
}

function finishedBash(id: string, command: string): ToolExecutionComponent {
	return finish(bashRow(id, command));
}

function plain(lines: string[]): string[] {
	return lines.map((line) => stripTerminalSequences(line));
}

function fakeMode(rows: unknown[], expanded = false) {
	const container = new Container();
	for (const row of rows) container.addChild(row as any);
	return { chatContainer: container, toolOutputExpanded: expanded, ui: { requestRender() {} } };
}

function groupOf(mode: { chatContainer: Container }): ToolRunGroup {
	const groups = mode.chatContainer.children.filter((child) => child instanceof ToolRunGroup);
	assert.equal(groups.length, 1, "应恰好生成一个聚合组件");
	return groups[0] as ToolRunGroup;
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

check("按首次出现顺序汇总，shell 用 command 作量词", () => {
	assert.equal(summarize(["bash", "read", "bash"]), "2 shell commands, 1 read call");
	assert.equal(summarize(["bash"]), "1 shell command");
	assert.equal(summarize(["read", "read"]), "2 read calls");
	assert.equal(summarize(["grep", "find", "ls"]), "1 grep call, 1 find call, 1 ls call");
});

check("edit / write 与单条调用不聚合", () => {
	assert.equal(isGroupable(["bash", "edit"]), false);
	assert.equal(isGroupable(["write", "read"]), false);
	assert.equal(isGroupable(["bash"]), false);
	assert.equal(isGroupable(["bash", "grep"]), true);
});

check("摘要带思考耗时时四舍五入到秒", () => {
	assert.equal(describeRun(["bash", "bash"], 2400), "Thought for 2s, ran 2 shell commands");
	assert.equal(describeRun(["bash", "bash"], 40), "Thought for 1s, ran 2 shell commands");
	assert.equal(describeRun(["bash", "bash"]), "ran 2 shell commands");
});

check("相邻工具行合并为一个聚合组件", () => {
	const mode = fakeMode([
		finishedBash("c1", "ls"),
		finishedBash("c2", "pwd"),
		finishedBash("c3", "whoami"),
	]);
	groupToolRuns(mode);
	assert.equal(mode.chatContainer.children.length, 1);
	const group = groupOf(mode);
	assert.equal(group.children.length, 3);
});

check("单条调用与含 edit 的连续行保持原样", () => {
	const single = fakeMode([bashRow("c1", "ls")]);
	groupToolRuns(single);
	assert.equal(single.chatContainer.children.length, 1);
	assert.ok(single.chatContainer.children[0] instanceof ToolExecutionComponent);

	const mixed = fakeMode([bashRow("c1", "ls"), toolRow("edit", "c2", { path: "a.ts" })]);
	groupToolRuns(mixed);
	assert.equal(mixed.chatContainer.children.length, 2);
	assert.ok(mixed.chatContainer.children.every((child) => child instanceof ToolExecutionComponent));
});

check("被非工具行分隔的连续段各自聚合", () => {
	const mode = fakeMode([bashRow("c1", "ls"), bashRow("c2", "pwd"), new Container(), bashRow("c3", "id"), bashRow("c4", "date")]);
	groupToolRuns(mode);
	assert.equal(mode.chatContainer.children.length, 3);
	const groups = mode.chatContainer.children.filter((child) => child instanceof ToolRunGroup);
	assert.equal(groups.length, 2);
});

check("收起态是空行 + 一行摘要，缩进到标记栏所在列", () => {
	const mode = fakeMode([finishedBash("c1", "ls"), finishedBash("c2", "pwd")]);
	groupToolRuns(mode);
	const lines = plain(groupOf(mode).render(WIDTH));
	assert.equal(lines.length, 2);
	assert.equal(lines[0], "");
	assert.equal(lines[1]!.trimStart(), "ran 2 shell commands");
	assert.equal(lines[1]!.length - lines[1]!.trimStart().length, 2);
});

check("展开态先摘要行，再铺开每个工具行的完整内容", () => {
	const rows = [finishedBash("c1", "ls"), finishedBash("c2", "pwd")];
	const mode = fakeMode(rows);
	groupToolRuns(mode);
	const group = groupOf(mode);
	const expected = new Container();
	for (const row of rows) expected.addChild(row);

	group.setExpanded(true);
	const lines = plain(group.render(WIDTH));
	assert.equal(lines[0], "");
	assert.equal(lines[1]!.trimStart(), "ran 2 shell commands");
	assert.equal(lines.length, 2 + expected.render(WIDTH).length);
	// 展开态下 Pi 把参数铺成 `command: ls` 这样的多行，这里只校验内容已铺开。
	assert.ok(lines.slice(2).some((line) => line.includes("command")), JSON.stringify(lines));
});

check("执行中显示 Running，失败时标注数量", () => {
	const running = fakeMode([bashRow("c1", "ls"), finish(bashRow("c2", "pwd"))]);
	groupToolRuns(running);
	assert.ok(plain(groupOf(running).render(WIDTH))[1]!.includes("Running 2 shell commands"));

	const failed = fakeMode([finishedBash("c1", "ls"), finish(bashRow("c2", "pwd"), true)]);
	groupToolRuns(failed);
	const line = plain(groupOf(failed).render(WIDTH))[1]!;
	assert.ok(line.includes("ran 2 shell commands"), line);
	assert.ok(line.includes("1 failed"), line);
});

check("思考耗时只计入刚结束的那条消息", () => {
	const matched = fakeMode([finishedBash("c1", "ls"), finishedBash("c2", "pwd")]);
	groupToolRuns(matched, { ids: new Set(["c1", "c2"]), thoughtMs: 3200 });
	assert.ok(plain(groupOf(matched).render(WIDTH))[1]!.includes("Thought for 3s, ran 2 shell commands"));

	const mismatched = fakeMode([finishedBash("c1", "ls"), finishedBash("c2", "pwd")]);
	groupToolRuns(mismatched, { ids: new Set(["c9"]), thoughtMs: 3200 });
	assert.equal(plain(groupOf(mismatched).render(WIDTH))[1]!.trimStart(), "ran 2 shell commands");
});

check("重复聚合不叠加", () => {
	const mode = fakeMode([finishedBash("c1", "ls"), finishedBash("c2", "pwd")]);
	groupToolRuns(mode);
	const group = groupOf(mode);
	groupToolRuns(mode);
	assert.equal(mode.chatContainer.children.length, 1);
	assert.equal(mode.chatContainer.children[0], group);
});

check("Ctrl+O 的展开态传递到组内工具行", () => {
	const mode = fakeMode([finishedBash("c1", "ls"), finishedBash("c2", "pwd")]);
	groupToolRuns(mode);
	const group = groupOf(mode);
	assert.equal(group.expanded, false);
	group.setExpanded(true);
	assert.ok((group.children as ToolExecutionComponent[]).every((row) => (row as any).expanded === true));
});

check("摘要行不超过渲染宽度", () => {
	const mode = fakeMode([finishedBash("c1", "ls"), finishedBash("c2", "pwd"), finishedBash("c3", "id")]);
	groupToolRuns(mode);
	const narrow = plain(groupOf(mode).render(12));
	assert.equal(narrow.length, 2);
	assert.ok(narrow[1]!.length <= 12, JSON.stringify(narrow[1]));
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
	console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `\n      ${r.detail}` : ""}`);
}
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
