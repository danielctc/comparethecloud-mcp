import { createMcpHandler } from 'agents/mcp/server';
import { Effect } from 'effect';
import { version } from '../package.json';
import type { Env } from './env';
import { authorise } from './core/keys';
import { registerSafely } from './core/registration';
import { landing, registrationFailure, registrationForm, registrationSuccess } from './html';
import { createServer } from './mcp';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id, X-CTC-Tier, X-RateLimit-Policy, Retry-After',
};
const html = (body: string, status = 200) => new Response(body, {
  status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' },
});
const decorate = (response: Response, headers: Record<string, string>) => {
  const wrapped = new Response(response.body, response);
  for (const [key, value] of Object.entries(headers)) wrapped.headers.set(key, value);
  return wrapped;
};
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const path = new URL(request.url).pathname;
    if ((path === '/mcp' || path === '/health') && request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...cors, ...(path === '/mcp' ? { 'X-CTC-Tier': 'anonymous', 'X-RateLimit-Policy': '60;w=60' } : {}) } });
    }
    if (path === '/mcp') {
      const decision = await Effect.runPromise(authorise(request, env).pipe(
        Effect.catchCause(() => Effect.succeed(null)),
      ));
      if (!decision) return Response.json({ error: 'service_unavailable' }, { status: 503, headers: {
        ...cors, 'X-CTC-Tier': request.headers.has('Authorization') ? 'registered' : 'anonymous',
        'X-RateLimit-Policy': request.headers.has('Authorization') ? '600;w=60' : '60;w=60',
      } });
      const headers = { ...cors, 'X-CTC-Tier': decision.caller.tier, 'X-RateLimit-Policy': decision.caller.policy };
      if (decision.status !== 200) return Response.json({
        error: decision.error, ...(decision.status === 429 ? { retry_after: 60 } : {}), register: `${env.PUBLIC_ORIGIN}/register`,
      }, { status: decision.status, headers: { ...headers, ...(decision.status === 429 ? { 'Retry-After': '60' } : {}) } });
      const originHeader = request.headers.get('Origin');
      const allowedOrigins: string[] = [];
      if (originHeader !== null) {
        try {
          const browserOrigin = new URL(originHeader);
          if (!['https:', 'http:'].includes(browserOrigin.protocol) || browserOrigin.origin !== originHeader) {
            return Response.json({ error: 'invalid_origin' }, { status: 403, headers });
          }
          allowedOrigins.push(browserOrigin.hostname);
        } catch {
          return Response.json({ error: 'invalid_origin' }, { status: 403, headers });
        }
      }
      const handler = createMcpHandler(() => createServer({ env, bucket: decision.caller.bucket }), {
        corsOptions: false,
        // This public, cookie-free API accepts every valid HTTP(S) browser origin.
        allowedOriginHostnames: allowedOrigins,
        allowedHostnames: [new URL(env.PUBLIC_ORIGIN).hostname, 'localhost', '127.0.0.1', '[::1]'],
      });
      try {
        return decorate(await handler(request, env, ctx), headers);
      } catch {
        return Response.json({ error: 'internal_error' }, { status: 500, headers });
      }
    }
    if (path === '/health' && request.method === 'GET') {
      return Response.json({ ok: true, version, upstream: env.SITE_ORIGIN }, { headers: cors });
    }
    if (path === '/' && request.method === 'GET') return html(landing(env.PUBLIC_ORIGIN));
    if (path === '/register' && request.method === 'GET') return html(registrationForm());
    if (path === '/register' && request.method === 'POST') {
      const outcome = await Effect.runPromise(registerSafely(request, env));
      if (outcome.sent) return html(registrationSuccess());
      return html(outcome.status >= 500 ? registrationFailure() : registrationForm('message' in outcome ? outcome.message : ''), outcome.status);
    }
    if (path === '/.well-known/mcp.json' && request.method === 'GET') return Response.json({
      name: 'Compare the Cloud', description: 'Read-only UK B2B technology directory, articles, news and opinion.',
      endpoint: `${env.PUBLIC_ORIGIN}/mcp`, transport: 'streamable-http', auth: 'optional bearer key',
      register: `${env.PUBLIC_ORIGIN}/register`, docs: 'https://github.com/danielctc/comparethecloud-mcp',
      privacy: 'https://www.comparethecloud.net/privacy-policy', contact: 'https://www.comparethecloud.net/contact',
    });
    if (['/logo.png', '/logo-512.png', '/logo-400.png'].includes(path) && request.method === 'GET') return env.ASSETS.fetch(request);
    return Response.json({ error: 'not_found' }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
