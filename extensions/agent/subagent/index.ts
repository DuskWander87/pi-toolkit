/**
 * subagent
 *
 * 把任务交给独立上下文里的子代理：每次调用起一个 `pi --mode json` 子进程，
 * 主会话只收回结论，子代理的调研过程不进主上下文。
 *
 * 两种模式 —— single（一个 agent + 一个任务）、parallel（多个任务，上限 8，并发 4）。
 */

import { type ExtensionAPI, DEFAULT_MAX_BYTES, getMarkdownTheme, truncateHead } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, discoverAgents, formatAgentCatalog } from "./agents.ts";
import {
	type DispatchDefaults,
	type TaskResult,
	type Usage,
	emptyUsage,
	mapWithConcurrencyLimit,
	runAgent,
} from "./run.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;

/** 工具结果的 details：渲染与排查都读它。 */
interface SubagentDetails {
	mode: "single" | "parallel";
	results: TaskResult[];
}

// ============================================================================
// 文本
// ============================================================================

function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsage(usage: Usage): string {
	const parts: string[] = [];
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.contextTokens) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	return parts.join(" ");
}

/** 单行预览：折叠换行，超长截断。 */
function preview(text: string, max: number): string {
	const flat = text.replace(/\s*\r?\n\s*/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function isFailed(result: TaskResult): boolean {
	return result.status === "failed" || result.status === "aborted";
}

/** 状态标记。 */
function statusMark(result: TaskResult, theme: { fg(token: string, text: string): string }): string {
	if (result.status === "completed") return theme.fg("success", "✓");
	if (result.status === "aborted") return theme.fg("warning", "⏹");
	if (result.status === "failed") return theme.fg("error", "✗");
	return theme.fg("warning", "⏳");
}

/** 所有任务的结果正文加起来的可用字节数：并行跑满时也不会一次灌满主上下文。 */
const MAX_TOTAL_OUTPUT_BYTES = 100 * 1024;

/** 按字节上限切一段前缀。中文一个字符 3 字节，不能直接按字符数切。 */
function cutToBytes(text: string, maxBytes: number): string {
	const buffer = Buffer.from(text, "utf8");
	if (buffer.length <= maxBytes) return text;
	let end = maxBytes;
	// 回退到字符起始字节，否则末尾会多出一个 U+FFFD。
	while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
	return buffer.subarray(0, end).toString("utf8");
}

/** 交给模型或展开视图的正文。超长时保留开头并计数，细节留在 details 里。 */
export function bodyText(result: TaskResult, maxBytes?: number): string {
	const budget = maxBytes ?? DEFAULT_MAX_BYTES;
	const output = result.output?.trim() ? result.output : "";
	const error = result.error?.trim() ? result.error : "";

	// 失败原因不参加截断。它在正文之后、又是最先被切掉的那一段，而它正是主模型
	// 分辨「没跑成」和「跑成了但结论是坏的」的依据。
	const truncated = truncateHead(output, { maxBytes: budget });
	let body = output;
	if (truncated.truncated) {
		// 首行就超过字节上限时 truncateHead 返回空正文；直接使用会让模型只收到一句
		// 「已截断」而看不到任何结论，所以退回按字节切一段前缀。
		const content = truncated.content || cutToBytes(output, budget);
		const omitted = truncated.totalBytes - Buffer.byteLength(content, "utf8");
		body = `${content}\n\n[输出被截断：省略 ${omitted} 字节]`;
	}

	return [body, error].filter(Boolean).join("\n\n") || "(无输出)";
}

/** `parallel` 的工具结果正文：成功计数 + 每条任务一小节。 */
export function parallelSummary(results: TaskResult[]): string {
	const succeeded = results.filter((result) => !isFailed(result)).length;
	// 每条任务分到均额：8 条并行各自 50KB 会把主上下文一次灌满，
	// 而「只收回结论」正是这个工具的意义。
	const perTaskBytes = Math.floor(MAX_TOTAL_OUTPUT_BYTES / results.length);
	const sections = results.map(
		(result) => `### [${result.agent}] ${result.status}\n\n${bodyText(result, perTaskBytes)}`,
	);
	return `并行：${succeeded}/${results.length} 成功\n\n${sections.join("\n\n---\n\n")}`;
}

/** 工具描述。模型靠这份清单决定什么时候派谁，所以清单必须随描述一起下发。 */
function buildDescription(agents: AgentConfig[]): string {
	const lines = [
		"Delegate a task to a subagent that runs in its own context window; only its final answer comes back.",
		// 何时该用的完整判断在 promptGuidelines（system prompt 的 rules 段）里，这里只留一句定位：
		// 同一句触发条件每轮读两遍不会让模型更听话。
		"Use it for research rather than action.",
		"",
		"Available agents:",
		formatAgentCatalog(agents),
	];
	lines.push("", "Modes: single (agent + task) or parallel (tasks array).");
	return lines.join("\n");
}

/**
 * 工具活跃时追加到 system prompt 的 `<rules>` 段。
 * 工具描述只在模型主动想到这个工具时才会被读到，调研类任务里模型往往一上来就直接 bash，
 * 所以判断条件要写进规则，并且每条都点名工具。
 */
const PROMPT_GUIDELINES = [
	"Use subagent for research that would otherwise flood the conversation: surveying an unfamiliar area, reading several files to answer one question, or searching repeatedly. Do that work yourself only when one or two targeted reads answer it.",
];

// ============================================================================
// 参数
// ============================================================================

const TaskItem = Type.Object({
	agent: Type.String({ description: "要调用的 agent 名" }),
	task: Type.String({ description: "交给该 agent 的任务" }),
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "single 模式的 agent 名" })),
	task: Type.Optional(Type.String({ description: "single 模式的任务" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "parallel 模式：{ agent, task } 数组，并发执行" })),
});

// ============================================================================
// 扩展入口
// ============================================================================

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: buildDescription(discoverAgents(process.cwd()).agents),
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: SubagentParams,

		// 工具描述是静态的，定义目录却会变；活跃工具集变化时把清单重写一遍，
		// 模型才能看到磁盘上新增的 agent。
		prepareLoadout(loadout) {
			if (!loadout.declared.some((tool) => tool.name === "subagent")) return undefined;
			return { descriptions: { subagent: buildDescription(discoverAgents(process.cwd()).agents) } };
		},

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const discovery = discoverAgents(ctx.cwd);
			const defaults: DispatchDefaults = {
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				thinkingLevel: ctx.thinkingLevel,
			};
			const catalog = formatAgentCatalog(discovery.agents);
			const build = (mode: "single" | "parallel", results: TaskResult[]): SubagentDetails => ({ mode, results });

			const single = Boolean(params.agent && params.task);
			const parallel = (params.tasks?.length ?? 0) > 0;

			if (Number(single) + Number(parallel) !== 1) {
				return {
					content: [{ type: "text" as const, text: `参数错误：agent+task 与 tasks 二选一。可用 agent：\n${catalog}` }],
					details: build("single", []),
					isError: true,
				};
			}

			if (parallel && params.tasks!.length > MAX_PARALLEL_TASKS) {
				return {
					content: [
						{
							type: "text" as const,
							text: `并行的任务过多（${params.tasks!.length}），上限 ${MAX_PARALLEL_TASKS}。`,
						},
					],
					details: build("parallel", []),
					isError: true,
				};
			}

			const requested = single ? [params.agent!] : params.tasks!.map((item) => item.agent);
			const missing = requested.filter((name) => !discovery.agents.some((agent) => agent.name === name));
			if (missing.length > 0) {
				return {
					content: [{ type: "text" as const, text: `找不到 agent：${missing.join("、")}。可用 agent：\n${catalog}` }],
					details: build(single ? "single" : "parallel", []),
					isError: true,
				};
			}

			const findAgent = (name: string) => discovery.agents.find((agent) => agent.name === name)!;

			if (single) {
				const agent = findAgent(params.agent!);
				const live: TaskResult = {
					agent: agent.name,
					source: agent.source,
					task: params.task!,
					status: "running",
					output: "",
					usage: emptyUsage(),
				};
				const result = await runAgent({
					agent,
					task: params.task!,
					defaults,
					cwd: ctx.cwd,
					signal,
					onProgress: ({ output, usage }) => {
						live.output = output;
						live.usage = usage;
						onUpdate?.({
							content: [{ type: "text" as const, text: output || "(运行中…)" }],
							details: build("single", [{ ...live }]),
						});
					},
				});
				return {
					content: [
						{
							type: "text" as const,
							text: isFailed(result) ? `[${result.status}] ${bodyText(result)}` : bodyText(result),
						},
					],
					details: build("single", [result]),
					isError: isFailed(result),
				};
			}

			const items = params.tasks!;
			const results: TaskResult[] = items.map((item) => ({
				agent: item.agent,
				source: "unknown" as const,
				task: item.task,
				status: "pending" as const,
				output: "",
				usage: emptyUsage(),
			}));

			const emitProgress = () => {
				const settled = results.filter((result) => result.status === "completed").length;
				onUpdate?.({
					content: [{ type: "text" as const, text: `并行：${settled}/${results.length} 完成` }],
					details: build("parallel", [...results]),
				});
			};

			await mapWithConcurrencyLimit(items, MAX_CONCURRENCY, async (item, index) => {
				const result = await runAgent({
					agent: findAgent(item.agent),
					task: item.task,
					defaults,
					cwd: ctx.cwd,
					signal,
					onProgress: ({ output, usage }) => {
						results[index] = { ...results[index], status: "running", output, usage };
						emitProgress();
					},
				});
				results[index] = result;
				emitProgress();
			});

			return {
				content: [{ type: "text" as const, text: parallelSummary(results) }],
				details: build("parallel", results),
				isError: results.some(isFailed),
			};
		},

		renderCall(args, theme) {
			if (args.tasks && args.tasks.length > 0) {
				const shown = args.tasks.slice(0, 5);
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `${args.tasks.length} 个并行任务`);
				shown.forEach((item, index) => {
					const last = index === shown.length - 1 && shown.length === args.tasks!.length;
					text += `\n  ${theme.fg("muted", last ? "└" : "├")} ${theme.fg("accent", item.agent)}${theme.fg("dim", ` ${preview(item.task, 40)}`)}`;
				});
				if (shown.length < args.tasks.length) {
					text += `\n  ${theme.fg("muted", `└ 另有 ${args.tasks.length - shown.length} 个`)}`;
				}
				return new Text(text, 0, 0);
			}

			let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", args.agent ?? "…");
			if (args.task) text += `\n  ${theme.fg("muted", "└")} ${theme.fg("dim", preview(args.task, 60))}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as SubagentDetails | undefined;
			const fallback = result.content[0];
			const plain = fallback?.type === "text" ? fallback.text : "(无输出)";
			if (!details || details.results.length === 0) return new Text(plain, 0, 0);

			if (details.mode === "single") {
				const task = details.results[0];
				const mark = statusMark(task, theme);
				const usage = formatUsage(task.usage);

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							[mark, theme.fg("accent", task.agent), theme.fg("dim", usage)].filter(Boolean).join(" "),
							0,
							0,
						),
					);
					container.addChild(new Markdown(bodyText(task), 0, 0, getMarkdownTheme()));
					return container;
				}

				const body = isFailed(task) ? (task.error ?? bodyText(task)) : task.output;
				const lines = body.split("\n").slice(0, 3).join("\n");
				return new Text(
					`${mark} ${theme.fg("toolOutput", lines)}${usage ? ` ${theme.fg("dim", usage)}` : ""}`,
					0,
					0,
				);
			}

			if (expanded) {
				const container = new Container();
				for (const task of details.results) {
					container.addChild(
						new Text(
							`${statusMark(task, theme)} ${theme.fg("accent", task.agent)} ${theme.fg("dim", formatUsage(task.usage))}`,
							0,
							0,
						),
					);
					container.addChild(new Markdown(bodyText(task), 0, 0, getMarkdownTheme()));
				}
				return container;
			}

			const lines = details.results.map((task) => {
				const body = isFailed(task) ? (task.error ?? "(失败)") : preview(task.output, 100);
				return `${statusMark(task, theme)} ${theme.fg("accent", task.agent)} ${theme.fg("toolOutput", body)}`;
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
