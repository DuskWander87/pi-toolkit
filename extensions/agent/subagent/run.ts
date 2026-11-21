/**
 * 子代理进程的启动参数、事件流解析与运行循环。
 *
 * 参数构造与事件解析是纯函数，测试直接覆盖；只有 `runAgent` 碰进程。
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Message } from "@earendil-works/pi-ai";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.ts";

/**
 * 没写工具白名单、也不放开写入时，从默认继承里减掉的项。
 *
 * `subagent` 只能写在这一个字符串里：pi 的 `--exclude-tools` 是赋值覆盖，拆成两个 flag
 * 会静默丢掉前一个，递归防护跟着失效。
 */
export const DEFAULT_EXCLUDED_TOOLS = "write,edit,subagent";
/** 无论白名单怎么写都不交给子代理的工具。放开写入时也只有这一项。 */
export const ALWAYS_EXCLUDED_TOOLS = "subagent";
/**
 * 调研要用的三件套不在 pi 的默认工具集里（默认只有 read / bash / edit / write），
 * 所以继承模式下要显式加上，否则子代理只能拿 read 与 bash。
 */
export const INHERIT_EXTRA_TOOLS = "grep,find,ls";

/** 流式过程中的实时进度，只用于渲染，不进工具结果。 */
export interface Progress {
	output: string;
	usage: Usage;
}

export interface Usage {
	input: number;
	output: number;
	contextTokens: number;
}

export function emptyUsage(): Usage {
	return { input: 0, output: 0, contextTokens: 0 };
}

export interface DispatchDefaults {
	/** 调用方会话的模型，形如 `provider/id`。 */
	model?: string;
	thinkingLevel?: string;
}

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "aborted";

export interface TaskResult {
	agent: string;
	source: "user" | "project" | "builtin" | "unknown";
	task: string;
	status: TaskStatus;
	output: string;
	error?: string;
	usage: Usage;
}

/**
 * 构造子进程参数。
 *
 * - `agent.tools` 给了就用 `--tools` 整组替换；没给就继承默认工具集，补上 `INHERIT_EXTRA_TOOLS`，
 *   再按 `agent.allowWrite` 决定要不要减掉 write / edit
 * - `ALWAYS_EXCLUDED_TOOLS` 始终生效，两种情况下都断掉递归
 * - 思考等级只在跟随调用方模型时继承：换模型后，调用方的等级未必落在新模型的能力区间
 */
export function buildArgs(
	agent: AgentConfig,
	task: string,
	defaults: DispatchDefaults,
	systemPromptPath?: string,
): string[] {
	const args = ["--mode", "json", "-p", "--no-session"];

	const model = agent.model ?? defaults.model;
	if (model) args.push("--model", model);
	if (!agent.model && defaults.thinkingLevel) args.push("--thinking", defaults.thinkingLevel);

	if (agent.omitContext) args.push("--no-context-files");

	if (agent.tools && agent.tools.length > 0) {
		args.push("--tools", agent.tools.join(","), "--exclude-tools", ALWAYS_EXCLUDED_TOOLS);
	} else {
		args.push("--tools", `+${INHERIT_EXTRA_TOOLS.split(",").join(",+")}`);
		args.push("--exclude-tools", agent.allowWrite ? ALWAYS_EXCLUDED_TOOLS : DEFAULT_EXCLUDED_TOOLS);
	}

	if (systemPromptPath) args.push("--append-system-prompt", systemPromptPath);

	args.push(`Task: ${task}`);
	return args;
}

/**
 * 逐块喂入子进程的原始字节，按 LF 切出完整行。
 *
 * 解码交给 `StringDecoder`：直接对每个 chunk 调 `toString()` 会把断在字符中间的
 * 多字节序列解成 U+FFFD，而 JSON 照样能解析，乱码就这样静默进了结论。
 */
export class LineBuffer {
	private readonly decoder = new StringDecoder("utf8");
	private pending = "";

	/** 返回本次喂入后已经完整（带换行收尾）的行。 */
	push(chunk: Buffer): string[] {
		const text = this.pending + this.decoder.write(chunk);
		const lines = text.split("\n");
		this.pending = lines.pop() ?? "";
		return lines;
	}

	/** 流结束时取出没有换行收尾的最后一行。 */
	flush(): string {
		const rest = this.pending + this.decoder.end();
		this.pending = "";
		return rest;
	}
}

/** 一行 JSONL 若是收尾的消息就返回它；会话头、增量事件一律忽略。 */
export function parseMessageEvent(line: string): Message | undefined {
	const trimmed = line.trim();
	if (!trimmed) return undefined;

	let event: { type?: unknown; message?: unknown };
	try {
		event = JSON.parse(trimmed);
	} catch {
		return undefined;
	}
	if (event.type !== "message_end") return undefined;
	if (typeof event.message !== "object" || event.message === null) return undefined;

	const message = event.message as Message;
	if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") return undefined;
	if (message.role === "assistant" && !isUsableAssistant(message)) return undefined;
	return message;
}

/**
 * 助手消息至少要带正文数组与用量对象。
 *
 * 子进程的版本未必与宿主一致（`piInvocation` 会退回 PATH 上的 `pi`），缺字段的消息会让
 * `addUsage` 解构 `undefined`、`finalText` 读不到数组——两者都在 stdout 的事件回调里跑，
 * 抛出来是未捕获异常，赔上的是宿主进程而不是这一条任务。可疑的行走 `consume` 丢掉的路径，
 * 任务最终会以「没有返回文本」失败。
 */
function isUsableAssistant(message: Message): boolean {
	const candidate = message as { content?: unknown; usage?: unknown };
	return Array.isArray(candidate.content) && typeof candidate.usage === "object" && candidate.usage !== null;
}

/** 累加一条消息的用量。非助手消息原样返回。 */
export function addUsage(usage: Usage, message: Message): Usage {
	if (message.role !== "assistant") return usage;
	const { input, output, totalTokens } = message.usage;
	return {
		input: usage.input + input,
		output: usage.output + output,
		contextTokens: totalTokens,
	};
}

/** 最后一条带文本的助手消息。工具调用的参数不进结果，主会话只需要结论。 */
export function finalText(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		const text = message.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("")
			.trim();
		if (text) return text;
	}
	return "";
}

/**
 * 最后一条助手消息是否以文本收尾。
 *
 * `finalText` 会回溯到更早的助手消息取文本，那可能是「先读文件」这类过场话。
 * 收尾这一轮只有工具调用、没有文本时，交回去的就不是结论。
 */
export function concludesWithText(messages: Message[]): boolean {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		return message.content.some((block) => block.type === "text" && block.text.trim().length > 0);
	}
	return false;
}

/**
 * 最后一条助手消息的收尾结论。
 *
 * `--mode json` 下模型侧报错与输出超限同样退出码 0（print-mode 只在 text 模式把
 * `error` / `length` 变成非 0），所以退出码为 0 也不能说明任务跑成了。
 * 返回 undefined 表示没有可置疑的收尾状态。
 */
export function stopFailure(messages: Message[]): { status: "failed" | "aborted"; error: string } | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		if (message.stopReason === "error") {
			return { status: "failed", error: `模型侧报错：${message.errorMessage ?? "未说明原因"}` };
		}
		if (message.stopReason === "aborted") {
			return { status: "aborted", error: message.errorMessage ?? "子代理被中止" };
		}
		if (message.stopReason === "length") {
			return { status: "failed", error: "输出达到 token 上限被截断" };
		}
		return undefined;
	}
	return undefined;
}

/** 路径的真实位置；解析不了（不存在、权限）就用解析后的原路径。 */
function realOrSelf(target: string): string {
	try {
		return fs.realpathSync(target);
	} catch {
		return path.resolve(target);
	}
}

/** `script` 是否落在 pi 包目录里：是的话它就是 pi 自己的入口。 */
function isPiEntry(script: string): boolean {
	const relative = path.relative(realOrSelf(getPackageDir()), realOrSelf(script));
	return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * 定位 pi 的启动方式。
 *
 * 只有 argv[1] 确实在 pi 包目录里时才复用它：pi 以 `node <cli.js>` 或 `bun <main.ts>` 启动时，
 * argv[1] 就是 pi 自己；而宿主是别的 Node 程序（SDK 嵌入、脚本）时 argv[1] 与本工具无关，
 * 拿去当子进程命令会跑起另一个程序。
 *
 * 剩下的情况：运行时是通用 node / bun 时退回 PATH 上的 `pi`；是 Bun 单文件包这类
 * 自带运行时的可执行文件时，`execPath` 本身就是 pi。
 */
export function piInvocation(
	args: string[],
	host: { script?: string; execPath?: string } = { script: process.argv[1], execPath: process.execPath },
): { command: string; args: string[] } {
	const script = host.script;
	const execPath = host.execPath ?? process.execPath;
	if (script && fs.existsSync(script) && isPiEntry(script)) {
		return { command: execPath, args: [script, ...args] };
	}

	const executable = path.basename(execPath).toLowerCase();
	if (/^(node|bun)(\.exe)?$/.test(executable)) return { command: "pi", args };
	return { command: execPath, args };
}

/** 把 `spawnCommand` 与 pi 参数合成最终启动命令；数组形式把前置参数排在 pi 参数之前。 */
export function spawnCommandInvocation(
	spawnCommand: string | readonly string[] | undefined,
	args: string[],
): { command: string; args: string[] } {
	if (typeof spawnCommand === "string") {
		return spawnCommand === "" ? piInvocation(args) : { command: spawnCommand, args };
	}
	const [command, ...prefix] = spawnCommand ?? [];
	return command === undefined ? piInvocation(args) : { command, args: [...prefix, ...args] };
}

/** 子进程被 SIGTERM 后留给它收尾的时间，超时再 SIGKILL。 */
const KILL_GRACE_MS = 5000;

interface ProcessOutcome {
	code: number | null;
	signal: NodeJS.Signals | null;
	spawnError?: Error;
}

export interface RunOptions {
	agent: AgentConfig;
	task: string;
	defaults: DispatchDefaults;
	cwd: string;
	signal?: AbortSignal;
	onProgress?: (progress: Progress) => void;
	/**
	 * 替换启动命令，默认按 pi 的安装方式推断。测试用它注入回放固定 JSONL 的假 `pi`：
	 * 传入数组时第一项是命令，其余项排在 pi 参数之前。空串与空数组等同于没给。
	 */
	spawnCommand?: string | readonly string[];
}

export async function runAgent({
	agent,
	task,
	defaults,
	cwd,
	signal,
	onProgress,
	spawnCommand,
}: RunOptions): Promise<TaskResult> {
	const result: TaskResult = {
		agent: agent.name,
		source: agent.source,
		task,
		status: "running",
		output: "",
		usage: emptyUsage(),
	};

	if (signal?.aborted) return { ...result, status: "aborted", error: "aborted before start" };

	let promptDir: string | undefined;
	let promptPath: string | undefined;
	try {
		// 系统提示走临时文件：正文可以任意长，不受 argv 长度限制。
		if (agent.systemPrompt) {
			promptDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
			promptPath = path.join(promptDir, "system-prompt.md");
			await fs.promises.writeFile(promptPath, agent.systemPrompt, { encoding: "utf-8", mode: 0o600 });
		}

		const args = buildArgs(agent, task, defaults, promptPath);
		const messages: Message[] = [];
		const stdout = new LineBuffer();
		const stderrDecoder = new StringDecoder("utf8");
		let stderr = "";
		let aborted = false;

		const outcome = await new Promise<ProcessOutcome>((resolve) => {
			const invocation = spawnCommandInvocation(spawnCommand, args);
			let settled = false;
			let killTimer: ReturnType<typeof setTimeout> | undefined;
			let exited = false;
			let proc: ReturnType<typeof spawn>;

			const finish = (value: ProcessOutcome) => {
				if (settled) return;
				settled = true;
				if (killTimer) clearTimeout(killTimer);
				signal?.removeEventListener("abort", abortProcess);
				resolve(value);
			};

			const abortProcess = () => {
				if (exited || proc.exitCode !== null || proc.signalCode !== null) return;
				if (!proc.kill("SIGTERM")) return;
				aborted = true;
				killTimer = setTimeout(() => {
					if (!exited) proc.kill("SIGKILL");
				}, KILL_GRACE_MS);
			};

			const consume = (line: string) => {
				const message = parseMessageEvent(line);
				if (!message) return;
				messages.push(message);
				result.usage = addUsage(result.usage, message);
				result.output = finalText(messages);
				onProgress?.({ output: result.output, usage: result.usage });
			};

			try {
				proc = spawn(invocation.command, invocation.args, {
					cwd,
					shell: false,
					stdio: ["ignore", "pipe", "pipe"],
				});
			} catch (error) {
				finish({ code: null, signal: null, spawnError: error instanceof Error ? error : new Error(String(error)) });
				return;
			}

			proc.stdout?.on("data", (chunk: Buffer) => {
				for (const line of stdout.push(chunk)) consume(line);
			});
			proc.stderr?.on("data", (chunk: Buffer) => {
				stderr += stderrDecoder.write(chunk);
			});
			proc.on("exit", () => {
				exited = true;
			});
			proc.on("close", (code, terminationSignal) => {
				const rest = stdout.flush();
				if (rest.trim()) consume(rest);
				finish({ code, signal: terminationSignal });
			});
			proc.on("error", (error) => {
				finish({ code: null, signal: null, spawnError: error });
			});

			if (signal) {
				if (signal.aborted) abortProcess();
				else signal.addEventListener("abort", abortProcess, { once: true });
			}
		});

		result.output = finalText(messages);

		if (aborted) {
			result.status = "aborted";
			result.error = "aborted";
		} else if (outcome.spawnError) {
			result.status = "failed";
			result.error = `无法启动子进程：${outcome.spawnError.message}`;
		} else if (outcome.signal) {
			result.status = "failed";
			result.error = `子进程被信号 ${outcome.signal} 终止`;
		} else if (outcome.code !== 0) {
			result.status = "failed";
			result.error = `子进程退出码 ${outcome.code}${stderr.trim() ? `：${stderr.trim()}` : ""}`;
		} else {
			const failure = stopFailure(messages);
			if (failure) {
				result.status = failure.status;
				result.error = failure.error;
			} else if (!result.output) {
				result.status = "failed";
				result.error = "子进程正常退出但没有返回文本";
			} else if (!concludesWithText(messages)) {
				// 收尾停在工具调用轮：`finalText` 回溯拿到的是更早的过场话，不能当结论。
				result.status = "failed";
				result.error = "子代理停在工具调用轮，没有给出结论";
			} else {
				result.status = "completed";
			}
		}
		return result;
	} finally {
		if (promptPath) await fs.promises.rm(promptPath, { force: true }).catch(() => {});
		if (promptDir) await fs.promises.rmdir(promptDir).catch(() => {});
	}
}

/** 并发受限的 map：并行模式下控制同时在跑的子进程数。 */
export async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: limit }, async () => {
			while (next < items.length) {
				const index = next++;
				results[index] = await fn(items[index], index);
			}
		}),
	);
	return results;
}
