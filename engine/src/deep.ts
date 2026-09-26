/** Deep-проход: LLM-суммаризация файла + per-symbol summary/crux. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readDeep, writeDeep } from "./store.js";
import type { DeepConfig, DeepStore, Graph } from "./types.js";

interface LlmReply {
	summary: string;
	crux?: string[];
}

/** Один openai-chat запрос (для --name и concept-синтеза). */
export async function llmChat(cfg: DeepConfig, system: string, user: string): Promise<string> {
	const url = cfg.baseUrl.replace(/\/$/, "") + "/chat/completions";
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
	const body = {
		model: cfg.model,
		temperature: cfg.temperature ?? 0.2,
		messages: [
			{ role: "system", content: system },
			{ role: "user", content: user },
		],
	};
	for (let attempt = 0; attempt < 2; attempt++) {
		const ctl = new AbortController();
		const t = setTimeout(() => ctl.abort(), cfg.timeoutMs ?? 90_000);
		try {
			const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: ctl.signal });
			if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
			const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
			const text = j.choices?.[0]?.message?.content;
			if (!text) throw new Error("LLM: пустой ответ");
			return text;
		} finally {
			clearTimeout(t);
		}
	}
	throw new Error("LLM: не удалось получить ответ (2 попытки)");
}

const SYSTEM_RU = "Ты — индексатор кодовой базы. Отвечай на русском, точно и без воды.";

function parseLlmJson(raw: string): LlmReply | null {
	// Модель может обернуть JSON в маркдаун — вырезаем первый {...}.
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	try {
		const j = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
		if (typeof j.summary !== "string" || !j.summary.trim()) return null;
		const crux = Array.isArray(j.crux) ? (j.crux as unknown[]).filter((x): x is string => typeof x === "string") : undefined;
		return { summary: j.summary.trim().slice(0, 400), crux: crux?.slice(0, 6) };
	} catch {
		return null;
	}
}

export interface DeepReport {
	filesDone: number;
	filesCached: number;
	symbolsDone: number;
	symbolsCached: number;
	symbolsFailed: number;
}

/**
 * Инкрементальный deep-проход: только файлы/символы с изменившимся bodyHash.
 * Без cfg — ошибка (явный конфиг обязателен).
 */
export async function deepBuild(root: string, g: Graph, cfg: DeepConfig, onProgress?: (msg: string) => void): Promise<DeepReport> {
	if (!cfg.baseUrl || !cfg.model) throw new Error("deep: нужен конфиг LLM (baseUrl + model); см. `graft config show` / `graft config set`");
	const deep: DeepStore = readDeep(root);
	const report: DeepReport = { filesDone: 0, filesCached: 0, symbolsDone: 0, symbolsCached: 0, symbolsFailed: 0 };
	const fileNodes = g.nodes.filter((n) => n.kind === "file");
	const symNodes = g.nodes.filter((n) => n.kind === "function" || n.kind === "method" || n.kind === "class" || n.kind === "type");

	for (const f of fileNodes) {
		const cached = deep.files[f.path];
		if (cached && cached.hash === f.bodyHash) {
			report.filesCached++;
			continue;
		}
		const content = readFileSync(join(root, f.path), "utf8");
		const preview = content.slice(0, 6000);
		const syms = g.nodes.filter((n) => n.path === f.path && n.kind !== "file").map((n) => `${n.kind} ${n.name}`).join(", ");
		try {
			const raw = await llmChat(cfg, SYSTEM_RU, `Опиши ОДНИМ предложением (≤40 слов), что делает файл «${f.path}».\nСимволы: ${syms || "—"}\n\nКод (первое начало):\n${preview}`);
			deep.files[f.path] = { hash: f.bodyHash, summary: raw.trim().slice(0, 400) };
			report.filesDone++;
			onProgress?.(`файл: ${f.path}`);
		} catch (e) {
			report.symbolsFailed++;
			onProgress?.(`файл НЕ готов (${(e as Error).message.slice(0, 80)}): ${f.path}`);
		}
	}

	for (const s of symNodes) {
		const cached = deep.symbols[s.id];
		if (cached && cached.hash === s.bodyHash) {
			report.symbolsCached++;
			continue;
		}
		const content = readFileSync(join(root, s.path), "utf8");
		const lines = content.split("\n");
		const body = lines.slice(s.span.start - 1, Math.min(lines.length, s.span.end)).join("\n");
		if (body.length > 4000) {
			// Слишком большой символ — summary без crux.
			try {
				const raw = await llmChat(cfg, SYSTEM_RU, `Опиши ОДНИМ предложением (≤30 слов), что делает ${s.kind} «${s.name}» (${s.path}):\n${body.slice(0, 3000)}`);
				deep.symbols[s.id] = { hash: s.bodyHash, summary: raw.trim().slice(0, 300) };
				report.symbolsDone++;
			} catch {
				report.symbolsFailed++;
			}
			continue;
		}
		try {
			const raw = await llmChat(
				cfg,
				SYSTEM_RU +
					" Ответ — строго JSON без маркдаун: {\"summary\": \"одно предложение ≤30 слов\", \"crux\": [\"1-3 строки кода дословно из исходника, несущие ключевую логику\"]}.",
				`${s.kind} «${s.name}» из «${s.path}»:\n${body}`,
			);
			const parsed = parseLlmJson(raw);
			if (!parsed) {
				report.symbolsFailed++;
				onProgress?.(`JSON не распарсен: ${s.name}`);
				continue;
			}
			// Валидация crux: строки обязаны присутствовать в исходнике.
			const src = new Set(lines.map((l) => l.trim()).filter(Boolean));
			const crux = parsed.crux?.filter((l: string) => src.has(l.trim())).slice(0, 3);
			deep.symbols[s.id] = { hash: s.bodyHash, summary: parsed.summary, ...(crux?.length ? { crux } : {}) };
			report.symbolsDone++;
			onProgress?.(`символ: ${s.name}`);
		} catch (e) {
			report.symbolsFailed++;
			onProgress?.(`символ НЕ готов (${(e as Error).message.slice(0, 60)}): ${s.name}`);
		}
	}

	writeDeep(root, deep);
	return report;
}
