// Zero-dependency Supabase client — Cloudflare Pages Functions version
// Pass Cloudflare env object to createDB(); returns a supabase-compatible client.

export function createDB(env) {
  const SUPABASE_URL = env.SUPABASE_URL;
  const SUPABASE_KEY = env.SUPABASE_SERVICE_KEY;

  const BASE  = () => `${SUPABASE_URL}/rest/v1`;
  const SBASE = () => `${SUPABASE_URL}/storage/v1`;

  function dbHeaders(extra = {}) {
    return {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...extra,
    };
  }

  // ─── QueryBuilder ──────────────────────────────────────────────────────────
  class QB {
    constructor(table, method, bodyData) {
      this._table   = table;
      this._method  = method;
      this._body    = bodyData ?? null;
      this._filters = [];
      this._cols    = '*';
      this._order   = null;
      this._limit   = null;
      this._single  = false;
      this._count   = false;
      this._head    = false;
      this._retSel  = false;
    }

    select(cols = '*', opts = {}) {
      if (this._method === 'GET') {
        this._cols = cols;
      } else {
        this._retSel = true;
      }
      if (opts.count === 'exact') this._count = true;
      if (opts.head)              this._head  = true;
      return this;
    }
    eq(col, val)  { this._filters.push(`${col}=eq.${encodeURIComponent(String(val))}`);  return this; }
    neq(col, val) { this._filters.push(`${col}=neq.${encodeURIComponent(String(val))}`); return this; }
    gt(col, val)  { this._filters.push(`${col}=gt.${encodeURIComponent(String(val))}`);  return this; }
    gte(col, val) { this._filters.push(`${col}=gte.${encodeURIComponent(String(val))}`); return this; }
    lt(col, val)  { this._filters.push(`${col}=lt.${encodeURIComponent(String(val))}`);  return this; }
    lte(col, val) { this._filters.push(`${col}=lte.${encodeURIComponent(String(val))}`); return this; }
    in(col, vals) { this._filters.push(`${col}=in.(${vals.map(v => encodeURIComponent(String(v))).join(',')})`); return this; }
    is(col, val)  { this._filters.push(`${col}=is.${val}`); return this; }
    or(expr)      { this._filters.push(`or=(${expr})`);     return this; }
    order(col, opts = {}) { this._order = `${col}.${opts.ascending === false ? 'desc' : 'asc'}`; return this; }
    limit(n)   { this._limit  = n;    return this; }
    single()   { this._single = true; return this; }

    then(resolve, reject) { this._run().then(resolve, reject); }

    async _run() {
      if (!SUPABASE_KEY) throw new Error('SUPABASE_SERVICE_KEY not set');

      if (this._method === 'GET') {
        let url = `${BASE()}/${this._table}?select=${encodeURIComponent(this._cols)}`;
        if (this._filters.length) url += '&' + this._filters.join('&');
        if (this._order)          url += `&order=${this._order}`;
        if (this._limit !== null) url += `&limit=${this._limit}`;
        if (this._single)         url += '&limit=1';

        const prefer = this._count ? 'count=exact' : undefined;
        const h = dbHeaders(prefer ? { Prefer: prefer } : {});

        const res = await fetch(url, { method: this._head ? 'HEAD' : 'GET', headers: h });

        let count = null;
        if (this._count) {
          const cr = res.headers.get('content-range');
          if (cr) { const parts = cr.split('/'); count = parts[1] ? parseInt(parts[1]) : 0; }
        }

        if (this._head) return { data: null, count, error: null };

        const body = await res.json().catch(() => []);
        const arr  = Array.isArray(body) ? body : (body ? [body] : []);

        if (this._single) return { data: arr[0] ?? null, count, error: null };
        return { data: arr, count, error: !res.ok ? body : null };
      }

      // POST / PATCH / DELETE
      const filterStr = this._filters.length ? '?' + this._filters.join('&') : '';
      const url = `${BASE()}/${this._table}${filterStr}`;

      if (this._method === 'POST') {
        const h = dbHeaders({ Prefer: 'return=representation' });
        const res  = await fetch(url, { method: 'POST', headers: h, body: JSON.stringify(this._body) });
        const body = await res.json().catch(() => null);
        const arr  = Array.isArray(body) ? body : (body ? [body] : []);
        const data = this._single ? (arr[0] ?? null) : (arr.length ? arr : null);
        return { data, error: !res.ok ? body : null };
      }

      if (this._method === 'PATCH') {
        const h = dbHeaders({ Prefer: 'return=representation' });
        const res  = await fetch(url, { method: 'PATCH', headers: h, body: JSON.stringify(this._body) });
        const body = await res.json().catch(() => null);
        const arr  = Array.isArray(body) ? body : (body ? [body] : []);
        return { data: arr[0] ?? null, error: !res.ok ? body : null };
      }

      if (this._method === 'DELETE') {
        const res = await fetch(url, { method: 'DELETE', headers: dbHeaders() });
        return { data: null, error: !res.ok ? await res.json().catch(() => null) : null };
      }
    }
  }

  // ─── Insert builder ────────────────────────────────────────────────────────
  class InsertQB {
    constructor(table, data) {
      this._table  = table;
      this._data   = data;
      this._single = false;
    }
    select() { return this; }
    single() { this._single = true; return this; }
    then(resolve, reject) { this._run().then(resolve, reject); }

    async _run() {
      const url  = `${BASE()}/${this._table}`;
      const h    = dbHeaders({ Prefer: 'return=representation' });
      const res  = await fetch(url, { method: 'POST', headers: h, body: JSON.stringify(this._data) });
      const body = await res.json().catch(() => null);
      const arr  = Array.isArray(body) ? body : (body ? [body] : []);
      const data = this._single ? (arr[0] ?? null) : (arr.length ? arr : null);
      return { data, error: !res.ok ? body : null };
    }
  }

  // ─── Upsert builder ────────────────────────────────────────────────────────
  class UpsertQB {
    constructor(table, data, opts = {}) {
      this._table  = table;
      this._data   = data;
      this._opts   = opts;
      this._single = false;
    }
    select() { return this; }
    single() { this._single = true; return this; }
    then(resolve, reject) { this._run().then(resolve, reject); }

    async _run() {
      const conflict = this._opts.onConflict ? `?on_conflict=${encodeURIComponent(this._opts.onConflict)}` : '';
      const url = `${BASE()}/${this._table}${conflict}`;
      const h   = dbHeaders({ Prefer: 'return=representation,resolution=merge-duplicates' });
      const res  = await fetch(url, { method: 'POST', headers: h, body: JSON.stringify(this._data) });
      const body = await res.json().catch(() => null);
      const arr  = Array.isArray(body) ? body : (body ? [body] : []);
      const data = this._single ? (arr[0] ?? null) : (arr.length ? arr : null);
      return { data, error: !res.ok ? body : null };
    }
  }

  // ─── Storage ───────────────────────────────────────────────────────────────
  function storageFrom(bucket) {
    return {
      getPublicUrl(path) {
        return {
          data: { publicUrl: `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${path}` }
        };
      },

      async createSignedUploadUrl(path) {
        const res = await fetch(`${SBASE()}/object/upload/sign/${bucket}/${path}`, {
          method:  'POST',
          headers: dbHeaders(),
          body:    JSON.stringify({}),
        });
        const data = await res.json().catch(() => ({}));
        return { data: res.ok ? data : null, error: !res.ok ? data : null };
      },

      async createSignedUrl(path, expiresIn = 3600) {
        const res = await fetch(`${SBASE()}/object/sign/${bucket}/${path}`, {
          method:  'POST',
          headers: dbHeaders(),
          body:    JSON.stringify({ expiresIn }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return { data: null, error: data };
        const signedUrl = data.signedUrl || data.signedURL || '';
        return { data: { signedUrl }, error: null };
      },

      async list(prefix = '') {
        const res = await fetch(`${SBASE()}/object/list/${bucket}`, {
          method:  'POST',
          headers: dbHeaders(),
          body:    JSON.stringify({ prefix, limit: 1000, offset: 0 }),
        });
        const data = await res.json().catch(() => []);
        return { data: Array.isArray(data) ? data : [], error: !res.ok ? data : null };
      },
    };
  }

  // ─── Main supabase object ──────────────────────────────────────────────────
  return {
    from(table) {
      return {
        select(cols = '*', opts = {}) { return new QB(table, 'GET').select(cols, opts); },
        insert(data)                  { return new InsertQB(table, data); },
        update(data)                  { return new QB(table, 'PATCH', data); },
        delete()                      { return new QB(table, 'DELETE'); },
        upsert(data, opts = {})       { return new UpsertQB(table, data, opts); },
      };
    },
    storage: {
      from: (bucket) => storageFrom(bucket),
    },
  };
}
