/**
 * Auto-refresh: быстрый fingerprint дрейфа (size+mtime по умолчанию; GRFT_REFRESH=hash — sha1)
 * и тихая пересборка графа перед запросами. GRFT_NO_REFRESH=1 — выключить везде.
 *
 * Файл: graft/.engine/fingerprint.json — { mode, paths, files: {path: {size, mtimeMs} | hash} }.
 * Чек = git ls-files (+untracked) vs paths + stat/hash общих путей. ~мс для сотен файлов.
 */
import { stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { engineDir, hasGraph } from "./store.js";
import { isIndexablePath, listRepoPaths, readBuildConfig, effectiveRuntime } from "./scan.js";

const FP_NAME = "fingerprint.json";
const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

interface Fingerprint {
	mode: "stat" | "hash";
	/** Индексированный набор путей (для сравнения added/removed). */
	paths: string[];
	/** stat: {size, mtimeMs}; hash: sha1. */
	files: Record<string, { size: number; mtimeMs: number } | string>;
}

export function fpPath(root: string): string {
	return join(engineDir(root), FP_NAME);
}

/** Записать fingerprint после build (из index.build). */
export async function writeFingerprint(root: string, paths: string[], hashes: Record<string, string>): Promise<void> {
	const files: Fingerprint["files"] = {};
	for (const p of paths) {
		try {
			const st = await stat(join(root, p));
			files[p] = { size: st.size, mtimeMs: st.mtimeMs };
		} catch {
			/* файл исчез — просто нет записи */
		}
	}
	const fp: Fingerprint = { mode: "stat", paths, files };
	void hashes;
	mkdirSync(engineDir(root), { recursive: true });
	writeFileSync(fpPath(root), JSON.stringify(fp, null, 0));
}

function readFp(root: string): Fingerprint | null {
	try {
		if (!existsSync(fpPath(root))) return null;
		return JSON.parse(readFileSync(fpPath(root), "utf8")) as Fingerprint;
	} catch {
		return null;
	}
}

/** Быстрый (async, но дешёвый) отчёт о дрейфе без пересборки. */
export async function driftReport(
	root: string,
): Promise<{ drifted: boolean; reason: string | null; added: number; removed: number; changed: number }> {
	if (!hasGraph(root)) return { drifted: false, reason: "нет графа", added: 0, removed: 0, changed: 0 };
	const fp = readFp(root);
	if (!fp) return { drifted: true, reason: "нет fingerprint (пересборка)", added: 0, removed: 0, changed: 0 };
	const useHash = effectiveRuntime(root).useHash;
	const list = await listRepoPaths(root, readBuildConfig(root).followSubmodules);
	if (list.length === 0) return { drifted: false, reason: "git недоступен — пропуск", added: 0, removed: 0, changed: 0 };
	const current = list.filter(isIndexablePath);
	const curSet = new Set(current);
	const idxSet = new Set(fp.paths);
	const added = current.filter((p) => !idxSet.has(p)).length;
	const removed = fp.paths.filter((p) => !curSet.has(p)).length;
	let changed = 0;
	for (const p of current) {
		if (!idxSet.has(p)) continue;
		const stored = fp.files[p];
		if (!stored) {
			changed++;
			continue;
		}
		if (useHash) {
			try {
				const h = sha1(readFileSync(join(root, p), "utf8"));
				if (h !== (typeof stored === "string" ? stored : JSON.stringify(stored))) changed++;
			} catch {
				changed++;
			}
		} else if (typeof stored === "object") {
			try {
				const st = await stat(join(root, p));
				if (st.size !== stored.size || st.mtimeMs !== stored.mtimeMs) changed++;
			} catch {
				changed++;
			}
		} else {
			changed++;
		}
	}
	const drifted = added > 0 || removed > 0 || changed > 0;
	return {
		drifted,
		reason: drifted ? `drift: +${added} new, -${removed} removed, ~${changed} changed` : null,
		added,
		removed,
		changed,
	};
}

let autoRebuildTimer: NodeJS.Timeout | null = null;
let autoRebuildInflight = false;

/**
 * Дебаунс-обёртка для тихой пересборки после правок (write/edit): коалесит серию правок
 * в один rebuild через debounceMs; параллельные запуски — один в полёте. Ошибки — тихо.
 */
export function enableAutoRebuild(fn: () => Promise<void>, debounceMs = 4000, root?: string): void {
	if (autoRebuildInflight || (root ? effectiveRuntime(root).noRefresh : process.env.GRFT_NO_REFRESH === "1")) return;
	if (autoRebuildTimer) clearTimeout(autoRebuildTimer);
	autoRebuildTimer = setTimeout(async () => {
		autoRebuildTimer = null;
		autoRebuildInflight = true;
		try {
			await fn();
		} catch {
			/* тихо: бейдж поправится следующим refreshBadge */
		}
		autoRebuildInflight = false;
	}, debounceMs);
}

/**
 * Тихая пересборка при дрейфе. In-process TTL (3s) против повторных git-вызовов в одном ходе.
 * GRFT_NO_REFRESH=1 — всегда пропуск. Возврат: {refreshed, files?, skipped?, reason?}.
 */
/** Single-flight rebuild по root: не запускать вторую пересборку поверх идущей. */
const rebuildInflight = new Map<string, Promise<number>>();
export const isRebuilding = (root: string): boolean => rebuildInflight.has(root);

/**
 * Тихая пересборка при дрейфе. In-process TTL (3s) против повторных git-вызовов в одном ходе.
 * GRFT_NO_REFRESH=1 — всегда пропуск.
 * opts.timeoutMs: если пересборка дольше бюджета — ответить по старому графу (stale:true)
 * и докрутить rebuild фоном (prompt/тул не блокируются). Возврат: {refreshed, stale?, files?, skipped?, reason?}.
 */
export async function ensureFresh(
	root: string,
	opts: { timeoutMs?: number } = {},
): Promise<{ refreshed: boolean; stale?: boolean; files?: number; skipped?: string; reason?: string }> {
	if (effectiveRuntime(root).noRefresh) return { refreshed: false, skipped: "no-refresh (env GRFT_NO_REFRESH или конфиг)" };
	const dr = await driftReport(root);
	if (!dr.drifted) return { refreshed: false, reason: dr.reason ?? undefined };
	if (rebuildInflight.has(root)) return { refreshed: false, reason: "rebuild уже идёт (фоновый)" };
	const { build } = await import("./index.js");
	const job = (async (): Promise<number> => {
		try {
			return (await build(root, {})).files;
		} finally {
			rebuildInflight.delete(root);
		}
	})();
	job.catch(() => {
		/* после тайм-аута докрутка фоновая — ошибки не роняют сессию */
	});
	rebuildInflight.set(root, job);
	if (!opts.timeoutMs) {
		const files = await job;
		return { refreshed: true, files, reason: dr.reason ?? undefined };
	}
	const donePromise = job.then((files) => ({ t: "done" as const, files }));
	donePromise.catch(() => {
		/* build упал после тайм-аута — фоновая история, не роняем запрос */
	});
	const timeoutPromise = new Promise<{ t: "timeout" }>((res) => {
		const timer = setTimeout(() => res({ t: "timeout" }), opts.timeoutMs);
		(timer as { unref?: () => void }).unref?.();
	});
	const winner = await Promise.race([donePromise, timeoutPromise]);
	if (winner.t === "done") return { refreshed: true, files: winner.files, reason: dr.reason ?? undefined };
	return { refreshed: false, stale: true, reason: "rebuild в фоне (тайм-аут)" };
}
