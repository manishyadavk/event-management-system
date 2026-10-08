// One-time helper: obtains a Google OAuth refresh token for the calendar owner.
// Usage: npm run google-auth   (needs GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in .env)
import 'dotenv/config';
import http from 'node:http';
import { google } from 'googleapis';

const { GOOGLE_CLIENT_ID: id, GOOGLE_CLIENT_SECRET: secret } = process.env;
if (!id || !secret) { console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first.'); process.exit(1); }

const redirect = 'http://localhost:3001/oauth2callback';
const oauth = new google.auth.OAuth2(id, secret, redirect);
const url = oauth.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: ['https://www.googleapis.com/auth/calendar.events'] });

console.log('\nOpen this URL in your browser and approve access:\n\n' + url + '\n');
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost:3001');
  if (u.pathname !== '/oauth2callback') { res.end(); return; }
  try {
    const { tokens } = await oauth.getToken(u.searchParams.get('code'));
    res.end('Done! You can close this tab and return to the terminal.');
    console.log('\nAdd this line to your .env (keep it secret):\n\nGOOGLE_REFRESH_TOKEN=' + tokens.refresh_token + '\n');
  } catch (e) { res.end('Failed: ' + e.message); console.error(e.message); }
  server.close();
});
server.listen(3001);
