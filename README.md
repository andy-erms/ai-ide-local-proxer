# cursor-proxer

Local OpenAI-compatible proxy that sits between **Cursor IDE** / **OpenAI Codex CLI** and a thinking-capable LLM provider (**DeepSeek**, **Moonshot/Kimi**, ...). It exists because Cursor and Codex out-of-the-box don't talk cleanly to non-OpenAI thinking models, and the proxy patches the round-trip transparently.

---

## What it fixes

### 1. `reasoning_content` injection (Cursor + thinking models)

When a model is in thinking mode (DeepSeek `deepseek-reasoner`, Moonshot Kimi K2.x, ...), every assistant turn returns a `reasoning_content` field. On the next request the provider expects that field back in history. **Cursor strips it.** The provider then rejects the request with errors like:

```
thinking is enabled but reasoning_content is missing in assistant tool call message at index 5
The reasoning_content in the thinking mode must be passed back to the API.
```

The proxy captures `reasoning_content` from streamed responses, caches it under two keys (sorted `tool_call_id`s and `sha256(content)`), and re-injects it into matching assistant messages on the next request.

### 2. `/v1/responses` → `/v1/chat/completions` translation (Codex CLI)

Codex CLI talks the OpenAI Responses API. DeepSeek and friends only implement `/v1/chat/completions`. The proxy translates requests and SSE responses both ways, including `function_call` / `function_call_output` / `reasoning` items.

### 3. `developer` role remap

Cursor sometimes sends `role: "developer"` (an OpenAI-only role); the proxy rewrites it to `system` before forwarding.

---

## Requirements

* Node.js **20+** (uses native `fetch` and `ReadableStream` iteration)
* No npm dependencies — just stdlib

---

## Quick start

```bash
git clone <this-repo>
cd cursor-proxer

UPSTREAM_URL=https://api.deepseek.com \
UPSTREAM_API_KEY=sk-your-real-deepseek-key \
LOG=1 \
node proxy.js
```

Get full reference:

```bash
node proxy.js --help
```

The proxy listens on `http://127.0.0.1:8765` by default.

---

## Configuration

All configuration is via environment variables.

| Variable | Required | Default | Description |
|---|:-:|---|---|
| `UPSTREAM_API_KEY` | **yes** | — | Bearer token for the upstream provider AND the shared secret incoming clients must send. Without it the proxy refuses to start (`exit 2`). |
| `UPSTREAM_URL` | no | `https://api.deepseek.com` | Upstream base URL, no trailing slash. |
| `HOST` | no | `127.0.0.1` | Listen interface. |
| `PORT` | no | `8765` | Listen port. |
| `FALLBACK_REASONING` | no | `""` | String injected when `reasoning_content` is missing from history and the cache has no match. Set to e.g. `"(elided)"` if your provider rejects empty strings. |
| `CACHE_TTL_MINUTES` | no | `30` | Reasoning cache time-to-live. |
| `CACHE_MAX_ENTRY_BYTES` | no | `1048576` (1 MB) | Maximum size of a single cached reasoning entry. Larger entries are not cached. |
| `LOG` | no | unset | Set to `"1"` for verbose request / cache logging. |

**Hard-coded limits:**
* Maximum request body size: **50 MB** (returns `413` if exceeded).

---

## Client setup

### Cursor IDE

1. **Settings → Models → "Add Custom Model"** (or equivalent flow for the version you're on).
2. **OpenAI Base URL:** `http://localhost:8765/v1` (or your tunnel URL — see below).
3. **OpenAI API Key:** the same value you set as `UPSTREAM_API_KEY`. The proxy validates this and forwards its own key upstream.
4. Pick the model name your upstream provider expects (`deepseek-reasoner`, `kimi-k2.6`, ...).

### Codex CLI

Edit `~/.codex/config.toml`:

```toml
model_provider = "deepseek"
model = "deepseek-v4-pro"

[model_providers.deepseek]
name = "deepseek"
base_url = "http://localhost:8765/v1"        # or tunnel URL + /v1
env_key = "DEEPSEEK_API_KEY"

[profiles.deepseek-v4-pro]
model = "deepseek-v4-pro"
model_reasoning_effort = "xhigh"
temperature = 0.6
```

Then in your shell:

```bash
export DEEPSEEK_API_KEY=<same value as UPSTREAM_API_KEY>
codex
```

Restart Codex completely after changing config.

---

## Exposing the proxy publicly

Cursor's backend proxies requests through Cloudflare and **blocks private IPs** (`127.0.0.1`, `10.*`, `192.168.*`) — you'll see:

```
ssrf_blocked: connection to private IP is blocked
```

You need a public HTTPS URL for the proxy. Three options that work:

### localhost.run (no install, no account)

```bash
ssh -R 80:localhost:8765 nokey@localhost.run
```

Outputs an HTTPS URL like `https://13810d65635fe9.lhr.life`. Use that + `/v1` as the base URL in Cursor / Codex.

### ngrok

```bash
brew install ngrok
ngrok config add-authtoken <token>
ngrok http 8765
```

### cloudflared (quick tunnel)

```bash
brew install cloudflared
cloudflared tunnel --url http://localhost:8765 --protocol http2
```

> ⚠️ `trycloudflare.com` quick tunnels run through Cloudflare bot protection, which can serve a CAPTCHA challenge to Cursor's backend. If that happens, switch to `localhost.run` or `ngrok`. To use Cloudflare without challenges, set up a **named tunnel** on your own domain and disable Bot Fight Mode for that hostname.

---

## Authentication

The proxy uses a single shared secret (`UPSTREAM_API_KEY`) for both:

1. Upstream credential — sent as `Authorization: Bearer <key>` to the provider.
2. Inbound auth — clients must send the same value. Mismatched / missing → `401`.

Comparison is constant-time (`crypto.timingSafeEqual`).

This is the only auth model the proxy supports today; it's the right one for personal use exposed via tunnel.

---

## Troubleshooting

| Error | Cause | Fix |
|---|---|---|
| `thinking is enabled but reasoning_content is missing` | Cursor stripped reasoning from history *and* nothing was in the cache (e.g. you switched providers mid-conversation, or restarted the proxy). | Start a fresh chat in Cursor, or set `FALLBACK_REASONING="(elided)"`. |
| `unknown variant 'developer'` | Provider doesn't accept the `developer` role. | Already handled — proxy rewrites to `system`. Make sure you're on the latest `proxy.js`. |
| `ssrf_blocked` | You pointed Cursor at `localhost`. | Use a tunnel (see above). |
| `gpt-5.5 is not supported` (Codex) | Codex's UI / config didn't pick up the right model. | Add `model = "..."` at the **top level** of `config.toml`, completely restart Codex. |
| `401 Unauthorized` from the proxy | Client's API key doesn't match `UPSTREAM_API_KEY`. | Set the matching key in Cursor / `DEEPSEEK_API_KEY`. |
| `413` | Request body > 50 MB. | Check what Cursor is sending; this usually means a runaway file context. |
| `Cloudflare Tunnel error` HTML page | trycloudflare.com bot protection challenge. | Switch tunnel provider (see above). |
| QUIC / `failed to dial` from cloudflared | UDP blocked by network. | Add `--protocol http2` to cloudflared, or switch to ngrok / localhost.run. |

Set `LOG=1` to see what's actually happening:

```
[req] POST /v1/chat/completions → 200 (patched=2)
[cache] stored reasoning (4821 chars) under tc:call_abc + c:7659967510ef9...
[patch] reasoning_content via tc:call_abc (4821 chars)
```

---

## Development

```bash
node test-smoke.js
```

Runs an in-process mock upstream + proxy and verifies:

* Reasoning caching by `tool_call_id`
* Reasoning caching by content hash
* `/v1/responses` translation, including `function_call` / `function_call_output`
* Auth (wrong / missing Bearer → 401)
* Body size limit (>50 MB → 413)
* Object-prototype safety

---

## Security model

* **No npm runtime dependencies** — only Node stdlib.
* Constant-time secret comparison.
* Refuses to start without `UPSTREAM_API_KEY`.
* `__proto__` / `constructor` / `prototype` headers filtered.
* Errors are sanitized before being returned to the client; full details only go to stderr.
* Designed for **single-tenant** use — the cache is shared globally and one secret authorizes everything.

Out of scope: rate-limiting, per-route ACLs, multi-tenant isolation. If you need those, put a real gateway (Cloudflare Access, Caddy + auth, ...) in front.

---

## License

[MIT](LICENSE) © Andy Erms
