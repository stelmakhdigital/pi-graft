/** Оценка «tokens saved»: сколько модель сэкономила против чтения покрытых файлов целиком.
 *  Размер файлов — из fingerprint.json (записывается на каждой сборке; размер — точный и
 *  дёшево читаемый). Fallback — statSync. Порог: <100 tok строку не пишем (на крошечных
 *  файлах указатели стоят столько же, что и исходник). */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const CHARS_PER_TOKEN = 4; // грубая, осознанная константа (модели ~3-5 символов/токен)
const MIN_SAVED = 100;

export function makeSavings(root: string) {
	let cache: Map<string, number> | null = null;
	const sizeOf = (p: string): number => {
		if (cache?.has(p)) return cache!.get(p)!;
		try {
			if (!cache) {
				cache = new Map();
				const fp = JSON.parse(readFileSync(join(root, "graft", ".engine", "fingerprint.json"), "utf8")) as {
					files?: Record<string, { size?: number } | string>;
				};
				for (const [path, v] of Object.entries(fp.files ?? {})) if (typeof v === "object" && v && v.size) cache.set(path, v.size);
			}
			const n = cache.get(p);
			if (n !== undefined) return n;
			const st = statSync(join(root, p));
			cache.set(p, st.size);
			return st.size;
		} catch {
			return 0; // файл исчез (дрейф без пересборки) — не считаем, не падаем
		}
	};

	/** Положительные сэкономленные токены (0, если < MIN_SAVED или покрывать нечем). */
	const tokensSaved = (files: string[], out: string): number => {
		const seen = new Set<string>();
		let bytes = 0;
		for (const f of files) if (!seen.has(f)) { seen.add(f); bytes += sizeOf(f); }
		if (bytes === 0) return 0;
		const saved = bytes / CHARS_PER_TOKEN - out.length / CHARS_PER_TOKEN;
		return saved >= MIN_SAVED ? Math.round(saved) : 0;
	};

	/** Строка-футер (контракт со статус-баром/отчётом) или null. */
	const line = (files: string[], out: string): string | null => {
		const n = tokensSaved(files, out);
		return n > 0 ? `[graft] tokens saved ≈ ${n.toLocaleString("en-US")}` : null;
	};

	return { tokensSaved, line };
}
