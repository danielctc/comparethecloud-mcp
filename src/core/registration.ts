import { Clock, DateTime, Effect, Schema } from 'effect';
import type { Env } from '../env';
import { escapeHtml } from '../html';
import { generateKey, hashKey, readKey, storage, writeKey, type KeyRecord } from './keys';

const length = (min: number, max: number) => Schema.String.check(Schema.isMinLength(min), Schema.isMaxLength(max));
const Registration = Schema.Struct({
  name: length(2, 80),
  email: length(3, 254).check(Schema.isPattern(/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/)),
  org: length(0, 200), use: length(10, 500), terms: Schema.Literal(true),
});
const Counter = Schema.Struct({ count: Schema.Number, expiresAt: Schema.Number });
export class RegistrationError extends Schema.TaggedError<RegistrationError>()('RegistrationError', {
  status: Schema.Number, message: Schema.String,
}) {}

const sendKey = Effect.fn('sendKey')(function* (env: Env, email: string, key: string) {
  const endpoint = `${env.PUBLIC_ORIGIN}/mcp`;
  const cursor = JSON.stringify({ mcpServers: { comparethecloud: {
    url: endpoint, headers: { Authorization: `Bearer ${key}` },
  } } }, null, 2);
  const text = `Your Compare the Cloud MCP key: ${key}\n\nEndpoint: ${endpoint}\n\nClaude Code:\nclaude mcp add --transport http comparethecloud ${endpoint} --header "Authorization: Bearer ${key}"\n\nCursor JSON (.cursor/mcp.json), also suitable for clients accepting MCP JSON configuration:\n${cursor}\n\nCodex CLI:\ncodex mcp add comparethecloud --url ${endpoint} --bearer-token-env-var CTC_MCP_KEY\nSet CTC_MCP_KEY to your key in your shell environment.\n\nLimit: 600 requests/min. Keep your key private.\nHelp: https://www.comparethecloud.net/contact`;
  const response = yield* Effect.tryPromise({
    try: () => fetch('https://api.resend.com/emails', {
      method: 'POST', signal: AbortSignal.timeout(10_000), redirect: 'error',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.RESEND_FROM, to: [email], subject: 'Your Compare the Cloud MCP key',
        text, html: `<html lang="en-GB"><body style="font-family:system-ui;color:#0F172A;background:#FFFFFF"><h1>Your Compare the Cloud MCP key</h1><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${escapeHtml(text)}</pre></body></html>`,
      }),
    }),
    catch: () => new RegistrationError({ status: 500, message: 'Could not send, try again later.' }),
  });
  if (!response.ok) return yield* new RegistrationError({ status: 500, message: 'Could not send, try again later.' });
});

export const register = Effect.fn('register')(function* (request: Request, env: Env) {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/x-www-form-urlencoded')) {
    return yield* new RegistrationError({ status: 415, message: 'Please submit the registration form.' });
  }
  const raw = yield* Effect.tryPromise({
    try: () => request.text(),
    catch: () => new RegistrationError({ status: 400, message: 'Could not read the registration form.' }),
  });
  if (raw.length > 16_384) return yield* new RegistrationError({ status: 413, message: 'The registration form is too large.' });
  const form = new URLSearchParams(raw);
  if (form.get('website')) return { status: 200, sent: true };
  const details = yield* Schema.decodeUnknownEffect(Registration)({
    name: (form.get('name') ?? '').trim(), email: (form.get('email') ?? '').trim().toLowerCase(),
    org: (form.get('org') ?? '').trim(), use: (form.get('use') ?? '').trim(), terms: form.has('terms'),
  }).pipe(Effect.mapError(() => new RegistrationError({
    status: 400, message: 'Enter a name (2–80 characters), a valid work email and your intended use (10–500 characters), and agree to the terms and privacy policy.',
  })));
  const counterKey = `reg:${request.headers.get('CF-Connecting-IP') ?? 'unknown'}`;
  const now = yield* Clock.currentTimeMillis;
  const rawCounter = yield* storage(() => env.MCP_KEYS.get(counterKey));
  const stored = rawCounter === null ? null : yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Counter))(rawCounter);
  const counter = stored && stored.expiresAt > now ? stored : { count: 0, expiresAt: now + 3_600_000 };
  if (counter.count >= 5) return yield* new RegistrationError({ status: 429, message: 'Too many registrations. Please try again in an hour.' });
  yield* storage(() => env.MCP_KEYS.put(counterKey, JSON.stringify({ ...counter, count: counter.count + 1 }), {
    expirationTtl: Math.max(60, Math.ceil((counter.expiresAt - now) / 1000)),
  }));
  const emailKey = `email:${details.email}`;
  const oldHash = yield* storage(() => env.MCP_KEYS.get(emailKey));
  if (oldHash) {
    const old = yield* readKey(env, oldHash);
    if (old) yield* writeKey(env, oldHash, { ...old, status: 'revoked' });
  }
  const key = yield* generateKey;
  const hash = yield* hashKey(key);
  const createdAt = DateTime.formatIso(yield* DateTime.now);
  const record: KeyRecord = { name: details.name, email: details.email, org: details.org, use: details.use,
    createdAt, tier: 'registered', status: 'active' };
  yield* writeKey(env, hash, record);
  yield* storage(() => env.MCP_KEYS.put(emailKey, hash)).pipe(
    Effect.andThen(sendKey(env, details.email, key)),
    Effect.catch(error => writeKey(env, hash, { ...record, status: 'revoked' }).pipe(
      Effect.andThen(Effect.fail(error)),
    )),
  );
  return { status: 200, sent: true };
});

export const registerSafely = Effect.fn('registerSafely')(function* (request: Request, env: Env) {
  return yield* register(request, env).pipe(
    Effect.catch(error => Effect.succeed({ status: error._tag === 'RegistrationError' ? error.status : 500,
      sent: false, message: error._tag === 'RegistrationError' ? error.message : 'Could not send, try again later.' })),
    Effect.catchCause(() => Effect.succeed({ status: 500, sent: false, message: 'Could not send, try again later.' })),
  );
});
