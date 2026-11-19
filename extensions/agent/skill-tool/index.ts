/**
 * skill-tool
 *
 * 把技能的加载动作从「read 一个路径」改成「调一个专用工具」：
 * - 从 system prompt 摘掉 `<skills>` 段
 * - 技能目录挪进 `skill` 工具的描述
 * - 模型调 `skill({ name })` 得到正文
 */

import { readFile } from "node:fs/promises";
import { stripFrontmatter } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, Skill } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const TOOL_NAME = "skill";
/** 目录总长上限，超出时截断并显式计数。 */
const MAX_CATALOG_CHARS = 8000;

/** 工具结果的 details，供渲染与排查使用。 */
interface SkillToolDetails {
	name: string;
	found: boolean;
	filePath?: string;
	error?: string;
}

// ============================================================================
// 文本构造
// ============================================================================

/** 清单一行一个技能：折叠换行，并转义会被读成标记的字符。 */
function escapeCatalogText(text: string): string {
	return text
		.replace(/\s*\r?\n\s*/g, " ")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

/** 工具描述：指令 + `<available_skills>` 清单，每个技能一行。 */
export function buildCatalog(skills: Skill[]): string {
	const visible = skills.filter((skill) => !skill.disableModelInvocation);
	if (visible.length === 0) return "";

	const lines = [
		"Load a skill's full instructions by exact name.",
		"",
		"Call this before acting when the task matches a skill listed below. Each",
		"description states what the skill does and when it applies.",
		"",
		"<available_skills>",
	];
	let used = lines.join("\n").length;
	let omitted = 0;
	for (let i = 0; i < visible.length; i++) {
		const line = `- ${escapeCatalogText(visible[i].name)}: ${escapeCatalogText(visible[i].description)}`;
		if (used + line.length + 1 > MAX_CATALOG_CHARS) {
			omitted = visible.length - i;
			break;
		}
		lines.push(line);
		used += line.length + 1;
	}
	lines.push("</available_skills>");
	if (omitted > 0) {
		// 被省略的技能照样能按名调用，所以至少给出名字，只是不给描述。
		const header = `${omitted} more skills are callable by name, without descriptions: `;
		const names: string[] = [];
		let tailUsed = header.length;
		for (const skill of visible.slice(visible.length - omitted)) {
			const name = escapeCatalogText(skill.name);
			if (used + tailUsed + name.length + 2 > MAX_CATALOG_CHARS) break;
			tailUsed += name.length + 2;
			names.push(name);
		}
		if (names.length < omitted) names.push("…");
		lines.push(header + names.join(", "));
	}
	return lines.join("\n");
}

/** 加载结果：与 Pi 原生 `/skill:name` 注入的形状一致。 */
export function formatLoadResult(skill: Skill, body: string): string {
	return [
		`<skill name="${skill.name}" location="${skill.filePath}">`,
		`References are relative to ${skill.baseDir}.`,
		"",
		body.trim(),
		"</skill>",
	].join("\n");
}

/** 工具参数：技能名。 */
function skillParameters() {
	return Type.Object({
		name: Type.String({ description: "Exact skill name from the available_skills list" }),
	});
}

// ============================================================================
// 扩展入口
// ============================================================================

export default function (pi: ExtensionAPI): void {
	// 首次注册时快照；会话中途增删技能需 /new 或 /reload 才会反映。
	let catalog = new Map<string, Skill>();
	let catalogText = "";
	let registered = false;

	function registerSkillTool(): void {
		pi.registerTool<ReturnType<typeof skillParameters>, SkillToolDetails>({
			name: TOOL_NAME,
			label: "Skill",
			description: catalogText,
			parameters: skillParameters(),
			async execute(_toolCallId, params) {
				const skill = catalog.get(params.name);
				if (!skill) {
					return {
						content: [
							{
								type: "text",
								text: `No skill named "${params.name}". Available: ${[...catalog.keys()].join(", ")}.`,
							},
						],
						details: { name: params.name, found: false },
						isError: true,
					};
				}
				try {
					const body = stripFrontmatter(await readFile(skill.filePath, "utf-8"));
					return {
						content: [{ type: "text", text: formatLoadResult(skill, body) }],
						details: { name: skill.name, filePath: skill.filePath, found: true },
					};
				} catch (error) {
					const message = error instanceof Error ? error.message : "failed to read skill file";
					return {
						content: [{ type: "text", text: `Failed to read skill "${skill.name}": ${message}` }],
						details: { name: skill.name, filePath: skill.filePath, found: true, error: message },
						isError: true,
					};
				}
			},
		});
	}

	// systemPromptOptions 与渲染共用：清空 skills 后 Pi 重渲染时 `<skills>` 段消失。
	// 只有 `skill` 工具真的进入活跃集合才清空，否则保留 Pi 原生的 skills 段。
	pi.on("before_agent_start", async (event) => {
		const options = event.systemPromptOptions;
		if (!Array.isArray(options?.skills)) return;
		const visible = options.skills.filter((skill) => !skill.disableModelInvocation);
		if (visible.length === 0) return;
		if (!registered) {
			catalog = new Map(visible.map((skill) => [skill.name, skill]));
			catalogText = buildCatalog(visible);
			registerSkillTool();
			registered = true;
		}
		// 白名单、denylist 或 pi config 过滤掉工具时不清空，模型仍能按原生提示 read 技能文件。
		if (!pi.getActiveTools().includes(TOOL_NAME)) return;
		options.skills = [];
	});
}
