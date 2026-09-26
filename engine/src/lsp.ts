/** LSP-синхронизация: нерешённые member-вызовы (unresolved.json) → goToDefinition через stdio-LSP.
 *  Рёбра добавляются с confidence "lsp". Серверы опциональны — без бинаря lspSync честно отчитывается.
 *  Фрейминг: JSON-RPC 2.0 с заголовком Content-Length (стандарт LSP). */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { LspCandidate } from "./types.js";
import { readGraph, writeGraph } from "./store.js";

export interface LspServerDef {
	bin: string;
	label: string;
	install: string;
	args?: string[];
}

/** lang → LSP-сервер (то, что покрывает наши нерешённые вызовы на практике). */
export const LSP_SERVERS: Record<string, LspServerDef> = {
	ts: { bin: "typescript-language-server", label: "TypeScript", install: "npm i -g typescript-language-server typescript", args: ["--stdio"] },
	js: { bin: "typescript-language-server", label: "TypeScript", install: "npm i -g typescript-language-server typescript", args: ["--stdio"] },
	jsx: { bin: "typescript-language-server", label: "TypeScript", install: "npm i -g typescript-language-server typescript", args: ["--stdio"] },
	tsx: { bin: "typescript-language-server", label: "TypeScript", install: "npm i -g typescript-language-server typescript", args: ["--stdio"] },
	py: { bin: "pyright-langserver", label: "Python (pyright)", install: "npm i -g pyright", args: ["--stdio"] },
	go: { bin: "gopls", label: "Go (gopls)", install: "go install golang.org/x/tools/gopls@latest" },
	rust: { bin: "rust-analyzer", label: "Rust (rust-analyzer)", install: "cargo install rust-analyzer" },
	c: { bin: "clangd", label: "C/C++ (clangd)", install: "apt/brew install clangd (llvm)" },
	cpp: { bin: "clangd", label: "C/C++ (clangd)", install: "apt/brew install clangd (llvm)" },
};

export function lspAvailable(lang: string): boolean {
	const def = LSP_SERVERS[lang];
	if (!def) return false;
	try {
		const r = spawnSync("sh", ["-c", `command -v ${def.bin}`], { encoding: "utf8" });
		return r.status === 0 && r.stdout.trim().length > 0;
	} catch {
		return false;
	}
}

/** Статус: по каждому языку с кандидатами — доступен ли сервер. */
export function lspStatus(root: string): Array<{ lang: string; bin: string; available: boolean; candidates: number; install: string }> {
	const counts = new Map<string, number>();
	for (const c of readUnresolvedLocal(root)) {
		const lang = (c.file.split(".").pop() ?? "").toLowerCase();
		const known = langExtToLang(lang);
		if (known) counts.set(known, (counts.get(known) ?? 0) + 1);
	}
	const out: Array<{ lang: string; bin: string; available: boolean; candidates: number; install: string }> = [];
	for (const [lang, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
		const def = LSP_SERVERS[lang];
		if (!def) continue;
		out.push({ lang, bin: def.bin, available: lspAvailable(lang), candidates: n, install: def.install });
	}
	return out;
}

function readUnresolvedLocal(root: string): LspCandidate[] {
	try {
		return (JSON.parse(readFileSync(join(root, "graft", ".engine", "unresolved.json"), "utf8")) as { list: LspCandidate[] }).list;
	} catch {
		return [];
	}
}

function langExtToLang(ext: string): string | null {
	const m: Record<string, string> = {
		ts: "ts", tsx: "tsx", mts: "ts", cts: "ts", js: "js", mjs: "js", cjs: "js", jsx: "jsx",
		py: "py", go: "go", rs: "rust", c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp",
	};
	return m[ext] ?? null;
}

export interface LspSyncReport {
	langs: Array<{ lang: string; bin: string; available: boolean; ok: boolean; edges: number; error?: string; install?: string }>;
	totalEdges: number;
	candidates: number;
}

/** Прогоняет кандидатов через доступные LSP-серверы и добавляет рёбра confidence "lsp". */
export async function lspSync(root: string): Promise<LspSyncReport> {
	const candidates = readUnresolvedLocal(root);
	const byLang = new Map<string, LspCandidate[]>();
	for (const c of candidates) {
		const lang = langExtToLang((c.file.split(".").pop() ?? "").toLowerCase());
		if (!lang) continue;
		byLang.set(lang, [...(byLang.get(lang) ?? []), c]);
	}
	const langs: LspSyncReport["langs"] = [];
	let total = 0;
	for (const [lang, list] of byLang) {
		const def = LSP_SERVERS[lang];
		if (!def) continue;
		if (!lspAvailable(lang)) {
			langs.push({ lang, bin: def.bin, available: false, ok: false, edges: 0, error: "бинарь не найден", install: def.install });
			continue;
		}
		try {
			const edges = await lspResolveLang(root, def, lang, list);
			total += edges;
			langs.push({ lang, bin: def.bin, available: true, ok: true, edges });
		} catch (e) {
			langs.push({ lang, bin: def.bin, available: true, ok: false, edges: 0, error: e instanceof Error ? e.message : String(e) });
		}
	}
	return { langs, totalEdges: total, candidates: candidates.length };
}

async function lspResolveLang(root: string, def: LspServerDef, lang: string, list: LspCandidate[]): Promise<number> {
	const proc = spawn(def.bin, def.args ?? [], { stdio: ["pipe", "pipe", "pipe"] });
	let buf = Buffer.alloc(0);
	const pending = new Map<number, (v: unknown) => void>();
	let nextId = 0;
	const req = (method: string, params: unknown, timeoutMs = 20000): Promise<unknown> =>
		new Promise((res, rej) => {
			const id = ++nextId;
			pending.set(id, res as (v: unknown) => void);
			const t = setTimeout(() => {
				pending.delete(id);
				rej(new Error(`LSP ${method}: таймаут ${timeoutMs}мс`));
			}, timeoutMs);
			const orig = pending.get(id);
			pending.set(id, (v) => { clearTimeout(t); orig?.(v); });
			send(proc, { jsonrpc: "2.0", id, method, params });
		});
	const notify = (method: string, params: unknown) => send(proc, { jsonrpc: "2.0", method, params });
	proc.stdout.on("data", (d: Buffer) => {
		buf = Buffer.concat([buf, d]);
		for (;;) {
			const headerEnd = buf.indexOf("\r\n\r\n");
			if (headerEnd < 0) break;
			const header = buf.subarray(0, headerEnd).toString("utf8");
			const m = /Content-Length: (\d+)/i.exec(header);
			if (!m) { buf = buf.subarray(headerEnd + 4); continue; }
			const len = parseInt(m[1], 10);
			if (buf.length < headerEnd + 4 + len) break;
			const body = buf.subarray(headerEnd + 4, headerEnd + 4 + len).toString("utf8");
			buf = buf.subarray(headerEnd + 4 + len);
			try {
				const msg = JSON.parse(body);
				if (typeof msg.id === "number" && pending.has(msg.id)) {
					const r = pending.get(msg.id)!;
					pending.delete(msg.id);
					r(msg.result ?? msg);
				}
			} catch { /* partial/corrupt — skip */ }
		}
	});
	let failed = false;
	proc.on("error", () => { failed = true; });
	void failed;

	const rootUri = "file://" + root;
	try {
		await req("initialize", {
			processId: process.pid,
			rootUri,
			capabilities: {},
		});
		notify("initialized", {});
	} catch (e) {
		proc.kill();
		throw new Error(`initialize: ${e instanceof Error ? e.message : String(e)}`);
	}

	// Группируем кандидаты по файлу: didOpen один раз на файл.
	const byFile = new Map<string, LspCandidate[]>();
	for (const c of list) byFile.set(c.file, [...(byFile.get(c.file) ?? []), c]);

	let added = 0;
	const g = readGraph(root);
	const existing = new Set(g.edges.map((e) => `${e.source}->${e.target}:calls`));
	const newEdges: Array<{ source: string; target: string; relation: "calls"; confidence: "lsp" }> = [];
	const nodeByFile = new Map<string, Array<{ id: string; path: string; span: { start: number; end: number } }>>();
	for (const n of g.nodes) {
		if (n.kind === "file") continue;
		const arr = nodeByFile.get(n.path) ?? [];
		arr.push(n);
		nodeByFile.set(n.path, arr);
	}
	const rel = (p: string) => (isAbsolute(p) ? relative(root, p) : p);

	for (const [file, items] of byFile) {
		const abs = join(root, file);
		let content: string;
		try {
			content = readFileSync(abs, "utf8");
		} catch {
			continue;
		}
		notify("textDocument/didOpen", { textDocument: { uri: "file://" + abs, languageId: lang, version: 1, text: content } });
		await new Promise((r) => setTimeout(r, 300)); // даём серверу проиндексировать
		for (const c of items) {
			try {
				const res = await req("textDocument/definition", {
					textDocument: { uri: "file://" + abs },
					position: { line: c.line, character: c.col },
				}, 15000);
				const locs: Array<{ uri?: string; range?: { start?: { line?: number } } }> = Array.isArray(res)
					? res
					: res && typeof res === "object" && "uri" in (res as object)
						? [res as { uri?: string; range?: { start?: { line?: number } } }]
						: [];
				for (const loc of locs) {
					if (!loc.uri || !loc.uri.startsWith("file://")) continue;
					const tFile = rel(decodeURIComponent(loc.uri.slice("file://".length)));
					const line = loc.range?.start?.line ?? -1;
					const target = findNodeAtLine(nodeByFile.get(tFile) ?? [], line) ?? tFile;
					const key = `${c.caller}->${target}:calls`;
					if (existing.has(key) || c.caller === target) continue;
					existing.add(key);
					newEdges.push({ source: c.caller, target, relation: "calls", confidence: "lsp" });
					added++;
				}
			} catch { /* нет определения — пропускаем */ }
		}
	}
	notify("exit", {});
	proc.kill();
	if (newEdges.length > 0) {
		g.edges.push(...newEdges);
		writeGraph(root, g);
	}
	return added;
}

function findNodeAtLine(nodes: Array<{ id: string; span: { start: number; end: number } }>, line: number): string | null {
	if (line < 0) return null;
	const exact = nodes.filter((n) => n.span.start === line);
	if (exact.length > 0) return exact[0].id;
	const inside = nodes.find((n) => n.span.start <= line && line <= n.span.end);
	return inside ? inside.id : null;
}

function send(proc: { stdin: NodeJS.WritableStream }, msg: unknown): void {
	const json = JSON.stringify(msg);
	const header = `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n`;
 proc.stdin.write(header + json);
}
