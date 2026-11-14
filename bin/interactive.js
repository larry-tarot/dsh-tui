#!/usr/bin/env node
// 交互模式：Ink 渲染 + Vim 模态输入。TTY 且非 `run` 一次性调用时自动进入。
// 支持 --session <id> / --resume / --new 决定初始会话；TUI 内 /new /resume 切换。
import { render } from "ink";
import React from "react";
import { DshClient } from "../lib/client.js";
import { Session, PTC_PRESET } from "../lib/session.js";
import { LiveConversation } from "../lib/live.js";
import App from "../ui/components.js";
import { routeSlash } from "../lib/commands.js";
import { loadConfig, configToRuntime } from "../lib/config.js";
import { writeRecent } from "../lib/registry.js";

/**
 * 决定初始会话：最终都会把用到的最新会话写进最近记忆。
 */
async function initialSession(client, { sessionId, mode, preset, cwd }) {
	if (sessionId) {
		return Session.open(client, sessionId);
	}
	if (mode === "resume") {
		const resumed = await Session.openRecent(client);
		if (resumed) return resumed;
		// 没有可恢复的 → 新建
	}
	return Session.create(client, { cwd, agentPreset: preset });
}

export async function startInteractive({ baseUrl, sessionId, preset, cwd, mode = "new" }) {
	const client = new DshClient(baseUrl);
	// 未显式给 cwd 时，用启动目录（Claude Code 心智：在工作目录启动即在其中工作）。
	const resolvedCwd = cwd || process.cwd();
	let session = await initialSession(client, { sessionId, mode, preset, cwd: resolvedCwd });
	writeRecent(session.sessionId, { cwd: session.cwd, agentPreset: session.agentPreset });

	// 应用 dsh-tui 配置（~/.dsh/dsh-tui.yml）：默认审批模式/权限档位/编辑工具白名单。
	const cfg = configToRuntime(loadConfig());
	const conv = new LiveConversation({
		client,
		session,
		approvalMode: cfg.approvalMode,
		policy: { editableTools: cfg.editableTools, allowTools: cfg.allowTools, allowBypassPermissions: cfg.allowBypassPermissions }
	});
	conv.setPermissionMode(cfg.permissionMode);

	const onCommand = async (cmdText) => {
		// cmdText 已是去掉 / 的剩余（或要带 /？）—— UI 传完整输入更好，这里直接收 name
		const routed = routeSlash(cmdText.startsWith("/") ? cmdText : `/${cmdText}`);
		if (!routed) return;
		if (routed.local) {
			await handleLocalAction(routed.action, { conv, client, onRestart });
			return;
		}
		// host 命令：以 /name args 发给 session.prompt
		try {
			await conv.send(`/${routed.name}${routed.args ? ` ${routed.args}` : ""}`);
		} catch (error) {
			conv.state.notice = `命令出错：${error.message}`;
			conv.emit();
		}
	};

	const handleLocalAction = async (action, { conv, client }) => {
		switch (action) {
			case "exit":
				process.exit(0);
				break;
			case "new": {
				const next = await Session.create(client, { cwd: session.cwd, agentPreset: session.agentPreset ?? PTC_PRESET });
				session = next;
				writeRecent(session.sessionId, { cwd: session.cwd, agentPreset: session.agentPreset });
				await conv.switchSession(next);
				conv.state.notice = `已新建会话：${session.sessionId}`;
				conv.emit();
				break;
			}
			case "resume": {
				const next = await Session.openRecent(client);
				if (!next) {
					conv.state.notice = "没有可恢复的会话";
					conv.emit();
					break;
				}
				if (next.sessionId === session.sessionId) {
					conv.state.notice = "已在最近会话上";
					conv.emit();
					break;
				}
				session = next;
				writeRecent(session.sessionId, { cwd: session.cwd, agentPreset: session.agentPreset });
				await conv.switchSession(next);
				conv.state.notice = `已恢复会话：${session.sessionId}`;
				conv.emit();
				break;
			}
			case "list": {
				const items = await Session.list(client);
				conv.state.notice = items
					.filter((i) => !i.blank)
					.slice(0, 5)
					.map((i) => `${i.sessionId.slice(0, 8)}${i.running ? "▶" : ""}${i.agentPreset ? `[${i.agentPreset}]` : ""}`)
					.join("  ");
				conv.emit();
				break;
			}
			case "status": {
				// 展示隐藏进 HUD 的会话详情（session ID/模型/上下文/模式/token）。
				const { hudState, formatCost, formatTokens } = await import("../lib/hud.js");
				const view = conv.snapshot();
				const hid = hudState({ view, session: { sessionId: session.sessionId, agentPreset: session.agentPreset, cwd: session.cwd } });
				const cost = formatCost(hid.costUsd);
				conv.state.notice =
					`session ${session.sessionId}` +
					` | ${hid.modelLabel}` +
					` | ${hid.mode}${hid.permBadge ? `/${hid.permBadge}` : ""}` +
					(cost ? ` | ${cost}` : "") +
					` | ${hid.hasUsage ? `${formatTokens(hid.usage.input)}i/${formatTokens(hid.usage.output)}o` : ""}`.trim() +
					`${session.cwd ? ` | cwd ${session.cwd}` : ""}`;
				conv.emit();
				break;
			}
			case "clear":
				conv.state.notice = "已清空客户端会话记忆（不影响 host 上的会话）";
				conv.emit();
				break;
			case "help": {
				const { allCommands } = await import("../lib/commands.js");
				const lines = allCommands()
					.map((c) => `/${c.name}${c.description ? ` — ${c.description}` : ""}`)
					.join("  ");
				conv.state.notice = `命令：${lines}`;
				conv.emit();
				break;
			}
			default:
				break;
		}
	};

	// onRestart 占位（switchSession 已覆盖切换，process 内部不需要重启）
	const onRestart = async () => {};

	render(
		React.createElement(App, {
			conv,
			session: { sessionId: session.sessionId, agentPreset: session.agentPreset, cwd: session.cwd },
			onCommand,
			onExit: () => {
				// 优雅退出：关流再退出
				try {
					conv.close();
				} catch {
					/* ignore */
				}
				process.exit(0);
			},
			getSession: () => session
		}),
		{ exitOnCtrlC: false } // 自管 Ctrl+C：运行中中断、空闲双按退出
	);

	// Ctrl+C / SIGINT：优雅关闭当前会话流
	process.on("SIGINT", () => {
		try {
			conv.close();
		} catch {
			/* ignore */
		}
		process.exit(0);
	});
}
