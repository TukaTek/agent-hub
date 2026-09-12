import { createHash } from "node:crypto";

export interface HubVerifyCacheConfig {
  /** Cache TTL in milliseconds. Default: 30 seconds */
  ttlMs: number;
  /** Whether to enable the cache. Default: true */
  enabled: boolean;
}

export interface HubVerifyCacheEntry {
  /** When this cache entry expires (min of TTL expiry and token expiry) */
  expiresAt: number;
  /** Token expiry time for reference */
  tokenExpiresAt: number;
}

export interface HubVerifyCacheMetrics {
  hits: number;
  misses: number;
  evictions: number;
  verifyLatencyMs: number[];
}

/**
 * Process-local in-memory cache for Hub session verification results.
 * 
 * Caches successful `client.verify()` outcomes keyed by access token hash,
 * respecting both the configured TTL and the token's actual expiry time.
 * 
 * ## Design decisions
 * 
 * - **Process-local**: acceptable for v1; TTL bounds worst-case revoke lag per replica
 * - **Fail-closed**: only successful verifications are cached; failures always re-verify
 * - **Token-keyed**: cache key is a hash of the decrypted access token
 * - **Bounded expiry**: cache expiry = min(now + TTL, token expiry)
 * - **Auto-cleanup**: expired entries are lazily removed on access and periodically swept
 * 
 * ## Revoke semantics
 * 
 * Worst-case revoke detection lag = TTL + one request round-trip.
 * After TTL expires, the next request re-verifies with Hub and observes the revoke/disable.
 * 
 * @example
 * ```ts
 * const cache = createHubVerifyCache({ ttlMs: 30_000, enabled: true });
 * const tokenHash = cache.hashToken(decryptedAccessToken);
 * 
 * if (cache.get(tokenHash, tokenExpiresAtMs)) {
 *   // Cache hit: skip Hub verify
 * } else {
 *   // Cache miss: verify with Hub
 *   const start = Date.now();
 *   await client.verify(token, identity);
 *   cache.set(tokenHash, tokenExpiresAtMs);
 *   cache.recordVerifyLatency(Date.now() - start);
 * }
 * ```
 */
export function createHubVerifyCache(config: HubVerifyCacheConfig) {
  const cache = new Map<string, HubVerifyCacheEntry>();
  const metrics: HubVerifyCacheMetrics = {
    hits: 0,
    misses: 0,
    evictions: 0,
    verifyLatencyMs: [],
  };

  // Periodic cleanup of expired entries (every 60 seconds)
  let cleanupTimer: NodeJS.Timeout | undefined;
  if (config.enabled) {
    cleanupTimer = setInterval(() => {
      const now = Date.now();
      let evicted = 0;
      for (const [key, entry] of cache.entries()) {
        if (entry.expiresAt <= now) {
          cache.delete(key);
          evicted++;
        }
      }
      if (evicted > 0) {
        metrics.evictions += evicted;
        logCacheEvent("sweep", { evicted, cacheSize: cache.size });
      }
    }, 60_000);
    // Don't prevent process exit
    cleanupTimer.unref();
  }

  /**
   * Hash the access token to create a cache key.
   * Uses SHA-256 to avoid storing tokens in memory.
   */
  function hashToken(accessToken: string): string {
    return createHash("sha256").update(accessToken).digest("hex");
  }

  /**
   * Get a cached verification result if still valid.
   * 
   * @param tokenHash - Hash of the access token
   * @param tokenExpiresAt - Token expiry timestamp (ms since epoch)
   * @returns true if cached and valid, false otherwise
   */
  function get(tokenHash: string, tokenExpiresAt: number): boolean {
    if (!config.enabled) return false;

    const entry = cache.get(tokenHash);
    const now = Date.now();

    // Cache miss: entry doesn't exist
    if (!entry) {
      metrics.misses++;
      return false;
    }

    // Evict if expired (either TTL expired or token expired)
    if (entry.expiresAt <= now || entry.tokenExpiresAt <= now) {
      cache.delete(tokenHash);
      metrics.evictions++;
      metrics.misses++;
      logCacheEvent("evict", { reason: "expired", tokenHash: tokenHash.slice(0, 8) });
      return false;
    }

    // Evict if token expiry changed (token was refreshed/rotated)
    if (entry.tokenExpiresAt !== tokenExpiresAt) {
      cache.delete(tokenHash);
      metrics.evictions++;
      metrics.misses++;
      logCacheEvent("evict", { reason: "token-changed", tokenHash: tokenHash.slice(0, 8) });
      return false;
    }

    // Cache hit
    metrics.hits++;
    return true;
  }

  /**
   * Cache a successful verification result.
   * 
   * @param tokenHash - Hash of the access token
   * @param tokenExpiresAt - Token expiry timestamp (ms since epoch)
   */
  function set(tokenHash: string, tokenExpiresAt: number): void {
    if (!config.enabled) return;

    const now = Date.now();
    const ttlExpiry = now + config.ttlMs;
    const expiresAt = Math.min(ttlExpiry, tokenExpiresAt);

    // Don't cache if token is already expired or expiring within 1 second
    if (expiresAt <= now + 1000) {
      return;
    }

    cache.set(tokenHash, { expiresAt, tokenExpiresAt });
  }

  /**
   * Invalidate all cached entries (e.g., on logout or explicit cache clear).
   */
  function invalidateAll(): void {
    const size = cache.size;
    cache.clear();
    if (size > 0) {
      logCacheEvent("invalidate-all", { evicted: size });
    }
  }

  /**
   * Invalidate a specific token's cache entry.
   */
  function invalidate(tokenHash: string): void {
    if (cache.delete(tokenHash)) {
      metrics.evictions++;
      logCacheEvent("invalidate", { tokenHash: tokenHash.slice(0, 8) });
    }
  }

  /**
   * Record a Hub verify latency measurement for observability.
   */
  function recordVerifyLatency(latencyMs: number): void {
    metrics.verifyLatencyMs.push(latencyMs);
    // Keep only last 100 measurements to avoid unbounded memory growth
    if (metrics.verifyLatencyMs.length > 100) {
      metrics.verifyLatencyMs.shift();
    }
  }

  /**
   * Get current cache metrics (hits, misses, evictions, latencies).
   */
  function getMetrics(): Readonly<HubVerifyCacheMetrics> & { cacheSize: number } {
    return {
      ...metrics,
      cacheSize: cache.size,
    };
  }

  /**
   * Destroy the cache and stop background cleanup.
   */
  function destroy(): void {
    if (cleanupTimer) {
      clearInterval(cleanupTimer);
      cleanupTimer = undefined;
    }
    cache.clear();
  }

  return {
    hashToken,
    get,
    set,
    invalidate,
    invalidateAll,
    recordVerifyLatency,
    getMetrics,
    destroy,
  };
}

export type HubVerifyCache = ReturnType<typeof createHubVerifyCache>;

/**
 * Log cache events for observability.
 * Uses console.warn for cache-related events so they're visible in production logs.
 */
function logCacheEvent(event: string, details: Record<string, unknown>): void {
  console.warn(
    `[hub-verify-cache] ${event}:`,
    JSON.stringify(details, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value,
    ),
  );
}

/**
 * Log cache metrics summary (call periodically for observability).
 */
export function logCacheMetrics(cache: HubVerifyCache): void {
  const metrics = cache.getMetrics();
  const hitRate =
    metrics.hits + metrics.misses > 0
      ? ((metrics.hits / (metrics.hits + metrics.misses)) * 100).toFixed(1)
      : "N/A";

  const latencies = metrics.verifyLatencyMs;
  const latencyStats =
    latencies.length > 0
      ? {
          p50: percentile(latencies, 0.5).toFixed(0),
          p95: percentile(latencies, 0.95).toFixed(0),
          count: latencies.length,
        }
      : null;

  console.warn(
    `[hub-verify-cache] metrics:`,
    JSON.stringify({
      hits: metrics.hits,
      misses: metrics.misses,
      evictions: metrics.evictions,
      hitRate: `${hitRate}%`,
      cacheSize: metrics.cacheSize,
      verifyLatency: latencyStats,
    }),
  );
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil(sorted.length * p) - 1;
  return sorted[Math.max(0, index)]!;
}
