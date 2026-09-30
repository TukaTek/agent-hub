import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BotSecretDestination } from "@cortexai-agent-hub/contracts";
import {
  botSecretDestinationSchema,
  decodeLoginSecret,
  isPrivateNetworkHost,
  SecretHttpRequest,
} from "@cortexai-agent-hub/contracts";
import type { Prisma, PrismaClient } from "@cortexai-agent-hub/db";

import { combineSignals, redactConnectorPayload } from "./connector-safety.js";
import type { RemoteTransportDependencies } from "./remote-mcp.js";
import { createPrivateNetworkFetch, createSafeRemoteFetch } from "./remote-mcp.js";
import type { EncryptedSecretStore } from "./secrets.js";
import { readBodyCapped, withAbort } from "./web-ssrf.js";

export type BotSecretScope = { userId: string; spaceId: string; botId: string };
function scopeFields({ userId, spaceId, botId }: BotSecretScope): BotSecretScope {
  return { userId, spaceId, botId };
}

function getFileDownloadCap(): number {
  const env = process.env.CORTEXAI_AGENT_HUB_SECRET_REQUEST_FILE_CAP_BYTES;
  if (!env) return 25 * 1024 * 1024;
  const parsed = parseInt(env, 10);
  return parsed > 0 ? parsed : 25 * 1024 * 1024;
}

const TEXT_BODY_CAP = 1_000_000;

function isTextOrJsonContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const lower = contentType.toLowerCase();
  return (
    lower.includes("text/") ||
    lower.includes("application/json") ||
    lower.includes("application/javascript") ||
    lower.includes("+json")
  );
}

function sanitizeFilename(disposition: string | null, url: string): string {
  if (disposition) {
    const match = /filename\*?=["']?([^"';]+)["']?/i.exec(disposition);
    if (match) {
      const name = match[1]!.trim();
      if (name && !/[/\\]/.test(name)) return name;
    }
  }
  try {
    const path = new URL(url).pathname;
    const lastSegment = path.split("/").filter(Boolean).pop();
    if (lastSegment && !/[/\\]/.test(lastSegment)) return lastSegment;
  } catch {
    /* Fall through */
  }
  return `download-${Date.now()}`;
}

const metadata = { name: true, origin: true, auth: true } as const;

function credentialHeader(destination: BotSecretDestination, plaintext: string) {
  if (destination.auth.type === "login") {
    throw new Error("Credential cannot be used with this authentication method");
  }
  const name = destination.auth.type === "header" ? destination.auth.name : "Authorization";
  const value =
    destination.auth.type === "bearer"
      ? `Bearer ${plaintext}`
      : destination.auth.type === "basic"
        ? `Basic ${Buffer.from(`${destination.auth.username}:${plaintext}`).toString("base64")}`
        : plaintext;
  try {
    const headers = new Headers({ [name]: value });
    if (headers.get(name) !== value) throw new Error("Header value was normalized");
  } catch {
    throw new Error("Credential cannot be used with this authentication method");
  }
  return { name, value };
}

/** Owner escape enabling plain-HTTP origins on private LAN hosts (see #907). */
export function allowPrivateHttpSecretOrigins(): boolean {
  return process.env.CORTEXAI_AGENT_HUB_SECRETS_ALLOW_PRIVATE_HTTP === "1";
}

export function normalizeSecretDestination(value: unknown): BotSecretDestination {
  const parsed = botSecretDestinationSchema({
    allowPrivateHttpOrigin: allowPrivateHttpSecretOrigins(),
  }).safeParse(value);
  if (!parsed.success) {
    // Surface the actual failing field: models (and people) supply all three
    // parts and still fail on a name character or an origin rule, and a
    // generic "specify name, origin, auth" error sends them retrying blind.
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "credential"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid credential destination — ${detail}`);
  }
  return { ...parsed.data, origin: new URL(parsed.data.origin).origin };
}

export function sameSecretDestination(
  left: BotSecretDestination,
  right: BotSecretDestination,
): boolean {
  return (
    left.name === right.name &&
    left.origin === right.origin &&
    JSON.stringify(left.auth) === JSON.stringify(right.auth)
  );
}

export async function findBotSecret(prisma: PrismaClient, scope: BotSecretScope, name: string) {
  const row = await prisma.botSecret.findFirst({
    where: { ...scopeFields(scope), name },
    select: metadata,
  });
  return row ? normalizeSecretDestination(row) : null;
}

export async function storeBotSecret(input: {
  tx: Prisma.TransactionClient;
  secretStore: EncryptedSecretStore;
  scope: BotSecretScope;
  destination: BotSecretDestination;
  plaintext: string;
}): Promise<void> {
  const { tx, secretStore, scope, plaintext } = input;
  if (!plaintext || plaintext.length > 16_384) throw new Error("Invalid credential length");
  const destination = normalizeSecretDestination(input.destination);
  if (destination.auth.type === "login") decodeLoginSecret(plaintext);
  else credentialHeader(destination, plaintext);
  // Serialize credential updates and deletions for a bot, including concurrent first saves.
  await tx.$queryRaw`SELECT id FROM bots WHERE id = ${scope.botId} FOR UPDATE`;
  const existing = await tx.botSecret.findFirst({
    where: { ...scopeFields(scope), name: destination.name },
  });
  if (existing && !sameSecretDestination(normalizeSecretDestination(existing), destination)) {
    throw new Error("Remove the existing credential before changing its destination");
  }
  if (!existing && (await tx.botSecret.count({ where: scopeFields(scope) })) >= 100) {
    throw new Error("Credential limit reached");
  }
  const id = existing?.id ?? randomBytes(12).toString("hex");
  const encrypted = await secretStore.put(
    plaintext,
    {
      operationId: id,
      traceId: id,
      userId: scope.userId,
      spaceId: scope.spaceId,
      signal: new AbortController().signal,
    },
    id,
  );
  if (existing) {
    await tx.botSecret.update({ where: { id }, data: { ciphertext: encrypted.ciphertext } });
  } else {
    await tx.botSecret.create({
      data: { id, ...scopeFields(scope), ...destination, ciphertext: encrypted.ciphertext },
    });
  }
}

export function listBotSecrets(prisma: PrismaClient, scope: BotSecretScope) {
  return prisma.botSecret.findMany({
    where: scopeFields(scope),
    select: metadata,
    orderBy: { name: "asc" },
    take: 100,
  });
}

export async function forgetBotSecret(prisma: PrismaClient, scope: BotSecretScope, name: string) {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM bots WHERE id = ${scope.botId} FOR UPDATE`;
    await tx.botSecret.deleteMany({ where: { ...scopeFields(scope), name } });
  });
  return { removed: true };
}

/** Credentials are resolved only inside this destination-bound HTTP boundary. */
export async function requestWithBotSecret(input: {
  prisma: PrismaClient;
  secretStore: EncryptedSecretStore;
  scope: BotSecretScope;
  request: unknown;
  signal: AbortSignal;
  remote?: RemoteTransportDependencies;
  registerRedactions?: (values: string[]) => void;
  downloadsDir?: string;
}): Promise<unknown> {
  const request = SecretHttpRequest.parse(input.request);
  const row = await input.prisma.botSecret.findFirst({
    where: { ...scopeFields(input.scope), name: request.name },
  });
  if (!row) return { error: "Credential is unavailable. Use request_secret to save it first." };
  const destination = normalizeSecretDestination(row);
  if (destination.auth.type === "login") {
    return { error: "Website logins can only be filled into their site with browser_act." };
  }
  const url = new URL(request.url);
  if (url.origin !== destination.origin || url.username || url.password || url.hash) {
    return { error: "This credential cannot be sent to that destination." };
  }
  const plaintext = input.secretStore.load(row.ciphertext, row.id);
  const headers = new Headers({ accept: "application/json", "content-type": request.contentType });
  const { name: headerName, value: headerValue } = credentialHeader(destination, plaintext);
  const redactions = [
    ...new Set([
      plaintext,
      headerValue,
      Buffer.from(plaintext).toString("base64"),
      encodeURIComponent(plaintext),
      headerValue.replace(/^Basic /, ""),
    ]),
  ].filter(Boolean);
  input.registerRedactions?.(redactions);
  const controller = new AbortController();
  const signal = combineSignals(input.signal, controller.signal, AbortSignal.timeout(30_000));
  // The safe fetch refuses plain-HTTP and private hosts outright. A credential
  // saved under the owner's private-HTTP opt-in was validated against exactly
  // those rules at save time, and the request URL is pinned to its origin, so
  // deliver it through the inverted transport instead — it re-checks that every
  // resolved address is private (metadata endpoints stay blocked) and pins the
  // connection to the validated answer.
  const privateHttpDestination =
    allowPrivateHttpSecretOrigins() &&
    url.protocol === "http:" &&
    isPrivateNetworkHost(url.hostname);
  const fetch = privateHttpDestination
    ? createPrivateNetworkFetch(input.remote?.fetch, input.remote?.resolveHostname)
    : createSafeRemoteFetch(input.remote?.fetch, input.remote?.resolveHostname);
  try {
    headers.set(headerName, headerValue);
    const response = await withAbort(
      fetch(url, {
        method: request.method,
        headers,
        body: request.body,
        redirect: "manual",
        signal,
      }),
      signal,
    );

    if (!response.ok) {
      const snippet = await readBodySnippet(response, signal, redactions);
      return {
        error: `Request failed with HTTP ${response.status}${snippet ? `: ${snippet}` : ""}.`,
      };
    }

    if (response.status >= 300 && response.status < 400) {
      return { error: "Redirects are not followed for authenticated requests." };
    }

    const contentType = response.headers.get("content-type");
    const contentLength = response.headers.get("content-length");
    const declaredSize = contentLength ? parseInt(contentLength, 10) : undefined;

    // Binary/file mode: non-text/JSON content types
    if (!isTextOrJsonContentType(contentType)) {
      const fileCap = getFileDownloadCap();
      if (declaredSize !== undefined && declaredSize > fileCap) {
        return {
          error: `Response size ${declaredSize} bytes exceeds the ${fileCap} byte file download limit.`,
        };
      }

      if (!input.downloadsDir) {
        return {
          error:
            "File downloads require a bot workspace. Use text/JSON endpoints or request support.",
        };
      }

      return await downloadToFile(
        response,
        url.href,
        contentType,
        fileCap,
        input.downloadsDir,
        signal,
        redactions,
      );
    }

    // Text/JSON mode
    if (declaredSize !== undefined && declaredSize > TEXT_BODY_CAP) {
      return {
        error: `Response size ${declaredSize} bytes exceeds the ${TEXT_BODY_CAP} byte text body limit.`,
      };
    }

    const bytes = await readBodyCapped(response, TEXT_BODY_CAP, signal);
    const text = new TextDecoder().decode(bytes);
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* Plain text responses are supported. */
    }
    // Redact before truncating, so an output boundary cannot expose part of a value.
    const safe = JSON.stringify(redactConnectorPayload(body, redactions));
    return {
      status: response.status,
      body: safe.length > 20_000 ? safe.slice(0, 20_000) : JSON.parse(safe),
      truncated: safe.length > 20_000,
    };
  } catch (error) {
    if (signal.aborted) {
      return { error: "Request timed out after 30 seconds." };
    }
    if (error instanceof Error) {
      if (error.message.includes("Response is too large")) {
        return {
          error: `Response body exceeds the ${TEXT_BODY_CAP} byte limit. Use a streaming endpoint or request file mode support.`,
        };
      }
      if (
        error.message.includes("private") ||
        error.message.includes("internal") ||
        error.message.includes("blocked")
      ) {
        return { error: "Destination is blocked by network policy (private or internal host)." };
      }
      if (error.message.includes("ENOTFOUND") || error.message.includes("EAI_AGAIN")) {
        return { error: "DNS resolution failed. Check the destination hostname." };
      }
      if (
        error.message.includes("ECONNREFUSED") ||
        error.message.includes("ETIMEDOUT") ||
        error.message.includes("ECONNRESET")
      ) {
        return { error: `Network error: ${error.message}` };
      }
    }
    return { error: "Authenticated request failed. Check the destination and credential." };
  } finally {
    controller.abort();
    await withAbort(fetch.close(), AbortSignal.timeout(1000)).catch(() => undefined);
  }
}

async function readBodySnippet(
  response: Response,
  signal?: AbortSignal,
  redactions?: string[],
): Promise<string> {
  try {
    const bytes = await readBodyCapped(response, 200, signal);
    let snippet = new TextDecoder().decode(bytes).trim();
    if (redactions) {
      for (const value of redactions) {
        snippet = snippet.replaceAll(value, "[REDACTED]");
      }
    }
    return snippet;
  } catch {
    return "";
  }
}

async function downloadToFile(
  response: Response,
  url: string,
  contentType: string | null,
  maxBytes: number,
  downloadsDir: string,
  signal: AbortSignal,
  redactions: string[],
): Promise<unknown> {
  const filename = sanitizeFilename(response.headers.get("content-disposition"), url);
  const tempPath = join(downloadsDir, `.${filename}.tmp.${randomBytes(8).toString("hex")}`);
  const finalPath = join(downloadsDir, filename);

  await mkdir(downloadsDir, { recursive: true });

  const hash = createHash("sha256");
  let bytesWritten = 0;

  try {
    const writeStream = createWriteStream(tempPath);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Response body is not readable");

    try {
      while (true) {
        if (signal.aborted) throw new Error("Download aborted");
        const { done, value } = await reader.read();
        if (done) break;

        bytesWritten += value.length;
        if (bytesWritten > maxBytes) {
          throw new Error(
            `Response size exceeds the ${maxBytes} byte file download limit (received ${bytesWritten} bytes so far).`,
          );
        }

        hash.update(value);
        writeStream.write(value);
      }

      writeStream.end();
      await new Promise<void>((resolve, reject) => {
        writeStream.on("finish", () => resolve());
        writeStream.on("error", reject);
      });
    } finally {
      reader.releaseLock();
    }

    await mkdir(dirname(finalPath), { recursive: true });
    try {
      await unlink(finalPath);
    } catch {
      /* OK if it doesn't exist */
    }

    const { rename } = await import("node:fs/promises");
    await rename(tempPath, finalPath);

    return {
      file: {
        path: finalPath,
        size: bytesWritten,
        contentType: contentType || "application/octet-stream",
        sha256: hash.digest("hex"),
        filename,
      },
    };
  } catch (error) {
    try {
      await unlink(tempPath);
    } catch {
      /* Cleanup best-effort */
    }
    if (error instanceof Error && error.message.includes("exceeds the")) {
      // Redact any secret values that might be in the error message
      let message = error.message;
      for (const value of redactions) {
        message = message.replaceAll(value, "[REDACTED]");
      }
      return { error: message };
    }
    throw error;
  }
}

export type LoginField = "username" | "password";
const MIN_REDACTED_USERNAME = 6;

/**
 * Resolve one field of a saved website login for a page fill. The caller must pass `origin` to
 * the page browser, which refuses to fill unless the page is still on that origin.
 */
export async function resolveLoginFill(input: {
  prisma: PrismaClient;
  secretStore: EncryptedSecretStore;
  scope: BotSecretScope;
  name: string;
  field: LoginField;
}): Promise<{ text: string; origin: string; redactions: string[] } | { error: string }> {
  const row = await input.prisma.botSecret.findFirst({
    where: { ...scopeFields(input.scope), name: input.name },
  });
  if (!row) return { error: "Login is unavailable. Use request_secret to save it first." };
  // Checked on the stored origin itself, so the private-LAN HTTP allowance cannot widen a login.
  let storedOrigin: URL;
  try {
    storedOrigin = new URL(row.origin);
  } catch {
    return { error: "Website logins can only be filled on an HTTPS origin." };
  }
  if (storedOrigin.protocol !== "https:") {
    return { error: "Website logins can only be filled on an HTTPS origin." };
  }
  const destination = normalizeSecretDestination(row);
  if (destination.auth.type !== "login") {
    return { error: "This credential is not a website login." };
  }
  if (destination.origin !== storedOrigin.origin) {
    return { error: "Website logins can only be filled on an HTTPS origin." };
  }
  const login = decodeLoginSecret(input.secretStore.load(row.ciphertext, row.id));
  return {
    text: login[input.field],
    origin: destination.origin,
    // Redaction is substring replacement, so a short username would mangle unrelated text.
    redactions: [
      ...new Set(
        [login.password, encodeURIComponent(login.password)].concat(
          login.username.length >= MIN_REDACTED_USERNAME
            ? [login.username, encodeURIComponent(login.username)]
            : [],
        ),
      ),
    ],
  };
}
