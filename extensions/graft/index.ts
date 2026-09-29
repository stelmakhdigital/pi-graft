/**
 * Graft — интеграция собственного кодового графа (pi-graft-engine) в pi.
 *
 * - Движок: engine/ (чистый TS: tree-sitter-wasm, без чужого runtime).
 * - Нативные инструменты: graft_ask, graft_grep, graft_callers, graft_skeleton,
 *   graft_map, graft_check, graft_blast (прямой import движка, без spawn).
 * - `<graft>`-секция системного промпта: `graft map` обновляется при каждом
 *   промпте (TTL-кэш 120s, инвалидация после правок).
 * - Push-режим (флаг --graft-push): `graft ask "<промпт>"` в секцию.
 * - Blast radius: после write/edit дописывается блок «кто зависит от изменённых
 *   символов».
 * - Бейдж свежести: `graft: synced` / `graft: ⚠ N stale` / `graft: нет графа`.
 * - Команда /graft: статус + `/graft build` / `/graft build deep`.
 * - Deep-конфиг LLM (многоуровневый, без дефолтов): env GRFT_LLM_* →
 *   <repo>/graft/.engine/llm.json → ~/.config/pi-graft/llm.json
 *   (openai-chat-формат; настройка: `graft config set`).
 *
 * Активно только в репозиториях с построенным графом (graft/.engine/graph.json).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import {
	blastFileText,
	build,
	checkStatus,
	deepCoverage,
	effectiveRuntime,
	enableAutoRebuild,
	ensureFresh,
	findGraphRoot,
	isRebuilding,
	makeQueries,
	readGraph,
	resolveDeepConfig,
	scopeOfPath,
} from "../../engine/src/index.js";

const STATUS_KEY = " graft";

function cap(text: string, max: number): string {
	return text.length <= max ? text : text.slice(0, max) + `\n…[обрезано до ${max} символов]`;
}

function toolResult(text: string, details: Record<string, unknown>) {
	return { content: [{ type: "text" as const, text }], details };
}

export default function graftExtension(pi: ExtensionAPI) {
	pi.registerFlag("graft", {
		description: "Включить интеграцию Graft (авто: активна, если в репо построен граф graft/)",
		type: "boolean",
		default: true,
	});
	pi.registerFlag("graft-map", {
		description: "Подмешивать `graft map` в системный промпт (секция <graft>)",
		type: "boolean",
		default: true,
	});
	pi.registerFlag("graft-push", {
		description: "При каждом промпте класть в секцию <graft> указатели графа под промпт (вкл по умолчанию; выкл: --graft-push=false). Гейты: длина/слова, coverage, novelty-dedup",
		type: "boolean",
		default: true,
	});
	pi.registerFlag("graft-blast", {
		description: "После write/edit дописывать blast radius (кто зависит от изменённых символов)",
		type: "boolean",
		default: true,
	});
	pi.registerFlag("graft-max-output", {
		description: "Лимит вывода graft-инструментов в символах (число; env GRFT_MAX_OUTPUT / config --max-output)",
		type: "string",
		default: "16000",
	});
	pi.registerFlag("graft-auto-rebuild", {
		description: "Тихая пересборка графа после правок write/edit (дебаунс 4 c; бейдж «syncing…»)",
		type: "boolean",
		default: true,
	});

	let mapCache: { text: string; at: number } | null = null;
	const MAP_TTL_MS = 120_000;
	let freshCache: { at: number; st: Awaited<ReturnType<typeof checkStatus>> } | null = null;
	const FRESH_TTL_MS = 30_000;
	let bgSyncRunning = false;
	/** Бюджет синхронного rebuild'а: дольше — отвечаем по старому графу, rebuild докручивается фоном.
	 *  env GRFT_REFRESH_TIMEOUT_MS → project-конфиг (graft config set --refresh-timeout-ms) → 10s. */
	function freshTimeoutMs(root: string | null): number {
		return effectiveRuntime(root ?? undefined).refreshTimeoutMs;
	}
	let lastEditedPath: string | null = null;

	function enabled(ctx: ExtensionContext): boolean {
		if (pi.getFlag("graft") === false) return false;
		return findGraphRoot(ctx.cwd) !== null;
	}

	function rootOf(ctx: ExtensionContext): string | null {
		return findGraphRoot(ctx.cwd);
	}

	/** Лимит вывода: флаг --graft-max-output (если не дефолт) → env GRFT_MAX_OUTPUT →
	 *  project-конфиг (graft config set --max-output) → 16000. */
	function maxOut(root: string | null = null): number {
		const flag = pi.getFlag("graft-max-output");
		if (flag != null && String(flag) !== "16000") return Number(flag) || 16000;
		return effectiveRuntime(root ?? undefined).maxOutput ?? 16000;
	}

	const noGraphHint =
		"В этом каталоге нет графа Graft (graft/.engine не найден выше cwd). Собери: `/graft build` (или `node engine/bin/graft.mjs build`), затем вызови инструмент снова.";


	async function refreshBadge(ctx: ExtensionContext, root: string | null): Promise<void> {
		if (!ctx.hasUI) return;
		if (!root) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		try {
			const st = await checkStatus(root);
			if (st.text === "нет графа") {
				ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("warning", "graft: нет графа — /graft build"));
				return;
			}
			const cov = Math.round(deepCoverage(root) * 100);
			const deepPart = cov > 0 ? ` · ${cov}% deep` : "";
			const savedPart = savingsSession.tokens > 0 ? ` · ≈${fmtTok(savingsSession.tokens)} tok saved` : "";
			if (!st.ok) ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("warning", `graft: ⚠ ${st.stale} stale${st.added ? ` +${st.added} new` : ""}${deepPart}${savedPart}`));
			else ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", `graft: synced${deepPart}${savedPart}`));
		} catch {
			// тихо
		}
	}

	/** Сессионный накопитель «tokens saved» (строка [graft] tokens saved ≈ в выводах тулов). */
	interface SavingsSession { tokens: number; calls: number }
	const savingsSession: SavingsSession = (globalThis as Record<string, unknown>).__graftSavings ??= { tokens: 0, calls: 0 };
	const recordSavings = (out: string, ctx?: ExtensionContext): void => {
		const m = /\[graft\] tokens saved ≈ ([\d,]+)/.exec(out);
		if (m) {
			savingsSession.tokens += parseInt(m[1].replace(/,/g, ""), 10);
			savingsSession.calls++;
			if (ctx) trackMetrics(ctx, { tokens: parseInt(m[1].replace(/,/g, ""), 10) });
		}
	};
	const fmtTok = (n: number): string => (Math.round(n / 1000) >= 100 ? `${Math.round(n / 1000)}k` : n.toLocaleString("en-US"));
	/** Сессионные метрики на диске (~/.local/state/pi-graft/metrics/<sid>.json, override: GRFT_STATE_DIR). */
	const metricsDir = (): string => process.env.GRFT_STATE_DIR?.trim() || join(homedir(), ".local", "state", "pi-graft", "metrics");
	const metricsPath = (sid: string): string => join(metricsDir(), `${sid}.json`);
	interface MetricsFile { calls: number; tokens: number; graftTurns: number; reportedTurns: number; sourceReads: number; sourceTokens: number; ts: number }
	const readMetrics = (ctx: ExtensionContext): MetricsFile | null => {
		try {
			const sid = (ctx.sessionManager as { getSessionId?: () => string } | undefined)?.getSessionId?.();
			if (!sid) return null;
			return JSON.parse(readFileSync(metricsPath(sid), "utf8")) as MetricsFile;
		} catch {
			return null;
		}
	};
	const trackMetrics = (ctx: ExtensionContext, patch: { calls?: number; tokens?: number; graftTurns?: number; reportedTurns?: number; sourceReads?: number; sourceTokens?: number }): void => {
		try {
			const sid = (ctx.sessionManager as { getSessionId?: () => string } | undefined)?.getSessionId?.();
			if (!sid) return;
			const p = metricsPath(sid);
			let m: MetricsFile = { calls: 0, tokens: 0, graftTurns: 0, reportedTurns: 0, sourceReads: 0, sourceTokens: 0, ts: Date.now() };
			try { m = { ...m, ...(JSON.parse(readFileSync(p, "utf8")) as MetricsFile) }; } catch { /* новая сессия */ }
			m.calls += patch.calls ?? 0;
			m.tokens += patch.tokens ?? 0;
			m.graftTurns += patch.graftTurns ?? 0;
			m.reportedTurns += patch.reportedTurns ?? 0;
			m.sourceReads += patch.sourceReads ?? 0;
			m.sourceTokens += patch.sourceTokens ?? 0;
			m.ts = Date.now();
			mkdirSync(dirname(p), { recursive: true });
			writeFileSync(p, JSON.stringify(m));
		} catch {
			// тихо
		}
	};
	const GRAFT_TOOL_NAMES = new Set(["graft_ask", "graft_grep", "graft_callers", "graft_skeleton", "graft_map", "graft_check", "graft_blast"]);
	/** Compliance: был ли graft-тул в ходе сессии с экономией, но без «🌱» в ответе. */
	let complianceReminder = false;
	/** Сводка по всем файлам метрик: за период (дни) calls/tokens; 0 = «сегодня с 00:00». */
	const readAllMetrics = (): MetricsFile[] => {
		try {
			const dir = metricsDir();
			return readdirSync(dir).filter((f) => f.endsWith(".json")).flatMap((f) => {
				try {
					return [JSON.parse(readFileSync(join(dir, f), "utf8")) as MetricsFile];
				} catch {
					return [];
				}
			});
		} catch {
			return [];
		}
	};
	const aggregateMetrics = (files: MetricsFile[], fromTs: number): { calls: number; tokens: number } => {
		const agg = { calls: 0, tokens: 0 };
		for (const m of files) {
			if ((m.ts ?? 0) >= fromTs) {
				agg.calls += m.calls ?? 0;
				agg.tokens += m.tokens ?? 0;
			}
		}
		return agg;
	};
	const statsReport = (lines: string[]): void => {
		const files = readAllMetrics();
		const dayStart = new Date();
		dayStart.setHours(0, 0, 0, 0);
		const row = (label: string, fromTs: number): void => {
			const agg = aggregateMetrics(files, fromTs);
			lines.push(`  ${label}: ${agg.calls} вызовов, ≈${fmtTok(agg.tokens)} токенов`);
		};
		lines.push(`Сводка экономии (метрики: ${metricsDir()}):`);
		row("Сегодня", dayStart.getTime());
		row("7 дней", Date.now() - 7 * 86_400_000);
		row("30 дней", Date.now() - 30 * 86_400_000);
		row("Всего", 0);
		const turns = files.reduce((s2, m) => s2 + (m.graftTurns ?? 0), 0);
		const reported = files.reduce((s2, m) => s2 + (m.reportedTurns ?? 0), 0);
		if (turns > 0) lines.push(`  🌱-отчёт в ответе: ${reported} из ${turns} graft-ходов`);
		const callsAll = files.reduce((s2, m) => s2 + (m.calls ?? 0), 0);
		const sr = files.reduce((s2, m) => s2 + (m.sourceReads ?? 0), 0);
		const st = files.reduce((s2, m) => s2 + (m.sourceTokens ?? 0), 0);
		if (sr > 0 && callsAll + sr > 0) {
			const share = Math.round((callsAll / (callsAll + sr)) * 100);
			lines.push(`  Usage mix: ${share}% граф / ${100 - share}% прямой source-read (${sr} read, ≈${fmtTok(st)} tok прочитано)`);
		}
		if (files.length === 0) lines.push("  (метрики ещё не записаны — появятся после первых graft-вызовов)");
	};

	/** «syncing…» на время тихой пересборки (сбрасывается в refreshBadge). */
	function setSyncingBadge(ctx: ExtensionContext): void {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", "graft: syncing…"));
	}

	// ---------- Инструменты ----------

	pi.registerTool({
		name: "graft_ask",
		label: "graft_ask",
		description:
			"Ранжированный запрос к графу Graft: подходящие символы/ноды с точными file:line и кодом (детерминированный поиск, без LLM). Для понимания «как это работает / где это лежит». Для исчерпывающего «все вхождения» используй graft_grep.",
		promptSnippet: "Ranked lookup in the local Graft code graph (nodes with file:line, $0, deterministic). Retrieval outputs open with a [graft] tokens saved ≈ N line; when you used graft tools in a turn, close your reply with one line: 🌱 graft saved ~N tokens this turn (M calls) — the sum of those lines. Never pipe graft output through head/tail/sed.",
		parameters: Type.Object({
			query: Type.String({ description: "Вопрос или набор идентификаторов (символ, строка ошибки, имя файла)" }),
			source: Type.Optional(Type.Boolean({ description: "true — в вывод каждого хита встроить код span (≤8 строк): результат и есть код, без доп. чтения файла" })),
			full: Type.Optional(Type.Boolean({ description: "(унаследованный флаг; без эффекта в v1) Полные определения вместо crux" })),
			scope: Type.Optional(Type.String({ description: "Ограничить подпроектом монорепо (префикс пути)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const root = rootOf(ctx);
			if (!root || !enabled(ctx)) return toolResult(noGraphHint, { error: "no-graph" });
			trackMetrics(ctx, { calls: 1 });
			try {
				await (async () => {
					const fr = await ensureFresh(root, { timeoutMs: freshTimeoutMs(root) });
					if (fr.stale) setSyncingBadge(ctx);
				})();
				const out = makeQueries(root).ask(params.query, { source: params.source, scope: params.scope });
				recordSavings(out, ctx);
				return toolResult(cap(out, maxOut(root)), { cmd: `graft ask ${params.query}` });
			} catch (e) {
				return toolResult(`graft ask: ${(e as Error).message}`, { error: "query" });
			}
		},
	});

	pi.registerTool({
		name: "graft_grep",
		label: "graft_grep",
		description:
			"Исчерпывающий regex-поиск по всем индексированным файлам графа Graft; хиты сгруппированы по замыкающему символу и ранжированы по связанности. Используй вместо grep -rn для индексированных файлов.",
		promptSnippet: "Exhaustive regex search over Graft-indexed files, grouped by enclosing symbol.",
		parameters: Type.Object({
			pattern: Type.String({ description: "Regex (или литерал с fixed: true)" }),
			scope: Type.Optional(Type.String({ description: "Префикс пути (файлы под этим каталогом)" })),
			fixed: Type.Optional(Type.Boolean({ description: "Трактовать pattern как строку, не regex" })),
			ignoreCase: Type.Optional(Type.Boolean({ description: "Без учёта регистра" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const root = rootOf(ctx);
			if (!root || !enabled(ctx)) return toolResult(noGraphHint, { error: "no-graph" });
			trackMetrics(ctx, { calls: 1 });
			try {
				await (async () => {
					const fr = await ensureFresh(root, { timeoutMs: freshTimeoutMs(root) });
					if (fr.stale) setSyncingBadge(ctx);
				})();
				const out = makeQueries(root).grep(params.pattern, { scope: params.scope, fixed: params.fixed, ignoreCase: params.ignoreCase });
				recordSavings(out, ctx);
				return toolResult(cap(out, maxOut(root)), { cmd: `graft grep ${params.pattern}` });
			} catch (e) {
				return toolResult(`graft grep: ${(e as Error).message}`, { error: "query" });
			}
		},
	});

	pi.registerTool({
		name: "graft_callers",
		label: "graft_callers",
		description:
			'Точные предвычисленные рёбра графа Graft: кто вызывает/использует символ (direction: "in", по умолчанию) или на что сам ссылается (direction: "out"). depth — транзитивное обхождение (blast radius), depth: "all" — полное замыкание (для refactoring/rename).',
		promptSnippet: "Exact dependency edges from the Graft graph (callers/callees, transitive depth).",
		parameters: Type.Object({
			symbol: Type.String({ description: "Имя символа (функция, класс, метод)" }),
			direction: Type.Optional(Type.Union([Type.Literal("in"), Type.Literal("out")], { description: "in (по умолчанию): кто зависит; out: на что зависит" })),
			depth: Type.Optional(Type.Union([Type.Number({ minimum: 1, maximum: 10 }), Type.Literal("all")], { description: "Глубина транзитивного обхода (blast radius); all — полное замыкание (для refactoring/rename)" })),
			scope: Type.Optional(Type.String({ description: "Показать только зависимости в скоупе (имя скоупа из [scope/] или префикс пути)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const root = rootOf(ctx);
			if (!root || !enabled(ctx)) return toolResult(noGraphHint, { error: "no-graph" });
			trackMetrics(ctx, { calls: 1 });
			try {
				await (async () => {
					const fr = await ensureFresh(root, { timeoutMs: freshTimeoutMs(root) });
					if (fr.stale) setSyncingBadge(ctx);
				})();
				const out = makeQueries(root).callers(params.symbol, { direction: params.direction, depth: params.depth, scope: params.scope });
				recordSavings(out, ctx);
				return toolResult(cap(out, maxOut(root)), { cmd: `graft callers ${params.symbol}` });
			} catch (e) {
				return toolResult(`graft callers: ${(e as Error).message}`, { error: "query" });
			}
		},
	});

	pi.registerTool({
		name: "graft_skeleton",
		label: "graft_skeleton",
		description:
			"Все сигнатуры одного файла (без тел) из графа Graft — API-поверхность примерно в 10 раз дешевле чтения файла целиком. Используй, чтобы осмотреть файл, прежде чем открывать его.",
		promptSnippet: "Every signature in a file from the Graft graph, ~10x cheaper than reading it.",
		parameters: Type.Object({
			file: Type.String({ description: "Путь к файлу (относительно корневого каталога графа)" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const root = rootOf(ctx);
			if (!root || !enabled(ctx)) return toolResult(noGraphHint, { error: "no-graph" });
			trackMetrics(ctx, { calls: 1 });
			try {
				await (async () => {
					const fr = await ensureFresh(root, { timeoutMs: freshTimeoutMs(root) });
					if (fr.stale) setSyncingBadge(ctx);
				})();
				const out = makeQueries(root).skeleton(params.file);
				recordSavings(out, ctx);
				return toolResult(cap(out, maxOut(root)), { cmd: `graft skeleton ${params.file}` });
			} catch (e) {
				return toolResult(`graft skeleton: ${(e as Error).message}`, { error: "query" });
			}
		},
	});

	pi.registerTool({
		name: "graft_map",
		label: "graft_map",
		description:
			"Ориентация в репо по графу Graft с бюджетом токенов: кластеры каталогов, хабы и hotspots (по in-degree). Точка входа в неизученном репо — сначала graft_map.",
		promptSnippet: "Token-budgeted repo orientation from the Graft graph (dir clusters, hubs, hotspots).",
		parameters: Type.Object({
			maxDirs: Type.Optional(Type.Number({ description: "Число каталогов в выводе (по умолчанию — авто)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const root = rootOf(ctx);
			if (!root || !enabled(ctx)) return toolResult(noGraphHint, { error: "no-graph" });
			trackMetrics(ctx, { calls: 1 });
			try {
				await (async () => {
					const fr = await ensureFresh(root, { timeoutMs: freshTimeoutMs(root) });
					if (fr.stale) setSyncingBadge(ctx);
				})();
				const out = makeQueries(root).map({ maxDirs: params.maxDirs });
				mapCache = { text: out, at: Date.now() };
				return toolResult(cap(out, maxOut(root)), { cmd: "graft map" });
			} catch (e) {
				return toolResult(`graft map: ${(e as Error).message}`, { error: "query" });
			}
		},
	});

	pi.registerTool({
		name: "graft_check",
		label: "graft_check",
		description:
			"Отчёт о свежести графа Graft: дрейф graft/ относительно кода (добавлено/удалено/изменено/stale), JSON. Не пересобирает граф — только сообщает.",
		promptSnippet: "Freshness/drift report of the Graft graph (JSON).",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const root = rootOf(ctx);
			if (!root || !enabled(ctx)) return toolResult(noGraphHint, { error: "no-graph" });
			trackMetrics(ctx, { calls: 1 });
			try {
				const { text, json } = await makeQueries(root).check();
				void refreshBadge(ctx, root);
				return toolResult(text, json as Record<string, unknown>);
			} catch (e) {
				return toolResult(`graft check: ${(e as Error).message}`, { error: "check" });
			}
		},
	});

	pi.registerTool({
		name: "graft_blast",
		label: "graft_blast",
		description:
			"Blast radius git-диффа по графу Graft: что зависит от строк, затронутых изменениями. base — референс для diff (например origin/main); без base — working tree (незакоммиченные изменения).",
		promptSnippet: "Blast radius of a git diff from the Graft graph.",
		parameters: Type.Object({
			base: Type.Optional(Type.String({ description: "Git-референс для сравнения (например origin/main)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const root = rootOf(ctx);
			if (!root || !enabled(ctx)) return toolResult(noGraphHint, { error: "no-graph" });
			trackMetrics(ctx, { calls: 1 });
			try {
				await (async () => {
					const fr = await ensureFresh(root, { timeoutMs: freshTimeoutMs(root) });
					if (fr.stale) setSyncingBadge(ctx);
				})();
				const out = await makeQueries(root).blast(params.base);
				return toolResult(cap(out, maxOut(root)), { cmd: `graft blast ${params.base ?? ""}`.trim() });
			} catch (e) {
				return toolResult(`graft blast: ${(e as Error).message}`, { error: "blast" });
			}
		},
	});

	/** Push: топ-хиты графа под промпт (askJson) + scope-хинт + сессионный dedup (retract:
	 *  старые пакеты не повторять — только новые id; пусто → пакет не инжектится). */
	const pushHits = async (root: string, prompt: string, words: string[], ctx: ExtensionContext): Promise<string | null> => {
		await (async () => {
			const fr = await ensureFresh(root, { timeoutMs: freshTimeoutMs(root) });
			if (fr.stale) setSyncingBadge(ctx);
		})();
		let scopes: Record<string, string[]> = {};
		try {
			scopes = readGraph(root).meta.scopes ?? {};
		} catch {
			/* графа ещё нет */
		}
		const scopeKey =
			Object.keys(scopes).find((k) => prompt.includes(k)) ??
			Object.keys(scopes).find((k) => {
				const tail = k.split("/").pop()?.toLowerCase();
				return tail ? words.some((w) => w.toLowerCase() === tail) : false;
			}) ??
			null;
		const scopeFiles = scopeKey ? new Set(scopes[scopeKey]) : null;
		const ask = makeQueries(root).askJson(prompt);
		const results = ask.results;
		// Coverage-гейт (детерминированный, $0): сильный матч — по имени/сигнатуре топ-хита,
		// слабый — только нудж (граф может знать больше), пусто — тишина.
		if (results.length === 0) return null;
		const strong = ask.coverageStrong ?? 0;
		const broad = ask.coverage ?? 0;
		const STRONG_FLOOR = 0.3;
		const HIGH_FLOOR = 0.5;
		if (strong < STRONG_FLOOR && broad < HIGH_FLOOR) {
			const nudged: boolean = (globalThis as Record<string, unknown>).__graftPushNudged ?? false;
			(globalThis as Record<string, unknown>).__graftPushNudged = true;
			if (nudged) return null;
			return `## Граф не дал сильного совпадения по этому промпту — если нужен код, начни с graft_ask «задача» (детерминированный поиск).`;
		}
		const inScope = scopeFiles ? results.filter((r) => scopeFiles.has(r.path)) : results;
		const seen: Set<string> = ((globalThis as Record<string, unknown>).__graftPushSeen as Set<string> | undefined) ?? new Set<string>();
		(globalThis as Record<string, unknown>).__graftPushSeen = seen;
		const idOf = (r: { path: string; name: string; start: number }): string => `${r.path}#${r.name}@L${r.start}`;
		const fresh = inScope.filter((r) => !seen.has(idOf(r)));
		if (fresh.length === 0) return null;
		for (const r of fresh) {
			seen.add(idOf(r));
			if (seen.size > 400) seen.clear();
		}
		// Формат: указатели без кода (топ-3) — свежая инъекция стоит full-price на каждый
		// промпт; код модель заберёт сама через graft_ask, когда укажатель зацепит.
		const lines = fresh.slice(0, 3).map((r) => `  ${r.path}:L${r.start}-L${r.end}  ${r.name}`);
		return `## Указатели графа под текущий промпт${scopeKey ? ` (scope: ${scopeKey})` : ""}\n${lines.join("\n")}`;
	};

	// ---------- Хуки ----------

	pi.on("session_start", async (_event, ctx) => {
		if (!enabled(ctx)) return;
		await refreshBadge(ctx, rootOf(ctx));
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!enabled(ctx)) return;
		const wantMap = pi.getFlag("graft-map") !== false;
		const wantPush = pi.getFlag("graft-push") === true;
		if (!wantMap && !wantPush) return;
		const root = rootOf(ctx);
		if (!root) return;

		const parts: string[] = [];
		if (wantMap) {
			if (!mapCache || Date.now() - mapCache.at > MAP_TTL_MS) {
				try {
					await (async () => {
						const fr = await ensureFresh(root, { timeoutMs: freshTimeoutMs(root) });
						if (fr.stale) setSyncingBadge(ctx);
					})();
					const out = makeQueries(root).map();
					mapCache = { text: out, at: Date.now() };
				} catch {
					if (!mapCache) return;
				}
			}
			parts.push(mapCache.text);
		}
		if (wantPush) {
			// Релевантность-гейт: короткие/не-кодовые промпты не шлём в граф.
			const words = event.prompt.match(/[a-zA-Zа-яё][a-zA-Zа-яё-]{3,}/g) ?? [];
			if (event.prompt.trim().length >= 15 && words.length > 0) {
				try {
					const out = await pushHits(root, event.prompt, words, ctx);
					if (out) parts.push(cap(out, 4000));
				} catch {
					// тихо
				}
			}
		}
		if (parts.length > 0) {
			const head: string[] = [
				`Нижележащий локальный граф кодовой базы (graft/) — собственный движок pi-graft-engine (engine). Используй его ПЕРЕД grep/чтениями файлов. ` +
				`Для уточнения есть инструменты graft_ask/graft_grep/graft_callers/graft_skeleton.`,
			];
			try {
				if (!freshCache || Date.now() - freshCache.at > FRESH_TTL_MS) {
					freshCache = { at: Date.now(), st: await checkStatus(root) };
				}
				const st = freshCache.st;
				if (st.text !== "нет графа") {
					head.push(st.ok ? "Свежесть: граф синхронен." : `Свежесть: ⚠ дрейф (stale ${st.stale}${st.added ? `, new ${st.added}` : ""}) — проверь /graft check, при необходимости /graft build.`);
				}
			} catch {
				// тихо
			}
			if (complianceReminder) {
				head.push("Напоминание: в прошлом ходе были graft-тулы со строками [graft] tokens saved, но отчёт об экономии отсутствует — заверши ответ строкой вида 🌱 graft saved ~N tokens (M calls).");
				complianceReminder = false;
			}
			event.systemPromptOptions.sections["graft"] = head.join("\n\n") + "\n\n" + parts.join("\n\n");
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.isError) return;
		if (!enabled(ctx)) return;
		// Usage mix: прямой source-read (тул read) — доля «граф vs прямой source».
		// Читы самих артефактов графа (graft/*) — НЕ source, не считаем.
		if (event.toolName === "read") {
			const rp = event.input?.path;
			const rpNorm = typeof rp === "string" ? rp.replace(/\\/g, "/") : "";
			if (rpNorm && !(rpNorm.includes("/graft/") || rpNorm.startsWith("graft/"))) {
				const textLen = (event.content ?? []).reduce((sum: number, c) => (c && c.type === "text" && typeof c.text === "string" ? sum + c.text.length : sum), 0);
				trackMetrics(ctx, { sourceReads: 1, sourceTokens: Math.ceil(textLen / 4) });
			}
			return;
		}
		if (event.toolName !== "write" && event.toolName !== "edit") return;
		if (pi.getFlag("graft-blast") === false) return;
		const path = event.input?.path;
		if (typeof path !== "string" || path.length === 0) return;
		const root = rootOf(ctx);
		if (!root) return;

		mapCache = null;
		const blast = blastFileText(root, path);
		const note = blast ? `🌿 Graft blast radius по ${path}:\n${blast}` : "";
		if (note && ctx.hasUI) ctx.ui.notify(note, "info");

		// Auto-rebuild: тихая пересборка после правки (дебаунс в enableAutoRebuild).
		if (pi.getFlag("graft-auto-rebuild") !== false) {
			setSyncingBadge(ctx);
			enableAutoRebuild(() => build(root, {}).then(() => refreshBadge(ctx, root)), 4000, root);
		}
		return note ? { content: [...event.content, { type: "text", text: note }] } : undefined;
	});
	// Compliance: в ходе были graft-тулы с экономией — счётчики tally; нет «🌱» → напомнить в след. секции.
	pi.on("turn_end", async (event, ctx) => {
		try {
			const trs = (event.toolResults ?? []) as Array<{ toolName?: string; content?: Array<{ type?: string; text?: string }> }>;
			let savingsInTurn = 0;
			for (const tr of trs) {
				if (!tr.toolName || !GRAFT_TOOL_NAMES.has(tr.toolName)) continue;
				const text = (tr.content ?? []).map((c) => (c.type === "text" ? c.text ?? "" : "")).join(" ");
				const m = /\[graft\] tokens saved ≈ ([\d,]+)/.exec(text);
				if (m) savingsInTurn += parseInt(m[1].replace(/,/g, ""), 10);
			}
			if (savingsInTurn === 0) return;
			const msg = event.message as { content?: Array<{ type?: string; text?: string }> } | undefined;
			const reply = (msg?.content ?? []).map((c) => (c.type === "text" ? c.text ?? "" : "")).join(" ");
			const reported = /🌱/.test(reply);
			trackMetrics(ctx, { graftTurns: 1, reportedTurns: reported ? 1 : 0 });
			if (!reported) complianceReminder = true;
		} catch {
			// тихо
		}
	});

	// Фоновый синхронизатор: после завершения хода — тихий ensureFresh + бейдж (guard одного rebuild).
	pi.on("agent_end", async (_event, ctx) => {
		if (!enabled(ctx)) return;
		const root = rootOf(ctx);
		if (!root || pi.getFlag("graft-auto-rebuild") === false || bgSyncRunning) return;
		bgSyncRunning = true;
		void ensureFresh(root)
			.then(() => refreshBadge(ctx, root))
			.catch(() => {
				// тихо
			})
			.finally(() => {
				bgSyncRunning = false;
			});
	});

	// ---------- Команды /graft и /graft:* ----------

	/** Деспатч подкоманд /graft (общий для `/graft <cmd>` и `/graft:<cmd>`). */
	const runGraftCmd = async (arg: string, ctx: ExtensionContext): Promise<void> => {
		const root = rootOf(ctx);
		const [cmd, ...rest] = arg.split(/\s+/);
		const restArg = rest.join(" ");
		if (cmd === "stats") {
			const lines: string[] = [];
			statsReport(lines);
			ctx.ui.notify(lines.join("\n"), "info");
			return;
		}
		if (cmd === "build") {
			const withDeep = restArg.includes("deep");
			const deepCfg = withDeep ? resolveDeepConfig(root ?? ctx.cwd).config : undefined;
			if (withDeep && !deepCfg) {
				ctx.ui.notify(
					"graft build deep: нет конфига LLM. Задайте через `graft config set --base-url … --model …` (или env GRFT_LLM_BASE_URL/GRFT_LLM_MODEL) и повторите.",
					"error",
				);
				return;
			}
			ctx.ui.notify(
				`Запускаю: graft build${withDeep ? " deep" : ""}… (${withDeep ? `LLM ${deepCfg!.model}` : "$0, tree-sitter-wasm"})`,
				"info",
			);
			try {
				const t0 = Date.now();
				const rep = await build(root ?? ctx.cwd, {
					deep: deepCfg ?? undefined,
					onProgress: (m) => ctx.ui.notify(`graft build: ${m}`, "info"),
				});
				mapCache = null;
				ctx.ui.notify(
					`graft build готов за ${((Date.now() - t0) / 1000).toFixed(1)}s: ${rep.files} файлов, ${rep.nodes} узлов, ${rep.edges} рёбер` +
						(rep.deep ? `, deep: +${rep.deep.filesDone}+${rep.deep.symbolsDone}, кэш ${rep.deep.filesCached}+${rep.deep.symbolsCached}, ошибок ${rep.deep.symbolsFailed}` : ""),
					"info",
				);
			} catch (e) {
				ctx.ui.notify(`graft build: ${(e as Error).message}`, "error");
			}
			await refreshBadge(ctx, root);
			return;
		}

		// Подкоманды-запросы к графу: ask/grep/callers/skeleton/map/check/blast/config.
		const USAGE = "Команды: /graft <cmd> или /graft:<cmd> — ask <запрос> · grep <regex> · callers <символ> [in|out] · skeleton <file> · map · check · blast [base] · config [show] · stats · build [deep]";
		if (!root) {
			ctx.ui.notify("Нет графа (graft/ не найден выше cwd) — сначала `/graft build` в корне репо.", "error");
			return;
		}
		const q = makeQueries(root);
		const out = (t: string): void => { mapCache = null; ctx.ui.notify(cap(t, maxOut(root)), "info"); };
		try {
			switch (cmd) {
				case "ask": if (!restArg) throw new Error("использование: /graft ask <запрос>"); out(q.ask(restArg, { source: true })); break;
				case "grep": if (!restArg) throw new Error("использование: /graft grep <regex>"); out(q.grep(restArg)); break;
				case "callers": if (!restArg) throw new Error("использование: /graft callers <символ> [in|out]"); out(q.callers(rest[0], { direction: rest[1] === "in" || rest[1] === "out" ? rest[1] : undefined })); break;
				case "skeleton": if (!restArg) throw new Error("использование: /graft skeleton <file>"); out(q.skeleton(restArg)); break;
				case "map": out(q.map()); break;
				case "check": out((await q.check()).text); break;
				case "blast": out(await q.blast(restArg || undefined)); break;
				case "config": if (restArg && restArg !== "show") throw new Error("поддерживается: /graft config show (настройка — через CLI `graft config set`)"); { const c = resolveDeepConfig(root).config; out(c ? `LLM: ${c.model} @ ${c.baseUrl} (apiKey: ${c.apiKey ? "задан" : "нет"})` : "LLM-конфиг не задан (CLI: `graft config set --base-url … --model …`)"); } break;
				default: throw new Error("неизвестная команда. " + USAGE);
			}
		} catch (e) {
			ctx.ui.notify(`graft ${cmd}: ${(e as Error).message}`, "error");
		}
	};

	pi.registerCommand("graft", {
		description: "Graft: /graft — сводка; /graft <cmd> — подкоманда (ask|grep|callers|skeleton|map|check|blast|config|stats|build); отдельные: /graft:build, /graft:ask, …",
		handler: async (args: string, ctx) => {
			const root = rootOf(ctx);
			const parts: string[] = [`Graft: pi-graft-engine (engine, свой движок)`];
			if (root) {
				const st = await checkStatus(root);
				const cov = Math.round(deepCoverage(root) * 100);
				parts.push(
					st.text === "нет графа"
						? "Граф: НЕ СОБРАН (/graft build)"
						: `Граф: ${root} — ${st.ok ? "синхронен" : `дрейф (stale ${st.stale}, new ${st.added})`}${cov > 0 ? ` · ${cov}% deep` : ""}`,
				);
			} else {
				parts.push("Граф: не найден (запусти `/graft build` в корне репо)");
			}
			parts.push(`Флаги: map=${pi.getFlag("graft-map") !== false} push=${pi.getFlag("graft-push") === true} blast=${pi.getFlag("graft-blast") === true}`);
			const m = readMetrics(ctx);
			if (m) parts.push(`Сессия: ${m.calls} вызовов graft-тулов, ≈${fmtTok(m.tokens)} токенов сэкономлено (метрика на диске, ~/.local/state/pi-graft).`);

			const w7 = aggregateMetrics(readAllMetrics(), Date.now() - 7 * 86_400_000);
			if (w7.calls > 0) parts.push(`Сводка за 7 дней: ${w7.calls} вызовов, ≈${fmtTok(w7.tokens)} токенов (подробно: /graft stats)`);

			const arg = args.trim();
			if (arg) {
				await runGraftCmd(arg, ctx);
				return;
			}

			ctx.ui.notify(parts.join("\n"), "info");
		},
	});

	// Отдельные команды /graft:* (стиль om:*) — тот же деспатч.
	const GRAFT_SUBCOMMANDS: Array<[string, string, string]> = [
		["graft:build", "build", "Пересобрать граф: /graft:build [deep]"],
		["graft:ask", "ask", "Поиск по графу: /graft:ask <запрос>"],
		["graft:grep", "grep", "Regex-поиск по индексированным файлам: /graft:grep <regex>"],
		["graft:callers", "callers", "Зависимости символа: /graft:callers <символ> [in|out]"],
		["graft:skeleton", "skeleton", "Сигнатуры файла: /graft:skeleton <file>"],
		["graft:map", "map", "Ориентация в репо: /graft:map"],
		["graft:check", "check", "Свежесть графа: /graft:check"],
		["graft:blast", "blast", "Blast radius git-диффа: /graft:blast [base]"],
		["graft:config", "config", "LLM-конфиг: /graft:config [show]"],
		["graft:stats", "stats", "Сводка экономии: /graft:stats"],
	];
	for (const [name, cmd, desc] of GRAFT_SUBCOMMANDS) {
		pi.registerCommand(name, {
			description: desc,
			handler: (args: string, ctx) => runGraftCmd(`${cmd}${args.trim() ? ` ${args.trim()}` : ""}`, ctx),
		});
	}

}
