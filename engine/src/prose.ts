/**
 * Проза-ноды Graft: нарратив «как это устроено» по теме (LLM deep).
 * - Темы — из concept-синтеза (deep.concepts.topics); топ-6 по числу файлов.
 * - Кэш: hash = sha1(тема | summary | file-hashes тематических файлов) —
 *   не изменились файлы темы → 0 LLM-вызовов (инкрементально, как deep).
 * - Артефакт: graft/prose/<slug>.md (читается моделью как обычный файл).
 * - Retrieval: `ask` подсовывает совпавшие по ключевым словам ноды в выдачу.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { llmChat } from "./concepts.js";
import { readDeep, writeDeep } from "./store.js";
import type { DeepConcept, DeepConfig, Graph } from "./types.js";

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

const slug = (name: string) => {
	const s = name
		.toLowerCase()
		.replace(/[^a-zа-яё0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
	return s || "topic";
};

export interface ProseReport {
	done: number;
	cached: number;
	failed: number;
	removed: number;
}

/** Нарратив по каждой из топ-тем. Без LLM-конфига не вызывается (см. build()). */
export async function proseBuild(root: string, g: Graph, cfg: DeepConfig, topics: DeepConcept[], onProgress?: (m: string) => void): Promise<ProseReport> {
	const deep = readDeep(root);
	if (!deep.prose) deep.prose = {};
	const fileHash = new Map<string, string>();
	for (const f of g.meta.files) fileHash.set(f.path, f.hash);

	const ranked = [...topics]
		.filter((t) => t.files?.length)
		.sort((a, b) => (b.files?.length ?? 0) - (a.files?.length ?? 0))
		.slice(0, 6);

	const report: ProseReport = { done: 0, cached: 0, failed: 0, removed: 0 };
	const keep = new Set<string>();

	for (const topic of ranked) {
		const files = (topic.files ?? []).slice(0, 8);
		const key = slug(topic.name ?? "topic");
		keep.add(key);
		const hash = sha1([topic.name ?? "", topic.summary ?? "", ...files.map((f) => fileHash.get(f) ?? f)].join("|"));
		const prev = deep.prose[key];
		if (prev?.hash === hash && existsSync(join(root, prev.file))) {
			report.cached++;
			continue;
		}
		// Контекст: символы тематических файлов + их deep-summaries.
		const ctxParts: string[] = [];
		for (const f of files) {
			const syms = g.nodes
				.filter((n) => n.path === f && n.kind !== "file")
				.slice(0, 8)
				.map((n) => `${n.name} (${n.path}:L${n.span.start})${n.signature ? ` — ${String(n.signature).slice(0, 120)}` : ""}${deep.symbols[n.id]?.summary ? ` — ${deep.symbols[n.id].summary}` : ""}`);
			if (syms.length) ctxParts.push(`${f}:\n${syms.join("\n")}`);
		}
		let context = ctxParts.join("\n\n");
		if (context.length > 7000) context = context.slice(0, 7000) + "\n… (обрезано)";
		try {
			const system =
				"Ты — аналитик кодовой базы. Пишешь короткий нарратив на русском: как устроена часть системы по данной теме. " +
				"10–20 строк plain markdown БЕЗ заголовков. Каждый значимый факт — с точной ссылкой file:line из контекста. " +
				"Только то, что подтверждено контекстом; не выдумывай. Возвращай только текст.";
			const user = `Тема: «${topic.name}»${topic.summary ? ` — ${topic.summary}` : ""}\n\nКонтекст:\n${context}`;
			const text = (await llmChat(cfg, system, user)).replace(/^```[a-z]*\n?/i, "").replace(/\n?```\s*$/, "").trim();
			if (!text) throw new Error("LLM вернул пустой текст");
			const file = `graft/prose/${key}.md`;
			mkdirSync(join(root, dirname(file)), { recursive: true });
			writeFileSync(
				join(root, file),
				`# ${topic.name ?? key}\n\n> Проза-нода Graft: нарратив «как это устроено». Сгенерировано LLM deep; регенерация — \`graft build --deep\` (инкрементально по hash файлов темы).\n\n${text}\n`,
			);
			deep.prose[key] = { hash, topic: topic.name ?? key, summary: topic.summary, files, text, file, at: Date.now() };
			report.done++;
			onProgress?.(`prose: +${file}`);
		} catch (e) {
			report.failed++;
			onProgress?.(`prose: ОШИБКА ${key}: ${(e as Error).message}`);
		}
	}

	// Утилизация мёртвых нод: файл темы исчез из графа и тема не в топ-ранке.
	for (const [key, node] of Object.entries(deep.prose)) {
		if (keep.has(key)) continue;
		const filesAlive = node.files.some((f) => fileHash.has(f));
		if (!filesAlive) {
			rmSync(join(root, node.file), { force: true });
			delete deep.prose[key];
			report.removed++;
		}
	}
	writeDeep(root, deep);
	return report;
}
