/** Визуализация: самодостаточный graft/viz.html (SVG, без внешних зависимостей). */
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { readDeep, readGraph } from "./store.js";
import type { Graph } from "./types.js";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function writeViz(root: string, g: Graph, outPath?: string): string {
	const deep = readDeep(root);
	const files = g.meta.files;
	const fileIds = new Set(files.map((f) => f.path));

	// Степени по file-file рёбрам.
	const degree = new Map<string, number>();
	const edgePairs: Array<{ s: string; t: string; rel: string }> = [];
	for (const e of g.edges) {
		const s = fileIds.has(e.source) ? e.source : e.source.split("#")[0];
		const t = fileIds.has(e.target) ? e.target : e.target.split("#")[0];
		if (s === t || !fileIds.has(s) || !fileIds.has(t)) continue;
		degree.set(s, (degree.get(s) ?? 0) + 1);
		degree.set(t, (degree.get(t) ?? 0) + 1);
		edgePairs.push({ s, t, rel: e.relation });
	}

	// Layout: каталоги — секторы круга, файлы — дуга внутри сектора.
	const byDir = new Map<string, string[]>();
	for (const f of files) {
		const dir = f.path.includes("/") ? f.path.split("/").slice(0, -1).join("/") : "(root)";
		byDir.set(dir, [...(byDir.get(dir) ?? []), f.path]);
	}
	const dirs = [...byDir.entries()].sort((a, b) => b[1].length - a[1].length);
	const cx = 500;
	const cy = 420;
	const R = 360;
	const pos = new Map<string, { x: number; y: number }>();
	let angle = -Math.PI / 2;
	for (const [dir, fs] of dirs) {
		const span = (fs.length / files.length) * Math.PI * 2;
		const dirMid = angle + span / 2;
		const dirR = R + 40;
		pos.set(`dir:${dir}`, { x: cx + dirR * Math.cos(dirMid), y: cy + dirR * Math.sin(dirMid) });
		fs.forEach((p, i) => {
			const a = angle + (span * (i + 0.5)) / fs.length;
			pos.set(p, { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) });
		});
		angle += span;
	}

	const maxDeg = Math.max(1, ...degree.values());
	const nodesSvg = files
		.map((f) => {
			const p = pos.get(f.path)!;
			const r = 5 + 9 * ((degree.get(f.path) ?? 0) / maxDeg);
			const sum = deep.files[f.path]?.summary ?? "";
			return `<circle class="node" data-id="${esc(f.path)}" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r.toFixed(1)}"><title>${esc(f.path)}\n${esc(sum)}</title></circle>`;
		})
		.join("\n");
	const edgesSvg = edgePairs
		.map((e) => {
			const a = pos.get(e.s)!;
			const b = pos.get(e.t)!;
			const cls = e.rel === "imports" ? "imp" : "call";
			return `<line class="edge ${cls}" data-s="${esc(e.s)}" data-t="${esc(e.t)}" x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}"/>`;
		})
		.join("\n");
	const dirLabels = dirs
		.map(([d]) => {
			const p = pos.get(`dir:${d}`)!;
			return `<text class="dir" x="${p.x.toFixed(1)}" y="${p.y.toFixed(1)}">${esc(d)}</text>`;
		})
		.join("\n");
	const filesShown = (files: string[]) => `${files.slice(0, 10).join(", ")}${files.length > 10 ? ", …" : ""}`;
	const topics = deep.concepts?.topics;
	const topicsHtml = topics?.length
		? `<div class="topics"><h2>Темы (deep)</h2>` + topics.map((t) => `<div class="topic"><b>${esc(t.name)}</b> — ${esc(t.summary)}<span class="files">${esc(filesShown(t.files))}</span></div>`).join("") + "</div>"
		: "";

	const html = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>graft viz — ${esc(root.split("/").pop() ?? root)}</title>
<style>
	body { font-family: ui-monospace, monospace; margin: 0; display: flex; background: #10141a; color: #d7e0ea; }
	svg { flex: 0 0 auto; }
	.edge { stroke: #3a4757; stroke-width: 1; opacity: .55; }
	.edge.call { stroke: #5b8def; }
	.edge.dim { opacity: .08; }
	.node { fill: #37d67a; cursor: pointer; }
	.node.hl { fill: #ffd257; }
	.dir { fill: #7f8ea3; font-size: 13px; }
	.panel { flex: 1; padding: 16px; overflow: auto; border-left: 1px solid #232c38; min-width: 340px; max-height: 840px; }
	.panel h1 { font-size: 15px; }
	#sel { font-size: 13px; white-space: pre-wrap; color: #9fb2c8; }
	#sel .path { color: #ffd257; }
	#sel .sum { color: #d7e0ea; margin-top: 8px; }
	.topics { margin-top: 18px; font-size: 13px; }
	.topic { margin: 6px 0; }
	.files { display: block; color: #6d7f96; font-size: 11px; }
</style>
</head>
<body>
<svg width="1000" height="840">${edgesSvg}\n${nodesSvg}\n${dirLabels}</svg>
<div class="panel">
	<h1>graft viz — ${esc(root)} (${files.length} файлов, ${edgePairs.length} file-рёбер)</h1>
	<div class="legend">зелёный = файл (размер = связность); <span style="color:#5b8def">синие рёбра</span> — calls, серые — imports. Клик по файлу — подсветка соседей.</div>
	<div id="sel">Кликни файл, чтобы увидеть summary (deep) и соседи.</div>
	${topicsHtml}
</div>
<script>
const DATA = ${JSON.stringify(
		Object.fromEntries(
			files.map((f) => [
				f.path,
				{
					sum: deep.files[f.path]?.summary ?? "",
					neighbors: [...new Set(edgePairs.filter((e) => e.s === f.path || e.t === f.path).map((e) => (e.s === f.path ? e.t : e.s)))],
				},
			]),
		),
	)};
const nodes = [...document.querySelectorAll(".node")];
const edges = [...document.querySelectorAll(".edge")];
let active = null;
nodes.forEach((n) =>
	n.addEventListener("click", () => {
		const id = n.dataset.id;
		active = active === id ? null : id;
		nodes.forEach((x) => x.classList.toggle("hl", x.dataset.id === active));
		edges.forEach((e) => e.classList.toggle("dim", active ? e.dataset.s !== active && e.dataset.t !== active : false));
		document.getElementById("sel").innerHTML = active
			? '<span class="path">' + active + "</span><div class='sum'>" + (DATA[active].sum || "(нет deep-summaries — /graft build deep)") + "</div><div>Соседи: " + DATA[active].neighbors.join(", ") + "</div>"
			: "Кликни файл, чтобы увидеть summary (deep) и соседи.";
	}),
);
</script>
</body>
</html>`;

	const out = outPath ?? join(root, "graft", "viz.html");
	writeFileSync(out, html, "utf8");
	return out;
}

const RELOAD_SCRIPT = `<script>
// live-reload: каждые 5с спрашиваем /api/graph; если граф изменился — перезагрузка.
(function () {
	var h = "";
	setInterval(async function () {
		try {
			var r = await fetch("/api/graph", { cache: "no-store" });
			var t = await r.text();
			var s = t.length + ":" + t.slice(0, 300) + ":" + t.slice(-300);
			if (h && h !== s) location.reload();
			h = s;
		} catch (e) { /* сервер занят — молча */ }
	}, 5000);
})();
</script>`;

/** HTTP-сервер viz: / (viz.html + live-reload), /api/graph (текущий graph.json). */
export function serveViz(root: string, port: number): string {
	const server = createServer((req, res) => {
		try {
			if (req.url === "/api/graph") {
				const g = readGraph(root);
				res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
				res.end(JSON.stringify(g));
				return;
			}
			if (req.url === "/" || req.url === "/index.html") {
				const path = writeViz(root, readGraph(root));
				const html = readFileSync(path, "utf8").replace("</body>", RELOAD_SCRIPT + "\n</body>");
				res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
				res.end(html);
				return;
			}
			res.writeHead(404, { "content-type": "text/plain" });
			res.end("not found ( / , /api/graph )");
		} catch (e) {
			res.writeHead(500, { "content-type": "text/plain" });
			res.end(String(e));
		}
	});
	server.listen(port);
	return "http://127.0.0.1:" + port;
}
