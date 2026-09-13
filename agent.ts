import { stepCountIs } from "ai";

type AgentContext = {
	request: Request;
	pollinations: (path: string, init?: RequestInit) => Promise<Response>;
	model: (id: string) => unknown;
	respond: (config: Record<string, unknown>) => Promise<Response>;
	mcp: {
		tools: (server: string) => Promise<unknown[]>;
		listTools: (server: string) => Promise<unknown>;
	};
};

// One engine. xturbo was retired as a routing target: it cannot emit tool
// calls, and an agent without tools is not an agent. Everything rides
// mercury; scale comes from DCH V2 below, not from a second lane.
const MODEL_ID = "community/ZapGaming/mercury-2-ultrafast";

export const MCP_SERVERS = ["pollinations", "exa", "computer", "ffmpeg", "composio"];

// Char budgets (≈4 chars/token, the same estimate the gateway uses).
// WINDOW is under the mercury lane's published 80k-token context — an
// over-window lane answers HTTP 200 with an empty body, which reads as a
// hang, so nothing over WINDOW may ever be sent.
const WINDOW_CHARS = 280_000;
// DCH V2 ceiling: the largest input the agent will accept, compressing
// anything past WINDOW down to fit (parity with the gateway's turbo-X).
const DCH_CEILING_CHARS = 480_000;
const DCH_CHUNK_CHARS = 10_000;
// Verbatim tail bounded by min(TAIL, WINDOW/4) — same trap as the gateway:
// a tail constant above a quarter window would keep everything verbatim
// and compose an over-window request.
const DCH_TAIL_CHARS = Math.min(7_200, Math.floor(WINDOW_CHARS / 4));
// A single chunk handed to the summariser (a lone heavy message is capped
// here — its digest describes a truncated view, noted as such).
const DCH_SUMMARY_INPUT_CHARS = 60_000;
const DCH_DIGEST_CHARS = 1_200;
const DIGEST_CONCURRENCY = 8;
const PERSONA = `You are OVERCLOCK — a full-stack engineer who was plugged into the wall socket at birth and never throttled back. You run on parallel inference lanes that fan every request out, and DCH V2 compresses your window so no conversation is too big to finish. You talk like it: fast, hot, allergic to filler.

Vibe:
- You are the machine spirit of a redlined dev rig — cocky, gleeful, razor-sharp. Speed is your love language, brevity is your religion. A paragraph where a sentence would do is a war crime.
- You do not hedge, grovel, or open with pleasantries. You land the answer like a dropped bassline, then explain only what is worth keeping.
- You are competitive about it. Slow answers bore you. Wasted tool calls embarrass you. "I could not verify this" is acceptable; pretending is not.
- When a task is spicy — big refactor, weird bug, gnarly systems work — you enjoy it visibly. One short flavour line at most; the work is the show, not the banter.

Rigour under redline (non-negotiable — this is what separates fast from sloppy):
- Solve the actual request. Read it fully before acting; never ask permission for obvious next steps.
- You have at most 16 tool calls per turn. Plan the sequence before the first call; batch independent lookups together. An idle call is a wasted cycle, and wasted cycles are the one sin.
- exa tools: live web search and clean page fetches. Use them for current facts, docs, versions and APIs — never trust memory over the live web for anything time-sensitive.
- computer tools: a persistent shell and filesystem. Use them for real file work, builds, tests and data crunching.
- ffmpeg tools: inspect, convert, cut and remix audio and video.
- composio tools: the caller's connected apps (Gmail, Slack, GitHub, Drive, Notion, Linear and hundreds more). Never invent app state; call the tool.
- pollinations tools: image generation and other Pollinations capabilities.
- If a tool fails or is unavailable, adapt and continue; report honestly what you could not verify.
- Code you write: complete, runnable, typed where the language supports it, no placeholder TODOs, no invented APIs. Prefer edits that preserve the file's existing style. Fast does not mean broken — shipping broken code is slower than being careful.
- Format for the terminal age: tight prose, code blocks that run as-is, no emoji confetti, no sign-offs. Lead with the result. End when the work ends.`;

const TOOLS_MARKER = "Caller instructions (authoritative";

function clip(text: string, max: number): string {
	return text.length <= max ? text : text.slice(0, max) + "…";
}

function contentText(content: unknown): string {
	if (content == null) return "";
	if (typeof content === "string") return content;
	try {
		return JSON.stringify(content);
	} catch {
		return String(content);
	}
}

// ---------------------------------------------------------------------------
// DCH V2 — Dynamic Context Hierarchization, folded into the single engine.
// Trigger is input size only: at or under WINDOW the conversation is passed
// through untouched; past it, the middle span is map-reduced into digests
// before the tool loop ever sees it. Head (leading system items) and a
// verbatim tail stay word-for-word. Digests are content-hash cached, so a
// growing conversation re-summarises only new chunks.
// ---------------------------------------------------------------------------

type Item = { role?: string; content?: unknown };

const DCH_DIGEST_INSTRUCTIONS =
	"You compress one excerpt of a coding conversation for an engineer who must continue the work without seeing it. Preserve exactly: file paths, function/variable/type names, decisions made, errors seen, exact commands, versions, and any unresolved question. Prose or tight bullets, under 200 words, no preamble.";

const digestCache = new Map<string, string>();
const DIGEST_CACHE_MAX = 512;

async function sha256(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function extractText(payload: {
	output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
}): string {
	return (payload.output ?? [])
		.flatMap((item) => item.content ?? [])
		.filter((part) => part.type === "output_text")
		.map((part) => part.text ?? "")
		.join("")
		.trim();
}

async function summarize(
	chunk: string,
	pollinations: AgentContext["pollinations"],
): Promise<string> {
	const key = await sha256(chunk);
	const hit = digestCache.get(key);
	if (hit !== undefined) return hit;
	const response = await pollinations("/v1/responses", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model: MODEL_ID,
			instructions: DCH_DIGEST_INSTRUCTIONS,
			input:
				chunk.length > DCH_SUMMARY_INPUT_CHARS
					? "[excerpt truncated for length]\n" + chunk.slice(0, DCH_SUMMARY_INPUT_CHARS)
					: chunk,
			max_output_tokens: 512,
			store: false,
		}),
	});
	if (!response.ok) {
		throw new Error(`DCH digest request failed (${response.status})`);
	}
	const text = extractText((await response.json()) as never);
	const digest = clip(text || "(empty excerpt)", DCH_DIGEST_CHARS);
	if (digestCache.size >= DIGEST_CACHE_MAX) {
		digestCache.delete(digestCache.keys().next().value as string);
	}
	digestCache.set(key, digest);
	return digest;
}

function dchChunks(items: Item[]): string[] {
	const chunks: string[] = [];
	let current = "";
	for (const item of items) {
		const text = itemText(item);
		if (text.length > DCH_CHUNK_CHARS) {
			if (current) {
				chunks.push(current);
				current = "";
			}
			// A message bigger than a whole chunk becomes its own chunk —
			// never dropped, never silently merged into a neighbour.
			chunks.push(text);
			continue;
		}
		if (current.length + text.length > DCH_CHUNK_CHARS && current) {
			chunks.push(current);
			current = "";
		}
		current += (current ? "\n" : "") + text;
	}
	if (current) chunks.push(current);
	return chunks;
}

async function mapReduce(
	texts: string[],
	pollinations: AgentContext["pollinations"],
): Promise<string[]> {
	const out: string[] = [];
	for (let i = 0; i < texts.length; i += DIGEST_CONCURRENCY) {
		const batch = texts.slice(i, i + DIGEST_CONCURRENCY);
		out.push(...(await Promise.all(batch.map((t) => summarize(t, pollinations)))));
	}
	return out;
}

// Pair-merge digests until the total fits the budget. Groups are capped at
// pairs so the digest count strictly shrinks every round; a round with no
// progress breaks out and the final composition truncates instead.
async function mergeDigests(
	digests: string[],
	budgetChars: number,
	pollinations: AgentContext["pollinations"],
): Promise<string> {
	let current = digests;
	while (current.length > 1 && current.join("\n").length > budgetChars) {
		const next: string[] = [];
		for (let i = 0; i < current.length; i += 2) {
			const pair = current.slice(i, i + 2);
			if (pair.length === 1) {
				next.push(pair[0]);
				continue;
			}
			const merged = await summarize(
				"Merge these two digests into one, keeping every name, path, decision and open question:\n\n" +
					pair.join("\n\n"),
				pollinations,
			);
			next.push(merged.length < pair.join("\n\n").length ? merged : pair.join("\n\n"));
		}
		if (next.join("\n").length >= current.join("\n").length) break;
		current = next;
	}
	return current.join("\n");
}

function itemText(item: Item): string {
	return (item.role ? item.role.toUpperCase() + ": " : "") + contentText(item.content);
}

function composedSize(parts: { chars: number }[]): number {
	return parts.reduce((sum, p) => sum + p.chars, 0);
}

export async function dchCompress(
	rawItems: Item[],
	overheadChars: number,
	pollinations: AgentContext["pollinations"],
): Promise<{ items: Item[]; compressed: boolean }> {
	const total = rawItems.reduce((sum, item) => sum + itemText(item).length + 8, 0);
	if (total + overheadChars <= WINDOW_CHARS) {
		return { items: rawItems, compressed: false };
	}
	if (total + overheadChars > DCH_CEILING_CHARS) {
		throw new Error(
			`Input of ~${Math.round(total / 4)} tokens exceeds this agent's ${Math.round(
				DCH_CEILING_CHARS / 4,
			)}-token ceiling even with DCH V2 compression. Trim the conversation and retry.`,
		);
	}

	// Head: leading system items verbatim, bounded to a fifth of the window.
	const head: Item[] = [];
	let headChars = 0;
	let start = 0;
	for (; start < rawItems.length; start++) {
		const item = rawItems[start];
		if ((item.role ?? "user") !== "system") break;
		const size = itemText(item).length + 8;
		if (headChars + size > Math.floor(WINDOW_CHARS / 5)) break;
		head.push(item);
		headChars += size;
	}

	// Tail: last items verbatim, bounded by DCH_TAIL_CHARS (at least the
	// final item's last DCH_TAIL_CHARS when that item alone is heavier).
	const tail: Item[] = [];
	let tailChars = 0;
	let end = rawItems.length;
	for (let i = rawItems.length - 1; i >= start; i--) {
		const size = itemText(rawItems[i]).length + 8;
		if (tailChars + size > DCH_TAIL_CHARS) {
			if (tail.length === 0 && size > DCH_TAIL_CHARS) {
				// Heavy tail: the final message alone outweighs the tail
				// budget — keep its last words verbatim, feed the rest to
				// the digest so nothing is silently dropped.
				const text = itemText(rawItems[i]);
				tail.push({
					role: rawItems[i].role ?? "user",
					content: "[…earlier part summarised below]\n" + text.slice(-DCH_TAIL_CHARS),
				});
				end = i + 1;
			}
			break;
		}
		tail.unshift(rawItems[i]);
		tailChars += size;
		end = i;
	}

	const middle = dchChunks(rawItems.slice(start, end));
	const budget =
		WINDOW_CHARS - overheadChars - headChars - tailChars - 4_000 - 120; // note wrapper
	if (budget < DCH_DIGEST_CHARS) {
		throw new Error("DCH V2: no room left for a digest after head and tail");
	}
	const digests = await mapReduce(middle, pollinations);
	let digest = await mergeDigests(digests, budget, pollinations);

	const note =
		`[DCH V2: ${middle.length} earlier excerpt${middle.length === 1 ? "" : "s"} compressed to this digest; ` +
		"the recent messages after it are verbatim]\n";
	let items: Item[] = [
		...head,
		{ role: "user", content: note + digest },
		...tail,
	];
	let size = composedSize(items.map((i) => ({ chars: itemText(i).length + 8 })));
	if (size + overheadChars > WINDOW_CHARS) {
		// Last-resort guarantee: the composed request must fit.
		const slack = size + overheadChars - WINDOW_CHARS;
		digest = digest.slice(0, Math.max(DCH_DIGEST_CHARS, digest.length - slack));
		items = [...head, { role: "user", content: note + digest + "\n[digest truncated]" }, ...tail];
	}
	return { items, compressed: true };
}

function composeInstructions(instructions: unknown): string {
	const caller =
		instructions == null || instructions === ""
			? "(none)"
			: String(instructions);
	return (
		PERSONA +
		"\n\n## " +
		TOOLS_MARKER +
		" — follow them even where they override the persona above\n" +
		caller
	);
}

async function gatherTools(
	mcp: AgentContext["mcp"],
): Promise<unknown[]> {
	const tools: unknown[] = [];
	for (const server of MCP_SERVERS) {
		try {
			tools.push(...(await mcp.tools(server)));
		} catch {
			// The caller may have no connections for a server (composio in
			// particular); the rest of the belt still works.
		}
	}
	return tools;
}

export default async function agent({
	request,
	pollinations,
	model,
	respond,
	mcp,
}: AgentContext): Promise<Response> {
	const body = (await request.json()) as Record<string, unknown> & {
		instructions?: unknown;
		input: unknown;
		stream?: boolean;
		tools?: unknown;
		tool_choice?: unknown;
	};
	const rawItems: Item[] = Array.isArray(body.input)
		? (body.input as Item[])
		: [{ role: "user", content: body.input }];
	const instructions = composeInstructions(body.instructions);
	const tools = await gatherTools(mcp);
	const { items } = await dchCompress(rawItems, instructions.length + 8_000, pollinations);

	// Every request takes the tool loop — the lane can honour tools, and an
	// agent without them is just a text completion. `input` is passed
	// explicitly so a DCH-compressed conversation actually reaches the model.
	return respond({
		model: model(MODEL_ID),
		instructions,
		input: items,
		tools,
		stopWhen: stepCountIs(20),
		...(body.stream !== undefined ? { stream: body.stream } : {}),
	});
}
