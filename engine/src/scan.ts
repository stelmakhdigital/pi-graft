/** Обход репо: git ls-files (+ untracked), фильтрация, языки. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Lang, RepoFile } from "./types.js";

const LANG_BY_EXT: Record<string, Lang> = {
	".ts": "ts",
	".tsx": "tsx",
	".mts": "ts",
	".cts": "ts",
	".js": "js",
	".jsx": "js",
	".mjs": "js",
	".cjs": "js",
	".py": "py",
	".go": "go",
	".rs": "rust",
	".c": "c",
	".h": "c",
	".cpp": "cpp",
	".cc": "cpp",
	".cxx": "cpp",
	".hpp": "cpp",
	".hh": "cpp",
	".sh": "sh",
	".bash": "sh",
	".java": "java",
	".cs": "csharp",
	".kt": "kotlin",
	".kts": "kotlin",
	".rb": "ruby",
	".php": "php",
	".swift": "swift",
	".dart": "dart",
	".scala": "scala",
	".lua": "lua",
	".r": "r",
	".R": "r",
	".ex": "elixir",
	".exs": "elixir",
	".sol": "solidity",
	".ml": "ocaml",
	".mli": "ocaml",
	".zig": "zig",
	".clj": "clojure",
	".cljs": "clojure",
	".cljc": "clojure",
	".nix": "nix",
};

const SKIP_RE = /(^|\/)(node_modules|\.git|dist|build|out|\.memory|__pycache__|artifacts)(\/|$)/;

function sha1(s: string): string {
	return createHash("sha1").update(s).digest("hex");
}

function gitLines(root: string, args: string[]): Promise<string[]> {
	return new Promise<string[]>((res) => {
		execFile("git", ["-C", root, "ls-files", ...args], { maxBuffer: 16 * 1024 * 1024 }, (err: Error | null, stdout: string) => {
			res(err ? [] : stdout.split("\n").map((l) => l.trim()).filter(Boolean));
		});
	});
}

export function langOf(path: string): Lang | null {
	const dot = path.lastIndexOf(".");
	if (dot < 0) return null;
	return LANG_BY_EXT[path.slice(dot).toLowerCase()] ?? null;
}

/** Путь индексации (единый фильтр scanRepo и refresh-fingerprint). */
export function isIndexablePath(path: string): boolean {
	if (!langOf(path)) return false;
	if (SKIP_RE.test(path)) return false;
	if (path === "graft" || path.startsWith("graft/")) return false; // кэш графа (только в корне)
	if (path.endsWith(".min.js") || path.includes("node_modules/")) return false;
	return true;
}

/** Путь конфигурации build (gitignored вместе с graft/.engine/). */
const buildConfigPath = (root: string) => join(root, "graft", ".engine", "config.json");

export interface BuildConfig {
	followSubmodules: boolean;
	/** GRFT_NO_REFRESH=1 — не автопересобирать граф */
	noRefresh?: boolean;
	/** GRFT_AUTO_DEEP=0 — выключить auto-deep при структурном build */
	autoDeep?: boolean;
	/** GRFT_REFRESH=hash — fingerprint по sha1 (def: size+mtime) */
	refresh?: "size" | "hash";
	/** GRFT_REFRESH_TIMEOUT_MS — бюджет синхронного rebuild'а (def 10000) */
	refreshTimeoutMs?: number;
	/** GRFT_MAX_OUTPUT — лимит вывода graft-тулов в символах (def 16000) */
	maxOutput?: number;
}

export function readBuildConfig(root: string): BuildConfig {
	try {
		const c = JSON.parse(readFileSync(buildConfigPath(root), "utf8")) as Partial<BuildConfig>;
		return { followSubmodules: c.followSubmodules === true, ...c };
	} catch {
		return { followSubmodules: false };
	}
}

export function writeBuildConfig(root: string, cfg: Partial<BuildConfig>): void {
	try {
		const p = buildConfigPath(root);
		const dir = p.slice(0, p.lastIndexOf("/"));
		ensureDir(dir);
		// merge с существующим: флаг --follow-submodules не затирает остальные настройки
		const merged: Record<string, unknown> = { ...readRaw(p), ...cfg };
		writeFileSync(p, JSON.stringify(merged));
	} catch {
		// тихо: конфиг опционален
	}
}

function readRaw(p: string): Record<string, unknown> {
	try {
		const j = JSON.parse(readFileSync(p, "utf8")) as unknown;
		if (j && typeof j === "object" && !Array.isArray(j)) return j as Record<string, unknown>;
	} catch { /* нет файла */ }
	return {};
}

export interface RuntimeConfig {
	noRefresh: boolean;
	autoDeepDisabled: boolean;
	useHash: boolean;
	refreshTimeoutMs: number;
	maxOutput: number | undefined;
}

/**
 * Эффективное runtime: env (GRFT_*) → <root>/graft/.engine/config.json → дефолты.
 * (machine-level GRFT_STATE_DIR/GRFT_MCP_ROOT/GRFT_LLM_CONFIG остаются env-only — они не per-repo.)
 */
export function effectiveRuntime(root?: string): RuntimeConfig {
	const c = root ? readBuildConfig(root) : ({} as BuildConfig);
	const numEnv = (v: string | undefined) => {
		const n = Number(v);
		return Number.isFinite(n) && n > 0 ? n : undefined;
	};
	return {
		noRefresh: process.env.GRFT_NO_REFRESH === "1" || c.noRefresh === true,
		autoDeepDisabled: process.env.GRFT_AUTO_DEEP === "0" || c.autoDeep === false,
		useHash: process.env.GRFT_REFRESH === "hash" || c.refresh === "hash",
		refreshTimeoutMs: numEnv(process.env.GRFT_REFRESH_TIMEOUT_MS) ?? c.refreshTimeoutMs ?? 10_000,
		maxOutput: numEnv(process.env.GRFT_MAX_OUTPUT) ?? c.maxOutput,
	};
}

function ensureDir(dir: string): void {
	try {
		mkdirSync(dir, { recursive: true });
	} catch {
		/* уже есть */
	}
}

/** Инициализированные сабмодули (gitlink'и): пути из `git ls-files -s` (mode 160000). */
export async function submodulePaths(root: string): Promise<string[]> {
	return new Promise<string[]>((res) => {
		execFile("git", ["-C", root, "ls-files", "-s"], { maxBuffer: 16 * 1024 * 1024 }, (err: Error | null, stdout: string) => {
			if (err) return res([]);
			const out: string[] = [];
			for (const line of stdout.split("\n")) {
				const m = line.match(/^160000 [0-9a-f]{40} \d+\t(.+)$/);
				if (m) out.push(m[1].trim());
			}
			res(out);
		});
	});
}

/**
 * Список путей исходников (tracked + untracked, не ignored).
 * follow=true: инициализированные сабмодули сворачиваются с префиксом пути
 * (deps/parser/src/index.ts), уважая .gitignore САМОГО сабмодуля
 * (git ls-files внутри него — его индекс и его ignore-правила).
 * Незаинициализированный сабмодуль (пустой каталог) — git не даст файлов, [] .
 */
export async function listRepoPaths(root: string, follow = false): Promise<string[]> {
	const tracked = await gitLines(root, []);
	const untracked = await gitLines(root, ["--others", "--exclude-standard"]);
	const base = [...new Set([...tracked, ...untracked])];
	if (!follow) return base;
	const subs = await submodulePaths(root);
	const out = new Set(base);
	for (const sub of subs) {
		const subRoot = join(root, sub);
		const subTracked = await gitLines(subRoot, []);
		const subUntracked = await gitLines(subRoot, ["--others", "--exclude-standard"]);
		for (const p of new Set([...subTracked, ...subUntracked])) out.add(sub + "/" + p);
	}
	return [...out];
}

/**
 * Файлы для индексации. `git ls-files` (tracked) + `--others --exclude-standard` (untracked,
 * не ignored). git недоступен — пустой список (build отвалится с понятной ошибкой).
 */
export async function scanRepo(root: string, followSubmodules = false): Promise<RepoFile[]> {
	const paths = await listRepoPaths(root, followSubmodules);
	const seen = new Set<string>();
	const tracked: string[] = paths;
	void tracked;
	const out: RepoFile[] = [];
	for (const path of paths) {
		if (seen.has(path)) continue;
		seen.add(path);
		const lang = langOf(path);
		if (!lang) continue;
		if (!isIndexablePath(path)) continue;
		let content: string;
		try {
			content = readFileSync(join(root, path), "utf8");
		} catch {
			continue; // файл исчез/нечитаемый
		}
		if (content.length > 400_000) continue; // аномально большой — не индексим
		out.push({ path, lang, content, hash: sha1(content) });
	}
	return out;
}

/**
 * Monorepo-scope: сабпроекты по маркерам (package.json/pyproject.toml/Cargo.toml/go.mod/
 * pom.xml/build.gradle в каталоге ≠ корню). Возврат: scope → пути (файлы вне сабпроектов
 * — scope "(root)"). Пустой объект — скоупов нет (только корневой маркер).
 */
const SCOPE_MARKERS = new Set(["package.json", "pyproject.toml", "Cargo.toml", "go.mod", "pom.xml", "build.gradle"]);

export function detectScopes(paths: string[]): Record<string, string[]> {
	const markerDirs = new Set<string>();
	for (const p of paths) {
		const base = p.split("/").pop();
		if (!base || !SCOPE_MARKERS.has(base)) continue;
		markerDirs.add(p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
	}
	if ([...markerDirs].every((d) => d === "")) return {}; // только корневой маркер — скоупов нет
	const out: Record<string, string[]> = {};
	for (const p of paths) {
		const parts = p.split("/");
		let scope = "(root)";
		for (let i = parts.length - 1; i > 0; i--) {
			const dir = parts.slice(0, i).join("/");
			if (markerDirs.has(dir)) {
				scope = dir;
				break;
			}
		}
		(out[scope] ??= []).push(p);
	}
	return out;
}
