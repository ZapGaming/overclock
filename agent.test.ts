import assert from "node:assert/strict";
import test from "node:test";
import agent, { MCP_SERVERS } from "./agent.ts";

const HEAVY = "community/ZapGaming/llama3.1-8b-xturbo";
const TOOLS = "community/ZapGaming/mercury-2-ultrafast";

function labelReply(label: string) {
	return Response.json({
		output: [{ content: [{ type: "output_text", text: label }] }],
	});
}

type Call =
	| { kind: "pollinations"; path: string; body: Record<string, unknown> }
	| { kind: "respond"; config: Record<string, unknown> };

function makeContext(label: string, body: unknown, opts: {
	downstream?: Response;
	respondResult?: Response;
	failServers?: string[];
} = {}) {
	const calls: Call[] = [];
	let pollinationsCalls = 0;
	let routerInput = "";
	const downstream = opts.downstream ?? new Response("downstream");
	const respondResult = opts.respondResult ?? new Response("responded");
	const ctx = {
		request: new Request("https://gen.pollinations.ai/v1/responses", {
			method: "POST",
			body: JSON.stringify(body),
		}),
		pollinations: async (path: string, init?: RequestInit) => {
			pollinationsCalls++;
			if (pollinationsCalls === 1) {
				routerInput = (JSON.parse(init?.body as string) as { input: string }).input;
				return labelReply(label);
			}
			calls.push({
				kind: "pollinations",
				path,
				body: JSON.parse(init?.body as string),
			});
			return downstream;
		},
		model: (id: string) => ({ sdkModel: id }),
		respond: async (config: Record<string, unknown>) => {
			calls.push({ kind: "respond", config });
			return respondResult;
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
	return { ctx, calls, routerInput: () => routerInput, downstream, respondResult };
}

test("TOOLS label runs the full tool loop over every MCP server", async () => {
	const { ctx, calls, respondResult } = makeContext("TOOLS", {
		input: "Search the web for the latest Bun release and summarise it.",
		instructions: "Cite sources.",
	});
	const result = await agent(ctx);
	assert.equal(result, respondResult);
	assert.equal(calls.length, 1);
	const call = calls[0] as Extract<Call, { kind: "respond" }>;
	const config = call.config;
	assert.deepEqual((config.model as { sdkModel: string }).sdkModel, TOOLS);
	assert.equal(config.stopWhen !== undefined, true);
	const tools = config.tools as { name: string }[];
	assert.deepEqual(
		tools.map((t) => t.name).sort(),
		MCP_SERVERS.map((s) => s + "-tool").sort(),
	);
	const instructions = config.instructions as string;
	assert.match(instructions, /OVERCLOCK/);
	assert.match(instructions, /Cite sources\./);
	// The router call itself never reached pollinations a second time.
	assert.equal(calls.filter((c) => c.kind === "pollinations").length, 0);
});

test("a server that fails to expose tools does not break the belt", async () => {
	const { ctx, calls } = makeContext(
		"TOOLS",
		{ input: "check my gmail" },
		{ failServers: ["composio", "ffmpeg"] },
	);
	await agent(ctx);
	const call = calls[0] as Extract<Call, { kind: "respond" }>;
	const tools = call.config.tools as { name: string }[];
	assert.deepEqual(tools.map((t) => t.name).sort(), [
		"computer-tool",
		"exa-tool",
		"pollinations-tool",
	]);
});

test("HEAVY label forwards to the xturbo lane with the caller's stream intact", async () => {
	const body = {
		model: "ZapGaming/overclock",
		input: [
			{ role: "user", content: "Write a 2000-line Zig allocator." },
		],
		instructions: "Target macOS.",
		stream: true,
		tools: [{ type: "function", name: "caller-tool" }],
		tool_choice: "auto",
	};
	const { ctx, calls, downstream } = makeContext("HEAVY", body);
	const result = await agent(ctx);
	assert.equal(result, downstream);
	assert.equal(calls.length, 1);
	const call = calls[0] as Extract<Call, { kind: "pollinations" }>;
	assert.equal(call.path, "/v1/responses");
	assert.equal(call.body.model, HEAVY);
	assert.equal(call.body.stream, true);
	assert.equal(call.body.tools, undefined);
	assert.equal(call.body.tool_choice, undefined);
	const instructions = call.body.instructions as string;
	assert.match(instructions, /OVERCLOCK/);
	assert.match(instructions, /Target macOS\./);
	// Everything else rides through untouched.
	assert.deepEqual(call.body.input, body.input);
});

test("an oversized TOOLS ask downgrades to xturbo and loses the tool loop", async () => {
	const body = { input: "Summarise this transcript. " + "y".repeat(300_000) };
	const { ctx, calls } = makeContext("TOOLS", body);
	await agent(ctx);
	const call = calls[0] as Extract<Call, { kind: "pollinations" }>;
	assert.equal(call.body.model, HEAVY);
	assert.equal(call.body.tools, undefined);
	assert.equal(call.body.tool_choice, undefined);
});

test("the router never sees the full conversation", async () => {
	const messages = Array.from({ length: 60 }, (_, i) => ({
		role: i % 2 ? "assistant" : "user",
		content: "turn " + i + ": " + "z".repeat(1000),
	}));
	const { ctx, routerInput } = makeContext("HEAVY", { input: messages });
	await agent(ctx);
	const view = routerInput();
	assert.ok(view.length < 3200, "router input was " + view.length);
	assert.match(view, /conversation truncated/);
});

test("an invalid routing label fails loudly without a downstream call", async () => {
	const { ctx, calls, downstream } = makeContext("OK", { input: "hi" });
	let bodyGuard = new Response("never");
	const sentinel = new Response("sentinel");
	// replace downstream sentinel so a wrong passthrough is detectable
	const ctx2 = { ...ctx, pollinations: async (path: string, init?: RequestInit) => {
		const first = !(calls.length);
		if (first) return labelReply("OK");
		calls.push({ kind: "pollinations", path, body: JSON.parse(init?.body as string) });
		return sentinel;
	} };
	bodyGuard = sentinel;
	await assert.rejects(agent(ctx2), /invalid label/);
	assert.equal(calls.length, 0);
	assert.equal(bodyGuard, sentinel);
	assert.notEqual(downstream, null);
});
