import { DurableObject } from 'cloudflare:workers';
import { Clock, Effect, Option, Schema } from 'effect';
import type { Env } from '../env';
import { NOT_FOUND_BLOCK_SECONDS, NOT_FOUND_WINDOW_SECONDS, type Quota, type QuotaName, type Usage, type Verdict } from './limits';

const DAY_MS = 86_400_000;
const WINDOW_MS = NOT_FOUND_WINDOW_SECONDS * 1_000;
const BLOCK_MS = NOT_FOUND_BLOCK_SECONDS * 1_000;

/** One identity's counters. `day` is days since the epoch, so the daily quotas reset at UTC midnight.
 *  `misses` holds the times of not-found lookups in the last hour, at most one hour's limit of them. */
const State = Schema.Struct({
  day: Schema.Number, toolCalls: Schema.Number, providerProfiles: Schema.Number, contentReads: Schema.Number,
  misses: Schema.Array(Schema.Number), blockedUntil: Schema.Number,
});
type State = typeof State.Type;
interface Decision { state: State; verdict: Verdict }
type Storage = Pick<DurableObjectStorage, 'kv' | 'deleteAll' | 'getAlarm' | 'setAlarm'>;

const decodeState = Schema.decodeUnknownOption(State);
const dayOf = (now: number) => Math.floor(now / DAY_MS);
const seconds = (ms: number) => Math.max(1, Math.ceil(ms / 1_000));
/** The stored state brought up to `now`: a new day zeroes the daily counters and misses older than an hour
 *  drop out. State written by an older shape starts fresh rather than failing every call. */
const current = (storage: Storage, now: number): State => {
  const stored = Option.getOrUndefined(decodeState(storage.kv.get('state')));
  if (!stored) return { day: dayOf(now), toolCalls: 0, providerProfiles: 0, contentReads: 0, misses: [], blockedUntil: 0 };
  const today = stored.day === dayOf(now) ? stored : { ...stored, day: dayOf(now), toolCalls: 0, providerProfiles: 0, contentReads: 0 };
  return { ...today, misses: today.misses.filter(at => at > now - WINDOW_MS) };
};
/** When nothing in the state matters any more: the end of its day, its block and its newest miss's hour. */
const expiry = (state: State) => Math.max((state.day + 1) * DAY_MS, state.blockedUntil, ...state.misses.map(at => at + WINDOW_MS));
/** Every identity gets a Durable Object, and one-off addresses are most of them, so each one clears itself. */
const scheduleCleanup = Effect.fn('scheduleCleanup')(function* (storage: Storage, state: State) {
  const at = expiry(state);
  const alarm = yield* Effect.promise(() => storage.getAlarm());
  if (alarm !== at) yield* Effect.promise(() => storage.setAlarm(at));
});

const consume = Effect.fn('QuotaCounter.consume')(function* (storage: Storage, usage: Usage, quota: Quota) {
  const now = yield* Clock.currentTimeMillis;
  // Read, decide and write with no await in between: the synchronous kv API means no other request to
  // this object can run between the check and the increment, so concurrent calls cannot overspend.
  const { state, verdict } = yield* Effect.sync((): Decision => {
    const state = current(storage, now);
    if (state.blockedUntil > now) return { state, verdict: { ok: false, quota: 'not_found_block', retryAfter: seconds(state.blockedUntil - now) } };
    const checks: [QuotaName, number, number, number][] = [
      ['tool_calls', state.toolCalls, usage.toolCalls, quota.toolCalls],
      ['provider_profiles', state.providerProfiles, usage.providerProfiles, quota.providerProfiles],
      ['content_reads', state.contentReads, usage.contentReads, quota.contentReads],
    ];
    const over = checks.find(([, used, adding, limit]) => adding > 0 && used + adding > limit);
    if (over) return { state, verdict: { ok: false, quota: over[0], retryAfter: seconds((state.day + 1) * DAY_MS - now) } };
    const next = { ...state, toolCalls: state.toolCalls + usage.toolCalls,
      providerProfiles: state.providerProfiles + usage.providerProfiles, contentReads: state.contentReads + usage.contentReads };
    storage.kv.put('state', next);
    return { state: next, verdict: { ok: true } };
  });
  if (verdict.ok) yield* scheduleCleanup(storage, state);
  return verdict;
});

const recordNotFound = Effect.fn('QuotaCounter.recordNotFound')(function* (storage: Storage, quota: Quota) {
  const now = yield* Clock.currentTimeMillis;
  const state = yield* Effect.sync(() => {
    const state = current(storage, now);
    const misses = [...state.misses, now];
    const next = misses.length >= quota.notFoundPerHour
      ? { ...state, misses: [], blockedUntil: now + BLOCK_MS }
      : { ...state, misses };
    storage.kv.put('state', next);
    return next;
  });
  yield* scheduleCleanup(storage, state);
});

const cleanup = Effect.fn('QuotaCounter.alarm')(function* (storage: Storage) {
  const now = yield* Clock.currentTimeMillis;
  const stored = Option.getOrUndefined(decodeState(storage.kv.get('state')));
  if (stored && expiry(stored) > now) return yield* scheduleCleanup(storage, stored);
  yield* Effect.promise(() => storage.deleteAll());
});

/** Daily quota and not-found counter for one caller bucket (`ip:`, `k:` and later `u:`), addressed by name. */
export class QuotaCounter extends DurableObject<Env> {
  consume(usage: Usage, quota: Quota): Promise<Verdict> {
    return Effect.runPromise(consume(this.ctx.storage, usage, quota));
  }
  recordNotFound(quota: Quota): Promise<void> {
    return Effect.runPromise(recordNotFound(this.ctx.storage, quota));
  }
  override alarm(): Promise<void> {
    return Effect.runPromise(cleanup(this.ctx.storage));
  }
}
