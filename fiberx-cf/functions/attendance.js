import { adapt } from './_adapter.js';
import { resp, cors } from './_auth.js';

const CAN_VIEW_ALL = ['DEVELOPER', 'SUPERVISOR'];

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

async function checkWorkLocation(supabase, lat, lng) {
  const { data: locations } = await supabase
    .from('work_locations')
    .select('id,name,lat,lng,radius')
    .eq('active', true);

  if (!locations?.length) return { ok: true, noLocations: true };

  let minDist = Infinity;
  let closestLoc = null;

  for (const loc of locations) {
    const dist = Math.round(haversine(parseFloat(loc.lat), parseFloat(loc.lng), parseFloat(lat), parseFloat(lng)));
    if (dist < minDist) { minDist = dist; closestLoc = loc; }
    if (dist <= (loc.radius || 100)) return { ok: true, distance: dist, locName: loc.name };
  }

  return { ok: false, distance: minDist, radius: closestLoc?.radius || 100, locName: closestLoc?.name };
}

async function handler(event, { supabase, verifySession, audit }) {
  if (event.httpMethod === 'OPTIONS') return cors();
  const user = await verifySession(event);
  if (!user) return resp(401, { error: 'Unauthorized' });

  const q    = event.queryStringParameters || {};
  const body = event.body ? JSON.parse(event.body) : {};

  // ── Work Locations List ───────────────────────────────────────────────────
  if (q.action === 'locations') {
    const { data } = await supabase.from('work_locations').select('id,name,lat,lng,radius').eq('active', true);
    return resp(200, data || []);
  }

  // ── Check In ──────────────────────────────────────────────────────────────
  if (event.httpMethod === 'POST' && !q.action) {
    const { lat, lng, accuracy, check_in_photo } = body;

    if (!lat || !lng) return resp(400, { error: 'الإحداثيات مطلوبة' });

    const locCheck = await checkWorkLocation(supabase, lat, lng);
    if (!locCheck.ok) {
      return resp(400, {
        error: `أنت خارج موقع العمل المحدد.\nالمسافة: ${locCheck.distance} متر — المسموح: ${locCheck.radius} متر.`,
        distance: locCheck.distance,
        radius: locCheck.radius,
      });
    }

    const serverNow = new Date();
    const today = serverNow.toISOString().slice(0, 10);

    const { data: existing } = await supabase
      .from('attendance')
      .select('id,check_out')
      .eq('user_id', user.id)
      .eq('date', today)
      .is('check_out', null)
      .single();

    if (existing) return resp(400, { error: 'لقد سجلت حضورك اليوم بالفعل' });

    const { data: record, error } = await supabase.from('attendance').insert({
      user_id:          user.id,
      date:             today,
      check_in:         serverNow.toISOString(),
      lat:              parseFloat(lat),
      lng:              parseFloat(lng),
      accuracy:         accuracy || null,
      check_in_photo:   check_in_photo || null,
    }).select().single();

    if (error) return resp(400, { error: error.message });
    await audit('CHECK_IN', 'attendance', record.id, user.id, { lat, lng, has_photo: !!check_in_photo });

    return resp(201, { ok: true, record });
  }

  // ── Check Out ─────────────────────────────────────────────────────────────
  if (event.httpMethod === 'PUT' && !q.action) {
    const { lat, lng, accuracy, check_out_photo } = body;

    if (!lat || !lng) return resp(400, { error: 'الإحداثيات مطلوبة للانصراف' });

    const locCheck = await checkWorkLocation(supabase, lat, lng);
    if (!locCheck.ok) {
      return resp(400, {
        error: `أنت خارج موقع العمل المحدد.\nلا يمكن تسجيل الانصراف. المسافة: ${locCheck.distance} متر — المسموح: ${locCheck.radius} متر.`,
        distance: locCheck.distance,
        radius: locCheck.radius,
      });
    }

    const today = new Date().toISOString().slice(0, 10);

    const { data: record } = await supabase
      .from('attendance')
      .select('id,check_in')
      .eq('user_id', user.id)
      .eq('date', today)
      .is('check_out', null)
      .single();

    if (!record) return resp(404, { error: 'لا يوجد سجل حضور مفتوح اليوم' });

    const checkOut     = new Date().toISOString();
    const durationMins = Math.round((new Date(checkOut) - new Date(record.check_in)) / 60000);

    await supabase.from('attendance').update({
      check_out:        checkOut,
      duration_minutes: durationMins,
      check_out_photo:  check_out_photo || null,
      lat_out:          parseFloat(lat),
      lng_out:          parseFloat(lng),
    }).eq('id', record.id);

    await audit('CHECK_OUT', 'attendance', record.id, user.id, { duration_minutes: durationMins, has_photo: !!check_out_photo });

    return resp(200, { ok: true, duration_minutes: durationMins });
  }

  // ── List Attendance ───────────────────────────────────────────────────────
  if (event.httpMethod === 'GET' && !q.action) {
    let query = supabase
      .from('attendance')
      .select('*, user:users!user_id(id,name,avatar_url,role)')
      .order('created_at', { ascending: false });

    if (!CAN_VIEW_ALL.includes(user.role)) {
      if (user.role === 'TEAM_LEADER') {
        const { data: myTickets } = await supabase
          .from('tickets').select('assigned_to').eq('team_leader_id', user.id);
        const techIds = [...new Set((myTickets||[]).map(t => t.assigned_to).filter(Boolean))];
        techIds.push(user.id);
        query = query.in('user_id', techIds);
      } else {
        query = query.eq('user_id', user.id);
      }
    }

    if (q.mine === 'true') query = query.eq('user_id', user.id);
    if (q.user_id) query = query.eq('user_id', q.user_id);
    if (q.date)    query = query.eq('date', q.date);
    if (q.from)    query = query.gte('date', q.from);
    if (q.to)      query = query.lte('date', q.to);
    if (q.limit)   query = query.limit(parseInt(q.limit));

    const { data, error } = await query;
    if (error) return resp(500, { error: error.message });
    return resp(200, data || []);
  }

  // ── Today Status ──────────────────────────────────────────────────────────
  if (q.action === 'today' || (q.mine === 'true' && q.today === 'true')) {
    const today = new Date().toISOString().slice(0, 10);
    const { data } = await supabase
      .from('attendance')
      .select('*')
      .eq('user_id', user.id)
      .eq('date', today)
      .order('check_in', { ascending: false })
      .limit(1)
      .single();
    return resp(200, data || null);
  }

  return resp(404, { error: 'Not found' });
}

export const onRequest = adapt(handler);
