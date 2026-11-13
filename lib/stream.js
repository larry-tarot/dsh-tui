/**
 * Current DSH Remote mux client.
 *
 * DSH 0.2.2 uses `/api/remote.mux`, not the retired `/api/events.mux` SSE
 * carrier. Unary calls use the same authenticated API cookie; streams carry
 * `{ open, item, end, error }` frames and expose Remote values to live.js.
 */

/** Parse one JSON value received from the Remote mux. */
export function parseRemoteFrame(raw) {
	try {
		const frame = JSON.parse(typeof raw === "string" ? raw : String(raw ?? ""));
		if (!frame || typeof frame !== "object" || typeof frame.type !== "string" || typeof frame.streamId !== "string") return null;
		return frame;
	} catch {
		return null;
	}
}

/** Legacy parser retained for consumers of dsh-tui < 0.3. */
export function parseServerRequest(raw) {
	try {
		const message = JSON.parse(raw);
		return message && message.type === "server-request" && typeof message.payload === "object" ? message : null;
	} catch {
		return null;
	}
}

/** Legacy SSE helper retained for source compatibility. */
export function extractSseData(chunk) {
	return chunk.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("");
}

export class MuxStream {
	constructor(clientOrBaseUrl, { WebSocketImpl } = {}) {
		this.client = typeof clientOrBaseUrl === "string" ? null : clientOrBaseUrl;
		this.legacyEvents = typeof clientOrBaseUrl === "string";
		this.baseUrl = String(this.client?.baseUrl ?? clientOrBaseUrl).replace(/\/+$/, "");
		this.WebSocketImpl = WebSocketImpl ?? this.client?.WebSocketImpl ?? globalThis.WebSocket;
	}

	async openSocket() {
		if (this.client?.createWebSocket) return this.client.createWebSocket("/api/remote.mux");
		if (!this.WebSocketImpl) throw new Error("无 WebSocket 实现；请安装 ws 或注入 WebSocketImpl");
		const url = new URL("/api/remote.mux", this.baseUrl);
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		return new this.WebSocketImpl(url.href);
	}

	/** Open one Remote stream and yield its item values. */
	async *open(endpoint, payload = { args: {} }, { signal } = {}) {
		const ws = await this.openSocket();
		const streamId = `stream-${crypto.randomUUID()}`;
		const inbox = [];
		let wake;
		let closed = false;
		let failure = null;
		const notify = () => { wake?.(); wake = null; };
		const onMessage = (event) => {
			const frame = parseRemoteFrame(event.data);
			if (!frame || frame.streamId !== streamId) return;
			inbox.push(frame);
			notify();
		};
		const onError = () => { failure ??= new Error(`transport failure for ${endpoint}`); notify(); };
		const onClose = () => { closed = true; notify(); };
		ws.addEventListener("message", onMessage);
		ws.addEventListener("error", onError);
		ws.addEventListener("close", onClose);
		const abort = () => { try { ws.close(); } catch {} closed = true; notify(); };
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
		try {
			await new Promise((resolve, reject) => {
				if (ws.readyState === 1) return resolve();
				const onOpen = () => { ws.removeEventListener("error", onOpeningError); resolve(); };
				const onOpeningError = () => { ws.removeEventListener("open", onOpen); reject(new Error(`Remote mux failed to open for ${endpoint}`)); };
				ws.addEventListener("open", onOpen, { once: true });
				ws.addEventListener("error", onOpeningError, { once: true });
			});
			ws.send(JSON.stringify({ type: "open", streamId, endpoint, payload }));
			for (;;) {
				while (!inbox.length && !closed && !failure) await new Promise((resolve) => { wake = resolve; });
				const frame = inbox.shift();
				if (!frame) {
					if (failure) throw failure;
					if (closed) return;
					continue;
				}
				if (frame.type === "item") { yield frame.value; continue; }
				if (frame.type === "error") throw new Error(`${frame.error?.code ?? "remote-error"}: ${frame.error?.message ?? "Remote stream failed"}`);
				if (frame.type === "end") return;
			}
		} finally {
			signal?.removeEventListener("abort", abort);
			if (!closed) { try { ws.send(JSON.stringify({ type: "cancel", streamId })); } catch {} }
			try { ws.close(); } catch {}
		}
	}

	/** Compatibility carrier for the retired events.mux tests/older hosts. */
	async *frames({ signal, onOpen, WebSocketImpl } = {}) {
		const Impl = WebSocketImpl ?? this.WebSocketImpl;
		if (!Impl) throw new Error("无 WebSocket 实现；请安装 ws 或注入 WebSocketImpl");
		const url = this.baseUrl.replace(/^http/i, "ws") + "/api/events.mux";
		const ws = new Impl(url);
		const inbox = [];
		let closed = false;
		let closeError = null;
		let wake;
		const settle = () => { if (wake) { const resolve = wake; wake = null; resolve(); } };
		ws.addEventListener("open", () => { onOpen?.(); settle(); });
		ws.addEventListener("message", (event) => {
			const message = parseServerRequest(typeof event.data === "string" ? event.data : String(event.data ?? ""));
			if (message) inbox.push(message);
			settle();
		});
		ws.addEventListener("error", (event) => { closeError ??= new Error(`transport failure for events.mux: ${event.message || "websocket error"}`); settle(); });
		ws.addEventListener("close", () => { closed = true; settle(); });
		const abort = () => { try { ws.close(); } catch {} closed = true; settle(); };
		if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
		try {
			for (;;) {
				while (!inbox.length && !closed) await new Promise((resolve) => { wake = resolve; });
				if (inbox.length) yield inbox.shift();
				else if (closed) { if (closeError) throw closeError; return; }
			}
		} finally {
			signal?.removeEventListener("abort", abort);
			try { ws.close(); } catch {}
		}
	}
}

export async function respond(client, rpcId, result) {
	return client.respond(rpcId, result);
}
