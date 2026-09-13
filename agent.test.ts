import assert from "node:assert/strict";
import test from "node:test";
import agent, { MCP_SERVERS, dchCompress } from "./agent.ts";

const MODEL_ID = "community/ZapGaming/mercury-2-ultrafast";

type Call =
	| { kind: "pollinations"; path: string; body: Record<string, unknown> }
	| { kind: "respond"; config: Record<string, unknown> };

function makeContext(body: unknown, opts: {
	digestReply?: string;
	digestStatus?: number;
	failServers?: string[];
} = {}) {
	const calls: Call[] = [];
	const digestReply = opts.digestReply ?? "digest: kept names and decisions.";
	const ctx = {
		request: new Request("https://gen.pollinations.ai/v1/responses", {
			method: "POST",
			body: JSON.stringify(body),
		}),
		pollinations: async (path: string, init?: RequestInit) => {
			const parsed = JSON.parse(init?.body as string) as Record<string, unknown>;
			calls.push({ kind: "pollinations", path, body: parsed });
			if (opts.digestStatus) return new Response("nope", { status: opts.digestStatus });
			return Response.json({
				output: [{ content: [{ type: "output_text", text: digestReply }] }],
			});
		},
		model: (id: string) => ({ sdkModel: id }),
		respond: async (config: Record<string, unknown>) => {
			calls.push({ kind: "respond", config });
			return new Response("responded");
		},
		mcp: {
			tools: async (server: string) => {
				if (opts.failServers?.includes(server)) {
					throw new Error("no connection for " + server);
				}
				return [{ name: server + "-tool" }];
			},
			listTools: async () => ({}),
		},
	};
	return { ctx, calls };
}

function respondCall(calls: Call[]) {
	const call = calls.find((c) => c.kind === "respond") as Extract<Call, { kind: "respond" }>;
	assert.ok(call, "no respond call was made");
	return call.config;
}

test("every request runs the full tool loop over every MCP server", async () => {
	const { ctx, calls } = makeContext({
		input: "Search the web for the latest Bun release and summarise it.",
		instructions: "Cite sources.",
	});
	await agent(ctx);
	const config = respondCall(calls);
	assert.equal(calls.filter((c) => c.kind === "pollinations").length, 0);
	assert.equal((config.model as { sdkModel: string }).sdkModel, MODEL_ID);
	assert.equal(config.stopWhen !== undefined, true);
	const tools = config.tools as { name: string }[];
	assert.deepEqual(
		tools.map((t) => t.name).sort(),
		MCP_SERVERS.map((s) => s + "-tool").sort(),
	);
	const instructions = config.instructions as string;
	assert.match(instructions, /OVERCLOCK/);
	assert.match(instructions, /Cite sources\./);
	assert.deepEqual(config.input, [
		{ role: "user", content: "Search the web for the latest Bun release and summarise it." },
	]);
});

test("a server that fails to expose tools does not break the belt", async () => {
	const { ctx, calls } = makeContext(
		{ input: "check my gmail" },
		{ failServers: ["composio", "ffmpeg"] },
	);
	await agent(ctx);
	const config = respondCall(calls);
	const tools = config.tools as { name: string }[];
	assert.deepEqual(tools.map((t) => t.name).sort(), [
		"computer-tool",
		"exa-tool",
		"pollinations-tool",
	]);
});

test("a string input becomes a user message", async () => {
	const { ctx, calls } = makeContext({ input: "hi" });
	await agent(ctx);
	assert.deepEqual(respondCall(calls).input, [{ role: "user", content: "hi" }]);
});

test("a caller stream flag rides through to the respond config", async () => {
	const { ctx, calls } = makeContext({ input: "hi", stream: true });
	await agent(ctx);
	assert.equal(respondCall(calls).stream, true);
});

test("DCH V2 leaves an under-window conversation untouched", async () => {
	const items = Array.from({ length: 30 }, (_, i) => ({
		role: i % 2 ? "assistant" : "user",
		content: "turn " + i + ": " + "x".repeat(4000),
	}));
	const { ctx, calls } = makeContext({ input: items });
	await agent(ctx);
	const config = respondCall(calls);
	assert.equal(calls.filter((c) => c.kind === "pollinations").length, 0);
	assert.deepEqual(config.input, items);
});

test("DCH V2 compresses an over-window conversation to fit", async () => {
	const items = Array.from({ length: 40 }, (_, i) => ({
		role: i % 2 ? "assistant" : "user",
		content: "turn " + i + ": " + "y".repeat(8000),
	}));
	const tail = { role: "user", content: "final ask: " + "z".repeat(2000) };
	const { ctx, calls } = makeContext({ input: [...items, tail] });
	await agent(ctx);
	const config = respondCall(calls);
	const digestCalls = calls.filter((c) => c.kind === "pollinations");
	assert.ok(digestCalls.length > 0, "expected digest calls");
	const input = config.input as { role: string; content: string }[];
	assert.ok(input.length < items.length, "input should be much smaller");
	assert.match(input[0].content, /DCH V2/);
	const serialized = JSON.stringify(input);
	assert.ok(
		serialized.length < 280_000,
		"composed input was " + serialized.length + " chars",
	);
	// The tail survives verbatim.
	const last = input[input.length - 1];
	assert.ok(String(last.content).startsWith("final ask:"));
});

test("DCH V2 cache: a second identical request makes no new digest calls", async () => {
	const items = Array.from({ length: 40 }, (_, i) => ({
		role: i % 2 ? "assistant" : "user",
		content: "cache turn " + i + ": " + "v".repeat(8000),
	}));
	const body = { input: items };
	const first = makeContext(body);
	await agent(first.ctx);
	const firstDigests = first.calls.filter((c) => c.kind === "pollinations").length;
	assert.ok(firstDigests > 0);
	const second = makeContext(body);
	await agent(second.ctx);
	assert.equal(
		second.calls.filter((c) => c.kind === "pollinations").length,
		0,
		"digest cache missed on an identical conversation",
	);
});

test("a single message heavier than the window is heavy-tailed, not dropped", async () => {
	const huge = "log line: " + "w".repeat(300_000) + " END-OF-LOG-MARKER";
	const body = { input: [{ role: "user", content: "here" }, { role: "user", content: huge }] };
	const { ctx, calls } = makeContext(body);
	await agent(ctx);
	const config = respondCall(calls);
	const input = config.input as { role: string; content: string }[];
	const serialized = JSON.stringify(input);
	assert.ok(serialized.length < 280_000, "composed input was " + serialized.length);
	// The verbatim tail of the heavy message survives.
	const last = input[input.length - 1];
	assert.match(String(last.content), /END-OF-LOG-MARKER/);
});

test("input past the DCH ceiling fails loudly with no respond call", async () => {
	const body = { input: "q".repeat(520_000) };
	const { ctx, calls } = makeContext(body);
	await assert.rejects(agent(ctx), /ceiling/);
	assert.equal(calls.filter((c) => c.kind === "respond").length, 0);
});

test("a failing digest upstream fails the request loudly", async () => {
	const items = Array.from({ length: 40 }, (_, i) => ({
		role: i % 2 ? "assistant" : "user",
		content: "fault turn " + i + ": " + "u".repeat(8000),
	}));
	const { ctx, calls } = makeContext({ input: items }, { digestStatus: 502 });
	await assert.rejects(agent(ctx), /digest request failed/);
	assert.equal(calls.filter((c) => c.kind === "respond").length, 0);
});

test("dchCompress guarantees the composed request fits for any size", async () => {
	const noop = async () => Response.json({ output: [] });
	const items = Array.from({ length: 45 }, (_, i) => ({
		role: i % 2 ? "assistant" : "user",
		content: "msg " + i + ": " + "m".repeat(8500),
	}));
	const { items: composed } = await dchCompress(items, 9_000, noop);
	const size = JSON.stringify(composed).length;
	assert.ok(size <= 289_000, "composed input was " + size + " chars");
});
