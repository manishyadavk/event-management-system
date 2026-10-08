import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
export const db = new DatabaseSync(process.env.DB_PATH || path.join(dir, '..', 'events.db'));

db.exec(`
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS students (
  student_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  course        TEXT NOT NULL,
  password_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  event_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  category     TEXT NOT NULL DEFAULT 'Technology',
  date         TEXT NOT NULL,            -- YYYY-MM-DD
  time         TEXT NOT NULL,            -- HH:MM (24h)
  venue        TEXT NOT NULL,
  max_capacity INTEGER NOT NULL CHECK (max_capacity > 0)
);

CREATE TABLE IF NOT EXISTS registrations (
  registration_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id        INTEGER NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
  event_id          INTEGER NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
  registration_date TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','cancelled')),
  calendar_status   TEXT NOT NULL DEFAULT 'pending', -- pending | created | failed
  calendar_link     TEXT,
  calendar_event_id TEXT,
  calendar_error    TEXT,
  UNIQUE (student_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_reg_event   ON registrations(event_id, status);
CREATE INDEX IF NOT EXISTS idx_reg_student ON registrations(student_id);
CREATE INDEX IF NOT EXISTS idx_events_date ON events(date);
`);

export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
