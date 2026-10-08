// LLM agent: Claude decides which application tool to call, the backend executes it, results go back to Claude.
// Every tool runs through the same service layer as the REST API, and is gated by the caller's role on the SERVER.
import Anthropic from '@anthropic-ai/sdk';
import * as svc from './services.js';

// LLM provider: Google Gemini if GEMINI_API_KEY is set, otherwise Anthropic Claude if ANTHROPIC_API_KEY is set.
// (LLM_PROVIDER=gemini|anthropic forces one.) Tools, permissions and the loop are identical for both.
export class LlmError extends Error {}
const provider = () => {
  const p = (process.env.LLM_PROVIDER || '').toLowerCase();
  if (p === 'gemini' || p === 'anthropic') return p;
  return process.env.GEMINI_API_KEY ? 'gemini' : 'anthropic';
};
export const llmConfigured = () => !!(provider() === 'gemini' ? process.env.GEMINI_API_KEY : process.env.ANTHROPIC_API_KEY);
export const llmName = () => (provider() === 'gemini' ? process.env.GEMINI_MODEL || 'gemini-3.8-flash' : process.env.ANTHROPIC_MODEL || 'claude-opus-5-5');

let client;
const anthropic = () => (client ??= new Anthropic()); // reads ANTHROPIC_API_KEY (and optional base URL) from env

async function geminiCall(body) {
  const base = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1000 * attempt));
    let r;
    try {
      r = await fetch(`${base}/v1beta/models/${llmName()}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY }, body: JSON.stringify(body),
        signal: AbortSignal.timeout(45000),
      });
    } catch (e) { lastErr = new LlmError('Gemini request failed: ' + e.message); continue; }
    const data = await r.json().catch(() => ({}));
    if (r.ok) return data;
    lastErr = new LlmError(`Gemini ${r.status}: ${data?.error?.message || 'request failed'}`);
    if (![500, 502, 503, 504].includes(r.status)) break; // only transient errors are retried
  }
  throw lastErr;
}

// Each adapter: start(history) -> state; step(state, system, tools) -> {text, calls, refusal}; addResults(state, results)
const adapters = {
  anthropic: {
    start: (history) => ({ messages: history.map((m) => ({ role: m.role, content: m.content })) }),
    async step(st, system, tools) {
      const res = await anthropic().messages.create({ model: llmName(), max_tokens: 2048, system, tools, messages: st.messages, output_config: { effort: 'low' } });
      if (res.stop_reason === 'refusal') return { refusal: true, calls: [] };
      st.messages.push({ role: 'assistant', content: res.content });
      const calls = res.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, input: b.input || {} }));
      return { text: res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim(), calls: res.stop_reason === 'tool_use' ? calls : [] };
    },
    addResults(st, results) {
      st.messages.push({ role: 'user', content: results.map((r) => ({ type: 'tool_result', tool_use_id: r.call.id, content: JSON.stringify(r.out), is_error: r.isError })) });
    },
  },
  gemini: {
    start: (history) => ({ contents: history.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })) }),
    async step(st, system, tools) {
      const decls = tools.map((t) => ({ name: t.name, description: t.description, ...(Object.keys(t.input_schema.properties || {}).length ? { parameters: t.input_schema } : {}) }));
      const data = await geminiCall({ systemInstruction: { parts: [{ text: system }] }, contents: st.contents, tools: [{ functionDeclarations: decls }], generationConfig: { temperature: 0.2, thinkingConfig: { thinkingLevel: process.env.GEMINI_THINKING || 'low' } } });
      const cand = data.candidates?.[0];
      if (!cand?.content?.parts?.length) return { refusal: true, calls: [] };
      st.contents.push({ role: 'model', parts: cand.content.parts }); // keep parts verbatim (incl. any thought signatures)
      const calls = cand.content.parts.filter((p) => p.functionCall).map((p, i) => ({ id: String(i), name: p.functionCall.name, input: p.functionCall.args || {} }));
      return { text: cand.content.parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('\n').trim(), calls };
    },
    addResults(st, results) {
      st.contents.push({ role: 'user', parts: results.map((r) => ({ functionResponse: { name: r.call.name, response: { result: r.out } } })) });
    },
  },
};

/** One-shot text completion (used for the registration confirmation message). */
async function complete(system, userText) {
  if (provider() === 'gemini') {
    const d = await geminiCall({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: userText }] }] });
    return (d.candidates?.[0]?.content?.parts || []).filter((p) => p.text && !p.thought).map((p) => p.text).join(' ').trim();
  }
  const res = await anthropic().messages.create({ model: llmName(), max_tokens: 400, output_config: { effort: 'low' }, system, messages: [{ role: 'user', content: userText }] });
  return res.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
}

const dateProps = {
  from_date: { type: 'string', description: 'YYYY-MM-DD inclusive' },
  to_date: { type: 'string', description: 'YYYY-MM-DD inclusive' },
};
const eventRef = {
  event_id: { type: 'integer', description: 'Event id from a previous search/list result' },
  keyword: { type: 'string', description: 'Event name keyword if the id is unknown, e.g. "business analytics"' },
};

// roles: who may call the tool. Enforced in dispatch(), not just by what we show the model.
const TOOLS = [
  { roles: ['student', 'admin'], name: 'get_events', description: 'List events, optionally by category and/or date range. Use for "show upcoming events", "events this month", "technology events".',
    input_schema: { type: 'object', properties: { category: { type: 'string', enum: svc.CATEGORIES }, upcoming_only: { type: 'boolean' }, ...dateProps } } },
  { roles: ['student', 'admin'], name: 'search_events', description: 'Search events by keyword (name/category/description) with optional date range. Use for "which AI workshops are happening this month?".',
    input_schema: { type: 'object', properties: { keyword: { type: 'string' }, ...dateProps }, required: ['keyword'] } },
  { roles: ['student', 'admin'], name: 'get_event_details', description: 'Full details of one event: description, date, time, venue, capacity, registrations and seats left.',
    input_schema: { type: 'object', properties: eventRef } },
  { roles: ['student', 'admin'], name: 'get_registration_count', description: 'Count confirmed registrations. With an event (id or keyword) counts for matching events; with neither, the total across all events.',
    input_schema: { type: 'object', properties: eventRef } },
  { roles: ['student'], name: 'get_student_details', description: "Profile of the CURRENT student (name, email, course).", input_schema: { type: 'object', properties: {} } },
  { roles: ['admin'], name: 'get_student_details', description: 'Look up a student by email or name (admin only).',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'email or part of the name' } }, required: ['query'] } },
  { roles: ['student'], name: 'get_student_registrations', description: "The CURRENT student's registrations; with a keyword, checks whether they are registered for matching events (use for \"Am I registered for ...?\").",
    input_schema: { type: 'object', properties: { keyword: { type: 'string' } } } },
  { roles: ['student'], name: 'register_student', description: "Register the CURRENT student for an event: checks the event, capacity and duplicates, writes the registration to the database and creates a Google Calendar event. Pass event_id from search_events/get_event_details. If the request matches several events, ask which one instead of guessing.",
    input_schema: { type: 'object', properties: { event_id: { type: 'integer' } }, required: ['event_id'] } },
  { roles: ['student'], name: 'cancel_registration', description: "Cancel the CURRENT student's registration (only when explicitly asked).",
    input_schema: { type: 'object', properties: { event_id: { type: 'integer' } }, required: ['event_id'] } },
  { roles: ['admin'], name: 'get_participants', description: 'List participants (name, email, course, status) for an event (admin only).',
    input_schema: { type: 'object', properties: eventRef } },
  { roles: ['admin'], name: 'get_admin_statistics', description: 'Dashboard statistics: totals, upcoming events, popular events, recent registrations (admin only).',
    input_schema: { type: 'object', properties: {} } },
  { roles: ['admin'], name: 'create_event', description: 'Create a new event (admin only). Ask for any missing field first.',
    input_schema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, category: { type: 'string', enum: svc.CATEGORIES }, date: { type: 'string' }, time: { type: 'string', description: 'HH:MM 24h' }, venue: { type: 'string' }, max_capacity: { type: 'integer' } }, required: ['name', 'category', 'date', 'time', 'venue', 'max_capacity'] } },
];

const brief = (e) => ({ event_id: e.event_id, name: e.name, category: e.category, date: e.date, time: e.time, venue: e.venue, max_capacity: e.max_capacity, registered: e.registered, seats_left: e.seats_left });
const eventsRange = (i) => ({ q: i.keyword, from: i.from_date, to: i.to_date, category: i.category, upcomingOnly: i.upcoming_only });

function resolveEvents(input) {
  if (input.event_id) { const e = svc.getEvent(Number(input.event_id)); return e ? [e] : []; }
  return input.keyword ? svc.listEvents({ q: input.keyword }) : [];
}

// ctx = { role, student } where student comes from the verified login token, never from model arguments.
async function dispatch(name, input, ctx) {
  const def = TOOLS.find((t) => t.name === name && t.roles.includes(ctx.role));
  if (!def) return { error: 'You are not permitted to use this tool.' };
  switch (name) {
    case 'get_events':
    case 'search_events':
      return svc.listEvents(eventsRange(input)).map(brief);
    case 'get_event_details': {
      const evs = resolveEvents(input);
      if (!evs.length) return { error: 'No matching event found.' };
      return evs.map((e) => ({ ...brief(e), description: e.description }));
    }
    case 'get_registration_count': {
      const evs = input.event_id || input.keyword ? resolveEvents(input) : null;
      if (!evs) return { total_confirmed_registrations: svc.countRegistrations(), total_students: svc.listStudents().length };
      return evs.map((e) => ({ event_id: e.event_id, name: e.name, confirmed_registrations: e.registered, max_capacity: e.max_capacity }));
    }
    case 'get_student_details':
      if (ctx.role === 'student') return ctx.student;
      return svc.listStudents({ q: input.query });
    case 'get_student_registrations': {
      const regs = svc.listStudentRegistrations(ctx.student.student_id);
      const kw = input.keyword;
      const hits = kw ? regs.filter((r) => svc.matchesQuery({ name: r.event_name, category: r.category, description: '' }, kw)) : regs;
      if (kw && !hits.length) return { registered: false, note: 'The student has no registration matching that event.', matching_events: svc.listEvents({ q: kw }).map(brief) };
      return hits.map((r) => ({ event_id: r.event_id, event_name: r.event_name, date: r.date, time: r.time, registration_status: r.status, calendar_status: r.calendar_status }));
    }
    case 'register_student': {
      const r = await svc.registerForEvent(ctx.student.student_id, Number(input.event_id));
      return { success: true, registration_id: r.registration_id, event: r.event_name, date: r.date, time: r.time, venue: r.venue, calendar_status: r.calendar_status, calendar_link: r.calendar_link };
    }
    case 'cancel_registration': {
      const reg = svc.listStudentRegistrations(ctx.student.student_id).find((r) => r.event_id === Number(input.event_id) && r.status === 'confirmed');
      if (!reg) return { success: false, error: 'No active registration for that event.' };
      await svc.cancelRegistration(ctx.student.student_id, reg.registration_id);
      return { success: true, cancelled: reg.event_name };
    }
    case 'get_participants': {
      const evs = resolveEvents(input);
      if (!evs.length) return { error: 'No matching event found.' };
      return evs.slice(0, 3).map((e) => ({ event: e.name, participants: svc.listParticipants(e.event_id).filter((p) => p.status === 'confirmed').map(({ student_id, name, email, course }) => ({ student_id, name, email, course })) }));
    }
    case 'get_admin_statistics': {
      const d = svc.dashboardStats();
      return { ...d, upcoming: d.upcoming.map(brief), popular_events: d.popular_events.map(brief) };
    }
    case 'create_event':
      return brief(svc.createEvent(input));
    default:
      return { error: 'Unknown tool.' };
  }
}

/** user: { role: 'student', student } | { role: 'admin' } */
export async function runAgent(user, history) {
  const today = svc.todayStr();
  const who = user.role === 'admin' ? 'an ADMINISTRATOR (can see participant lists and statistics, and create events)' : `student ${user.student.name} (${user.student.course})`;
  const system = `You are the AI assistant inside a college Event Management System, talking to ${who}.
Today's date is ${today}. Always use the tools to get data - never invent events, counts, participants or registration status. For "this month" use the first and last day of the current month as a date range; for "upcoming" use upcoming_only or from_date=today.
${user.role === 'student' ? 'When the student asks to be registered, find the event, then call register_student; if several events match, list them and ask which one. After a registration, report the Google Calendar outcome exactly (added, or that it could not be added yet and can be retried from My Registrations). If a tool returns an error such as "event full" or "already registered", explain it plainly.' : 'You may not register or cancel on behalf of students.'}
If asked for something your tools cannot do or are not permitted to do, say so briefly. Keep replies short and friendly, plain text only: no markdown, no asterisks or bold (short lists with dashes are fine).`;

  const tools = TOOLS.filter((t) => t.roles.includes(user.role)).map(({ roles, ...t }) => t);
  const ad = adapters[provider()];
  const state = ad.start(history.slice(-10).map((m) => ({ role: m.role, content: String(m.content).slice(0, 2000) })));
  const actions = [];

  for (let i = 0; i < 6; i++) {
    const res = await ad.step(state, system, tools);
    if (res.refusal) return { reply: "Sorry, I can't help with that request.", actions };
    if (!res.calls.length) return { reply: res.text || 'Done.', actions };

    const results = [];
    for (const call of res.calls) {
      let out, isError = false;
      try { out = await dispatch(call.name, call.input, user); if (out?.error) isError = true; }
      catch (e) { out = { error: e instanceof svc.HttpError ? e.message : 'The action failed.' }; isError = true; if (!(e instanceof svc.HttpError)) console.error('[agent tool]', call.name, e); }
      actions.push({ tool: call.name, input: call.input, ok: !isError, summary: isError ? out.error : undefined });
      results.push({ call, out, isError });
    }
    ad.addResults(state, results);
  }
  return { reply: 'I could not finish that request. Please try rephrasing.', actions };
}

/** Agent step in the registration workflow: LLM writes the confirmation message (falls back to a template). */
export async function confirmationMessage(reg) {
  const fallback = `You're registered for "${reg.event_name}" on ${reg.date} at ${reg.time}, ${reg.venue}.` +
    (reg.calendar_status === 'created' ? ' A Google Calendar invite has been sent to your email.' : ' Registration successful, but Google Calendar synchronization failed.');
  // The failure notice is a fixed, guaranteed message - never left to the model's wording.
  if (!llmConfigured() || reg.calendar_status !== 'created') return fallback;
  try {
    return (await complete('Write a 2-sentence friendly registration confirmation for a student. Plain text, no markdown. State the facts given; do not invent details.',
      JSON.stringify({ student: reg.student_name, event: reg.event_name, date: reg.date, time: reg.time, venue: reg.venue, google_calendar_event_created: true }))) || fallback;
  } catch (e) {
    console.error('[llm] confirmation failed:', e.message);
    return fallback;
  }
}
