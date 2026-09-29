#!/usr/bin/env node
/**
 * graft (pi-graft-engine) — CLI для рук.
 *
 *   node engine/bin/graft.mjs build [--deep] [--follow-submodules | --no-follow-submodules] [--dir <dir>]
 *   node engine/bin/graft.mjs map [--dir <dir>]
 *   node engine/bin/graft.mjs ask <query> [--dir <dir>]
 *   node engine/bin/graft.mjs grep <pattern> [--scope <p>] [--fixed] [-i] [--dir <dir>]
 *   node engine/bin/graft.mjs callers <symbol> [--direction in|out] [-d N] [--dir <dir>]
 *   node engine/bin/graft.mjs skeleton <file> [--dir <dir>]
 *   node engine/bin/graft.mjs check [--json] [--dir <dir>]   # exit 1 при дрейфе (CI)
 *   node engine/bin/graft.mjs blast [base] [--dir <dir>]
 *   node engine/bin/graft.mjs concepts [--dir <dir>]     # темы (LLM, fallback по каталогам)
 *   node engine/bin/graft.mjs watch [--dir <dir>]       # авто-пересборка при изменениях
 *   node engine/bin/graft.mjs viz [--dir <dir>]         # graft/viz.html
 *   node engine/bin/graft.mjs config [show|set]         # конфиг LLM + runtime (без export каждый раз)
 *     set: --base-url <url> --model <m> [--api-key <k>] [--temperature N] [--timeout-ms N] [--scope global|project]
 *          [--no-refresh on|off] [--auto-deep on|off] [--follow-submodules on|off]
 *          [--refresh-mode size|hash] [--refresh-timeout-ms N] [--max-output N]  (runtime → project config.json)
 *     show: что резолвится и откуда (env → <repo>/graft/.engine/{llm,config}.json → ~/.config/pi-graft/llm.json)
 *
 * Auto-refresh: ask/grep/callers/skeleton/map/blast тихо пересобирают граф при дрейфе
 * (fingerprint: size+mtime; GRFT_REFRESH=hash — sha1; GRFT_NO_REFRESH=1 — выкл).
 * check НЕ пересобирает — только отчёт (и exit 1 при дрейфе).
 *
 * Deep-конфиг (многоуровневый, см. `graft config show`):
 *   1. env GRFT_LLM_BASE_URL / GRFT_LLM_MODEL / GRFT_LLM_API_KEY
 *   2. <root>/graft/.engine/llm.json (project, gitignored)
 *   3. ~/.config/pi-graft/llm.json (global, chmod 600)
 */
import { createJiti } from "jiti";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const jiti = createJiti(fileURLToPath(import.meta.url));
const engine = jiti("../src/index.ts");

const argv = process.argv.slice(2);
const [cmd, ...rest] = argv;

function optFlag(name) {
	const i = rest.indexOf(name);
	return i >= 0;
}
function optVal(name) {
	const i = rest.indexOf(name);
	return i >= 0 ? rest[i + 1] : undefined;
}
// Позиционные аргументы: без флагов и значений флагов-приёмников ("--dir somedir" не даёт "somedir").
const VALUE_FLAGS = new Set(["--dir", "--in", "--scope", "-d", "--depth", "-n", "--max-dirs", "--format", "--base"]);
function positionals() {
	const out = [];
	let skip = false;
	for (const a of rest) {
		if (skip) { skip = false; continue; }
		if (a.startsWith("-")) { skip = VALUE_FLAGS.has(a); continue; }
		out.push(a);
	}
	return out;
}

function deepConfig() {
	const soft = deepConfigSoft();
	if (!soft) {
		console.error("deep: нет конфига LLM. Задайте через `graft config set --base-url … --model …` (или env GRFT_LLM_BASE_URL/GRFT_LLM_MODEL).");
		process.exit(2);
	}
	return soft;
}
function deepConfigSoft() {
	return engine.resolveDeepConfig(root).config;
}

function renderBlastMarkdown(data, base) {
	const lines = [`## Blast radius${base ? ` — \`${base}\`` : " — working tree"}`];
	for (const f of data.files) {
		lines.push(``, `### ${f.path}${f.owner ? ` _(owner: ${f.owner})_` : ""}`);
		for (const sym of f.symbols) {
			lines.push(`- \`${sym.name}\` (L${sym.start})${sym.dependents.length ? ` ← ${sym.dependents.join(", ")}` : ""}`);
		}
	}
	return lines.join("\n");
}
async function nameBlastAreas(data) {
	const cfg = deepConfigSoft();
	if (!cfg) {
		console.error("blast --name: нет LLM-конфига (graft config show / graft config set)");
		return;
	}
	const list = data.files.map((f) => `- ${f.path}: ${f.symbols.map((x) => x.name).join(", ")}`).join("\n");
	const raw = await engine.llmChat(cfg, "Ты — ревьюер. Верни ТОЛЬКО JSON-массив коротких имён зон (по одному на строку списка, в том же порядке).", `Имёнуй зоны изменения (по файлам) одной-двумя словами. Список:\n${list}\nВерни JSON-массив.`);
	let names = [];
	try {
		names = JSON.parse(raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1));
	} catch {
		console.error("blast --name: не удалось разобрать ответ LLM");
		return;
	}
	if (Array.isArray(names)) for (const f of data.files) f.area = names[data.files.indexOf(f)];
	console.log("зоны (LLM):", data.files.map((f) => `${f.path} → ${f.area ?? "—"}`).join("; "));
}
const root = resolve(process.cwd(), optVal("--dir") ?? ".");

switch (cmd) {
	case "build": {
		const withDeep = optFlag("--deep") || optFlag("--deep-llm") || rest.includes("deep");
		// Сабмодули: явный флаг персистится в graft/.engine/config.json (авто-рефреш
		// и MCP будут вести себя так же); без флага — сохранённое (дефолт: выкл).
		const follow = optFlag("--follow-submodules") ? true : optFlag("--no-follow-submodules") ? false : undefined;
		console.log(`graft build: ${root}${withDeep ? " (+deep LLM)" : ""}${follow ? " (+сабмодули)" : ""}`);
		const t0 = Date.now();
		const rep = await engine.build(root, {
			deep: withDeep ? deepConfig() : undefined,
			followSubmodules: follow,
			onProgress: (m) => console.log("  …", m),
		});
		console.log(
			`готово за ${((Date.now() - t0) / 1000).toFixed(1)}s: ${rep.files} файлов, ${rep.nodes} узлов, ${rep.edges} рёбер, ${rep.cards} карточек` +
				(rep.deep ? `, deep: ${rep.deep.filesDone}+${rep.deep.symbolsDone} новых, ${rep.deep.filesCached}+${rep.deep.symbolsCached} из кэша, ошибок ${rep.deep.symbolsFailed}` : ""),
		);
		break;
	}
	case "map": {
		await engine.ensureFresh(root);
		const q = engine.makeQueries(root);
		console.log(q.map({ maxDirs: Number(optVal("--max-dirs")) || undefined }));
		break;
	}
	case "ask": {
		const query = positionals()[0];
		if (!query) throw new Error("usage: graft ask <query> [--source] [--in <scope>] [-n N] [--json]");
		await engine.ensureFresh(root);
		const q = engine.makeQueries(root);
		const scope = optVal("--in") ?? optVal("--scope");
		const n = Number(optVal("-n")) || undefined;
		if (optFlag("--json")) console.log(JSON.stringify(q.askJson(query, { scope, limit: n }), null, 2));
		else console.log(q.ask(query, { source: optFlag("--source"), scope, limit: n }));
		break;
	}
	case "grep": {
		const pattern = positionals()[0];
		if (!pattern) throw new Error("usage: graft grep <pattern>");
		await engine.ensureFresh(root);
		const q = engine.makeQueries(root);
		console.log(q.grep(pattern, { scope: optVal("--in") ?? optVal("--scope"), fixed: optFlag("--fixed"), ignoreCase: optFlag("-i") }));
		break;
	}
	case "callers": {
		const symbol = positionals()[0];
		if (!symbol) throw new Error("usage: graft callers <symbol>");
		await engine.ensureFresh(root);
		const q = engine.makeQueries(root);
		const d = optVal("-d") ?? optVal("--depth");
		const scope = optVal("--in") ?? optVal("--scope");
		console.log(q.callers(symbol, { direction: optVal("--direction") ?? "in", depth: d === "all" ? "all" : d ? Number(d) : undefined, scope }));
		break;
	}
	case "skeleton": {
		const file = positionals()[0];
		if (!file) throw new Error("usage: graft skeleton <file>");
		await engine.ensureFresh(root);
		console.log(engine.makeQueries(root).skeleton(file));
		break;
	}
	case "stats": {
		// Метрики сессий (без графа и сети): сколько ходов шло через граф,
		// а сколько модель читала source напрямую (тул read).
		const { readdirSync, readFileSync } = await import("node:fs");
		const { homedir } = await import("node:os");
		const dir = process.env.GRFT_STATE_DIR?.trim() || resolve(homedir(), ".local", "state", "pi-graft", "metrics");
		let files = [];
		try {
			files = readdirSync(dir)
				.filter((f) => f.endsWith(".json"))
				.flatMap((f) => {
					try {
						return [{ sid: f.slice(0, -5), ...JSON.parse(readFileSync(resolve(dir, f), "utf8")) }];
					} catch {
						return [];
					}
				});
		} catch { /* каталог ещё не создан */ }
		if (!files.length) {
			console.log("graft stats: метрик нет (появятся после первых graft-вызовов/source-reads; dir: " + dir + ")");
			break;
		}
		files.sort((x, y) => (y.ts ?? 0) - (x.ts ?? 0));
		const m = files[0];
		const calls = m.calls ?? 0;
		const sr = m.sourceReads ?? 0;
		const share = calls + sr > 0 ? Math.round((calls / (calls + sr)) * 100) : 0;
		if (optFlag("--json")) {
			console.log(
				JSON.stringify(
					{
						session: m.sid,
						ts: m.ts,
						graftCalls: calls,
						tokensSaved: m.tokens ?? 0,
						sourceReads: sr,
						sourceTokensRead: m.sourceTokens ?? 0,
						graphSharePct: share,
						graftTurns: m.graftTurns ?? 0,
						reportedTurns: m.reportedTurns ?? 0,
					},
					null,
					1,
				),
			);
			break;
		}
		const tok = (n) => "≈" + Math.round(n).toLocaleString("ru-RU");
		console.log(`graft stats (сессия ${m.sid}, активность ${new Date(m.ts ?? 0).toISOString().slice(0, 16).replace("T", " ")}):`);
		console.log(`  graft-вызовы: ${calls} · сэкономлено ${tok(m.tokens ?? 0)} tok`);
		console.log(`  прямые source-reads: ${sr} (прочитано ${tok(m.sourceTokens ?? 0)} tok)`);
		console.log(`  usage mix: ${share}% граф / ${100 - share}% прямой source-read`);
		if (m.graftTurns) console.log(`  🌱-отчёт: ${m.reportedTurns ?? 0}/${m.graftTurns} graft-ходов`);
		break;
	}
	case "check": {
		const status = await engine.checkStatus(root);
		if (optFlag("--json")) {
			const q = engine.makeQueries(root);
			const { json } = await q.check();
			console.log(JSON.stringify(json, null, 1));
			process.exitCode = json.ok ? 0 : 1;
		} else {
			console.log(status.text);
			process.exitCode = status.ok ? 0 : 1;
		}
		break;
	}
	case "blast": {
		const base = rest.find((a) => !a.startsWith("-") && a !== optVal("--format"));
		await engine.ensureFresh(root);
		const q = engine.makeQueries(root);
		const format = optVal("--format") ?? "text";
		const owners = !optFlag("--no-owners");
		const data = await q.blastData(base, { owners });
		if (format === "json") {
			console.log(JSON.stringify(data, null, 2));
		} else if (format === "markdown") {
			console.log(renderBlastMarkdown(data, base));
			if (optFlag("--name")) await nameBlastAreas(data);
		} else {
			console.log(await q.blast(base));
		}
		if (optVal("--export-viz")) {
			const out = engine.writeBlastViz(root, data, optVal("--export-viz"));
			console.log(`graft blast: viz → ${out}`);
		}
		break;
	}
	case "config": {
		const sub = rest.find((a) => !a.startsWith("-")) ?? "show";
		if (sub === "set") {
			const numOpt = (name, min = 1) => {
				const v = optVal(name);
				if (v === undefined) return undefined;
				const n = Number(v);
				if (!Number.isFinite(n) || n < min) throw new Error(`${name}: ожидается число >= ${min}, получено: ${v}`);
				return n;
			};
			const boolOpt = (name) => {
				const v = optVal(name);
				if (v === undefined) return undefined;
				if (v === "on" || v === "1" || v === "true") return true;
				if (v === "off" || v === "0" || v === "false") return false;
				throw new Error(`${name}: on|off, получено: ${v}`);
			};
			// LLM (llm.json, scope global|project)
			const cfg = {
				baseUrl: optVal("--base-url"),
				model: optVal("--model"),
				apiKey: optVal("--api-key"),
				temperature: numOpt("--temperature", 0),
				timeoutMs: numOpt("--timeout-ms"),
			};
			const hasLlm = Object.values(cfg).some((v) => v !== undefined);
			// Runtime (per-repo, → graft/.engine/config.json; приоритет: env GRFT_* → файл → def)
			const runtime = {};
			const nr = boolOpt("--no-refresh"); if (nr !== undefined) runtime.noRefresh = nr;
			const ad = boolOpt("--auto-deep"); if (ad !== undefined) runtime.autoDeep = ad;
			const fsm = boolOpt("--follow-submodules"); if (fsm !== undefined) runtime.followSubmodules = fsm;
			const rm = optVal("--refresh-mode");
			if (rm !== undefined) { if (rm !== "size" && rm !== "hash") throw new Error("--refresh-mode: size|hash"); runtime.refresh = rm; }
			const rtm = numOpt("--refresh-timeout-ms"); if (rtm !== undefined) runtime.refreshTimeoutMs = rtm;
			const mo = numOpt("--max-output"); if (mo !== undefined) runtime.maxOutput = mo;
			const hasRuntime = Object.keys(runtime).length > 0;
			if (!hasLlm && !hasRuntime)
				throw new Error("usage: graft config set [--base-url <url> --model <m> [--api-key <k>] [--temperature N] [--timeout-ms N] [--scope global|project] [--no-refresh on|off] [--auto-deep on|off] [--follow-submodules on|off] [--refresh-mode size|hash] [--refresh-timeout-ms N] [--max-output N]");
			if (hasLlm) {
				// Дефолтный скоуп: project, если в корне есть graft/ (репо с графом), иначе global.
				const scope = optVal("--scope") ?? (existsSync(join(root, "graft")) ? "project" : "global");
				const path = engine.writeLlmConfig(scope, root, cfg);
				console.log(`graft config (LLM): записано в ${path} (0600)`);
			}
			if (hasRuntime) {
				const p = join(root, "graft", ".engine", "config.json");
				engine.writeBuildConfig(root, runtime);
				console.log(`graft config (runtime): записано в ${p}`);
			}
			console.log("проверка: graft config show");
		} else if (sub === "show") {
			const r = engine.resolveDeepConfig(root);
			const src = (s) => (s ? `  ← ${s}` : "");
			const projectPath = engine.projectLlmConfigPath(root);
			const globalPath = engine.globalLlmConfigPath();
			const lines = [
				`graft config (root: ${root})`,
				`  baseUrl: ${r.config?.baseUrl ?? "—"}${src(r.sources.baseUrl)}`,
				`  model:   ${r.config?.model ?? "—"}${src(r.sources.model)}`,
				`  apiKey:  ${engine.maskKey(r.config?.apiKey)}${src(r.sources.apiKey)}`,
				`  temperature: ${r.config?.temperature ?? "—"}${src(r.sources.temperature)}${r.config?.temperature == null ? " (def 0.2)" : ""}`,
				`  timeoutMs:   ${r.config?.timeoutMs ?? "—"}${src(r.sources.timeoutMs)}${r.config?.timeoutMs == null ? " (def 90s deep / 120s concepts)" : ""}`,
				`  project: ${projectPath}${existsSync(projectPath) ? " (есть)" : " (нет)"}`,
				`  global:  ${globalPath}${existsSync(globalPath) ? " (есть)" : " (нет)"}`,
			];
			if (!r.config) lines.push("  → конфиг НЕ резолвится (нужны baseUrl + model): graft config set --base-url … --model …");
			else if (r.sources.baseUrl === "env" || r.sources.model === "env") lines.push("  → часть полей из env (GRFT_LLM_*) — env имеет приоритет над файлами");
			// Runtime: env GRFT_* → graft/.engine/config.json → дефолты
			const rt = engine.effectiveRuntime(root);
			const bc = engine.readBuildConfig(root);
			const bcPath = join(root, "graft", ".engine", "config.json");
			lines.push(
				"",
				"  runtime (env → config.json → def):",
				`    auto-rebuild:       ${rt.noRefresh ? "ВЫКЛ (no-refresh)" : "вкл"}`,
				`    auto-deep:          ${rt.autoDeepDisabled ? "ВЫКЛ" : "вкл"}`,
				`    refresh-fingerprint:${rt.useHash ? " hash (sha1)" : " size+mtime"}`,
				`    refresh-timeout:    ${rt.refreshTimeoutMs}ms`,
				`    max-output:         ${rt.maxOutput ?? 16000}`,
				`    follow-submodules:  ${bc.followSubmodules ? "вкл" : "выкл"}`,
				`    config.json:        ${bcPath}${existsSync(bcPath) ? " (есть)" : " (нет)"}`,
			);
			console.log(lines.join("\n"));
		} else {
			throw new Error(`usage: graft config [show|set] (неизвестное: ${sub})`);
		}
		break;
	}
	case "concepts": {
		const cfg = deepConfigSoft();
		if (!cfg?.baseUrl && !cfg?.model) console.log("подсказка: без конфига LLM (graft config show) темы соберутся fallback'ом по каталогам");
		const g = engine.readGraph(root);
		const topics = await engine.conceptsBuild(root, g, cfg, (m) => console.log("  …", m));
		for (const t of topics) console.log(`${t.name}: ${t.summary}\n  [${t.files.slice(0, 10).join(", ")}${t.files.length > 10 ? ", …" : ""}]`);
		break;
	}
	case "watch": {
		const { watch } = await import("node:fs");
		let timer = null;
		const w = watch(root, { recursive: true });
		w.on("change", (_ev, p) => {
			if (!p || p.startsWith("graft/") || p.includes("node_modules/")) return;
			clearTimeout(timer);
			timer = setTimeout(async () => {
				try {
					const rep = await engine.build(root);
					const deepPart = rep.deep ? `, auto-deep: +${rep.deep.filesDone} файлов/+${rep.deep.symbolsDone} символов (кэш ${rep.deep.filesCached}/${rep.deep.symbolsCached})` : "";
					console.log(`[${new Date().toLocaleTimeString()}] rebuild: ${rep.files} файлов, ${rep.nodes} узлов, ${rep.edges} рёбер${deepPart}`);
				} catch (e) {
					console.log("rebuild failed:", e.message);
				}
			}, 1500);
		});
		console.log(`graft watch: слежу за ${root} (дебаунс 1.5s; auto-deep при дрейфе — если есть конфиг LLM: graft config show). Ctrl+C — стоп.`);
		await new Promise(() => {});
		break;
	}
	case "prose": {
		await engine.ensureFresh(root);
		const deep = engine.readDeep(root);
		const items = Object.values(deep.prose ?? {});
		if (!items.length) { console.log("Проза-нод нет (создаются `graft build --deep`: LLM-нарратив по топ-темам концептов)."); break; }
		console.log(`graft prose: ${items.length} нод(ы)`);
		for (const n of items.sort((x, y) => y.at - x.at)) console.log(`  ${n.file} — ${n.topic} (${new Date(n.at).toISOString().slice(0, 10)})`);
		break;
	}
	case "viz": {
		const serveArg = optVal("--serve");
		if (serveArg !== undefined) {
			const port = serveArg === "" || serveArg === "true" ? 8123 : parseInt(serveArg, 10);
			if (!Number.isFinite(port) || port < 1) throw new Error("usage: graft viz --serve [порт] (по умолчанию 8123)");
			const url = engine.serveViz(root, port);
			console.log(`graft viz: ${url} (live-reload каждые 5с; Ctrl+C — стоп)`);
		} else {
			const out = engine.writeViz(root, engine.readGraph(root));
			console.log(`graft viz: ${out}`);
		}
		break;
	}
	case "lsp-status": {
		const st = engine.lspStatus(root);
		if (st.length === 0) console.log("LSP-кандидатов нет (unresolved пусто)");
		for (const row of st) console.log(`graft lsp ${row.lang}: ${row.available ? "сервер есть" : "НЕТ сервера (" + row.bin + ")"} · ${row.candidates} к. · ${row.available ? "" : "установка: " + row.install}`);
		break;
	}
	case "lsp-sync": {
		await engine.ensureFresh(root);
		const rep = await engine.lspSync(root);
		if (rep.candidates === 0) console.log("graft lsp-sync: кандидатов нет (unresolved.json пуст)");
		for (const l of rep.langs) {
			if (l.available && l.ok) console.log(`graft lsp ${l.lang} (${l.bin}): +${l.edges} рёбер (lsp)`);
			else if (l.available) console.log(`graft lsp ${l.lang} (${l.bin}): ошибка — ${l.error}`);
			else console.log(`graft lsp ${l.lang}: сервер ${l.bin} не найден (${l.candidates} к.) — установка: ${l.install}`);
		}
		console.log(`graft lsp-sync: всего +${rep.totalEdges} рёбер`);
		break;
	}
	case "init": {
		const rep = engine.initWiring(root, { dryRun: optFlag("--dry-run"), mcp: !optFlag("--no-mcp") });
		for (const f of rep.files) console.log(`graft init [${f.action}] ${f.path}`);
		if (optFlag("--dry-run")) console.log("graft init: dry-run — ничего не записано");
		break;
	}
	case "uninstall": {
		const rep = engine.uninstallWiring(root, { dryRun: !optFlag("-y") && !optFlag("--yes") });
		for (const f of rep.files) console.log(`graft uninstall [${f.action}] ${f.path}`);
		break;
	}
	default:
		console.log("pi-graft-engine CLI — см. шапку файла engine/bin/graft.mjs");
		process.exit(cmd ? 1 : 0);
}
