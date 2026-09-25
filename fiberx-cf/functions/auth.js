// Auth function — Cloudflare Pages version
// Uses native fetch() instead of Node.js https module.
// crypto is available as a global in Cloudflare Workers (Web Crypto API),
// but scrypt requires Node.js crypto. With nodejs_compat flag it's available.
import { createDB } from './_db.js';
import { createAuth, resp, cors, DEVELOPER_EMAIL } from './_auth.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function generateToken(n = 48) {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Password hashing using Web Crypto API (PBKDF2 — available natively in Workers)
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const saltHex = Array.from(salt).map(b => b.toString(16).padStart(2, '0')).join('');
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial, 256
  );
  const hashHex = Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
  return `pbkdf2:${saltHex}:${hashHex}`;
}

async function verifyPassword(password, stored) {
  try {
    if (stored.startsWith('pbkdf2:')) {
      // New PBKDF2 format
      const [, saltHex, hashHex] = stored.split(':');
      const salt = new Uint8Array(saltHex.match(/.{2}/g).map(b => parseInt(b, 16)));
      const enc = new TextEncoder();
      const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
      const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
        keyMaterial, 256
      );
      const candidateHex = Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
      // Constant-time compare
      if (candidateHex.length !== hashHex.length) return false;
      let diff = 0;
      for (let i = 0; i < candidateHex.length; i++) diff |= candidateHex.charCodeAt(i) ^ hashHex.charCodeAt(i);
      return diff === 0;
    }
    // Legacy scrypt format (salt:hash) — passwords hashed by old Netlify backend
    // Cannot be verified in Cloudflare (no scrypt in Web Crypto API).
    // Return false so the user gets a clear error; they'll need to re-register.
    return false;
  } catch { return false; }
}

async function httpPost(url, data) {
  const body = new URLSearchParams(data).toString();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  return res.json().catch(() => ({}));
}

async function httpGet(url) {
  const res = await fetch(url);
  return res.json().catch(() => ({}));
}

function redirect(to) {
  return { statusCode: 302, headers: { Location: to }, body: '' };
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function onRequest({ request, env }) {
  // Build supabase and auth helpers for this request
  const supabase = createDB(env);
  const { verifySession, audit, notify } = createAuth(supabase);

  const SITE_URL      = env.SITE_URL || '';
  // Callback URL uses /functions/auth (Cloudflare Pages Functions path)
  const REDIRECT_URI  = `${SITE_URL}/functions/auth?action=callback`;

  // Convert Web Request → event object
  const url = new URL(request.url);
  const q = {};
  url.searchParams.forEach((v, k) => { q[k] = v; });

  const headers = {};
  request.headers.forEach((v, k) => { headers[k] = v; });

  let rawBody = null;
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    rawBody = await request.text().catch(() => null);
  }
  const body = rawBody ? (() => { try { return JSON.parse(rawBody); } catch { return {}; } })() : {};

  const event = { httpMethod: request.method, path: url.pathname, queryStringParameters: q, headers, body: rawBody };

  function toRes(result) {
    return new Response(result.body, { status: result.statusCode, headers: result.headers || {} });
  }

  if (request.method === 'OPTIONS') return toRes(cors());

  // ── Developer Public Info ─────────────────────────────────────────────────
  if (q.action === 'dev-info' && request.method === 'GET') {
    const { data: dev } = await supabase.from('users')
      .select('name,avatar_url')
      .eq('email', DEVELOPER_EMAIL)
      .single();
    return toRes(resp(200, { name: dev?.name || 'FiberX Dev Team', avatar_url: dev?.avatar_url || null }));
  }

  // ── Register (username + password) ───────────────────────────────────────
  if (q.action === 'register' && request.method === 'POST') {
    const { name, username, password } = body;
    if (!name || !username || !password) return toRes(resp(400, { error: 'الحقول مطلوبة' }));
    if (username.length < 3) return toRes(resp(400, { error: 'اسم المستخدم يجب أن يكون 3 أحرف على الأقل' }));
    if (password.length < 6) return toRes(resp(400, { error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' }));

    const { data: existingUser } = await supabase.from('users').select('id').eq('username', username).single();
    if (existingUser) return toRes(resp(400, { error: 'اسم المستخدم مستخدم بالفعل' }));

    const { data: existingReq } = await supabase.from('access_requests')
      .select('*').eq('username', username).order('created_at', { ascending: false }).limit(1).single();
    if (existingReq) {
      if (existingReq.status === 'PENDING')  return toRes(resp(400, { error: 'طلبك قيد المراجعة' }));
      if (existingReq.status === 'REJECTED') return toRes(resp(400, { error: 'تم رفض طلبك من قبل' }));
    }

    const password_hash = await hashPassword(password);
    const fakeEmail = `${username}@fiberx.local`;

    await supabase.from('access_requests').insert({
      email: fakeEmail, name, username, password_hash, status: 'PENDING'
    });

    const { data: dev } = await supabase.from('users').select('id').eq('email', DEVELOPER_EMAIL).single();
    if (dev) await notify(dev.id, 'طلب وصول جديد', `${name} يطلب الانضمام للنظام`, 'ACCESS_REQUEST', { username });

    return toRes(resp(200, { ok: true, status: 'pending' }));
  }

  // ── Login (username + password) ───────────────────────────────────────────
  if (q.action === 'login' && request.method === 'POST') {
    const { username, password } = body;
    if (!username || !password) return toRes(resp(400, { error: 'الحقول مطلوبة' }));

    const { data: user } = await supabase.from('users')
      .select('*').eq('username', username).single();

    if (!user)              return toRes(resp(401, { error: 'اسم المستخدم أو كلمة المرور غير صحيحة' }));
    if (!user.active)       return toRes(resp(403, { error: 'الحساب غير مفعّل' }));
    if (!user.password_hash) return toRes(resp(401, { error: 'هذا الحساب يستخدم تسجيل دخول Google' }));

    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) return toRes(resp(401, { error: 'اسم المستخدم أو كلمة المرور غير صحيحة' }));

    const tk = await generateToken();
    await supabase.from('sessions').insert({
      user_id: user.id, token: tk,
      expires_at: new Date(Date.now() + 30*24*60*60*1000).toISOString()
    });
    await supabase.from('users').update({ last_login: new Date().toISOString() }).eq('id', user.id);
    await audit('LOGIN', 'users', user.id, user.id, { method: 'password' });
    return toRes(resp(200, { token: tk }));
  }

  // ── Get Google OAuth URL ──────────────────────────────────────────────────
  if (q.action === 'google-url') {
    const deviceId = q.device_id || body.device_id || '';
    if (deviceId) {
      const { data: allDevices } = await supabase.from('trusted_devices').select('device_id').limit(1);
      if (allDevices?.length) {
        const { data: match } = await supabase.from('trusted_devices').select('id').eq('device_id', deviceId).single();
        if (!match) return toRes(resp(403, { error: 'الجهاز غير مصرح له بتسجيل الدخول. تواصل مع المسؤول.' }));
      }
    }
    const state = btoa(JSON.stringify({ device_id: deviceId, ts: Date.now() }));
    const oauthUrl = new URL('https://accounts.google.com/o/oauth2/auth');
    oauthUrl.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
    oauthUrl.searchParams.set('redirect_uri', REDIRECT_URI);
    oauthUrl.searchParams.set('response_type', 'code');
    oauthUrl.searchParams.set('scope', 'openid email profile');
    oauthUrl.searchParams.set('access_type', 'online');
    oauthUrl.searchParams.set('prompt', 'select_account');
    oauthUrl.searchParams.set('state', state);
    return toRes(resp(200, { url: oauthUrl.toString() }));
  }

  // ── Google OAuth Callback ─────────────────────────────────────────────────
  if (q.action === 'callback') {
    if (q.error) return toRes(redirect(`${SITE_URL}/?auth=error&msg=${encodeURIComponent(q.error)}`));
    if (!q.code) return toRes(redirect(`${SITE_URL}/?auth=error&msg=no_code`));
    try {
      const tokens = await httpPost('https://oauth2.googleapis.com/token', {
        code: q.code, client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: REDIRECT_URI, grant_type: 'authorization_code',
      });
      if (tokens.error) throw new Error(tokens.error_description || tokens.error);

      const info = await httpGet(`https://www.googleapis.com/oauth2/v1/userinfo?access_token=${tokens.access_token}`);
      if (!info.email) throw new Error('no_email');

      const { email, name, picture, id: gid } = info;
      const isDev = email === DEVELOPER_EMAIL;

      if (!isDev) return toRes(redirect(`${SITE_URL}/?auth=error&msg=google_dev_only`));

      const { data: existing } = await supabase.from('users').select('*').eq('email', email).single();

      let deviceId = '';
      try { deviceId = JSON.parse(atob(q.state || '')).device_id || ''; } catch {}

      if (existing) {
        if (!existing.active) return toRes(redirect(`${SITE_URL}/?auth=inactive`));

        if (deviceId) {
          const { data: allDevices } = await supabase.from('trusted_devices').select('device_id').limit(1);
          if (allDevices?.length) {
            const { data: match } = await supabase.from('trusted_devices').select('id').eq('device_id', deviceId).single();
            if (!match) return toRes(redirect(`${SITE_URL}/?auth=error&msg=device_blocked`));
          }
          await supabase.from('trusted_devices').upsert({ device_id: deviceId, user_id: existing.id }, { onConflict: 'device_id' });
        }

        await supabase.from('users').update({ google_id: gid, avatar_url: picture }).eq('id', existing.id);
        const tk = await generateToken();
        await supabase.from('sessions').insert({ user_id: existing.id, token: tk, expires_at: new Date(Date.now() + 30*24*60*60*1000).toISOString() });
        await audit('LOGIN', 'users', existing.id, existing.id, { method: 'google' });
        return toRes(redirect(`${SITE_URL}/?auth=success&tk=${tk}`));
      }

      // Auto-create developer (first time)
      const { data: dev } = await supabase.from('users').insert({
        email, name: name||'Developer', role: 'DEVELOPER', active: true, google_id: gid, avatar_url: picture
      }).select().single();
      const tk = await generateToken();
      await supabase.from('sessions').insert({ user_id: dev.id, token: tk, expires_at: new Date(Date.now() + 30*24*60*60*1000).toISOString() });
      if (deviceId) {
        await supabase.from('trusted_devices').upsert({ device_id: deviceId, user_id: dev.id }, { onConflict: 'device_id' });
      }
      return toRes(redirect(`${SITE_URL}/?auth=success&tk=${tk}`));
    } catch(e) {
      console.error(e);
      return toRes(redirect(`${SITE_URL}/?auth=error&msg=${encodeURIComponent(e.message)}`));
    }
  }

  // ── GET Me ────────────────────────────────────────────────────────────────
  if (q.action === 'me') {
    const user = await verifySession(event);
    if (!user) return toRes(resp(401, { error: 'Unauthorized' }));
    const { count } = await supabase.from('notifications').select('*', { count: 'exact', head: true }).eq('user_id', user.id).eq('read', false);
    return toRes(resp(200, { ...user, unread: count || 0 }));
  }

  // ── Logout ────────────────────────────────────────────────────────────────
  if (q.action === 'logout' || request.method === 'DELETE') {
    const authHeader = (headers.authorization || '').replace('Bearer ', '').trim();
    if (authHeader) await supabase.from('sessions').delete().eq('token', authHeader);
    return toRes(resp(200, { ok: true }));
  }

  return toRes(resp(404, { error: 'Not found' }));
}
