import { adapt } from './_adapter.js';
import { resp, cors, DEVELOPER_EMAIL } from './_auth.js';

const CAN_MANAGE = ['DEVELOPER', 'SUPERVISOR'];

async function handler(event, { supabase, verifySession, audit, notify }) {
  if (event.httpMethod === 'OPTIONS') return cors();
  const user = await verifySession(event);
  if (!user) return resp(401, { error: 'Unauthorized' });

  const q    = event.queryStringParameters || {};
  const body = event.body ? JSON.parse(event.body) : {};

  // ── List Penalties ────────────────────────────────────────────────────────
  if (event.httpMethod === 'GET') {
    let query = supabase
      .from('penalties')
      .select('*, employee:users!user_id(id,name,avatar_url,role), added_by_user:users!added_by(id,name)')
      .order('created_at', { ascending: false });

    if (!CAN_MANAGE.includes(user.role) && user.role !== 'TEAM_LEADER') {
      query = query.eq('user_id', user.id);
    }

    if (q.user_id) query = query.eq('user_id', q.user_id);
    if (q.type)    query = query.eq('type', q.type);
    if (q.from)    query = query.gte('created_at', q.from);
    if (q.to)      query = query.lte('created_at', q.to);

    const { data, error } = await query;
    if (error) return resp(500, { error: error.message });
    return resp(200, data || []);
  }

  // ── Create Penalty ────────────────────────────────────────────────────────
  if (event.httpMethod === 'POST') {
    if (!CAN_MANAGE.includes(user.role)) return resp(403, { error: 'ليس لديك صلاحية إضافة خصم' });

    const { user_id, type, reason, amount, notes } = body;
    if (!user_id || !type || !reason || amount === undefined) {
      return resp(400, { error: 'المستخدم والنوع والسبب والمبلغ مطلوبة' });
    }

    const { data: target } = await supabase.from('users').select('email').eq('id', user_id).single();
    if (target?.email === DEVELOPER_EMAIL) {
      return resp(403, { error: 'لا يمكن إضافة خصم لحساب المطور' });
    }

    const { data: penalty, error } = await supabase.from('penalties').insert({
      user_id,
      type,
      reason,
      amount:   parseFloat(amount),
      notes:    notes || '',
      added_by: user.id,
      status:   'ACTIVE',
    }).select().single();

    if (error) return resp(400, { error: error.message });

    await audit('ADD_PENALTY', 'penalties', penalty.id, user.id, { user_id, type, amount });
    await notify(user_id, 'تم إضافة خصم', `تم إضافة خصم بمبلغ ${amount} - السبب: ${reason}`, 'PENALTY_ADDED', { penalty_id: penalty.id });

    return resp(201, penalty);
  }

  // ── Update Penalty ────────────────────────────────────────────────────────
  if (event.httpMethod === 'PUT') {
    if (!CAN_MANAGE.includes(user.role)) return resp(403, { error: 'Forbidden' });
    const { id } = q;

    const updates = {};
    if (body.type !== undefined)   updates.type   = body.type;
    if (body.reason !== undefined) updates.reason = body.reason;
    if (body.amount !== undefined) updates.amount = parseFloat(body.amount);
    if (body.notes !== undefined)  updates.notes  = body.notes;
    if (body.status !== undefined) updates.status = body.status;

    await supabase.from('penalties').update(updates).eq('id', id);
    await audit('UPDATE_PENALTY', 'penalties', id, user.id, updates);

    return resp(200, { ok: true });
  }

  // ── Delete Penalty ────────────────────────────────────────────────────────
  if (event.httpMethod === 'DELETE') {
    if (user.role !== 'DEVELOPER') return resp(403, { error: 'Forbidden' });
    const { id } = q;
    await supabase.from('penalties').delete().eq('id', id);
    await audit('DELETE_PENALTY', 'penalties', id, user.id, {});
    return resp(200, { ok: true });
  }

  return resp(404, { error: 'Not found' });
}

export const onRequest = adapt(handler);
