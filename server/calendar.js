import { google } from 'googleapis';

// Credentials come ONLY from environment variables (.env, never the frontend or git).
export function calendarConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN);
}

function client() {
  const auth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return google.calendar({ version: 'v3', auth });
}

const calId = () => process.env.GOOGLE_CALENDAR_ID || 'primary';

function endDateTime(date, time, minutes) {
  // Pure string/Date-UTC arithmetic so the result isn't shifted by the server timezone.
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d, hh, mm + minutes));
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}T${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:00`;
}

/** Creates a real Google Calendar event and invites the student by email. */
export async function createCalendarEvent(event, student) {
  if (!calendarConfigured()) throw new Error('Google Calendar is not configured (missing GOOGLE_* env vars).');
  const tz = process.env.EVENT_TIMEZONE || 'Asia/Kolkata';
  const minutes = Number(process.env.EVENT_DURATION_MINUTES) || 120;
  const res = await client().events.insert({
    calendarId: calId(),
    sendUpdates: 'all',
    requestBody: {
      summary: event.name,
      description: `${event.description}\n\nRegistered via the College Event Management System.`,
      location: event.venue,
      start: { dateTime: `${event.date}T${event.time}:00`, timeZone: tz },
      end: { dateTime: endDateTime(event.date, event.time, minutes), timeZone: tz },
      attendees: [{ email: student.email, displayName: student.name }],
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 60 }, { method: 'email', minutes: 1440 }] },
    },
  });
  return { id: res.data.id, link: res.data.htmlLink };
}

export async function deleteCalendarEvent(calendarEventId) {
  if (!calendarConfigured() || !calendarEventId) return;
  await client().events.delete({ calendarId: calId(), eventId: calendarEventId, sendUpdates: 'all' });
}
