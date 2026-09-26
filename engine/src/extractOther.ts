/** Извлечение для Go / Rust / C / C++ / Shell: символы + именованные вызовы. */
import { createHash } from "node:crypto";
import type { Tree, Node as TsNode } from "web-tree-sitter";
import type { GraphEdge, GraphNode, RepoFile } from "./types.js";
import type { ExtractedFile, PendingMemberCall, PendingVia } from "./extract.js";

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

const firstIdent = (n: TsNode): string | null => {
	for (const c of n.namedChildren) if (c.type === "identifier") return c.text;
	return null;
};
const RESERVED_OBJ = new Set(["this", "self", "true", "false", "null", "None", "nil"]);

const lastIdent = (n: TsNode): string | null => {
	let out: string | null = null;
	for (const c of n.namedChildren) if (c.type === "identifier") out = c.text;
	return out;
};

const deepFirstIdent = (n: TsNode): string | null => {
	for (const c of n.namedChildren) {
		if (c.type === "identifier") return c.text;
		const r = deepFirstIdent(c);
		if (r) return r;
	}
	return null;
};
// value_path/attrpath/цепочки: последний ident-сегмент (M.f → f).
const pathIdent = (n: TsNode): string | null => {
	const r = lastIdent(n);
	if (r) return r;
	const parts = n.text.split(".");
	return parts.length ? parts[parts.length - 1] : null;
};

const nameChild = (n: TsNode, types: string[]): string | null => {
	for (const c of n.namedChildren) if (types.includes(c.type)) return c.text;
	return null;
};

/** Квалифицированное имя метода: enclosing class (java/csharp/kotlin). */
const enclosingClassName = (n: TsNode): string | null => {
	for (let p = n.parent; p; p = p.parent) {
		if (p.type === "class_declaration") return nameChild(p, ["identifier", "type_identifier", "simple_identifier", "name"]);
		if (p.type === "object_declaration") return nameChild(p, ["identifier", "type_identifier"]);
		if (p.type === "class") return nameChild(p, ["constant", "identifier"]); // ruby
		if (p.type === "class_definition") return nameChild(p, ["identifier"]); // dart/scala
			if (p.type === "contract_declaration") return nameChild(p, ["identifier"]); // solidity
	}
	return null;
};

interface SymbolRule {
	node: string;
	kind: GraphNode["kind"];
	/** Как получить имя. */
	name: (n: TsNode) => string | null;
	/** Как получить квалифицированное имя (класс.метод) — null → просто имя. */
	qualified?: (n: TsNode) => string | null;
}

interface LangRules {
	symbols: SymbolRule[];
	/** Как из call-ноды получить имя callee (null — не вызов для нас). */
	callee: (fn: TsNode) => string | null;
	/** Тип call-ноды (вместо call_expression). */
	callNode?: string;
	/** Несколько типов call-нод (php: function/member/object). */
	callNodes?: string[];
	/** Базовый identifier в операторной позиции считается вызовом (ruby: `helper`). */
	bareIdentCall?: boolean;
	/** Имя callee — последний именованный ребёнок (ruby: obj.helper). */
	calleeFrom?: "lastIdent";
	/** Тело метода — соседний узел после сигнатуры (dart): ходить с caller=метод. */
	pairedBody?: boolean;
	/** Member-вызов obj.m() → pending (full fidelity: go/java/kotlin/php/swift). */
	memberCall?: (n: TsNode) => { obj: string; method: string } | null;
	/** Подсказки типов локальных переменных: x = new T() / x: T / x := NewT(). */
	varAssigns?: Array<{ node: string; varName: (n: TsNode) => string | null; resolve: (n: TsNode) => { kind: "new" | "type"; name: string } | null }>;
}

const RULES: Record<string, LangRules> = {
	go: {
		symbols: [
			{ node: "function_declaration", kind: "function", name: (n) => n.childForFieldName?.("name")?.text ?? null },
			{
				node: "method_declaration",
				kind: "method",
				name: (n) => n.childForFieldName?.("name")?.text ?? null,
				qualified: (n) => {
					const name = n.childForFieldName?.("name")?.text;
					const recv = n.childForFieldName?.("receiver");
					if (!name || !recv) return null;
					let t: string | null = null;
					const findType = (n: TsNode, depth: number): string | null => {
						if (depth > 3) return null;
						if (n.type === "type_identifier") return n.text; // только тип: identifier — это имя переменной-рецивера
						for (const c of n.namedChildren) {
							const r = findType(c, depth + 1);
							if (r) return r;
						}
						return null;
					};
					t = findType(recv, 0); // в т.ч. ptr receiver *T (pointer_type → type_identifier)
					return t ? `${t}.${name}` : null;
				},
			},
			{ node: "type_declaration", kind: "type", name: (n) => n.childForFieldName?.("name")?.text ?? null },
		],
		callee: (fn) => (fn.type === "identifier" ? fn.text : fn.type === "selector_expression" ? fn.childForFieldName?.("property")?.text ?? null : null),
		memberCall: (n) => {
			if (n.type !== "call_expression") return null;
			const sel = n.namedChildren[0];
			if (!sel || sel.type !== "selector_expression") return null;
			const obj = sel.namedChildren[0];
			const m = sel.namedChildren.find((c) => c.type === "field_identifier");
			if (!obj || obj.type !== "identifier" || !m) return null;
			return { obj: obj.text, method: m.text };
		},
		varAssigns: [
			{
				node: "short_var_declaration",
				varName: (n) => {
					const l = n.namedChildren.find((c) => c.type === "expression_list");
					return l?.namedChildren.find((c) => c.type === "identifier")?.text ?? null;
				},
				resolve: (n) => {
					const lists = n.namedChildren.filter((c) => c.type === "expression_list");
					const r = lists[lists.length - 1];
					if (!r) return null;
					const findComp = (x: TsNode, d = 0): string | null => {
						if (d > 3) return null;
						for (const c of x.namedChildren) {
							if (c.type === "composite_literal") return c.namedChildren.find((y) => y.type === "type_identifier")?.text ?? null;
							const rr = findComp(c, d + 1);
							if (rr) return rr;
						}
						return null;
					};
					const comp = findComp(r);
					if (comp) return { kind: "new", name: comp };
					const ce = r.namedChildren.find((c) => c.type === "call_expression");
					if (ce) {
						const id = ce.namedChildren.find((c) => c.type === "identifier");
						// Go-идиома: NewService() → Service
						if (id && /^New[A-Z]/.test(id.text)) return { kind: "new", name: id.text.slice(3) };
					}
					return null;
				},
			},
		],
	},
	rust: {
		symbols: [
			{ node: "function_item", kind: "function", name: (n) => n.childForFieldName?.("name")?.text ?? null },
			{
				node: "method_item",
				kind: "method",
				name: (n) => n.childForFieldName?.("name")?.text ?? null,
				qualified: (n) => {
					const name = n.childForFieldName?.("name")?.text;
					// impl_item: impl Type for ... — ищем type_path внутри родителя
					const impl = n.parent?.type === "impl_item" ? n.parent : null;
					let t: string | null = null;
					if (impl) {
						for (const c of impl.namedChildren) {
							if (c.type === "type_identifier") {
								t = c.text;
								break;
							}
						}
					}
					return t && name ? `${t}.${name}` : null;
				},
			},
			{ node: "struct_item", kind: "class", name: (n) => n.childForFieldName?.("name")?.text ?? null },
			{ node: "enum_item", kind: "type", name: (n) => n.childForFieldName?.("name")?.text ?? null },
		],
		callee: (fn) => {
			if (fn.type === "identifier") return fn.text;
			if (fn.type === "scoped_identifier" || fn.type === "qualified_path") return lastIdent(fn);
			return null;
		},
	},
	c: {
		symbols: [
			{
				node: "function_definition",
				kind: "function",
				name: (n) => {
					const decl = n.childForFieldName?.("declarator");
					if (!decl) return null;
					return decl.type === "identifier" ? decl.text : firstIdent(decl);
				},
			},
			{ node: "struct_specifier", kind: "type", name: (n) => n.childForFieldName?.("name")?.text ?? null },
			{ node: "enum_specifier", kind: "type", name: (n) => n.childForFieldName?.("name")?.text ?? null },
		],
		callee: (fn) => (fn.type === "identifier" ? fn.text : null),
	},
	cpp: {
		symbols: [
			{
				node: "function_definition",
				kind: "function",
				name: (n) => {
					const decl = n.childForFieldName?.("declarator");
					if (!decl) return null;
					return decl.type === "identifier" ? decl.text : decl.type === "field_identifier" ? decl.text : firstIdent(decl);
				},
			},
			{ node: "class_specifier", kind: "class", name: (n) => n.childForFieldName?.("name")?.text ?? null },
			{ node: "struct_specifier", kind: "class", name: (n) => n.childForFieldName?.("name")?.text ?? null },
		],
		callee: (fn) =>
			fn.type === "identifier" ? fn.text : fn.type === "field_expression" ? fn.childForFieldName?.("property")?.text ?? null : null,
	},
	sh: {
		symbols: [{ node: "function_definition", kind: "function", name: (n) => n.childForFieldName?.("name")?.text ?? firstIdent(n) }],
		callee: (fn) => (fn.type === "identifier" || fn.type === "word" || fn.type === "command_name" ? fn.text : null),
		callNode: "command",
	},
	java: {
		symbols: [
			{ node: "class_declaration", kind: "class", name: (n) => nameChild(n, ["identifier", "type_identifier"]) },
			{
				node: "method_declaration",
				kind: "method",
				name: (n) => nameChild(n, ["identifier"]),
				qualified: (n) => {
					const nm = nameChild(n, ["identifier"]);
					const cls = enclosingClassName(n);
					return cls && nm ? `${cls}.${nm}` : null;
				},
			},
		],
		callee: (fn) => (fn.type === "identifier" ? fn.text : null),
		callNode: "method_invocation",
		memberCall: (n) => {
			if (n.type !== "method_invocation") return null;
			const obj = n.namedChildren[0];
			const meth = n.namedChildren[1];
			if (!obj || obj.type !== "identifier" || !meth || meth.type !== "identifier") return null;
			return { obj: obj.text, method: meth.text };
		},
		varAssigns: [
			{
				node: "local_variable_declaration",
				varName: (n) => {
					const vd = n.namedChildren.find((c) => c.type === "variable_declarator");
					return vd?.namedChildren.find((c) => c.type === "identifier")?.text ?? null;
				},
				resolve: (n) => {
					const vd = n.namedChildren.find((c) => c.type === "variable_declarator");
					const oce = vd?.namedChildren.find((c) => c.type === "object_creation_expression");
					const ctor = oce?.namedChildren.find((c) => c.type === "type_identifier")?.text;
					if (ctor) return { kind: "new", name: ctor };
					const ty = n.namedChildren.find((c) => c.type === "type_identifier")?.text;
					return ty ? { kind: "type", name: ty } : null;
				},
			},
		],
	},
	csharp: {
		symbols: [
			{ node: "class_declaration", kind: "class", name: (n) => nameChild(n, ["identifier", "type_identifier"]) },
			{
				node: "method_declaration",
				kind: "method",
				name: (n) => nameChild(n, ["identifier"]),
				qualified: (n) => {
					const nm = nameChild(n, ["identifier"]);
					const cls = enclosingClassName(n);
					return cls && nm ? `${cls}.${nm}` : null;
				},
			},
		],
		callee: (fn) => (fn.type === "identifier" ? fn.text : null),
		callNode: "invocation_expression",
	},
	dart: {
		symbols: [
			{ node: "class_definition", kind: "class", name: (n) => nameChild(n, ["identifier"]) },
			{
				node: "method_signature",
				kind: "method",
				name: (n) => {
					const sig = n.namedChildren.find((c) => c.type === "function_signature");
					return sig ? nameChild(sig, ["identifier"]) : nameChild(n, ["identifier"]);
				},
				qualified: (n) => {
					const sig = n.namedChildren.find((c) => c.type === "function_signature");
					const nm = sig ? nameChild(sig, ["identifier"]) : nameChild(n, ["identifier"]);
					const cls = enclosingClassName(n);
					return cls && nm ? `${cls}.${nm}` : null;
				},
			},
			{ node: "function_declaration", kind: "function", name: (n) => nameChild(n, ["identifier"]) },
		],
		callee: (fn) => (fn.type === "identifier" ? fn.text : null),
		bareIdentCall: true,
		pairedBody: true,
	},
	scala: {
		symbols: [
			{ node: "class_definition", kind: "class", name: (n) => nameChild(n, ["identifier"]) },
			{
				node: "function_definition",
				kind: "function",
				name: (n) => nameChild(n, ["identifier"]),
				qualified: (n) => {
					const nm = nameChild(n, ["identifier"]);
					const cls = enclosingClassName(n);
					return cls && nm ? `${cls}.${nm}` : null;
				},
			},
		],
		callee: (fn) => (fn.type === "identifier" ? fn.text : null),
		callNode: "call_expression",
	},
	lua: {
		symbols: [
			{
				node: "function_declaration",
				kind: "method",
				name: (n) => {
					const idx = n.namedChildren[0];
					if (!idx) return null;
					const idents = idx.namedChildren.filter((c) => c.type === "identifier");
					return idents.length ? idents[idents.length - 1].text : null;
				},
				qualified: (n) => {
					const idx = n.namedChildren[0];
					if (!idx || idx.namedChildren.filter((c) => c.type === "identifier").length < 2) return null;
					const idents = idx.namedChildren.filter((c) => c.type === "identifier");
					return `${idents[0].text}.${idents[idents.length - 1].text}`;
				},
			},
		],
		callee: (fn) => (fn.type === "identifier" ? fn.text : null),
		callNodes: ["function_call"],
		calleeFrom: "lastIdent",
	},
	ruby: {
		symbols: [
			{ node: "class", kind: "class", name: (n) => nameChild(n, ["constant", "identifier"]) },
			{
				node: "method",
				kind: "method",
				name: (n) => nameChild(n, ["identifier"]),
				qualified: (n) => {
					const nm = nameChild(n, ["identifier"]);
					const cls = enclosingClassName(n);
					return cls && nm ? `${cls}.${nm}` : null;
				},
			},
		],
		callee: (fn) => (fn.type === "identifier" || fn.type === "constant" ? fn.text : null),
		callNode: "call",
		calleeFrom: "lastIdent",
		bareIdentCall: true,
	},
	php: {
		symbols: [
			{ node: "class_declaration", kind: "class", name: (n) => nameChild(n, ["name", "identifier"]) },
			{
				node: "method_declaration",
				kind: "method",
				name: (n) => nameChild(n, ["name", "identifier"]),
				qualified: (n) => {
					const nm = nameChild(n, ["name", "identifier"]);
					const cls = enclosingClassName(n);
					return cls && nm ? `${cls}.${nm}` : null;
				},
			},
			{ node: "function_definition", kind: "function", name: (n) => nameChild(n, ["name", "identifier"]) },
		],
		callee: (fn) => (fn.type === "name" || fn.type === "identifier" ? fn.text : null),
		callNodes: ["function_call_expression", "member_call_expression"],
		memberCall: (n) => {
			if (n.type !== "member_call_expression") return null;
			const vn = n.namedChildren.find((c) => c.type === "variable_name");
			const meth = n.childForFieldName?.("name") ?? n.namedChildren.find((c) => c.type === "name");
			const on = vn?.namedChildren.find((c) => c.type === "name");
			if (!on || !meth) return null;
			return { obj: on.text, method: meth.text };
		},
		varAssigns: [
			{
				node: "assignment_expression",
				varName: (n) => {
					const vn = n.namedChildren.find((c) => c.type === "variable_name");
					return vn?.namedChildren.find((c) => c.type === "name")?.text ?? null;
				},
				resolve: (n) => {
					const oce = n.namedChildren.find((c) => c.type === "object_creation_expression");
					return oce ? { kind: "new", name: oce.namedChildren.find((c) => c.type === "name")?.text ?? "" } : null;
				},
			},
		],
	},
	swift: {
		symbols: [
			{ node: "class_declaration", kind: "class", name: (n) => nameChild(n, ["type_identifier", "identifier", "simple_identifier"]) },
			{
				node: "function_declaration",
				kind: "function",
				name: (n) => nameChild(n, ["simple_identifier", "identifier"]),
				qualified: (n) => {
					const nm = nameChild(n, ["simple_identifier", "identifier"]);
					const cls = enclosingClassName(n);
					return cls && nm ? `${cls}.${nm}` : null;
				},
			},
		],
		callee: (fn) => {
			if (fn.type === "simple_identifier" || fn.type === "identifier") return fn.text;
			if (fn.type === "navigation_expression") {
				// self.m() / obj.m() — имя метода = последний ident в цепочке
				let cur: TsNode | undefined = fn;
				for (let d = 0; cur && d < 3; d++) {
					const nm = cur.namedChildren.find((c) => c.type === "simple_identifier" || c.type === "identifier");
					if (nm) return nm.text;
					cur = cur.namedChildren[0];
				}
				return null;
			}
			return null;
		},
		callNode: "call_expression",
		memberCall: (n) => {
			if (n.type !== "call_expression") return null;
			const nav = n.namedChildren.find((c) => c.type === "navigation_expression");
			if (!nav) return null;
			const base_ = nav.namedChildren[0];
			const suf = nav.namedChildren.find((c) => c.type === "navigation_suffix");
			if (!base_ || base_.type !== "simple_identifier" || !suf) return null;
			const m = suf.text.replace(/^[.!?]+/, "");
			return m ? { obj: base_.text, method: m } : null;
		},
		varAssigns: [
			{
				node: "property_declaration",
				varName: (n) => {
					const p = n.namedChildren.find((c) => c.type === "pattern");
					return p?.namedChildren.find((c) => c.type === "simple_identifier")?.text ?? null;
				},
				resolve: (n) => {
					const ce = n.namedChildren.find((c) => c.type === "call_expression");
					const ctor = ce?.namedChildren.find((c) => c.type === "simple_identifier")?.text;
					if (ctor) return { kind: "new", name: ctor };
					const ut = n.namedChildren.find((c) => c.type === "user_type");
					return ut ? { kind: "type", name: ut.text } : null;
				},
			},
		],
	},

	r: {
		symbols: [
			{
				// add <- function(x, y) { ... } — binary_operator [identifier add, function_definition]
				node: "binary_operator",
				kind: "function",
				name: (n) => {
					const children = n.namedChildren;
					if (children.length < 2) return null;
					const last = children[children.length - 1];
					if (last.type !== "function_definition") return null;
					const first = children[0];
					return first.type === "identifier" ? first.text : null;
				},
			},
		],
		callee: (fn) => {
			const first = fn.namedChildren[0];
			return first && first.type === "identifier" ? first.text : null;
		},
		callNode: "call",
	},
	elixir: {
		symbols: [
			{
				// defmodule Math do ... end → class (name = alias/identifier в arguments)
				node: "call",
				kind: "class",
				name: (n) => {
					const head = n.namedChildren[0];
					if (!head || head.type !== "identifier" || head.text !== "defmodule") return null;
					const args = n.namedChildren[1];
					const first = args?.namedChildren[0];
					return first ? first.text : null;
				},
			},
			{
				// def/defp add(...) — method (квалификация: enclosing defmodule)
				node: "call",
				kind: "method",
				name: (n) => {
					const head = n.namedChildren[0];
					if (!head || head.type !== "identifier" || (head.text !== "def" && head.text !== "defp")) return null;
					const args = n.namedChildren[1];
					const first = args?.namedChildren[0];
					if (!first) return null;
					// add(a, b) → call [identifier add, ...]; run → identifier
					if (first.type === "call") {
						const nm = first.namedChildren.find((c) => c.type === "identifier");
						return nm?.text ?? null;
					}
					return first.type === "identifier" ? first.text : null;
				},
				qualified: (n) => {
					const args = n.namedChildren[1];
					const first = args?.namedChildren[0];
					let nm: string | null = null;
					if (first) {
						if (first.type === "call") nm = first.namedChildren.find((c) => c.type === "identifier")?.text ?? null;
						else if (first.type === "identifier") nm = first.text;
					}
					for (let p = n.parent; p; p = p.parent) {
						if (p.type !== "call") continue;
						const head = p.namedChildren[0];
						if (head?.type === "identifier" && head.text === "defmodule") {
							const mod = p.namedChildren[1]?.namedChildren[0]?.text;
							return mod && nm ? `${mod}.${nm}` : null;
						}
					}
					return null;
				},
			},
		],
		callee: (fn) => {
			if (fn.type === "identifier") {
				const t = fn.text;
				// ключевые слова/макро-построители — не вызовы
				const NON_CALL = new Set(["def", "defp", "defmodule", "do", "end", "if", "case", "fn", "for", "cond", "unless", "with", "try", "catch", "rescue", "quote", "unquote", "use", "import", "require", "alias", "behaviour", "raise", "send", "spawn", "spawn_link", "receive", "after", "else", "when"]);
				return NON_CALL.has(t) ? null : t;
			}
			if (fn.type === "dot") return lastIdent(fn); // Math.add → add
			return null;
		},
		callNode: "call",
	},
	solidity: {
		symbols: [
			{ node: "contract_declaration", kind: "class", name: (n) => nameChild(n, ["identifier"]) },
			{
				node: "function_definition",
				kind: "method",
				name: (n) => nameChild(n, ["identifier"]),
				qualified: (n) => {
					const nm = nameChild(n, ["identifier"]);
					const cls = enclosingClassName(n);
					return cls && nm ? `${cls}.${nm}` : null;
				},
			},
			{ node: "struct_declaration", kind: "type", name: (n) => nameChild(n, ["identifier"]) },
			{ node: "interface_declaration", kind: "type", name: (n) => nameChild(n, ["identifier"]) },
		],
		callee: (fn) => {
			const field = fn.childForFieldName?.("function");
			if (field) return field.text;
			return firstIdent(fn);
		},
		callNode: "call_expression",
	},
	ocaml: {
		symbols: [
			{ node: "value_definition", kind: "function", name: (n) => nameChild(n, ["value_name"]) ?? nameChild(n.namedChildren[0] ?? n, ["value_name"]) },
			{ node: "module_definition", kind: "class", name: (n) => nameChild(n, ["module_name"]) ?? nameChild(n.namedChildren[0] ?? n, ["module_name"]) },
			{ node: "type_definition", kind: "type", name: (n) => nameChild(n, ["type_name"]) ?? nameChild(n.namedChildren[0] ?? n, ["type_name"]) },
		],
		callee: (fn) => {
			if (fn.type === "value_path") return pathIdent(fn);
			const first = fn.namedChildren[0];
			if (!first) return null;
			if (first.type === "value_path") return pathIdent(first); // M.f → f
			if (first.type === "identifier") return first.text;
			return null;
		},
		callNode: "application_expression",
	},
	zig: {
		symbols: [
			{
				node: "function_declaration",
				kind: "function",
				name: (n) => n.childForFieldName?.("name")?.text ?? nameChild(n, ["identifier"]),
			},
			{ node: "struct_declaration", kind: "class", name: (n) => nameChild(n, ["identifier"]) },
			{ node: "union_declaration", kind: "type", name: (n) => nameChild(n, ["identifier"]) },
		],
		callee: (fn) => (fn.type === "identifier" ? fn.text : firstIdent(fn)),
		callNode: "call_expression",
	},
	clojure: {
		symbols: [
			{
				// (defn run [] ...) — list_lit [sym_lit defn, sym_lit run, ...]
				node: "list_lit",
				kind: "function",
				name: (n) => {
					const head = n.namedChildren[0];
					if (!head || head.type !== "sym_lit") return null;
					if (head.text !== "defn" && head.text !== "defn-") return null;
					const second = n.namedChildren[1];
					return second && second.type === "sym_lit" ? second.text : null;
				},
			},
		],
		callee: (fn) => {
			const head = fn.type === "sym_lit" ? fn : fn.namedChildren[0];
			if (!head || head.type !== "sym_lit") return null;
			const t = head.text;
			const SPECIAL = new Set(["defn", "defn-", "def", "def-", "defmacro", "defmulti", "defprotocol", "defrecord", "ns", "in-ns", "let", "letfn", "fn", "loop", "do", "doseq", "dofor", "for", "if", "when", "when-let", "when-some", "cond", "case", "try", "catch", "finally", "throw", "require", "import", "declare", "deftype", "definterface", "defstruct", "redef"]);
			return SPECIAL.has(t) ? null : t;
		},
		callNode: "list_lit",
	},
	nix: {
		symbols: [
			{
				// attrset-биндинг: binding [attrpath [a], expr] (топ-уровень в wasm-грамматике глючит)
				node: "binding",
				kind: "function",
				name: (n) => deepFirstIdent(n),
			},
		],
		callee: (fn) => {
			const first = fn.namedChildren[0];
			if (!first) return null;
			if (first.type === "variable_expression") return firstIdent(first);
			if (first.type === "identifier") return first.text;
			return null;
		},
		callNode: "apply_expression",
	},
	kotlin: {
		symbols: [
			{ node: "class_declaration", kind: "class", name: (n) => nameChild(n, ["type_identifier", "identifier", "simple_identifier"]) },
			{
				node: "function_declaration",
				kind: "function",
				name: (n) => nameChild(n, ["simple_identifier", "identifier"]),
				qualified: (n) => {
					const nm = nameChild(n, ["simple_identifier", "identifier"]);
					const cls = enclosingClassName(n);
					return cls && nm ? `${cls}.${nm}` : null;
				},
			},
		],
		callee: (fn) => (fn.type === "simple_identifier" || fn.type === "identifier" ? fn.text : null),
		callNode: "call_expression",
		memberCall: (n) => {
			if (n.type !== "call_expression") return null;
			const nav = n.namedChildren.find((c) => c.type === "navigation_expression");
			if (!nav) return null;
			const base_ = nav.namedChildren[0];
			const suf = nav.namedChildren.find((c) => c.type === "navigation_suffix");
			if (!base_ || base_.type !== "simple_identifier" || !suf) return null;
			const m = suf.text.replace(/^[.!?]+/, "");
			return m ? { obj: base_.text, method: m } : null;
		},
		varAssigns: [
			{
				node: "property_declaration",
				varName: (n) => {
					const vd = n.namedChildren.find((c) => c.type === "variable_declaration");
					return vd?.namedChildren.find((c) => c.type === "simple_identifier")?.text ?? null;
				},
				resolve: (n) => {
					const ce = n.namedChildren.find((c) => c.type === "call_expression");
					const ctor = ce?.namedChildren.find((c) => c.type === "simple_identifier")?.text;
					if (ctor) return { kind: "new", name: ctor };
					const vd = n.namedChildren.find((c) => c.type === "variable_declaration");
					const ty = vd?.namedChildren.find((c) => c.type === "user_type")?.text;
					return ty ? { kind: "type", name: ty } : null;
				},
			},
		],
	},
};
export async function extractOther(file: RepoFile, tree: Tree, lang: string): Promise<ExtractedFile> {
	const rules = RULES[lang];
	const nodes: GraphNode[] = [];
	const edges: GraphEdge[] = [];
	const callSites: Array<{ callee: string; caller: GraphNode | null }> = [];
	const vars = new Map<string, PendingVia>();
	const pending: PendingMemberCall[] = [];
	const lineCount = file.content.split("\n").length;

	nodes.push({
		id: file.path,
		name: file.path.split("/").pop() ?? file.path,
		kind: "file",
		path: file.path,
		span: { start: 1, end: lineCount },
		signature: null,
		exported: true,
		bodyHash: file.hash,
	});

	const used = new Set<string>();
	const addSymbol = (node: TsNode, name: string, kind: GraphNode["kind"], qualified?: string | null): GraphNode => {
		const nm = qualified ?? name;
		const id = `${file.path}#${nm}`;
		const existing = nodes.find((n) => n.id === id);
		if (existing) return existing;
		used.add(nm);
		const gn: GraphNode = {
			id,
			name: nm,
			kind,
			path: file.path,
			span: { start: node.startPosition.row + 1, end: node.endPosition.row + 1 },
			signature: node.text.split("\n")[0].replace(/\s+/g, " ").slice(0, 160),
			exported: true, // v1: без анализа видимости
			bodyHash: sha1(node.text),
		};
		nodes.push(gn);
		return gn;
	};

	const skipped = new Set<number>();
	const walk = (node: TsNode, caller: GraphNode | null): void => {
		if (skipped.has(node.id)) return;
		let nextCaller = caller;
		for (const rule of rules.symbols) {			if (node.type !== rule.node) continue;
			const name = rule.name(node);			if (!name) continue;
			nextCaller = addSymbol(node, name, rule.kind, rule.qualified?.(node) ?? null);			// dart: function_body — следующий за сигнатурой SIBLING; идём в него с caller=метод
			if (rules.pairedBody && node.type === "method_signature") {
				const sib = node.parent?.namedChildren ?? [];
				const i = sib.findIndex((c) => c.id === node.id); // web-tree-sitter: child-обёртки — новые объекты
				for (let k = i + 1; k < sib.length; k++) {
					if (sib[k].type === "function_body") {
						walk(sib[k], nextCaller);
						skipped.add(sib[k].id);
					} else break;
				}
				}
			break;
		}
		const callTypes = rules.callNodes ?? [rules.callNode ?? "call_expression"];
		if (callTypes.includes(node.type)) {
			let callee: string | null = null;
			if (rules.calleeFrom === "lastIdent") {
				let last: TsNode | null = null;
				for (const c of node.namedChildren) {
					if (c.type === "identifier" || c.type === "constant") last = c;
					else if (c.type === "method_index_expression" || c.type === "dot_index_expression") {
						// lua: self:helper / obj.helper — имя метода внутри index-ноды
						const id = [...c.namedChildren].reverse().find((x) => x.type === "identifier");
						if (id) last = id;
					}
				}
				callee = last?.text ?? null;
			} else {
				// callee — первая "именованная" нода (this/obj могут идти первыми: this.m(), o.m())
				const CALLEE_TYPES = ["identifier", "simple_identifier", "command_name", "word", "type_identifier", "name", "navigation_expression"];
				const fn = rules.callNode || rules.callNodes
					? (node.namedChildren.find((c) => CALLEE_TYPES.includes(c.type)) ?? node.namedChildren[0])
					: (node.childForFieldName?.("function") as TsNode | undefined);
				if (fn) callee = rules.callee(fn);
			}
			if (callee) callSites.push({ callee, caller });
		}
		// B6: member-вызовы obj.m() → pending (резолвится в build.ts по vars/классам)
		if (rules.memberCall) {
			const mc = rules.memberCall(node);
			if (mc && !RESERVED_OBJ.has(mc.obj)) {
				const text = node.text;
				const idx = text.indexOf(mc.method);
				const lineStart = text.lastIndexOf("\n", idx) + 1;
				const linesBefore = text.slice(0, idx).split("\n").length - 1;
				pending.push({ caller, method: mc.method, via: { kind: "ident", name: mc.obj }, line: node.startPosition.row + linesBefore, col: idx - lineStart });
			}
		}
		// B6: тип-подсказки локальных переменных
		if (rules.varAssigns) {
			for (const va of rules.varAssigns) {
				if (node.type !== va.node) continue;
				const vn = va.varName(node);
				const res = va.resolve(node);
				if (vn && res) vars.set(vn, res);
			}
		}
		// ruby: `helper` / dart: `helper();` — identifier в операторной позиции — вызов
		const BARE_PARENTS = new Set(["body_statement", "expression_statement"]);
		if (rules.bareIdentCall && node.type === "identifier" && node.parent && BARE_PARENTS.has(node.parent.type)) {			const callee = rules.callee(node);
			if (callee) callSites.push({ callee, caller });
		}
		for (const c of node.namedChildren) walk(c, nextCaller);
	};
	walk(tree.rootNode, null);

	const byName = new Map<string, GraphNode>();
	for (const n of nodes) if (n.kind !== "file" && !byName.has(n.name)) byName.set(n.name, n);
	// Квалификация: "T.m" → по методу m (для Go selector-вызовов).
	// Базовое имя (helper) → qualified-метод того же файла (T.helper), если plain-имени нет.
	const qualifiedByShort = new Map<string, GraphNode>();
	for (const n of nodes) {
		if (n.kind === "file" || !n.name.includes(".")) continue;
		const short = n.name.slice(n.name.lastIndexOf(".") + 1);
		if (!qualifiedByShort.has(short)) qualifiedByShort.set(short, n);
	}
	for (const cs of callSites) {
		const t = byName.get(cs.callee) ?? qualifiedByShort.get(cs.callee);
		if (!t) continue;
		const source = cs.caller ? cs.caller.id : file.path;
		if (source === t.id) continue;
		if (edges.some((e) => e.source === source && e.target === t.id && e.relation === "calls")) continue;
		edges.push({ source, target: t.id, relation: "calls", confidence: "extracted" });
	}

	return {
		file,
		nodes,
		edges,
		imports: [],
		exports: new Map([...byName.entries()].filter(([, n]) => n.kind !== "file")),
		vars,
		fnReturns: new Map<string, string>(), // у rule-языков явных return-типов нет
		pending,
	};
}
