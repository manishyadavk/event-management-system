# CampusEvents: AI-Powered Event Management System

A full-stack web app where students discover and register for college workshops and seminars, admins manage events and participants, and an **LLM agent with real tools** can search, look up and act on the data. Every registration creates a **real Google Calendar event**.

```
Student/Admin → Frontend (public/) → Backend (Express) → Database (SQLite)
                                          │──→ AI Agent (Claude) → AI tools → same service layer → Database
                                          └──→ Google Calendar API
```

## 1. Problem statement
A college runs workshops and seminars and wants to digitise registrations, participant management and event communication, combining a working frontend, backend, database, an LLM-powered agent and the Google Calendar API.

## 2. Features
- **Students:** sign up/log in, browse events (search, category, date and availability filters), event details, one-click registration, "My registrations" with Google Calendar sync status and retry, cancel, AI assistant.
- **Admins:** dashboard (totals, upcoming, recent registrations, popular events, per-category chart), event CRUD with validation, participant lists and search/filter, student list/add, AI assistant with admin tools.
- **Rules enforced in the backend and database:** no duplicate registration (`UNIQUE(student_id,event_id)` + check), capacity limit ("Event Full"), no registration for events that have started, validation on every input.
- **Resilience:** if Google Calendar fails the registration stays saved; the user sees *"Registration successful, but Google Calendar synchronization failed."* and can retry. Raw provider errors are logged server-side only.

## 3. Tech stack
| Layer | Choice |
|---|---|
| Frontend | Vanilla JS single-page app (`public/`), no build step, responsive CSS, XSS-safe templating |
| Backend | Node.js 22+ / Express 4 |
| Database | SQLite via Node's built-in `node:sqlite` (file `events.db`) |
| LLM | **Anthropic Claude** through the official SDK (`ANTHROPIC_MODEL`, default `claude-opus-5-5`) |
| Calendar | Google Calendar API v3 (`googleapis`, OAuth2 refresh token) |
| Auth | Scrypt-hashed student passwords, HMAC-signed 8-hour bearer tokens, admin password from env, login rate limiting |

## 4. Architecture
- **Frontend** only calls `/api/*`. It never touches the DB, Google or the LLM, and never holds secrets.
- **Backend** (`server/index.js`) authenticates, authorises by role, validates, and calls the **service layer** (`server/services.js`), the single place where business rules and SQL live.
- **AI agent** (`server/agent.js`) runs a tool-use loop: Claude picks a tool → backend executes it through the *same* service layer as the REST API → the result goes back to Claude → Claude answers.
- **Google Calendar** (`server/calendar.js`) is called by the service layer after the registration row is committed.

Files: `server/{index,services,agent,calendar,auth,db,seed}.js`, `public/{index.html,app.js,style.css}`, `scripts/google-auth.js`, `tests/api.test.mjs`.

## 5. Database schema (SQLite)
```
students(student_id PK, name, email UNIQUE, course, password_hash)
events(event_id PK, name, description, category, date YYYY-MM-DD, time HH:MM, venue, max_capacity CHECK >0)
registrations(registration_id PK, student_id FK→students, event_id FK→events, registration_date,
              status CHECK IN ('confirmed','cancelled'), calendar_status, calendar_link, calendar_event_id, calendar_error,
              UNIQUE(student_id, event_id))
indexes: registrations(event_id,status), registrations(student_id), events(date)
```
Student → Registration → Event. Foreign keys are enforced (`PRAGMA foreign_keys=ON`, `ON DELETE CASCADE`). Registration runs in a `BEGIN IMMEDIATE` transaction so two simultaneous requests cannot oversell a seat.

## 6. API (all JSON, `Authorization: Bearer <token>`)
| Method & route | Access | Purpose |
|---|---|---|
| `GET /api/status`, `GET /api/public/events` | public | feature flags/categories; upcoming-event preview |
| `POST /api/auth/student/login`, `/student/signup`, `/admin/login` | public (rate limited) | get a token |
| `GET /api/events?q&category&from&to&upcoming` | any user | list/filter events (with `registered`, `seats_left`) |
| `GET /api/events/:id` | any user | event details |
| `POST /api/events`, `PUT/PATCH /api/events/:id`, `DELETE /api/events/:id` | admin | event CRUD |
| `GET /api/events/:id/participants` | admin | participant list |
| `GET /api/students`, `POST /api/students` | admin | list / create student |
| `GET /api/students/:id`, `GET /api/students/:id/registrations` | admin or that student | one student / their registrations |
| `POST /api/registrations {event_id}` | student | **register** (validate → DB → Calendar → confirmation) |
| `GET /api/registrations/mine` | student | own registrations |
| `GET /api/registrations?event_id&q&status` | admin | all registrations / participants |
| `GET /api/registrations/:id` | admin or owner | one registration |
| `DELETE /api/registrations/:id` | student (own) | cancel (also removes the calendar event) |
| `POST /api/registrations/:id/retry-calendar` | student (own) | retry Google Calendar sync |
| `GET /api/admin/dashboard` (alias `/api/stats`) | admin | totals, upcoming, popular, recent, per-category |
| `POST /api/agent/chat {messages}` | student or admin | AI agent |

## 7. AI agent
**What it is:** the LLM is given a set of tools and decides which to call for a natural-language request. It does not guess: it reads real data and performs real actions. This is what separates it from a chatbot that only generates text.

| Tool | Who | What it does |
|---|---|---|
| `get_events` | student, admin | list events by category/date range/upcoming |
| `search_events` | student, admin | keyword search + date range ("AI workshops this month") |
| `get_event_details` | student, admin | one event in full (capacity, seats left) |
| `get_registration_count` | student, admin | confirmed registrations for an event or in total |
| `get_student_details` | student (self) / admin (lookup) | profile |
| `get_student_registrations` | student | "Am I registered for…?" / all own registrations |
| `register_student` | student (self only) | find student → validate event → capacity → duplicate → INSERT → Google Calendar → real result |
| `cancel_registration` | student (self only) | cancel own registration |
| `get_participants` | **admin only** | participant names/emails for an event |
| `get_admin_statistics` | **admin only** | dashboard statistics |
| `create_event` | **admin only** | create an event |

**Authorization:** the student identity comes from the verified login token, never from model arguments. Tools are filtered by role *and* re-checked on the server in `dispatch()`, so a student cannot reach admin tools even if the model asks for one. Tool errors (full, duplicate, past) are returned to the model and explained to the user. The UI shows each tool call as a chip under the answer.

Example prompts: "Show me upcoming AI workshops.", "What events am I registered for?", "How many students registered for the AI workshop?", "Register me for the business analytics workshop.", "Show technology events this month."

## 8. Google Calendar integration
After the registration row is committed, `createCalendarEvent()` calls `calendar.events.insert` with the event name, description, date, start/end time (duration `EVENT_DURATION_MINUTES`), venue as location, the student as attendee (invite email) and reminders. The returned event id and link are stored on the registration. Failure → `calendar_status='failed'`, registration kept, retry endpoint available. Cancelling a registration or deleting an event deletes the calendar events.

## 9. Environment variables (`.env`, copy from `.env.example`)
`SESSION_SECRET` (required), `ADMIN_PASSWORD`, `DEMO_STUDENT_PASSWORD`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `GOOGLE_CALENDAR_ID`, `EVENT_TIMEZONE`, `EVENT_DURATION_MINUTES`, `PORT`, optional `DB_PATH`, `LOGIN_RATE_LIMIT`. `.env` is git-ignored; nothing secret is in the frontend.

## 10. Install, database, seed, run
```bash
npm install
cp .env.example .env        # fill in SESSION_SECRET, ADMIN_PASSWORD, ANTHROPIC_API_KEY, Google values
npm start                   # http://localhost:3000
```
The database (`events.db`) is created and seeded automatically on first start (8 students, 10 events across all categories, 18 registrations; one event, Cybersecurity, is deliberately full). `npm run seed` seeds an empty DB manually. To reset, stop the server and delete `events.db*`.
Demo logins: students `aarav.sharma@example.com` … password `Student@123` (or your `DEMO_STUDENT_PASSWORD`); admin password is your `ADMIN_PASSWORD`.

### One-time Google Calendar setup
1. Google Cloud Console → new project → enable **Google Calendar API**.
2. OAuth consent screen → add your Google account as a *test user*.
3. Credentials → OAuth client ID → *Web application* → redirect URI `http://localhost:3001/oauth2callback`.
4. Put the client id/secret in `.env`, run `npm run google-auth`, approve in the browser, paste the printed `GOOGLE_REFRESH_TOKEN` into `.env`, restart.
Use a student email you can read (sign up with your own address) so the invite lands in your inbox/calendar.

## 11. Tests
`npm test` starts the real server on a temp database and checks auth, seed data, filters, registration (success/duplicate/full/past), authorization on every admin route, event CRUD, dashboard stats, the agent's tool loop and role gating. **The LLM in this suite is a local mock that scripts tool calls**, so it proves the agent loop, tools, permissions and DB writes, not the model's language understanding. Google Calendar is left unconfigured, which exercises the real failure path. `npm run check` syntax-checks backend and frontend (there is no build step).

## 12. End-to-end demo
1. Student logs in → **Events** → open **AI & Machine Learning Workshop** → **Register**. The backend validates, inserts the row, calls Google Calendar and returns the confirmation modal (with Calendar status).
2. **My registrations** shows the record and sync status; the event's seat count dropped.
3. Open **Ask AI** → "Am I registered for the AI workshop?" (tool `get_student_registrations`, answer from the DB).
4. "How many students have registered?" (`get_registration_count`).
5. "Register me for the business analytics workshop." (`search_events` → `register_student`, real DB write + calendar event). Refresh My registrations to see it.
6. Try registering twice → "You are already registered for this event."; try Cybersecurity → "Event Full".
7. Log in as admin → Dashboard shows the new registrations; Events (create/edit/delete); Registrations (search/filter by event); open the AI as admin: "Who is registered for the cybersecurity workshop?".

## 13. Security
Secrets only in `.env`; `.env`, `*.db` git-ignored; passwords hashed with scrypt; signed expiring tokens; role checks on every route and every AI tool; students can read only their own data; same error for unknown email vs wrong password; login rate limit; parameterised SQL only; all rendered values HTML-escaped; JSON body size limit; security headers; raw Google/LLM errors never returned to clients. Known limits: tokens live in `sessionStorage` (no HttpOnly cookie), the rate limiter is in-memory and single-process, the admin is a single shared password. Fine for a college deployment behind HTTPS, worth hardening for more.

## 14. Viva explanation
1. **Problem:** manual event sign-ups, no capacity control, no participant lists, no reminders.
2. **Frontend:** UI only, with views, filters, forms and the chat panel; talks to `/api` and holds no secrets.
3. **Backend:** authentication, authorisation, validation, business rules (capacity, duplicates, past events), database access, the AI agent and Google Calendar.
4. **Data storage / database:** SQLite file `events.db`, three related tables with keys, constraints and indexes.
5. **LLM:** Anthropic Claude (configured by `ANTHROPIC_MODEL`).
6. **AI agent:** an LLM that can choose and call tools to read data and take actions, then report the actual result.
7. **Vs. a chatbot:** a chatbot only produces text from its training; this agent queries the live database and can write to it (register a student) through permission-checked tools.
8. **Tools:** see the table in section 7.
9. **How AI talks to the backend:** `POST /api/agent/chat` → `runAgent()` → tool call → `dispatch()` → service layer → SQLite/Calendar → tool result → model → reply.
10. **Google API:** Google Calendar API (v3, `events.insert`/`events.delete`).
11. **Why Calendar:** registrations become reminders in the tool students already use, which makes event communication automatic.
12. **Credentials:** server-side `.env` only; the OAuth refresh token is created once with `npm run google-auth`.
13. **If Google fails:** registration is already committed; status becomes `failed`, the user gets the "synchronization failed" notice, the error is logged server-side, and "Retry" re-runs the sync.
14. **Whole flow:** Student → Frontend → Backend (validate) → DB (insert) → Google Calendar → Backend → Frontend confirmation; and Student → Frontend → Backend → AI agent → tools → DB.
15. **Vibe-coded part:** the scaffold and most code were generated with Claude Code (AI-assisted); the schema, business rules, tool permissions and security decisions were reviewed and tested by the developer. Be ready to explain any file, since you are responsible for it.
