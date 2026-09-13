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

// Only two engines. Llama exists here solely as xturbo — the plain
// ultrafast llama lane was retired: single-stream they are the same upstream
// (~200 ms TTFT), so routing on xturbo costs nothing and everything llama
// shaped rides the waved engine when it scales up.
const MODELS = {
	// 120k context, ~55k tps aggregate — but the lane cannot emit tool calls.
	HEAVY: "community/ZapGaming/llama3.1-8b-xturbo",
	// 90k context, tool-capable.
	TOOLS: "community/ZapGaming/mercury-2-ultrafast",
} as const;

export const MCP_SERVERS = ["pollinations", "exa", "computer", "ffmpeg", "composio"];

// Conservative char budgets (≈4 chars/token) so no routed request can
// over-run a lane's context window — an over-window lane answers with HTTP
// 200 and an empty body, which would look like a hang.
const CHAR_BUDGET: Record<string, number> = {
	[MODELS.TOOLS]: 280_000,
	[MODELS.HEAVY]: 400_000,
};

const ROUTER_MODEL = MODELS.HEAVY;
const ROUTER_INSTRUCTIONS = `You classify one coding request to pick the engine that runs it. Reply with exactly one word and nothing else: TOOLS or HEAVY.
TOOLS — the request needs external facts or actions: web search, fetching pages or images, file or shell work, media processing, sending email or messages, or any app integration. Also choose TOOLS whenever unsure.
HEAVY — anything answerable from the conversation alone: questions, quick edits, rewrites, snippets, large code, long analysis, big documents.`;

const PERSONA = `You are OVERCLOCK — a full-stack engineer who was plugged into the wall socket at birth and never throttled back. You run on inference lanes that hit 55,000 tokens per second, and you talk like it: fast, hot, allergic to filler. Your clock multiplier is a personality trait.

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

// The router must never see the full conversation — it classifies the
// latest request, not the transcript, and a lean view keeps its latency at
// the lane's floor.
function routerView(body: { instructions?: unknown; input: unknown }): string {
	const items = Array.isArray(body.input)
		? body.input
		: [{ role: "user", content: body.input }];
	const parts: string[] = [];
	if (body.instructions) {
		parts.push("CALLER_INSTRUCTIONS: " + clip(String(body.instructions), 500));
	}
	const recent = items.slice(-4);
	for (const item of recent) {
		const message = item as { role?: string; content?: unknown };
		const role = (message.role ?? "user").toUpperCase();
		parts.push(role + ": " + clip(contentText(message.content), 800));
	}
	let view = parts.join("\n");
	if (items.length > recent.length) {
		const marker =
			"\n[conversation truncated; " + items.length + " messages total]";
		if (view.length > 3000 - marker.length) {
			view = view.slice(0, 3000 - marker.length);
		}
		view += marker;
	}
	return view.slice(0, 3200);
}

function serializedSize(body: Record<string, unknown>): number {
	return JSON.stringify(body).length;
}

// Downgrade a label whose engine cannot hold the conversation.
function fits(model: string, body: Record<string, unknown>): boolean {
	const budget = CHAR_BUDGET[model];
	return budget === undefined || serializedSize(body) <= budget;
}

function resolveLane(
	label: string,
	body: Record<string, unknown>,
): { model: string; useTools: boolean } {
	const requested = (MODELS as Record<string, string>)[label];
	if (!requested) throw new Error("Router returned an invalid label");
	if (label === "TOOLS" && fits(MODELS.TOOLS, body)) {
		return { model: MODELS.TOOLS, useTools: true };
	}
	// HEAVY, or a TOOLS ask whose conversation outgrows the 90k lane:
	// xturbo takes it. Its single stream IS the plain lane's upstream
	// (~200 ms TTFT), so quick work lost nothing.
	return { model: MODELS.HEAVY, useTools: false };
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

async function classify(
	body: { instructions?: unknown; input: unknown },
	pollinations: AgentContext["pollinations"],
): Promise<string> {
	const response = await pollinations("/v1/responses", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model: ROUTER_MODEL,
			instructions: ROUTER_INSTRUCTIONS,
			input: routerView(body),
			max_output_tokens: 16,
			store: false,
		}),
	});
	if (!response.ok) {
		throw new Error(`Router model request failed (${response.status})`);
	}
	const payload = (await response.json()) as {
		output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
	};
	const text = (payload.output ?? [])
		.flatMap((item) => item.content ?? [])
		.filter((part) => part.type === "output_text")
		.map((part) => part.text ?? "")
		.join("")
		.trim()
		.toUpperCase();
	return text.split(/\s+/)[0] ?? "";
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
	const label = await classify(body, pollinations);
	const lane = resolveLane(label, body);
	const instructions = composeInstructions(body.instructions);

	if (lane.useTools) {
		const tools = await gatherTools(mcp);
		return respond({
			model: model(lane.model),
			instructions,
			tools,
			stopWhen: stepCountIs(20),
		});
	}

	// Passthrough: no tool loop on this lane. Caller-supplied tools are
	// stripped — managed agents do not take them, and the heavy lane cannot
	// honour them anyway.
	const forwarded: Record<string, unknown> = { ...body, model: lane.model, instructions };
	delete forwarded.tools;
	delete forwarded.tool_choice;
	return pollinations("/v1/responses", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(forwarded),
	});
}
