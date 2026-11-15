/**
 * 测试 harness：统一的 check 与结果汇总。
 *
 * 每个测试文件仍是独立进程：原型补丁与模块状态互不污染。
 */

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];

export function check(name: string, fn: () => void): void {
	try {
		fn();
		results.push({ name, ok: true });
	} catch (error) {
		results.push({ name, ok: false, detail: (error as Error).message });
	}
}

/** 打印结果并以失败数决定退出码。 */
export function finish(): never {
	const failed = results.filter((result) => !result.ok);
	for (const result of results) {
		console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.name}${result.detail ? `\n      ${result.detail}` : ""}`);
	}
	console.log(`\n${results.length - failed.length}/${results.length} 通过`);
	process.exit(failed.length === 0 ? 0 : 1);
}
