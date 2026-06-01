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
  return cur
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

export function getValkey(): Redis {
  if (cached) return cached;
  const host = process.env.VALKEY_ENDPOINT;
  if (!host) throw new Error('VALKEY_ENDPOINT not configured');
  const port = Number(process.env.VALKEY_PORT ?? '6379');
  cached = new Redis({
    host,
    port,
    tls: {},
    // Don't block module load on a TCP handshake; first command opens it.
    lazyConnect: true,
    // Bounded retry so a transient Valkey blip doesn't hang a Lambda
    // invocation for its whole 10s timeout.
    maxRetriesPerRequest: 2,
    connectTimeout: 2_000,
    commandTimeout: 1_500,
    // Keep the connection alive across Lambda invocations within a warm
    // container. Without this, ioredis pings can keep the event loop
    // open and prevent the Lambda runtime from freezing the container
    // between invocations — which means it never actually freezes and
    // we burn billable time. enableOfflineQueue=false also keeps the
    // failure surface honest.
    keepAlive: 30_000,
    enableOfflineQueue: false,
  });
  cached.defineCommand('rlIncr', {
    numberOfKeys: 1,
    lua: RL_INCR_LUA,
  });
  return cached;
}
