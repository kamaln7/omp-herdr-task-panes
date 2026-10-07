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

const [file = process.env.HTP_FILE, label = process.env.HTP_LABEL ?? "subagent"] = process.argv.slice(2);
if (!file) {
	console.error("usage: view.ts <session.jsonl> [label]  (or HTP_FILE / HTP_LABEL env)");
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
		if (json.type === "title" || json.type === "session") header.push(raw);
		else pending.push({ raw, json });
	}
	return true;
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
	const need = rows() - 2;
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
	for (let i = blocks.length - 1; i >= 0 && body.length < height - 2; i--) {
		const b = blocks[i];
		if (b.width !== width || !b.lines) break;
		body.unshift(...b.lines);
	}
	const shown = body.slice(-(height - 2));
	const title = `\x1b[1m● ${label}\x1b[0m`;
	const status = openCalls.length
		? `\x1b[2m⏳ ${openCalls.join(", ")} running…\x1b[0m`
		: header.length
			? ""
			: "\x1b[2mwaiting for session…\x1b[0m";
	let frame = `\x1b[1;1H${title}\x1b[K`;
	for (let r = 0; r < height - 2; r++) frame += `\x1b[${r + 2};1H${shown[r] ?? ""}\x1b[0m\x1b[K`;
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
			readNew();
			closeBlock();
			await fillViewport();
			paint();
		} while (again);
	} finally {
		busy = false;
	}
}

out.write(`\x1b]2;${label}\x07`);
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
