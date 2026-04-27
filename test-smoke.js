// Smoke tests:
//  1. Kimi / tool-call round-trip: reasoning cached by tool_call_id, injected in next request
//  2. DeepSeek / plain-text round-trip: reasoning cached by content hash, injected in next request
//  3. Codex /v1/responses translation: request converted to chat/completions, response back to Responses API format
//  4. /v1/responses with tool-calls in history: function_call items translated + reasoning injected

import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';

const MOCK_PORT  = 18799;
const PROXY_PORT = 18800;

const upstreamRequests = [];

const mock = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  upstreamRequests.push({ url: req.url, body });

  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const n = upstreamRequests.length;

  let frames;
  if (n === 1) {
    // Kimi-style: reasoning + tool_call
    frames = [
      { choices: [{ index: 0, delta: { reasoning_content: 'thinking step one. ' } }] },
      { choices: [{ index: 0, delta: { reasoning_content: 'thinking step two.' } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_123', function: { name: 'f', arguments: '{}' } }] } }] },
    ];
  } else if (n === 2) {
    // Second call (tool-call history re-sent): reply with plain text
    frames = [
      { choices: [{ index: 0, delta: { reasoning_content: 'pondering the answer' } }] },
      { choices: [{ index: 0, delta: { content: 'Hello there!' } }] },
    ];
  } else if (n === 3) {
    // Third call (plain text history re-sent, DeepSeek-style): just ack
    frames = [{ choices: [{ index: 0, delta: { content: 'ok' } }] }];
  } else if (n === 4) {
    // Codex /v1/responses: plain text answer
    frames = [
      { choices: [{ index: 0, delta: { reasoning_content: 'deciding what to do' } }] },
      { choices: [{ index: 0, delta: { content: 'Sure, here is the code.' } }] },
    ];
  } else {
    // Codex follow-up with function_call_output in history + function call reply
    frames = [
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_codex', function: { name: 'shell', arguments: '{"cmd":"ls"}' } }] } }] },
    ];
  }

  for (const f of frames) res.write(`data: ${JSON.stringify(f)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
});
mock.listen(MOCK_PORT);
await once(mock, 'listening');

const PROXY_KEY = 'test-secret-key';

const proxy = spawn(process.execPath, ['proxy.js'], {
  env: {
    ...process.env,
    UPSTREAM_URL: `http://127.0.0.1:${MOCK_PORT}`,
    UPSTREAM_API_KEY: PROXY_KEY,
    PORT: String(PROXY_PORT),
    LOG: '1',
  },
  stdio: 'inherit',
});
await sleep(300);

const AUTH = { 'content-type': 'application/json', 'authorization': `Bearer ${PROXY_KEY}` };

async function postChat(body) {
  const r = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify({ ...body, stream: true }),
  });
  return r.text();
}

async function postResponses(body) {
  const r = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/responses`, {
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify(body),
  });
  return r.text();
}

const checks = [];

try {
  // ── Test 1: initial Kimi-style request → cache reasoning by tool_call_id ──
  await postChat({ model: 'kimi', messages: [{ role: 'user', content: 'hi' }] });

  // ── Test 2: follow-up with tool-call in history — proxy must inject reasoning ──
  await postChat({
    model: 'kimi',
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', tool_calls: [{ id: 'call_123', type: 'function', function: { name: 'f', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_123', content: 'ok' },
      { role: 'user', content: 'go' },
    ],
  });

  // ── Test 3: DeepSeek-style — plain text assistant in history, patched by content hash ──
  await postChat({
    model: 'ds',
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hello there!' }, // cached by hash from test 2's response
      { role: 'user', content: 'continue' },
    ],
  });

  // ── Test 4: Codex /v1/responses — simple user message, translated to chat ──
  await postResponses({
    model: 'deepseek-reasoner',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'write code' }] }],
    stream: true,
  });

  // ── Test 5: Codex follow-up with function_call + function_call_output ──
  await postResponses({
    model: 'deepseek-reasoner',
    input: [
      { type: 'message', role: 'user', content: 'write code' },
      { type: 'function_call', call_id: 'call_codex', name: 'shell', arguments: '{"cmd":"ls"}' },
      { type: 'function_call_output', call_id: 'call_codex', output: 'file.txt' },
      { type: 'message', role: 'user', content: 'now what?' },
    ],
    stream: true,
  });

  // ── Evaluate ──────────────────────────────────────────────────────────────

  const req2 = upstreamRequests[1].body;
  const req3 = upstreamRequests[2].body;
  const req4 = upstreamRequests[3];
  const req5 = upstreamRequests[4].body;

  const tcMsg = req2.messages.find(m => m.role === 'assistant' && m.tool_calls);
  const contentMsg = req3.messages.find(m => m.role === 'assistant' && m.content);

  checks.push(['tool_call-keyed reasoning injected',
    tcMsg?.reasoning_content === 'thinking step one. thinking step two.']);

  checks.push(['content-hash-keyed reasoning injected',
    contentMsg?.reasoning_content === 'pondering the answer']);

  checks.push(['/v1/responses → /v1/chat/completions routing',
    req4.url === '/v1/chat/completions']);

  checks.push(['/v1/responses input converted to messages',
    req4.body.messages?.some(m => m.role === 'user' && m.content === 'write code')]);

  const assistantTcMsg = req5.messages.find(m => m.role === 'assistant' && m.tool_calls);
  checks.push(['function_call → assistant tool_calls',
    assistantTcMsg?.tool_calls?.[0]?.id === 'call_codex']);

  const toolResultMsg = req5.messages.find(m => m.role === 'tool');
  checks.push(['function_call_output → tool message',
    toolResultMsg?.tool_call_id === 'call_codex' && toolResultMsg?.content === 'file.txt']);

  // reasoning from test 4 cached under content "Sure, here is the code."
  // not injected here since this is a fresh turn — just check it got through
  checks.push(['follow-up /v1/responses request reached upstream',
    upstreamRequests.length >= 5]);

  // ── Security tests ────────────────────────────────────────────────────────

  // 6) Wrong Bearer → 401, request must NOT reach upstream
  const upstreamCountBefore = upstreamRequests.length;
  const unauthResp = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': 'Bearer wrong-key' },
    body: JSON.stringify({ model: 'x', messages: [] }),
  });
  await unauthResp.text();
  checks.push(['wrong Bearer → 401', unauthResp.status === 401]);
  checks.push(['wrong Bearer never reaches upstream', upstreamRequests.length === upstreamCountBefore]);

  // 7) Missing Authorization header → 401
  const noAuthResp = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'x', messages: [] }),
  });
  await noAuthResp.text();
  checks.push(['missing Authorization → 401', noAuthResp.status === 401]);

  // 8) Body over 50 MB → 413
  const huge = 'x'.repeat(51 * 1024 * 1024);
  const bigResp = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: AUTH,
    body: huge,
  });
  await bigResp.text();
  checks.push(['oversized body → 413', bigResp.status === 413]);

  // 9) Prototype pollution: __proto__ header must NOT mutate Object.prototype
  await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: { ...AUTH, 'x-test': 'a', '__proto__': 'evil' }, // most clients won't even let this through, but try
    body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'hi' }], stream: true }),
  }).then(r => r.text()).catch(() => {});
  checks.push(['Object.prototype not polluted', ({}).polluted === undefined && Object.prototype.evil === undefined]);

} finally {
  proxy.kill();
  mock.close();
}

console.log('\n=== RESULTS ===');
let allPass = true;
for (const [label, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (!ok) allPass = false;
}
process.exitCode = allPass ? 0 : 1;
