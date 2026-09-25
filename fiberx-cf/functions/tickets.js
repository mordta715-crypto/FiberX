import { adapt } from './_adapter.js';
import { resp, cors, DEVELOPER_EMAIL } from './_auth.js';

const CAN_MANAGE = ['DEVELOPER', 'SUPERVISOR'];
const CAN_CLOSE  = ['DEVELOPER', 'SUPERVISOR', 'TEAM_LEADER'];
const VALID_STATUSES = ['OPEN','ASSIGNED','IN_PROGRESS','COMPLETED','EXPIRED'];

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

async function nextTicketNumber(supabase) {
  const { data } = await supabase
    .from('tickets')
    .select('ticket_number')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  const last = data?.ticket_number ? parseInt(data.ticket_number, 10) : 0;
  return String(last + 1).padStart(5, '0');
}

async function handler(event, { supabase, verifySession, audit, notify, notifyRole }) {
  if (event.httpMethod === 'OPTIONS') return cors();
  const user = await verifySession(event);
  if (!user) return resp(401, { error: 'Unauthorized' });

  const q    = event.queryStringParameters || {};
  const body = event.body ? JSON.parse(event.body) : {};

  // ── List Tickets ──────────────────────────────────────────────────────────
  if (event.httpMethod === 'GET' && !q.id && !q.action) {
    let query = supabase
      .from('tickets')
      .select(`
        id, ticket_number, type, title, description, status, priority,
        customer_name, customer_phone, address, lat, lng,
        assigned_to, created_by, team_leader_id,
        started_at, completed_at, duration_minutes,
        created_at, updated_at,
        assignee:users!assigned_to(id,name,avatar_url),
        creator:users!created_by(id,name,avatar_url),
        leader:users!team_leader_id(id,name,avatar_url)
      `)
      .order('created_at', { ascending: false });

    if (user.role === 'TECHNICIAN') {
      query = query.eq('assigned_to', user.id).neq('type', 'COLLECTION');
    } else if (user.role === 'COLLECTION_AGENT') {
      query = query.eq('assigned_to', user.id).eq('type', 'COLLECTION');
    } else if (user.role === 'TEAM_LEADER') {
      query = query.or(`team_leader_id.eq.${user.id},created_by.eq.${user.id}`);
    }

    if (q.status)      query = query.eq('status', q.status);
    if (q.type)        query = query.eq('type', q.type);
    if (q.priority)    query = query.eq('priority', q.priority);
    if (q.assigned_to) query = query.eq('assigned_to', q.assigned_to);
    if (q.search) {
      query = query.or(`ticket_number.ilike.%${q.search}%,customer_name.ilike.%${q.search}%,customer_phone.ilike.%${q.search}%,title.ilike.%${q.search}%`);
    }
    if (q.limit)  query = query.limit(parseInt(q.limit));
    if (q.offset) query = query.range(parseInt(q.offset), parseInt(q.offset) + (parseInt(q.limit)||50) - 1);

    const { data, error } = await query;
    if (error) return resp(500, { error: error.message });
    return resp(200, data || []);
  }

  // ── Get Single Ticket ─────────────────────────────────────────────────────
  if (event.httpMethod === 'GET' && q.id && !q.action) {
    const { data: ticket, error } = await supabase
      .from('tickets')
      .select(`
        *,
        assignee:users!assigned_to(id,name,avatar_url,role),
        creator:users!created_by(id,name,avatar_url,role),
        leader:users!team_leader_id(id,name,avatar_url),
        images:ticket_images(id,url,label,uploaded_at,uploaded_by,uploader:users!uploaded_by(name)),
        comments:ticket_comments(id,text,created_at,author:users!user_id(id,name,avatar_url))
      `)
      .eq('id', q.id)
      .single();

    if (error || !ticket) return resp(404, { error: 'التذكرة غير موجودة' });

    if (user.role === 'TECHNICIAN'       && ticket.assigned_to !== user.id) return resp(403, { error: 'Forbidden' });
    if (user.role === 'COLLECTION_AGENT' && ticket.assigned_to !== user.id) return resp(403, { error: 'Forbidden' });
    if (user.role === 'TEAM_LEADER') {
      if (ticket.team_leader_id !== user.id && ticket.created_by !== user.id) return resp(403, { error: 'Forbidden' });
    }

    return resp(200, ticket);
  }

  // ── Create Ticket ─────────────────────────────────────────────────────────
  if (event.httpMethod === 'POST' && !q.action) {
    if (!CAN_MANAGE.includes(user.role) && user.role !== 'TEAM_LEADER') {
      return resp(403, { error: 'ليس لديك صلاحية إنشاء تذكرة' });
    }

    const { type, title, description, priority, request_type,
            customer_name, customer_phone, address, lat, lng,
            assigned_to, team_leader_id, location_id } = body;

    if (!title || !type) return resp(400, { error: 'العنوان والنوع مطلوبان' });

    if (type === 'COLLECTION' && user.role === 'TEAM_LEADER') {
      return resp(403, { error: 'التيم ليدر لا يستطيع إنشاء تذاكر جباية' });
    }

    let leaderId = team_leader_id || null;
    if (user.role === 'TEAM_LEADER' && !leaderId) leaderId = user.id;

    const ticket_number = await nextTicketNumber(supabase);
    const status = assigned_to ? 'ASSIGNED' : 'OPEN';

    const { data: ticket, error } = await supabase.from('tickets').insert({
      ticket_number,
      type,
      title,
      description:    description || '',
      priority:       priority || 'MEDIUM',
      request_type:   request_type || '',
      status,
      customer_name:  customer_name || '',
      customer_phone: customer_phone || '',
      address:        address || '',
      lat:            lat || null,
      lng:            lng || null,
      radius:         50,
      assigned_to:    assigned_to || null,
      team_leader_id: leaderId,
      location_id:    location_id || null,
      created_by:     user.id,
    }).select().single();

    if (error) return resp(400, { error: error.message });

    await audit('CREATE_TICKET', 'tickets', ticket.id, user.id, { ticket_number, type, status });

    if (assigned_to) {
      await notify(assigned_to, 'تذكرة جديدة مسندة إليك', `تذكرة #${ticket_number}: ${title}`, 'TICKET_ASSIGNED', { ticket_id: ticket.id });
    }

    return resp(201, ticket);
  }

  // ── Update Ticket Fields ───────────────────────────────────────────────────
  if (event.httpMethod === 'PUT' && !q.action) {
    const { id } = q;
    if (!id) return resp(400, { error: 'id مطلوب' });

    const { data: ticket } = await supabase.from('tickets').select('*').eq('id', id).single();
    if (!ticket) return resp(404, { error: 'التذكرة غير موجودة' });

    const isAssigned = ticket.assigned_to === user.id;
    const isLeader   = ticket.team_leader_id === user.id;
    const isManager  = CAN_MANAGE.includes(user.role);

    if (!isAssigned && !isLeader && !isManager) return resp(403, { error: 'ليس لديك صلاحية تعديل هذه التذكرة' });

    const updates = { updated_at: new Date().toISOString() };
    if (body.title !== undefined)          updates.title          = body.title;
    if (body.description !== undefined)    updates.description    = body.description;
    if (body.priority !== undefined)       updates.priority       = body.priority;
    if (body.request_type !== undefined)   updates.request_type   = body.request_type;
    if (body.customer_name !== undefined)  updates.customer_name  = body.customer_name;
    if (body.customer_phone !== undefined) updates.customer_phone = body.customer_phone;
    if (body.address !== undefined)        updates.address        = body.address;
    if (body.lat !== undefined)            updates.lat            = body.lat;
    if (body.lng !== undefined)            updates.lng            = body.lng;
    if (body.radius !== undefined && isManager) updates.radius    = body.radius;

    if (isManager || isLeader) {
      if (body.assigned_to !== undefined) {
        updates.assigned_to = body.assigned_to;
        updates.status = body.assigned_to ? 'ASSIGNED' : 'OPEN';
      }
      if (body.team_leader_id !== undefined) updates.team_leader_id = body.team_leader_id;
      if (body.location_id !== undefined)    updates.location_id    = body.location_id;
    }

    await supabase.from('tickets').update(updates).eq('id', id);
    await audit('UPDATE_TICKET', 'tickets', id, user.id, updates);

    if (updates.assigned_to) {
      await notify(updates.assigned_to, 'تم تعيين تذكرة لك', `التذكرة #${ticket.ticket_number}: ${ticket.title}`, 'TICKET_ASSIGNED', { ticket_id: id });
    }

    return resp(200, { ok: true });
  }

  // ── Status Transitions ────────────────────────────────────────────────────
  if (q.action === 'status' && event.httpMethod === 'POST') {
    const { id } = q;
    const { status, lat, lng, accuracy, note } = body;

    if (!id || !status) return resp(400, { error: 'id والحالة مطلوبان' });
    if (!VALID_STATUSES.includes(status)) return resp(400, { error: 'حالة غير صالحة' });

    const { data: ticket } = await supabase.from('tickets').select('*').eq('id', id).single();
    if (!ticket) return resp(404, { error: 'التذكرة غير موجودة' });

    const isAssigned = ticket.assigned_to === user.id;
    const isLeader   = ticket.team_leader_id === user.id;
    const isManager  = CAN_MANAGE.includes(user.role);

    const now = new Date().toISOString();
    const updates = { status, updated_at: now };

    if (status === 'IN_PROGRESS') {
      if (!isAssigned && !isManager) return resp(403, { error: 'ليس لديك صلاحية بدء هذه التذكرة' });
      if (!['OPEN','ASSIGNED'].includes(ticket.status)) {
        return resp(400, { error: 'لا يمكن بدء تذكرة بحالة ' + ticket.status });
      }

      if (ticket.lat && ticket.lng && lat && lng) {
        const dist = haversine(parseFloat(ticket.lat), parseFloat(ticket.lng), parseFloat(lat), parseFloat(lng));
        const radius = ticket.radius || 50;
        if (dist > radius) {
          return resp(400, {
            error: `أنت خارج نطاق موقع العمل المحدد. المسافة: ${Math.round(dist)} متر، النطاق المسموح: ${radius} متر.`,
            distance: Math.round(dist),
            radius
          });
        }
        updates.checkin_lat      = lat;
        updates.checkin_lng      = lng;
        updates.checkin_accuracy = accuracy || null;
      }

      updates.started_at = now;
    }

    if (status === 'COMPLETED') {
      if (!CAN_CLOSE.includes(user.role) && !isAssigned) return resp(403, { error: 'ليس لديك صلاحية إكمال هذه التذكرة' });
      if (ticket.status !== 'IN_PROGRESS') return resp(400, { error: 'يجب أن تكون التذكرة قيد العمل لإكمالها' });

      if (ticket.type !== 'COLLECTION') {
        const { count } = await supabase
          .from('ticket_images')
          .select('*', { count: 'exact', head: true })
          .eq('ticket_id', id);

        if (!count || count < 2) {
          return resp(400, {
            error: 'لا يمكن إكمال التذكرة قبل رفع صورة الباور السابق وصورة الباور الحالي.',
            images_uploaded: count || 0
          });
        }
      }

      updates.completed_at = now;
      if (ticket.started_at) {
        const ms = new Date(now) - new Date(ticket.started_at);
        updates.duration_minutes = Math.round(ms / 60000);
      }
      if (note) updates.close_note = note;
      if (ticket.type === 'COLLECTION' && body.amount_collected !== undefined) {
        updates.amount_collected = parseFloat(body.amount_collected) || 0;
      }
    }

    if (status === 'EXPIRED') {
      if (!isManager && !isLeader) return resp(403, { error: 'ليس لديك صلاحية تغيير التذكرة إلى منتهية' });
      if (note) updates.close_note = note;
    }

    if (status === 'ASSIGNED') {
      if (!isManager && !isLeader) return resp(403, { error: 'Forbidden' });
    }

    await supabase.from('tickets').update(updates).eq('id', id);
    await audit('TICKET_STATUS', 'tickets', id, user.id, { from: ticket.status, to: status, lat, lng });

    if (status === 'IN_PROGRESS' && ticket.team_leader_id) {
      await notify(ticket.team_leader_id, 'بدء الصيانة', `الفني بدأ العمل على التذكرة #${ticket.ticket_number}`, 'TICKET_STARTED', { ticket_id: id });
    }
    if (status === 'COMPLETED') {
      if (ticket.team_leader_id) await notify(ticket.team_leader_id, 'تذكرة مكتملة', `تذكرة #${ticket.ticket_number} تم إكمالها`, 'TICKET_COMPLETED', { ticket_id: id });
      await notifyRole(['SUPERVISOR'], 'تذكرة مكتملة', `تذكرة #${ticket.ticket_number} تم إكمالها`, 'TICKET_COMPLETED', { ticket_id: id });
    }
    if (status === 'EXPIRED') {
      if (ticket.assigned_to) await notify(ticket.assigned_to, 'تذكرة منتهية الصلاحية', `التذكرة #${ticket.ticket_number} أصبحت منتهية`, 'TICKET_EXPIRED', { ticket_id: id });
    }

    return resp(200, { ok: true });
  }

  // ── Collection Summary ────────────────────────────────────────────────────
  if (q.action === 'collection-summary' && event.httpMethod === 'GET') {
    if (user.role === 'COLLECTION_AGENT') {
      const { data: myTickets } = await supabase
        .from('tickets')
        .select('id,ticket_number,status,amount_collected,customer_name,completed_at,created_at')
        .eq('type', 'COLLECTION')
        .eq('assigned_to', user.id)
        .order('created_at', { ascending: false });

      const completed = (myTickets || []).filter(t => t.status === 'COMPLETED');
      const active    = (myTickets || []).filter(t => ['OPEN','ASSIGNED','IN_PROGRESS'].includes(t.status));
      const total     = completed.reduce((s, t) => s + (parseFloat(t.amount_collected) || 0), 0);

      return resp(200, {
        total_collected: total,
        completed_count: completed.length,
        active_count:    active.length,
        tickets:         myTickets || []
      });
    }

    if (!CAN_MANAGE.includes(user.role)) return resp(403, { error: 'Forbidden' });

    const { data: agents } = await supabase
      .from('users')
      .select('id,name,avatar_url')
      .eq('role', 'COLLECTION_AGENT')
      .eq('active', true);

    const result = [];
    for (const agent of (agents || [])) {
      const { data: tks } = await supabase
        .from('tickets')
        .select('status,amount_collected')
        .eq('type', 'COLLECTION')
        .eq('assigned_to', agent.id);

      const completed = (tks || []).filter(t => t.status === 'COMPLETED');
      const active    = (tks || []).filter(t => ['OPEN','ASSIGNED','IN_PROGRESS'].includes(t.status));
      const total     = completed.reduce((s, t) => s + (parseFloat(t.amount_collected) || 0), 0);

      result.push({
        ...agent,
        total_collected: total,
        completed_count: completed.length,
        active_count:    active.length,
        total_tickets:   (tks || []).length
      });
    }
    return resp(200, result);
  }

  // ── Server Timer ───────────────────────────────────────────────────────────
  if (q.action === 'timer' && event.httpMethod === 'GET') {
    const { id } = q;
    const { data: ticket } = await supabase
      .from('tickets')
      .select('started_at,completed_at,status,duration_minutes')
      .eq('id', id)
      .single();
    if (!ticket) return resp(404, { error: 'التذكرة غير موجودة' });

    const serverNow = new Date().toISOString();
    let elapsed = (ticket.duration_minutes || 0) * 60;
    if (ticket.status === 'IN_PROGRESS' && ticket.started_at) {
      elapsed = Math.round((Date.now() - new Date(ticket.started_at).getTime()) / 1000);
    }
    return resp(200, { server_time: serverNow, elapsed_seconds: elapsed, status: ticket.status });
  }

  // ── Add Image ──────────────────────────────────────────────────────────────
  if (q.action === 'image' && event.httpMethod === 'POST') {
    const { id } = q;
    const { url, label } = body;
    if (!url) return resp(400, { error: 'url مطلوب' });

    const { data: ticket } = await supabase.from('tickets').select('assigned_to,team_leader_id,ticket_number').eq('id', id).single();
    if (!ticket) return resp(404, { error: 'التذكرة غير موجودة' });

    const canAdd = ticket.assigned_to === user.id || ticket.team_leader_id === user.id || CAN_MANAGE.includes(user.role);
    if (!canAdd) return resp(403, { error: 'ليس لديك صلاحية رفع صور لهذه التذكرة' });

    await supabase.from('ticket_images').insert({
      ticket_id:   id,
      url,
      label:       label || 'OTHER',
      uploaded_by: user.id,
      uploaded_at: new Date().toISOString(),
    });

    await supabase.from('tickets').update({ updated_at: new Date().toISOString() }).eq('id', id);
    await audit('ADD_TICKET_IMAGE', 'tickets', id, user.id, { label });

    const { count } = await supabase.from('ticket_images').select('*', { count: 'exact', head: true }).eq('ticket_id', id);
    if (count >= 2 && ticket.team_leader_id) {
      await notify(ticket.team_leader_id, 'صور الباور جاهزة', `الصور مكتملة للتذكرة #${ticket.ticket_number}`, 'TICKET_IMAGES_READY', { ticket_id: id });
    }

    return resp(200, { ok: true, total_images: count });
  }

  // ── Delete Image ───────────────────────────────────────────────────────────
  if (q.action === 'image' && event.httpMethod === 'DELETE') {
    if (!CAN_MANAGE.includes(user.role)) return resp(403, { error: 'Forbidden' });
    const { image_id } = q;
    await supabase.from('ticket_images').delete().eq('id', image_id);
    return resp(200, { ok: true });
  }

  // ── Comments ───────────────────────────────────────────────────────────────
  if (q.action === 'comment' && event.httpMethod === 'POST') {
    const { id } = q;
    const { text } = body;
    if (!text) return resp(400, { error: 'النص مطلوب' });

    const { data: ticket } = await supabase.from('tickets').select('assigned_to,team_leader_id').eq('id', id).single();
    if (!ticket) return resp(404, { error: 'التذكرة غير موجودة' });

    const canComment = ticket.assigned_to === user.id || ticket.team_leader_id === user.id || CAN_MANAGE.includes(user.role);
    if (!canComment) return resp(403, { error: 'Forbidden' });

    const { data: comment } = await supabase.from('ticket_comments').insert({
      ticket_id: id, user_id: user.id, text, created_at: new Date().toISOString()
    }).select('*, author:users!user_id(id,name,avatar_url)').single();

    return resp(200, { ok: true, comment });
  }

  if (q.action === 'comment' && event.httpMethod === 'GET') {
    const { id } = q;
    const { data } = await supabase
      .from('ticket_comments')
      .select('*, author:users!user_id(id,name,avatar_url)')
      .eq('ticket_id', id)
      .order('created_at', { ascending: true });
    return resp(200, data || []);
  }

  // ── Delete Ticket ──────────────────────────────────────────────────────────
  if (event.httpMethod === 'DELETE' && !q.action) {
    if (user.role !== 'DEVELOPER') return resp(403, { error: 'Forbidden' });
    const { id } = q;
    if (!id) return resp(400, { error: 'id مطلوب' });
    await supabase.from('ticket_images').delete().eq('ticket_id', id);
    await supabase.from('ticket_comments').delete().eq('ticket_id', id);
    await supabase.from('tickets').delete().eq('id', id);
    await audit('DELETE_TICKET', 'tickets', id, user.id, {});
    return resp(200, { ok: true });
  }

  return resp(404, { error: 'Not found' });
}

export const onRequest = adapt(handler);
