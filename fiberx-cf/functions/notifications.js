import { adapt } from './_adapter.js';
import { resp, cors } from './_auth.js';

async function handler(event, { supabase, verifySession }) {
  if (event.httpMethod === 'OPTIONS') return cors();
  const user = await verifySession(event);
  if (!user) return resp(401, { error: 'Unauthorized' });

  const q    = event.queryStringParameters || {};
  const body = event.body ? JSON.parse(event.body) : {};

  // ── List Notifications ────────────────────────────────────────────────────
  if (event.httpMethod === 'GET' && !q.action) {
    const limit = parseInt(q.limit) || 30;
    let query = supabase
      .from('notifications')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (q.unread === 'true') query = query.eq('read', false);

    const { data, error } = await query;
    if (error) return resp(500, { error: error.message });

    const { count } = await supabase
      .from('notifications')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('read', false);

    return resp(200, { notifications: data || [], unread: count || 0 });
  }

  // ── Mark as Read ──────────────────────────────────────────────────────────
  if (event.httpMethod === 'PUT' && !q.action) {
    const { id, all } = body;

    if (all) {
      await supabase.from('notifications').update({ read: true }).eq('user_id', user.id).eq('read', false);
    } else if (id) {
      await supabase.from('notifications').update({ read: true }).eq('id', id).eq('user_id', user.id);
    } else {
      return resp(400, { error: 'id أو all مطلوب' });
    }

    return resp(200, { ok: true });
  }

  // ── Delete Notification ───────────────────────────────────────────────────
  if (event.httpMethod === 'DELETE') {
    const { id } = q;
    if (!id) return resp(400, { error: 'id مطلوب' });
    await supabase.from('notifications').delete().eq('id', id).eq('user_id', user.id);
    return resp(200, { ok: true });
  }

  return resp(404, { error: 'Not found' });
}

export const onRequest = adapt(handler);
