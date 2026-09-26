/** Типы движка graft-engine. */

export type Lang = "ts" | "tsx" | "js" | "py" | "go" | "rust" | "c" | "cpp" | "sh" | "java" | "csharp" | "kotlin" | "ruby" | "php" | "swift" | "dart" | "scala" | "lua" | "r" | "elixir" | "solidity" | "ocaml" | "zig" | "clojure" | "nix";

export interface RepoFile {
	/** Путь относительно корня репо (posix). */
	path: string;
	lang: Lang;
	content: string;
	/** sha1(content). */
	hash: string;
}

export type NodeKind = "file" | "function" | "class" | "method" | "type";

export interface GraphNode {
	/** "path" (file) или "path#symbol". */
	id: string;
	name: string;
	kind: NodeKind;
	path: string;
	/** 1-based, инклюзивные строки. */
	span: { start: number; end: number };
	signature?: string | null;
	exported: boolean;
	/** sha1(text тела/декларации). */
	bodyHash: string;
}

export type EdgeRelation = "calls" | "imports" | "references";

export interface GraphEdge {
	source: string;
	target: string;
	relation: EdgeRelation;
	confidence: "extracted" | "lsp";
}

export interface GraphFileMeta {
	path: string;
	hash: string;
}

export interface Graph {
	version: 1;
	meta: {
		builtAt: string;
		root: string;
		files: GraphFileMeta[];
		/** Monorepo-скоупы: scope → пути (отсутствует/пусто — скоупов нет). */
		scopes?: Record<string, string[]>;
	};
	nodes: GraphNode[];
	edges: GraphEdge[];
}

export interface DeepSymbolEntry {
	hash: string;
	summary: string;
	crux?: string[];
}

/** Связь между концептами (темами): from использует/зависит от to (по рёбрам графа). */
export interface ConceptLink {
	from: string;
	to: string;
	type: "uses";
	count: number;
}

export interface DeepConcept {
	name: string;
	summary: string;
	files: string[];
}

/** Нерешённый member-вызов (метод не найден статически) — кандидат для lsp-sync (LSP goToDefinition). */
export interface LspCandidate {
	file: string;
	method: string;
	/** 0-based строка/колонка имени метода. */
	line: number;
	col: number;
	/** id вызывающего символа или файла. */
	caller: string;
}

export interface ProseNode {
	hash: string;
	topic: string;
	summary?: string;
	files: string[];
	text: string;
	/** Путь к markdown-файлу прозы (относительно root). */
	file: string;
	at: number;
}

export interface DeepStore {
	files: Record<string, { hash: string; summary: string }>;
	symbols: Record<string, DeepSymbolEntry>;
	/** Темы + типизованные связи между ними (part_of через files, uses — по рёбрам графа). */
	concepts?: { hash: string; topics: DeepConcept[]; links?: ConceptLink[] };
	/** Проза-ноды: нарратив «как это устроено» по теме (LLM deep), файл graft/prose/<slug>.md. */
	prose?: Record<string, ProseNode>;
}

/** Конфиг LLM для deep-прохода (openai-chat-формат). */
export interface DeepConfig {
	baseUrl: string;
	model: string;
	apiKey?: string;
	/** def 0.2 (llmChat) */
	temperature?: number;
	/** Таймаут одного LLM-запроса, мс (def 90s deep / 120s concepts) */
	timeoutMs?: number;
}
