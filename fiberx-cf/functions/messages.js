import { adapt } from './_adapter.js';
import { resp, cors } from './_auth.js';

async function handler(event, { supabase, verifySession }) {
  if (event.httpMethod === 'OPTIONS') return cors();
  const user = await verifySession(event);
  if (!user) return resp(401, { error: 'Unauthorized' });
  if (user.role === 'DEVELOPER') return resp(403, { error: 'المطور غير مسموح له بالمحادثة' });

  const q    = event.queryStringParameters || {};
  const body = event.body ? JSON.parse(event.body) : {};

  // ── GET contacts list (last message + unread) ─────────────────────────────
  if (event.httpMethod === 'GET' && !q.with && !q.room) {
    const { data: users } = await supabase.from('users')
      .select('id,name,role,avatar_url')
      .eq('active', true)
      .neq('role', 'DEVELOPER')
      .neq('id', user.id)
      .order('name');

    if (!users?.length) return resp(200, []);

    const result = await Promise.all(users.map(async (u) => {
      const { data: last } = await supabase.from('messages')
        .select('body,image_url,created_at,from_user_id')
        .or(`and(from_user_id.eq.${user.id},to_user_id.eq.${u.id}),and(from_user_id.eq.${u.id},to_user_id.eq.${user.id})`)
        .is('room', null)
        .order('created_at', { ascending: false })
        .limit(1);

      const { count: unread } = await supabase.from('messages')
        .select('*', { count: 'exact', head: true })
        .eq('from_user_id', u.id)
        .eq('to_user_id', user.id)
        .is('room', null)
        .eq('read', false);

      const lastMsg = last?.[0];
      const preview = lastMsg?.image_url ? '[📷 صورة]' : (lastMsg?.body || null);

      return {
        ...u,
        last_message: preview,
        last_at:      lastMsg?.created_at || null,
        unread:       unread || 0,
      };
    }));

    result.sort((a, b) => {
      if (a.last_at && b.last_at) return b.last_at.localeCompare(a.last_at);
      if (a.last_at) return -1;
      if (b.last_at) return 1;
      return a.name.localeCompare(b.name);
    });

    return resp(200, result);
  }

  // ── GET general/group chat messages ───────────────────────────────────────
  if (event.httpMethod === 'GET' && q.room === 'general') {
    const { data: msgs } = await supabase.from('messages')
      .select('id,body,image_url,from_user_id,created_at,users:from_user_id(id,name,avatar_url,role)')
      .eq('room', 'general')
      .order('created_at', { ascending: true })
      .limit(200);

    await supabase.from('messages')
      .update({ read: true })
      .eq('room', 'general')
      .eq('read', false)
      .neq('from_user_id', user.id)
      .lte('created_at', new Date().toISOString());

    return resp(200, (msgs || []).map(m => ({
      id:            m.id,
      body:          m.body,
      image_url:     m.image_url || null,
      from_user_id:  m.from_user_id,
      created_at:    m.created_at,
      sender_name:   m.users?.name || 'مجهول',
      sender_avatar: m.users?.avatar_url || null,
      sender_role:   m.users?.role || null,
    })));
  }

  // ── GET DM thread with a specific user ────────────────────────────────────
  if (event.httpMethod === 'GET' && q.with) {
    const otherId = q.with;
    const { data: msgs } = await supabase.from('messages')
      .select('id,body,image_url,from_user_id,to_user_id,created_at,read')
      .or(`and(from_user_id.eq.${user.id},to_user_id.eq.${otherId}),and(from_user_id.eq.${otherId},to_user_id.eq.${user.id})`)
      .is('room', null)
      .order('created_at', { ascending: true })
      .limit(200);

    await supabase.from('messages')
      .update({ read: true })
      .eq('from_user_id', otherId)
      .eq('to_user_id', user.id)
      .is('room', null)
      .eq('read', false);

    return resp(200, msgs || []);
  }

  // ── POST send message ─────────────────────────────────────────────────────
  if (event.httpMethod === 'POST') {
    const { to_user_id, room, body: msgBody, image_url } = body;

    if (!msgBody?.trim() && !image_url) return resp(400, { error: 'الرسالة أو الصورة مطلوبة' });

    const msgData = {
      from_user_id: user.id,
      body:         msgBody?.trim() || null,
      image_url:    image_url || null,
      read:         false,
    };

    if (room === 'general') {
      const { data: msg } = await supabase.from('messages')
        .insert({ ...msgData, room: 'general' }).select().single();
      return resp(201, msg);
    }

    if (to_user_id) {
      const { data: target } = await supabase.from('users').select('role,active').eq('id', to_user_id).single();
      if (!target || !target.active) return resp(404, { error: 'المستخدم غير موجود' });
      if (target.role === 'DEVELOPER') return resp(403, { error: 'لا يمكن إرسال رسالة للمطور' });

      const { data: msg } = await supabase.from('messages')
        .insert({ ...msgData, to_user_id }).select().single();
      return resp(201, msg);
    }

    return resp(400, { error: 'يجب تحديد المستلم أو الغرفة' });
  }

  return resp(404, { error: 'Not found' });
}

export const onRequest = adapt(handler);
