/**
 * 三个扩展同时安装时的左缘对齐契约。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
	getMarkdownTheme,
	initTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences } from "@earendil-works/pi-tui";
import installMessageMarks from "../extensions/message-marks/index.ts";
import installMinimalTools from "../extensions/minimal-tools/index.ts";
import { ToolRunSummary, groupSilentTurns, groupToolRuns } from "../extensions/tool-run-groups/index.ts";
import { check, finish } from "./harness.ts";

initTheme("dark", false);

const WIDTH = 60;
const theme = {
	appearance: "dark" as const,
	fg: (_token: string, text: string) => text,
	bg: (_token: string, text: string) => text,
	bold: (text: string) => text,
	style: (text: string, _options: unknown) => text,
};

installMessageMarks({
	on(_event: string, handler: (event: unknown, ctx: unknown) => void) {
		handler({}, { hasUI: true, ui: { theme, setEditorComponent() {} } });
	},
} as any);

let resolver: ((name: string, next: () => unknown) => any) | undefined;
installMinimalTools({
	registerToolRenderer(r: (name: string, next: () => unknown) => any) {
		resolver = r;
	},
	on(_event: string, handler: (event: unknown, ctx: unknown) => void) {
		handler({}, { ui: { theme: { getFgAnsi: () => "" }, setHiddenThinkingLabel() {} } });
	},
} as any);

function toolRow(id: string, command: string): ToolExecutionComponent {
	const renderers = { renderShell: "self" as const, ...resolver!("bash", () => undefined) };
	const row = new ToolExecutionComponent(
		"bash",
		id,
		{ command },
		{ outputPad: 1 },
		renderers,
		{ requestRender() {} } as any,
		process.cwd(),
	);
	row.markExecutionStarted();
	row.setArgsComplete();
	row.updateResult({ content: [{ type: "text", text: "ok" }], details: {}, durationMs: 300 } as any, false);
	return row;
}

function assistantRow(thinking: string, text?: string): AssistantMessageComponent {
	const content: Array<Record<string, unknown>> = [{ type: "thinking", thinking }];
	if (text !== undefined) content.push({ type: "text", text });
	// 默认显示思考正文，验证扩展在收起态不泄漏静默轮次的内容。
	return new AssistantMessageComponent(
		{ content, stopReason: "stop" } as any,
		false,
		getMarkdownTheme(),
		"Thinking...",
		1,
		[],
	);
}

function plain(lines: string[]): string[] {
	return lines.map(stripTerminalSequences);
}

check("三扩展同时安装时用户、摘要与工具行左缘一致", () => {
	const chat = new Container();
	chat.addChild(new UserMessageComponent("跑一下测试", getMarkdownTheme(), 1));
	chat.addChild(assistantRow("先看看现状"));
	chat.addChild(toolRow("c1", "ls"));
	chat.addChild(toolRow("c2", "pwd"));

	const mode = { chatContainer: chat, toolOutputExpanded: false, ui: { requestRender() {} } };
	groupToolRuns(mode);
	groupSilentTurns(mode, { thoughtMsFor: () => 2000 });

	const summary = chat.children.find((child): child is ToolRunSummary => child instanceof ToolRunSummary);
	assert.ok(summary !== undefined, "应生成请求级摘要");

	const collapsed = plain(chat.render(WIDTH));
	assert.equal(collapsed.some((line) => line.includes("先看看现状")), false, collapsed.join("\n"));
	for (const line of collapsed) {
		if (line.trim() === "") continue;
		assert.ok(
			line.startsWith("› ") || line.startsWith("  "),
			JSON.stringify(line),
		);
	}

	summary.setExpanded(true);
	const expanded = plain(chat.render(WIDTH));
	assert.ok(expanded.some((line) => line.includes("先看看现状")), expanded.join("\n"));
	for (const line of expanded) {
		if (line.trim() === "") continue;
		assert.ok(
			line.startsWith("› ") || line.startsWith("● ") || line.startsWith("  "),
			JSON.stringify(line),
		);
	}
	// 两个工具行各一个圆点，用户消息一个前缀，不重复。
	const joined = expanded.join("\n");
	assert.equal((joined.match(/●/g) ?? []).length, 2, joined);
	assert.equal((joined.match(/›/g) ?? []).length, 1, joined);
});

check("静默轮次的思考正文只在展开后出现", () => {
	const chat = new Container();
	chat.addChild(assistantRow("折叠里的思考"));
	chat.addChild(toolRow("d1", "ls"));
	chat.addChild(toolRow("d2", "pwd"));
	const mode = { chatContainer: chat, toolOutputExpanded: false, ui: { requestRender() {} } };
	groupToolRuns(mode);
	groupSilentTurns(mode);

	const summary = chat.children.find((child): child is ToolRunSummary => child instanceof ToolRunSummary);
	assert.ok(summary !== undefined);
	assert.equal(plain(chat.render(WIDTH)).join("\n").includes("折叠里的思考"), false);
	summary.setExpanded(true);
	assert.ok(plain(chat.render(WIDTH)).join("\n").includes("折叠里的思考"));
});

check("带正文的轮次收起时只剩正文与摘要行", () => {
	const chat = new Container();
	chat.addChild(assistantRow("先确认现状", "先看看当前的失败用例。"));
	chat.addChild(toolRow("e1", "ls"));
	chat.addChild(toolRow("e2", "pwd"));
	chat.addChild(assistantRow("收尾思考", "已经修好了。"));
	const mode = { chatContainer: chat, toolOutputExpanded: false, ui: { requestRender() {} } };
	groupToolRuns(mode);
	groupSilentTurns(mode, { thoughtMsFor: () => 3000 });

	const collapsed = plain(chat.render(WIDTH)).join("\n");
	assert.ok(collapsed.includes("先看看当前的失败用例。"), collapsed);
	assert.ok(collapsed.includes("已经修好了。"), collapsed);
	assert.ok(collapsed.includes("Thought for 6s, ran 2 shell commands"), collapsed);
	assert.equal(collapsed.includes("先确认现状"), false, collapsed);
	assert.equal(collapsed.includes("收尾思考"), false, collapsed);
});

finish();
