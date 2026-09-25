import { adapt } from './_adapter.js';
import { resp, cors } from './_auth.js';

const CAN_MANAGE = ['DEVELOPER', 'SUPERVISOR'];

async function handler(event, { supabase, verifySession, audit }) {
  if (event.httpMethod === 'OPTIONS') return cors();
  const user = await verifySession(event);
  if (!user) return resp(401, { error: 'Unauthorized' });

  const q    = event.queryStringParameters || {};
  const body = event.body ? JSON.parse(event.body) : {};

  // ── List Locations ────────────────────────────────────────────────────────
  if (event.httpMethod === 'GET') {
    const { data, error } = await supabase
      .from('work_locations')
      .select('*')
      .order('name', { ascending: true });
    if (error) return resp(500, { error: error.message });
    return resp(200, data || []);
  }

  // ── Create Location ───────────────────────────────────────────────────────
  if (event.httpMethod === 'POST') {
    if (!CAN_MANAGE.includes(user.role)) return resp(403, { error: 'Forbidden' });

    const { name, lat, lng, radius, description } = body;
    if (!name || !lat || !lng) return resp(400, { error: 'الاسم والإحداثيات مطلوبة' });

    const { data, error } = await supabase.from('work_locations').insert({
      name,
      lat:         parseFloat(lat),
      lng:         parseFloat(lng),
      radius:      parseInt(radius) || 100,
      description: description || '',
      active:      true,
      created_by:  user.id,
    }).select().single();

    if (error) return resp(400, { error: error.message });
    await audit('CREATE_LOCATION', 'work_locations', data.id, user.id, { name });
    return resp(201, data);
  }

  // ── Update Location ───────────────────────────────────────────────────────
  if (event.httpMethod === 'PUT') {
    if (!CAN_MANAGE.includes(user.role)) return resp(403, { error: 'Forbidden' });
    const { id } = q;

    const updates = {};
    if (body.name !== undefined)        updates.name        = body.name;
    if (body.lat !== undefined)         updates.lat         = parseFloat(body.lat);
    if (body.lng !== undefined)         updates.lng         = parseFloat(body.lng);
    if (body.radius !== undefined)      updates.radius      = parseInt(body.radius);
    if (body.description !== undefined) updates.description = body.description;
    if (body.active !== undefined)      updates.active      = body.active;

    await supabase.from('work_locations').update(updates).eq('id', id);
    await audit('UPDATE_LOCATION', 'work_locations', id, user.id, updates);
    return resp(200, { ok: true });
  }

  // ── Delete Location ───────────────────────────────────────────────────────
  if (event.httpMethod === 'DELETE') {
    if (user.role !== 'DEVELOPER') return resp(403, { error: 'Forbidden' });
    const { id } = q;
    await supabase.from('work_locations').delete().eq('id', id);
    await audit('DELETE_LOCATION', 'work_locations', id, user.id, {});
    return resp(200, { ok: true });
  }

  return resp(404, { error: 'Not found' });
}

export const onRequest = adapt(handler);
