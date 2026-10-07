// Mirrors each omp subagent run into a herdr split pane (read-only live transcript).
// Active only inside herdr (HERDR_ENV=1). Disable with OMP_HERDR_TASK_PANES=0.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import net from "node:net";
import path from "node:path";

const VIEWER = path.join(import.meta.dir, "view.ts");
const parentPane = process.env.HERDR_PANE_ID;
const tabId = process.env.HERDR_TAB_ID;
const socketPath = process.env.HERDR_SOCKET_PATH;
const enabled =
	process.env.HERDR_ENV === "1" &&
	!!parentPane &&
	!!tabId &&
	!!socketPath &&
	process.env.OMP_HERDR_TASK_PANES !== "0";

const CLI_TIMEOUT_MS = 5000;
const SOCKET_TIMEOUT_MS = 2000;

// One slot per live subagent run, keyed by session file. Reserved synchronously on start and
// released synchronously on end, so event order alone decides ownership; the pane id is
// filled in later by the serialized open. Process-wide so sibling subagents share one area.
type Slot = { paneId?: string };
const slots = new Map<string, Slot>();
const ourPanes = () => new Set([...slots.values()].flatMap(s => (s.paneId ? [s.paneId] : [])));

async function herdr(...args: string[]): Promise<unknown> {
	const proc = Bun.spawn(["herdr", ...args], { stdout: "pipe", stderr: "pipe" });
	const timer = setTimeout(() => proc.kill(), CLI_TIMEOUT_MS);
	try {
		const [out, err, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		if (proc.signalCode) throw new Error(`herdr ${args[0]} ${args[1]}: timed out`);
		if (code !== 0) throw new Error(`herdr ${args[0]} ${args[1]}: ${err.trim() || `exit ${code}`}`);
		return out.trim() ? JSON.parse(out) : undefined;
	} finally {
		clearTimeout(timer);
	}
}

// Socket API for layout.* methods the CLI does not expose. One request per connection.
// Every path settles the promise: reply, parse failure, error, peer close, or timeout.
function api(method: string, params: Record<string, unknown>): Promise<unknown> {
	const { promise, resolve, reject } = Promise.withResolvers<unknown>();
	const sock = net.createConnection(socketPath!);
	let buf = "";
	sock.setTimeout(SOCKET_TIMEOUT_MS, () => {
		sock.destroy();
		reject(new Error(`herdr ${method}: timeout`));
	});
	sock.on("error", reject);
	sock.on("close", () => reject(new Error(`herdr ${method}: connection closed without reply`)));
	sock.on("data", chunk => {
		buf += chunk;
		const nl = buf.indexOf("\n");
		if (nl < 0) return;
		sock.end();
		try {
			const res = JSON.parse(buf.slice(0, nl)) as { result?: unknown; error?: { message: string } }; // herdr socket contract
			if (res.error) reject(new Error(`herdr ${method}: ${res.error.message}`));
			else resolve(res.result);
		} catch (err) {
			reject(err);
		}
	});
	sock.write(`${JSON.stringify({ id: "herdr-task-panes", method, params })}\n`);
	return promise;
}

type Dir = "right" | "down";
type Node =
	| { type: "pane"; pane_id: string }
	| { type: "split"; direction: Dir; ratio: number; first: Node; second: Node };
type Path = boolean[]; // false = first child, true = second (herdr layout path)
type Rect = { width: number; height: number };

async function exportRoot(): Promise<Node> {
	const res = (await api("layout.export", { tab_id: tabId })) as { layout: { root: Node } }; // herdr socket contract
	return res.layout.root;
}

function findPane(node: Node, paneId: string, at: Path = []): Path | undefined {
	if (node.type === "pane") return node.pane_id === paneId ? at : undefined;
	return findPane(node.first, paneId, [...at, false]) ?? findPane(node.second, paneId, [...at, true]);
}

function nodeAt(node: Node, at: Path): Node {
	for (const second of at) {
		if (node.type !== "split") break;
		node = second ? node.second : node.first;
	}
	return node;
}

function leaves(node: Node): string[] {
	return node.type === "pane" ? [node.pane_id] : [...leaves(node.first), ...leaves(node.second)];
}

// Panes a subtree spans along an axis: summed across same-axis splits, max across others.
function span(node: Node, dir: Dir): number {
	if (node.type === "pane") return 1;
	const a = span(node.first, dir);
	const b = span(node.second, dir);
	return node.direction === dir ? a + b : Math.max(a, b);
}

// The agent area is the parent pane's sibling subtree, but only when every pane in it is one
// of ours; otherwise (no agents yet, or the user's own panes sit there) there is none.
function agentArea(root: Node): { node: Node; at: Path } | undefined {
	const parentPath = findPane(root, parentPane!);
	if (!parentPath?.length) return undefined;
	const at = [...parentPath.slice(0, -1), !parentPath.at(-1)];
	const node = nodeAt(root, at);
	const ours = ourPanes();
	return leaves(node).every(id => ours.has(id)) ? { node, at } : undefined;
}

async function paneRects(): Promise<Map<string, Rect>> {
	const res = (await herdr("pane", "layout", "--pane", parentPane!)) as {
		result: { layout: { panes: { pane_id: string; rect: Rect }[] } };
	}; // herdr CLI JSON contract
	return new Map(res.result.layout.panes.map(p => [p.pane_id, p.rect]));
}

// Parent stays left; agents tile the right. Only leaf splits are possible without moving panes:
// - no agent area: split the parent right;
// - one agent pane: stack the new one below it;
// - two rows (a `down` split): append to the shorter row → 3, 2×2, 3+2, …;
// - any other shape (e.g. a lone row or column after others emptied): split the largest
//   agent pane along its longer side (cells are ~2:1 tall), newest wins ties.
// The viewer's inputs go in as pane env vars so the command typed into the pane's shell (and
// echoed until the viewer clears the screen) stays short and contains no paths.
async function openPane(cwd: string, env: Record<string, string>): Promise<string> {
	let target = parentPane!;
	let direction: Dir = "right";
	const node = agentArea(await exportRoot())?.node;
	if (node?.type === "split" && node.direction === "down") {
		const row = leaves(node.second).length < leaves(node.first).length ? node.second : node.first;
		target = leaves(row).at(-1)!;
		direction = "right";
	} else if (node?.type === "pane") {
		target = node.pane_id;
		direction = "down";
	} else if (node) {
		const rects = await paneRects();
		let best: { id: string; rect: Rect } | undefined;
		for (const id of leaves(node)) {
			const rect = rects.get(id);
			if (rect && (!best || rect.width * rect.height >= best.rect.width * best.rect.height)) best = { id, rect };
		}
		if (best) {
			target = best.id;
			direction = best.rect.width >= best.rect.height * 2 ? "right" : "down";
		}
	}
	const envArgs = Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
	const split = (await herdr("pane", "split", target, "--direction", direction, "--cwd", cwd, ...envArgs, "--no-focus")) as {
		result: { pane: { pane_id: string } };
	}; // herdr CLI JSON contract
	return split.result.pane.pane_id;
}

// Equalize every split inside the agent area. Only ratios change; the parent/agent divider and
// any panes that are not ours are never touched.
async function rebalance(): Promise<void> {
	const area = agentArea(await exportRoot());
	if (!area) return;
	const updates: { path: Path; ratio: number }[] = [];
	const walk = (node: Node, at: Path) => {
		if (node.type !== "split") return;
		const a = span(node.first, node.direction);
		const ratio = a / (a + span(node.second, node.direction));
		if (Math.abs(ratio - node.ratio) > 0.005) updates.push({ path: at, ratio });
		walk(node.first, [...at, false]);
		walk(node.second, [...at, true]);
	};
	walk(area.node, area.at);
	for (const u of updates) await api("layout.set_split_ratio", { tab_id: tabId, path: u.path, ratio: u.ratio });
}

// Pane mutations are serialized process-wide: parallel subagents start together and each
// placement depends on the layout the previous one produced. A failed step never blocks the
// queue: every herdr call above is bounded by a timeout.
let queue: Promise<unknown> = Promise.resolve();
let logError: (msg: string) => void = () => {};
function serial(fn: () => Promise<void>): void {
	queue = queue.then(fn).catch(err => logError(`herdr-task-panes: ${err}`));
}

export default function (pi: ExtensionAPI) {
	if (!enabled) return;
	logError = msg => pi.logger.error(msg);
	let mine: string | undefined; // session file this subagent session currently mirrors

	// A pane lives for one run. Handlers only enqueue work, so a slow herdr never delays the agent.
	pi.on("agent_start", (_event, ctx) => {
		if (ctx.agent.kind !== "sub") return;
		const file = ctx.sessionManager.getSessionFile();
		if (!file || slots.has(file)) return;
		const slot: Slot = {};
		slots.set(file, slot);
		mine = file;
		const label = `${ctx.agent.name} ${ctx.agent.id}`;
		serial(async () => {
			if (slots.get(file) !== slot) return; // ended before its pane was opened
			slot.paneId = await openPane(ctx.cwd, { HTP_VIEW: VIEWER, HTP_FILE: file, HTP_LABEL: label });
			await rebalance();
			await herdr("pane", "rename", slot.paneId, label);
			await herdr("pane", "run", slot.paneId, 'exec bun "$HTP_VIEW"');
		});
	});

	const close = () => {
		if (!mine) return;
		const file = mine;
		const slot = slots.get(file);
		mine = undefined;
		slots.delete(file);
		serial(async () => {
			if (!slot?.paneId) return;
			await herdr("pane", "close", slot.paneId).catch(() => {}); // user may have closed it
			await rebalance();
		});
	};
	// Non-terminal ends (retry, compaction, async wake) resume the same run: keep the pane.
	pi.on("agent_end", event => {
		if (event.isTerminal !== false) close();
	});
	pi.on("session_shutdown", close);
}
