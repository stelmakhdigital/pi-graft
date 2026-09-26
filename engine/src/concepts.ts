/** Концепт-ноды: LLM-кластеризация файлов по темам (кэш в deep.concepts). */
import { createHash } from "node:crypto";
import type { DeepConcept, DeepConfig, DeepStore, Graph } from "./types.js";
import { readDeep, writeDeep } from "./store.js";

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

export async function llmChat(cfg: DeepConfig, system: string, user: string): Promise<string> {
	const url = cfg.baseUrl.replace(/\/$/, "") + "/chat/completions";
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
	const res = await fetch(url, {
		method: "POST",
		headers,
		body: JSON.stringify({ model: cfg.model, temperature: cfg.temperature ?? 0.2, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
		signal: AbortSignal.timeout(cfg.timeoutMs ?? 120_000),
	});
	if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
	const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
	const text = j.choices?.[0]?.message?.content;
	if (!text) throw new Error("LLM: пустой ответ");
	return text;
}

interface LlmTopics {
	topics?: Array<{ name?: string; summary?: string; files?: string[] }>;
}

/**
 * Кластеризация файлов на 3–8 тем.
 * - Есть deep-summaries файлов → один LLM-вызов, ответ строго JSON.
 * - Без summaries → детерминированный fallback: темы по каталогам (LLM не нужен).
 * Результат кешируется в deep.json по hash(список файлов + summaries).
 */
export async function conceptsBuild(root: string, g: Graph, cfg: DeepConfig, onProgress?: (m: string) => void): Promise<DeepConcept[]> {
	const deep: DeepStore = readDeep(root);
	const paths = g.meta.files.map((f) => f.path);
	const summaries: Record<string, string> = {};
	for (const p of paths) summaries[p] = deep.files[p]?.summary ?? "";
	const hash = sha1(paths.join("\n") + "::" + Object.values(summaries).join("\n"));
	if (deep.concepts?.hash === hash) return deep.concepts.topics;

	let topics: DeepConcept[] | null = null;
	const hasSummaries = Object.values(summaries).some(Boolean);

	if (hasSummaries && cfg.baseUrl && cfg.model) {
		const input = paths.map((p) => `- ${p}: ${summaries[p] || "(нет summary)"}`).join("\n").slice(0, 24_000);
		const raw = await llmChat(
			cfg,
			"Ты — организатор документации. Ответ — строго JSON без маркдаун.",
			`Разбей список файлов кодовой базы на 3–8 тем (топиков) по функциональности. Каждый файл — ровно в одном топике.
Ответ: {"topics": [{"name": "короткое имя темы", "summary": "одним предложением ≤25 слов о теме", "files": ["пути"]}]}.
Файлы:
${input}`,
		);
		const start = raw.indexOf("{");
		const end = raw.lastIndexOf("}");
		const parsed = JSON.parse(raw.slice(start, end + 1)) as LlmTopics;
		if (!Array.isArray(parsed.topics) || !parsed.topics.length) throw new Error("concepts: LLM вернул пустые темы");
		const mapped = parsed.topics
			.map((t) => ({
				name: String(t.name ?? "без имени").slice(0, 80),
				summary: String(t.summary ?? "").slice(0, 300),
				files: (t.files ?? []).map(String).filter((f) => paths.includes(f)),
			}))
			.filter((t) => t.files.length > 0);
		if (!mapped.length) throw new Error("concepts: LLM не вернул ни одной темы с файлами");
		topics = mapped;
	}

	// Пост-процесс: все файлы обязаны быть в каком-то топике.
	if (topics) {
		const covered = new Set(topics.flatMap((t) => t.files));
		const missing = paths.filter((p) => !covered.has(p));
		if (missing.length) {
			// Пропавшие → в топик с совпадающим префиксом каталога, иначе "Прочее".
			for (const p of missing) {
				const dir = p.split("/").slice(0, -1).join("/");
				const host = topics.find((t) => t.files.some((f) => f.startsWith(dir + "/")));
				if (host) host.files.push(p);
				else topics[topics.length - 1]?.files.push(p);
			}
		}
		onProgress?.(`темы (LLM): ${topics.map((t) => t.name).join(", ")}`);
	}

	if (!topics) {
		// Fallback без LLM: темы по верхним каталогам; корень — по языковой семье;
		// мелкие группы (<2 файлов) — в «прочее».
		const byDir = new Map<string, string[]>();
		for (const p of paths) {
			const dir = p.includes("/") ? p.split("/")[0] : "(root)";
			byDir.set(dir, [...(byDir.get(dir) ?? []), p]);
		}
		const langFamily = (p: string): string => {
			const ext = p.slice(p.lastIndexOf(".") + 1).toLowerCase();
			if (["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"].includes(ext)) return "ts-js";
			if (ext === "py") return "python";
			if (["go", "rs", "c", "h", "cpp", "cc", "sh", "bash", "java", "cs", "kt"].includes(ext)) return ext;
			return "other";
		};
		const groups = new Map<string, string[]>();
		for (const [dir, fs] of byDir) {
			if (dir === "(root)" && fs.length >= 3) {
				const byLang = new Map<string, string[]>();
				for (const p of fs) {
					const fam = langFamily(p);
					byLang.set(fam, [...(byLang.get(fam) ?? []), p]);
				}
				for (const [fam, fl] of byLang)
					groups.set(`root/${fam}`, [...(groups.get(`root/${fam}`) ?? []), ...fl]);
			} else {
				groups.set(dir, [...(groups.get(dir) ?? []), ...fs]);
			}
		}
		const main = [...groups.entries()].filter(([, fs]) => fs.length >= 2).sort((a, b) => b[1].length - a[1].length);
		const misc = [...groups.entries()].filter(([, fs]) => fs.length < 2).flatMap(([, fs]) => fs);
		topics = main.map(([name, fs]) => ({ name, summary: `${name}: ${fs.length} файлов.`, files: fs }));
		if (misc.length) topics.push({ name: "прочее", summary: `Разрозненные файлы: ${misc.length}.`, files: misc });
		onProgress?.(`темы (fallback без LLM): ${topics.length}`);
	}

	// Типизованные связи между темами (детерминированно, по рёбрам графа: from → to = "uses").
	const fileTopic = new Map<string, number>();
	topics.forEach((t, i) => { for (const f of t.files) fileTopic.set(f, i); });
	const pairCount = new Map<string, number>();
	for (const e of g.edges) {
		const sp = e.source.includes("#") ? e.source.split("#")[0] : e.source;
		const tp = e.target.includes("#") ? e.target.split("#")[0] : e.target;
		const a2 = fileTopic.get(sp);
		const b2 = fileTopic.get(tp);
		if (a2 === undefined || b2 === undefined || a2 === b2) continue;
		const key = a2 < b2 ? `${a2}->${b2}` : `${b2}->${a2}`;
		pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
	}
	const links = [...pairCount.entries()]
		.sort((x, y) => y[1] - x[1])
		.slice(0, 20)
		.map(([k, n]) => {
			const [fa, fb] = k.split("->").map(Number);
			return { from: topics[fa].name, to: topics[fb].name, type: "uses" as const, count: n };
		});
	deep.concepts = { hash, topics, links };
	writeDeep(root, deep);
	return topics;
}
