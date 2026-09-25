// Adapter: converts a Cloudflare Pages onRequest context → Netlify-style event,
// then wraps the Netlify-style { statusCode, headers, body } result into a Web Response.
// Usage in each function file:
//
//   import { adapt } from './_adapter.js';
//   import { createDB } from './_db.js';
//   import { createAuth, resp, cors, DEVELOPER_EMAIL } from './_auth.js';
//
//   async function handler(event, { supabase, verifySession, audit, notify, notifyRole }) {
//     // ... return resp(200, data) etc.
//   }
//
//   export const onRequest = adapt(handler);

import { createDB } from './_db.js';
import { createAuth } from './_auth.js';

export function adapt(handler) {
  return async function onRequest({ request, env }) {
    // Build supabase client and auth helpers scoped to this request's env
    const supabase = createDB(env);
    const { verifySession, audit, notify, notifyRole } = createAuth(supabase);

    // Convert Web Request → Netlify-style event
    const url = new URL(request.url);
    const queryStringParameters = {};
    url.searchParams.forEach((v, k) => { queryStringParameters[k] = v; });

    const headers = {};
    request.headers.forEach((v, k) => { headers[k] = v; });

    let body = null;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      body = await request.text().catch(() => null);
    }

    const event = {
      httpMethod: request.method,
      path: url.pathname,
      queryStringParameters,
      headers,
      body,
    };

    // Call Netlify-style handler
    const result = await handler(event, { supabase, verifySession, audit, notify, notifyRole, env });

    // Return Web Response
    return new Response(result.body, {
      status: result.statusCode,
      headers: result.headers || {},
    });
  };
}
