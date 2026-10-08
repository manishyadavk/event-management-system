// End-to-end API tests: spawns the real server against a throw-away SQLite file.
// The Anthropic API is replaced by a tiny local MOCK that scripts tool calls, so these tests exercise OUR agent loop,
// tool dispatch, role gating and database writes - not the real model. Google Calendar is intentionally unconfigured,
// which exercises the real failure-handling path. Run: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 3300 + Math.floor(Math.random() * 400), MOCK = PORT + 500;
const BASE = `http://localhost:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ems-'));
let server, mock;

const call = async (p, { method = 'GET', body, token } = {}) => {
  const r = await fetch(BASE + '/api' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};
const login = async (email, password = 'Student@123') => (await call('/auth/student/login', { method: 'POST', body: { email, password } })).data.token;
const adminLogin = async () => (await call('/auth/admin/login', { method: 'POST', body: { password: 'admin-test-pw' } })).data.token;
const chat = (token, text) => call('/agent/chat', { method: 'POST', token, body: { messages: [{ role: 'user', content: text }] } });

function startMock() {
  const scripts = [
    [/register me for the business analytics/i, [{ name: 'search_events', input: { keyword: 'business analytics' } }, (prev) => ({ name: 'register_student', input: { event_id: prev[0].event_id } })]],
    [/how many students/i, [{ name: 'get_registration_count', input: {} }]],
    [/am i registered for the business/i, [{ name: 'get_student_registrations', input: { keyword: 'business analytics' } }]],
    [/which ai workshops/i, [{ name: 'search_events', input: { keyword: 'AI' } }]],
    [/participants/i, [{ name: 'get_participants', input: { keyword: 'cybersecurity' } }]],
    [/stats/i, [{ name: 'get_admin_statistics', input: {} }]],
  ];
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
        const body = JSON.parse(b || '{}');
        const msgs = body.messages;
        const firstUser = [...msgs].reverse().find((m) => m.role === 'user' && typeof m.content === 'string');
        const results = msgs.filter((m) => Array.isArray(m.content) && m.content[0]?.type === 'tool_result');
        const script = scripts.find(([re]) => re.test(firstUser?.content || ''))?.[1] || [];
        const lastRes = results.length ? JSON.parse(results.at(-1).content[0].content) : null;
        let content, stop;
        if (results.length < script.length) {
          const step = script[results.length];
          const t = typeof step === 'function' ? step(lastRes) : step;
          content = [{ type: 'tool_use', id: 'tu_' + results.length, name: t.name, input: t.input }]; stop = 'tool_use';
          body.__offered = (body.tools || []).map((x) => x.name);
        } else {
          content = [{ type: 'text', text: 'RESULT ' + JSON.stringify({ tools_offered: (body.tools || []).map((x) => x.name), last: lastRes }) }]; stop = 'end_turn';
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ id: 'msg_x', type: 'message', role: 'assistant', model: body.model, content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }));
      });
    }).listen(MOCK, resolve);
    mock = s;
  });
}

before(async () => {
  await startMock();
  server = spawn('node', ['server/index.js'], {
    env: { PATH: process.env.PATH, PORT, DB_PATH: path.join(tmp, 't.db'), SESSION_SECRET: 'test-secret-test-secret', ADMIN_PASSWORD: 'admin-test-pw', LOGIN_RATE_LIMIT: '100000', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', GOOGLE_REFRESH_TOKEN: '', GEMINI_API_KEY: '', ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: `http://localhost:${MOCK}`, ANTHROPIC_MODEL: 'mock' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 100; i++) { try { await fetch(BASE + '/api/status'); return; } catch { await new Promise((r) => setTimeout(r, 200)); } }
  throw new Error('server did not start');
});
after(() => { server?.kill(); mock?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('seed data + auth', async () => {
  assert.equal((await call('/events')).status, 401);
  assert.equal((await call('/auth/student/login', { method: 'POST', body: { email: 'aarav.sharma@example.com', password: 'wrong' } })).status, 401);
  assert.equal((await call('/auth/admin/login', { method: 'POST', body: { password: 'nope' } })).status, 401);
  const t = await login('aarav.sharma@example.com');
  const evs = (await call('/events', { token: t })).data;
  assert.ok(evs.length >= 6);
  assert.ok(evs.every((e) => e.category && e.seats_left >= 0));
  const s = (await adminLogin());
  assert.ok((await call('/students', { token: s })).data.length >= 5);
  assert.ok(!JSON.stringify((await call('/students', { token: s })).data).includes('password'));
});

test('filters: category, date range, keyword is word-aware', async () => {
  const t = await login('aarav.sharma@example.com');
  const ai = (await call('/events?category=AI', { token: t })).data;
  assert.ok(ai.length >= 2 && ai.every((e) => e.category === 'AI'));
  const kw = (await call('/events?q=AI', { token: t })).data.map((e) => e.name);
  assert.ok(kw.includes('AI & Machine Learning Workshop'));
  assert.ok(!kw.includes('Cybersecurity Workshop'), 'AI must not match "certain"-style substrings');
  assert.equal((await call('/events?from=2999-01-01', { token: t })).data.length, 0);
});

test('registration: success, duplicate, full, past, authz, DB state', async () => {
  const t = await login('sneha.iyer@example.com');
  const events = (await call('/events', { token: t })).data;
  const web = events.find((e) => e.name.startsWith('Web Development'));
  const before = web.registered;
  const r = await call('/registrations', { method: 'POST', token: t, body: { event_id: web.event_id } });
  assert.equal(r.status, 409, 'Sneha is already registered for Web Dev in the seed');

  const target = events.find((e) => e.name.startsWith('Data Science'));
  const ok = await call('/registrations', { method: 'POST', token: t, body: { event_id: target.event_id } });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.registration.status, 'confirmed');
  // No Google credentials in the test env -> registration stays saved, calendar marked failed, message says so
  assert.equal(ok.data.registration.calendar_status, 'failed');
  assert.match(ok.data.message, /Google Calendar synchronization failed/);
  assert.ok(!JSON.stringify(ok.data).includes('GOOGLE_'), 'raw provider/config errors must not leak');
  assert.equal((await call('/events/' + target.event_id, { token: t })).data.registered, target.registered + 1);

  const dup = await call('/registrations', { method: 'POST', token: t, body: { event_id: target.event_id } });
  assert.equal(dup.status, 409);
  assert.equal(dup.data.error, 'You are already registered for this event.');
  assert.equal((await call('/events/' + web.event_id, { token: t })).data.registered, before);

  const retry = await call(`/registrations/${ok.data.registration.registration_id}/retry-calendar`, { method: 'POST', token: t });
  assert.equal(retry.status, 200);
  assert.equal(retry.data.calendar_status, 'failed');

  // capacity: Cybersecurity is seeded 6/6
  const cyber = events.find((e) => e.name.startsWith('Cybersecurity'));
  assert.equal(cyber.seats_left, 0);
  const t2 = await login('meera.nair@example.com');
  const full = await call('/registrations', { method: 'POST', token: t2, body: { event_id: cyber.event_id } });
  assert.equal(full.status, 409);
  assert.match(full.data.error, /full/i);

  const past = events.find((e) => e.name.startsWith('Career Readiness')) || (await call('/events', { token: t })).data.find((e) => e.name.startsWith('Career'));
  const pr = await call('/registrations', { method: 'POST', token: t, body: { event_id: past.event_id } });
  assert.equal(pr.status, 400);

  assert.equal((await call('/registrations', { method: 'POST', token: t, body: { event_id: 99999 } })).status, 404);
  assert.equal((await call('/registrations', { method: 'POST', token: t, body: {} })).status, 400);
  assert.equal((await call('/registrations', { method: 'POST', token: await adminLogin(), body: { event_id: target.event_id } })).status, 403);
});

test('authorization: students cannot reach admin data', async () => {
  const t = await login('aarav.sharma@example.com');
  for (const p of ['/students', '/registrations', '/admin/dashboard', '/stats', '/events/1/participants'])
    assert.equal((await call(p, { token: t })).status, 403, p);
  assert.equal((await call('/events', { method: 'POST', token: t, body: {} })).status, 403);
  assert.equal((await call('/events/1', { method: 'DELETE', token: t })).status, 403);
  assert.equal((await call('/students/2', { token: t })).status, 403); // someone else's record
  assert.equal((await call('/students/1', { token: t })).status, 200);
  assert.equal((await call('/students/2/registrations', { token: t })).status, 403);
  assert.equal((await call('/events', { token: 'garbage.token' })).status, 401);
});

test('admin: event CRUD, validation, participants, stats', async () => {
  const a = await adminLogin();
  const bad = await call('/events', { method: 'POST', token: a, body: { name: 'x', date: 'nope', time: '25:00', venue: '', max_capacity: 0, category: 'Zzz' } });
  assert.equal(bad.status, 400);
  const created = await call('/events', { method: 'POST', token: a, body: { name: 'Test Event', description: 'd', category: 'Technology', date: '2999-01-01', time: '10:00', venue: 'Lab', max_capacity: 5 } });
  assert.equal(created.status, 201);
  const id = created.data.event_id;
  assert.equal((await call('/events/' + id, { method: 'PUT', token: a, body: { name: 'Renamed', max_capacity: 8 } })).data.name, 'Renamed');
  const stu = await login('priya.verma@example.com');
  await call('/registrations', { method: 'POST', token: stu, body: { event_id: id } });
  assert.equal((await call('/events/' + id + '/participants', { token: a })).data.length, 1);
  assert.equal((await call('/events/' + id, { method: 'PUT', token: a, body: { max_capacity: 0 } })).status, 400);
  assert.equal((await call('/registrations?event_id=' + id + '&q=priya', { token: a })).data.length, 1);
  const stats = (await call('/admin/dashboard', { token: a })).data;
  assert.ok(stats.total_registrations > 10 && stats.popular_events.length && stats.recent_registrations.length && stats.upcoming.length);
  assert.equal((await call('/events/' + id, { method: 'DELETE', token: a })).status, 200);
  assert.equal((await call('/events/' + id, { token: a })).status, 404);
  const ns = await call('/students', { method: 'POST', token: a, body: { name: 'New Kid', email: 'new.kid@example.com', course: 'BCA', password: 'longenough1' } });
  assert.equal(ns.status, 201);
  assert.equal((await call('/students', { method: 'POST', token: a, body: { name: 'Dup', email: 'new.kid@example.com', course: 'BCA', password: 'longenough1' } })).status, 409);
});

test('AI agent: tool calls hit the real database (mocked LLM)', async () => {
  const t = await login('rohan.gupta@example.com');
  assert.equal((await call('/agent/chat', { method: 'POST', body: { messages: [] } })).status, 401);

  let r = await chat(t, 'Which AI workshops are happening this month?');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.actions.map((a) => a.tool), ['search_events']);
  assert.match(r.data.reply, /AI & Machine Learning Workshop/);

  r = await chat(t, 'How many students have registered?');
  const total = JSON.parse(r.data.reply.slice(7)).last.total_confirmed_registrations;
  assert.ok(total >= 18);

  // Rohan is registered for Business Analytics in the seed
  r = await chat(t, 'Am I registered for the business analytics workshop?');
  assert.match(r.data.reply, /"registration_status":"confirmed"/);

  // Student-only tools offered; admin tools not offered
  const offered = JSON.parse(r.data.reply.slice(7)).tools_offered;
  assert.ok(offered.includes('register_student') && !offered.includes('get_participants'));

  // Register a student who is NOT yet registered -> real DB write
  const t2 = await login('karan.mehta@example.com');
  const regs0 = (await call('/registrations/mine', { token: t2 })).data.length;
  r = await chat(t2, 'Register me for the business analytics workshop');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.actions.map((a) => a.tool), ['search_events', 'register_student']);
  assert.ok(r.data.actions.every((a) => a.ok));
  assert.equal((await call('/registrations/mine', { token: t2 })).data.length, regs0 + 1);
  // doing it again hits the duplicate rule through the same service layer
  r = await chat(t2, 'Register me for the business analytics workshop');
  assert.equal(r.data.actions[1].ok, false);
  assert.match(r.data.reply, /already registered/);
});

test('AI agent: role gating is enforced server-side', async () => {
  const t = await login('rohan.gupta@example.com');
  const r = await chat(t, 'List the participants'); // mock calls get_participants regardless of what was offered
  assert.equal(r.data.actions[0].ok, false);
  assert.match(r.data.reply, /not permitted/);
  assert.ok(!r.data.reply.includes('@example.com'), 'no participant emails may leak to a student');

  const a = await adminLogin();
  const ar = await chat(a, 'List the participants');
  assert.equal(ar.data.actions[0].ok, true);
  assert.match(ar.data.reply, /@example\.com/);
  assert.ok(!JSON.parse(ar.data.reply.slice(7)).tools_offered.includes('register_student'));
  assert.ok((await chat(a, 'show stats')).data.reply.includes('total_registrations'));
});
