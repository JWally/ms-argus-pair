/**
 * Lazy Valkey client for the pair Lambda.
 *
 * - One ioredis instance per warm container, reused across invocations.
 * - TLS is mandatory (ElastiCache Serverless requires it).
 * - No password — SG isolation IS the auth boundary (Valkey lives in
 *   the shared VPC, ingress 6379 from the lambda SG only).
 * - Lazy-connect: handshake happens on first command, not at import,
 *   so cold starts don't pay for Valkey if the request doesn't need it.
 *
 * The rate-limit Lua script is registered as a custom command at
 * connect-time, so callers just do `valkey.rlIncr(key, max, ttl)`.
 * EVALSHA caching is handled by ioredis under the hood (it falls
 * back to EVAL on SCRIPT_LOAD miss, then upgrades to EVALSHA).
 */
import Redis from 'ioredis';

/**
 * Lua: atomic "increment if under cap" for rate-limit buckets.
 *
 *   KEYS[1]  bucket key
 *   ARGV[1]  cap
 *   ARGV[2]  ttl seconds
 *
 * Returns the post-state counter (whether or not we incremented). The
 * caller compares against cap to decide if the request tripped.
 */
const RL_INCR_LUA = `
local cur = tonumber(redis.call('GET', KEYS[1]) or "0")
if cur >= tonumber(ARGV[1]) then
  return tonumber(ARGV[1]) + 1
end
local new = redis.call('INCR', KEYS[1])
if new == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return new
`;

declare module 'ioredis' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface RedisCommander<Context> {
    rlIncr(key: string, max: number, ttl: number): Promise<number>;
  }
}

let cached: Redis | null = null;

/**
 * Lambda containers freeze between invocations. The underlying TCP
 * socket can die during the freeze without ioredis noticing — the next
 * `exec()` then throws "Stream isn't writeable and enableOfflineQueue
 * options is false" forever, because the cached client is held in a
 * permanently-broken state.
 *
 * Fix: gate the singleton on `client.status === 'ready'`. If it's
 * anything else (`end`, `wait`, `connecting`, `reconnecting`, `close`),
 * tear it down and build a fresh one. Plus an `end` handler that null's
 * the singleton so the next request unambiguously builds new.
 *
 * `lazyConnect: false` + `enableOfflineQueue: true` together let
 * commands queue while a fresh client is mid-handshake — the
 * `commandTimeout` is the upper bound, so a hanging connect can't
 * stall a Lambda invocation past its budget.
 */
export function getValkey(): Redis {
  if (cached && cached.status === 'ready') return cached;
  if (cached) {
    try {
      cached.disconnect();
    } catch {
      /* socket already gone — ignore */
    }
    cached = null;
  }
  const host = process.env.VALKEY_ENDPOINT;
  if (!host) throw new Error('VALKEY_ENDPOINT not configured');
  const port = Number(process.env.VALKEY_PORT ?? '6379');
  const client = new Redis({
    host,
    port,
    tls: {},
    lazyConnect: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 5_000,
    commandTimeout: 2_000,
    enableOfflineQueue: true,
    // Reconnect on ANY redis-level error so a stuck socket doesn't
    // persist. Returning 1 means "reconnect AND requeue this command".
    reconnectOnError: () => 1,
  });
  client.on('error', (err) => {
    console.warn(`[valkey] client error: ${err.message}`);
  });
  client.on('end', () => {
    // Connection terminated for good — drop the singleton so the next
    // getValkey() call builds fresh.
    if (cached === client) cached = null;
  });
  client.defineCommand('rlIncr', {
    numberOfKeys: 1,
    lua: RL_INCR_LUA,
  });
  cached = client;
  return cached;
}
