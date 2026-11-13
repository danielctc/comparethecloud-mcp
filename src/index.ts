import { DEFAULT_MAX_REQUEST_BODY_SIZE, isJsonContentType } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { Effect } from 'effect';
import { version } from '../package.json';
import { SITE_URL, TIERS, type Caller, type Env, type Tier } from './env';
import { readUpTo } from './core/body';
import { connectorRanges } from './core/connectors';
import { authorise, type AuthDecision } from './core/keys';
import { callsIn, CONTACT_URL, enforceQuota, REFUSALS, settleLookup, type RpcId } from './core/limits';
import { registerSafely } from './core/registration';
import { landing, registrationFailure, registrationForm, registrationSuccess } from './html';
import { createServer } from './mcp';

export { QuotaCounter } from './core/quota';

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
/** Discovery documents under /.well-known: the MCP card and the OpenAI plugin-directory domain check. */
const wellKnown = (path: string, method: string, env: Env): Response | null => {
  if (path === '/.well-known/mcp.json' && method === 'GET') return Response.json({
    name: 'Compare the Cloud', description: 'Read-only UK B2B technology directory, articles, news and opinion.',
    endpoint: `${env.PUBLIC_ORIGIN}/mcp`, transport: 'streamable-http', auth: 'optional bearer key',
    register: `${env.PUBLIC_ORIGIN}/register`, docs: 'https://github.com/danielctc/comparethecloud-mcp',
    privacy: `${SITE_URL}/privacy-policy`, contact: `${SITE_URL}/contact`,
  });
  if (path === '/.well-known/openai-apps-challenge' && (method === 'GET' || method === 'HEAD')) {
    // The portal's domain check: the exact token as plain text, never cached, so a rotated secret shows at once.
    if (!env.OPENAI_APPS_CHALLENGE) return new Response(null, { status: 404 });
    return new Response(method === 'HEAD' ? null : env.OPENAI_APPS_CHALLENGE,
      { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
  return null;
};
/** The answer for a caller authorise turned away: on the deny list, an unknown key, or over the minute rate. */
const refusal = (decision: AuthDecision, headers: Record<string, string>, env: Env) => {
  const register = `${env.PUBLIC_ORIGIN}/register`;
  if (decision.status === 403) return apiError(403, 'denied', headers, { contact: CONTACT_URL });
  if (decision.status !== 429) return apiError(decision.status, decision.error ?? 'error', headers, { register });
  const retryAfter = TIERS[decision.caller.tier].window;
  return apiError(429, decision.error ?? 'rate_limited', { ...headers, 'Retry-After': String(retryAfter) },
    { retry_after: retryAfter, register, contact: CONTACT_URL });
};
/** Spend this request's tool calls on the caller's daily quota. Gives a Response when the request must not go
 *  through, otherwise the time its lookups' not-found slots were reserved at, if any. Only tools/call
 *  requests spend, so initialise and tools/list never touch the counter, and neither does a body the
 *  transport will refuse as not JSON. The body is read from a clone: the handler still gets the original. */
const meter = async (request: Request, env: Env, caller: Caller, headers: Record<string, string>): Promise<Response | { reservedAt?: number }> => {
  const outcome = await Effect.runPromise(Effect.gen(function* () {
    // A body too large to read cannot be counted, so it is refused rather than served uncounted. The cap is the
    // MCP SDK's own transport limit, which it also enforces; this keeps the guarantee if that default changes.
    const json = request.method === 'POST' && isJsonContentType(request.headers.get('Content-Type'));
    const calls = callsIn(json ? yield* readUpTo(request.clone().body, DEFAULT_MAX_REQUEST_BODY_SIZE) : '');
    return { calls, verdict: yield* enforceQuota(env, caller, calls.usage) };
  }).pipe(
    Effect.catchTag('BodyTooLarge', () => Effect.succeed('too_large' as const)),
    Effect.catchCause(() => Effect.succeed(null)),
  ));
  if (outcome === 'too_large') return apiError(413, 'payload_too_large', headers);
  if (!outcome) return apiError(503, 'service_unavailable', headers);
  const { calls, verdict } = outcome;
  if (verdict.ok) return { reservedAt: verdict.reservedAt };
  // A JSON-RPC error, so an MCP client shows the message; HTTP 429 and Retry-After stay for everything else.
  const error = (id: RpcId | null) => ({ jsonrpc: '2.0', id, error: { code: -32000, message: REFUSALS[verdict.quota].message,
    data: { error: 'quota_exceeded', quota: verdict.quota, retry_after: verdict.retryAfter, contact: REFUSALS[verdict.quota].contact } } });
  return Response.json(calls.batch ? calls.ids.map(error) : error(calls.ids[0] ?? null),
    { status: 429, headers: { ...headers, 'Retry-After': String(verdict.retryAfter) } });
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
      const waitUntil = (promise: Promise<unknown>) => ctx.waitUntil(promise);
      const decision = await Effect.runPromise(connectorRanges(env, waitUntil).pipe(
        Effect.flatMap(connectors => authorise(request, env, connectors)),
        Effect.catchCause(() => Effect.succeed(null)),
      ));
      // Nothing was verified when authorisation itself failed, so report the anonymous tier.
      if (!decision) return apiError(503, 'service_unavailable', anonymousHeaders);
      const { caller } = decision;
      const headers = tierHeaders(caller.tier);
      if (decision.status !== 200) return refusal(decision, headers, env);
      const metered = await meter(request, env, caller, headers);
      if (metered instanceof Response) return metered;
      // Only a request whose lookups reserved not-found slots has anything to settle; connector addresses never do.
      const { reservedAt } = metered;
      const handler = createMcpHandler(() => createServer({ env, bucket: caller.bucket, waitUntil,
        // Settled after the reply rather than before it: the count never changes what this caller receives.
        ...(reservedAt === undefined ? {} : { onLookup: (missed: boolean) => Effect.sync(() => ctx.waitUntil(Effect.runPromise(settleLookup(env, caller, missed, reservedAt)))) }) }), {
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
    const discovery = wellKnown(path, request.method, env);
    if (discovery) return discovery;
    if (['/logo.png', '/logo-512.png', '/logo-400.png'].includes(path) && request.method === 'GET') return env.ASSETS.fetch(request);
    return apiError(404, 'not_found', {});
  },
} satisfies ExportedHandler<Env>;
