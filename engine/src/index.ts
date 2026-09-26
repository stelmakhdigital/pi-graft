/**
 * pi-graft-engine — собственный движок кодового графа (замена @nanonets/graft).
 *
 * Публичный API:
 *   findGraphRoot(cwd) — ближайший корень с graft/.engine/graph.json
 *   build(root, opts)  — сборка графа (опционально deep: {deep: DeepConfig})
 *   makeQueries(root)  — skeleton/callers/map/ask/grep/check/blast/blastFile
 *
 * Движок — чистый TS без pi-API; расширение extensions/graft — тонкий адаптер.
 */
import { buildGraph } from "./build.js";
import { deepBuild } from "./deep.js";
import { resolveDeepConfig } from "./llmConfig.js";
import { proseBuild } from "./prose.js";
import { readBuildConfig, writeBuildConfig, effectiveRuntime } from "./scan.js";
import { conceptsBuild } from "./concepts.js";
import { serveViz, writeViz } from "./viz.js";
import { writeFingerprint } from "./refresh.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { readGraph } from "./store.js";

export { conceptsBuild, proseBuild, serveViz, writeViz };
export { readGraph, readDeep, writeCards, writeDeep } from "./store.js";
export { scopeOfPath } from "./query.js";
import { hasDeep, hasGraph, readDeep, writeCards, writeGraph, writeIndex, writeUnresolved } from "./store.js";
import { makeQueries } from "./query.js";
import type { DeepConfig, Graph } from "./types.js";

export { findGraphRoot, hasGraph, readUnresolved, writeUnresolved } from "./store.js";
export { lspStatus, lspSync, LSP_SERVERS } from "./lsp.js";
export { makeQueries } from "./query.js";
export type { Queries } from "./query.js";
export type { DeepConfig, Graph, GraphNode, DeepStore } from "./types.js";
export { resolveDeepConfig, writeLlmConfig, maskKey, globalLlmConfigPath, projectLlmConfigPath } from "./llmConfig.js";
export { readBuildConfig, writeBuildConfig, effectiveRuntime, scanRepo, type BuildConfig, type RuntimeConfig } from "./scan.js";
export { ensureFresh, driftReport, enableAutoRebuild, isRebuilding } from "./refresh.js";
export { initWiring, uninstallWiring, mcpServerPath } from "./wiring.js";
export { llmChat } from "./deep.js";

export interface BuildOptions {
	deep?: DeepConfig;
	onProgress?: (msg: string) => void;
	/** Auto-refresh deep при структурном build (по умолчанию true; false или GRFT_AUTO_DEEP=0 — выкл). */
	autoDeep?: boolean;
	/** Явный выбор по сабмодулям (true/false — и персистится в graft/.engine/config.json); undefined — читать сохранённое. */
	followSubmodules?: boolean;
}

export interface BuildReport {
	files: number;
	nodes: number;
	edges: number;
	cards: number;
	deep?: { filesDone: number; filesCached: number; symbolsDone: number; symbolsCached: number; symbolsFailed: number };
}

/** Пересобрать граф: структурный слой (+ deep при opts.deep). */
export async function build(root: string, opts: BuildOptions = {}): Promise<BuildReport> {
	const follow = opts.followSubmodules ?? readBuildConfig(root).followSubmodules;
	if (opts.followSubmodules !== undefined) writeBuildConfig(root, { followSubmodules: opts.followSubmodules });
	const { graph: g, unresolved } = await buildGraph(root, { followSubmodules: follow });
	writeUnresolved(root, unresolved);
	writeGraph(root, g);
	await writeFingerprint(root, g.meta.files.map((f) => f.path), Object.fromEntries(g.meta.files.map((f) => [f.path, f.hash])));

	let deepReport: BuildReport["deep"];
	if (opts.deep) {
		const rep = await deepBuild(root, g, opts.deep, opts.onProgress);
		deepReport = rep;
		const topics = await conceptsBuild(root, g, opts.deep, opts.onProgress);
		const prose = await proseBuild(root, g, opts.deep, topics, opts.onProgress);
		if (prose.done || prose.cached) opts.onProgress?.(`prose: ${prose.done} новых / ${prose.cached} в кэше`);
		// deep.json уже записан внутри deepBuild/conceptsBuild; пересобираем карточки/index.
	} else if (opts.autoDeep !== false) {
		// Auto-refresh: если deep уже запускали (deep.json не пуст) и конфиг LLM есть
		// (env → project → global) — инкрементальный deep (только изменившиеся файлы/символы;
		// без дрейфа — 0 LLM-вызовов). Отключение: opts.autoDeep = false, env GRFT_AUTO_DEEP=0
		// или project-конфиг (graft config set --auto-deep off).
		const envCfg = effectiveRuntime(root).autoDeepDisabled ? null : resolveDeepConfig(root).config;
		if (envCfg && hasDeep(root)) {
			opts.onProgress?.("auto-deep: инкрементальный deep (конфиг LLM)");
			deepReport = await deepBuild(root, g, envCfg, opts.onProgress);
			const topics = await conceptsBuild(root, g, envCfg, opts.onProgress);
			const prose = await proseBuild(root, g, envCfg, topics, opts.onProgress);
			if (prose.done || prose.cached) opts.onProgress?.(`prose: ${prose.done} новых / ${prose.cached} в кэше`);
		}
	}
	const deep = readDeep(root);
	const cards = writeCards(root, g, deep);
	const queries = makeQueries(root);
	const mapText = queries.map();
	writeIndex(root, g, mapText);
	return { files: g.meta.files.length, nodes: g.nodes.length, edges: g.edges.length, cards, deep: deepReport };
}

/** Быстрый статус для бейджа: {ok, stale, added, counts}. */
export async function checkStatus(root: string): Promise<{ ok: boolean; stale: number; added: number; text: string }> {
	if (!hasGraph(root)) return { ok: false, stale: 0, added: 0, text: "нет графа" };
	const q = makeQueries(root);
	const { text, json } = await q.check();
	const j = json as { ok: boolean; added: string[]; stale: string[] };
	return { ok: j.ok, stale: j.stale.length, added: j.added.length, text };
}

/** Blast radius для write/edit-хука (синхронно, дешёво; пусто — нет зависимых). */
export function blastFileText(root: string, path: string): string {
	if (!hasGraph(root)) return "";
	try {
		return makeQueries(root).blastFile(path);
	} catch {
		return "";
	}
}

/** Blast-радиус как отдельная viz-страница (сабграф зон + зависимостей) в outDir/index.html. */
export function writeBlastViz(
	root: string,
	data: { files: Array<{ path: string; symbols: Array<{ name: string; dependents: string[] }> }> },
	outDir: string,
): string {
	const g = readGraph(root);
	const nodeById = new Map(g.nodes.map((n) => [n.id, n]));
	void nodeById;
	const nameToId = new Map(g.nodes.filter((n) => n.kind !== "file").map((n) => [n.name, n.id]));
	const keep = new Set<string>(data.files.map((f) => f.path));
	for (const f of data.files) for (const sym of f.symbols) for (const dep of sym.dependents) {
		const id = nameToId.get(dep);
		if (id) keep.add(id);
	}
	const fileOf = (id: string) => (id.includes("#") ? id.split("#")[0] : id);
	const paths = new Set([...keep].map(fileOf));
	const nodes = g.nodes.filter((n) => keep.has(n.id) || (n.kind === "file" && paths.has(n.path)));
	const idSet = new Set(nodes.map((n) => n.id));
	const edges = g.edges.filter((e) => idSet.has(e.source) && idSet.has(e.target));
	const sub: Graph = {
		version: 1,
		meta: { ...g.meta, files: g.meta.files.filter((f) => paths.has(f.path)) },
		nodes,
		edges,
	};
	mkdirSync(outDir, { recursive: true });
	const out = join(outDir, "index.html");
	writeViz(root, sub, out);
	return out;
}

/** Доля не-файловых символов с актуальным deep (bodyHash совпал), 0..1. */
export function deepCoverage(root: string): number {
	if (!hasGraph(root)) return 0;
	const g = readGraph(root);
	const deep = readDeep(root);
	const syms = g.nodes.filter((n) => n.kind !== "file");
	if (syms.length === 0) return 0;
	let c = 0;
	for (const s of syms) if (deep.symbols[s.id]?.hash === s.bodyHash) c++;
	return c / syms.length;
}

