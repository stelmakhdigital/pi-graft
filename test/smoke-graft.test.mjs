/**
 * Смоук-тест graft-расширения (вынесен из test/smoke.test.mjs pi-extensions):
 * загружает extensions/graft/index.ts через jiti (как это делает сам pi)
 * со стаб-объектом ExtensionAPI и проверяет инструменты, /graft, флаги,
 * push-гейты, blast radius, метрики, stats и MCP-инициализацию.
 * Запуск: node test/smoke-graft.test.mjs
 */
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";

// Герметичность: CLI-сабпроцессы не должны лезть в реальный LLM global-конфиг машины.
if (!process.env.GRFT_LLM_CONFIG) process.env.GRFT_LLM_CONFIG = join(tmpdir(), "grft-llm-test-does-not-exist.json");

const jiti = createJiti(fileURLToPath(import.meta.url));

const results = [];
async function check(name, fn) {
	try {
		await fn();
		results.push(`ok   ${name}`);
	} catch (e) {
		results.push(`FAIL ${name}: ${e?.message ?? e}`);
	}
}

// --- стаб ExtensionAPI ---
function makePi() {
	const handlers = {};
	const shortcuts = [];
	const commands = [];
	const flags = [];
	const tools = [];
	return {
		handlers, shortcuts, commands, flags, tools,
		on: (event, fn) => { handlers[event] = fn; },
		registerShortcut: (key, def) => shortcuts.push({ key, def }),
		registerCommand: (name, def) => commands.push({ name, def }),
		registerFlag: (name, def) => flags.push({ name, def }),
		registerTool: (def) => tools.push(def),
		getFlag: () => false,
	};
}

const noUiCtx = {
	hasUI: false,
	mode: "tui",
	ui: {
		notify: () => {},
		setWidget: () => {},
		setStatus: () => {},
		theme: { fg: (_c, s) => s, bg: (_c, s) => s, bold: (s) => s },
	},
};

// === graft ===
{
	// makePi.getFlag по умолчанию возвращает false — для graft нужны дефолты из registerFlag
	function makePi2() {
		const base = makePi();
		base.getFlag = (name) => {
			const f = base.flags.find((x) => x.name === name); // реальный pi: без нормализации префикса
			return f ? f.default : false;
		};
		return base;
	}
	const graftExt = jiti("../extensions/graft/index.ts");
	const pi = makePi2();
	graftExt.default(pi);

	// берём пустой каталож, где графа нет
	const { mkdirSync: mkdirG } = await import("node:fs");
	const noGraphDir = "/tmp/pi-ext-no-graft";
	mkdirG(noGraphDir, { recursive: true });
	const ctxNoGraph = { ...noUiCtx, cwd: noGraphDir }; // в нём графа нет

	await check("graft: 7 инструментов зарегистрированы", () => {
		for (const name of ["graft_ask", "graft_grep", "graft_callers", "graft_skeleton", "graft_map", "graft_check", "graft_blast"]) {
			if (!pi.tools.find((t) => t.name === name)) throw new Error("нет " + name);
		}
	});
	await check("graft: /graft-команда и флаги", () => {
		if (!pi.commands.some((c) => c.name === "graft")) throw new Error("нет /graft");
		if (!pi.flags.some((f) => f.name === "graft-push")) throw new Error("нет --graft-push");
		const push = pi.flags.find((f) => f.name === "graft-push");
		if (push.def.default !== true) throw new Error("push должен быть включён по умолчанию (parity с always-on после init)");
	});
	await check("graft: без графа — подсказка о graft build", async () => {
		const tool = pi.tools.find((t) => t.name === "graft_map");
		const res = await tool.execute("id", {}, new AbortController().signal, () => {}, ctxNoGraph);
		const text = res.content[0].text;
		if (!text.includes("graft build")) throw new Error("нет подсказки: " + text.slice(0, 120));
	});

	// Фикстура с графом
	const { existsSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
	const { spawnSync } = await import("node:child_process");
	const fixture = "/tmp/pi-ext-graft-fixture";
	const engineBin = new URL("../engine/bin/graft.mjs", import.meta.url).pathname;
	if (!existsSync(fixture + "/graft/.engine/graph.json")) {
		rmSync(fixture, { recursive: true, force: true });
		mkdirSync(fixture, { recursive: true });
		writeFileSync(fixture + "/a.ts", "export function auth(req: string): string { return \"ok-\" + req; }\nexport function handler(req: string) { return auth(req).toUpperCase(); }\n");
		const b = spawnSync("git", ["init", "-q"], { cwd: fixture });
		if (b.status !== 0) throw new Error("git init failed");
		const add = spawnSync("git", ["add", "-A"], { cwd: fixture });
		if (add.status !== 0) throw new Error("git add failed");
		const build = spawnSync(process.execPath, [engineBin, "build"], { cwd: fixture, timeout: 60000, encoding: "utf8" });
		if (build.status !== 0) throw new Error("graft build failed: " + (build.stdout || "").slice(-300));
	}
	const ctxGraph = { ...noUiCtx, cwd: fixture };

	await check("graft: graft_map возвращает карту репо", async () => {
		const tool = pi.tools.find((t) => t.name === "graft_map");
		const res = await tool.execute("id", {}, new AbortController().signal, () => {}, ctxGraph);
		const text = res.content[0].text;
		if (!text.includes("repo map")) throw new Error("нет 'repo map': " + text.slice(0, 200));
	});
	await check("graft: graft_ask находит символы", async () => {
		const tool = pi.tools.find((t) => t.name === "graft_ask");
		const res = await tool.execute("id", { query: "where is auth" }, new AbortController().signal, () => {}, ctxGraph);
		const text = res.content[0].text;
		if (!text.includes("auth")) throw new Error("нет 'auth': " + text.slice(0, 200));
	});
	await check("graft: graft_ask source=true встраивает код хита", async () => {
		const tool = pi.tools.find((t2) => t2.name === "graft_ask");
		const res = await tool.execute("id", { query: "where is auth", source: true }, new AbortController().signal, () => {}, ctxGraph);
		const text = res.content[0].text;
		if (!text.includes("code L")) throw new Error("нет code-блока: " + text.slice(0, 300));
		if (!text.includes("ok-")) throw new Error("нет кода тела auth: " + text.slice(0, 300));
	});
	await check("graft: graft_ask limit=1 — не больше одного хита", async () => {
		const tool = pi.tools.find((t2) => t2.name === "graft_ask");
		const res = await tool.execute("id", { query: "where is auth", limit: 1 }, new AbortController().signal, () => {}, ctxGraph);
		const lines = res.content[0].text.split("\n").filter((l) => /^  \d/.test(l));
		if (lines.length > 1) throw new Error("limit=1, хитов: " + lines.length);
	});
	await check("graft: graft_callers scope — фильтр по пути", async () => {
		const tool = pi.tools.find((t) => t.name === "graft_callers");
		const res = await tool.execute("id", { symbol: "auth", scope: "no_such_dir_xyz" }, new AbortController().signal, () => {}, ctxGraph);
		const text = res.content[0].text;
		if (!text.includes("scope") && !text.includes("не найдено")) throw new Error("scope-ответ: " + text.slice(0, 200));
	});
	await check("graft usage mix: read-счётчик в метриках (graft/* не считается)", async () => {
		const { mkdtempSync: mk4 } = await import("node:fs");
		const { tmpdir: tmpd4 } = await import("node:os");
		const state = mk4(tmpd4 + "/pi-graft-mix-");
		const prev = process.env.GRFT_STATE_DIR;
		process.env.GRFT_STATE_DIR = state;
		const ctxMix = { ...ctxGraph, sessionManager: { getSessionId: () => "mix-sid" } };
		try {
			await pi.handlers.tool_result({ isError: false, toolName: "read", input: { path: "src/a.ts" }, content: [{ type: "text", text: "x".repeat(1600) }] }, ctxMix);
			await pi.handlers.tool_result({ isError: false, toolName: "read", input: { path: "graft/cards/a.ts.md" }, content: [{ type: "text", text: "y".repeat(1600) }] }, ctxMix);
			await pi.handlers.tool_result({ isError: false, toolName: "read", input: { path: "/repo/graft/prose/x.md" }, content: [{ type: "text", text: "z".repeat(1600) }] }, ctxMix);
			const m = JSON.parse((await import("node:fs")).readFileSync(state + "/mix-sid.json", "utf8"));
			if (m.sourceReads !== 1) throw new Error("sourceReads=1 (только src/a.ts): " + JSON.stringify(m));
			if (m.sourceTokens !== 400) throw new Error("sourceTokens=400: " + JSON.stringify(m));
		} finally {
			if (prev === undefined) delete process.env.GRFT_STATE_DIR;
			else process.env.GRFT_STATE_DIR = prev;
		}
	});
	await check("graft: graft_callers находит зависимых", async () => {
		const tool = pi.tools.find((t) => t.name === "graft_callers");
		const res = await tool.execute("id", { symbol: "auth" }, new AbortController().signal, () => {}, ctxGraph);
		const text = res.content[0].text;
		if (!text.includes("handler")) throw new Error("нет 'handler': " + text.slice(0, 200));
	});
	await check("graft: before_agent_start ставит секцию <graft> с картой", async () => {
		const sections = {};
		await pi.handlers.before_agent_start({ prompt: "fix auth bug", systemPromptOptions: { sections } }, ctxGraph);
		if (!sections.graft || !sections.graft.includes("repo map")) throw new Error("секция не установлена: " + JSON.stringify(Object.keys(sections)));
	});
	await check("graft: tool_result (write) дописывает blast radius", async () => {
		// правка a.ts (unstaged) → в diff попадает строка auth → зависимость handler
		const { readFileSync, writeFileSync: wf } = await import("node:fs");
		wf(fixture + "/a.ts", readFileSync(fixture + "/a.ts", "utf8") + "\n// touch\n");
		const res = await pi.handlers.tool_result({ isError: false, toolName: "write", input: { path: "a.ts" }, content: [{ type: "text", text: "written" }] }, ctxGraph);
		if (!res) throw new Error("ожидался результат с blast radius");
		const texts = res.content.map((c) => c.text).join("\n");
		if (!texts.includes("blast radius")) throw new Error("нет blast: " + texts.slice(0, 300));
	});
	// v2.6: push-гейт/dedup, compliance, метрики, MCP instructions
	const makePiFlags = (overrides) => {
		const base = makePi();
		base.getFlag = (name) => {
			const f = base.flags.find((x) => x.name === name); // реальный pi: без нормализации префикса
			return overrides["--" + name] ?? overrides[name] ?? (f ? f.default : false);
		};
		return base;
	};
	const ctxGraft = jiti("../extensions/graft/index.ts");
	const piPush = makePiFlags({ "--graft-push": true });
	ctxGraft.default(piPush);

	await check("graft push: гейт релевантности (короткий промпт → без пакета)", async () => {
		const sections = {};
		await piPush.handlers.before_agent_start({ prompt: "ок", systemPromptOptions: { sections } }, ctxGraph);
		if (sections.graft && sections.graft.includes("Top-хиты")) throw new Error("пакет на короткий промпт: " + sections.graft.slice(0, 200));
	});

	await check("graft push: дедуп по сессии (второй раз — только новые id)", async () => {
		const sections1 = {};
		await piPush.handlers.before_agent_start({ prompt: "fix the auth bug in handler", systemPromptOptions: { sections: sections1 } }, ctxGraph);
		if (!sections1.graft || !sections1.graft.includes("Указатели графа")) throw new Error("нет пакета: " + JSON.stringify(sections1.graft ?? null).slice(0, 200));
		if (!/a\.ts:L\d+-L\d+\s+auth/.test(sections1.graft)) throw new Error("нет указателя file:line: " + sections1.graft.slice(0, 300));
		if (sections1.graft.includes("export function")) throw new Error("сниппет в пакете (должен быть только указатель): " + sections1.graft.slice(0, 300));
		const sections2 = {};
		await piPush.handlers.before_agent_start({ prompt: "fix the auth bug in handler", systemPromptOptions: { sections: sections2 } }, ctxGraph);
		if (sections2.graft && sections2.graft.includes("Указатели графа")) throw new Error("повторный пакет: " + sections2.graft.slice(0, 200));
	});

	await check("graft compliance: turn_end без 🌱 → напоминание в след. секции", async () => {
		await pi.handlers.turn_end(
			{
				turnIndex: 0,
				message: { content: [{ type: "text", text: "готово, без эмодзи" }] },
				toolResults: [{ toolName: "graft_ask", content: [{ type: "text", text: "[graft] tokens saved ≈ 500\ngraft ask: ..." }] }],
			},
			ctxGraph,
		);
		const s1 = {};
		await pi.handlers.before_agent_start({ prompt: "продолжи работу над кодом проекта", systemPromptOptions: { sections: s1 } }, ctxGraph);
		if (!s1.graft || !s1.graft.includes("Напоминание")) throw new Error("нет напоминания: " + JSON.stringify(s1.graft ?? null).slice(0, 300));
		const s2 = {};
		await pi.handlers.before_agent_start({ prompt: "ещё один промпт для проверки кэша", systemPromptOptions: { sections: s2 } }, ctxGraph);
		if (s2.graft && s2.graft.includes("Напоминание")) throw new Error("напоминание не разовое: " + s2.graft.slice(0, 300));
	});

	await check("graft метрики: вызов тула пишет ~/.local/state (GRFT_STATE_DIR)", async () => {
		const { mkdtempSync, readFileSync: rf, existsSync: ex } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const state = mkdtempSync(tmpdir() + "/pi-graft-state-");
		const prev = process.env.GRFT_STATE_DIR;
		process.env.GRFT_STATE_DIR = state;
		try {
			const tool = pi.tools.find((t) => t.name === "graft_ask");
			await tool.execute("id", { query: "auth symbol" }, new AbortController().signal, () => {}, { ...ctxGraph, sessionManager: { getSessionId: () => "smoke-sid" } });
			const f = state + "/smoke-sid.json";
			if (!ex(f)) throw new Error("нет файла метрик: " + f);
			const m = JSON.parse(rf(f, "utf8"));
			if (m.calls < 1 || typeof m.tokens !== "number") throw new Error("плохие метрики: " + JSON.stringify(m));
		} finally {
			if (prev === undefined) delete process.env.GRFT_STATE_DIR;
			else process.env.GRFT_STATE_DIR = prev;
		}
	});

	await check("graft stats: /graft stats — сводка экономии по периодам", async () => {
		const { mkdtempSync, writeFileSync: wf3 } = await import("node:fs");
		const { tmpdir: tmpd } = await import("node:os");
		const state = mkdtempSync(tmpd + "/pi-graft-stats-");
		const now = Date.now();
		const D = 86_400_000;
		wf3(state + "/t0.json", JSON.stringify({ calls: 5, tokens: 1000, sourceReads: 30, sourceTokens: 5000, ts: now }));
		wf3(state + "/t6.json", JSON.stringify({ calls: 10, tokens: 5000, ts: now - 6 * D }));
		wf3(state + "/t40.json", JSON.stringify({ calls: 50, tokens: 90000, ts: now - 40 * D }));
		wf3(state + "/bad.json", "{не json");
		const prev = process.env.GRFT_STATE_DIR;
		process.env.GRFT_STATE_DIR = state;
		let notified = "";
		const ctxCap = { ...ctxGraph, ui: { ...noUiCtx.ui, notify: (m) => { notified += m + "\n"; } } };
		const cmd = pi.commands.find((c) => c.name === "graft").def;
		try {
			await cmd.handler("stats", ctxCap);
		} finally {
			if (prev === undefined) delete process.env.GRFT_STATE_DIR;
			else process.env.GRFT_STATE_DIR = prev;
		}
		if (!notified.includes("Сводка экономии")) throw new Error("нет заголовка: " + notified.slice(0, 300));
		const week = notified.match(/7 дн[а-я]*: (\d+) вызов[а-я]*, ≈([\d,]+) токенов/);
		if (!week || week[1] !== "15" || week[2] !== "6,000") throw new Error("неверные 7 дней: " + (week ? week.join(" ") : notified.slice(0, 300)));
		const total = notified.match(/Всего: (\d+) вызов[а-я]*, ≈([\d,]+) токенов/);
		if (!total || total[1] !== "65" || total[2] !== "96,000") throw new Error("неверный итог: " + (total ? total.join(" ") : notified.slice(0, 300)));
		if (!notified.includes("Usage mix: 68% граф / 32% прямой source-read")) throw new Error("нет usage mix: " + notified.slice(0, 400));
	});

	await check("graft push: coverage-гейт — слабые хиты дают нудж один раз, дальше тишина", async () => {
		// "toUpperCase" есть в сниппете handler → хиты есть, но в имени/пути их нет → weak.
		const s1 = {};
		await piPush.handlers.before_agent_start({ prompt: "toUpperCase in a.ts file", systemPromptOptions: { sections: s1 } }, ctxGraph);
		if (!s1.graft || !s1.graft.includes("не дал сильного совпадения")) throw new Error("нет нуджа: " + JSON.stringify(s1.graft ?? null).slice(0, 200));
		const s2 = {};
		await piPush.handlers.before_agent_start({ prompt: "toUpperCase again near the request path", systemPromptOptions: { sections: s2 } }, ctxGraph);
		if (s2.graft && s2.graft.includes("не дал сильного совпадения")) throw new Error("нудж повторился: " + s2.graft.slice(0, 200));
	});

	await check("graft tally: 🌱-доля пишется в метрики на turn_end", async () => {
		const { mkdtempSync } = await import("node:fs");
		const { tmpdir: tmpd } = await import("node:os");
		const state = mkdtempSync(tmpd + "/pi-graft-tally-");
		const prev = process.env.GRFT_STATE_DIR;
		process.env.GRFT_STATE_DIR = state;
		const ctxSid = { ...ctxGraph, sessionManager: { getSessionId: () => "tally-sid" } };
		try {
			const ev = (text) => ({ turnIndex: 0, message: { content: [{ type: "text", text }] }, toolResults: [{ toolName: "graft_ask", content: [{ type: "text", text: "[graft] tokens saved ≈ 900\ngraft ask: x" }] }] });
			await pi.handlers.turn_end(ev("готово, без эмодзи"), ctxSid);
			await pi.handlers.turn_end(ev("готово. 🌱 graft saved ~900 tokens (1 call)"), ctxSid);
			const { readFileSync: rf2 } = await import("node:fs");
			const m = JSON.parse(rf2(state + "/tally-sid.json", "utf8"));
			if (m.graftTurns !== 2 || m.reportedTurns !== 1) throw new Error("tally неверный: " + JSON.stringify(m));
		} finally {
			if (prev === undefined) delete process.env.GRFT_STATE_DIR;
			else process.env.GRFT_STATE_DIR = prev;
		}
	});

	await check("graft mcp: initialize отдаёт instructions с экономикой", async () => {
		const { spawn } = await import("node:child_process");
		const bin = new URL("../engine/bin/graft-mcp.mjs", import.meta.url).pathname;
		const p = spawn(process.execPath, [bin], { env: { ...process.env, GRFT_MCP_ROOT: fixture } });
		let buf = "";
		await new Promise((res) => {
			p.stdout.on("data", (d) => { buf += d.toString(); if (buf.includes("\n")) res(); });
			setTimeout(res, 5000);
		});
		p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
		await new Promise((res) => {
			p.stdout.on("data", (d) => { buf += d.toString(); if (buf.includes("instructions")) res(); });
			setTimeout(res, 5000);
		});
		p.kill();
		const line = buf.split("\n").find((l) => l.includes("instructions"));
		if (!line) throw new Error("нет instructions: " + buf.slice(0, 200));
		if (!line.includes("tokens saved")) throw new Error("instructions без экономики: " + line.slice(0, 200));
	});
}

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL"));
process.exit(failed.length ? 1 : 0);
