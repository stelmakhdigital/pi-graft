/** Запросы к графу: skeleton/callers/map/ask/grep/check/blast. */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeSavings } from "./savings.js";
import { readDeep, readGraph } from "./store.js";
import { langOf, listRepoPaths } from "./scan.js";
import type { Graph, GraphNode } from "./types.js";

/** Лексическая релевантность: доля ключевых слов запроса, найденных в текстах. */
const KEYWORD_RE = /[a-zA-Zа-яё][a-zA-Zа-яё0-9_-]{3,}/g;
function coverageScore(query: string, ...texts: Array<string | null | undefined>): number {
	const kws = [...new Set(query.toLowerCase().match(KEYWORD_RE) ?? [])];
	if (!kws.length) return 0;
	const hay = texts.map((t) => (t ?? "").toLowerCase()).join(" ");
	if (!hay) return 0;
	let hit = 0;
	for (const k of kws) if (hay.includes(k)) hit++;
	return hit / kws.length;
}

/** Предикат пути для --in/scope: именованный скоуп (meta.scopes) или префикс/хвост пути. */
function scopePred(scopes: Record<string, string[]> | undefined, scope: string | undefined | null): (p: string) => boolean {
	if (!scope) return () => true;
	const key = scope.replace(/\/$/, "");
	const named = scopes?.[key];
	if (named) return (p) => named.includes(p);
	return (p) => p === key || p.startsWith(key + "/") || p.endsWith("/" + key);
}

/** Scope по пути: имя скоупа, если путь входит в его набор (иначе null). */
export function scopeOfPath(scopes: Record<string, string[]> | undefined | null, path: string): string | null {
	if (!scopes) return null;
	for (const [name, paths] of Object.entries(scopes)) if (paths.includes(path)) return name;
	return null;
}

function nodeLabel(n: GraphNode): string {
	return `${n.name} · ${n.path}:L${n.span.start}` + (n.span.end > n.span.start ? `-L${n.span.end}` : "");
}

/** Разрешить имя символа к узлу: точное имя (или Class.name). */
function resolveSymbol(g: Graph, name: string): GraphNode | null {
	const exact = g.nodes.filter((n) => n.kind !== "file" && n.name === name);
	if (exact.length === 1) return exact[0];
	if (exact.length > 1) {
		// Предпочитаем не-метод.
		const nonMethod = exact.find((n) => n.kind !== "method");
		return nonMethod ?? exact[0];
	}
	const suffixed = g.nodes.filter((n) => n.kind !== "file" && n.name.endsWith(`.${name}`));
	return suffixed[0] ?? null;
}

export interface Queries {
	skeleton: (file: string) => string;
	callers: (symbol: string, opts?: { direction?: "in" | "out"; depth?: number | "all"; scope?: string }) => string;
	map: (opts?: { maxDirs?: number; deep?: boolean }) => string;
	ask: (query: string, opts?: { source?: boolean; scope?: string; limit?: number }) => string;
	grep: (pattern: string, opts?: { scope?: string; fixed?: boolean; ignoreCase?: boolean }) => string;
	check: () => Promise<{ text: string; json: Record<string, unknown> }>;
	blast: (base?: string) => Promise<string>;
	blastFile: (path: string) => string;
	askJson: (query: string, opts?: { scope?: string; limit?: number }) => { query: string; count: number; coverage: number; coverageStrong: number; results: Array<{ name: string; kind: string; path: string; start: number; end: number; score: number; snippet: string; summary?: string }> };
	blastData: (base?: string, opts?: { owners?: boolean }) => Promise<{ base: string | null; files: Array<{ path: string; owner: string | null; symbols: Array<{ name: string; start: number; dependents: string[] }> }> }>;
}

/** Источники файлов (кэш на время сессии запросов). */
class SourceCache {
	private m = new Map<string, string>();
	constructor(private root: string) {}
	get(path: string): string | null {
		if (this.m.has(path)) return this.m.get(path)!;
		try {
			const s = readFileSync(join(this.root, path), "utf8");
			this.m.set(path, s);
			return s;
		} catch {
			return null;
		}
	}
}

export function makeQueries(root: string): Queries {
	const g = readGraph(root);
	const sav = makeSavings(root);
	const deep = readDeep(root);
	const src = new SourceCache(root);
	const inDegree = new Map<string, number>();
	const outDegree = new Map<string, number>();
	for (const e of g.edges) {
		if (e.relation === "calls") {
			inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
			outDegree.set(e.source, (outDegree.get(e.source) ?? 0) + 1);
		}
	}
	const nodeById = new Map(g.nodes.map((n) => [n.id, n]));
	const scopes = g.meta.scopes ?? {};
	const scopeOf = new Map<string, string>();
	for (const [name, paths] of Object.entries(scopes)) for (const p of paths) scopeOf.set(p, name);
	const scopeLabel = (path: string): string => {
		const sc = scopeOf.get(path);
		if (!sc) return "";
		return ` [${sc === "(root)" ? "root" : sc}]`;
	};

	const skeleton = (file: string): string => {
		const target = g.nodes.find((n) => n.kind === "file" && (n.path === file || n.path.endsWith(file)));
		if (!target) return `graft skeleton: файл «${file}» не в графе`;
		const syms = g.nodes.filter((n) => n.path === target.path && n.kind !== "file");
		if (syms.length === 0) return `graft skeleton: ${target.path}\n— (символы не извлечены)`;
		const lines = syms.map((s) => {
			const d = deep.symbols[s.id];
			const sum = d && d.hash === s.bodyHash ? `  ${d.summary}` : "";
			return `- L${s.span.start}-L${s.span.end}  ${s.kind} ${s.name}  ${s.signature ?? ""}${sum}`;
		});
		const body = `graft skeleton: ${target.path}\n${lines.join("\n")}`;
		const s = sav.line([target.path], body);
		return s ? `${s}\n${body}` : body;
	};

	const walkEdges = (id: string, direction: "in" | "out", depth: number, includeImports = false): Array<{ id: string; via: string[] }> => {
		const out: Array<{ id: string; via: string[] }> = [];
		const visited = new Set<string>([id]);
		let frontier = [id];
		for (let d = 0; d < depth; d++) {
			const next: string[] = [];
			for (const f of frontier) {
				for (const e of g.edges) {
					if (!includeImports && e.relation === "imports") continue;
					const hit = direction === "in" ? e.target === f ? e.source : null : e.source === f ? e.target : null;
					if (hit && !visited.has(hit)) {
						visited.add(hit);
						out.push({ id: hit, via: [id, ...frontier.slice(0, 0), f] });
						next.push(hit);
					}
				}
			}
			frontier = next;
			if (!frontier.length) break;
		}
		return out;
	};

	const callers: Queries["callers"] = (symbol, opts = {}) => {
		const direction = opts.direction ?? "in";
		const depthN = Number.isFinite(opts.depth) && (opts.depth as number) > 0 ? (opts.depth as number) : 1;
		const depth = opts.depth === "all" ? Infinity : Math.max(1, Math.min(depthN, 10));
		const depthLabel = depth === Infinity ? "all" : String(depth);
		const node = resolveSymbol(g, symbol);
		if (!node) return `graft callers: символ «${symbol}» не найден в графе`;
		const all = walkEdges(node.id, direction, depth);
		const keep = scopePred(g.meta.scopes, opts.scope);
		const hits = all.filter((h) => keep(nodeById.get(h.id)!.path));
		const scopeTag = opts.scope ? ` · scope ${opts.scope}` : "";
		const head =
			direction === "in"
				? `graft callers (in, depth ${depthLabel}${scopeTag}): ${nodeLabel(node)} — кто зависит`
				: `graft callees (out, depth ${depthLabel}${scopeTag}): ${nodeLabel(node)} — на что ссылается`;
		if (all.length === 0) return head + "\n— (не найдено)";
		if (hits.length === 0) return head + `\n— (в scope «${opts.scope}» зависимых нет; всего вне фильтра: ${all.length})`;
		const lines = hits.map((h) => {
			const n = nodeById.get(h.id)!;
			const deg = direction === "in" ? inDegree.get(n.id) ?? 0 : outDegree.get(n.id) ?? 0;
			return `← ${n.name} (${n.path}:L${n.span.start}) [in:${deg}]`.replace(/^←/, direction === "in" ? "←" : "→");
		});
		const body = [head, ...lines].join("\n");
		const covered = [...new Set(hits.map((h) => nodeById.get(h.id)!.path))];
		const s = sav.line(covered, body);
		return s ? `${s}\n${body}` : body;
	};

	const map: Queries["map"] = (opts = {}) => {
		const maxDirs = opts.maxDirs ?? 40;
		const wantDeep = opts.deep === true;
		const files = g.meta.files;
		const byDir = new Map<string, number>();
		for (const f of files) {
			const parts = f.path.split("/");
			const dir = parts.length > 1 ? parts.slice(0, -1).join("/") : "(root)";
			byDir.set(dir, (byDir.get(dir) ?? 0) + 1);
		}
		const dirs = [...byDir.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxDirs);
		const syms = g.nodes.filter((n) => n.kind !== "file");
		const hubs = [...syms]
			.map((n) => ({ n, deg: inDegree.get(n.id) ?? 0 }))
			.filter((x) => x.deg > 0)
			.sort((a, b) => b.deg - a.deg)
			.slice(0, 8);
		const langs = [...new Set(files.map((f) => f.path.split(".").pop()))].sort().join(", ");
		const scopeBlocks: string[] = [];
		if (Object.keys(scopes).length) {
				for (const [name, paths] of Object.entries(scopes).sort((x, y) => y[1].length - x[1].length)) {
						const set = new Set(paths);
						const symsIn = syms.filter((n) => set.has(n.path));
						const hubsIn = symsIn
								.map((n) => ({ n, deg: inDegree.get(n.id) ?? 0 }))
								.filter((x) => x.deg > 0)
								.sort((a, b) => b.deg - a.deg)
								.slice(0, 3);
						scopeBlocks.push(
								`  ${name === "(root)" ? "root" : name} — ${paths.length} files, ${symsIn.length} symbols` + (hubsIn.length ? ` · hubs: ${hubsIn.map((h) => `${h.n.name} (${h.deg}←)`).join(", ")}` : ""),
						);
				}
		}
		const out = [
			`repo map — ${files.length} files · ${syms.length} symbols · ${g.edges.length} edges · ${langs}`,
			``,
			...(scopeBlocks.length ? ["scopes:", ...scopeBlocks, ""] : []),
		...dirs.map(([d, c]) => `  ${d} — ${c} file${c > 1 ? "s" : ""}`),
			``,
			`hubs (in-degree): ${hubs.map((h) => `${h.n.name} (${h.n.path.split("/").pop()}, ${h.deg}←)`).join("  ") || "—"}`,
		];
		if (wantDeep) {
			const topics = deep.concepts?.topics;
			if (topics?.length) {
				out.push("", "topics:");
				for (const t of topics) out.push(`  ${t.name}: ${t.summary} [${t.files.slice(0, 8).join(", ")}${t.files.length > 8 ? ", …" : ""}]`);
				const links = deep.concepts?.links;
				if (links?.length) {
					out.push("  связи:");
					for (const l of links.slice(0, 10)) out.push(`  ${l.from} → ${l.to} (uses, ${l.count})`);
				}
			}
			const withSummary = files
				.map((f) => ({ p: f.path, s: deep.files[f.path]?.summary }))
				.filter((x): x is { p: string; s: string } => Boolean(x.s))
				.slice(0, 30);
			if (withSummary.length) {
				out.push("", "file summaries (deep):");
				for (const x of withSummary) out.push(`  ${x.p} — ${x.s.slice(0, 140)}`);
			}
		}
		return out.join("\n");
	};

		const askScore = (query: string): Array<{ n: GraphNode; score: number }> => {
		const terms = query.toLowerCase().split(/[\s,;:()'"`/\\.#]+/).filter((t) => t.length > 1);
		const scored: Array<{ n: GraphNode; score: number }> = [];
		for (const n of g.nodes) {
			if (n.kind === "file") continue;
			let score = 0;
			const name = n.name.toLowerCase();
			const path = n.path.toLowerCase();
			for (const t of terms) {
				if (name === t) score += 10;
				else if (name.includes(t)) score += 4;
				else if (path.includes(t)) score += 2;
				else {
					// camelCase-слово: findGraphRoot ~ find
					const words = n.name.toLowerCase().split(/(?=[A-Zа-яЁё])|(?<=[а-яёА-ЯЁ])/g);
					if (words.includes(t)) score += 3;
				}
			}
			if (score > 0) score += Math.min(inDegree.get(n.id) ?? 0, 5) * 0.5;
			if (score > 0) scored.push({ n, score });
		}
				scored.sort((a, b) => b.score - a.score);
		return scored;
	};
	/** Проза-ноды, чья тема/файлы совпали с ключевыми словами запроса (топ-3). */
	const proseBlock = (query: string): string => {
		const prose = deep.prose ?? {};
		const entries = Object.values(prose).filter((n) => n.file);
		if (!entries.length) return "";
		const kws = query.toLowerCase().match(KEYWORD_RE) ?? [];
		const matched = entries
			.map((n) => {
				const hay = `${n.topic} ${n.summary ?? ""} ${n.files.join(" ")}`.toLowerCase();
				return { n, hits: kws.filter((k) => hay.includes(k)).length };
			})
			.filter((x) => x.hits > 0)
			.sort((a, b) => b.hits - a.hits)
			.slice(0, 3);
		if (!matched.length) return "";
		return "prose (нарратив «как устроено» — читать файл):\n" + matched.map((x) => `  - ${x.n.file} — ${x.n.topic}`).join("\n") + "\n";
	};

	const ask: Queries["ask"] = (query, opts = {}) => {
		const scored = askScore(query);
		const limit = Math.max(1, Math.min(opts.limit ?? 12, 50));
		const keep = scopePred(scopes, opts.scope);
		const pool = opts.scope ? scored.filter((x) => keep(x.n.path)) : scored;
		let top: Array<{ n: GraphNode; score: number }> = pool.slice(0, limit);
		if (!opts.scope && Object.keys(scopes).length) {
			// Scope-fusion: глобальный топ-6 + топ-3 каждого скоупа (сабпроект не тонет в крупном).
			const picked = scored.slice(0, 6);
			const ids = new Set(picked.map((x) => x.n.id));
			for (const paths of Object.values(scopes)) {
				const set = new Set(paths);
				for (const x of scored) {
					if (picked.length >= 12 || ids.has(x.n.id) || !set.has(x.n.path)) continue;
					ids.add(x.n.id);
					picked.push(x);
				}
			}
			top = picked;
		}
		if (!top.length) return `graft ask: «${query}» — нет совпадений в графе`;
		const lines = top.flatMap(({ n, score }) => {
			const content = src.get(n.path);
			let snippet = "";
			if (content) {
				const ls = content.split("\n");
				snippet = (ls[n.span.start - 1] ?? "").trim().slice(0, 100);
			}
			const out = [`  ${score.toFixed(1)}  ${n.name}  ${n.path}${scopeLabel(n.path)}:L${n.span.start}-L${n.span.end}  ${snippet}`];
			// --source: inline-код хита (≤8 строк span'а) — результат и есть код, без доп. round-trip.
			if (opts.source && content) {
				const ls = content.split("\n");
				const shown = ls.slice(n.span.start - 1, Math.min(n.span.end, n.span.start + 7));
				out.push(`    code L${n.span.start}-${n.span.end}:`);
				for (const l of shown) out.push(`      ${l}`);
				if (n.span.end > n.span.start + 7) out.push(`      … (полный span: read L${n.span.start}-L${n.span.end})`);
			}
			const d = deep.symbols[n.id];
			if (d && d.hash === n.bodyHash) {
				out.push(`    ↳ ${d.summary}`);
				for (const c of (d.crux ?? []).slice(0, 2)) out.push(`    crux: ${c.slice(0, 100)}`);
			}
			return out;
		});
		const body = `graft ask: «${query}»\n${proseBlock(query)}${lines.join("\n")}`;
		const covered = [...new Set(top.map(({ n }) => n.path))];
		const s = sav.line(covered, body);
		return s ? `${s}\n${body}` : body;
	};
	const askJson: Queries["askJson"] = (query, opts = {}) => {
		const scored = askScore(query);
		const limit = Math.max(1, Math.min(opts.limit ?? 12, 50));
		const keep = scopePred(scopes, opts.scope);
		const top = (opts.scope ? scored.filter((x) => keep(x.n.path)) : scored).slice(0, limit);
		const topN = top[0]?.n;
		return {
			query,
			count: top.length,
			// Релевантность топ-хита: strong — в имени/сигнатуре, broad — + путь и сниппет.
			coverageStrong: topN ? coverageScore(query, topN.name, topN.signature) : 0,
			coverage: topN ? coverageScore(query, topN.name, topN.path, topN.signature) : 0,
			results: top.map(({ n, score }) => {
				const content = src.get(n.path);
				const snippet = content ? (content.split("\n")[n.span.start - 1] ?? "").trim().slice(0, 100) : "";
				const d = deep.symbols[n.id];
				return {
					name: n.name,
					kind: n.kind,
					path: n.path,
					start: n.span.start,
					end: n.span.end,
					score: Math.round(score * 10) / 10,
					snippet,
					summary: d && d.hash === n.bodyHash ? d.summary : undefined,
				};
			}),
		};
	};

	const grep: Queries["grep"] = (pattern, opts = {}) => {
		let re: RegExp;
		try {
			re = new RegExp(opts.fixed ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern, opts.ignoreCase ? "gi" : "g");
		} catch (e) {
			return `graft grep: некорректный pattern: ${(e as Error).message}`;
		}
		const scopeKey = ((): string | null => {
			const sc = (opts.scope ?? "").replace(/\/$/, "");
			return Object.keys(scopes).find((k) => k === sc) ?? null;
		})();
		const scopeFiles = scopeKey ? new Set(scopes[scopeKey]) : null;
		const scopePrefix = scopeKey ? "" : (opts.scope ?? "");
		const hitsByFile = new Map<string, Array<{ line: number; text: string; sym?: GraphNode }>>();
		for (const f of g.meta.files) {
			if (scopeFiles && !scopeFiles.has(f.path)) continue;
			if (scopePrefix && !f.path.startsWith(scopePrefix.replace(/\/$/, ""))) continue;
			const content = src.get(f.path);
			if (!content) continue;
			const fileSyms = g.nodes.filter((n) => n.path === f.path && n.kind !== "file").sort((a, b) => a.span.start - b.span.start);
			const out: Array<{ line: number; text: string; sym?: GraphNode }> = [];
			for (const [i, line] of content.split("\n").entries()) {
				re.lastIndex = 0;
				if (re.test(line)) {
					const lineNo = i + 1;
					// Innermost: минимальный span, содержащий строку.
					const enclosing = fileSyms.filter((s) => lineNo >= s.span.start && lineNo <= s.span.end);
					const sym = enclosing.sort((a, b) => a.span.end - a.span.start - (b.span.end - b.span.start))[0];
					out.push({ line: lineNo, text: line.trim().slice(0, 120), sym });
				}
			}
			if (out.length) hitsByFile.set(f.path, out);
		}
		// Ранжирование: по в-степени файла.
		const fileIn = (p: string) => g.edges.filter((e) => e.target === p).length;
		const files = [...hitsByFile.keys()].sort((a, b) => fileIn(b) - fileIn(a));
		if (!files.length) return `graft grep: «${pattern}» — нет хитов`;
		const lines: string[] = [`graft grep: «${pattern}» — ${files.reduce((s, f) => s + (hitsByFile.get(f)?.length ?? 0), 0)} хитов в ${files.length} файлах`];
		for (const f of files) {
			lines.push(`  ${f}:`);
			for (const h of hitsByFile.get(f)!.slice(0, 20)) {
				lines.push(`    L${h.line}  ${h.text}${h.sym ? `  [in ${h.sym.name}]` : ""}`);
			}
		}
		const body = lines.join("\n");
		const s = sav.line(files, body);
		return s ? `${s}\n${body}` : body;
	};

	const check = async () => {
		const { createHash } = await import("node:crypto");
		const h = (s: string) => createHash("sha1").update(s).digest("hex");
		const list = await listRepoPaths(root);
		const current = new Map<string, string>();
		for (const p of list) {
			if (!langOf(p)) continue;
			if (/(^|\/)(node_modules|\.git|dist|build|out|\.memory)(\/|$)/.test(p) || p === "graft" || p.startsWith("graft/")) continue;
			try {
				current.set(p, h(readFileSync(join(root, p), "utf8")));
			} catch {
				/* пропуск */
			}
		}
		const indexed = new Map(g.meta.files.map((f) => [f.path, f.hash]));
		const added: string[] = [];
		const removed: string[] = [];
		const changed: string[] = [];
		for (const [p, hh] of current) {
			if (!indexed.has(p)) added.push(p);
			else if (indexed.get(p) !== hh) changed.push(p);
		}
		for (const p of indexed.keys()) if (!current.has(p)) removed.push(p);
		const stale = [...changed, ...removed];
		const json = {
			ok: stale.length === 0 && added.length === 0,
			added,
			removed,
			changed,
			stale,
			indexed: g.meta.files.length,
		};
		const text = json.ok
			? `graft check: ок — граф синхронен (${g.meta.files.length} файлов, ${g.edges.length} рёбер)`
			: `graft check: ДРЕЙФ — added ${added.length}, changed ${changed.length}, removed ${removed.length} (пересборка: /graft build)\n${[...added, ...changed, ...removed].slice(0, 15).map((p) => `  ${p}`).join("\n")}`;
		return { text, json };
	};

	const blastFile: Queries["blastFile"] = (path) => {
		const target = g.nodes.find((n) => n.kind === "file" && (n.path === path || n.path.endsWith(path)));
		if (!target) return "";
		const syms = g.nodes.filter((n) => n.path === target.path && n.kind !== "file");
		const lines: string[] = [];
		for (const s of syms.slice(0, 5)) {
			const hits = walkEdges(s.id, "in", 1).filter((h) => h.id !== s.id);
			if (hits.length) lines.push(`${s.name}: ${hits.slice(0, 5).map((h) => { const n = nodeById.get(h.id)!; return `${n.name} (${n.path})`; }).join(", ")}`);
		}
		return lines.join("\n");
	};

	const gitRun = (args: string[]): Promise<string> =>
		new Promise<string>((res) => execFile("git", args, { maxBuffer: 32 * 1024 * 1024 }, (err: Error | null, o: string) => res(err ? "" : o)));

	const blastCore = async (base: string | undefined, owners: boolean): Promise<Awaited<ReturnType<Queries["blastData"]>>> => {
		const out = await gitRun(["-C", root, "diff", "--unified=0", ...(base ? [base] : [])]);
		const byFile = new Map<string, Set<number>>();
		let cur: string | null = null;
		let newStart = 0;
		for (const line of out.split("\n")) {
			const f = line.match(/^diff --git a\/(.+) b\//);
			if (f) {
				cur = f[1];
				byFile.set(cur, new Set());
				continue;
			}
			const h = line.match(/^@@ -\d+(?:-\d+)? \+(\d+)/);
			if (h) newStart = Number(h[1]);
			if (cur && (line.startsWith("+") || line.startsWith("-")) && line[1] !== "=" && byFile.has(cur)) byFile.get(cur)!.add(newStart);
		}
		const files: Awaited<ReturnType<Queries["blastData"]>>["files"] = [];
		for (const [path, lineNos] of byFile) {
			const syms = g.nodes.filter((n) => n.path === path && n.kind !== "file");
			const touched = syms.filter((x) => [...lineNos].some((ln) => ln >= x.span.start && ln <= x.span.end));
			const list = (touched.length ? touched : g.nodes.filter((n) => n.id === path && n.kind === "file")).slice(0, 8);
			const symbols = list.map((x) => ({
				name: x.name,
				start: x.span.start,
				dependents: walkEdges(x.id, "in", 2, x.kind === "file")
					.filter((h) => h.id !== x.id)
					.slice(0, 12)
					.map((h) => nodeById.get(h.id)!.name),
			}));
			let owner: string | null = null;
			if (owners) {
				owner = (await gitRun(["-C", root, "log", "-1", "--format=%an", "--", path])).trim() || null;
			}
			files.push({ path, owner, symbols });
		}
		return { base: base ?? null, files };
	};

	const blastData: Queries["blastData"] = async (base, opts = {}) => blastCore(base, opts.owners !== false);

	const blast: Queries["blast"] = async (base) => {
		const args = ["-C", root, "diff", "--unified=0"];
		if (base) args.push(base);
		const out = await new Promise<string>((res) => {
			execFile("git", args, { maxBuffer: 32 * 1024 * 1024 }, (err: Error | null, o: string) => res(err ? "" : o));
		});
		if (!out) return "graft blast: diff пуст (нет изменений)";
		const byFile = new Map<string, Set<number>>();
		let cur: string | null = null;
		let newStart = 0;
		for (const line of out.split("\n")) {
			const f = line.match(/^diff --git a\/(.+) b\//);
			if (f) {
				cur = f[1];
				byFile.set(cur, new Set());
				continue;
			}
			const h = line.match(/^@@ -\d+(?:-\d+)? \+(\d+)/);
			if (h) newStart = Number(h[1]);
			if (cur && (line.startsWith("+") || line.startsWith("-")) && line[1] !== "=" && byFile.has(cur)) byFile.get(cur)!.add(newStart);
		}
		const lines: string[] = ["graft blast:"];
		let any = false;
		for (const [path, lineNos] of byFile) {
			const syms = g.nodes.filter((n) => n.path === path && n.kind !== "file");
			const touched = syms.filter((s) => [...lineNos].some((ln) => ln >= s.span.start && ln <= s.span.end));
			const list = touched.length ? touched : g.nodes.filter((n) => n.id === path && n.kind === "file");
			for (const s of list.slice(0, 8)) {
				const hits = walkEdges(s.id, "in", 2, s.kind === "file").filter((h) => h.id !== s.id);
				if (!hits.length) continue;
				any = true;
				lines.push(`  ${s.name} (${path}:L${s.span.start}) ← ${hits.slice(0, 6).map((h) => { const n = nodeById.get(h.id)!; return n.name; }).join(", ")}`);
			}
		}
		if (!any) lines.push("  — (затронутые строки не попали в символы с зависимостями)");
		return lines.join("\n");
	};

	return { skeleton, callers, map, ask, askJson, grep, check, blast, blastData, blastFile };
}
