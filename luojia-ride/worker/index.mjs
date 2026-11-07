import { home, policy } from './content.mjs';

const signIn = '/signin-with-chatgpt?return_to=%2Faccount';
const signOut = '/signout-with-chatgpt?return_to=%2F';

function roleFor(request, env) {
  // Sites Dispatch supplies verified identity headers to the hosted Worker.
  const id = request.headers.get('oai-authenticated-user-id');
  const email = request.headers.get('oai-authenticated-user-email')?.trim().toLowerCase();
  if (!id || !email) return 'guest';
  const developers = (env.DEVELOPER_EMAILS || '').split(',').map(value => value.trim().toLowerCase());
  return developers.includes(email) ? 'developer' : 'user';
}

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
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Strict-Transport-Security': 'max-age=31536000',
    ...extra
  } });
}

export default {
  fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return respond('此页面只支持读取。', 405, { Allow: 'GET, HEAD' });
    }
    const role = roleFor(request, env);
    const body = request.method === 'HEAD' ? null : undefined;
    const render = (html, status) => respond(body === null ? null : html, status);
    if (path === '/' || path === '/index.html') {
      const link = role === 'guest'
        ? '<a href="' + signIn + '" target="_top">使用 ChatGPT 登录</a>'
        : '<a href="/account">我的账号</a>';
      return render(home.replace('<!-- hosted-account -->', link));
    }
    if (path === '/account' || path === '/developer') {
      if (role === 'guest') return respond(null, 302, { Location: signIn });
      if (path === '/developer') {
        if (role !== 'developer') return render(page('访问受限', '<p>此页面需要开发者权限。</p>'), 403);
        return render(page('开发者工作台', '<p>身份校验通过。当前站点提供公开内容、账号入口和演示预测。</p><p>调研状态可在<a href="/#survey">线下调研</a>查看。</p><p><a href="/account">返回账号</a></p>'));
      }
      const label = role === 'developer' ? '开发者' : '普通用户';
      const dashboard = role === 'developer' ? '<p><a href="/developer">进入开发者工作台</a></p>' : '';
      return render(page('我的账号', '<p>当前身份为<strong>' + label + '</strong>。</p>' + dashboard +
        '<p><a href="' + signOut + '" target="_top">退出登录</a></p>'));
    }
    return render(page('页面不存在', '<p>请从首页进入对应栏目。</p>'), 404);
  }
};
