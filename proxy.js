#!/usr/bin/env node
// OpenAI-compatible proxy that:
//
//  1. Fixes thinking-model round-trips for Cursor (Kimi / DeepSeek):
//       * captures reasoning_content from streamed/buffered assistant turns,
//         cached under two keys — sorted tool_call ids AND sha256 of content
//       * re-injects reasoning_content into assistant messages in subsequent
//         requests that lack it (Cursor strips it)
//
//  2. Translates OpenAI Responses API (/v1/responses) → chat/completions so
//     tools like Codex CLI work with backends that only implement chat/completions
//     (DeepSeek, Moonshot, etc.).  The translation is transparent: existing
//     /v1/chat/completions (and other) paths pass through completely unchanged.
//
// Run:
//   UPSTREAM_URL=https://api.deepseek.com \
//   UPSTREAM_API_KEY=sk-...  \
//   PORT=8765 \
//   node proxy.js
//
// Cursor base URL: http://localhost:8765/v1
// Codex base URL:  http://localhost:8765/v1

import http from 'node:http';
import { Buffer } from 'node:buffer';
import { createHash, timingSafeEqual } from 'node:crypto';

// ── Help ─────────────────────────────────────────────────────────────────────

const HELP = `cursor-proxer — local OpenAI-compatible proxy for Cursor IDE and Codex CLI

USAGE:
    UPSTREAM_API_KEY=<key> [OPTIONS] node proxy.js
    node proxy.js --help

DESCRIPTION:
    Sits between an OpenAI-compatible client (Cursor, Codex CLI, ...) and a
    thinking-capable provider (DeepSeek, Moonshot/Kimi, ...). Fixes two
    common breakages:
      * Re-injects reasoning_content into assistant history messages that
        Cursor strips out, which providers in thinking mode reject.
      * Translates the OpenAI Responses API (/v1/responses) used by Codex
        to /v1/chat/completions for backends that don't implement it.

REQUIRED ENV:
    UPSTREAM_API_KEY        Bearer token for the upstream provider AND the
                            shared secret that incoming requests must send
                            in their Authorization: Bearer <token> header.
                            Without this set, the proxy refuses to start.

OPTIONAL ENV:
    UPSTREAM_URL            Upstream base URL.
                            Default: https://api.deepseek.com
    HOST                    Interface to bind. Default: 127.0.0.1
    PORT                    Port to bind.      Default: 8765
    FALLBACK_REASONING      String injected when reasoning_content is missing
                            from history and the cache has no match.
                            Default: "" (empty string)
    CACHE_TTL_MINUTES       Reasoning cache time-to-live, in minutes.
                            Default: 30
    CACHE_MAX_ENTRY_BYTES   Max size of a single cached reasoning entry.
                            Default: 1048576 (1 MB)
    LOG                     Set to "1" for verbose request/cache logging.

LIMITS (hard-coded):
    Max request body size:  50 MB (returns 413 if exceeded)

ROUTES:
    POST /v1/responses          → translated to upstream /v1/chat/completions
    *                           → forwarded to upstream as-is

EXAMPLE:
    UPSTREAM_URL=https://api.deepseek.com \\
    UPSTREAM_API_KEY=sk-... \\
    LOG=1 \\
    node proxy.js

CLIENT SETUP:
    Cursor: Settings → Models → custom OpenAI base URL = http://localhost:8765/v1
            API Key = <same value as UPSTREAM_API_KEY>
    Codex:  ~/.codex/config.toml — point base_url at this proxy and set the
            provider's env_key var to UPSTREAM_API_KEY's value.

EXIT CODES:
    0  --help shown, or normal shutdown
    2  required env missing or invalid
`;

function printHelp(stream = process.stdout) {
  stream.write(HELP);
}

// ── CLI flags ────────────────────────────────────────────────────────────────

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  printHelp();
  process.exit(0);
}

// ── Config ───────────────────────────────────────────────────────────────────

const UPSTREAM_URL    = (process.env.UPSTREAM_URL    || 'https://api.deepseek.com').replace(/\/$/, '');
const UPSTREAM_API_KEY = process.env.UPSTREAM_API_KEY || '';
const PORT            = parseInt(process.env.PORT  || '8765', 10);
const HOST            = process.env.HOST            || '127.0.0.1';
const FALLBACK_REASONING = process.env.FALLBACK_REASONING ?? '';
const LOG             = process.env.LOG === '1';

// Hard-coded body-size cap (50 MB).
const MAX_BODY_BYTES  = 50 * 1024 * 1024;
// Cache tunables (env-overridable).
const CACHE_TTL_MS         = Math.max(1, parseInt(process.env.CACHE_TTL_MINUTES    || '30',                10)) * 60_000;
const CACHE_MAX_ENTRY_BYTES = Math.max(1, parseInt(process.env.CACHE_MAX_ENTRY_BYTES || String(1024 * 1024), 10));

// Hard requirement: refuse to start without an auth key — the proxy is
// designed to be exposed via tunnel, and a missing key would silently leave
// the upstream credentials open to the world.
if (!UPSTREAM_API_KEY) {
  printHelp(process.stderr);
  console.error('\nERROR: UPSTREAM_API_KEY is required.');
  process.exit(2);
}

// Constant-time string compare. The length check itself leaks length, which
// is fine — the secret is the bytes of a fixed-length API key, not its size.
function safeStrEq(a, b) {
  const ab = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// ── Reasoning cache ───────────────────────────────────────────────────────────
// Keyed by:
//   tc:<sorted,tool,call,ids>     → Kimi: assistant messages with tool_calls
//   c:<sha256-prefix-of-content>  → DeepSeek: plain text assistant messages

const reasoningCache = new Map();
const MAX_CACHE = 1000;

function contentKey(content) {
  if (content == null) return null;
  const s = typeof content === 'string' ? content : (() => { try { return JSON.stringify(content); } catch { return null; } })();
  if (!s || s === '""') return null;
  return 'c:' + createHash('sha256').update(s).digest('hex').slice(0, 24);
}

function toolCallsKey(toolCalls) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return null;
  const ids = toolCalls.map(tc => tc?.id).filter(Boolean);
  return ids.length ? 'tc:' + ids.slice().sort().join(',') : null;
}

function keysForMsg(msg) {
  const keys = [];
  const tk = toolCallsKey(msg?.tool_calls);
  if (tk) keys.push(tk);
  const ck = contentKey(msg?.content);
  if (ck) keys.push(ck);
  return keys;
}

function cacheSet(key, reasoning) {
  if (!key || !reasoning) return;
  // Skip oversized entries — a single rogue/runaway response shouldn't pin
  // megabytes in the proxy's heap forever.
  if (Buffer.byteLength(reasoning, 'utf8') > CACHE_MAX_ENTRY_BYTES) {
    if (LOG) console.log(`[cache] skipped oversized entry (${reasoning.length} chars > ${CACHE_MAX_ENTRY_BYTES} bytes)`);
    return;
  }
  if (reasoningCache.size >= MAX_CACHE && !reasoningCache.has(key)) {
    reasoningCache.delete(reasoningCache.keys().next().value);
  }
  reasoningCache.set(key, { value: reasoning, expiresAt: Date.now() + CACHE_TTL_MS });
}

function cacheGet(key) {
  const entry = reasoningCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    reasoningCache.delete(key);
    return null;
  }
  return entry.value;
}

function rememberReasoning({ toolCalls, content, reasoning }) {
  if (!reasoning) return;
  const keys = keysForMsg({ tool_calls: toolCalls, content });
  keys.forEach(k => cacheSet(k, reasoning));
  if (LOG && keys.length) console.log(`[cache] stored reasoning (${reasoning.length} chars) under ${keys.join(' + ')}`);
}

function patchRequestMessages(body) {
  if (!body || !Array.isArray(body.messages)) return 0;
  let patched = 0;
  for (const msg of body.messages) {
    // Remap OpenAI-specific roles that DeepSeek/Moonshot don't support
    if (msg?.role === 'developer') {
      msg.role = 'system';
      patched++;
      if (LOG) console.log('[patch] role developer → system');
    }

    if (msg?.role !== 'assistant') continue;
    if (typeof msg.reasoning_content === 'string' && msg.reasoning_content.length > 0) continue;
    const keys = keysForMsg(msg);
    if (keys.length === 0) continue;
    let cached = null, hitKey = null;
    for (const k of keys) { const v = cacheGet(k); if (v) { cached = v; hitKey = k; break; } }
    msg.reasoning_content = cached || FALLBACK_REASONING;
    patched++;
    if (LOG) console.log(`[patch] reasoning_content via ${hitKey || 'fallback'} (${(cached || FALLBACK_REASONING).length} chars)`);
  }
  return patched;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

const HOP_BY_HOP = new Set([
  'host','connection','keep-alive','proxy-authenticate','proxy-authorization',
  'te','trailer','transfer-encoding','upgrade','content-length','accept-encoding',
]);

// HTTP allows weird header names. Refuse to set ones that mutate Object's
// prototype chain on a regular {} accumulator.
const POISONED = new Set(['__proto__', 'constructor', 'prototype']);

function cleanReqHeaders(raw, overrideAuth) {
  const out = Object.create(null);
  for (const [k, v] of Object.entries(raw)) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk) || POISONED.has(lk)) continue;
    out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  if (overrideAuth) out['authorization'] = `Bearer ${overrideAuth}`;
  return out;
}

function cleanRespHeaders(headers) {
  const out = Object.create(null);
  for (const [k, v] of headers.entries()) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk) || POISONED.has(lk)) continue;
    out[k] = v;
  }
  return out;
}

async function readBody(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > maxBytes) {
      const err = new Error('request body too large');
      err.code = 'BODY_TOO_LARGE';
      err.statusCode = 413;
      throw err;
    }
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

// ── SSE inspector (non-mutating — just calls onDelta for each parsed frame) ──

function makeStreamInspector(onDelta) {
  let buf = '';
  return {
    push(chunk) {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try { onDelta(JSON.parse(data)); } catch {}
      }
    },
  };
}

// ── Responses API ↔ chat/completions translation ─────────────────────────────

function normalizeResponsesContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts = content
      .filter(p => p.type === 'input_text' || p.type === 'output_text' || p.type === 'text')
      .map(p => p.text ?? p.content ?? '');
    return texts.length === 1 ? texts[0] : texts.join('\n') || JSON.stringify(content);
  }
  return String(content);
}

function responsesInputToMessages(body) {
  const messages = [];
  if (body.instructions) messages.push({ role: 'system', content: body.instructions });

  const input = Array.isArray(body.input)
    ? body.input
    : typeof body.input === 'string'
    ? [{ type: 'message', role: 'user', content: body.input }]
    : [];

  for (const item of input) {
    if (item.type === 'message' || (!item.type && item.role)) {
      const role = item.role || 'user';
      const content = normalizeResponsesContent(item.content);
      if (role === 'system') messages.unshift({ role: 'system', content });
      else messages.push({ role, content });

    } else if (item.type === 'function_call') {
      // Assistant tool-call turn — merge consecutive calls into one message
      const prev = messages[messages.length - 1];
      const tc = { id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments || '' } };
      if (prev?.role === 'assistant' && Array.isArray(prev.tool_calls)) {
        prev.tool_calls.push(tc);
      } else {
        messages.push({ role: 'assistant', content: null, tool_calls: [tc] });
      }

    } else if (item.type === 'function_call_output') {
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id,
        content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? ''),
      });
    }
  }
  return messages;
}

function responsesBodyToChatBody(body) {
  const messages = responsesInputToMessages(body);

  const tools = (body.tools || [])
    .filter(t => t.type === 'function')
    .map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters || {},
        ...(t.strict !== undefined ? { strict: t.strict } : {}),
      },
    }));

  const chat = { model: body.model, messages, stream: body.stream ?? false };
  if (tools.length)             chat.tools = tools;
  if (body.max_output_tokens != null) chat.max_tokens = body.max_output_tokens;
  if (body.temperature != null)  chat.temperature = body.temperature;
  if (body.top_p != null)        chat.top_p = body.top_p;
  return chat;
}

function chatRespToResponsesResp(chatResp, origBody) {
  const msg = chatResp.choices?.[0]?.message;
  const id  = 'resp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const output = [];

  if (msg?.reasoning_content) {
    output.push({
      type: 'reasoning',
      id: 'rs_' + Math.random().toString(36).slice(2, 10),
      summary: [{ type: 'summary_text', text: msg.reasoning_content }],
    });
  }
  if (Array.isArray(msg?.tool_calls)) {
    for (const tc of msg.tool_calls) {
      output.push({
        type: 'function_call',
        id: 'fc_' + tc.id, call_id: tc.id,
        name: tc.function.name, arguments: tc.function.arguments,
        status: 'completed',
      });
    }
  }
  if (msg?.content) {
    output.push({
      type: 'message',
      id: 'msg_' + Math.random().toString(36).slice(2, 10),
      role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: msg.content }],
    });
  }

  const u = chatResp.usage;
  return {
    id, object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: chatResp.model || origBody.model,
    output,
    ...(u ? { usage: { input_tokens: u.prompt_tokens ?? 0, output_tokens: u.completion_tokens ?? 0, total_tokens: u.total_tokens ?? 0 } } : {}),
  };
}

// Translates a streaming chat/completions SSE response into Responses API SSE.
class ResponsesStreamAdapter {
  constructor(res, id, model) {
    this.res = res; this.id = id; this.model = model;
    this.nextIdx = 0;
    this.reasoning = { opened: false, id: null, idx: null, text: '' };
    this.message   = { opened: false, id: null, idx: null, text: '' };
    this.toolCalls = {}; // deltaIndex → { id, name, arguments, idx, opened }
    this.usageFinal = null;
  }

  _send(event, data) {
    this.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  start() {
    this._send('response.created', {
      type: 'response.created',
      response: { id: this.id, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'in_progress', model: this.model, output: [] },
    });
  }

  pushDelta(obj) {
    if (obj?.usage) this.usageFinal = obj.usage;
    const delta = obj?.choices?.[0]?.delta;
    if (!delta) return;

    // Reasoning delta
    if (delta.reasoning_content) {
      const r = this.reasoning;
      if (!r.opened) {
        r.id = 'rs_' + Math.random().toString(36).slice(2, 10);
        r.idx = this.nextIdx++;
        this._send('response.output_item.added', { type: 'response.output_item.added', output_index: r.idx, item: { type: 'reasoning', id: r.id, summary: [] } });
        this._send('response.reasoning_summary_part.added', { type: 'response.reasoning_summary_part.added', item_id: r.id, output_index: r.idx, summary_index: 0, part: { type: 'summary_text', text: '' } });
        r.opened = true;
      }
      r.text += delta.reasoning_content;
      this._send('response.reasoning_summary_text.delta', { type: 'response.reasoning_summary_text.delta', item_id: r.id, output_index: r.idx, summary_index: 0, delta: delta.reasoning_content });
    }

    // Tool call deltas
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const i = tc.index ?? 0;
        if (!this.toolCalls[i]) this.toolCalls[i] = { id: undefined, name: '', arguments: '', idx: null, opened: false };
        const e = this.toolCalls[i];
        if (tc.id) e.id = tc.id;
        if (tc.function?.name)      e.name      += tc.function.name;
        if (tc.function?.arguments) e.arguments += tc.function.arguments;

        if (e.id && !e.opened) {
          e.idx = this.nextIdx++;
          e.opened = true;
          this._send('response.output_item.added', { type: 'response.output_item.added', output_index: e.idx, item: { type: 'function_call', id: 'fc_' + e.id, call_id: e.id, name: e.name, arguments: '', status: 'in_progress' } });
        }
        if (tc.function?.arguments && e.opened) {
          this._send('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: 'fc_' + e.id, output_index: e.idx, delta: tc.function.arguments });
        }
      }
    }

    // Content delta
    if (delta.content) {
      const m = this.message;
      if (!m.opened) {
        m.id = 'msg_' + Math.random().toString(36).slice(2, 10);
        m.idx = this.nextIdx++;
        this._send('response.output_item.added', { type: 'response.output_item.added', output_index: m.idx, item: { type: 'message', id: m.id, role: 'assistant', status: 'in_progress', content: [] } });
        this._send('response.content_part.added', { type: 'response.content_part.added', item_id: m.id, output_index: m.idx, content_index: 0, part: { type: 'output_text', text: '' } });
        m.opened = true;
      }
      m.text += delta.content;
      this._send('response.output_text.delta', { type: 'response.output_text.delta', item_id: m.id, output_index: m.idx, content_index: 0, delta: delta.content });
    }
  }

  end() {
    const r = this.reasoning, m = this.message;
    const outputByIdx = {};

    if (r.opened) {
      this._send('response.reasoning_summary_text.done',  { type: 'response.reasoning_summary_text.done',  item_id: r.id, output_index: r.idx, summary_index: 0, text: r.text });
      this._send('response.reasoning_summary_part.done',  { type: 'response.reasoning_summary_part.done',  item_id: r.id, output_index: r.idx, summary_index: 0, part: { type: 'summary_text', text: r.text } });
      this._send('response.output_item.done', { type: 'response.output_item.done', output_index: r.idx, item: { type: 'reasoning', id: r.id, summary: [{ type: 'summary_text', text: r.text }] } });
      outputByIdx[r.idx] = { type: 'reasoning', id: r.id, summary: [{ type: 'summary_text', text: r.text }] };
    }

    for (const e of Object.values(this.toolCalls)) {
      if (!e.opened) continue;
      this._send('response.function_call_arguments.done', { type: 'response.function_call_arguments.done', item_id: 'fc_' + e.id, output_index: e.idx, arguments: e.arguments });
      this._send('response.output_item.done', { type: 'response.output_item.done', output_index: e.idx, item: { type: 'function_call', id: 'fc_' + e.id, call_id: e.id, name: e.name, arguments: e.arguments, status: 'completed' } });
      outputByIdx[e.idx] = { type: 'function_call', id: 'fc_' + e.id, call_id: e.id, name: e.name, arguments: e.arguments, status: 'completed' };
    }

    if (m.opened) {
      this._send('response.output_text.done',    { type: 'response.output_text.done',    item_id: m.id, output_index: m.idx, content_index: 0, text: m.text });
      this._send('response.content_part.done',   { type: 'response.content_part.done',   item_id: m.id, output_index: m.idx, content_index: 0, part: { type: 'output_text', text: m.text } });
      this._send('response.output_item.done',    { type: 'response.output_item.done',    output_index: m.idx, item: { type: 'message', id: m.id, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: m.text }] } });
      outputByIdx[m.idx] = { type: 'message', id: m.id, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: m.text }] };
    }

    const output = Object.keys(outputByIdx).sort((a, b) => a - b).map(k => outputByIdx[k]);
    const u = this.usageFinal;
    this._send('response.completed', {
      type: 'response.completed',
      response: {
        id: this.id, object: 'response', created_at: Math.floor(Date.now() / 1000),
        status: 'completed', model: this.model, output,
        ...(u ? { usage: { input_tokens: u.prompt_tokens ?? 0, output_tokens: u.completion_tokens ?? 0, total_tokens: u.total_tokens ?? 0 } } : {}),
      },
    });
  }
}

// ── /v1/responses handler ─────────────────────────────────────────────────────

async function handleResponsesTranslated(req, res, responsesBody, started) {
  // Convert Responses API → chat/completions
  const chatBody = responsesBodyToChatBody(responsesBody);

  // Patch reasoning_content into history (same logic as for Cursor requests)
  const patched = patchRequestMessages(chatBody);

  const forwardBody = Buffer.from(JSON.stringify(chatBody));
  const headers = cleanReqHeaders(req.headers, UPSTREAM_API_KEY || '');
  headers['content-type'] = 'application/json';

  const targetUrl = UPSTREAM_URL + '/v1/chat/completions';
  if (LOG) console.log(`[responses] POST /v1/responses → ${targetUrl} (model=${responsesBody.model} stream=${chatBody.stream} patched=${patched})`);

  let upstream;
  try {
    upstream = await fetch(targetUrl, { method: 'POST', headers, body: forwardBody, redirect: 'manual' });
  } catch (err) {
    console.error('[responses] upstream fetch failed:', err);
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Upstream unreachable', type: 'proxy_error' } }));
    return;
  }

  const upCtype = (upstream.headers.get('content-type') || '').toLowerCase();

  // Streaming path
  if (chatBody.stream && upstream.body && upCtype.includes('text/event-stream')) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });

    const respId = 'resp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const adapter = new ResponsesStreamAdapter(res, respId, responsesBody.model);
    adapter.start();

    // Also collect for reasoning cache
    let reasoningBuf = '', contentBuf = '';
    const toolCallsBuf = [];

    const inspector = makeStreamInspector(obj => {
      const d = obj?.choices?.[0]?.delta;
      if (d?.reasoning_content)            reasoningBuf += d.reasoning_content;
      if (typeof d?.content === 'string')  contentBuf   += d.content;
      if (Array.isArray(d?.tool_calls)) {
        for (const tc of d.tool_calls) {
          const i = tc.index ?? 0;
          if (!toolCallsBuf[i]) toolCallsBuf[i] = { id: undefined };
          if (tc.id) toolCallsBuf[i].id = tc.id;
        }
      }
      adapter.pushDelta(obj);
    });

    const decoder = new TextDecoder();
    try {
      for await (const chunk of upstream.body) {
        inspector.push(decoder.decode(chunk, { stream: true }));
      }
    } catch (err) {
      if (LOG) console.log(`[responses-stream] aborted: ${err.message}`);
    }

    adapter.end();
    res.end();
    rememberReasoning({ toolCalls: toolCallsBuf, content: contentBuf || null, reasoning: reasoningBuf });
    if (LOG) console.log(`[responses] done in ${Date.now() - started}ms`);
    return;
  }

  // Non-streaming path
  const arr = new Uint8Array(await upstream.arrayBuffer());
  if (!upstream.ok) {
    res.writeHead(upstream.status, { 'content-type': 'application/json' });
    res.end(Buffer.from(arr));
    if (LOG) console.log(`[responses] upstream error ${upstream.status} in ${Date.now() - started}ms`);
    return;
  }

  let chatResp;
  try { chatResp = JSON.parse(Buffer.from(arr).toString('utf8')); } catch {}
  if (!chatResp) { res.writeHead(502); res.end(); return; }

  const msg = chatResp.choices?.[0]?.message;
  if (msg?.reasoning_content) {
    rememberReasoning({ toolCalls: msg.tool_calls, content: msg.content, reasoning: msg.reasoning_content });
  }

  const responsesResp = chatRespToResponsesResp(chatResp, responsesBody);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(responsesResp));
  if (LOG) console.log(`[responses] done in ${Date.now() - started}ms`);
}

// ── Main request handler ──────────────────────────────────────────────────────

async function handle(req, res) {
  const started = Date.now();

  // Auth (constant-time): incoming Bearer must equal UPSTREAM_API_KEY.
  const auth = req.headers['authorization'] || '';
  const incoming = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!safeStrEq(incoming, UPSTREAM_API_KEY)) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Unauthorized', type: 'auth_error' } }));
    if (LOG) console.log(`[auth] rejected (${req.method} ${req.url})`);
    return;
  }

  let rawBody;
  try {
    rawBody = await readBody(req, MAX_BODY_BYTES);
  } catch (err) {
    if (err.code === 'BODY_TOO_LARGE') {
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Request body exceeds ${MAX_BODY_BYTES} bytes`, type: 'invalid_request_error' } }));
      return;
    }
    throw err;
  }

  let parsed = null;
  if (rawBody.length && (req.headers['content-type'] || '').toLowerCase().includes('application/json')) {
    try { parsed = JSON.parse(rawBody.toString('utf8')); } catch {}
  }

  // Route /v1/responses to the translation layer
  const urlPath = req.url.split('?')[0];
  if (req.method === 'POST' && urlPath === '/v1/responses' && parsed) {
    await handleResponsesTranslated(req, res, parsed, started);
    return;
  }

  // ── Pass-through proxy (existing behaviour) ───────────────────────────────
  let patchedCount = 0;
  if (parsed) patchedCount = patchRequestMessages(parsed);

  const forwardBody = parsed ? Buffer.from(JSON.stringify(parsed)) : rawBody;
  const headers = cleanReqHeaders(req.headers, UPSTREAM_API_KEY || '');
  if (parsed) headers['content-type'] = 'application/json';

  let upstream;
  try {
    upstream = await fetch(UPSTREAM_URL + req.url, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : forwardBody,
      redirect: 'manual',
    });
  } catch (err) {
    console.error('[req] upstream fetch failed:', err);
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Upstream unreachable', type: 'proxy_error' } }));
    return;
  }

  const respHeaders = cleanRespHeaders(upstream.headers);
  res.writeHead(upstream.status, respHeaders);
  if (LOG) console.log(`[req] ${req.method} ${req.url} → ${upstream.status} (patched=${patchedCount})`);

  const upCtype = (upstream.headers.get('content-type') || '').toLowerCase();
  if (upstream.body && upCtype.includes('text/event-stream')) {
    let reasoningBuf = '', contentBuf = '';
    const toolCallsBuf = [];
    const inspector = makeStreamInspector(obj => {
      const d = obj?.choices?.[0]?.delta;
      if (!d) return;
      if (d.reasoning_content)             reasoningBuf += d.reasoning_content;
      if (typeof d.content === 'string')   contentBuf   += d.content;
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          const i = tc.index ?? 0;
          if (!toolCallsBuf[i]) toolCallsBuf[i] = { id: undefined };
          if (tc.id) toolCallsBuf[i].id = tc.id;
        }
      }
    });
    const decoder = new TextDecoder();
    try {
      for await (const chunk of upstream.body) {
        res.write(chunk);
        inspector.push(decoder.decode(chunk, { stream: true }));
      }
    } catch (err) { if (LOG) console.log(`[stream] aborted: ${err.message}`); }
    res.end();
    rememberReasoning({ toolCalls: toolCallsBuf, content: contentBuf || null, reasoning: reasoningBuf });
    if (LOG) console.log(`[req] done in ${Date.now() - started}ms`);
    return;
  }

  const arr = new Uint8Array(await upstream.arrayBuffer());
  res.end(Buffer.from(arr));
  if (upCtype.includes('application/json')) {
    try {
      const obj = JSON.parse(Buffer.from(arr).toString('utf8'));
      const msg = obj?.choices?.[0]?.message;
      if (msg?.reasoning_content) rememberReasoning({ toolCalls: msg.tool_calls, content: msg.content, reasoning: msg.reasoning_content });
    } catch {}
  }
  if (LOG) console.log(`[req] done in ${Date.now() - started}ms`);
}

// ── Server ────────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  handle(req, res).catch(err => {
    console.error('handler error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Internal proxy error', type: 'proxy_error' } }));
    } else {
      res.end();
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`cursor-proxer listening on http://${HOST}:${PORT} → ${UPSTREAM_URL}`);
  console.log(`Limits: body ${MAX_BODY_BYTES} B | cache TTL ${CACHE_TTL_MS / 60_000} min | cache max entry ${CACHE_MAX_ENTRY_BYTES} B`);
  console.log('Routes: /v1/responses → translated to /v1/chat/completions | everything else → pass-through');
});
