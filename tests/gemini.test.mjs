// Gemini adapter test with a local MOCK Gemini server (proves request/response format handling, tool loop and DB writes).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 3800 + Math.floor(Math.random() * 300), MOCK = PORT + 400, BASE = `http://localhost:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ems-g-'));
let server, mock, seen = [];

before(async () => {
  mock = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      const body = JSON.parse(b); seen.push({ url: req.url, key: req.headers['x-goog-api-key'], body });
      const last = body.contents.at(-1);
      const fr = last.parts.find((p) => p.functionResponse)?.functionResponse;
      let parts;
      if (!fr) parts = [{ functionCall: { name: 'search_events', args: { keyword: 'business analytics' } } }];
      else if (fr.name === 'search_events') parts = [{ functionCall: { name: 'register_student', args: { event_id: fr.response.result[0].event_id } } }];
      else parts = [{ text: 'Registered: ' + JSON.stringify(fr.response.result.event) }];
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts } }] }));
    });
  }).listen(MOCK);
  server = spawn('node', ['server/index.js'], { env: { PATH: process.env.PATH, PORT, DB_PATH: path.join(tmp, 't.db'), SESSION_SECRET: 'test-secret-test-secret', ADMIN_PASSWORD: 'x', LOGIN_RATE_LIMIT: '1000', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', GOOGLE_REFRESH_TOKEN: '', GEMINI_API_KEY: 'gk', GEMINI_BASE_URL: `http://localhost:${MOCK}`, GEMINI_MODEL: 'gemini-test' }, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { await fetch(BASE + '/api/status'); return; } catch { await new Promise((r) => setTimeout(r, 200)); } }
});
after(() => { server?.kill(); mock?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('Gemini provider: function-calling loop registers a student in the DB', async () => {
  const st = await (await fetch(BASE + '/api/status')).json();
  assert.equal(st.llm, true);
  const login = await (await fetch(BASE + '/api/auth/student/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'karan.mehta@example.com', password: 'Student@123' }) })).json();
  const r = await (await fetch(BASE + '/api/agent/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + login.token }, body: JSON.stringify({ messages: [{ role: 'user', content: 'Register me for the business analytics workshop' }] }) })).json();
  assert.deepEqual(r.actions.map((a) => a.tool), ['search_events', 'register_student']);
  assert.ok(r.actions.every((a) => a.ok), JSON.stringify(r));
  assert.match(r.reply, /Business Analytics Workshop/);
  assert.ok(seen.every((s) => s.key === 'gk' && s.url.includes('gemini-test:generateContent')));
  const tools = seen[0].body.tools[0].functionDeclarations.map((t) => t.name);
  assert.ok(tools.includes('register_student') && !tools.includes('get_participants'));
  const mine = await (await fetch(BASE + '/api/registrations/mine', { headers: { Authorization: 'Bearer ' + login.token } })).json();
  assert.ok(mine.some((m) => m.event_name === 'Business Analytics Workshop'));
});
