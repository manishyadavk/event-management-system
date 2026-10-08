// Frontend SPA. It talks ONLY to the backend REST API (/api/*) - never to the database, Google or the LLM directly.
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// ---------- safe templating: interpolations are HTML-escaped unless wrapped in raw() ----------
const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
class Raw { constructor(s) { this.s = s; } }
const raw = (s) => new Raw(s);
const html = (strs, ...vals) => new Raw(strs.reduce((o, s, i) => o + s + (i < vals.length ? [].concat(vals[i] ?? '').map((v) => (v instanceof Raw ? v.s : escHtml(v))).join('') : ''), ''));
const put = (el, tpl) => { el.innerHTML = tpl instanceof Raw ? tpl.s : escHtml(tpl); return el; };

// ---------- state ----------
let session = null;
try { session = JSON.parse(sessionStorage.getItem('session') || 'null'); } catch { /* ignore */ }
let status = { llm: false, calendar: false, categories: [] };
let chat = [];
let chatBusy = false;
let panelOpen = false;
let currentRoute = '';

const isAdmin = () => session?.user?.role === 'admin';

// ---------- API ----------
async function api(path, method = 'GET', body) {
  let r;
  try {
    r = await fetch('/api' + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: 'Bearer ' + session.token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch { throw new Error('Cannot reach the server. Check your connection and try again.'); }
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && session && !path.startsWith('/auth/')) { logout(true); throw new Error('Your session expired. Please log in again.'); }
  if (!r.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
  return data;
}
const qs = (o) => { const p = new URLSearchParams(Object.entries(o).filter(([, v]) => v)); return p.toString() ? '?' + p : ''; };

// ---------- helpers ----------
const todayStr = () => { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const nowHM = () => { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return `${p(d.getHours())}:${p(d.getMinutes())}`; };
const ended = (e) => e.date < todayStr() || (e.date === todayStr() && e.time <= nowHM());
const fmtDate = (d) => new Date(d + 'T00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const fmtTime = (t) => new Date('2000-01-01T' + t).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
const fmtStamp = (iso) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
const initials = (n) => String(n || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

function toast(msg, kind = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + kind; t.textContent = msg;
  $('#toasts').append(t);
  setTimeout(() => t.remove(), kind === 'err' || kind === 'warn' ? 7000 : 4000);
}
const fail = (e) => toast(e.message || 'Something went wrong.', 'err');

function openModal(tpl, { onClose } = {}) {
  closeModal();
  const root = $('#modalRoot');
  put(root, html`<div class="modal" role="dialog" aria-modal="true"><div class="modal-box">${tpl}</div></div>`);
  const m = $('.modal', root);
  m.addEventListener('mousedown', (e) => { if (e.target === m) closeModal(); });
  openModal.onClose = onClose;
  const f = $('input,select,textarea,button', m); if (f) f.focus();
  return m;
}
function closeModal() { $('#modalRoot').innerHTML = ''; const f = openModal.onClose; openModal.onClose = null; if (f) f(); }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if ($('.modal')) closeModal(); else if (panelOpen) { panelOpen = false; renderAssistant(); } } });

function confirmDialog({ title, message, confirmText = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const m = openModal(html`<h2>${title}</h2><p>${message}</p>
      <div class="row" style="justify-content:flex-end;margin-top:18px"><button class="btn ghost" data-no>Cancel</button><button class="btn ${danger ? 'danger' : ''}" data-yes>${confirmText}</button></div>`, { onClose: () => finish(false) });
    $('[data-no]', m).onclick = () => closeModal();
    $('[data-yes]', m).onclick = () => { finish(true); closeModal(); };
  });
}

const busy = (btn, label) => { btn.disabled = true; btn.dataset.old = btn.innerHTML; put(btn, html`<span class="spin"></span> ${label}`); return () => { btn.disabled = false; btn.innerHTML = btn.dataset.old; }; };

const skeleton = (n = 6) => html`<div class="cards">${Array.from({ length: n }, () => raw('<div class="skel"></div>'))}</div>`;
const errorState = (msg) => html`<div class="state-err"><b>Couldn't load this page.</b><br>${msg}<p><button class="btn ghost sm" onclick="route()">Try again</button></p></div>`;
const empty = (title, sub = '') => html`<div class="empty"><b>${title}</b>${sub}</div>`;

const calBadge = (r) => {
  if (r.status === 'cancelled') return html`<span class="badge bad">Cancelled</span>`;
  if (r.calendar_status === 'created') return r.calendar_link ? html`<a class="badge ok" href="${r.calendar_link}" target="_blank" rel="noopener">✓ Synced · Open</a>` : html`<span class="badge ok">✓ Synced</span>`;
  if (r.calendar_status === 'failed') return html`<span class="badge warn">Sync failed</span>`;
  return html`<span class="badge gray">Not synced</span>`;
};
const regBadge = (r) => html`<span class="badge ${r.status === 'confirmed' ? 'ok' : 'bad'}">${r.status === 'confirmed' ? 'Confirmed' : 'Cancelled'}</span>`;

// ---------- session ----------
function setSession(s) { session = s; sessionStorage.setItem('session', JSON.stringify(s)); chat = []; location.hash = isAdmin() ? '#/dashboard' : '#/events'; route(); }
function logout(expired) {
  session = null; sessionStorage.removeItem('session'); chat = []; panelOpen = false;
  location.hash = expired ? '#/login' : '#/'; route();
}

// ---------- chrome ----------
function renderChrome(page) {
  const links = !session ? [['#/', 'Home'], ['#/login', 'Log in']]
    : isAdmin() ? [['#/dashboard', 'Dashboard'], ['#/manage', 'Events'], ['#/participants', 'Registrations'], ['#/students', 'Students']]
    : [['#/events', 'Events'], ['#/registrations', 'My registrations']];
  put($('#nav'), html`${links.map(([h, l]) => html`<a href="${h}" class="${page === h.slice(2).split('/')[0] || (h === '#/' && page === '') ? 'active' : ''}">${l}</a>`)}`);
  put($('#userbox'), session ? html`<div class="avatar">${initials(session.user.name)}</div><div class="who"><b>${session.user.name}</b><small>${isAdmin() ? 'Administrator' : session.user.course}</small></div><button class="btn ghost sm" id="logout">Log out</button>` : '');
  if (session) $('#logout').onclick = () => logout();
}

// ---------- router ----------
const guards = { admin: ['dashboard', 'manage', 'participants', 'students'], student: ['events', 'registrations'] };
async function route() {
  closeModal();
  const parts = (location.hash.replace(/^#\/?/, '') || '').split('/');
  const page = parts[0].split('?')[0];
  currentRoute = page;
  const app = $('#app');
  renderChrome(page);
  renderAssistant();
  window.scrollTo(0, 0);
  try {
    if (!session) {
      if (page === 'login') return renderAuth(app);
      return await renderLanding(app);
    }
    const role = isAdmin() ? 'admin' : 'student';
    if (!guards[role].includes(page)) { location.hash = isAdmin() ? '#/dashboard' : '#/events'; return; }
    put(app, skeleton(6));
    await pages[page](app, parts[1]);
  } catch (e) { put(app, errorState(e.message)); }
}
window.route = route;
window.addEventListener('hashchange', route);

// ---------- landing ----------
const FEATURES = [
  ['📋', 'One-click registration', 'Capacity-aware sign-ups with duplicate protection, enforced by the database.'],
  ['📅', 'Google Calendar sync', 'Every registration creates a real calendar event with venue, time and reminders.'],
  ['🤖', 'AI event agent', 'Ask in plain English. The agent searches events, checks your status and registers you.'],
  ['📊', 'Admin dashboard', 'Create events, manage participants and watch registrations in real time.'],
];
async function renderLanding(app) {
  put(app, html`
  <section class="hero">
    <div class="eyebrow">✨ AI-powered campus events</div>
    <h1>Discover college workshops and seminars, register easily, and manage events with AI.</h1>
    <p>One place for every workshop and seminar on campus. Register in a click, get it on your Google Calendar, or just ask the assistant.</p>
    <div class="row" style="justify-content:center"><a class="btn lg" href="#/login">Browse &amp; register</a><a class="btn ghost lg" href="#/login?admin">Admin sign in</a></div>
  </section>
  <section class="section"><h2>Upcoming events</h2><p class="hint">A preview of what's coming up. Log in to register.</p><div id="lp-events">${skeleton(3)}</div></section>
  <section class="section"><h2>Event categories</h2><p class="hint">Workshops and seminars across disciplines.</p><div class="cats" id="lp-cats"></div></section>
  <section class="section"><h2>Everything in one platform</h2><p class="hint">Built for students and organisers.</p>
    <div class="features">${FEATURES.map(([i, t, d]) => html`<div class="card feat"><div class="ic">${i}</div><h3>${t}</h3><p>${d}</p></div>`)}</div></section>
  <section class="section"><div class="ai-intro">
    <div><h2>Meet your AI event assistant</h2><p>It isn't a chatbot that guesses. The agent understands what you ask, picks the right tool, reads the real database and performs actions like registering you, then tells you the actual result.</p>
      <a class="btn" href="#/login">Try the assistant</a></div>
    <div class="ai-demo"><div class="bubble u">Register me for the business analytics workshop</div>
      <div class="bubble a">Done! You're registered for Business Analytics Workshop. It's on your Google Calendar. 📅</div>
      <div class="bubble u">How many students have registered?</div></div></div></section>
  <section class="section"><div class="ctas">
    <div class="card cta"><h2>For students</h2><p>Find workshops, register in seconds and keep everything in your calendar.</p><a class="btn" href="#/login">Student login / sign up</a></div>
    <div class="card cta"><h2>For organisers</h2><p>Create events, track capacity and see exactly who is attending.</p><a class="btn ghost" href="#/login?admin">Admin login</a></div>
  </div></section>
  <footer style="margin:60px -20px -90px"><div class="in"><span><b>CampusEvents</b> · AI-powered event management</span><span>Express · SQLite · Claude · Google Calendar</span></div></footer>`);
  put($('#lp-cats'), html`${(status.categories || []).map((c) => html`<a class="cat" href="#/login">${c}</a>`)}`);
  try {
    const evs = await api('/public/events');
    put($('#lp-events'), evs.length ? html`<div class="cards">${evs.slice(0, 3).map((e) => eventCard(e, null, true))}</div>` : empty('No upcoming events.', 'Check back soon.'));
  } catch (e) { put($('#lp-events'), errorState(e.message)); }
}

// ---------- auth page ----------
function renderAuth(app) {
  let mode = location.hash.includes('admin') ? 'admin' : 'login';
  const draw = () => {
    put(app, html`<div class="auth card">
      <h1 style="margin-bottom:14px">${mode === 'admin' ? 'Admin sign in' : mode === 'signup' ? 'Create student account' : 'Welcome back'}</h1>
      <div class="tabs" role="tablist">
        <button data-m="login" class="${mode === 'login' ? 'on' : ''}">Student login</button>
        <button data-m="signup" class="${mode === 'signup' ? 'on' : ''}">Sign up</button>
        <button data-m="admin" class="${mode === 'admin' ? 'on' : ''}">Admin</button></div>
      <form id="af" novalidate>
        ${mode === 'signup' ? html`<label for="f-name">Full name</label><input id="f-name" name="name" required maxlength="100" autocomplete="name">
          <label for="f-course">Course</label><input id="f-course" name="course" required maxlength="60" placeholder="e.g. B.Tech CSE">` : ''}
        ${mode !== 'admin' ? html`<label for="f-email">Email</label><input id="f-email" name="email" type="email" required autocomplete="email" placeholder="you@college.edu">` : ''}
        <label for="f-pw">Password</label><input id="f-pw" name="password" type="password" required autocomplete="${mode === 'signup' ? 'new-password' : 'current-password'}" ${mode === 'signup' ? 'minlength="8"' : ''}>
        ${mode === 'signup' ? html`<div class="hint">At least 8 characters.</div>` : ''}
        <div class="field-err" id="ferr"></div>
        <button class="btn" style="width:100%;margin-top:8px" id="sub">${mode === 'signup' ? 'Create account' : 'Log in'}</button>
      </form>
      ${mode === 'login' ? html`<p class="hint" style="margin-top:14px">Demo student: <code>aarav.sharma@example.com</code> / <code>Student@123</code></p>` : ''}
    </div>`);
    $$('.tabs button', app).forEach((b) => (b.onclick = () => { mode = b.dataset.m; draw(); }));
    $('#af').onsubmit = async (ev) => {
      ev.preventDefault();
      const body = Object.fromEntries(new FormData(ev.target));
      const err = $('#ferr'); err.textContent = '';
      const done = busy($('#sub'), mode === 'signup' ? 'Creating account…' : 'Signing in…');
      try { setSession(await api(mode === 'admin' ? '/auth/admin/login' : mode === 'signup' ? '/auth/student/signup' : '/auth/student/login', 'POST', body)); }
      catch (e) { err.textContent = e.message; done(); }
    };
  };
  draw();
}

// ---------- shared event pieces ----------
function seatsBadge(e) {
  if (ended(e)) return html`<span class="badge gray">Ended</span>`;
  if (e.seats_left === 0) return html`<span class="badge bad">Event Full</span>`;
  return html`<span class="badge ${e.seats_left <= 5 ? 'warn' : 'ok'}">${e.seats_left} seat${e.seats_left === 1 ? '' : 's'} left</span>`;
}
const capBar = (e) => { const pct = Math.min(100, (e.registered / e.max_capacity) * 100); return html`<div class="cap ${e.seats_left === 0 ? 'full' : pct > 80 ? 'low' : ''}" role="progressbar" aria-valuenow="${e.registered}" aria-valuemax="${e.max_capacity}" aria-label="Registrations"><i style="width:${pct}%"></i></div>`; };

function eventCard(e, regMap, preview = false) {
  const reg = regMap?.get(e.event_id);
  const mine = reg && reg.status === 'confirmed';
  return html`<article class="card ev">
    <div class="row"><span class="badge">${e.category}</span><span class="grow"></span>${seatsBadge(e)}</div>
    <h3>${preview ? e.name : html`<a href="#/events/${e.event_id}">${e.name}</a>`}</h3>
    <div class="meta"><span>📆 ${fmtDate(e.date)} · ${fmtTime(e.time)}</span><span>📍 ${e.venue}</span><span>👥 ${e.registered} / ${e.max_capacity} registered</span></div>
    ${capBar(e)}
    <p>${e.description.length > 120 ? e.description.slice(0, 120) + '…' : e.description}</p>
    ${preview ? '' : html`<div class="ev-foot"><a class="btn ghost sm" href="#/events/${e.event_id}">Details</a>${registerControl(e, mine)}</div>`}
  </article>`;
}
function registerControl(e, mine, size = 'sm') {
  const cls = size === 'lg' ? 'btn lg" style="width:100%' : 'btn sm';
  if (mine) return html`<span class="badge ok">✓ Registered</span>`;
  if (ended(e)) return html`<button class="${raw(cls)}" disabled>Event ended</button>`;
  if (e.seats_left === 0) return html`<button class="${raw(cls)}" disabled>Event Full</button>`;
  return html`<button class="${raw(cls)}" data-reg="${e.event_id}">Register</button>`;
}
function bindRegister(root) {
  $$('[data-reg]', root).forEach((b) => (b.onclick = () => doRegister(Number(b.dataset.reg), b)));
}

async function doRegister(eventId, btn) {
  const done = busy(btn, 'Registering…');
  try {
    const r = await api('/registrations', 'POST', { event_id: eventId });
    showConfirmation(r);
  } catch (e) { fail(e); done(); }
}

function showConfirmation(r) {
  const reg = r.registration, synced = reg.calendar_status === 'created';
  const m = openModal(html`<h2>✅ You're registered</h2>
    <p>${r.message}</p>
    <dl class="kv"><dt>Event</dt><dd>${reg.event_name}</dd><dt>When</dt><dd>${fmtDate(reg.date)} · ${fmtTime(reg.time)}</dd><dt>Venue</dt><dd>${reg.venue}</dd>
      <dt>Registration</dt><dd>#${reg.registration_id}</dd><dt>Google Calendar</dt><dd id="calst">${calBadge(reg)}</dd></dl>
    ${synced ? '' : html`<p class="state-err" style="margin-top:14px">Registration successful, but Google Calendar synchronization failed. Your spot is saved. You can retry now or later from My registrations.</p>`}
    <div class="row" style="justify-content:flex-end;margin-top:18px">${synced ? '' : html`<button class="btn ghost" id="retry">Retry calendar sync</button>`}<button class="btn" id="ok">Done</button></div>`,
    { onClose: () => { if (['events', 'registrations'].includes(currentRoute)) route(); } });
  $('#ok', m).onclick = closeModal;
  const rb = $('#retry', m);
  if (rb) rb.onclick = async () => {
    const done = busy(rb, 'Syncing with Google Calendar…');
    try {
      const upd = await api(`/registrations/${reg.registration_id}/retry-calendar`, 'POST');
      if (upd.calendar_status === 'created') { toast('Added to Google Calendar', 'ok'); closeModal(); } else { toast('Google Calendar synchronization failed again.', 'warn'); done(); }
    } catch (e) { fail(e); done(); }
  };
}

// ---------- pages ----------
const pages = {
  // ----- student: events list -----
  async events(app, id) {
    if (id) return pages.eventDetail(app, id);
    const regs = await api('/registrations/mine');
    const regMap = new Map(regs.map((r) => [r.event_id, r]));
    put(app, html`<div class="page-head"><div><h1>Events</h1><p>Browse workshops and seminars and register in one click.</p></div></div>
      <div class="toolbar">
        <input class="search" id="q" type="search" placeholder="Search events…" aria-label="Search events">
        <select id="cat" aria-label="Category"><option value="">All categories</option>${status.categories.map((c) => html`<option>${c}</option>`)}</select>
        <input type="date" id="from" aria-label="From date" title="From date"><input type="date" id="to" aria-label="To date" title="To date">
        <select id="st" aria-label="Availability"><option value="upcoming">Upcoming</option><option value="all">All (incl. past)</option><option value="open">Open seats only</option><option value="mine">I'm registered</option></select>
      </div><div id="list"></div>`);
    const load = async () => {
      put($('#list'), skeleton(6));
      try {
        let evs = await api('/events' + qs({ q: $('#q').value.trim(), category: $('#cat').value, from: $('#from').value, to: $('#to').value }));
        const st = $('#st').value;
        if (st !== 'all') evs = evs.filter((e) => !ended(e) || (st === 'mine' && regMap.get(e.event_id)?.status === 'confirmed'));
        if (st === 'open') evs = evs.filter((e) => e.seats_left > 0);
        if (st === 'mine') evs = evs.filter((e) => regMap.get(e.event_id)?.status === 'confirmed');
        put($('#list'), evs.length ? html`<div class="cards">${evs.map((e) => eventCard(e, regMap))}</div>` : empty('No events found', 'Try changing the search or filters.'));
        bindRegister($('#list'));
      } catch (e) { put($('#list'), errorState(e.message)); }
    };
    $('#q').oninput = debounce(load);
    ['cat', 'from', 'to', 'st'].forEach((i) => ($('#' + i).onchange = load));
    load();
  },

  async eventDetail(app, id) {
    const [e, regs] = await Promise.all([api('/events/' + id), api('/registrations/mine')]);
    const reg = regs.find((r) => r.event_id === e.event_id && r.status === 'confirmed');
    put(app, html`<p><a href="#/events">← All events</a></p>
      <div class="detail"><div class="card">
        <div class="row"><span class="badge">${e.category}</span>${seatsBadge(e)}</div>
        <h1 style="margin:12px 0">${e.name}</h1><p style="color:var(--ink2);font-size:16px">${e.description || 'No description provided.'}</p></div>
      <aside class="card"><dl class="kv"><dt>Date</dt><dd>${fmtDate(e.date)}</dd><dt>Time</dt><dd>${fmtTime(e.time)}</dd><dt>Venue</dt><dd>${e.venue}</dd>
        <dt>Capacity</dt><dd>${e.max_capacity}</dd><dt>Registered</dt><dd>${e.registered}</dd><dt>Seats left</dt><dd>${e.seats_left}</dd></dl>
        <div style="margin:14px 0">${capBar(e)}</div>${reg ? html`<p>${regBadge(reg)} ${calBadge(reg)}</p>` : registerControl(e, false, 'lg')}
        ${!reg && ended(e) ? html`<p class="hint">Registration is closed because this event has already taken place.</p>` : ''}</aside></div>`);
    bindRegister(app);
  },

  // ----- student: my registrations -----
  async registrations(app) {
    const regs = await api('/registrations/mine');
    put(app, html`<div class="page-head"><div><h1>My registrations</h1><p>Your events and their Google Calendar sync status.</p></div></div>
      ${regs.length ? html`<div class="tablewrap"><table><thead><tr><th>Event</th><th>Date &amp; time</th><th>Venue</th><th>Registered on</th><th>Status</th><th>Google Calendar</th><th></th></tr></thead><tbody>
      ${regs.map((r) => html`<tr><td><a href="#/events/${r.event_id}"><b>${r.event_name}</b></a></td><td>${fmtDate(r.date)}<div class="sub">${fmtTime(r.time)}</div></td><td>${r.venue}</td><td>${fmtStamp(r.registration_date)}</td>
        <td>${regBadge(r)}</td><td>${calBadge(r)}</td>
        <td><div class="actions">${r.status === 'confirmed' && r.calendar_status !== 'created' && !ended(r) ? html`<button class="btn ghost sm" data-sync="${r.registration_id}">${r.calendar_status === 'failed' ? 'Retry sync' : 'Sync now'}</button>` : ''}
        ${r.status === 'confirmed' && !ended(r) ? html`<button class="btn ghost sm" data-cancel="${r.registration_id}" data-name="${r.event_name}">Cancel</button>` : ''}</div></td></tr>`)}
      </tbody></table></div>` : empty('No registrations found', html`<p>You haven't registered for any events yet.</p><a class="btn" href="#/events">Browse events</a>`)}`);
    $$('[data-sync]', app).forEach((b) => (b.onclick = async () => {
      const done = busy(b, 'Syncing with Google Calendar…');
      try {
        const r = await api(`/registrations/${b.dataset.sync}/retry-calendar`, 'POST');
        if (r.calendar_status === 'created') toast('Added to Google Calendar', 'ok'); else toast('Google Calendar synchronization failed. Please try again later.', 'warn');
        route();
      } catch (e) { fail(e); done(); }
    }));
    $$('[data-cancel]', app).forEach((b) => (b.onclick = async () => {
      if (!(await confirmDialog({ title: 'Cancel registration?', message: `You will give up your seat for "${b.dataset.name}".`, confirmText: 'Cancel registration', danger: true }))) return;
      try { await api('/registrations/' + b.dataset.cancel, 'DELETE'); toast('Registration cancelled', 'ok'); route(); } catch (e) { fail(e); }
    }));
  },

  // ----- admin: dashboard -----
  async dashboard(app) {
    const d = await api('/admin/dashboard');
    const stat = (n, l) => html`<div class="card stat"><div class="n">${n}</div><div class="l">${l}</div></div>`;
    const maxCat = Math.max(1, ...d.per_category.map((c) => c.registrations));
    put(app, html`<div class="page-head"><div><h1>Dashboard</h1><p>Live numbers from the database.</p></div><span class="grow"></span><a class="btn" href="#/manage">Manage events</a></div>
      <div class="stats">${stat(d.total_events, 'Total events')}${stat(d.total_students, 'Total students')}${stat(d.total_registrations, 'Active registrations')}${stat(d.upcoming_events, 'Upcoming events')}${stat(d.calendar_synced, 'Calendar events created')}${stat(d.calendar_failed, 'Calendar failures')}</div>
      <div class="two">
        <div class="card"><h2>Most popular events</h2>${d.popular_events.length ? d.popular_events.map((e) => html`<div class="bar-row"><div class="bar-top"><span>${e.name}</span><span class="hint">${e.registered} / ${e.max_capacity}</span></div>${capBar(e)}</div>`) : empty('No events yet')}</div>
        <div class="card"><h2>Registrations by category</h2>${d.per_category.length ? d.per_category.sort((a, b) => b.registrations - a.registrations).map((c) => html`<div class="bar-row"><div class="bar-top"><span>${c.category}</span><span class="hint">${c.registrations}</span></div><div class="cap"><i style="width:${(c.registrations / maxCat) * 100}%"></i></div></div>`) : empty('No data yet')}</div>
      </div>
      <div class="two">
        <div class="card"><h2>Upcoming events</h2>${d.upcoming.length ? d.upcoming.map((e) => html`<div class="list-item"><div class="grow"><b>${e.name}</b><div class="hint">${fmtDate(e.date)} · ${fmtTime(e.time)} · ${e.venue}</div></div>${seatsBadge(e)}</div>`) : empty('No upcoming events.')}</div>
        <div class="card"><h2>Recent registrations</h2>${d.recent_registrations.length ? d.recent_registrations.map((r) => html`<div class="list-item"><div class="avatar">${initials(r.student_name)}</div><div class="grow"><b>${r.student_name}</b><div class="hint">${r.event_name}</div></div><span class="hint">${fmtStamp(r.registration_date)}</span></div>`) : empty('No registrations found.')}</div>
      </div>`);
  },

  // ----- admin: events CRUD -----
  async manage(app) {
    put(app, html`<div class="page-head"><div><h1>Events</h1><p>Create, edit and delete events.</p></div><span class="grow"></span><button class="btn" id="new">+ New event</button></div>
      <div class="toolbar"><input class="search" id="q" type="search" placeholder="Search events…" aria-label="Search events">
        <select id="cat" aria-label="Category"><option value="">All categories</option>${status.categories.map((c) => html`<option>${c}</option>`)}</select>
        <select id="when" aria-label="When"><option value="">All dates</option><option value="upcoming">Upcoming</option><option value="past">Past</option></select></div><div id="list"></div>`);
    $('#new').onclick = () => eventForm(null, () => route());
    const load = async () => {
      put($('#list'), skeleton(1));
      try {
        let evs = await api('/events' + qs({ q: $('#q').value.trim(), category: $('#cat').value }));
        const w = $('#when').value;
        if (w) evs = evs.filter((e) => (w === 'past') === ended(e));
        put($('#list'), evs.length ? html`<div class="tablewrap"><table><thead><tr><th>ID</th><th>Event</th><th>Category</th><th>Date &amp; time</th><th>Venue</th><th>Registered</th><th></th></tr></thead><tbody>
          ${evs.map((e) => html`<tr><td>#${e.event_id}</td><td><b>${e.name}</b></td><td><span class="badge">${e.category}</span></td><td>${fmtDate(e.date)}<div class="sub">${fmtTime(e.time)}</div></td><td>${e.venue}</td><td>${e.registered} / ${e.max_capacity}</td>
          <td><div class="actions"><button class="btn ghost sm" data-p="${e.event_id}">Participants</button><button class="btn ghost sm" data-e="${e.event_id}">Edit</button><button class="btn danger sm" data-x="${e.event_id}">Delete</button></div></td></tr>`)}
          </tbody></table></div>` : empty('No events found', 'Try different filters or create a new event.'));
        $$('[data-e]').forEach((b) => (b.onclick = () => eventForm(evs.find((e) => e.event_id == b.dataset.e), load)));
        $$('[data-p]').forEach((b) => (b.onclick = () => participantsModal(evs.find((e) => e.event_id == b.dataset.p))));
        $$('[data-x]').forEach((b) => (b.onclick = async () => {
          const e = evs.find((x) => x.event_id == b.dataset.x);
          if (!(await confirmDialog({ title: 'Delete event?', message: `"${e.name}" and its ${e.registered} registration(s) will be permanently removed, along with the participants' calendar events.`, confirmText: 'Delete event', danger: true }))) return;
          try { await api('/events/' + e.event_id, 'DELETE'); toast('Event deleted', 'ok'); load(); } catch (x) { fail(x); }
        }));
      } catch (e) { put($('#list'), errorState(e.message)); }
    };
    $('#q').oninput = debounce(load); $('#cat').onchange = load; $('#when').onchange = load;
    load();
  },

  // ----- admin: registrations / participants -----
  async participants(app) {
    const events = await api('/events');
    put(app, html`<div class="page-head"><div><h1>Registrations</h1><p>Participant lists across all events.</p></div></div>
      <div class="toolbar"><input class="search" id="q" type="search" placeholder="Search by student, email or event…" aria-label="Search participants">
        <select id="ev" aria-label="Event"><option value="">All events</option>${events.map((e) => html`<option value="${e.event_id}">${e.name}</option>`)}</select>
        <select id="st" aria-label="Status"><option value="">Any status</option><option value="confirmed">Confirmed</option><option value="cancelled">Cancelled</option></select></div><div id="list"></div>`);
    const load = async () => {
      put($('#list'), skeleton(1));
      try {
        const rows = await api('/registrations' + qs({ q: $('#q').value.trim(), event_id: $('#ev').value, status: $('#st').value }));
        put($('#list'), rows.length ? html`<p class="hint">${rows.length} registration${rows.length === 1 ? '' : 's'}</p><div class="tablewrap"><table><thead><tr><th>Reg #</th><th>Student</th><th>Course</th><th>Event</th><th>Registered on</th><th>Status</th><th>Calendar</th></tr></thead><tbody>
          ${rows.map((r) => html`<tr><td>#${r.registration_id}</td><td><b>${r.student_name}</b><div class="sub">${r.email}</div></td><td>${r.course}</td><td>${r.event_name}</td><td>${fmtStamp(r.registration_date)}</td><td>${regBadge(r)}</td><td>${calBadge(r)}</td></tr>`)}</tbody></table></div>` : empty('No registrations found', 'Try a different search or filter.'));
      } catch (e) { put($('#list'), errorState(e.message)); }
    };
    $('#q').oninput = debounce(load); $('#ev').onchange = load; $('#st').onchange = load;
    load();
  },

  async students(app) {
    put(app, html`<div class="page-head"><div><h1>Students</h1><p>Registered student accounts.</p></div><span class="grow"></span><button class="btn" id="add">+ Add student</button></div>
      <div class="toolbar"><input class="search" id="q" type="search" placeholder="Search students…" aria-label="Search students"></div><div id="list"></div>`);
    $('#add').onclick = () => studentForm(() => route());
    const load = async () => {
      try {
        const rows = await api('/students' + qs({ q: $('#q').value.trim() }));
        put($('#list'), rows.length ? html`<div class="tablewrap"><table><thead><tr><th>ID</th><th>Name</th><th>Email</th><th>Course</th><th>Active registrations</th></tr></thead><tbody>
          ${rows.map((s) => html`<tr><td>#${s.student_id}</td><td><b>${s.name}</b></td><td>${s.email}</td><td>${s.course}</td><td>${s.registrations}</td></tr>`)}</tbody></table></div>` : empty('No students found'));
      } catch (e) { put($('#list'), errorState(e.message)); }
    };
    $('#q').oninput = debounce(load); load();
  },
};

// ---------- admin modals ----------
function eventForm(e, onSaved) {
  const v = e || { max_capacity: 50, category: status.categories[0] };
  const m = openModal(html`<h2>${e ? 'Edit event' : 'Create event'}</h2><form id="ef" novalidate><div class="form-grid">
    <div class="full"><label for="e-name">Name</label><input id="e-name" name="name" required maxlength="120" value="${v.name}"></div>
    <div class="full"><label for="e-desc">Description</label><textarea id="e-desc" name="description" rows="3" maxlength="2000">${v.description}</textarea></div>
    <div><label for="e-cat">Category</label><select id="e-cat" name="category">${status.categories.map((c) => html`<option ${c === v.category ? 'selected' : ''}>${c}</option>`)}</select></div>
    <div><label for="e-cap">Maximum capacity</label><input id="e-cap" name="max_capacity" type="number" min="1" max="10000" required value="${v.max_capacity}"></div>
    <div><label for="e-date">Date</label><input id="e-date" name="date" type="date" required value="${v.date}"></div>
    <div><label for="e-time">Time</label><input id="e-time" name="time" type="time" required value="${v.time}"></div>
    <div class="full"><label for="e-venue">Venue</label><input id="e-venue" name="venue" required maxlength="120" value="${v.venue}"></div></div>
    <div class="field-err" id="ferr"></div>
    <div class="row" style="justify-content:flex-end;margin-top:14px"><button type="button" class="btn ghost" id="cx">Cancel</button><button class="btn" id="sv">Save event</button></div></form>`);
  $('#cx', m).onclick = closeModal;
  $('#ef', m).onsubmit = async (ev) => {
    ev.preventDefault();
    const body = Object.fromEntries(new FormData(ev.target));
    body.max_capacity = Number(body.max_capacity);
    const done = busy($('#sv', m), 'Saving…');
    try {
      await api(e ? '/events/' + e.event_id : '/events', e ? 'PUT' : 'POST', body);
      closeModal(); toast(e ? 'Event updated' : 'Event created', 'ok'); onSaved();
    } catch (x) { $('#ferr', m).textContent = x.message; done(); }
  };
}

function studentForm(onSaved) {
  const m = openModal(html`<h2>Add student</h2><form id="sf" novalidate>
    <label for="s-name">Full name</label><input id="s-name" name="name" required maxlength="100">
    <label for="s-email">Email</label><input id="s-email" name="email" type="email" required>
    <label for="s-course">Course</label><input id="s-course" name="course" required maxlength="60">
    <label for="s-pw">Initial password</label><input id="s-pw" name="password" type="password" required minlength="8">
    <div class="field-err" id="ferr"></div>
    <div class="row" style="justify-content:flex-end;margin-top:14px"><button type="button" class="btn ghost" id="cx">Cancel</button><button class="btn" id="sv">Add student</button></div></form>`);
  $('#cx', m).onclick = closeModal;
  $('#sf', m).onsubmit = async (ev) => {
    ev.preventDefault();
    const done = busy($('#sv', m), 'Saving…');
    try { await api('/students', 'POST', Object.fromEntries(new FormData(ev.target))); closeModal(); toast('Student added', 'ok'); onSaved(); }
    catch (x) { $('#ferr', m).textContent = x.message; done(); }
  };
}

async function participantsModal(e) {
  try {
    const rows = await api(`/events/${e.event_id}/participants`);
    const active = rows.filter((r) => r.status === 'confirmed').length;
    const m = openModal(html`<h2>Participants</h2><p class="hint">${e.name} · ${active} confirmed of ${e.max_capacity}</p>
      ${rows.length ? html`<div class="tablewrap"><table><thead><tr><th>ID</th><th>Name</th><th>Email</th><th>Course</th><th>Status</th></tr></thead><tbody>
      ${rows.map((r) => html`<tr><td>#${r.student_id}</td><td>${r.name}</td><td>${r.email}</td><td>${r.course}</td><td>${regBadge(r)}</td></tr>`)}</tbody></table></div>` : empty('No participants yet.')}
      <div class="row" style="justify-content:flex-end;margin-top:16px"><button class="btn" id="cx">Close</button></div>`);
    $('#cx', m).onclick = closeModal;
  } catch (x) { fail(x); }
}

// ---------- AI assistant (floating panel; student + admin) ----------
const PROMPTS = {
  student: ['Show me upcoming AI workshops.', 'What events am I registered for?', 'How many students registered for the AI workshop?', 'Register me for the business analytics workshop.', 'Show technology events this month.'],
  admin: ['Give me the dashboard statistics.', 'Who is registered for the cybersecurity workshop?', 'How many students have registered in total?', 'Which events are the most popular?', 'Show upcoming events.'],
};
function renderAssistant() {
  const root = $('#assistant');
  if (!session) { root.innerHTML = ''; return; }
  if (!panelOpen) {
    put(root, html`<button class="ai-fab" id="fab" aria-label="Open AI assistant">✨ Ask AI</button>`);
    $('#fab').onclick = () => { panelOpen = true; renderAssistant(); };
    return;
  }
  put(root, html`<section class="ai-panel" aria-label="AI assistant">
    <div class="ai-head"><div class="avatar">AI</div><div class="grow"><b>Event assistant</b><small><span class="dot ${status.llm ? '' : 'off'}" style="display:inline-block;margin-right:5px"></span>${status.llm ? 'Agent online · uses live data' : 'Unavailable (server not configured)'}</small></div><button class="btn ghost sm" id="clr" title="Clear conversation">Clear</button><button class="btn ghost sm" id="cls" aria-label="Close">✕</button></div>
    <div class="ai-msgs" id="msgs"></div>
    <div class="chips" id="chips"></div>
    <form class="ai-form" id="cf"><input id="ci" placeholder="Ask about events or registrations…" autocomplete="off" maxlength="500" aria-label="Message"><button class="btn" id="cs">Send</button></form>
  </section>`);
  $('#cls').onclick = () => { panelOpen = false; renderAssistant(); };
  $('#clr').onclick = () => { if (!chatBusy) { chat = []; drawChat(); } };
  $('#cf').onsubmit = (e) => { e.preventDefault(); const v = $('#ci').value; $('#ci').value = ''; sendChat(v); };
  drawChat(); $('#ci').focus();
}
function drawChat() {
  const box = $('#msgs'); if (!box) return;
  put(box, html`${chat.length ? '' : html`<div class="empty" style="padding:20px 8px"><b>Hi${isAdmin() ? ', admin' : ' ' + session.user.name.split(' ')[0]} 👋</b>I look things up in the real database and can perform actions. Try one of the prompts below.</div>`}
    ${chat.map((m) => html`<div class="msg ${m.role} ${m.error ? 'error' : ''}">${m.content}${m.actions?.length ? html`<div class="tools">${m.actions.map((a) => html`<span class="tool ${a.ok ? '' : 'fail'}" title="${a.summary || ''}">${a.ok ? '✓' : '✕'} ${a.tool}</span>`)}</div>` : ''}</div>`)}
    ${chatBusy ? html`<div class="typing"><span class="spin dark"></span> AI is thinking…</div>` : ''}`);
  box.scrollTop = box.scrollHeight;
  put($('#chips'), chat.length ? '' : html`${PROMPTS[isAdmin() ? 'admin' : 'student'].map((p) => html`<button type="button" class="chip" data-p="${p}">${p}</button>`)}`);
  $$('.chip', $('#chips')).forEach((c) => (c.onclick = () => sendChat(c.dataset.p)));
  const cs = $('#cs'); if (cs) cs.disabled = chatBusy;
}
async function sendChat(text) {
  text = text.trim();
  if (!text || chatBusy) return;
  chat.push({ role: 'user', content: text }); chatBusy = true; drawChat();
  try {
    const r = await api('/agent/chat', 'POST', { messages: chat.filter((m) => !m.error).map(({ role, content }) => ({ role, content })) });
    chat.push({ role: 'assistant', content: r.reply, actions: r.actions });
    if (r.actions?.some((a) => a.ok && ['register_student', 'cancel_registration', 'create_event'].includes(a.tool)) && ['events', 'registrations', 'manage', 'dashboard'].includes(currentRoute)) route();
  } catch (e) { chat.push({ role: 'assistant', content: e.message, error: true }); }
  chatBusy = false; drawChat();
}

// ---------- boot ----------
(async () => {
  try { status = await (await fetch('/api/status')).json(); } catch { /* assistant shows as offline */ }
  route();
})();
