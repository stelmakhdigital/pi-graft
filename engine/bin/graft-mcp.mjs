#!/usr/bin/env node
/**
 * graft-mcp — минимальный MCP-сервер (stdio, JSON-RPC 2.0, newline-delimited)
 * над pi-graft-engine. Без внешних зависимостей.
 *
 * Корень репо: env GRFT_MCP_ROOT (по умолчанию process.cwd(); граф ищется вверх
 * через findGraphRoot). Инструменты: те же 7, что в pi (graft_ask/grep/callers/
 * skeleton/map/check/blast).
 *
 * Использование (пример для MCP-клиента):
 *   command: node, args: ["engine/bin/graft-mcp.mjs"], env: { GRFT_MCP_ROOT: "/path/to/repo" }
 */
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

const jiti = createJiti(fileURLToPath(import.meta.url));
const engine = jiti("../src/index.ts");

const root = () => {
	const base = process.env.GRFT_MCP_ROOT ?? process.cwd();
	return engine.findGraphRoot(base) ?? base;
};

const TOOLS = [
	{
		name: "graft_ask",
		description: "Ранжированный запрос к графу Graft: символы/ноды с file:line, summary (deep) и crux-кодом.",
		inputSchema: {
			type: "object",
			properties: { query: { type: "string" }, scope: { type: "string" }, source: { type: "boolean" } },
			required: ["query"],
		},
	},
	{
		name: "graft_grep",
		description: "Исчерпывающий regex-поиск по индексированным файлам, сгруппированный по замыкающему символу.",
		inputSchema: {
			type: "object",
			properties: { pattern: { type: "string" }, scope: { type: "string" }, fixed: { type: "boolean" }, ignoreCase: { type: "boolean" } },
			required: ["pattern"],
		},
	},
	{
		name: "graft_callers",
		description: "Предвычисленные рёбра графа: кто зависит от символа (in) / на что ссылается (out), глубина.",
		inputSchema: {
			type: "object",
			properties: { symbol: { type: "string" }, scope: { type: "string" }, direction: { enum: ["in", "out"] }, depth: { anyOf: [{ type: "number" }, { const: "all" }], description: "transitive depth; all = full closure" } },
			required: ["symbol"],
		},
	},
	{
		name: "graft_skeleton",
		description: "Все сигнатуры файла (+ deep-summaries) без тел.",
		inputSchema: { type: "object", properties: { file: { type: "string" } }, required: ["file"] },
	},
	{
		name: "graft_map",
		description: "Ориентация в репо: кластеры каталогов, хабы, hotspots; deep: темы + file-summaries.",
		inputSchema: { type: "object", properties: { maxDirs: { type: "number" }, deep: { type: "boolean" } } },
	},
	{
		name: "graft_check",
		description: "Свежесть графа (JSON: added/removed/changed/stale).",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "graft_blast",
		description: "Blast radius git-диффа: что зависит от затронутых строк.",
		inputSchema: { type: "object", properties: { base: { type: "string" } } },
	},
];

async function callTool(name, args = {}) {
	const r = root();
	await engine.ensureFresh(r); // тихая пересборка при дрейфе (GRFT_NO_REFRESH=1 — выкл)
	const q = engine.makeQueries(r);
	switch (name) {
		case "graft_ask":
			return q.ask(args.query ?? "", { source: args.source === true });
		case "graft_grep":
			return q.grep(args.pattern ?? "", { scope: args.scope, fixed: args.fixed, ignoreCase: args.ignoreCase });
		case "graft_callers":
			return q.callers(args.symbol ?? "", { direction: args.direction, depth: args.depth });
		case "graft_skeleton":
			return q.skeleton(args.file ?? "");
		case "graft_map":
			return q.map({ maxDirs: args.maxDirs, deep: args.deep });
		case "graft_check":
			return (await q.check()).text;
		case "graft_blast":
			return await q.blast(args.base);
		default:
			throw new Error(`неизвестный инструмент: ${name}`);
	}
}

const reply = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

let buf = "";
process.stdin.on("data", (chunk) => {
	buf += chunk.toString();
	let idx;
	while ((idx = buf.indexOf("\n")) >= 0) {
		const line = buf.slice(0, idx).trim();
		buf = buf.slice(idx + 1);
		if (!line) continue;
		let req;
		try {
			req = JSON.parse(line);
		} catch {
			continue; // не JSON-RPC — пропускаем
		}
		const { id, method, params } = req;
		let handled = false;
		if (method === "initialize") {
			handled = true;
			reply({
				jsonrpc: "2.0",
				id,
				result: {
					protocolVersion: params?.protocolVersion ?? "2024-11-05",
					capabilities: { tools: {} },
					serverInfo: { name: "pi-graft-engine-mcp", version: "1.0.0" },
					instructions:
						"Локальный кодовый граф (pi-graft-engine), корень: " + root() + ". " +
						"Детерминированные запросы БЕЗ LLM: используй ПЕРЕД grep/чтениями файлов. " +
						"ask — «как это работает / где живёт» (file:line + сниппеты); grep — исчерпывающие все вхождения; " +
						"callers — кто зависит от символа (direction in/out, depth число или all — полное замыкание); " +
						"skeleton — все сигнатуры файла (~10x дешевле чтения); map — ориентация в репо; check — свежесть; blast — blast radius git-diffa. " +
						"Выдачи retrieval (ask/grep/skeleton/callers) открываются строкой [graft] tokens saved ≈ N — суммируй их и в конце ответа отчитайся: 🌱 graft saved ~N tokens (M calls). " +
						"Не обрезай выходы head/tail — сузь запрос (scope, depth).",
				},
			});
		}
		if (method === "tools/list") {
			handled = true;
			reply({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
		}
		if (method === "tools/call") {
			handled = true;
			callTool(params?.name, params?.arguments)
				.then((text) => reply({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String(text) }], isError: false } }))
				.catch((e) => reply({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `graft-mcp: ${e.message}` }], isError: true } }));
		}
		if (!handled && id !== undefined && !(method ?? "").startsWith("notifications/")) {
			reply({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
		}
	}
});
process.stdin.resume();
