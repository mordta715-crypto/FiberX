import { adapt } from './_adapter.js';
import { resp, cors } from './_auth.js';

const CAN_APPROVE = ['DEVELOPER', 'SUPERVISOR'];
const CAN_REQUEST = ['TECHNICIAN', 'COLLECTION_AGENT', 'TEAM_LEADER'];

async function handler(event, { supabase, verifySession, audit, notify, notifyRole }) {
  if (event.httpMethod === 'OPTIONS') return cors();
  const user = await verifySession(event);
  if (!user) return resp(401, { error: 'Unauthorized' });

  const q    = event.queryStringParameters || {};
  const body = event.body ? JSON.parse(event.body) : {};

  // ── Debug ─────────────────────────────────────────────────────────────────
  if (event.httpMethod === 'GET' && q.debug === 'me') {
    return resp(200, { id: user.id, role: user.role, name: user.name, canRequest: CAN_REQUEST.includes(user.role) });
  }

  // ── List Advances ─────────────────────────────────────────────────────────
  if (event.httpMethod === 'GET') {
    let query = supabase
      .from('advances')
      .select('*, requester:users!user_id(id,name,avatar_url,role), approver:users!reviewed_by(id,name)')
      .order('created_at', { ascending: false });

    if (!CAN_APPROVE.includes(user.role)) {
      query = query.eq('user_id', user.id);
    }

    if (q.user_id) query = query.eq('user_id', q.user_id);
    if (q.status)  query = query.eq('status', q.status);
    if (q.from)    query = query.gte('created_at', q.from);
    if (q.to)      query = query.lte('created_at', q.to);

    const { data, error } = await query;
    if (error) return resp(500, { error: error.message });
    return resp(200, data || []);
  }

  // ── Create Advance Request ─────────────────────────────────────────────────
  if (event.httpMethod === 'POST' && !q.action) {
    if (!CAN_REQUEST.includes(user.role)) return resp(403, { error: 'ليس لديك صلاحية طلب سلفة' });

    const { amount, reason, notes } = body;
    if (!amount || !reason) return resp(400, { error: 'المبلغ والسبب مطلوبان' });
    if (parseFloat(amount) <= 0) return resp(400, { error: 'المبلغ يجب أن يكون أكبر من صفر' });

    const { data: pending } = await supabase
      .from('advances')
      .select('id')
      .eq('user_id', user.id)
      .eq('status', 'PENDING')
      .single();

    if (pending) return resp(400, { error: 'لديك طلب سلفة قيد الانتظار بالفعل' });

    const { data: advance, error } = await supabase.from('advances').insert({
      user_id:    user.id,
      amount:     parseFloat(amount),
      reason,
      notes:      notes || '',
      status:     'PENDING',
    }).select().single();

    if (error) return resp(400, { error: error.message });

    await audit('REQUEST_ADVANCE', 'advances', advance.id, user.id, { amount, reason });
    await notifyRole(['SUPERVISOR'], 'طلب سلفة جديد', `${user.name} يطلب سلفة بمبلغ ${amount}`, 'ADVANCE_REQUEST', { advance_id: advance.id });

    return resp(201, advance);
  }

  // ── Approve / Reject ──────────────────────────────────────────────────────
  if (event.httpMethod === 'POST' && (q.action === 'review' || body.action === 'review')) {
    if (!CAN_APPROVE.includes(user.role)) return resp(403, { error: 'ليس لديك صلاحية مراجعة طلبات السلف' });

    const id     = body.id;
    const action = body.action !== 'review' ? body.action : body.status;
    const note   = body.note || body.review_note || '';
    if (!id || !['APPROVED','REJECTED'].includes(action)) return resp(400, { error: 'id والإجراء مطلوبان' });

    const { data: advance } = await supabase.from('advances').select('*').eq('id', id).single();
    if (!advance) return resp(404, { error: 'طلب السلفة غير موجود' });
    if (advance.status !== 'PENDING') return resp(400, { error: 'تم مراجعة هذا الطلب مسبقاً' });

    await supabase.from('advances').update({
      status:      action,
      reviewed_by: user.id,
      reviewed_at: new Date().toISOString(),
      review_note: note || '',
    }).eq('id', id);

    await audit(action === 'APPROVED' ? 'APPROVE_ADVANCE' : 'REJECT_ADVANCE', 'advances', id, user.id, { action });

    const msg = action === 'APPROVED'
      ? `تم قبول طلب السلفة بمبلغ ${advance.amount}`
      : `تم رفض طلب السلفة. ${note || ''}`;

    await notify(advance.user_id, action === 'APPROVED' ? 'تم قبول السلفة' : 'تم رفض السلفة', msg,
      action === 'APPROVED' ? 'ADVANCE_APPROVED' : 'ADVANCE_REJECTED', { advance_id: id });

    return resp(200, { ok: true });
  }

  // ── Delete (Developer only) ───────────────────────────────────────────────
  if (event.httpMethod === 'DELETE') {
    if (user.role !== 'DEVELOPER') return resp(403, { error: 'Forbidden' });
    const { id } = q;
    await supabase.from('advances').delete().eq('id', id);
    return resp(200, { ok: true });
  }

  return resp(404, { error: 'Not found' });
}

export const onRequest = adapt(handler);
