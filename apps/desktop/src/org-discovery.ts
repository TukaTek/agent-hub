import { isIP } from "node:net";
import type { DesktopDiscoveryReply } from "@cortexai-agent-hub/contracts";
import {
  isLocalNetworkHost,
  isLoopbackHost,
  MANAGED_UNREACHABLE_MESSAGE,
  normalizeServerUrl,
  readProbeJson,
} from "./setup-config.js";

/** Hub org discovery (contract `agent-hub-discovery` v1, vendored in `fixtures/`). */
export const DISCOVERY_PATH = "/api/v1/agent-hub/discover";
export const DISCOVERY_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_AFTER_SECONDS = 60;
const MAX_RETRY_AFTER_SECONDS = 3600;
const MAX_EMAIL_LENGTH = 254;
const MAX_ORIGIN_LENGTH = 2048;

export type DiscoveryOutcome =
  | { kind: "found"; origin: string; method: string; loginHint: string | null }
  | { kind: "not_found" }
  | { kind: "unsupported_email" }
  | { kind: "invalid_email" }
  | { kind: "rate_limited"; retryAfterSeconds: number }
  | { kind: "unavailable" }
  /** Hub speaks a contract version this release does not; retrying cannot help. */
  | { kind: "update_required" };

export const DISCOVERY_MESSAGES = {
  // Identical for "no organization" and "no such user": Hub never says which.
  not_found: "We couldn't find an Agent Hub for that email. Check with your admin.",
  unsupported_email: "Use your work email address.",
  invalid_email: "Enter a valid email address.",
  // Discovery runs only in managed builds, which never show self-host wording.
  unavailable: MANAGED_UNREACHABLE_MESSAGE,
  update_required: "Please update the app.",
} as const;

/**
 * Asks the central Hub which Agent Hub serves `email`. Runs in main only; the
 * renderer never picks the URL. Never throws and never logs: the email and the
 * returned login hint are personal data.
 */
export async function discoverOrganization(
  email: unknown,
  options: { hubUrl: string | null; fetch?: typeof fetch; timeoutMs?: number },
): Promise<DiscoveryOutcome> {
  const address = typeof email === "string" ? email.trim() : "";
  if (!looksLikeEmail(address)) return { kind: "invalid_email" };
  if (options.hubUrl === null) return { kind: "unavailable" };

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException("Discovery timed out", "TimeoutError")),
    options.timeoutMs ?? DISCOVERY_TIMEOUT_MS,
  );
  try {
    const response = await (options.fetch ?? fetch)(new URL(DISCOVERY_PATH, options.hubUrl), {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ email: address, client: "desktop" }),
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    if (response.status === 429) {
      void response.body?.cancel().catch(() => undefined);
      return {
        kind: "rate_limited",
        retryAfterSeconds: retryAfterSeconds(response.headers.get("retry-after")),
      };
    }
    if (response.status === 400) {
      const body = await readProbeJson(response);
      return isRecord(body) && body.error === "invalid_request"
        ? { kind: "invalid_email" }
        : { kind: "unavailable" };
    }
    if (response.status !== 200) {
      void response.body?.cancel().catch(() => undefined);
      return { kind: "unavailable" };
    }
    return parseDiscoveryBody(await readProbeJson(response));
  } catch {
    return { kind: "unavailable" };
  } finally {
    clearTimeout(timer);
  }
}

function parseDiscoveryBody(body: unknown): DiscoveryOutcome {
  if (!isRecord(body)) return { kind: "unavailable" };
  if ("contractVersion" in body && body.contractVersion !== 1) return { kind: "update_required" };
  if (body.contractVersion !== 1 || typeof body.result !== "string") return { kind: "unavailable" };
  if (body.result === "unsupported_email") return { kind: "unsupported_email" };
  // Any result this release does not know is reported exactly like not_found.
  if (body.result !== "found") return { kind: "not_found" };

  const { tenant, agentHub, signIn } = body;
  if (
    !isRecord(tenant) ||
    typeof tenant.id !== "string" ||
    typeof tenant.slug !== "string" ||
    !isRecord(agentHub) ||
    typeof agentHub.deploymentId !== "string" ||
    !isRecord(signIn) ||
    typeof signIn.method !== "string" ||
    (signIn.loginHint != null && typeof signIn.loginHint !== "string")
  )
    return { kind: "unavailable" };
  const origin = validateDiscoveredOrigin(agentHub.origin);
  if (origin === null) return { kind: "unavailable" };
  const hint = typeof signIn.loginHint === "string" ? signIn.loginHint.trim() : "";
  return {
    kind: "found",
    origin,
    method: signIn.method,
    loginHint: looksLikeEmail(hint) ? hint : null,
  };
}

/** What the setup window is told: the outcome, never the email or hint. */
export function discoveryReply(outcome: DiscoveryOutcome): DesktopDiscoveryReply {
  switch (outcome.kind) {
    case "found":
      return { ok: true };
    case "not_found":
    case "unsupported_email":
    case "unavailable":
      return { ok: false, error: DISCOVERY_MESSAGES[outcome.kind] };
    case "update_required":
      return { ok: false, error: DISCOVERY_MESSAGES.update_required, terminal: true };
    case "invalid_email":
      return { ok: false, field: "email", error: DISCOVERY_MESSAGES.invalid_email };
    case "rate_limited":
      return {
        ok: false,
        error: `Too many attempts. Try again in ${outcome.retryAfterSeconds} seconds.`,
        retryAfterSeconds: outcome.retryAfterSeconds,
      };
  }
}

/**
 * The whole desktop discover-and-sign-in step behind the setup IPC: discover,
 * hand the login hint to the found origin, and open it. Never logs, and never
 * returns the email, the hint, or self-host failure details.
 */
export async function discoverAndOpen(
  email: unknown,
  options: {
    hubUrl: string | null;
    fetch?: typeof fetch;
    loginHints: ReturnType<typeof createLoginHintStore>;
    open: (origin: string) => Promise<{ ok: boolean; error?: string }>;
  },
): Promise<DesktopDiscoveryReply> {
  const outcome = await discoverOrganization(email, options);
  if (outcome.kind !== "found") return discoveryReply(outcome);
  // Set before opening: the sign-in page asks for it as soon as it loads.
  options.loginHints.set(outcome.origin, outcome.loginHint);
  let opened: { ok: boolean };
  try {
    opened = await options.open(outcome.origin);
  } catch {
    opened = { ok: false };
  }
  if (opened.ok) return { ok: true };
  options.loginHints.clear();
  return { ok: false, error: MANAGED_UNREACHABLE_MESSAGE };
}

/**
 * Hub tells the app which server to open and sign in to, so the answer must be
 * one canonical public HTTPS origin that round-trips through URL parsing
 * unchanged: no path, credentials, IP literal, private or loopback host.
 */
export function validateDiscoveredOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_ORIGIN_LENGTH) return null;
  // URL parsing silently drops tabs and newlines and treats `\` as `/`.
  if (/[\s\\]/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.origin !== value) return null;
  if (normalizeServerUrl(value) !== value) return null;
  const host = url.hostname;
  if (isIP(host.replace(/^\[|\]$/g, "")) !== 0) return null;
  if (isLoopbackHost(host) || isLocalNetworkHost(host)) return null;
  // A single label or a trailing dot is an intranet or ambiguous name.
  if (!host.includes(".") || host.endsWith(".")) return null;
  return value;
}

function retryAfterSeconds(header: string | null): number {
  const seconds = header !== null && /^\d+$/.test(header.trim()) ? Number(header.trim()) : NaN;
  if (!Number.isFinite(seconds)) return DEFAULT_RETRY_AFTER_SECONDS;
  return Math.min(Math.max(seconds, 1), MAX_RETRY_AFTER_SECONDS);
}

function looksLikeEmail(value: string): boolean {
  return value.length <= MAX_EMAIL_LENGTH && /^[^\s@]+@[^\s@]+$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Holds the hint from the last discovery for the sign-in page of that origin
 * only, in memory, handed out once and only within a few minutes.
 */
export const LOGIN_HINT_TTL_MS = 5 * 60_000;

export function createLoginHintStore(now: () => number = Date.now) {
  let pending: { origin: string; hint: string; expiresAt: number } | null = null;
  return {
    set(origin: string, hint: string | null) {
      pending = hint === null ? null : { origin, hint, expiresAt: now() + LOGIN_HINT_TTL_MS };
    },
    take(origin: string): string | null {
      if (pending !== null && now() >= pending.expiresAt) pending = null;
      if (pending === null || pending.origin !== origin) return null;
      const { hint } = pending;
      pending = null;
      return hint;
    },
    clear() {
      pending = null;
    },
  };
}
