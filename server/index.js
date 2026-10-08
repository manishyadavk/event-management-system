import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { seedIfEmpty } from './seed.js';
import { signToken, requireAuth, checkAdminPassword, loginLimiter } from './auth.js';
import { runAgent, confirmationMessage, llmConfigured, LlmError } from './agent.js';
import { calendarConfigured } from './calendar.js';
import * as svc from './services.js';

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 16) {
  console.error('SESSION_SECRET is missing or too short. Copy .env.example to .env and set it.');
  process.exit(1);
}
seedIfEmpty();

const app = express();
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' });
  next();
});
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const intParam = (v) => { const n = Number(v); if (!Number.isInteger(n) || n < 1) throw new svc.HttpError(400, 'Invalid id.'); return n; };
const optStr = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const optDate = (v) => { v = optStr(v); if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new svc.HttpError(400, 'Dates must be YYYY-MM-DD.'); return v; };
// Provider error text and calendar ids stay server-side.
const pub = ({ calendar_error, calendar_event_id, ...r }) => r;
const asUser = (u) => ({ ...u, role: 'student' });

// ---- public ----
app.get('/api/status', (_req, res) => res.json({ llm: llmConfigured(), calendar: calendarConfigured(), categories: svc.CATEGORIES }));
// Landing page preview: upcoming events only, no personal data.
app.get('/api/public/events', (_req, res) => res.json(svc.listEvents({ upcomingOnly: true }).slice(0, 6)));

// ---- auth ----
app.post('/api/auth/student/login', loginLimiter, (req, res) => {
  const s = svc.loginStudent(req.body?.email, req.body?.password);
  res.json({ token: signToken({ role: 'student', student_id: s.student_id }), user: asUser(s) });
});
app.post('/api/auth/student/signup', loginLimiter, (req, res) => {
  const s = svc.signupStudent(req.body || {});
  res.status(201).json({ token: signToken({ role: 'student', student_id: s.student_id }), user: asUser(s) });
});
app.post('/api/auth/admin/login', loginLimiter, (req, res) => {
  if (!checkAdminPassword(req.body?.password)) throw new svc.HttpError(401, 'Incorrect admin password.');
  res.json({ token: signToken({ role: 'admin' }), user: { name: 'Administrator', role: 'admin' } });
});

// ---- events (read: any logged-in user; write: admin) ----
app.get('/api/events', requireAuth(), (req, res) => res.json(svc.listEvents({
  q: optStr(req.query.q), category: optStr(req.query.category), from: optDate(req.query.from), to: optDate(req.query.to), upcomingOnly: req.query.upcoming === 'true',
})));
app.get('/api/events/:id', requireAuth(), (req, res) => {
  const e = svc.getEvent(intParam(req.params.id));
  if (!e) throw new svc.HttpError(404, 'Event not found.');
  res.json(e);
});
app.post('/api/events', requireAuth('admin'), (req, res) => res.status(201).json(svc.createEvent(req.body || {})));
app.put('/api/events/:id', requireAuth('admin'), (req, res) => res.json(svc.updateEvent(intParam(req.params.id), req.body || {})));
app.patch('/api/events/:id', requireAuth('admin'), (req, res) => res.json(svc.updateEvent(intParam(req.params.id), req.body || {})));
app.delete('/api/events/:id', requireAuth('admin'), wrap(async (req, res) => { await svc.deleteEvent(intParam(req.params.id)); res.json({ ok: true }); }));
app.get('/api/events/:id/participants', requireAuth('admin'), (req, res) => {
  const id = intParam(req.params.id);
  if (!svc.getEvent(id)) throw new svc.HttpError(404, 'Event not found.');
  res.json(svc.listParticipants(id));
});

// ---- students (admin only; a student may read only their own record) ----
app.get('/api/students', requireAuth('admin'), (req, res) => res.json(svc.listStudents({ q: optStr(req.query.q) })));
app.post('/api/students', requireAuth('admin'), (req, res) => res.status(201).json(svc.signupStudent(req.body || {})));
app.get('/api/students/:id', requireAuth(), (req, res) => {
  const id = intParam(req.params.id);
  if (req.user.role !== 'admin' && req.user.student_id !== id) throw new svc.HttpError(403, 'Not allowed for your role.');
  const s = svc.getStudent(id);
  if (!s) throw new svc.HttpError(404, 'Student not found.');
  res.json(s);
});
app.get('/api/students/:id/registrations', requireAuth(), (req, res) => {
  const id = intParam(req.params.id);
  if (req.user.role !== 'admin' && req.user.student_id !== id) throw new svc.HttpError(403, 'Not allowed for your role.');
  if (!svc.getStudent(id)) throw new svc.HttpError(404, 'Student not found.');
  res.json(svc.listStudentRegistrations(id).map(pub));
});

// ---- registrations ----
// Workflow: Student -> Backend (validate) -> Database -> Google Calendar -> AI (confirmation text) -> Student
app.post('/api/registrations', requireAuth('student'), wrap(async (req, res) => {
  const reg = await svc.registerForEvent(req.user.student_id, intParam(req.body?.event_id));
  res.status(201).json({ registration: pub(reg), message: await confirmationMessage(reg) });
}));
app.get('/api/registrations/mine', requireAuth('student'), (req, res) => res.json(svc.listStudentRegistrations(req.user.student_id).map(pub)));
app.get('/api/registrations', requireAuth('admin'), (req, res) => res.json(svc.listAllRegistrations({
  eventId: req.query.event_id ? intParam(req.query.event_id) : undefined, q: optStr(req.query.q), status: optStr(req.query.status),
})));
app.get('/api/registrations/:id', requireAuth(), (req, res) => {
  const reg = svc.getRegistration(intParam(req.params.id));
  if (!reg || (req.user.role !== 'admin' && reg.student_id !== req.user.student_id)) throw new svc.HttpError(404, 'Registration not found.');
  res.json(pub(reg));
});
app.delete('/api/registrations/:id', requireAuth('student'), wrap(async (req, res) => res.json(pub(await svc.cancelRegistration(req.user.student_id, intParam(req.params.id))))));
app.post('/api/registrations/:id/retry-calendar', requireAuth('student'), wrap(async (req, res) => {
  const reg = svc.getRegistration(intParam(req.params.id));
  if (!reg || reg.student_id !== req.user.student_id || reg.status !== 'confirmed') throw new svc.HttpError(404, 'Registration not found.');
  if (svc.hasEnded(reg)) throw new svc.HttpError(400, 'This event has already taken place.');
  res.json(pub(await svc.syncCalendar(reg.registration_id)));
}));

// ---- statistics (admin) ----
app.get('/api/admin/dashboard', requireAuth('admin'), (_req, res) => res.json(svc.dashboardStats()));
app.get('/api/stats', requireAuth('admin'), (_req, res) => res.json(svc.dashboardStats()));

// ---- AI agent (student or admin; tools are role-gated inside the agent) ----
app.post('/api/agent/chat', requireAuth(), wrap(async (req, res) => {
  if (!llmConfigured()) throw new svc.HttpError(503, 'The AI assistant is not available right now. Please use the Events page.');
  const msgs = req.body?.messages;
  if (!Array.isArray(msgs) || !msgs.length || msgs[msgs.length - 1].role !== 'user')
    throw new svc.HttpError(400, 'Send a messages array ending with a user message.');
  const clean = msgs.filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim());
  const user = req.user.role === 'admin' ? { role: 'admin' } : { role: 'student', student: svc.getStudent(req.user.student_id) };
  if (user.role === 'student' && !user.student) throw new svc.HttpError(401, 'Please log in.');
  res.json(await runAgent(user, clean));
}));

app.use('/api', (_req, _res, next) => next(new svc.HttpError(404, 'Not found.')));

app.use((err, _req, res, _next) => {
  if (err instanceof svc.HttpError) return res.status(err.status).json({ error: err.message });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body.' });
  if (err instanceof Anthropic.APIError || err instanceof LlmError) {
    console.error('[llm]', err.status, err.message);
    if (/\b429\b/.test(String(err.message))) return res.status(429).json({ error: 'The AI assistant has reached its usage limit. Please wait a minute and try again.' });
    return res.status(502).json({ error: 'The AI service is temporarily unavailable. Please try again, or use the Events page.' });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Event Management System running at http://localhost:${port}`));
