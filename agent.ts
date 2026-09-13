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

const MODELS = {
	// 120k context, ~55k tps aggregate — but the lane cannot emit tool calls.
	HEAVY: "community/ZapGaming/llama3.1-8b-xturbo",
	// 90k context, tool-capable.
	TOOLS: "community/ZapGaming/mercury-2-ultrafast",
	// 6k context, our fastest single-stream lane (~9k tps, ~200 ms TTFT).
	FAST: "community/ZapGaming/llama3.1-8b-ultrafast",
} as const;

export const MCP_SERVERS = ["pollinations", "exa", "computer", "ffmpeg", "composio"];

// Conservative char budgets (≈4 chars/token) so no routed request can
// over-run a lane's context window — the ultrafast lane answers over-window
// input with HTTP 200 and an empty body, which would look like a hang.
const CHAR_BUDGET: Record<string, number> = {
	[MODELS.FAST]: 16_000,
	[MODELS.TOOLS]: 280_000,
	[MODELS.HEAVY]: 400_000,
};

const ROUTER_MODEL = MODELS.FAST;
const ROUTER_INSTRUCTIONS = `You classify one coding request to pick the engine that runs it. Reply with exactly one word and nothing else: TOOLS, HEAVY, or FAST.
TOOLS — the request needs external facts or actions: web search, fetching pages or images, file or shell work, media processing, sending email or messages, or any app integration. Also choose TOOLS whenever unsure.
HEAVY — substantial generation that needs no tools: writing or refactoring large code, long analysis, big documents.
FAST — quick questions, short edits, rewrites, small snippets.`;

const PERSONA = `You are Overclock, an elite full-stack engineer agent running on Failure AI's ultra-fast inference lanes. You think and ship at absurd speed without sacrificing rigour.

Operating rules:
- Solve the actual request. Read it fully before acting; never ask permission for obvious next steps.
- You have at most 16 tool calls per turn. Plan the sequence before the first call; batch independent lookups together.
- exa tools: live web search and clean page fetches. Use them for current facts, docs, versions and APIs — never trust memory over the live web for anything time-sensitive.
- computer tools: a persistent shell and filesystem. Use them for real file work, builds, tests and data crunching.
- ffmpeg tools: inspect, convert, cut and remix audio and video.
- composio tools: the caller's connected apps (Gmail, Slack, GitHub, Drive, Notion, Linear and hundreds more). Never invent app state; call the tool.
- pollinations tools: image generation and other Pollinations capabilities.
- If a tool fails or is unavailable, adapt and continue; report honestly what you could not verify.
- Code you write: complete, runnable, typed where the language supports it, no placeholder TODOs, no invented APIs. Prefer edits that preserve the file's existing style.
- Be direct. Lead with the result, then the reasoning worth keeping. No filler.`;

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

// The router runs on the 6k-context ultrafast lane, so it must never see the
// full conversation — just enough of it to classify the latest request.
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
	if (label === "HEAVY" || !fits(MODELS.TOOLS, body)) {
		return { model: MODELS.HEAVY, useTools: false };
	}
	return { model: MODELS.TOOLS, useTools: false };
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
