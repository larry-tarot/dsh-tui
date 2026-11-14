#!/usr/bin/env node
// dsh-tui — 命令行入口
//   dsh-tui [--new|--resume|--session <id>]   # TTY: 交互 TUI；否则列出会话
//   dsh-tui run <prompt> [--session <id>|--resume] [--preset <id>] [--cwd <dir>]
//     # 一次性调用（默认新建 PTC 会话 → 打印回复）
import { createRequire } from "node:module";
import { resolveVersion } from "../lib/version.js";
import { DshClient } from "../lib/client.js";
import { Session, PTC_PRESET } from "../lib/session.js";
import { lastAssistantText } from "../lib/fold.js";
import { startInteractive } from "./interactive.js";

const require = createRequire(import.meta.url);
const pkgVersion = (() => {
	try {
		return resolveVersion(require("../package.json"));
	} catch {
		return resolveVersion(null);
	}
})();

const baseUrl = process.env.DSH_URL ?? "http://127.0.0.1:3080";
const client = new DshClient(baseUrl);

function usage() {
	console.error(
		"usage: dsh-tui [--new|--resume|--session <id>] | dsh-tui run <prompt> [--session <id>] | dsh-tui --version"
	);
}

async function listSessions() {
	const { items } = await client.request("session.list");
	console.log(`Connected to ${baseUrl} — ${items.length} session(s):`);
	for (const item of items) {
		const state = item.blank ? "blank" : "used ";
		const running = item.running ? " (running)" : "";
		const preset = item.agentPreset ? `  [${item.agentPreset}]` : "";
		console.log(`  [${state}]${running} ${item.sessionId}${preset}  ${item.cwd ?? ""}`);
	}
}

function parseRunArgs(args) {
	// prompt = 第一个非 -- 开头的参数；flags 可出现在 prompt 前后。
	const promptText = args.find((a) => !a.startsWith("--"));
	if (!promptText) {
		usage();
		process.exit(2);
	}
	const opts = { sessionId: null, resume: false, preset: PTC_PRESET, cwd: null, json: false };
	for (let i = 0; i < args.length; i++) {
		const flag = args[i];
		if (flag === promptText) continue; // 跳过 prompt 本身
		if (flag === "--session" && args[i + 1]) {
			opts.sessionId = args[i + 1];
			i++;
		} else if (flag === "--resume") {
			opts.resume = true;
		} else if (flag === "--json") {
			opts.json = true;
		} else if (flag === "--preset" && args[i + 1]) {
			opts.preset = args[i + 1];
			i++;
		} else if (flag === "--cwd" && args[i + 1]) {
			opts.cwd = args[i + 1];
			i++;
		} else {
			usage();
			process.exit(2);
		}
	}
	return { promptText, opts };
}

async function main() {
	const args = process.argv.slice(2);

	if (args[0] === "--version" || args[0] === "-v") {
		console.log(pkgVersion);
		return;
	}

	if (args[0] === "--help" || args[0] === "-h") {
		console.log(
			[
				"dsh-tui — DeepSeek Harness 终端客户端",
				"",
				"用法:",
				"  dsh-tui [--new|--resume|--session <id>]  启动交互 TUI（默认新建 PTC 会话）",
				"  dsh-tui run <prompt> [--session <id>] [--resume] [--json]  一次性调用并打印回复",
				"  dsh-tui [--new|--resume|--session <id>] — 非 TTY 下列出会话",
				"  dsh-tui --version / --help",
				"",
				"交互 TUI:",
				"  i/a/A/o  进 insert 输入   ESC 回 normal   : 命令模式",
				"  :w 提交   :cancel 停止回合   :q 退出",
				"  /new /resume /help /status 或 host 命令（如 /git status）",
				"",
				"环境变量: DSH_URL   host 地址，默认 " + baseUrl
			].join("\n")
		);
		return;
	}

	if (args[0] !== "run" && args[0] && args[0].startsWith("--")) {
		// 交互入口的初始化选项：--new / --resume / --session <id>
		let mode = "new";
		let sessionId = null;
		let preset = PTC_PRESET;
		let cwd = null;
		for (let i = 0; i < args.length; i++) {
			const flag = args[i];
			const value = args[i + 1];
			if (flag === "--new") mode = "new";
			else if (flag === "--resume") mode = "resume";
			else if (flag === "--session" && value) {
				sessionId = value;
				mode = "session";
				i++;
			} else if (flag === "--preset" && value) {
				preset = value;
				i++;
			} else if (flag === "--cwd" && value) {
				cwd = value;
				i++;
			} else {
				usage();
				process.exit(2);
			}
		}
		if (process.stdout.isTTY && process.stdin.isTTY) {
			await startInteractive({ baseUrl, sessionId, mode, preset, cwd });
		} else {
			await listSessions();
		}
		return;
	}

	if (args[0] === "run") {
		const { promptText, opts } = parseRunArgs(args.slice(1));
		const session = opts.resume
			? ((await Session.openRecent(client)) ?? (await Session.create(client, { cwd: opts.cwd, agentPreset: opts.preset })))
			: opts.sessionId
				? await Session.open(client, opts.sessionId)
				: await Session.create(client, { cwd: opts.cwd, agentPreset: opts.preset });
		const view = await session.converse(promptText);
		if (opts.json) {
			// 结构化 JSON 输出（供脚本/CI 消费，等价 Codex exec --json / OpenCode headless）。
			const usage = view.messages.reduce(
				(acc, m) => {
					if (m.usage) {
						acc.input += m.usage.inputTokens ?? 0;
						acc.output += m.usage.outputTokens ?? 0;
					}
					return acc;
				},
				{ input: 0, output: 0 }
			);
			process.stdout.write(JSON.stringify({
				sessionId: session.sessionId,
				agentPreset: session.agentPreset,
				reply: lastAssistantText(view) ?? "",
				turn: view.turn,
				toolCalls: view.tools.length,
				usage,
				turnEnd: view.turnEnd ? view.turnEnd.reason.kind : null
			}, null, 2) + "\n");
			return;
		}
		if (view.tools.length > 0) {
			console.error(`[${session.sessionId}] ${view.tools.length} 次工具调用`);
		}
		console.log(lastAssistantText(view) ?? "(无回复)");
		return;
	}

	// 无子命令：TTY → 交互 TUI；否则列出会话。
	if (process.stdout.isTTY && process.stdin.isTTY) {
		await startInteractive({ baseUrl, sessionId: null, mode: "new", preset: PTC_PRESET, cwd: null });
	} else {
		await listSessions();
	}
}

main().catch((error) => {
	console.error(`dsh-tui: ${error.message}`);
	process.exit(1);
});
