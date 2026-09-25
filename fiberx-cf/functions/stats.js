import { adapt } from './_adapter.js';
import { resp, cors } from './_auth.js';

async function handler(event, { supabase, verifySession }) {
  if (event.httpMethod === 'OPTIONS') return cors();
  const user = await verifySession(event);
  if (!user) return resp(401, { error: 'Unauthorized' });

  const q = event.queryStringParameters || {};
  const today = new Date().toISOString().slice(0, 10);
  const month_start = today.slice(0, 7) + '-01';

  // ── Dashboard Stats ───────────────────────────────────────────────────────
  if (!q.action || q.action === 'dashboard') {
    let ticketBase = supabase.from('tickets').select('status,type,priority,duration_minutes,assigned_to,created_at', { count: 'exact' });

    if (user.role === 'TECHNICIAN') {
      ticketBase = ticketBase.eq('assigned_to', user.id).neq('type', 'COLLECTION');
    } else if (user.role === 'COLLECTION_AGENT') {
      ticketBase = ticketBase.eq('assigned_to', user.id).eq('type', 'COLLECTION');
    } else if (user.role === 'TEAM_LEADER') {
      ticketBase = ticketBase.or(`team_leader_id.eq.${user.id},created_by.eq.${user.id}`);
    }

    const { data: tickets } = await ticketBase;

    const counts = {
      total:       (tickets||[]).length,
      open:        0, assigned: 0, in_progress: 0, completed: 0, expired: 0,
      today:       0, this_month: 0,
      high:        0, medium: 0, low: 0,
    };

    const durations = [];

    for (const t of (tickets || [])) {
      if (t.status === 'OPEN')        counts.open++;
      if (t.status === 'ASSIGNED')    counts.assigned++;
      if (t.status === 'IN_PROGRESS') counts.in_progress++;
      if (t.status === 'COMPLETED')   counts.completed++;
      if (t.status === 'EXPIRED')     counts.expired++;

      if (t.created_at?.slice(0, 10) === today)            counts.today++;
      if (t.created_at?.slice(0, 7) === today.slice(0, 7)) counts.this_month++;

      if (t.priority === 'HIGH')   counts.high++;
      if (t.priority === 'MEDIUM') counts.medium++;
      if (t.priority === 'LOW')    counts.low++;

      if (t.duration_minutes) durations.push(t.duration_minutes);
    }

    const timer = {
      avg:   durations.length ? Math.round(durations.reduce((a,b)=>a+b,0)/durations.length) : 0,
      min:   durations.length ? Math.min(...durations) : 0,
      max:   durations.length ? Math.max(...durations) : 0,
      total: durations.reduce((a,b)=>a+b,0),
    };

    const { count: presentToday } = await supabase
      .from('attendance')
      .select('*', { count: 'exact', head: true })
      .eq('date', today);

    const { count: pendingAdvances } = await supabase
      .from('advances')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'PENDING');

    const { count: activePenalties } = await supabase
      .from('penalties')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'ACTIVE')
      .gte('created_at', month_start);

    return resp(200, {
      tickets: counts,
      timer,
      attendance: { present_today: presentToday || 0 },
      advances:   { pending: pendingAdvances || 0 },
      penalties:  { active_this_month: activePenalties || 0 },
    });
  }

  // ── Technician Performance ─────────────────────────────────────────────────
  if (q.action === 'performance') {
    if (!['DEVELOPER','SUPERVISOR','TEAM_LEADER'].includes(user.role)) {
      return resp(403, { error: 'Forbidden' });
    }

    let techQuery = supabase.from('users').select('id,name,avatar_url').eq('active', true);
    if (user.role === 'TEAM_LEADER') {
      const { data: myTickets } = await supabase.from('tickets').select('assigned_to').eq('team_leader_id', user.id);
      const ids = [...new Set((myTickets||[]).map(t=>t.assigned_to).filter(Boolean))];
      if (ids.length) techQuery = techQuery.in('id', ids);
      else return resp(200, []);
    } else {
      techQuery = techQuery.in('role', ['TECHNICIAN','COLLECTION_AGENT']);
    }

    const { data: techs } = await techQuery;
    if (!techs?.length) return resp(200, []);

    const result = await Promise.all(techs.map(async (tech) => {
      const { data: tix } = await supabase
        .from('tickets')
        .select('status,duration_minutes,created_at')
        .eq('assigned_to', tech.id);

      const completed = (tix||[]).filter(t => t.status === 'COMPLETED');
      const durations = completed.map(t => t.duration_minutes).filter(Boolean);

      return {
        user: tech,
        total:        (tix||[]).length,
        completed:    completed.length,
        open:         (tix||[]).filter(t=>t.status==='OPEN'||t.status==='ASSIGNED').length,
        in_progress:  (tix||[]).filter(t=>t.status==='IN_PROGRESS').length,
        avg_duration: durations.length ? Math.round(durations.reduce((a,b)=>a+b,0)/durations.length) : 0,
      };
    }));

    return resp(200, result);
  }

  // ── Audit Logs ─────────────────────────────────────────────────────────────
  if (q.action === 'audit') {
    if (user.role !== 'DEVELOPER') return resp(403, { error: 'Forbidden' });

    let query = supabase
      .from('audit_logs')
      .select('*, actor:users!user_id(id,name,avatar_url)')
      .order('created_at', { ascending: false })
      .limit(parseInt(q.limit) || 100);

    if (q.entity)      query = query.eq('entity', q.entity);
    if (q.action_type) query = query.eq('action', q.action_type);
    if (q.user_id)     query = query.eq('user_id', q.user_id);

    const { data, error } = await query;
    if (error) return resp(500, { error: error.message });
    return resp(200, data || []);
  }

  return resp(404, { error: 'Not found' });
}

export const onRequest = adapt(handler);
