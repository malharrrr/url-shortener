import { getAssetFromKV } from '@cloudflare/kv-asset-handler';
import manifestJSON from '__STATIC_CONTENT_MANIFEST';
const assetManifest = JSON.parse(manifestJSON);


function randomSlug(len = 6) {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  let slug = '';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  for (const b of bytes) slug += chars[b % chars.length];
  return slug;
}

async function hashPassword(password) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function requireApiKey(request, env) {
  const key = request.headers.get('X-API-Key');
  if (!key || key !== env.API_KEY) return json({ error: 'Unauthorized' }, 401);
  return null;
}

const PREFIX = 'link:';

async function getLink(env, slug) {
  const raw = await env.URLS.get(`${PREFIX}${slug}`);
  return raw ? JSON.parse(raw) : null;
}

async function putLink(env, slug, data) {
  await env.URLS.put(`${PREFIX}${slug}`, JSON.stringify(data));
}

async function removeLink(env, slug) {
  await env.URLS.delete(`${PREFIX}${slug}`);
}

async function listLinks(env) {
  const list = await env.URLS.list({ prefix: PREFIX });
  const links = await Promise.all(
    list.keys.map(async ({ name }) => {
      const raw = await env.URLS.get(name);
      return raw ? JSON.parse(raw) : null;
    })
  );
  return links.filter(Boolean);
}

async function handleCreate(request, env) {
  const denied = requireApiKey(request, env);
  if (denied) return denied;

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON body' }, 400); }

  const { longUrl, slug: customSlug, ttlSeconds, password } = body;

  if (!longUrl) return json({ error: 'longUrl is required' }, 400);
  try { new URL(longUrl); }
  catch { return json({ error: 'longUrl must be a valid URL' }, 400); }

  if (customSlug && !/^[a-zA-Z0-9_-]{2,32}$/.test(customSlug))
    return json({ error: 'Slug must be 2–32 chars: letters, numbers, - or _' }, 400);

  const slug = customSlug || randomSlug();

  if (await getLink(env, slug))
    return json({ error: `Slug "${slug}" is already taken` }, 409);

  const now = Date.now();
  const expiresAt = ttlSeconds && Number(ttlSeconds) > 0
    ? now + Number(ttlSeconds) * 1000
    : null;

  const link = {
    slug, longUrl, createdAt: now, expiresAt,
    passwordHash: password ? await hashPassword(password) : null,
    clicks: 0, lastClickAt: null,
  };

  await putLink(env, slug, link);

  const origin = new URL(request.url).origin;
  return json({ slug, shortUrl: `${origin}/${slug}`, longUrl, expiresAt, passwordProtected: !!link.passwordHash }, 201);
}

async function handleList(request, env) {
  const denied = requireApiKey(request, env);
  if (denied) return denied;

  const links = await listLinks(env);
  const origin = new URL(request.url).origin;
  return json(links.map((l) => ({
    slug: l.slug,
    shortUrl: `${origin}/${l.slug}`,
    longUrl: l.longUrl,
    clicks: l.clicks,
    createdAt: l.createdAt,
    expiresAt: l.expiresAt,
    lastClickAt: l.lastClickAt,
    passwordProtected: !!l.passwordHash,
  })));
}

async function handleStats(request, env, slug) {
  const denied = requireApiKey(request, env);
  if (denied) return denied;

  const link = await getLink(env, slug);
  if (!link) return json({ error: 'Not found' }, 404);

  const origin = new URL(request.url).origin;
  return json({
    slug: link.slug, shortUrl: `${origin}/${link.slug}`,
    longUrl: link.longUrl, clicks: link.clicks,
    createdAt: link.createdAt, expiresAt: link.expiresAt,
    lastClickAt: link.lastClickAt, passwordProtected: !!link.passwordHash,
  });
}

async function handleDelete(request, env, slug) {
  const denied = requireApiKey(request, env);
  if (denied) return denied;

  const link = await getLink(env, slug);
  if (!link) return json({ error: 'Not found' }, 404);
  await removeLink(env, slug);
  return json({ deleted: slug });
}

async function handleRedirect(request, env, ctx, slug) {
  const link = await getLink(env, slug);
  if (!link) return new Response('Link not found', { status: 404 });

  if (link.expiresAt && Date.now() > link.expiresAt) {
    await removeLink(env, slug);
    return new Response('This link has expired', { status: 410 });
  }

  if (link.passwordHash) {
    const assetReq = new Request(new URL('/password.html', request.url));
    const assetRes = await getAssetFromKV(
      { request: assetReq, waitUntil: ctx.waitUntil.bind(ctx) },
      { ASSET_NAMESPACE: env.__STATIC_CONTENT, ASSET_MANIFEST: assetManifest }
    );
    let html = await assetRes.text();
    html = html.replace(/__SLUG__/g, slug).replace(/__ERROR__/g, 'false');
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  link.clicks += 1;
  link.lastClickAt = Date.now();
  await putLink(env, slug, link);
  return Response.redirect(link.longUrl, 302);
}

async function handlePasswordSubmit(request, env, ctx, slug) {
  const link = await getLink(env, slug);
  if (!link) return new Response('Not found', { status: 404 });

  const form = await request.formData();
  const hash = await hashPassword(form.get('password') || '');

  const assetReq = new Request(new URL('/password.html', request.url));
  const assetRes = await getAssetFromKV(
    { request: assetReq, waitUntil: ctx.waitUntil.bind(ctx) },
    { ASSET_NAMESPACE: env.__STATIC_CONTENT, ASSET_MANIFEST: assetManifest }
  );
  let html = await assetRes.text();

  if (hash !== link.passwordHash) {
    html = html.replace(/__SLUG__/g, slug).replace(/__ERROR__/g, 'true');
    return new Response(html, { status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  link.clicks += 1;
  link.lastClickAt = Date.now();
  await putLink(env, slug, link);
  return Response.redirect(link.longUrl, 302);
}

async function serveStatic(request, env, ctx) {
  return getAssetFromKV(
    { request, waitUntil: ctx.waitUntil.bind(ctx) },
    { ASSET_NAMESPACE: env.__STATIC_CONTENT, ASSET_MANIFEST: assetManifest }
  );
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path   = url.pathname;
    const method = request.method.toUpperCase();

    if (method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
        },
      });
    }

    const staticPaths = ['/', '/index.html', '/style.css', '/app.js'];
    if (method === 'GET' && staticPaths.includes(path)) {
      try { return await serveStatic(request, env, ctx); }
      catch { return new Response('Asset not found', { status: 404 }); }
    }

    if (path === '/api/links') {
      if (method === 'POST') return handleCreate(request, env);
      if (method === 'GET')  return handleList(request, env);
    }

    const statsMatch = path.match(/^\/api\/links\/([^/]+)\/stats$/);
    if (statsMatch && method === 'GET')
      return handleStats(request, env, statsMatch[1]);

    const apiLinkMatch = path.match(/^\/api\/links\/([^/]+)$/);
    if (apiLinkMatch && method === 'DELETE')
      return handleDelete(request, env, apiLinkMatch[1]);

    const slugMatch = path.match(/^\/([a-zA-Z0-9_-]{2,32})$/);
    if (slugMatch) {
      if (method === 'GET')  return handleRedirect(request, env, ctx, slugMatch[1]);
      if (method === 'POST') return handlePasswordSubmit(request, env, ctx, slugMatch[1]);
    }

    return new Response('Not found', { status: 404 });
  },
};
