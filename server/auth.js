import crypto from 'node:crypto';

const secret = () => {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) throw new Error('SESSION_SECRET must be set (16+ chars) in .env');
  return s;
};

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `${salt.toString('hex')}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
export function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash || typeof pw !== 'string') return false;
  const a = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 64), b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Minimal in-memory limiter for login endpoints (per IP): 10 attempts / 5 min.
const hits = new Map();
export function loginLimiter(req, res, next) {
  const k = req.ip, now = Date.now();
  const arr = (hits.get(k) || []).filter((t) => now - t < 300000);
  if (arr.length >= (Number(process.env.LOGIN_RATE_LIMIT) || 10)) return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes.' });
  arr.push(now); hits.set(k, arr);
  next();
}
const b64 = (b) => Buffer.from(b).toString('base64url');

export function signToken(payload) {
  const body = b64(JSON.stringify({ ...payload, exp: Date.now() + 8 * 3600 * 1000 }));
  const sig = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp > Date.now() ? p : null;
  } catch {
    return null;
  }
}

export function requireAuth(role) {
  return (req, res, next) => {
    const h = req.headers.authorization || '';
    const user = verifyToken(h.startsWith('Bearer ') ? h.slice(7) : '');
    if (!user) return res.status(401).json({ error: 'Please log in.' });
    if (role && user.role !== role) return res.status(403).json({ error: 'Not allowed for your role.' });
    req.user = user;
    next();
  };
}

export function checkAdminPassword(pw) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || typeof pw !== 'string') return false;
  const a = crypto.createHash('sha256').update(pw).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}
