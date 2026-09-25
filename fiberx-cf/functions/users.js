import { adapt } from './_adapter.js';
import { resp, cors, DEVELOPER_EMAIL } from './_auth.js';

const CAN_MANAGE = ['DEVELOPER', 'SUPERVISOR'];

async function handler(event, { supabase, verifySession, audit }) {
  if (event.httpMethod === 'OPTIONS') return cors();
  const user = await verifySession(event);
  if (!user) return resp(401, { error: 'Unauthorized' });

  const q    = event.queryStringParameters || {};
  const body = event.body ? JSON.parse(event.body) : {};

  // ── Access Requests (Developer only) ─────────────────────────────────────
  if (q.action === 'requests') {
    if (user.role !== 'DEVELOPER') return resp(403, { error: 'Forbidden' });

    if (event.httpMethod === 'GET') {
      const { data } = await supabase.from('access_requests').select('*').order('created_at', { ascending: false });
      return resp(200, data || []);
    }

    if (event.httpMethod === 'POST') {
      const { id, action, name, role } = body;
      if (!['APPROVED', 'REJECTED'].includes(action)) return resp(400, { error: 'Invalid action' });

      const { data: req } = await supabase.from('access_requests').select('*').eq('id', id).single();
      if (!req) return resp(404, { error: 'Not found' });

      await supabase.from('access_requests').update({
        status: action,
        reviewed_by: user.id,
        reviewed_at: new Date().toISOString(),
      }).eq('id', id);

      if (action === 'APPROVED') {
        // Prevent creating Developer role via access requests
        const safeRole = role === 'DEVELOPER' ? 'TECHNICIAN' : (role || 'TECHNICIAN');
        const userInsert = {
          email:      req.email,
          name:       name || req.name,
          role:       safeRole,
          active:     true,
          google_id:  req.google_id  || null,
          avatar_url: req.avatar_url || null,
        };
        // If registered with username/password, carry those over
        if (req.username)      userInsert.username      = req.username;
        if (req.password_hash) userInsert.password_hash = req.password_hash;

        await supabase.from('users').insert(userInsert).select().single();
        await audit('APPROVE_ACCESS', 'access_requests', id, user.id, { email: req.email, role: safeRole });
      } else {
        await audit('REJECT_ACCESS', 'access_requests', id, user.id, { email: req.email });
      }

      return resp(200, { ok: true });
    }
  }

  // ── List Users ────────────────────────────────────────────────────────────
  if (event.httpMethod === 'GET' && !q.action) {
    if (!CAN_MANAGE.includes(user.role) && user.role !== 'TEAM_LEADER') {
      return resp(403, { error: 'Forbidden' });
    }

    let query = supabase
      .from('users')
      .select('id,email,name,role,active,avatar_url,username,created_at')
      .order('created_at', { ascending: false });

    if (user.role === 'TEAM_LEADER') {
      query = query.in('role', ['TECHNICIAN', 'COLLECTION_AGENT']);
    } else if (q.role) {
      const roles = q.role.split(',').map(r => r.trim()).filter(r => r !== 'DEVELOPER');
      if (roles.length) query = query.in('role', roles);
      else query = query.neq('role', 'DEVELOPER');
    } else {
      if (user.role !== 'DEVELOPER') query = query.neq('role', 'DEVELOPER');
    }

    if (q.active === 'true')  query = query.eq('active', true);
    if (q.active === 'false') query = query.eq('active', false);

    const { data } = await query;
    return resp(200, data || []);
  }

  // ── Create User (Developer only) ──────────────────────────────────────────
  if (event.httpMethod === 'POST' && !q.action) {
    if (user.role !== 'DEVELOPER') return resp(403, { error: 'Forbidden' });
    const { email, name, role } = body;
    if (!email || !name || !role) return resp(400, { error: 'Missing fields' });
    if (role === 'DEVELOPER') return resp(403, { error: 'لا يمكن إنشاء Developer آخر' });

    const { data: newUser, error } = await supabase
      .from('users')
      .insert({ email, name, role, active: true })
      .select()
      .single();

    if (error) return resp(400, { error: error.message });
    await audit('CREATE_USER', 'users', newUser.id, user.id, { email, role });
    return resp(201, newUser);
  }

  // ── Update User ───────────────────────────────────────────────────────────
  if (event.httpMethod === 'PUT') {
    if (user.role !== 'DEVELOPER') return resp(403, { error: 'Forbidden' });
    const { id } = q;
    const { data: target } = await supabase.from('users').select('*').eq('id', id).single();
    if (!target) return resp(404, { error: 'Not found' });
    if (target.email === DEVELOPER_EMAIL) return resp(403, { error: 'لا يمكن تعديل حساب المطور الرئيسي' });

    const updates = {};
    if (body.name)              updates.name   = body.name;
    if (body.role && body.role !== 'DEVELOPER') updates.role = body.role;
    if (body.active !== undefined) updates.active = body.active;

    await supabase.from('users').update(updates).eq('id', id);
    await audit('UPDATE_USER', 'users', id, user.id, updates);
    return resp(200, { ok: true });
  }

  // ── Delete User (hard delete) ─────────────────────────────────────────────
  if (event.httpMethod === 'DELETE') {
    if (user.role !== 'DEVELOPER') return resp(403, { error: 'Forbidden' });
    const { id } = q;
    const { data: target } = await supabase.from('users').select('email,name').eq('id', id).single();
    if (!target) return resp(404, { error: 'Not found' });
    if (target.email === DEVELOPER_EMAIL) return resp(403, { error: 'لا يمكن حذف حساب المطور الرئيسي' });

    // Clear FK references before hard delete
    await supabase.from('tickets').update({ assigned_to:    null }).eq('assigned_to',    id);
    await supabase.from('tickets').update({ team_leader_id: null }).eq('team_leader_id', id);
    await supabase.from('sessions').delete().eq('user_id', id);
    await supabase.from('notifications').delete().eq('user_id', id);
    await supabase.from('trusted_devices').delete().eq('user_id', id);
    await supabase.from('messages').update({ from_user_id: null }).eq('from_user_id', id);
    await supabase.from('messages').update({ to_user_id:   null }).eq('to_user_id',   id);
    await supabase.from('attendance').delete().eq('user_id', id);
    await supabase.from('penalties').delete().eq('user_id', id);
    await supabase.from('penalties').update({ added_by: null }).eq('added_by', id);
    await supabase.from('audit_logs').update({ user_id: null }).eq('user_id', id);

    await supabase.from('users').delete().eq('id', id);
    await audit('DELETE_USER', 'users', id, user.id, { name: target.name, email: target.email });
    return resp(200, { ok: true });
  }

  return resp(404, { error: 'Not found' });
}

export const onRequest = adapt(handler);
