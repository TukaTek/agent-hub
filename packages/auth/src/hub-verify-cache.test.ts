import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHubVerifyCache } from "./hub-verify-cache.js";

describe("Hub verification cache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("basic cache operations", () => {
    it("returns cache miss for non-existent token", () => {
      const cache = createHubVerifyCache({ ttlMs: 30_000, enabled: true });
      const tokenHash = cache.hashToken("test-token");
      const tokenExpiresAt = Date.now() + 60_000;

      expect(cache.get(tokenHash, tokenExpiresAt)).toBe(false);
      expect(cache.getMetrics().misses).toBe(1);
      expect(cache.getMetrics().hits).toBe(0);

      cache.destroy();
    });

    it("returns cache hit for valid cached token", () => {
      const cache = createHubVerifyCache({ ttlMs: 30_000, enabled: true });
      const tokenHash = cache.hashToken("test-token");
      const tokenExpiresAt = Date.now() + 60_000;

      cache.set(tokenHash, tokenExpiresAt);
      expect(cache.get(tokenHash, tokenExpiresAt)).toBe(true);
      expect(cache.getMetrics().hits).toBe(1);
      expect(cache.getMetrics().misses).toBe(0);

      cache.destroy();
    });

    it("hashes tokens consistently", () => {
      const cache = createHubVerifyCache({ ttlMs: 30_000, enabled: true });
      const hash1 = cache.hashToken("test-token");
      const hash2 = cache.hashToken("test-token");
      const hash3 = cache.hashToken("different-token");

      expect(hash1).toBe(hash2);
      expect(hash1).not.toBe(hash3);
      expect(hash1).toHaveLength(64); // SHA-256 hex digest

      cache.destroy();
    });
  });

  describe("TTL expiry", () => {
    it("evicts entry after TTL expires", () => {
      const cache = createHubVerifyCache({ ttlMs: 30_000, enabled: true });
      const tokenHash = cache.hashToken("test-token");
      const tokenExpiresAt = Date.now() + 120_000;

      cache.set(tokenHash, tokenExpiresAt);
      expect(cache.get(tokenHash, tokenExpiresAt)).toBe(true);

      // Advance time past TTL but before token expiry
      vi.advanceTimersByTime(31_000);

      expect(cache.get(tokenHash, tokenExpiresAt)).toBe(false);
      expect(cache.getMetrics().evictions).toBe(1);

      cache.destroy();
    });

    it("respects min of TTL and token expiry", () => {
      const cache = createHubVerifyCache({ ttlMs: 30_000, enabled: true });
      const tokenHash = cache.hashToken("test-token");
      const now = Date.now();
      const tokenExpiresAt = now + 10_000; // Token expires before TTL

      cache.set(tokenHash, tokenExpiresAt);
      expect(cache.get(tokenHash, tokenExpiresAt)).toBe(true);

      // Advance time past token expiry but before TTL
      vi.advanceTimersByTime(11_000);

      expect(cache.get(tokenHash, tokenExpiresAt)).toBe(false);
      expect(cache.getMetrics().evictions).toBe(1);

      cache.destroy();
    });

    it("does not cache tokens expiring within 1 second", () => {
      const cache = createHubVerifyCache({ ttlMs: 30_000, enabled: true });
      const tokenHash = cache.hashToken("test-token");
      const tokenExpiresAt = Date.now() + 500; // Expires in 500ms

      cache.set(tokenHash, tokenExpiresAt);
      expect(cache.get(tokenHash, tokenExpiresAt)).toBe(false);
      expect(cache.getMetrics().cacheSize).toBe(0);

      cache.destroy();
    });
  });

  describe("token changes", () => {
    it("evicts entry when token expiry changes", () => {
      const cache = createHubVerifyCache({ ttlMs: 30_000, enabled: true });
      const tokenHash = cache.hashToken("test-token");
      const originalExpiresAt = Date.now() + 60_000;

      cache.set(tokenHash, originalExpiresAt);
      expect(cache.get(tokenHash, originalExpiresAt)).toBe(true);

      // Same token hash but different expiry (token was refreshed)
      const newExpiresAt = Date.now() + 120_000;
      expect(cache.get(tokenHash, newExpiresAt)).toBe(false);
      expect(cache.getMetrics().evictions).toBe(1);

      cache.destroy();
    });

    it("does not reuse cached entry for different tokens", () => {
      const cache = createHubVerifyCache({ ttlMs: 30_000, enabled: true });
      const token1Hash = cache.hashToken("token-1");
      const token2Hash = cache.hashToken("token-2");
      const tokenExpiresAt = Date.now() + 60_000;

      cache.set(token1Hash, tokenExpiresAt);
      expect(cache.get(token1Hash, tokenExpiresAt)).toBe(true);
      expect(cache.get(token2Hash, tokenExpiresAt)).toBe(false);

      cache.destroy();
    });

    it("allows explicit invalidation of specific token", () => {
      const cache = createHubVerifyCache({ ttlMs: 30_000, enabled: true });
      const tokenHash = cache.hashToken("test-token");
      const tokenExpiresAt = Date.now() + 60_000;

      cache.set(tokenHash, tokenExpiresAt);
      expect(cache.get(tokenHash, tokenExpiresAt)).toBe(true);

      cache.invalidate(tokenHash);
      expect(cache.get(tokenHash, tokenExpiresAt)).toBe(false);
      expect(cache.getMetrics().evictions).toBe(1);

      cache.destroy();
    });

    it("allows invalidating all entries", () => {
      const cache = createHubVerifyCache({ ttlMs: 30_000, enabled: true });
      const tokenExpiresAt = Date.now() + 60_000;

      for (let i = 0; i < 5; i++) {
        cache.set(cache.hashToken(`token-${i}`), tokenExpiresAt);
      }
      expect(cache.getMetrics().cacheSize).toBe(5);

      cache.invalidateAll();
      expect(cache.getMetrics().cacheSize).toBe(0);

      cache.destroy();
    });
  });

  describe("cache disabled", () => {
    it("never caches when disabled", () => {
      const cache = createHubVerifyCache({ ttlMs: 30_000, enabled: false });
      const tokenHash = cache.hashToken("test-token");
      const tokenExpiresAt = Date.now() + 60_000;

      cache.set(tokenHash, tokenExpiresAt);
      expect(cache.get(tokenHash, tokenExpiresAt)).toBe(false);
      expect(cache.getMetrics().cacheSize).toBe(0);

      cache.destroy();
    });
  });

  describe("metrics", () => {
    it("tracks hits, misses, and evictions", () => {
      const cache = createHubVerifyCache({ ttlMs: 30_000, enabled: true });
      const token1Hash = cache.hashToken("token-1");
      const token2Hash = cache.hashToken("token-2");
      const tokenExpiresAt = Date.now() + 60_000;

      // Miss
      cache.get(token1Hash, tokenExpiresAt);
      expect(cache.getMetrics()).toMatchObject({
        hits: 0,
        misses: 1,
        evictions: 0,
      });

      // Set and hit
      cache.set(token1Hash, tokenExpiresAt);
      cache.get(token1Hash, tokenExpiresAt);
      expect(cache.getMetrics()).toMatchObject({
        hits: 1,
        misses: 1,
        evictions: 0,
      });

      // Another hit
      cache.get(token1Hash, tokenExpiresAt);
      expect(cache.getMetrics()).toMatchObject({
        hits: 2,
        misses: 1,
        evictions: 0,
      });

      // Miss on different token
      cache.get(token2Hash, tokenExpiresAt);
      expect(cache.getMetrics()).toMatchObject({
        hits: 2,
        misses: 2,
        evictions: 0,
      });

      // Evict via TTL expiry
      vi.advanceTimersByTime(31_000);
      cache.get(token1Hash, tokenExpiresAt);
      expect(cache.getMetrics()).toMatchObject({
        hits: 2,
        misses: 3,
        evictions: 1,
      });

      cache.destroy();
    });

    it("records verify latency", () => {
      const cache = createHubVerifyCache({ ttlMs: 30_000, enabled: true });

      cache.recordVerifyLatency(100);
      cache.recordVerifyLatency(200);
      cache.recordVerifyLatency(150);

      const metrics = cache.getMetrics();
      expect(metrics.verifyLatencyMs).toEqual([100, 200, 150]);

      cache.destroy();
    });

    it("limits latency buffer to 100 entries", () => {
      const cache = createHubVerifyCache({ ttlMs: 30_000, enabled: true });

      for (let i = 0; i < 150; i++) {
        cache.recordVerifyLatency(i);
      }

      const metrics = cache.getMetrics();
      expect(metrics.verifyLatencyMs).toHaveLength(100);
      expect(metrics.verifyLatencyMs[0]).toBe(50); // First 50 were removed

      cache.destroy();
    });
  });

  describe("periodic cleanup", () => {
    it("sweeps expired entries every 60 seconds", () => {
      const cache = createHubVerifyCache({ ttlMs: 30_000, enabled: true });
      const tokenExpiresAt = Date.now() + 60_000;

      // Add multiple entries
      for (let i = 0; i < 5; i++) {
        cache.set(cache.hashToken(`token-${i}`), tokenExpiresAt);
      }
      expect(cache.getMetrics().cacheSize).toBe(5);

      // Advance past TTL
      vi.advanceTimersByTime(31_000);

      // Trigger periodic cleanup
      vi.advanceTimersByTime(60_000);

      expect(cache.getMetrics().cacheSize).toBe(0);
      expect(cache.getMetrics().evictions).toBe(5);

      cache.destroy();
    });

    it("stops cleanup timer on destroy", () => {
      const cache = createHubVerifyCache({ ttlMs: 30_000, enabled: true });
      const tokenExpiresAt = Date.now() + 60_000;

      cache.set(cache.hashToken("token-1"), tokenExpiresAt);
      cache.destroy();

      // Advance past TTL and cleanup interval
      vi.advanceTimersByTime(100_000);

      // Cache should be empty because destroy() cleared it
      expect(cache.getMetrics().cacheSize).toBe(0);
    });
  });

  describe("fail-closed semantics", () => {
    it("only caches successful verifications (implicit)", () => {
      // This test documents that the cache only stores successes.
      // Failures are never passed to cache.set(), so they're never cached.
      const cache = createHubVerifyCache({ ttlMs: 30_000, enabled: true });
      const tokenHash = cache.hashToken("failed-token");
      const tokenExpiresAt = Date.now() + 60_000;

      // Simulate: verify failed, so we don't call cache.set()
      // Next request should miss and re-verify
      expect(cache.get(tokenHash, tokenExpiresAt)).toBe(false);
      expect(cache.getMetrics().misses).toBe(1);

      cache.destroy();
    });

    it("re-verifies after cache expiry", () => {
      const cache = createHubVerifyCache({ ttlMs: 10_000, enabled: true });
      const tokenHash = cache.hashToken("test-token");
      const tokenExpiresAt = Date.now() + 60_000;

      cache.set(tokenHash, tokenExpiresAt);
      expect(cache.get(tokenHash, tokenExpiresAt)).toBe(true);

      // Advance past TTL - should require re-verification
      vi.advanceTimersByTime(11_000);
      expect(cache.get(tokenHash, tokenExpiresAt)).toBe(false);

      cache.destroy();
    });
  });

  describe("Hub client integration contract", () => {
    it("prevents caching expired tokens", () => {
      const cache = createHubVerifyCache({ ttlMs: 30_000, enabled: true });
      const tokenHash = cache.hashToken("expired-token");
      const tokenExpiresAt = Date.now() - 1000; // Already expired

      cache.set(tokenHash, tokenExpiresAt);
      expect(cache.get(tokenHash, tokenExpiresAt)).toBe(false);
      expect(cache.getMetrics().cacheSize).toBe(0);

      cache.destroy();
    });

    it("evicts on token refresh (expiry changes)", () => {
      const cache = createHubVerifyCache({ ttlMs: 30_000, enabled: true });
      const oldTokenHash = cache.hashToken("old-access-token");
      const oldExpiresAt = Date.now() + 30_000;

      cache.set(oldTokenHash, oldExpiresAt);

      // Simulate token refresh: new token with new expiry
      const newTokenHash = cache.hashToken("new-access-token");
      const newExpiresAt = Date.now() + 60_000;

      // Old token should still hit if checked with old expiry
      expect(cache.get(oldTokenHash, oldExpiresAt)).toBe(true);

      // But new token is a miss
      expect(cache.get(newTokenHash, newExpiresAt)).toBe(false);

      // After explicit invalidation of old token
      cache.invalidate(oldTokenHash);
      expect(cache.get(oldTokenHash, oldExpiresAt)).toBe(false);

      cache.destroy();
    });
  });

  describe("environment configuration", () => {
    it("respects custom TTL", () => {
      const cache = createHubVerifyCache({ ttlMs: 5_000, enabled: true });
      const tokenHash = cache.hashToken("test-token");
      const tokenExpiresAt = Date.now() + 60_000;

      cache.set(tokenHash, tokenExpiresAt);
      expect(cache.get(tokenHash, tokenExpiresAt)).toBe(true);

      vi.advanceTimersByTime(6_000);
      expect(cache.get(tokenHash, tokenExpiresAt)).toBe(false);

      cache.destroy();
    });

    it("allows zero TTL (cache immediately expires)", () => {
      const cache = createHubVerifyCache({ ttlMs: 0, enabled: true });
      const tokenHash = cache.hashToken("test-token");
      const tokenExpiresAt = Date.now() + 60_000;

      cache.set(tokenHash, tokenExpiresAt);

      // Even with zero TTL, entry should exist momentarily
      expect(cache.get(tokenHash, tokenExpiresAt)).toBe(true);

      // But expire immediately on next tick
      vi.advanceTimersByTime(1);
      expect(cache.get(tokenHash, tokenExpiresAt)).toBe(false);

      cache.destroy();
    });
  });
});
