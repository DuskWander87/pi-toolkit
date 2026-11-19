/**
 * 测试 harness：统一的 check 与结果汇总。
 *
 * 每个测试文件仍是独立进程：原型补丁与模块状态互不污染。
 */

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
/** 异步用例的 promise，由 finish 统一等待后再汇总。 */
const pending: Promise<void>[] = [];

export function check(name: string, fn: () => void | Promise<void>): void {
	const pass = () => {
		results.push({ name, ok: true });
	};
	const fail = (error: unknown) => {
		results.push({ name, ok: false, detail: (error as Error).message });
	};
	try {
		const outcome = fn();
		if (outcome instanceof Promise) {
			pending.push(outcome.then(pass, fail));
			return;
		}
		pass();
	} catch (error) {
		fail(error);
	}
}

/** 打印结果并以失败数决定退出码。 */
export async function finish(): Promise<never> {
	await Promise.all(pending);
	const failed = results.filter((result) => !result.ok);
	for (const result of results) {
		console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.name}${result.detail ? `\n      ${result.detail}` : ""}`);
	}
	console.log(`\n${results.length - failed.length}/${results.length} 通过`);
	process.exit(failed.length === 0 ? 0 : 1);
}
