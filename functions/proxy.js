/**
 * Cloudflare Pages Functions: 外部资源代理
 * 目的：把被部分网络屏蔽/跨域受限的资源（图片/JSON等）通过同域转发，提升可访问性。
 *
 * 使用方式：
 *   /proxy?url=https%3A%2F%2Fexample.com%2Fxxx.png
 *
 * 安全说明（避免变成公开滥用的“万能代理”）：
 * - 仅允许 GET/HEAD
 * - 禁止代理本机/内网/保留地址
 * - 默认要求浏览器的同源请求（Sec-Fetch-Site: same-origin），降低被第三方站点直接调用的风险
 * - 可选：通过环境变量 PROXY_ALLOWLIST 限制可代理域名（逗号分隔），例如：
 *     PROXY_ALLOWLIST=raw.githubusercontent.com,cdn.jsdelivr.net,opennana.com
 *   如果设置为 "*" 则放开域名限制
 */

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024; // 25MB

function isPrivateHost(hostname) {
  const host = String(hostname || '').trim().toLowerCase();
  if (!host) return true;

  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;

  // IPv4
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    const parts = host.split('.').map(n => Number(n));
    if (parts.some(n => Number.isNaN(n) || n < 0 || n > 255)) return true;
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
  }

  // IPv6（粗略）
  if (host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true;

  return false;
}

function parseAllowlist(envValue) {
  const raw = String(envValue || '').trim();
  if (!raw) return null;
  if (raw === '*') return '*';
  const items = raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return items.length ? items : null;
}

function isAllowedHost(hostname, allowlist) {
  if (!allowlist) return true;
  if (allowlist === '*') return true;
  const host = String(hostname || '').trim().toLowerCase();
  return allowlist.some(rule => host === rule || host.endsWith(`.${rule}`));
}

function getMaxBytes(envValue) {
  const n = Number(envValue);
  if (Number.isFinite(n) && n > 0) return n;
  return DEFAULT_MAX_BYTES;
}

export async function onRequest(context) {
  const { request, env } = context;
  const reqUrl = new URL(request.url);

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('只支持 GET/HEAD', { status: 405 });
  }

  // 默认只接受同源触发，避免成为公开的“万能代理”
  // 说明：Sec-Fetch-Site 在现代浏览器里基本都会带；若缺失则退化为 Origin/Referer 校验。
  const secFetchSite = request.headers.get('sec-fetch-site');
  const origin = request.headers.get('origin');
  const referer = request.headers.get('referer');
  const isSameOriginHeader = (value) => {
    if (!value) return false;
    try {
      return new URL(value).origin === reqUrl.origin;
    } catch {
      return false;
    }
  };

  if (secFetchSite) {
    if (secFetchSite !== 'same-origin') return new Response('禁止跨站调用', { status: 403 });
  } else {
    if (!isSameOriginHeader(origin) && !isSameOriginHeader(referer)) {
      return new Response('禁止跨站调用', { status: 403 });
    }
  }

  const target = reqUrl.searchParams.get('url');
  if (!target) return new Response('缺少 url 参数', { status: 400 });

  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch {
    return new Response('url 参数不合法', { status: 400 });
  }

  if (!['http:', 'https:'].includes(targetUrl.protocol)) {
    return new Response('只支持 http/https', { status: 400 });
  }

  if (targetUrl.hostname === reqUrl.hostname) {
    return new Response('禁止代理本站地址', { status: 403 });
  }

  if (isPrivateHost(targetUrl.hostname)) {
    return new Response('禁止代理内网/保留地址', { status: 403 });
  }

  const allowlist = parseAllowlist(env && env.PROXY_ALLOWLIST);
  if (!isAllowedHost(targetUrl.hostname, allowlist)) {
    return new Response('该域名未加入代理白名单', { status: 403 });
  }

  const maxBytes = getMaxBytes(env && env.PROXY_MAX_BYTES);

  const upstreamHeaders = new Headers();
  const accept = request.headers.get('accept');
  const range = request.headers.get('range');
  const userAgent = request.headers.get('user-agent');
  if (accept) upstreamHeaders.set('accept', accept);
  if (range) upstreamHeaders.set('range', range);
  if (userAgent) upstreamHeaders.set('user-agent', userAgent);

  let upstream;
  try {
    upstream = await fetch(targetUrl.toString(), {
      method: request.method,
      headers: upstreamHeaders,
      redirect: 'follow',
      cf: { cacheEverything: true, cacheTtl: 86400 }
    });
  } catch (err) {
    const msg = err && err.message ? err.message : String(err || 'Upstream fetch failed');
    return new Response(`代理请求失败: ${msg}`, { status: 502 });
  }

  const contentLength = upstream.headers.get('content-length');
  if (contentLength && Number(contentLength) > maxBytes) {
    return new Response('资源过大，已拒绝', { status: 413 });
  }

  const headers = new Headers(upstream.headers);
  headers.set('access-control-allow-origin', '*');
  headers.set('x-proxy-by', 'cloudflare-pages');

  // 防止透传敏感头
  headers.delete('set-cookie');
  headers.delete('set-cookie2');

  // 尽量缓存（上游若已设置 cache-control 则尊重）
  if (!headers.get('cache-control')) {
    headers.set('cache-control', 'public, max-age=86400');
  }

  return new Response(upstream.body, { status: upstream.status, headers });
}
