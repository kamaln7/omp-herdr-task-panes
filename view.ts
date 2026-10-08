// Fullscreen live view of an omp subagent session JSONL, drawn by omp's own transcript renderer.
// Usage: bun view.ts <session.jsonl> [label]
//
// The session is split into blocks: each block is a run of entries rendered by one `omp render`
// call against a temp session (real header + only those entries, first one re-rooted). A block
// is only closed when every tool call in it has its result, because omp elides calls without
// results and drops results without calls; pending calls show on the status row instead.
//
// Rendered lines are cached per block at the width they were rendered for. Painting shows the
// tail that fits the pane; on resize only the blocks needed to fill the screen are re-rendered,
// merged into one `omp render` call. Frames are painted in one synchronized write.
import { fstatSync, mkdtempSync, openSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

// `--mock <state>` paints the chrome with canned metadata and no transcript, for previewing.
const MOCKS = ["waiting", "thinking", "running", "action", "done"] as const;
const mock = process.argv[2] === "--mock" ? (process.argv[3] ?? "") : undefined;
if (mock !== undefined && !(MOCKS as readonly string[]).includes(mock)) {
	console.error(`usage: view.ts --mock <${MOCKS.join("|")}>`);
	process.exit(2);
}
const [file = process.env.HTP_FILE, label = process.env.HTP_LABEL ?? "subagent"] =
	mock === undefined ? process.argv.slice(2) : ["", `mock ${mock}`];
if (!file && mock === undefined) {
	console.error("usage: view.ts <session.jsonl> [label]  (or HTP_FILE / HTP_LABEL env)\n       view.ts --mock <state>");
	process.exit(2);
}

type Obj = Record<string, unknown>;
type Entry = { raw: string; json: Obj };
type Block = { entries: Entry[]; lines?: string[]; width: number };
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null;

const out = process.stdout;
const scratch = mkdtempSync(path.join(tmpdir(), "herdr-task-pane-"));
const deltaFile = path.join(scratch, "delta.jsonl");

// Clear screen + scrollback (wipes the echoed launch command), hide cursor, no autowrap.
// No alternate screen and no synchronized-update markers: herdr already composites each pane,
// and both make its renderer fall back to full-surface repaints that flicker every pane.
out.write("\x1b[H\x1b[2J\x1b[3J\x1b[?25l\x1b[?7l");
process.on("exit", () => {
	out.write("\x1b[?7h\x1b[?25h");
	rmSync(scratch, { recursive: true, force: true });
});
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => process.exit(0));

let header: string[] = []; // `title` + `session` lines; required by `omp render`
let blocks: Block[] = []; // rendered history, oldest first
let pending: Entry[] = []; // read, not yet in a block
let openCalls: string[] = []; // tool names awaiting results
// Live run metadata, derived from session entries.
let model = ""; // provider prefix stripped
let effort = "";
let startedAt = 0; // session header timestamp (ms)
let endedAt = 0; // set when the last message is a final assistant answer
let todo: { done: number; total: number } | undefined;

let fd: number | undefined;
let ino = 0;
let offset = 0;
let partial = "";
let decoder = new StringDecoder("utf8");

const cols = () => out.columns || 100;
const rows = () => out.rows || 30;

function resetFile(): void {
	header = [];
	blocks = [];
	pending = [];
	openCalls = [];
	model = effort = "";
	startedAt = endedAt = 0;
	todo = undefined;
	offset = 0;
	partial = "";
	decoder = new StringDecoder("utf8");
}

// Read appended entries; reopen and start over if the path now names a different file.
function readNew(): boolean {
	let pathIno: number;
	try {
		pathIno = statSync(file).ino;
	} catch (err) {
		if (isObj(err) && err.code === "ENOENT") return false; // not created yet
		throw err;
	}
	if (fd === undefined || pathIno !== ino || fstatSync(fd).size < offset) {
		fd = openSync(file, "r");
		ino = pathIno;
		resetFile();
	}
	const buf = Buffer.allocUnsafe(1 << 16);
	let grew = false;
	for (;;) {
		const n = readSync(fd, buf, 0, buf.length, offset);
		if (n <= 0) break;
		offset += n;
		partial += decoder.write(buf.subarray(0, n));
		grew = true;
	}
	if (!grew) return false;
	const lines = partial.split("\n");
	partial = lines.pop() ?? "";
	for (const raw of lines) {
		if (!raw.trim()) continue;
		let json: unknown;
		try {
			json = JSON.parse(raw);
		} catch {
			continue; // not a complete entry
		}
		if (!isObj(json)) continue;
		track(json);
		if (json.type === "title" || json.type === "session") header.push(raw);
		else pending.push({ raw, json });
	}
	return true;
}

function track(json: Obj): void {
	const ts = typeof json.timestamp === "string" ? Date.parse(json.timestamp) : NaN;
	if (json.type === "session" && !Number.isNaN(ts)) startedAt = ts;
	else if (json.type === "model_change" && typeof json.model === "string") model = json.model.replace(/^[^/]*\//, "");
	else if (json.type === "thinking_level_change" && typeof json.thinkingLevel === "string") effort = json.thinkingLevel;
	if (json.type !== "message" || !isObj(json.message)) return;
	const m = json.message;
	if (m.role === "toolResult" && m.toolName === "yield") return; // keep the yield call's end time
	// A final answer, or a call to `yield` (how subagents hand back results), ends the run.
	const calls = Array.isArray(m.content) ? m.content.filter(b => isObj(b) && b.type === "toolCall") : [];
	const final = m.role === "assistant" && calls.every(b => isObj(b) && b.name === "yield");
	endedAt = final && !Number.isNaN(ts) ? ts : 0;
	// Progress comes from the subagent's own todo list, when it keeps one.
	if (m.role === "toolResult" && m.toolName === "todo" && isObj(m.details) && Array.isArray(m.details.phases)) {
		const tasks = m.details.phases.flatMap(p => (isObj(p) && Array.isArray(p.tasks) ? p.tasks : []));
		const total = tasks.filter(t => isObj(t) && t.status !== "abandoned").length;
		todo = total ? { done: tasks.filter(t => isObj(t) && t.status === "completed").length, total } : undefined;
	}
}

// 45s, 5m20s, 1h05m.
function duration(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(s / 3600)}h${String(Math.floor(s / 60) % 60).padStart(2, "0")}m`;
}

// Best effort from completed entries only: the JSONL carries no streaming state.
function statusText(): string {
	if (!header.length) return "\x1b[2mwaiting for session…\x1b[0m";
	if (endedAt) return "\x1b[32m✓ done\x1b[0m";
	if (openCalls.includes("ask")) return "\x1b[1;33m⚠ action required\x1b[0m";
	if (openCalls.length) return `\x1b[36m⏳ running ${openCalls.join(", ")}\x1b[0m`;
	return "\x1b[35m… thinking\x1b[0m";
}

// Move the longest pending prefix with no unanswered tool calls into a new (unrendered) block.
function closeBlock(): void {
	const open = new Map<string, string>();
	let cut = 0;
	pending.forEach(({ json }, i) => {
		const m = json.message;
		if (json.type === "message" && isObj(m)) {
			if (m.role === "assistant" && Array.isArray(m.content)) {
				for (const b of m.content) {
					if (isObj(b) && b.type === "toolCall" && typeof b.id === "string") open.set(b.id, String(b.name ?? "tool"));
				}
			} else if (m.role === "toolResult" && typeof m.toolCallId === "string") {
				open.delete(m.toolCallId);
			}
		}
		if (open.size === 0) cut = i + 1;
	});
	openCalls = [...open.values()];
	if (cut === 0) return;
	blocks.push({ entries: pending.slice(0, cut), width: 0 });
	pending = pending.slice(cut);
}

async function renderEntries(entries: Entry[], width: number): Promise<string[]> {
	const first = { ...entries[0].json, parentId: null };
	const body = [JSON.stringify(first), ...entries.slice(1).map(e => e.raw)];
	writeFileSync(deltaFile, `${[...header, ...body].join("\n")}\n`);
	const proc = Bun.spawn(["omp", "render", deltaFile, "-w", String(width)], { stdout: "pipe", stderr: "pipe" });
	const [text, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) return [`\x1b[31momp render failed (${code}): ${err.trim().split("\n")[0] ?? ""}\x1b[0m`];
	const lines = text.split("\n");
	while (lines.length && !lines.at(-1)!.trim()) lines.pop();
	return lines;
}

// Re-render (at the current width) the trailing blocks needed to fill the body, merging each
// stale run into one block so it costs one `omp render` call.
async function fillViewport(): Promise<void> {
	if (!header.length) return;
	const width = cols();
	const need = rows() - 1;
	let have = 0;
	let i = blocks.length - 1;
	while (i >= 0 && have < need) {
		if (blocks[i].width === width && blocks[i].lines) {
			have += blocks[i].lines!.length;
			i--;
			continue;
		}
		// Collect a stale run ending at i, estimating its size from the old render.
		let j = i;
		let estimate = 0;
		while (j >= 0 && blocks[j].width !== width && have + estimate < need) {
			estimate += blocks[j].lines?.length ?? 1;
			j--;
		}
		const run = blocks.slice(j + 1, i + 1);
		const merged: Block = { entries: run.flatMap(b => b.entries), width };
		merged.lines = await renderEntries(merged.entries, width);
		if (width !== cols()) return; // resized mid-render; a new pass is queued
		blocks.splice(j + 1, run.length, merged);
		i = j + 1; // re-examine the merged block (now fresh)
	}
}

let lastFrame = "";
function paint(): void {
	const width = cols();
	const height = rows();
	const body: string[] = [];
	for (let i = blocks.length - 1; i >= 0 && body.length < height - 1; i--) {
		const b = blocks[i];
		if (b.width !== width || !b.lines) break;
		body.unshift(...b.lines);
	}
	const shown = body.slice(-(height - 1));
	// herdr already draws the pane title in the border; model/effort go there as a prefix.
	const meta = [model, effort].filter(Boolean).join(" · ");
	const title = meta ? `[${meta}] ${label}` : label;
	if (title !== lastTitle) {
		out.write(`\x1b]2;${title}\x07`);
		lastTitle = title;
	}
	const parts = [statusText()];
	if (startedAt) parts.push(`\x1b[2m${duration((endedAt || Date.now()) - startedAt)}\x1b[0m`);
	if (todo) parts.push(`\x1b[2m${todo.done}/${todo.total} tasks\x1b[0m`);
	const status = parts.join("  ");
	let frame = "";
	for (let r = 0; r < height - 1; r++) frame += `\x1b[${r + 1};1H${shown[r] ?? ""}\x1b[0m\x1b[K`;
	frame += `\x1b[${height};1H${status}\x1b[K`;
	if (frame === lastFrame) return;
	out.write(frame);
	lastFrame = frame;
}

// Single-flight update loop: any trigger while busy reruns once afterwards.
let busy = false;
let again = false;
async function update(): Promise<void> {
	if (busy) {
		again = true;
		return;
	}
	busy = true;
	try {
		do {
			again = false;
			if (mock === undefined) {
				readNew();
				closeBlock();
				await fillViewport();
			}
			paint();
		} while (again);
	} finally {
		busy = false;
	}
}

if (mock && mock !== "waiting") {
	header = ["mock"];
	model = "claude-opus-5-5";
	effort = "high";
	startedAt = Date.now() - 320_000;
	todo = { done: 3, total: 7 };
	if (mock === "running") openCalls = ["read", "grep"];
	if (mock === "action") openCalls = ["ask"];
	if (mock === "done") endedAt = Date.now();
}
let lastTitle = "";
let resizeTimer: Timer | undefined;
out.on("resize", () => {
	clearTimeout(resizeTimer);
	resizeTimer = setTimeout(() => {
		lastFrame = "";
		void update();
	}, 80);
});
void update();
setInterval(() => void update(), 250);
