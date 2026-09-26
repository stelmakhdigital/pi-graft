/**
 * Многоуровневый конфиг LLM для deep (build --deep / auto-deep / concepts / blast --name).
 *
 * Приоритет (field-level: каждое поле берётся из первого слоя, где оно задано):
 *   1. env        — GRFT_LLM_BASE_URL / GRFT_LLM_MODEL / GRFT_LLM_API_KEY (one-off, CI)
 *   2. project    — <root>/graft/.engine/llm.json (per-repo; /graft/ в .gitignore)
 *   3. global     — ~/.config/pi-graft/llm.json (дефолт, один раз на машину; chmod 600)
 *
 * Формат файла: { "baseUrl": "...", "model": "...", "apiKey": "...",
 *   "temperature": 0.2, "timeoutMs": 90000 } (все поля опц.; temperature/timeoutMs — числа).
 * Конфиг существует, когда baseUrl и model резолвились хотя бы частично из слоёв.
 *
 * Настройка: `graft config set --base-url … --model … [--api-key …] [--temperature N] [--timeout-ms N]
 *   [--scope global|project]` (+ runtime-ручки в project-конфиге, см. effectiveRuntime).
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { DeepConfig } from "./types.js";

/** Путь глобального конфига (override: env GRFT_LLM_CONFIG). */
export function globalLlmConfigPath(): string {
	return process.env.GRFT_LLM_CONFIG?.trim() || join(homedir(), ".config", "pi-graft", "llm.json");
}

/** Путь проектного конфига (внутри graft/.engine/ — не коммитится). */
export function projectLlmConfigPath(root: string): string {
	return join(root, "graft", ".engine", "llm.json");
}

function readJsonConfig(path: string): Record<string, unknown> {
	try {
		const j = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (j && typeof j === "object" && !Array.isArray(j)) return j as Record<string, unknown>;
	} catch {
		/* файла нет / битый JSON — слой пропускается */
	}
	return {};
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined =>
	typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined;

const STR_FIELDS = ["baseUrl", "model", "apiKey"] as const;
const NUM_FIELDS = ["temperature", "timeoutMs"] as const;

export interface ResolvedDeepConfig {
	config: DeepConfig | null;
	/** Откуда взято каждое поле: "env" | "project" | "global" (для show/ошибок). */
	sources: { baseUrl?: string; model?: string; apiKey?: string; temperature?: string; timeoutMs?: string };
}

/**
 * Резолвит deep-конфиг: env → project(root) → global.
 * null — если baseUrl или model не заданы нигде.
 */
export function resolveDeepConfig(root?: string): ResolvedDeepConfig {
	const layers: Array<{ name: "env" | "project" | "global"; data: Record<string, unknown> }> = [
		{ name: "env", data: { baseUrl: process.env.GRFT_LLM_BASE_URL, model: process.env.GRFT_LLM_MODEL, apiKey: process.env.GRFT_LLM_API_KEY } },
	];
	if (root) layers.push({ name: "project", data: readJsonConfig(projectLlmConfigPath(root)) });
	layers.push({ name: "global", data: readJsonConfig(globalLlmConfigPath()) });

	const sources: ResolvedDeepConfig["sources"] = {};
	const cfg: DeepConfig = { baseUrl: "", model: "" };
	const pickStr = (field: (typeof STR_FIELDS)[number]) => {
		for (const layer of layers) {
			const v = str(layer.data[field]);
			if (v) {
				Object.assign(cfg, { [field]: v });
				sources[field] = layer.name;
				return;
			}
		}
	};
	const pickNum = (field: (typeof NUM_FIELDS)[number]) => {
		for (const layer of layers) {
			const v = num(layer.data[field]);
			if (v !== undefined) {
				Object.assign(cfg, { [field]: v });
				sources[field] = layer.name;
				return;
			}
		}
	};
	for (const f of STR_FIELDS) pickStr(f);
	for (const f of NUM_FIELDS) pickNum(f);
	if (!cfg.baseUrl || !cfg.model) return { config: null, sources };
	return { config: cfg, sources };
}

/**
 * Мержит cfg в существующий конфиг-файл и пишет (chmod 600).
 * scope "project" — <root>/graft/.engine/llm.json (нужен root); "global" — ~/.config/pi-graft/llm.json.
 * Возвращает путь, в который записано.
 */
export function writeLlmConfig(scope: "global" | "project", root: string | undefined, cfg: Partial<DeepConfig>): string {
	const path = scope === "global" ? globalLlmConfigPath() : root ? projectLlmConfigPath(root) : null;
	if (!path) throw new Error("project-конфиг: нужен корень репо (запустите в корне или передайте --dir)");
	const next: Record<string, unknown> = { ...readJsonConfig(path) };
	for (const [k, v] of Object.entries(cfg)) if (v !== undefined && v !== null) next[k] = v;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(next, null, 1) + "\n");
	try {
		chmodSync(path, 0o600);
	} catch {
		/* без прав (например, Windows) — просто предупреждать нечем */
	}
	return path;
}

/** Маска API-ключа для вывода: abcd…wxyz (короткие — полностью). */
export function maskKey(key?: string): string {
	if (!key) return "—";
	if (key.length <= 8) return "*".repeat(key.length);
	return `${key.slice(0, 4)}…${key.slice(-4)}`;
}
