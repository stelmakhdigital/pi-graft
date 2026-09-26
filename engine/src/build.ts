/** Сборка графа: scan → extract → разрешение импортов → Graph. */
import { extractFile, resolveImport, resolvePyImport, type ExtractedFile } from "./extract.js";
import { detectScopes, listRepoPaths, scanRepo } from "./scan.js";
import type { Graph, GraphEdge, LspCandidate } from "./types.js";

export interface BuildGraphResult {
	graph: Graph;
	/** Нерешённые member-вызовы — кандидаты для lsp-sync (LSP goToDefinition). */
	unresolved: LspCandidate[];
}

export async function buildGraph(root: string, opts: { followSubmodules?: boolean } = {}): Promise<BuildGraphResult> {
	const files = await scanRepo(root, opts.followSubmodules === true);
	if (files.length === 0) {
		throw new Error("graft-engine: нет файлов для индексации (git ls-files пуст или git недоступен)");
	}
	const knownPaths = new Set(files.map((f) => f.path));
	const extracted: ExtractedFile[] = [];
	for (const f of files) extracted.push(await extractFile(f));

	const edges: GraphEdge[] = [];
	const fileById = new Map<string, Graph["nodes"][number]>(extracted.flatMap((e) => e.nodes).map((n) => [n.id, n]));

	// Файловые import-рёбра + символ-импорты (named → target symbol).
	for (const e of extracted) {
		for (const imp of e.imports) {
			const targetFile =
				e.file.lang === "py"
					? resolvePyImport(e.file.path, imp.specifier, knownPaths)
					: resolveImport(e.file.path, imp.specifier, knownPaths);
			if (!targetFile) continue; // внешний пакет
			edges.push({ source: e.file.path, target: targetFile, relation: "imports", confidence: "extracted" });
			// named-импорт → символ целевого файла (если экспортируется).
			const targets = e.exports; // локальные имена == имена символов своего файла
			void targets;
			const targetExports = new Map<string, unknown>();
			const targetExtracted = extracted.find((t) => t.file.path === targetFile);
			if (targetExtracted) for (const [name, node] of targetExtracted.exports) targetExports.set(name, node);
			for (const name of imp.names) {
				if (name === "*" || name === "default") continue;
				const sym = targetExports.get(name);
				if (sym) edges.push({ source: e.file.path, target: (sym as { id: string }).id, relation: "references", confidence: "extracted" });
			}
		}
	}
	for (const e of extracted) edges.push(...e.edges);

	// Member-chain вызовы (obj.m()): глобальное разрешение new/import-цепей в классы.
	const allNodes = extracted.flatMap((e) => e.nodes);
	const globalMethods = new Map<string, Map<string, Graph["nodes"][number][]>>();
	for (const n of allNodes) {
		// Квалифицированные символы (Cls.m) — method (java/c#/...) или function (kotlin/swift).
		if ((n.kind !== "method" && n.kind !== "function") || !n.name.includes(".")) continue;
		const [cls, m] = n.name.split(".");
		const mm = globalMethods.get(cls) ?? new Map();
		mm.set(m, [...(mm.get(m) ?? []), n]);
		globalMethods.set(cls, mm);
	}
	const resolveVia = (via: { kind: string; name: string }, ex: (typeof extracted)[number], seen: Set<string>): string | null => {
		if (seen.has(via.name)) return null;
		seen.add(via.name);
		if (via.kind === "new" || via.kind === "type") return via.name; // type: явная аннотация
		if (via.kind === "call") {
			// возвратный тип функции (явная аннотация): const x = f(); x.m() → Foo.m
			const ret = ex.fnReturns.get(via.name);
			if (ret) {
				if (ex.nodes.some((n) => n.kind === "class" && n.name === ret)) return ret;
				for (const imp of ex.imports) {
					if (!imp.names.includes(ret)) continue;
					const tf =
						ex.file.lang === "py"
							? resolvePyImport(ex.file.path, imp.specifier, knownPaths)
							: resolveImport(ex.file.path, imp.specifier, knownPaths);
					const sym = extracted.find((x) => x.file.path === tf)?.exports.get(ret);
					if (sym?.kind === "class") return ret;
				}
			}
			return null;
		}
		const v2 = ex.vars.get(via.name);
		if (v2) return resolveVia(v2, ex, seen);
		// import: локальное имя → класс в целевом файле
		for (const imp of ex.imports) {
			if (!imp.names.includes(via.name)) continue;
			const tf =
				ex.file.lang === "py"
					? resolvePyImport(ex.file.path, imp.specifier, knownPaths)
					: resolveImport(ex.file.path, imp.specifier, knownPaths);
			if (!tf) return null;
			const te = extracted.find((x) => x.file.path === tf);
			const sym = te?.exports.get(via.name);
			if (sym?.kind === "class") return sym.name;
			return null;
		}
		return null;
	};
	const unresolvedLsp: LspCandidate[] = [];
	for (const e of extracted) {
		for (const p of e.pending) {
			const cls = resolveVia(p.via, e, new Set());
			const cands = cls ? (globalMethods.get(cls)?.get(p.method) ?? []) : [];
			const target = cands.find((c) => c.path === e.file.path) ?? cands[0];
			if (target) {
				const source = p.caller ? p.caller.id : e.file.path;
				if (source !== target.id) edges.push({ source, target: target.id, relation: "calls", confidence: "extracted" });
				continue;
			}
			unresolvedLsp.push({
				file: e.file.path,
				method: p.method,
				line: p.line,
				col: p.col,
				caller: p.caller?.id ?? e.file.path,
			});
		}
	}

	const nodes = extracted.flatMap((e) => e.nodes);
	// Уникализация рёбер.
	const dedup = new Set<string>();
	const uniqueEdges = edges.filter((ed) => {
		const k = `${ed.source}->${ed.target}:${ed.relation}`;
		if (dedup.has(k)) return false;
		dedup.add(k);
		return true;
	});

	void fileById;
	const rawPaths = await listRepoPaths(root, opts.followSubmodules === true);
	const scopes = detectScopes(rawPaths);
	return {
		graph: {
			version: 1,
			meta: { builtAt: new Date().toISOString(), root, files: files.map((f) => ({ path: f.path, hash: f.hash })), scopes: Object.keys(scopes).length ? scopes : undefined },
			nodes,
			edges: uniqueEdges,
		},
		unresolved: unresolvedLsp,
	};
}
