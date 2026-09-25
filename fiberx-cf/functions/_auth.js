// Auth helpers — Cloudflare Pages Functions version
// Pure functions (resp, cors, CORS) are exported directly.
// createAuth(supabase) returns request-scoped helpers that use that supabase instance.

export const DEVELOPER_EMAIL = 'mordta715@gmail.com';

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Content-Type': 'application/json',
};

export function resp(status, body, extra = {}) {
  return { statusCode: status, headers: { ...CORS, ...extra }, body: JSON.stringify(body) };
}

export function cors() {
  return { statusCode: 200, headers: CORS, body: '' };
}

export function createAuth(supabase) {
  async function verifySession(event) {
    const auth = (event.headers.authorization || event.headers.Authorization || '').replace('Bearer ', '').trim();
    if (!auth) return null;
    const now = new Date().toISOString();
    const { data: session } = await supabase
      .from('sessions')
      .select('user_id')
      .eq('token', auth)
      .gt('expires_at', now)
      .single();
    if (!session?.user_id) return null;
    const { data: user } = await supabase
      .from('users')
      .select('*')
      .eq('id', session.user_id)
      .eq('active', true)
      .single();
    return user || null;
  }

  async function audit(action, entity, entityId, userId, details = {}) {
    await supabase.from('audit_logs').insert({ action, entity, entity_id: entityId, user_id: userId, details });
  }

  async function notify(userId, title, body, type, data = {}) {
    await supabase.from('notifications').insert({ user_id: userId, title, body, type, data });
  }

  async function notifyRole(roles, title, body, type, data = {}) {
    const { data: users } = await supabase.from('users').select('id').in('role', roles).eq('active', true);
    if (users && users.length) {
      await supabase.from('notifications').insert(users.map(u => ({ user_id: u.id, title, body, type, data })));
    }
  }

  return { verifySession, audit, notify, notifyRole };
}
