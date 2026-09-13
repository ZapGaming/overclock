# Overclock

The most extensive coding agent on Pollinations — OVERCLOCK, a redlined persona-driven pair programmer that routes every request across Failure AI's fastest community engines and carries a full MCP tool belt. Routing and model calls use the caller's Pollen, never the publisher's keys.

**Engines** (two, both Failure AI community models — llama exists here solely as xturbo; the plain ultrafast llama lane was retired because single-stream they are the same upstream, and this way every llama-shaped request rides the waved engine when it scales):

| Label | Model | Why |
| --- | --- | --- |
| `TOOLS` | `community/ZapGaming/mercury-2-ultrafast` | 90k ctx, honours upstream `tools` — the only engine that can drive the tool loop |
| `HEAVY` | `community/ZapGaming/llama3.1-8b-xturbo` | 120k ctx (DCH V2), ~55k tps aggregate — long code, big refactors, huge output, *and* everything quick |

A ~16-token router call classifies each request (`TOOLS` / `HEAVY`) and itself rides the xturbo engine; the router only ever sees a ≤3,200-char head-and-tail view of the conversation (our lanes answer over-window input with HTTP 200 and *zero* tokens — a trap we designed around, not discovered).

**Tools** — the `TOOLS` lane runs the Vercel AI SDK tool loop with every Pollinations MCP server merged in: `pollinations` (image gen, models), `exa` (live web search + fetch), `computer` (persistent shell + files), `ffmpeg` (audio/video), `composio` (Gmail, Slack, GitHub, Drive, Notion, Linear, hundreds more). A server that fails to enumerate (e.g. a caller with no composio connections) is skipped, not fatal. Up to 16 tool calls and 20 loop steps per request.

## Deploy

1. Fork this repository (must be public).
2. In [My Models](https://enter.pollinations.ai/my-models) choose **Add Agent → Code agent** and enter your fork's URL. The repository name becomes the model ID (`<you>/overclock`).
3. For automatic deploys, add the repository **variable** `POLLINATIONS_SYNC_URL` = `https://gen.pollinations.ai/account/agents/YOUR_AGENT_ID/sync` and enable Actions — the included workflow syncs on every push.

## Test

```bash
bun install
bun test agent.test.ts
```

Six tests cover the router contract: engine resolution, the tools merge (including a half-failed server list), the ≤3,200-char router view, over-window downgrade to xturbo passthrough, passthrough tool-stripping, and invalid-label failure.

[Agent guide](https://github.com/pollinations/pollinations/blob/main/BUILD_YOUR_OWN_AGENT.md) · [More examples](https://github.com/orgs/pollinations/repositories?q=topic%3Apollinations-code-agent-example)
