import { createMcpHandler } from 'agents/mcp/server';
import { Effect } from 'effect';
import { version } from '../package.json';
import { SITE_URL, TIERS, type Env, type Tier } from './env';
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
const tierHeaders = (tier: Tier) => ({ ...cors, 'X-CTC-Tier': tier, 'X-RateLimit-Policy': TIERS[tier].policy });
const anonymousHeaders = tierHeaders('anonymous');
const apiError = (status: number, error: string, headers: Record<string, string>, extra: Record<string, unknown> = {}) =>
  Response.json({ error, ...extra }, { status, headers });
/** Parse the browser Origin, if any; null means absent, false means malformed. */
const browserOrigin = (request: Request): URL | null | false => {
  const header = request.headers.get('Origin');
  if (header === null) return null;
  try {
    const origin = new URL(header);
    return ['https:', 'http:'].includes(origin.protocol) && origin.origin === header ? origin : false;
  } catch {
    return false;
  }
};
const decorate = (response: Response, headers: Record<string, string>) => {
  const wrapped = new Response(response.body, response);
  for (const [key, value] of Object.entries(headers)) wrapped.headers.set(key, value);
  return wrapped;
};
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const path = new URL(request.url).pathname;
    if ((path === '/mcp' || path === '/health') && request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: path === '/mcp' ? anonymousHeaders : cors });
    }
    if (path === '/mcp') {
      // Shape checks first: a malformed Origin is refused before any KV read or rate-limit token is spent.
      const origin = browserOrigin(request);
      if (origin === false) return apiError(403, 'invalid_origin', anonymousHeaders);
      const decision = await Effect.runPromise(authorise(request, env).pipe(
        Effect.catchCause(() => Effect.succeed(null)),
      ));
      // Nothing was verified when authorisation itself failed, so report the anonymous tier.
      if (!decision) return apiError(503, 'service_unavailable', anonymousHeaders);
      const headers = tierHeaders(decision.caller.tier);
      if (decision.status !== 200) {
        const retryAfter = decision.status === 429 ? TIERS[decision.caller.tier].window : undefined;
        return apiError(decision.status, decision.error ?? 'error', { ...headers, ...(retryAfter ? { 'Retry-After': String(retryAfter) } : {}) },
          { ...(retryAfter ? { retry_after: retryAfter } : {}), register: `${env.PUBLIC_ORIGIN}/register` });
      }
      const handler = createMcpHandler(() => createServer({ env, bucket: decision.caller.bucket, waitUntil: p => ctx.waitUntil(p) }), {
        corsOptions: false,
        // This public, cookie-free API accepts every valid HTTP(S) browser origin.
        allowedOriginHostnames: origin ? [origin.hostname] : [],
        allowedHostnames: [new URL(env.PUBLIC_ORIGIN).hostname, 'localhost', '127.0.0.1', '[::1]'],
      });
      try {
        return decorate(await handler(request, env, ctx), headers);
      } catch {
        return apiError(500, 'internal_error', headers);
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
      privacy: `${SITE_URL}/privacy-policy`, contact: `${SITE_URL}/contact`,
    });
    if (['/logo.png', '/logo-512.png', '/logo-400.png'].includes(path) && request.method === 'GET') return env.ASSETS.fetch(request);
    return apiError(404, 'not_found', {});
  },
} satisfies ExportedHandler<Env>;
