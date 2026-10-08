// Business logic shared by the REST API and the AI agent's tools.
import { db, tx } from './db.js';
import { createCalendarEvent, deleteCalendarEvent } from './calendar.js';
import { hashPassword, verifyPassword } from './auth.js';

export const CATEGORIES = ['AI', 'Machine Learning', 'Business', 'Technology', 'Web Development', 'Data Science', 'Cybersecurity', 'Entrepreneurship'];
const pad = (n) => String(n).padStart(2, '0');
/** Server-local calendar date (YYYY-MM-DD) - not UTC, so "today" matches the campus clock. */
export const todayStr = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const nowTimeStr = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export const hasEnded = (e) => e.date < todayStr() || (e.date === todayStr() && e.time <= nowTimeStr());

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const EVENT_SELECT = `
  SELECT e.*, (SELECT COUNT(*) FROM registrations r WHERE r.event_id = e.event_id AND r.status='confirmed') AS registered
  FROM events e`;

const withSeats = (e) => e && { ...e, seats_left: Math.max(0, e.max_capacity - e.registered) };

// ---------- validation ----------
export function validateEvent(b, partial = false) {
  const out = {};
  const need = (k) => !partial || b[k] !== undefined;
  const str = (k, label, max = 500) => {
    if (!need(k)) return;
    const v = String(b[k] ?? '').trim();
    if (!v && k !== 'description') throw new HttpError(400, `${label} is required.`);
    if (v.length > max) throw new HttpError(400, `${label} is too long.`);
    out[k] = v;
  };
  str('name', 'Event name', 120);
  str('description', 'Description', 2000);
  str('venue', 'Venue', 120);
  if (need('category')) {
    if (!CATEGORIES.includes(b.category)) throw new HttpError(400, `Category must be one of: ${CATEGORIES.join(', ')}.`);
    out.category = b.category;
  }
  if (need('date')) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date || '') || isNaN(Date.parse(b.date))) throw new HttpError(400, 'Date must be YYYY-MM-DD.');
    out.date = b.date;
  }
  if (need('time')) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(b.time || '')) throw new HttpError(400, 'Time must be HH:MM (24h).');
    out.time = b.time;
  }
  if (need('max_capacity')) {
    const n = Number(b.max_capacity);
    if (!Number.isInteger(n) || n < 1 || n > 10000) throw new HttpError(400, 'Maximum capacity must be a whole number between 1 and 10000.');
    out.max_capacity = n;
  }
  return out;
}

export function validateStudent(b) {
  const name = String(b.name ?? '').trim();
  const email = String(b.email ?? '').trim().toLowerCase();
  const course = String(b.course ?? '').trim();
  if (!name || name.length > 100) throw new HttpError(400, 'Name is required.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address.');
  if (!course || course.length > 60) throw new HttpError(400, 'Course is required.');
  const password = String(b.password ?? '');
  if (password.length < 8 || password.length > 128) throw new HttpError(400, 'Password must be 8-128 characters.');
  return { name, email, course, password };
}

// ---------- students ----------
const STUDENT_COLS = 'student_id, name, email, course';
export const getStudentByEmail = (email) => db.prepare(`SELECT ${STUDENT_COLS} FROM students WHERE email=?`).get(String(email).trim().toLowerCase());
export const getStudent = (id) => db.prepare(`SELECT ${STUDENT_COLS} FROM students WHERE student_id=?`).get(id);
export const listStudents = ({ q } = {}) => {
  const like = `%${String(q || '').toLowerCase()}%`;
  return db.prepare(`SELECT ${STUDENT_COLS}, (SELECT COUNT(*) FROM registrations r WHERE r.student_id=students.student_id AND r.status='confirmed') AS registrations
    FROM students WHERE LOWER(name) LIKE ? OR LOWER(email) LIKE ? OR LOWER(course) LIKE ? ORDER BY name`).all(like, like, like);
};

export function signupStudent(body) {
  const s = validateStudent(body);
  if (getStudentByEmail(s.email)) throw new HttpError(409, 'An account with this email already exists. Please log in.');
  const r = db.prepare('INSERT INTO students (name,email,course,password_hash) VALUES (?,?,?,?)').run(s.name, s.email, s.course, hashPassword(s.password));
  return getStudent(Number(r.lastInsertRowid));
}

export function loginStudent(email, password) {
  const row = db.prepare('SELECT * FROM students WHERE email=?').get(String(email || '').trim().toLowerCase());
  // Same message for unknown email and wrong password (no account enumeration).
  if (!row || !verifyPassword(password, row.password_hash)) throw new HttpError(401, 'Incorrect email or password.');
  return getStudent(row.student_id);
}

// ---------- events ----------
export const listEvents = ({ q, from, to, category, upcomingOnly } = {}) => {
  const where = [], args = [];
  if (category) { where.push('e.category = ?'); args.push(category); }
  if (from) { where.push('e.date >= ?'); args.push(from); }
  if (to) { where.push('e.date <= ?'); args.push(to); }
  if (upcomingOnly) { where.push('e.date >= ?'); args.push(todayStr()); }
  const sql = `${EVENT_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY e.date, e.time`;
  const rows = db.prepare(sql).all(...args).map(withSeats);
  return q ? rows.filter((e) => matchesQuery(e, q)) : rows;
};

const STOP = new Set(['workshop', 'workshops', 'seminar', 'seminars', 'event', 'events', 'the', 'a', 'an', 'for', 'on', 'about', 'in', 'of', 'and', 'talk', 'session']);
/** Word-aware keyword match so "AI" does not hit "certain"; filler words like "workshop" are ignored. */
export function matchesQuery(e, q) {
  const tokens = String(q).toLowerCase().split(/[^a-z0-9+#]+/).filter((t) => t && !STOP.has(t));
  const hay = `${e.name} ${e.category} ${e.description}`.toLowerCase();
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return tokens.every((t) => new RegExp(`(^|[^a-z0-9])${esc(t)}${t.length <= 3 ? '([^a-z0-9]|$)' : ''}`).test(hay));
}

export const getEvent = (id) => withSeats(db.prepare(`${EVENT_SELECT} WHERE e.event_id=?`).get(id));

export function createEvent(body) {
  const e = validateEvent(body);
  const r = db.prepare('INSERT INTO events (name,description,category,date,time,venue,max_capacity) VALUES (?,?,?,?,?,?,?)')
    .run(e.name, e.description ?? '', e.category ?? 'Technology', e.date, e.time, e.venue, e.max_capacity);
  return getEvent(Number(r.lastInsertRowid));
}

export function updateEvent(id, body) {
  const cur = getEvent(id);
  if (!cur) throw new HttpError(404, 'Event not found.');
  const e = validateEvent(body, true);
  if (e.max_capacity !== undefined && e.max_capacity < cur.registered)
    throw new HttpError(400, `Capacity cannot be lower than the ${cur.registered} students already registered.`);
  const merged = { ...cur, ...e };
  db.prepare('UPDATE events SET name=?,description=?,category=?,date=?,time=?,venue=?,max_capacity=? WHERE event_id=?')
    .run(merged.name, merged.description, merged.category, merged.date, merged.time, merged.venue, merged.max_capacity, id);
  return getEvent(id);
}

export async function deleteEvent(id) {
  if (!getEvent(id)) throw new HttpError(404, 'Event not found.');
  const cal = db.prepare(`SELECT calendar_event_id FROM registrations WHERE event_id=? AND calendar_event_id IS NOT NULL`).all(id);
  db.prepare('DELETE FROM events WHERE event_id=?').run(id);
  for (const c of cal) await deleteCalendarEvent(c.calendar_event_id).catch(() => {});
}

// ---------- registrations ----------
export function registerStudentRow(studentId, eventId) {
  return tx(() => {
    const ev = getEvent(eventId);
    if (!ev) throw new HttpError(404, 'Event not found.');
    if (hasEnded(ev)) throw new HttpError(400, 'This event has already taken place.');
    const existing = db.prepare('SELECT * FROM registrations WHERE student_id=? AND event_id=?').get(studentId, eventId);
    if (existing && existing.status === 'confirmed') throw new HttpError(409, 'You are already registered for this event.');
    if (ev.seats_left <= 0) throw new HttpError(409, 'Sorry, this event is full.');
    const now = new Date().toISOString();
    if (existing) {
      db.prepare(`UPDATE registrations SET status='confirmed', registration_date=?, calendar_status='pending', calendar_link=NULL, calendar_event_id=NULL, calendar_error=NULL WHERE registration_id=?`).run(now, existing.registration_id);
      return existing.registration_id;
    }
    return Number(db.prepare('INSERT INTO registrations (student_id,event_id,registration_date,status) VALUES (?,?,?,?)').run(studentId, eventId, now, 'confirmed').lastInsertRowid);
  });
}

export const getRegistration = (id) => db.prepare(`
  SELECT r.*, e.name AS event_name, e.date, e.time, e.venue, s.name AS student_name, s.email, s.course
  FROM registrations r JOIN events e USING(event_id) JOIN students s USING(student_id) WHERE r.registration_id=?`).get(id);

/** Calendar step - never throws; failure is recorded so registration still stands and can be retried. */
export async function syncCalendar(registrationId) {
  const reg = getRegistration(registrationId);
  const set = db.prepare('UPDATE registrations SET calendar_status=?, calendar_link=?, calendar_event_id=?, calendar_error=? WHERE registration_id=?');
  try {
    const cal = await createCalendarEvent(getEvent(reg.event_id), getStudent(reg.student_id));
    set.run('created', cal.link, cal.id, null, registrationId);
  } catch (err) {
    const msg = String(err?.response?.data?.error_description || err?.message || err).slice(0, 300);
    console.error('[calendar] failed:', msg);
    set.run('failed', null, null, msg, registrationId);
  }
  return getRegistration(registrationId);
}

/** Full registration workflow: validate -> DB -> Google Calendar. */
export async function registerForEvent(studentId, eventId) {
  const id = registerStudentRow(studentId, eventId);
  return syncCalendar(id);
}

export async function cancelRegistration(studentId, registrationId) {
  const reg = getRegistration(registrationId);
  if (!reg || reg.student_id !== studentId) throw new HttpError(404, 'Registration not found.');
  if (reg.status === 'cancelled') throw new HttpError(409, 'Already cancelled.');
  db.prepare(`UPDATE registrations SET status='cancelled' WHERE registration_id=?`).run(registrationId);
  await deleteCalendarEvent(reg.calendar_event_id).catch((e) => console.error('[calendar] delete failed:', e.message));
  return getRegistration(registrationId);
}

export const listStudentRegistrations = (studentId) => db.prepare(`
  SELECT r.*, e.name AS event_name, e.category, e.date, e.time, e.venue FROM registrations r JOIN events e USING(event_id)
  WHERE r.student_id=? ORDER BY e.date`).all(studentId);

export const listParticipants = (eventId) => db.prepare(`
  SELECT r.registration_id, r.registration_date, r.status, r.calendar_status, s.student_id, s.name, s.email, s.course
  FROM registrations r JOIN students s USING(student_id) WHERE r.event_id=? ORDER BY r.registration_date`).all(eventId);


export const listAllRegistrations = ({ eventId, q, status } = {}) => {
  const where = [], args = [];
  if (eventId) { where.push('r.event_id = ?'); args.push(eventId); }
  if (status) { where.push('r.status = ?'); args.push(status); }
  if (q) { where.push('(LOWER(s.name) LIKE ? OR LOWER(s.email) LIKE ? OR LOWER(e.name) LIKE ?)'); const l = `%${q.toLowerCase()}%`; args.push(l, l, l); }
  return db.prepare(`
  SELECT r.registration_id, r.registration_date, r.status, r.calendar_status, e.name AS event_name, e.event_id, s.student_id, s.name AS student_name, s.email, s.course
  FROM registrations r JOIN events e USING(event_id) JOIN students s USING(student_id)
  ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.registration_date DESC`).all(...args);
};

export function countRegistrations(eventId) {
  if (eventId) return db.prepare(`SELECT COUNT(*) c FROM registrations WHERE event_id=? AND status='confirmed'`).get(eventId).c;
  return db.prepare(`SELECT COUNT(*) c FROM registrations WHERE status='confirmed'`).get().c;
}

export function dashboardStats() {
  const one = (sql, ...a) => db.prepare(sql).get(...a).c;
  const events = listEvents();
  const today = todayStr();
  return {
    total_events: events.length,
    upcoming_events: events.filter((e) => e.date >= today).length,
    total_students: one('SELECT COUNT(*) c FROM students'),
    total_registrations: countRegistrations(),
    calendar_synced: one(`SELECT COUNT(*) c FROM registrations WHERE calendar_status='created' AND status='confirmed'`),
    calendar_failed: one(`SELECT COUNT(*) c FROM registrations WHERE calendar_status='failed' AND status='confirmed'`),
    upcoming: events.filter((e) => e.date >= today).slice(0, 5),
    recent_registrations: listAllRegistrations().slice(0, 8),
    popular_events: [...events].sort((a, b) => b.registered - a.registered).slice(0, 5),
    per_category: Object.entries(events.reduce((m, e) => ((m[e.category] = (m[e.category] || 0) + e.registered), m), {})).map(([category, registrations]) => ({ category, registrations })),
  };
}
