# Overclock

The most extensive coding agent on Pollinations — OVERCLOCK, a redlined persona-driven pair programmer on a single Failure AI engine with DCH V2 context compression, carrying a full MCP tool belt. All model calls use the caller's Pollen, never the publisher's keys.

**Engine** (one, on purpose — xturbo was retired as a routing target because it cannot emit tool calls, and an agent without tools is not an agent):

| Model | Why |
| --- | --- |
| `community/ZapGaming/mercury-2-ultrafast` | 80k ctx, honours upstream `tools` — drives the whole loop |

**DCH V2** — Dynamic Context Hierarchization, folded into the engine (same design as the gateway's `failure-turbo-x`). The trigger is input size only: a conversation at or under the ~70k-token window passes through untouched; past it, the middle span is map-reduced into digests *before* the tool loop sees it — head (leading system items) and a verbatim tail (bounded to a quarter window) stay word-for-word, chunks are summarised in parallel (8 at a time) by the same engine, digests pair-merge under the budget, and a final truncation guard guarantees the composed request always fits (the lane answers over-window input with HTTP 200 and *zero* tokens — a trap designed around, not discovered). Digests are content-hash cached, so a growing conversation re-summarises only new chunks. Input past the 120k-token DCH ceiling fails loudly rather than silently truncating.

**Tools** — the Vercel AI SDK tool loop with every Pollinations MCP server merged in: `pollinations` (image gen, models), `exa` (live web search + fetch), `computer` (persistent shell + files), `ffmpeg` (audio/video), `composio` (Gmail, Slack, GitHub, Drive, Notion, Linear, hundreds more). A server that fails to enumerate (e.g. a caller with no composio connections) is skipped, not fatal. Up to 16 tool calls and 20 loop steps per request.

## Deploy

1. Fork this repository (must be public).
2. In [My Models](https://enter.pollinations.ai/my-models) choose **Add Agent → Code agent** and enter your fork's URL. The repository name becomes the model ID (`<you>/overclock`).
3. For automatic deploys, add the repository **variable** `POLLINATIONS_SYNC_URL` = `https://gen.pollinations.ai/account/agents/YOUR_AGENT_ID/sync` and enable Actions — the included workflow syncs on every push.

## Test

```bash
bun install
bun test agent.test.ts
```

Eleven tests cover: the tools merge (including a half-failed server list), DCH V2 (under-window passthrough untouched, over-window compression with tail preserved, the heavy-tail case, cache hits making no second digest calls, the loud over-ceiling failure, a failing digest upstream failing loudly, and the composed-request fit guarantee for any accepted size).

[Agent guide](https://github.com/pollinations/pollinations/blob/main/BUILD_YOUR_OWN_AGENT.md) · [More examples](https://github.com/orgs/pollinations/repositories?q=topic%3Apollinations-code-agent-example)
