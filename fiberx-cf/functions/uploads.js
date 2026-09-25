import { adapt } from './_adapter.js';
import { resp, cors } from './_auth.js';

async function handler(event, { supabase, verifySession }) {
  if (event.httpMethod === 'OPTIONS') return cors();
  const user = await verifySession(event);
  if (!user) return resp(401, { error: 'Unauthorized' });

  const q    = event.queryStringParameters || {};
  const body = event.body ? JSON.parse(event.body) : {};

  async function signedUpload(bucket, path, contentType) {
    const { data, error } = await supabase.storage.from(bucket).createSignedUploadUrl(path);
    if (error) return { error };
    const { data: pub } = supabase.storage.from(bucket).getPublicUrl(path);
    return { upload_url: data.signedUrl, token: data.token, path, public_url: pub.publicUrl };
  }

  // ── Get Upload URL ────────────────────────────────────────────────────────
  if (event.httpMethod === 'POST') {
    const { filename, content_type, ticket_id, action } = body;
    if (!filename) return resp(400, { error: 'filename مطلوب' });

    const ext = (filename.split('.').pop() || 'jpg').toLowerCase();
    const ts  = Date.now();

    if (action === 'attendance') {
      const path = `attendance/${user.id}/${ts}.${ext}`;
      const result = await signedUpload('ticket-images', path, content_type);
      if (result.error) return resp(500, { error: 'فشل إنشاء رابط الرفع: ' + result.error.message });
      return resp(200, result);
    }

    if (action === 'chat') {
      if (user.role === 'DEVELOPER') return resp(403, { error: 'المطور لا يستخدم المحادثة' });
      const path = `chat/${user.id}/${ts}.${ext}`;
      const result = await signedUpload('ticket-images', path, content_type);
      if (result.error) return resp(500, { error: 'فشل إنشاء رابط الرفع: ' + result.error.message });
      return resp(200, result);
    }

    if (!ticket_id) return resp(400, { error: 'ticket_id مطلوب لرفع صور التذاكر' });

    const { data: ticket } = await supabase
      .from('tickets')
      .select('assigned_to,team_leader_id')
      .eq('id', ticket_id)
      .single();

    if (!ticket) return resp(404, { error: 'التذكرة غير موجودة' });

    const canUpload = ['DEVELOPER','SUPERVISOR'].includes(user.role)
      || ticket.assigned_to === user.id
      || ticket.team_leader_id === user.id;

    if (!canUpload) return resp(403, { error: 'ليس لديك صلاحية رفع صور لهذه التذكرة' });

    const path = `tickets/${ticket_id}/${ts}_${user.id}.${ext}`;
    const result = await signedUpload('ticket-images', path, content_type);
    if (result.error) return resp(500, { error: 'فشل إنشاء رابط الرفع: ' + result.error.message });
    return resp(200, result);
  }

  // ── Get Signed View URL ───────────────────────────────────────────────────
  if (event.httpMethod === 'GET' && q.path) {
    const { data, error } = await supabase.storage
      .from('ticket-images')
      .createSignedUrl(q.path, 3600);

    if (error) return resp(404, { error: 'الملف غير موجود' });
    return resp(200, { url: data.signedUrl });
  }

  return resp(404, { error: 'Not found' });
}

export const onRequest = adapt(handler);
