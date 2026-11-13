/**
 * LiveConversation：会话的实时视图。
 *
 * 数据流：history 页做基线折叠（权威） → mux SSE 流增量折叠（实时）。
 * 增量按 seq 去重，assistant/chunk 不进消息列表而是累积成「流式草稿」，
 * assistant/message 到达时草稿落定进消息。UI 只消费 onState 推来的快照。
 *
 * 纯业务层：不依赖 React/Ink，测试用 fake client + fake stream 直接喂。
 */
import { foldEvents } from "./fold.js";
import { MuxStream } from "./stream.js";
import { answerApproval, answerQuestions, declinePlan, hasPlanReview } from "./policy.js";
import { PERMISSION_MODES, parseMode, allowToolsForMode, shouldDeclinePlanReview } from "./permission.js";
import { createTimingAccumulator, advanceTiming, timingSummary } from "./timing.js";

/** 初始视图快照。 */
export function initialState() {
	return {
		messages: [],
		tools: [],
		turn: 0,
		lastTurnEnd: null,
		turnStartTime: null, // 最近 turn/start 的时间戳（思考时长 / HUD ⏱）
		turnEndedAt: null, // 最近 turn/end 的本地墙钟时间戳（用于「Worked for」不随时间继续增长）
		lastSeq: -1,
		streaming: null, // { text, usage } — 未落定的 assistant 草稿
		running: false,
		model: null, // 最新 request/header 里的模型
		contextWindow: null, // 最新 request/context 的 contextWindow（HUD 上下文占用用）
		pendingQuestions: [],
		pendingApprovals: [],
		permissionMode: PERMISSION_MODES.MANUAL,
		queue: [],
		jobs: [],
		subagents: [], // 本会话 fork 出的子代理（subagent.list）
		notice: null, // 临时提示（slash 命令结果等）
		reconnecting: null, // { n, max } — mux 断连重连进度提示
		phaseTiming: null, // 最近回合的分相计时摘要（Thinking/Response/Tools）
		activePhase: null, // 当前回合进行到的相位 'thinking'|'responding'|'tools'|null（供运行中 spinner/阶段反馈）
		connected: false,
		error: null
	};
}

/** 按 seq 去重合并新事件（事件按 seq 严格递增，batch 内保持顺序）。 */
function mergeBySeq(events, minSeq) {
	const fresh = [];
	for (const event of events) {
		if (typeof event.seq === "number" && event.seq > minSeq) fresh.push(event);
	}
	fresh.sort((a, b) => a.seq - b.seq);
	return fresh;
}

/**
 * 按 callId 合并工具状态（纯函数，可单测）。
 * 关键修复（Codex 评审 #4）：`tool/result` 单独到达时，fold 里没有先前的 `tool/call` 可配对，
 * 缺 name/args；若只按 seq 追加会造成「同名重复卡片」且原卡永久 running。
 * 这里按 callId upsert：已存在则就地更新 status/finishedAt（保留 name/args），否则追加。
 * @param {Array<object>} existing - 现有 tools 列表。
 * @param {Array<object>} incoming - 新到要合并的 tools（可能只有 tool/result，name 缺失）。
 * @returns {Array<object>} 合并后的新列表。
 */
/** 判断当前 draft 是否有「应立刻 flush」的信号：任一块含换行（段落边界）或出现工具调用块。 */
export function hasFlushSignal(blocks) {
	if (!blocks) return false;
	let sawDoubleNewline = false;
	for (const b of blocks.values()) {
		if (b.type === "tool-call" || b.type === "reasoning" || b.type === "block-end") {
			if (b.type === "tool-call" || b.type === "reasoning") return true;
		}
		if (typeof b.text === "string" && /\n\s*\n/.test(b.text)) sawDoubleNewline = true;
	}
	return sawDoubleNewline;
}

export function mergeToolsByCallId(existing = [], incoming = []) {
	const out = [...existing];
	for (const t of incoming) {
		if (!t || !t.callId) continue;
		const idx = out.findIndex((x) => x.callId === t.callId);
		if (idx === -1) {
			out.push(t);
			continue;
		}
		// 保留原 name/args（result 不带），就地更新状态与完成时间。
		out[idx] = {
			...out[idx],
			...t,
			name: out[idx].name ?? t.name,
			args: out[idx].args ?? t.args
		};
	}
	return out;
}

export class LiveConversation {
	/**
	 * @param {object} deps
	 * @param {import("./client.js").DshClient} deps.client
	 * @param {import("./session.js").Session} deps.session
	 * @param {MuxStream} [deps.stream]
	 * @param {(state: object) => void} [deps.onState]
	 * @param {{ allowTools?: string[] }|null} [deps.policy] - 应答策略（approval 白名单等）
	 */
	constructor({ client, session, stream, onState, policy = null, approvalMode = "interactive" }) {
		this.client = client;
		this.session = session;
		this.stream = stream ?? new MuxStream(client);
		this.onState = onState ?? (() => {});
		this.policy = policy;
		this.approvalMode = approvalMode; // 'interactive' | 'auto'
		// 权限档位（Claude Code 概念映射到应答策略）：决定 approval 自动放行范围。
		this.permissionMode = PERMISSION_MODES.MANUAL;
		this.permissionOptions = {
			editableTools: (policy && policy.editableTools) || [],
			allowTools: (policy && policy.allowTools) || [],
			allowBypassPermissions: policy?.allowBypassPermissions === true
		};
		// 会话级审批放行（用户选「本会话允许」时记住的 toolName）。
		this.sessionAllowedTools = new Set();
		this.state = initialState();
		this.ac = new AbortController();
		this._draftBlocks = new Map(); // index → { type, text, name?, id? }
		this._draftUsage = null;
		// 流式可见发布调度（fix 逐字卡顿）：chunk 立即写内部完整状态，emit 合并到 ~50ms。
		this.streamingPublishMs = 50;
		// 单批最大字符数：避免一个超大 delta/突发把可见正文一次性渲染成巨大字符串。
		this.streamingMaxChars = 4000;
		this._streamingTimer = null;
		this._streamingDirty = false;
		// 步骤相位计时（Thinking/Response/Tools 分相，O(events) 共享游标累加），供 HUD/消息流展示。
		this._phaseEvents = [];
		this._phaseAcc = createTimingAccumulator();
		this._openPromise = null;
		this._consumePromise = null;
		this._historySyncPromise = null;
	}

	/**
	 * 交互式应答一个挂起的审批（用户选择后调用）。
	 * @param {object} approval - pendingApprovals 里的项（含 rpcId/approvalId/toolName）。
	 * @param {'allowed-once'|'allowed-session'|'rejected'} outcome
	 */
	async answerApproval(approval, outcome) {
		if (outcome === "allowed-session") {
			this.sessionAllowedTools.add(approval.toolName);
		}
		const value = {
			sessionId: this.session.sessionId,
			approvalId: approval.approvalId,
			outcome: outcome === "allowed-session" ? "allowed-once" : outcome
		};
		await this.client.respond(approval.rpcId, { ok: true, value });
		// respond 后 host 会发 approval/resolved 清掉 pending，这里也即时清除
		this.state.pendingApprovals = (this.state.pendingApprovals ?? []).filter(
			(a) => a.approvalId !== approval.approvalId
		);
		this.emit();
	}

	/**
	 * 交互式应答一个挂起的问题。
	 * @param {object} q - pendingQuestions 里的项（含 rpcId/questions）。
	 * @param {[{id:string, selected:string[]}]} answers - 每个问题选中的选项 label。
	 */
	async answerQuestion(q, answers) {
		const value = { sessionId: this.session.sessionId, answer: { answers } };
		await this.client.respond(q.rpcId, { ok: true, value });
		this.state.pendingQuestions = (this.state.pendingQuestions ?? []).filter(
			(p) => p.rpcId !== q.rpcId
		);
		this.emit();
	}

	/** 切换权限档位（Shift+Tab 循环用）；返回新档位。 */
	setPermissionMode(mode) {
		const parsed = parseMode(mode);
		this.permissionMode = parsed === PERMISSION_MODES.BYPASS && !this.permissionOptions.allowBypassPermissions
			? PERMISSION_MODES.MANUAL
			: parsed;
		this.state.permissionMode = this.permissionMode;
		this.emit();
		return this.permissionMode;
	}

	/** 视图快照（浅拷贝，React 可直接 setState）。 */
	snapshot() {
		return { ...this.state };
	}

	emit() {
		this.onState(this.snapshot());
	}

	/**
	 * 打开会话：拉 history 基线折叠，然后消费 mux 流直到 close()。
	 * 流断开会重连（退避重试），每次重连后重新拉基线（since 在 v1 未实现）。
	 */
	async open() {
		if (this._openPromise) return this._openPromise;
		const signal = this.ac.signal;
		this._openPromise = (async () => {
			await this.#baseline();
			if (signal.aborted) return;
			this.emit();
			if (!this._consumePromise) {
				this._consumePromise = this.#consume(signal).finally(() => {
					if (this.ac.signal === signal) this._consumePromise = null;
				});
			}
		})().catch((error) => {
			if (this.ac.signal === signal) this._openPromise = null;
			throw error;
		});
		return this._openPromise;
	}

	/** 启动 history 轮询兜底（由 UI 层调用；mux 断帧时回复必达）。 */
	startHistorySync(intervalMs = 1200) {
		if (this._historySyncPromise) return this._historySyncPromise;
		const signal = this.ac.signal;
		this._historySyncPromise = this.#historySync(intervalMs, signal).finally(() => {
			if (this.ac.signal === signal) this._historySyncPromise = null;
		});
		return this._historySyncPromise;
	}

	/** 立即对超时 pending 做落定判定（供测试/手动触发；正常由 historySync 周期调用）。 */
	resolveStuckPending(stuckAfterMs) {
		this.#resolveStuckPending(stuckAfterMs);
	}

	/** 立即发布待发的流式草稿（清定时器；测试/需要立刻可见时用）。 */
	flushStreaming() {
		this.#flushStreamingView();
	}

	/**
	 * 轮询兜底：周期从 session.history 拉事件并折叠合并进 state。
	 * mux SSE 流若断/漏帧（网络、重连失败、host 长会话），只靠 mux 会丢回复；
	 * history 是权威源，轮询保证「发出的消息最终显示回复」，与 run 一致可靠。
	 */
	async #historySync(intervalMs = 1200, signal = this.ac.signal) {
		while (!signal.aborted) {
			try {
				await this.refreshHistory();
				this.#resolveStuckPending();
			} catch {
				// host 瞬时不可用，继续轮询
			}
			await this.#sleep(intervalMs, signal);
		}
	}

	/**
	 * 手动触发一轮 history 合并（可测试：验证 history 兜底能落定 running / 合并工具 / 带回回复）。
	 * 返回本次是否有新事件被合并。
	 */
	async refreshHistory() {
		const page = await this.session.history({ maxMessages: 128 });
		const view = foldEvents(page.events);
		if (!view.messages.length && !view.lastTurnEnd && view.tools.length === 0) {
			return false;
		}
		this.#mergeView(view);
		return true;
	}

	/**
	 * pending 永不无限期（对齐 Codex "重试后仍无返回则明确报错"）：
	 * 超过 stuckAfterMs 仍未落定 → 标 stuck，UI 显示"可能未生效，试试重发"。
	 * 默认 60s（足够长模型正常的慢轮完成）。
	 */
	#resolveStuckPending(stuckAfterMs = 60_000) {
		const now = Date.now();
		let changed = false;
		this.state.messages = this.state.messages.map((m) => {
			if (m.pending && !m.stuck) {
				const sentAt = m.sentAt ?? m.time ?? 0;
				if (sentAt && now - sentAt > stuckAfterMs) {
					changed = true;
					return { ...m, stuck: true };
				}
			}
			return m;
		});
		if (changed) this.emit();
	}

	async #sleep(ms, signal = this.ac.signal) {
		if (signal.aborted) return;
		await new Promise((resolve) => {
			const finish = () => {
				signal.removeEventListener("abort", onAbort);
				resolve();
			};
			const t = setTimeout(finish, ms);
			const onAbort = () => { clearTimeout(t); resolve(); };
			if (signal.aborted) { onAbort(); return; }
			signal.addEventListener("abort", onAbort, { once: true });
		});
	}

	/** 用服务端 history 对账，但保留尚未落定的本地乐观消息。 */
	#reconcileMessages(serverMessages = []) {
		const persisted = new Map();
		for (const message of this.state.messages) {
			if (typeof message.seq === "number" && message.seq >= 0) persisted.set(message.seq, message);
		}
		for (const message of serverMessages) {
			if (typeof message.seq === "number" && message.seq >= 0) persisted.set(message.seq, message);
		}
		const pending = this.state.messages.filter((message) => message.pending);
		for (const message of serverMessages) {
			if (message.role !== "user") continue;
			const index = pending.findIndex((item) => item.text === message.text);
			if (index !== -1) pending.splice(index, 1);
		}
		return [...persisted.values()].sort((a, b) => a.seq - b.seq).concat(pending);
	}

	/** 把 fold 视图按 seq 增量合并进 state（mux 与 history 兜底共用）。 */
	#mergeView(view) {
		this.state.messages = this.#reconcileMessages(view.messages);
		if (view.tools.length) this.state.tools = mergeToolsByCallId(this.state.tools, view.tools);
		this.state.lastSeq = Math.max(this.state.lastSeq, view.lastSeq ?? -1);
		this.#syncStateMeta(view);
		this.emit();
	}

	/** 同步 lastTurnEnd/turn/model/contextWindow/running/turnStartTime。 */
	#syncStateMeta(view) {
		if (view.lastTurnEnd) {
			// 收到更新的 turn/end → 本轮确实已结束（不用等 mux 的 turn/end；Codex 评审 #5）。
			// 若这个 end 比当前已知的更「新」（seq 更高 / turn 更大），就把 running 落定为 false。
			const cur = this.state.lastTurnEnd;
			const newer = !cur || (view.lastTurnEnd.seq ?? 0) >= (cur.seq ?? 0);
			this.state.lastTurnEnd = view.lastTurnEnd;
			if (newer && this.state.running) {
				this.state.running = false;
				// 通过 history 兜底观察到 turn/end（非 mux 的 turn/end 事件）时，也要落定结束墙钟，
				// 否则 workedLabel 会退回 now 从而一直走秒（P1 #5 的 history 路径漏修）。
				if (!this.state.turnEndedAt) this.state.turnEndedAt = view.turnEndedAt ?? view.lastTurnEnd.time ?? Date.now();
			}
		}
		if (view.turn > this.state.turn) this.state.turn = view.turn;
		if (view.turnStartTime) this.state.turnStartTime = view.turnStartTime;
		if (view.model) this.state.model = view.model;
		if (view.contextWindow) this.state.contextWindow = view.contextWindow;
	}

	async #baseline() {
		const page = await this.session.history({ maxMessages: 128 });
		const view = foldEvents(page.events);
		this.state = {
			...this.state,
			messages: this.#reconcileMessages(view.messages),
			tools: mergeToolsByCallId(this.state.tools, view.tools),
			turn: view.turn,
			lastTurnEnd: view.lastTurnEnd,
			turnStartTime: view.turnStartTime ?? this.state.turnStartTime,
			lastSeq: Math.max(this.state.lastSeq, view.lastSeq ?? -1),
			turnEndedAt: view.turnEndedAt ?? this.state.turnEndedAt,
			model: view.model ?? this.state.model,
			contextWindow: view.contextWindow ?? this.state.contextWindow,
			connected: true
		};
	}

	async #consume(signal = this.ac.signal) {
		let attempts = 0;
		const MAX_ATTEMPTS = 6;
		for (;;) {
			if (signal.aborted) return;
			try {
				const frames = typeof this.stream.open === "function" && this.client?.createWebSocket
					? this.stream.open("session/follow", {
						args: { request: {
							address: { kind: "session", sessionId: this.session.sessionId },
							maxMessages: 128,
							activate: true,
							assistantStream: true
						} }
					}, { signal })
					: this.stream.frames({ signal });
				for await (const envelope of frames) {
					attempts = 0;
					// 重连成功/恢复：清除"正在重连"提示
					if (this.state.reconnecting) {
						this.state.reconnecting = null;
						this.state.notice = "已重新连接";
						this.emit();
					}
					if (this.client?.createWebSocket) this.#onRemoteValue(envelope);
					else this.#onFrame(envelope.payload, envelope.rpcId);
				}
				if (signal.aborted) return;
				throw new Error("events.mux closed");
			} catch (error) {
				if (signal.aborted) return;
				attempts += 1;
				if (attempts > MAX_ATTEMPTS) {
					this.state.error = `mux 流重连失败：${error.message}`;
					this.state.reconnecting = null;
					this.emit();
					return;
				}
				// 重连可视化（Codex "Reconnecting n/N" 模式）：告诉用户没卡死、在重连
				this.state.reconnecting = { n: attempts, max: MAX_ATTEMPTS };
				this.emit();
				await this.#sleep(Math.min(2000, 250 * 2 ** attempts), signal);
				if (signal.aborted) return;
				try {
					await this.#baseline(); // 重连后重新对齐基线
					this.emit();
				} catch {
					// 基线失败也继续重试
				}
			}
		}
	}

	#onRemoteValue(value) {
		if (!value) return;
		if (value.type === "snapshot") {
			const view = foldEvents(value.records ?? []);
			this.state = { ...this.state, lastSeq: Math.max(this.state.lastSeq, value.cursor ?? -1), connected: true };
			this.#syncStateMeta(view);
			return;
		}
		if (value.type === "event") {
			this.#onEvent(value.event);
			return;
		}
		if (value.type === "assistant-stream") {
			const frame = value.frame;
			if (frame?.type === "chunk") this.#applyChunk(frame.chunk);
			if (frame?.type === "end") this.#flushStreamingView();
			return;
		}
		if (value.type === "emit") return;
	}

	#onFrame(frame, rpcId) {
		if (frame.sessionId && frame.sessionId !== this.session.sessionId) return;
		switch (frame.type) {
			case "session/subscribed": {
				// subscribed.lastSeq 是服务端快照游标，不代表本地已经消费这些事件。
				// 直接推进会让 history 对账把基线与订阅之间的事件误判为已见；发现差距时拉 history。
				if (frame.lastSeq > this.state.lastSeq) this.refreshHistory().catch(() => {});
				break;
			}
			case "session/event": {
				this.#onEvent(frame.event);
				break;
			}
			case "question/requested": {
				const q = { rpcId, questions: frame.questions };
				this.state.pendingQuestions = [...this.state.pendingQuestions, q];
				// interactive 模式由 TUI QuestionPanel 明确让用户选择；auto 模式才按安全策略
				// 回答。禁止在可交互终端里静默替用户选择第一项。
				if (this.approvalMode === "auto") {
					this.#autoReply(frame, rpcId).catch((error) => {
						this.state.notice = `问题应答失败：${error.message}`;
						this.emit();
					});
				}
				this.emit();
				break;
			}
			case "question/resolved": {
				this.state.pendingQuestions = this.state.pendingQuestions.filter(
					(p) => p.rpcId !== frame.questionRpcId
				);
				this.emit();
				break;
			}
			case "approval/requested": {
				const approval = { approvalId: frame.approvalId, toolName: frame.toolName, rpcId };
				this.state.pendingApprovals = [...(this.state.pendingApprovals ?? []), approval];
				// 权限档位预授权：acceptEdits 档放行编辑工具、bypass 全放行（不进会话记忆）。
				const presetAllowed =
					(this.permissionMode === PERMISSION_MODES.ACCEPT_EDITS &&
						this.permissionOptions.editableTools.includes(frame.toolName)) ||
					(this.permissionMode === PERMISSION_MODES.BYPASS && this.permissionOptions.allowBypassPermissions);
				if (presetAllowed) {
					this.#autoAllow(frame, rpcId);
					break;
				}
				// 本会话已放行的工具直接自动允许（用户之前选过「本会话允许」）。
				if (this.sessionAllowedTools.has(frame.toolName)) {
					this.#autoAllow(frame, rpcId);
					break;
				}
				// 默认交互：挂起等 answerApproval；auto 模式才按档位自动应答。
				if (this.approvalMode !== "auto") this.emit();
				else {
					this.#autoReply(frame, rpcId).catch((error) => {
						this.state.notice = `审批应答失败：${error.message}`;
						this.emit();
					});
					this.emit();
				}
				break;
			}
			case "approval/resolved": {
				this.state.pendingApprovals = (this.state.pendingApprovals ?? []).filter(
					(a) => a.approvalId !== frame.approvalId
				);
				this.emit();
				break;
			}
			case "session/queue": {
				this.state.queue = frame.items;
				this.emit();
				break;
			}
			case "session/jobs": {
				this.state.jobs = frame.jobs;
				this.emit();
				break;
			}
			case "stream/error": {
				this.state.error = `${frame.error.code}: ${frame.error.message}`;
				this.emit();
				break;
			}
			default:
				break;
		}
	}

	#onEvent(event) {
		if (event.type === "assistant/chunk") {
			this.#applyChunk(event.data.chunk);
			return; // chunk 不参与折叠
		}
		if (event.type === "assistant/message") {
			// 草稿落定：先 flush 掉最后一个可见的流式批（否则定时器未发的尾 delta 会被清掉），再清空。
			this.#flushStreamingView();
			this._draftBlocks.clear();
			this._draftUsage = null;
			this.state.streaming = null;
		}
		if (event.type === "turn/start") {
			this.state.running = true;
			this.state.turnEndedAt = null; // 新一轮开始，清旧结束时间
			this.state.phaseTiming = null;
			this.state.activePhase = null;
		}
		if (event.type === "turn/end") {
			this.state.running = false;
			// 回合结束：关掉最后一段活跃相位，把分相计时写进 state 供 UI 展示。
			this.#closePhaseTiming();
			this.state.turnEndedAt = event.time ?? this.state.turnEndedAt;
		}

		const fresh = mergeBySeq([event], this.state.lastSeq);
		if (fresh.length === 0) return;
		this.state.lastSeq = Math.max(this.state.lastSeq, event.seq);

		if (event.type === "request/context") {
			if (event.data && typeof event.data.contextWindow === "number") {
				this.state.contextWindow = event.data.contextWindow;
			}
		}
		if (event.type === "user/message") {
			// 用真实事件替换乐观回显行（FIFO：先发先到，替换最早那条 pending）
			const view = foldEvents([{ event }]);
			const optimistic = this.state.messages.findIndex((m) => m.pending);
			if (optimistic !== -1) {
				this.state.messages[optimistic] = { ...view.messages[0] };
				this.emit();
				return;
			}
			this.state.messages = [...this.state.messages, ...view.messages];
			this.emit();
			return;
		}

		const view = foldEvents([{ event }]);
		if (view.messages.length) this.state.messages = [...this.state.messages, ...view.messages];
		if (view.tools.length) this.state.tools = mergeToolsByCallId(this.state.tools, view.tools);
		if (view.turn > this.state.turn) this.state.turn = view.turn;
		if (view.lastTurnEnd) this.state.lastTurnEnd = view.lastTurnEnd;
		if (view.model) this.state.model = view.model;
		this.emit();
	}

	#applyChunk(chunk) {
		const draft = this._draftBlocks;
		switch (chunk.type) {
			case "block-start": {
				draft.set(chunk.index, { type: chunk.blockType, text: "" });
				break;
			}
			case "text-delta": {
				const block = draft.get(chunk.index) ?? { type: "text", text: "" };
				block.text += chunk.text;
				draft.set(chunk.index, block);
				this.#feedPhase("responding");
				break;
			}
			case "reasoning-delta": {
				const block = draft.get(chunk.index) ?? { type: "reasoning", text: "" };
				block.text += chunk.text;
				draft.set(chunk.index, block);
				this.#feedPhase("thinking");
				break;
			}
			case "tool-call-delta": {
				const block = draft.get(chunk.index) ?? { type: "tool-call", id: chunk.id, name: "", arguments: "" };
				block.id = chunk.id;
				if (chunk.name) block.name = chunk.name;
				block.arguments = (block.arguments ?? "") + (chunk.argumentsDelta ?? "");
				draft.set(chunk.index, block);
				this.#feedPhase("tools");
				break;
			}
			case "block-end": {
				draft.set(chunk.index, { type: chunk.block.type, text: chunk.block.text ?? "" });
				break;
			}
			case "usage": {
				this._draftUsage = chunk.usage;
				// usage 不改变可见正文；不发正文重绘。返回让下方不 schedule。
				this.state.streaming = this.#draftView();
				return;
			}
			case "finish":
				break;
			default:
				break;
		}
		this.state.streaming = this.#draftView();
		this.#scheduleStreamingPublish();
	}

	/**
	 * 记录一个相位事件（thinking/responding/tools）喂给共享游标累加器。
	 * 同一相位连续多次只记一次（游标推进后惰性补时间戳）。
	 * @param {string} phase
	 */
	#feedPhase(phase) {
		const now = Date.now();
		const last = this._phaseEvents[this._phaseEvents.length - 1];
		if (last && last.phase === phase) return; // 已在此相位，不重复记
		this._phaseEvents.push({ phase, at: now });
		advanceTiming(this._phaseAcc, this._phaseEvents);
		this.state.activePhase = phase; // 驱动 UI 的「Thinking/Responding/Tools」实时阶段提示
	}

	/** 回合结束：关掉最后活跃相位，把分相计时摘要写进 state（供“✻ Worked for … · Thinking …”展示）。 */
	#closePhaseTiming(endedAt = Date.now()) {
		this._phaseEvents.push({ phase: null, at: endedAt });
		const buckets = advanceTiming(this._phaseAcc, this._phaseEvents);
		this.state.phaseTiming = timingSummary(buckets) || null;
		// 记录回合结束墙钟，供 UI 计算稳定的「Worked for」（不再用会继续增长的 now）。
		this.state.turnEndedAt = endedAt;
		this.state.activePhase = null; // 回合结束，清掉进行中相位
	}

	/**
	 * 合并流式可见发布：把「把最新 draft 写进 state + emit」延迟到 ~50ms 一批。
	 * 协议 chunk 已立即写进 _draftBlocks（不丢/不改），这里只控制 UI 更新频率。
	 * 要 flush 的事件（换行、工具边界、finish、error、assistant/message、会话结束）调 #flushStreamingView。
	 * @param {object} [opts]
	 */
	#scheduleStreamingPublish(opts = {}) {
		// 换行/工具边界立即 flush；或单批超出最大字符数（防一次渲染超大字符串）也立即 flush。
		const draftText = this.#draftView()?.text ?? "";
		const flush =
			opts.flush ||
			(this._draftBlocks && hasFlushSignal(this._draftBlocks)) ||
			(this.streamingMaxChars > 0 && draftText.length >= this.streamingMaxChars);
		this._streamingDirty = true;
		if (flush) {
			this.#flushStreamingView();
			return;
		}
		if (this._streamingTimer) return; // 已有定时器，合并到它
		this._streamingTimer = setTimeout(() => {
			this._streamingTimer = null;
			this.#flushStreamingView();
		}, this.streamingPublishMs);
	}

	/** 立即把当前流式草稿发布为可见状态（清定时器）。供 finish / settle / 请求立刻 flush 用。 */
	#flushStreamingView() {
		if (this._streamingTimer) { clearTimeout(this._streamingTimer); this._streamingTimer = null; }
		if (!this._streamingDirty) return;
		this._streamingDirty = false;
		this.state.streaming = this.#draftView();
		this.emit();
	}

	#draftView() {
		const text = [...this._draftBlocks.values()]
			.filter((block) => block.type === "text" && block.text)
			.map((block) => block.text)
			.join("\n");
		if (!text && !this._draftUsage) return null;
		return { text, usage: this._draftUsage ?? null };
	}

	/**
	 * 发送一条消息。普通消息乐观回显 user 行；/ 开头走 host 命令注册表（不乐观回显，
	 * 命令结果放进 notice）。
	 */
	async send(text) {
		const isCommand = text.startsWith("/");
		if (!isCommand) {
			this.state.messages = [
				...this.state.messages,
				{ role: "user", seq: -1, time: Date.now(), sentAt: Date.now(), text, pending: true }
			];
			this.state.notice = null;
			this.emit();
		}
		try {
			const res = await this.session.prompt(text);
			if (res.command) {
				this.state.notice = res.command.text ?? `已执行 ${text}`;
				this.emit();
			}
			return res;
		} catch (error) {
			this.state.messages = this.state.messages.filter((m) => m.seq !== -1 || !m.pending);
			this.state.notice = `发送失败：${error.message}`;
			this.emit();
			throw error;
		}
	}

	/** 应答一个可应答帧（question/approval requested）。 */
	async #autoReply(frame, rpcId) {
		if (!rpcId) return;
		let value;
		if (frame.type === "question/requested") {
			// 当前权限档位决定 plan-review 是否自动拒绝（manual/plan 拒绝）。
			const decline = shouldDeclinePlanReview(this.permissionMode) && hasPlanReview(frame.questions);
			value = decline
				? declinePlan(this.session.sessionId, frame.questions)
				: answerQuestions(this.session.sessionId, frame.questions, this.policy?.questions ?? {});
		} else if (frame.type === "approval/requested") {
			const allowTools = allowToolsForMode(this.permissionMode, this.permissionOptions);
			value = answerApproval(this.session.sessionId, frame, { allowTools });
		} else {
			return;
		}
		await this.client.respond(rpcId, { ok: true, value });
	}

	/**
	 * 预授权/会话级放行的自动批准。**只在 respond 成功后移除 pending**；
	 * 失败时保留 pending 并提示（Codex 评审 #6：避免网络失败时审批被吞、agent 却还在等）。
	 * @param {object} frame - approval/requested 帧（含 approvalId）。
	 * @param {string} rpcId
	 */
	async #autoAllow(frame, rpcId) {
		const value = {
			sessionId: this.session.sessionId,
			approvalId: frame.approvalId,
			outcome: "allowed-once"
		};
		try {
			await this.client.respond(rpcId, { ok: true, value });
			this.state.pendingApprovals = (this.state.pendingApprovals ?? []).filter(
				(a) => a.approvalId !== frame.approvalId
			);
		} catch (error) {
			this.state.notice = `自动审批应答失败：${error.message}（保留待你处理 y/n）`;
		}
		this.emit();
	}

	/**
	 * 停止当前回合（session.cancel）。TUI 的 `:cancel` / Esc 连按用。
	 */
	async cancelTurn() {
		try {
			await this.client.request("session.cancel", { sessionId: this.session.sessionId });
			this.state.notice = "已请求停止";
			this.emit();
		} catch (error) {
			this.state.notice = `停止失败：${error.message}`;
			this.emit();
		}
	}

	/**
	 * 拉取本会话 fork 出的子代理（只读状态板）。
	 * host 的 subagent.list 需要 parentSessionId=当前会话；失败时静默并置空。
	 */
	async refreshSubagents() {
		try {
			const resp = await this.client.request("subagent.list", {
				parentSessionId: this.session.sessionId
			});
			this.state.subagents = (resp && resp.items) || [];
			this.emit();
		} catch {
			this.state.subagents = [];
			this.emit();
		}
	}

	/**
	 * 切换到另一个会话：重置状态 + 关闭旧流 + 绑定新 session + 重新 baseline。
	 * @param {import("./session.js").Session} next - 新会话。
	 */
	async switchSession(next) {
		this.ac.abort();
		this.ac = new AbortController();
		this._openPromise = null;
		this._consumePromise = null;
		this._historySyncPromise = null;
		this._draftBlocks.clear();
		this._draftUsage = null;
		this.session = next;
		this.state = initialState();
		await this.open();
		this.startHistorySync();
	}

	close() {
		if (this._streamingTimer) { clearTimeout(this._streamingTimer); this._streamingTimer = null; }
		this.ac.abort();
	}
}
