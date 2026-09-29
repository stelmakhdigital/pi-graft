/** Хранилище: graft/.engine/{graph.json,deep.json}, graft/cards/, graft/index.md. */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { DeepStore, Graph, LspCandidate } from "./types.js";

export const ENGINE_DIR = ".engine";
export const GRAPHS_MARKER = join(ENGINE_DIR, "graph.json");

export function engineDir(root: string): string {
	return join(root, "graft", ENGINE_DIR);
}

export function hasGraph(root: string): boolean {
	return existsSync(join(engineDir(root), "graph.json"));
}

/** Атомарная запись: tmp + rename — обрыв на полуслове не оставляет усечённого артефакта. */
export function atomicWrite(p: string, data: string): void {
	const tmp = p + ".tmp";
	writeFileSync(tmp, data);
	renameSync(tmp, p);
}

export function readGraph(root: string): Graph {
	return JSON.parse(readFileSync(join(engineDir(root), "graph.json"), "utf8")) as Graph;
}

// In-process кэш распарсенных артефактов (root-ключ). Инвалидация — в writeGraph/writeDeep
// (единственные точки записи) и invalidateGraphCache() после rebuild.
const graphCache = new Map<string, Graph>();
const deepCache = new Map<string, DeepStore>();
export function readGraphCached(root: string): Graph {
	let g = graphCache.get(root);
	if (!g) {
		g = readGraph(root);
		graphCache.set(root, g);
	}
	return g;
}
export function invalidateGraphCache(root?: string): void {
	if (root) { graphCache.delete(root); deepCache.delete(root); }
	else { graphCache.clear(); deepCache.clear(); }
}
/** Есть ли уже deep-данные (для auto-refresh: deep.json не пустой). */
export function hasDeep(root: string): boolean {
	try {
		const d = readDeepCached(root);
		return Object.keys(d.files ?? {}).length > 0 || Object.keys(d.symbols ?? {}).length > 0;
	} catch {
		return false;
	}
}

export function readDeep(root: string): DeepStore {
	const p = join(engineDir(root), "deep.json");
	if (!existsSync(p)) return { files: {}, symbols: {} };
	return JSON.parse(readFileSync(p, "utf8")) as DeepStore;
}
export function readDeepCached(root: string): DeepStore {
	let d = deepCache.get(root);
	if (!d) {
		d = readDeep(root);
		deepCache.set(root, d);
	}
	return d;
}

export function writeGraph(root: string, g: Graph): void {
	const dir = engineDir(root);
	mkdirSync(dir, { recursive: true });
	// Чистим старый формат (nanonets: graft/wiring.json, карточки по дереву).
	rmSync(join(root, "graft", "wiring.json"), { force: true });
	atomicWrite(join(dir, "graph.json"), JSON.stringify(g, null, 1));
	invalidateGraphCache(root);
}

const unresolvedPath = (root: string) => join(engineDir(root), "unresolved.json");

/** Кандидаты для lsp-sync (нерешённые member-вызовы из последней сборки). */
export function writeUnresolved(root: string, list: LspCandidate[]): void {
	if (list.length === 0) {
		try { unlinkSync(unresolvedPath(root)); } catch { /* нет файла — ок */ }
		return;
	}
	mkdirSync(dirname(unresolvedPath(root)), { recursive: true });
	writeFileSync(unresolvedPath(root), JSON.stringify({ list }, null, 0));
}

export function readUnresolved(root: string): LspCandidate[] {
	try {
		return (JSON.parse(readFileSync(unresolvedPath(root), "utf8")) as { list: LspCandidate[] }).list;
	} catch {
		return [];
	}
}

export function writeDeep(root: string, d: DeepStore): void {
	mkdirSync(engineDir(root), { recursive: true });
	atomicWrite(join(engineDir(root), "deep.json"), JSON.stringify(d, null, 1));
	deepCache.delete(root);
}

const NOTES_BEGIN = "<!-- graft:notes:begin -->";
const NOTES_END = "<!-- graft:notes:end -->";

/** Notes-блок старой карточки (между маркерами) — сохраняется при регенерации. */
function extractNotes(md: string): string | null {
	const b = md.indexOf(NOTES_BEGIN);
	const e = md.indexOf(NOTES_END);
	if (b < 0 || e < b) return null;
	return md.slice(b, e + NOTES_END.length);
}

/** Per-file markdown-карточки: graft/cards/<путь-зеркало>.md */
export function writeCards(root: string, g: Graph, deep: DeepStore): number {
	const cardsRoot = join(root, "graft", "cards");
	// сохраняем Notes до переписывания
	const notes: Record<string, string> = {};
	if (existsSync(cardsRoot)) {
		const walk = (dir: string) => {
			for (const ent of readdirSync(dir, { withFileTypes: true })) {
				const p = join(dir, ent.name);
				if (ent.isDirectory()) walk(p);
				else if (ent.name.endsWith(".md")) {
					const rel = relative(cardsRoot, p).slice(0, -3);
					const n = extractNotes(readFileSync(p, "utf8"));
					if (n) notes[rel] = n;
				}
			}
		};
		walk(cardsRoot);
	}
	rmSync(cardsRoot, { recursive: true, force: true });
	mkdirSync(cardsRoot, { recursive: true });
	let count = 0;
	for (const fileNode of g.nodes.filter((n) => n.kind === "file")) {
		const syms = g.nodes.filter((n) => n.path === fileNode.path && n.kind !== "file");
		const lines: string[] = [];
		lines.push(`# graft card — ${fileNode.path}`);
		lines.push("");
		const fs = deep.files[fileNode.path];
		if (fs && fs.hash === fileNode.bodyHash) lines.push(`> ${fs.summary}`);
		for (const s of syms) {
			lines.push(`- L${s.span.start}-L${s.span.end} ${s.kind} \`${s.name}\` — ${s.signature ?? ""}`);
			const d = deep.symbols[s.id];
			if (d && d.hash === s.bodyHash) {
				lines.push(`  - ${d.summary}`);
				if (d.crux?.length) lines.push(`  - crux:`, ...d.crux.map((l) => `    \`${l}\``));
			}
		}
		if (notes[fileNode.path]) lines.push("", notes[fileNode.path]);
		lines.push("", `<!-- graft:notes (добавляй заметки между маркерами — они переживут пересборку): -->`, NOTES_BEGIN, NOTES_END);
		const out = join(cardsRoot, fileNode.path + ".md");
		mkdirSync(dirname(out), { recursive: true });
		writeFileSync(out, lines.join("\n") + "\n");
		count++;
	}
	return count;
}

/** graft/index.md — верхнеуровневая карта. */
export function writeIndex(root: string, g: Graph, text: string): void {
	const p = join(root, "graft", "index.md");
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(
		p,
		`# graft — repo map (pi-graft-engine v1)\n\nСобственный движок (engine): пересборка — \`/graft build\` (в pi) или \`node engine/bin/graft.mjs build\`.\n\n${text}\n`,
	);
}

/** Корень графа: ближайший каталог вверх с graft/.engine/graph.json. */
export function findGraphRoot(cwd: string): string | null {
	let dir = cwd;
	for (;;) {
		if (hasGraph(dir)) return dir;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

export { sep, relative };
