import { DurableObject } from 'cloudflare:workers';
import { Clock, Effect, Option, Schema } from 'effect';
import type { Env } from '../env';
import { NOT_FOUND_BLOCK_SECONDS, NOT_FOUND_WINDOW_SECONDS, type Quota, type QuotaName, type Usage, type Verdict } from './limits';

const DAY_MS = 86_400_000;
const WINDOW_MS = NOT_FOUND_WINDOW_SECONDS * 1_000;
const BLOCK_MS = NOT_FOUND_BLOCK_SECONDS * 1_000;
// A reservation outlives any lookup (upstream calls time out at 10 seconds); one never settled, because the
// handler refused the request or the isolate died, frees itself after this.
const PENDING_MS = 60_000;

/** One identity's counters. `day` is days since the epoch, so the daily quotas reset at UTC midnight.
 *  `misses` holds the times of not-found lookups in the last hour, at most one hour's limit of them, and
 *  `pending` the times of lookups admitted but not yet settled: each holds a not-found slot until it is. */
const State = Schema.Struct({
  day: Schema.Number, toolCalls: Schema.Number, providerProfiles: Schema.Number, contentReads: Schema.Number,
  misses: Schema.Array(Schema.Number), pending: Schema.Array(Schema.Number), blockedUntil: Schema.Number,
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
  if (!stored) return { day: dayOf(now), toolCalls: 0, providerProfiles: 0, contentReads: 0, misses: [], pending: [], blockedUntil: 0 };
  const today = stored.day === dayOf(now) ? stored : { ...stored, day: dayOf(now), toolCalls: 0, providerProfiles: 0, contentReads: 0 };
  return { ...today, misses: today.misses.filter(at => at > now - WINDOW_MS), pending: today.pending.filter(at => at > now - PENDING_MS) };
};
/** When nothing in the state matters any more: the end of its day, its block, its newest miss's hour and
 *  its last reservation. */
const expiry = (state: State) => Math.max((state.day + 1) * DAY_MS, state.blockedUntil,
  ...state.misses.map(at => at + WINDOW_MS), ...state.pending.map(at => at + PENDING_MS));
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
    // A block applies only under a quota that has one: an address blocked as anonymous while the connector list
    // was loading is not blocked once it is known to be a connector, where it would lock out everyone behind it.
    if (quota.notFoundPerHour !== null && state.blockedUntil > now) return { state, verdict: { ok: false, quota: 'not_found_block', retryAfter: seconds(state.blockedUntil - now) } };
    const checks: [QuotaName, number, number, number][] = [
      ['tool_calls', state.toolCalls, usage.toolCalls, quota.toolCalls],
      ['provider_profiles', state.providerProfiles, usage.providerProfiles, quota.providerProfiles],
      ['content_reads', state.contentReads, usage.contentReads, quota.contentReads],
    ];
    const over = checks.find(([, used, adding, limit]) => adding > 0 && used + adding > limit);
    if (over) return { state, verdict: { ok: false, quota: over[0], retryAfter: seconds((state.day + 1) * DAY_MS - now) } };
    // Each lookup reserves a not-found slot now, before its upstream call, so lookups admitted together (one
    // batch, or concurrent requests) cannot all pass the check and then all miss.
    const limit = quota.notFoundPerHour;
    const reserving = limit !== null && usage.lookups > 0;
    const excess = reserving ? state.misses.length + state.pending.length + usage.lookups - limit : 0;
    if (excess > 0) {
      // Retry when enough slots are free for the whole request: the excess-th slot to free, as misses leave
      // the hour and reservations lapse. A batch larger than the whole limit never fits, so it gets one
      // reservation's life rather than a time that would not help.
      const frees = [...state.misses.map(at => at + WINDOW_MS), ...state.pending.map(at => at + PENDING_MS)].sort((a, b) => a - b);
      const freed = frees[excess - 1] ?? now + PENDING_MS;
      return { state, verdict: { ok: false, quota: 'lookup_slots', retryAfter: seconds(freed - now) } };
    }
    const next = { ...state, toolCalls: state.toolCalls + usage.toolCalls,
      providerProfiles: state.providerProfiles + usage.providerProfiles, contentReads: state.contentReads + usage.contentReads,
      pending: reserving ? [...state.pending, ...Array<number>(usage.lookups).fill(now)] : state.pending };
    storage.kv.put('state', next);
    return { state: next, verdict: reserving ? { ok: true, reservedAt: now } : { ok: true } };
  });
  if (verdict.ok) yield* scheduleCleanup(storage, state);
  return verdict;
});

/** Release a lookup's own reservation (one made at `reservedAt`; a lapsed one is already gone, and another
 *  request's is never touched). A miss becomes a counted not-found lookup, and the limit's worth blocks. */
const settleLookup = Effect.fn('QuotaCounter.settleLookup')(function* (storage: Storage, missed: boolean, quota: Quota, reservedAt: number | undefined) {
  const limit = quota.notFoundPerHour;
  if (limit === null) return;
  const now = yield* Clock.currentTimeMillis;
  const state = yield* Effect.sync(() => {
    const state = current(storage, now);
    const own = reservedAt === undefined ? -1 : state.pending.indexOf(reservedAt);
    const settled = { ...state, pending: own < 0 ? state.pending : state.pending.toSpliced(own, 1) };
    const misses = missed ? [...state.misses, now] : state.misses;
    const next = missed && misses.length >= limit
      ? { ...settled, misses: [], blockedUntil: now + BLOCK_MS }
      : { ...settled, misses };
    storage.kv.put('state', next);
    return next;
  });
  yield* scheduleCleanup(storage, state);
});

/** Give back what a request spent when the transport refused it before running any tool. */
const refund = Effect.fn('QuotaCounter.refund')(function* (storage: Storage, usage: Usage, reservedAt: number | undefined) {
  const now = yield* Clock.currentTimeMillis;
  yield* Effect.sync(() => {
    const state = current(storage, now);
    let released = 0;
    const pending = state.pending.filter(at => at !== reservedAt || ++released > usage.lookups);
    storage.kv.put('state', { ...state, pending,
      toolCalls: Math.max(0, state.toolCalls - usage.toolCalls),
      providerProfiles: Math.max(0, state.providerProfiles - usage.providerProfiles),
      contentReads: Math.max(0, state.contentReads - usage.contentReads) });
  });
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
  settleLookup(missed: boolean, quota: Quota, reservedAt?: number): Promise<void> {
    return Effect.runPromise(settleLookup(this.ctx.storage, missed, quota, reservedAt));
  }
  refund(usage: Usage, reservedAt?: number): Promise<void> {
    return Effect.runPromise(refund(this.ctx.storage, usage, reservedAt));
  }
  override alarm(): Promise<void> {
    return Effect.runPromise(cleanup(this.ctx.storage));
  }
}
