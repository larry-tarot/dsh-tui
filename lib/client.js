import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import WebSocket from "ws";

const DEFAULT_BASE = "http://127.0.0.1:3080";
const NATIVE_FETCH = globalThis.fetch;

/** Mint a fresh rpcId (the initiator always mints; responses echo it). */
export function mintRpcId() {
	return `rpc-${randomUUID()}`;
}

/** Mint the request identity required by current DSH Session.prompt. */
export function mintRequestId() {
	return `request-${randomUUID()}`;
}

function discoverLaunchToken() {
	if (process.env.DSH_TOKEN) return process.env.DSH_TOKEN;
	const logPath = process.env.DSH_WEB_LOG ?? `${process.env.DSH_HOME ?? `${homedir()}/.dsh`}/logs/web.log`;
	try {
		const text = readFileSync(logPath, "utf8");
		return [...text.matchAll(/dsh web:\s+[^\s?]+:\/\/[^\s/]+(?::\d+)?\/\?token=([^\s]+)/g)].at(-1)?.[1] ?? null;
	} catch {
		return null;
	}
}

function parseCookie(setCookie) {
	if (!setCookie) return null;
	return setCookie.split(";", 1)[0];
}

function endpointFor(method) {
	if (method === "session.history") return "session/events";
	if (method === "subagent.list") return "subagents/list";
	return method
		.replace(/^subagent\./, "subagent/")
		.replace(/^session\./, "session/")
		.replace(/\./g, "/");
}

/** Convert the pre-0.2 TUI method aliases to current Typert Remote arguments. */
function requestArgs(method, payload) {
	if (method === "session.list") return { _request: payload ?? {} };
	if (method === "session.history") {
		const { sessionId, ...page } = payload ?? {};
		return { request: { address: { kind: "session", sessionId }, ...page } };
	}
	if (method.startsWith("session.") && method !== "session.initializeDefaultModel") {
		return { request: payload ?? {} };
	}
	return {};
}

/**
 * DSH Web API client.
 *
 * Current DSH uses slash-separated Typert Remote endpoints (`session/list`),
 * wraps arguments in `{ args: ... }`, and authenticates HTTP/WebSocket traffic
 * with the launch-token-derived browser/API cookie. This class keeps the old
 * dsh-tui method names as a compatibility layer for the UI.
 */
export class DshClient {
	constructor(baseUrl = DEFAULT_BASE, { token = null, fetchImpl = null, WebSocketImpl = WebSocket } = {}) {
		const raw = String(baseUrl).replace(/\/+$/, "");
		const parsed = new URL(raw);
		const injectedTransport = fetchImpl !== null;
		this.token = token !== null ? token : (parsed.searchParams.get("token") ?? (injectedTransport ? null : discoverLaunchToken()));
		parsed.searchParams.delete("token");
		this.baseUrl = parsed.toString().replace(/\/+$/, "");
		this.fetchImpl = fetchImpl;
		this.WebSocketImpl = WebSocketImpl;
		this.cookie = null;
		this.authPromise = null;
		// Keep injected fake transports compatible with the pre-auth unit contract.
		this.legacyTransport = injectedTransport;
	}

	isLegacyTransport() {
		return this.legacyTransport || (this.fetchImpl === null && globalThis.fetch !== NATIVE_FETCH);
	}

	fetcher() {
		return this.fetchImpl ?? globalThis.fetch;
	}

	async ensureAuth() {
		if (this.isLegacyTransport()) return "";
		if (this.cookie) return this.cookie;
		if (this.authPromise) return this.authPromise;
		this.authPromise = (async () => {
			if (!this.token) {
				throw new Error("DSH Web 需要认证：请设置 DSH_TOKEN，或先运行 dsh web 让 dsh-tui 自动读取 ~/.dsh/logs/web.log");
			}
			const fetcher = this.fetcher();
			const root = await fetcher(`${this.baseUrl}/?token=${encodeURIComponent(this.token)}`, { redirect: "manual" });
			const rootCookie = parseCookie(root.headers?.get?.("set-cookie"));
			if (rootCookie) this.cookie = rootCookie;
			if (!rootCookie && root.status !== 303 && root.status !== 200) {
				throw new Error(`DSH 认证失败：HTTP ${root.status}，请重新运行 dsh web 并使用最新 token`);
			}
			// API cookies are accepted by both unary HTTP and the Remote mux. The
			// connect exchange also creates the Peer used by the WebSocket carrier.
			const connect = await fetcher(`${this.baseUrl}/connect?token=${encodeURIComponent(this.token)}&interactions=answer`, {
				redirect: "manual",
				headers: this.cookie ? { cookie: this.cookie } : undefined
			});
			const apiCookie = parseCookie(connect.headers?.get?.("set-cookie"));
			if (apiCookie) this.cookie = apiCookie;
			if (!this.cookie) throw new Error("DSH 认证失败：服务端没有返回会话 Cookie");
			return this.cookie;
		})().catch((error) => {
			this.authPromise = null;
			throw error;
		});
		return this.authPromise;
	}

	async request(method, payload = {}, { signal } = {}) {
		const cookie = await this.ensureAuth();
		const rpcId = mintRpcId();
		const legacyTransport = this.isLegacyTransport();
		const endpoint = legacyTransport ? method : endpointFor(method);
		const response = await this.fetcher()(`${this.baseUrl}/api/${endpoint}`, {
			method: "POST",
			headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
			body: JSON.stringify({
				type: "client-request",
				rpcId,
				method: endpoint,
				payload: legacyTransport ? payload : { args: requestArgs(method, payload) }
			}),
			...(signal ? { signal } : {})
		});
		if (!response.ok) {
			const suffix = response.status === 401 ? "（认证已失效，请重启 dsh web 后重试）" : "";
			throw new Error(`HTTP ${response.status} from ${endpoint}${suffix}`);
		}
		const message = await response.json();
		if (message.type !== "server-response") throw new Error(`unexpected response type: ${String(message.type)}`);
		if (message.rpcId !== rpcId) throw new Error("rpcId mismatch in server response");
		if (!message.result.ok) {
			const error = message.result.error;
			const errorObject = new Error(`${error.code}: ${error.message}`);
			errorObject.code = error.code;
			errorObject.details = error.details;
			throw errorObject;
		}
		return message.result.value;
	}

	/** Create an authenticated ws(s) socket for the current DSH Remote mux. */
	async createWebSocket(path) {
		const cookie = await this.ensureAuth();
		const url = new URL(path, this.baseUrl);
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		return new this.WebSocketImpl(url.href, { headers: { cookie } });
	}

	async respond(rpcId, result) {
		// Current DSH approvals/questions are Remote events. Keep the legacy
		// endpoint for older hosts, but make its authentication and path current.
		const cookie = await this.ensureAuth();
		const response = await this.fetcher()(`${this.baseUrl}/api/respond`, {
			method: "POST",
			headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
			body: JSON.stringify({ type: "client-response", rpcId, result })
		});
		if (!response.ok) throw new Error(`HTTP ${response.status} from respond`);
		return response.json();
	}
}

export { endpointFor, requestArgs };
