/** Загрузка web-tree-sitter + wasm-грамматики (ts/tsx/js/py). */
import { Parser, Language, type Tree } from "web-tree-sitter";
import { getWasmPath } from "tree-sitter-wasm";
import type { Lang } from "./types.js";

let initPromise: Promise<void> | null = null;
const languages = new Map<Lang, Language>();

export function ensureParsers(): Promise<void> {
	if (!initPromise) {
		initPromise = (async () => {
			await Parser.init();
		})();
	}
	return initPromise;
}

export async function getLanguage(lang: Lang): Promise<Language> {
	let l = languages.get(lang);
	if (!l) {
		await ensureParsers();
		const GRAMMAR: Record<Lang, string> = {
		ts: "typescript",
		tsx: "tsx",
		js: "javascript",
		py: "python",
		go: "go",
		rust: "rust",
		c: "c",
		cpp: "cpp",
		sh: "bash",
		java: "java",
		csharp: "c_sharp",
		kotlin: "kotlin",
		ruby: "ruby",
		php: "php",
		swift: "swift",
		dart: "dart",
		scala: "scala",
		lua: "lua",
		r: "r",
		elixir: "elixir",
		solidity: "solidity",
		ocaml: "ocaml",
		zig: "zig",
		clojure: "clojure",
		nix: "nix",
	};
	const grammar = GRAMMAR[lang];
		l = await Language.load(getWasmPath(grammar as "typescript"));
		languages.set(lang, l);
	}
	return l;
}

const parsers = new Map<Lang, Parser>();

export async function parseSource(lang: Lang, source: string): Promise<Tree> {
	await ensureParsers();
	let p = parsers.get(lang);
	if (!p) {
		p = new Parser();
		p.setLanguage(await getLanguage(lang));
		parsers.set(lang, p);
	}
	const t = p.parse(source);
	if (!t) throw new Error("graft-engine: parse failed");
	return t;
}
