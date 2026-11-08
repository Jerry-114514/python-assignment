import { home, policy } from './content.mjs';

const cookieName = '__Host-luojia_session';
const cookieFlags = 'Path=/; Secure; HttpOnly; SameSite=Lax';
const redirect = (path, headers = {}) => respond(null, 303, { Location: path, ...headers });

function page(title, body) {
  return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' +
    title + ' · 珞珈骑迹</title><main><p><a href="/">返回珞珈骑迹</a></p><h1>' + title + '</h1>' + body + '</main></html>';
}

function respond(body, status = 200, extra = {}) {
  return new Response(body, { status, headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': policy,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Strict-Transport-Security': 'max-age=31536000',
    ...extra
  } });
}

const emailField = '<label>邮箱 <input type="email" name="email" autocomplete="email" maxlength="254" required></label>';
const back = '<p><a href="/login">返回邮箱登录</a></p>';
const logout = '<form method="post" action="/logout"><button>退出登录</button></form>';

function loginPage(message = '') {
  return page('邮箱登录', message +
    '<form method="post" action="/login/send">' + emailField + ' <button>发送验证码</button></form>' +
    '<p><a href="/login/code">已收到验证码</a></p>');
}

function codePage(message = '') {
  return page('输入验证码', message + '<p>请输入收件邮箱和邮件中的一次性验证码。</p>' +
    '<form method="post" action="/login/verify">' + emailField +
    ' <label>验证码 <input name="code" autocomplete="one-time-code" inputmode="numeric" pattern="[0-9]{6,8}" maxlength="8" required></label> <button>登录</button></form>' + back);
}

function provider(env) {
  const url = env.SUPABASE_URL?.trim();
  const key = env.SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!key || !/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url || '')) return null;
  return { url, key, transport: env.LOCAL_AUTH_TRANSPORT || fetch };
}

function auth(config, endpoint, { data, token } = {}) {
  const headers = { apikey: config.key };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (data) headers['Content-Type'] = 'application/json';
  return config.transport(config.url + '/auth/v1/' + endpoint, {
    method: data ? 'POST' : 'GET',
    headers,
    body: data ? JSON.stringify(data) : undefined,
    redirect: 'error',
    signal: AbortSignal.timeout(8000)
  });
}

function sessionToken(request) {
  const cookie = request.headers.get('Cookie') || '';
  const value = cookie.split(';').map(part => part.trim()).find(part => part.startsWith(cookieName + '='));
  const token = value?.slice(cookieName.length + 1) || '';
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) && token.length < 3800 ? token : null;
}

async function identityFor(request, env, config) {
  const token = sessionToken(request);
  if (!token || !config) return null;
  const response = await auth(config, 'user', { token });
  if (response.status === 401 || response.status === 403) return null;
  if (!response.ok) throw new Error('Identity service unavailable');
  const user = await response.json();
  if (!user.id || !user.email || !user.email_confirmed_at) return null;
  const email = user.email.trim().toLowerCase();
  const developers = (env.DEVELOPER_EMAILS || '').split(',').map(value => value.trim().toLowerCase());
  const profile = env.ACCOUNTS?.profile(email);
  return { email, profile, role: profile ? (profile.id < 4 ? 'developer' : 'user') : (developers.includes(email) ? 'developer' : 'user') };
}

const escapeHtml = value => value.replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const passwordField = '<label>密码 <input type="password" name="password" autocomplete="current-password" maxlength="128" required></label>';

function profileForm(profile) {
  return '<p>用户名 <strong>' + escapeHtml(profile.username || 'luoqier_' + profile.id) + '</strong></p>' +
    '<form method="post" action="/account/profile"><label>新用户名 <input name="username" maxlength="24" required></label> <button>保存用户名</button></form>' +
    '<form method="post" action="/account/password"><label>新密码 <input type="password" name="password" autocomplete="new-password" minlength="12" maxlength="128" required></label> <button>设置登录密码</button></form>';
}

async function smallForm(request) {
  const type = request.headers.get('Content-Type')?.split(';')[0];
  if (type !== 'application/x-www-form-urlencoded' || !request.body) return null;
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) return new URLSearchParams(text + decoder.decode());
    length += value.byteLength;
    if (length > 2048) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
}

async function handlePost(request, url, config, env) {
  if (request.headers.get('Origin') !== url.origin) return respond(page('请求受限', back), 403);
  if (url.pathname === '/logout') {
    env.ACCOUNTS?.revoke(sessionToken(request));
    return redirect('/', { 'Set-Cookie': cookieName + '=; ' + cookieFlags + '; Max-Age=0' });
  }
  const accounts = env.ACCOUNTS;
  if (accounts && url.pathname === '/login/password') {
    const form = await smallForm(request);
    const email = form?.get('email')?.trim().toLowerCase() || '';
    const password = form?.get('password') || '';
    const result = await accounts.login(email, password);
    if (!result) return respond(loginPage('<p>邮箱或密码有误，或尝试次数过多。</p>'), 401);
    return redirect('/account', { 'Set-Cookie': cookieName + '=' + result + '; ' + cookieFlags + '; Max-Age=3600' });
  }
  if (accounts && ['/account/profile', '/account/password'].includes(url.pathname)) {
    const identity = await identityFor(request, env, config);
    if (!identity?.profile) return redirect('/login');
    const form = await smallForm(request);
    if (url.pathname === '/account/profile') {
      const name = form?.get('username')?.trim() || '';
      if (!/^[\p{L}\p{N}_-]{2,24}$/u.test(name) || /^luoqier_/i.test(name) || !accounts.rename(identity.email, name)) {
        return respond(page('用户名不可用', '<p>请用 2–24 个字母、汉字、数字、下划线或连字符。系统前缀和已用名称不可选。</p><a href="/account">返回账号页</a>'), 400);
      }
      return redirect('/account');
    }
    const password = form?.get('password') || '';
    if (password.length < 12 || password.length > 128) return respond(page('密码长度不合适', '<p>请输入 12–128 个字符。</p><a href="/account">返回账号页</a>'), 400);
    if (!accounts.canSetPassword(sessionToken(request))) return respond(page('需要重新验证邮箱', back), 403);
    await accounts.setPassword(identity.email, password);
    return redirect('/account', { 'Set-Cookie': cookieName + '=' + accounts.issue(identity.email) + '; ' + cookieFlags + '; Max-Age=3600' });
  }
  if (url.pathname !== '/login/send' && url.pathname !== '/login/verify') return respond(page('页面不存在', ''), 404);
  if (!config) return respond(page('邮箱登录尚未启用', '<p>请稍后再试。</p>'), 503);
  const form = await smallForm(request);
  const email = form?.get('email')?.trim().toLowerCase() || '';
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return respond(loginPage('<p>请输入有效邮箱。</p>'), 400);
  }
  if (url.pathname === '/login/send') {
    const response = await auth(config, 'otp', { data: { email, create_user: true } });
    if (response.status === 429) return respond(loginPage('<p>操作过于频繁，请稍后再试。</p>'), 429);
    if (!response.ok) return respond(loginPage('<p>暂时无法发送验证码，请稍后重试。</p>'), 503);
    return redirect('/login/code');
  }
  const token = form.get('code')?.trim() || '';
  if (!/^\d{6,8}$/.test(token)) return respond(codePage('<p>请检查验证码格式。</p>'), 400);
  const response = await auth(config, 'verify', { data: { email, token, type: 'email' } });
  if (response.status === 429) return respond(codePage('<p>操作过于频繁，请稍后再试。</p>'), 429);
  if (response.status >= 500) throw new Error('Verification service unavailable');
  if (!response.ok) return respond(codePage('<p>验证码无效或已过期。</p>'), 400);
  const session = await response.json();
  if (!session.user?.email_confirmed_at || !session.access_token ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(session.access_token) ||
      session.access_token.length >= 3800 || !Number.isInteger(session.expires_in) || session.expires_in < 1) {
    throw new Error('Invalid identity service session');
  }
  return redirect('/account', {
    'Set-Cookie': cookieName + '=' + session.access_token + '; ' + cookieFlags + '; Max-Age=' + Math.min(session.expires_in, 3600)
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const config = provider(env);
    const render = (html, status) => respond(request.method === 'HEAD' ? null : html, status);
    try {
      if (request.method === 'POST') return await handlePost(request, url, config, env);
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return respond('此请求方式不受支持。', 405, { Allow: 'GET, HEAD, POST' });
      }
      if (path === '/' || path === '/index.html') {
        return render(home.replace('<!-- hosted-account -->', '<a href="/account">账号与邮箱登录</a>'));
      }
      if (path === '/login' || path === '/login/code') {
        if (!config) return render(page('邮箱登录尚未启用', '<p>请稍后再试。</p>'), 503);
        const alternative = env.ACCOUNTS ? '<p>本地测试版。验证码显示在启动终端。</p><form method="post" action="/login/password">' + emailField + ' ' + passwordField + ' <button>用密码登录</button></form><hr>' : '';
        return render(path === '/login' ? loginPage(alternative) : codePage());
      }
      if (path === '/account' || path === '/developer') {
        const identity = await identityFor(request, env, config);
        if (!identity) return redirect('/login');
        const { role, profile } = identity;
        if (path === '/developer') {
          if (role !== 'developer') return render(page('访问受限', '<p>此页面需要开发者权限。</p>'), 403);
          return render(page('开发者工作台', '<p>身份校验通过。</p><p><a href="/#survey">查看调研状态</a></p><p><a href="/account">返回账号</a></p>'));
        }
        const label = role === 'developer' ? '开发者' : '普通用户';
        const dashboard = role === 'developer' ? '<p><a href="/developer">进入开发者工作台</a></p>' : '';
        return render(page('我的账号', '<p>当前身份为<strong>' + label + '</strong>。</p>' + (profile ? profileForm(profile) : '') + dashboard + logout));
      }
      return render(page('页面不存在', '<p>请从首页进入对应栏目。</p>'), 404);
    } catch {
      return render(page('登录服务暂时不可用', '<p>请稍后重试。</p>'), 503);
    }
  }
};
