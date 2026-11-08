import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { randomBytes, randomInt, scrypt as derive, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import worker from './dist/server/index.js';

const scrypt = promisify(derive);
const port = Number(process.env.PORT || 8787);
const origin = 'http://127.0.0.1:' + port;
const reserved = [process.env.OWNER_EMAIL || 'owner@luojia.test', ...[1,2,3].map(i => process.env['DEVELOPER_' + i + '_EMAIL'] || '')].map(value => value.trim().toLowerCase());
if (new Set(reserved.filter(Boolean)).size !== reserved.filter(Boolean).length) throw new Error('开发者邮箱重复');
mkdirSync('.local-data', { recursive: true });
const db = new DatabaseSync('.local-data/accounts.sqlite');
db.exec(`CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, username TEXT COLLATE NOCASE UNIQUE,
  salt TEXT, password_hash TEXT
)`);
const profile = email => db.prepare('SELECT id, username FROM accounts WHERE email = ?').get(email);
for (const { id, email } of db.prepare('SELECT id, email FROM accounts WHERE id < 4').all()) {
  if (reserved[id] !== email) throw new Error('本地数据库已绑定不同的开发者邮箱，请为新配置使用新的测试数据库');
}
const codes = new Map();
const sessions = new Map();
const attempts = new Map();
const ttl = 3600_000;

function issue(email, verified = false) {
  for (const [key, value] of sessions) if (value.expires < Date.now()) sessions.delete(key);
  const token = 'local.' + randomBytes(24).toString('base64url') + '.session';
  sessions.set(token, { email, verified, expires: Date.now() + ttl });
  return token;
}

const accounts = {
  profile, issue,
  revoke(token) { sessions.delete(token); },
  canSetPassword(token) {
    const session = sessions.get(token);
    return session?.verified && session.expires - Date.now() > ttl - 600_000;
  },
  rename(email, username) {
    try { db.prepare('UPDATE accounts SET username = ? WHERE email = ?').run(username, email); return true; }
    catch (error) { if (error.errcode === 2067) return false; throw error; }
  },
  async setPassword(email, password) {
    const salt = randomBytes(16).toString('hex');
    const hash = await scrypt(password, salt, 64);
    db.prepare('UPDATE accounts SET salt = ?, password_hash = ? WHERE email = ?').run(salt, hash.toString('hex'), email);
    for (const [key, value] of sessions) if (value.email === email) sessions.delete(key);
  },
  async login(email, password) {
    if (!email || email.length > 254 || password.length < 12 || password.length > 128) return null;
    const now = Date.now();
    for (const [key, item] of attempts) if (item.until <= now) attempts.delete(key);
    if (!attempts.has(email) && attempts.size >= 500) return null;
    const attempt = attempts.get(email) || { count: 0, until: now + 300_000 };
    if (attempt.count >= 5) return null;
    attempt.count++;
    attempts.set(email, attempt);
    const row = db.prepare('SELECT salt, password_hash FROM accounts WHERE email = ?').get(email);
    const hash = await scrypt(password, row?.salt || 'local-dummy-salt', 64);
    const expected = row?.password_hash ? Buffer.from(row.password_hash, 'hex') : Buffer.alloc(64);
    if (!timingSafeEqual(hash, expected) || !row?.password_hash) return null;
    attempts.delete(email);
    return issue(email);
  }
};

function transport(url, options) {
  const endpoint = url.split('/').at(-1);
  const now = Date.now();
  if (endpoint === 'user') {
    const session = sessions.get(options.headers.Authorization?.slice(7));
    if (!session || session.expires <= now) return new Response(null, { status: 401 });
    return Response.json({ id: String(profile(session.email).id), email: session.email, email_confirmed_at: 'local-test' });
  }
  const { email, token } = JSON.parse(options.body);
  if (endpoint === 'otp') {
    for (const [key, item] of codes) if (item.expires <= now) codes.delete(key);
    if (codes.get(email)?.sent + 30_000 > now || codes.size >= 100) return new Response(null, { status: 429 });
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    codes.set(email, { code, sent: now, expires: now + 300_000, attempts: 0 });
    console.log('本地验证码 [%s] %s（5 分钟有效）', email, code);
    return Response.json({});
  }
  const challenge = codes.get(email);
  if (endpoint !== 'verify' || !challenge || challenge.expires <= now || challenge.attempts >= 5) return new Response(null, { status: 400 });
  challenge.attempts++;
  if (challenge.code !== token) return new Response(null, { status: 400 });
  codes.delete(email);
  if (!profile(email)) {
    const slot = reserved.indexOf(email);
    const id = slot >= 0 ? slot : db.prepare('SELECT MAX(3, COALESCE(MAX(id), 3)) + 1 AS id FROM accounts').get().id;
    db.prepare('INSERT INTO accounts (id, email) VALUES (?, ?)').run(id, email);
  }
  return Response.json({ access_token: issue(email, true), expires_in: 3600, user: { email_confirmed_at: 'local-test' } });
}

const env = { SUPABASE_URL: 'https://local.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'local-only', LOCAL_AUTH_TRANSPORT: transport, ACCOUNTS: accounts };
createServer(async (req, res) => {
  try {
    if (req.headers.host !== '127.0.0.1:' + port || !req.url?.startsWith('/') || req.url.startsWith('//')) {
      res.writeHead(403).end();
      return;
    }
    const init = { method: req.method, headers: req.headers };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      init.body = Readable.toWeb(req);
      init.duplex = 'half';
    }
    const response = await worker.fetch(new Request(origin + req.url, init), env);
    for (const [key, value] of response.headers) res.setHeader(key, value);
    // Loopback uses HTTP, so use a local cookie name and drop Secure at this boundary.
    const cookie = response.headers.get('set-cookie');
    if (cookie) res.setHeader('Set-Cookie', cookie.replace('__Host-luojia_session', 'luojia_local_session').replace('; Secure', ''));
    res.statusCode = response.status;
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch { res.writeHead(500).end('本地服务出错'); }
}).prependListener('request', req => {
  if (req.headers.cookie) req.headers.cookie = req.headers.cookie.replace(/(^|;\s*)luojia_local_session=/g, '$1__Host-luojia_session=');
}).listen(port, '127.0.0.1', () => console.log('珞珈骑迹本地测试版 %s', origin));
