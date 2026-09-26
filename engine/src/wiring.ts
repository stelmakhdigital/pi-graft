/**
 * Graft wiring для не-pi агентов (E12): секция AGENTS.md (marker-fenced) + .mcp.json.
 * Idempotent: повторный init обновляет только свои блоки, остальное не трогает.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const BEGIN = "<!-- graft:begin -->";
const END = "<!-- graft:end -->";

/** Путь к MCP-серверу движка (абсолютный, из расположения этого модуля). */
export function mcpServerPath(): string {
	return fileURLToPath(new URL("../bin/graft-mcp.mjs", import.meta.url));
}

function section(root: string): string {
	const bin = fileURLToPath(new URL("../bin/graft.mjs", import.meta.url));
	return `${BEGIN}
## Graft code graph (локальный граф кода)

В репо построен граф graft/ (pi-graft-engine). Используй его ПЕРЕД grep/чтением файлов:
- Ориентация: node ${bin} map (или MCP graft_map) — кластеры каталогов, хабы, hotspots.
- Вопрос о коде: node ${bin} ask "<вопрос>" (MCP graft_ask) — ранжированные ноды с file:line.
- Все вхождения: node ${bin} grep "<regex>"; сигнатуры файла — skeleton <file>;
  кто зависит — callers <symbol>; blast git-диффа — blast [base]; свежесть — check.
- Граф авто-пересобирается при каждом запросе (fingerprint дрейфа, $0); вручную — build
  (+ build --deep с конфигом LLM: graft config show / graft config set). MCP-сервер: node ${mcpServerPath()} (stdio).
${END}`;
}

export interface WiringReport {
	files: Array<{ path: string; action: "added" | "updated" | "unchanged" | "removed" | "skipped" }>;
}

/** Записать/обновить graft-секцию в AGENTS.md + mcpServers.graft в .mcp.json. */
export function initWiring(root: string, opts: { dryRun?: boolean; mcp?: boolean } = {}): WiringReport {
	const report: WiringReport = { files: [] };
	const sec = section(root);
	// AGENTS.md
	const agentsPath = join(root, "AGENTS.md");
	let agents = "";
	let agentsAction: WiringReport["files"][number]["action"] = "added";
	if (existsSync(agentsPath)) {
		agents = readFileSync(agentsPath, "utf8");
		const b = agents.indexOf(BEGIN);
		const e = agents.indexOf(END);
		if (b >= 0 && e > b) {
			const current = agents.slice(b, e + END.length);
			if (current === sec) {
				agentsAction = "unchanged";
			} else {
				agents = agents.slice(0, b) + sec + agents.slice(e + END.length);
				agentsAction = "updated";
			}
		} else {
			agents = agents.replace(/\n*$/, "\n") + "\n" + sec + "\n";
			agentsAction = "added";
		}
	} else {
		agents = sec + "\n";
		agentsAction = "added";
	}
	report.files.push({ path: "AGENTS.md", action: agentsAction });
	if (!opts.dryRun && agentsAction !== "unchanged") writeFileSync(agentsPath, agents, "utf8");
	// .mcp.json
	if (opts.mcp !== false) {
		const mcpPath = join(root, ".mcp.json");
		let mcp: Record<string, unknown> = {};
		if (existsSync(mcpPath)) {
			try {
				mcp = JSON.parse(readFileSync(mcpPath, "utf8")) as Record<string, unknown>;
			} catch {
				mcp = {};
			}
		}
		const servers = (mcp.mcpServers ?? {}) as Record<string, unknown>;
		const entry = {
			command: "node",
			args: [mcpServerPath()],
			env: { GRFT_MCP_ROOT: root },
		};
		const serverAction: WiringReport["files"][number]["action"] = JSON.stringify(servers.graft) === JSON.stringify(entry) ? "unchanged" : servers.graft ? "updated" : "added";
		servers.graft = entry;
		mcp.mcpServers = servers;
		report.files.push({ path: ".mcp.json", action: serverAction });
		if (!opts.dryRun && serverAction !== "unchanged") writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + "\n", "utf8");
	}
	return report;
}

/** Убрать graft-секцию из AGENTS.md и mcpServers.graft из .mcp.json (graft/ не трогает). */
export function uninstallWiring(root: string, opts: { dryRun?: boolean } = {}): WiringReport {
	const report: WiringReport = { files: [] };
	const agentsPath = join(root, "AGENTS.md");
	if (existsSync(agentsPath)) {
		const agents = readFileSync(agentsPath, "utf8");
		const b = agents.indexOf(BEGIN);
		const e = agents.indexOf(END);
		if (b >= 0 && e > b) {
			const cleaned = (agents.slice(0, b).replace(/\n+$/, "") + agents.slice(e + END.length)).replace(/\n{3,}/g, "\n\n");
			report.files.push({ path: "AGENTS.md", action: "removed" });
			if (!opts.dryRun) writeFileSync(agentsPath, cleaned.endsWith("\n") ? cleaned : cleaned + "\n", "utf8");
		} else {
			report.files.push({ path: "AGENTS.md", action: "skipped" });
		}
	} else {
		report.files.push({ path: "AGENTS.md", action: "skipped" });
	}
	const mcpPath = join(root, ".mcp.json");
	if (existsSync(mcpPath)) {
		try {
			const mcp = JSON.parse(readFileSync(mcpPath, "utf8")) as Record<string, unknown>;
			const servers = (mcp.mcpServers ?? {}) as Record<string, unknown>;
			if (servers.graft) {
				delete servers.graft;
				if (Object.keys(servers).length === 0) delete mcp.mcpServers;
				report.files.push({ path: ".mcp.json", action: "removed" });
				if (!opts.dryRun) writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + "\n", "utf8");
			} else {
				report.files.push({ path: ".mcp.json", action: "skipped" });
			}
		} catch {
			report.files.push({ path: ".mcp.json", action: "skipped" });
		}
	}
	return report;
}
