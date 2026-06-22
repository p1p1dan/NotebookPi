import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

const PASSWORD = process.env.NOTEBOOK_PASSWORD;
const SECRET = process.env.SESSION_SECRET;
const API_TOKEN = process.env.API_TOKEN || '';   // optional, enables Bearer-auth for scripts/AI
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1';
const COOKIE_NAME = 'session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

if (!PASSWORD) {
  console.error('FATAL: NOTEBOOK_PASSWORD env var is required');
  process.exit(1);
}
if (!SECRET || SECRET.length < 16) {
  console.error('FATAL: SESSION_SECRET env var is required (>=16 chars). Generate one with:');
  console.error('  node -e "console.log(require(\\"crypto\\").randomBytes(32).toString(\\"hex\\"))"');
  process.exit(1);
}
if (API_TOKEN && API_TOKEN.length < 16) {
  console.error('FATAL: API_TOKEN (if set) must be at least 16 chars to be brute-force resistant');
  process.exit(1);
}

const sign = (payload) => createHmac('sha256', SECRET).update(payload).digest('hex');

function makeToken() {
  const expires = Date.now() + SESSION_TTL_MS;
  const payload = String(expires);
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot < 1) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(payload);
  if (sig.length !== expected.length) return false;
  try {
    if (!timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return false;
  } catch {
    return false;
  }
  const expires = Number(payload);
  if (!Number.isFinite(expires) || expires < Date.now()) return false;
  return true;
}

function safeEqualStr(a, b) {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) {
    // still consume time
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

const cookieOpts = {
  httpOnly: true,
  sameSite: 'lax',
  secure: COOKIE_SECURE,
  path: '/',
  maxAge: Math.floor(SESSION_TTL_MS / 1000),
};

export async function authRoutes(app) {
  app.post('/api/login', async (req, reply) => {
    const { password } = req.body ?? {};
    if (typeof password !== 'string' || !safeEqualStr(password, PASSWORD)) {
      // small delay to slow brute force in case of misconfig (no rate limiter yet)
      await new Promise(r => setTimeout(r, 300 + Math.floor(Math.random() * 200)));
      return reply.code(401).send({ error: 'invalid_password' });
    }
    reply.setCookie(COOKIE_NAME, makeToken(), cookieOpts);
    return { ok: true };
  });

  app.post('/api/logout', async (_req, reply) => {
    reply.clearCookie(COOKIE_NAME, { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', async (req) => {
    return { authed: verifyToken(req.cookies?.[COOKIE_NAME]) };
  });
}

export async function requireAuth(req, reply) {
  // Path 1: browser session cookie.
  if (verifyToken(req.cookies?.[COOKIE_NAME])) return;
  // Path 2: API token via Authorization: Bearer <token> (for AI / CLI / curl).
  if (API_TOKEN) {
    const h = req.headers?.authorization || '';
    if (h.startsWith('Bearer ')) {
      const supplied = h.slice(7).trim();
      if (safeEqualStr(supplied, API_TOKEN)) return;
    }
  }
  return reply.code(401).send({ error: 'unauthorized' });
}

// exported helpers if other modules need them
export { verifyToken };
export const newShareToken = () => randomBytes(16).toString('base64url');
