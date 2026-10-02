import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { BotSecretDestination } from "@cortexai-agent-hub/contracts";
import {
  botSecretDestinationSchema,
  decodeLoginSecret,
  isPrivateNetworkHost,
  SecretHttpRequest,
} from "@cortexai-agent-hub/contracts";
import { attachmentExtensionForMimeType, inferAttachmentMimeType } from "@cortexai-agent-hub/core";
import type { Prisma, PrismaClient } from "@cortexai-agent-hub/db";
import { getLogger } from "@cortexai-agent-hub/logging";

import { combineSignals, redactConnectorPayload } from "./connector-safety.js";
import type { RemoteTransportDependencies } from "./remote-mcp.js";
import {
  createPrivateNetworkFetch,
  createSafeRemoteFetch,
  RemoteRedirectError,
} from "./remote-mcp.js";
import type { EncryptedSecretStore } from "./secrets.js";
import { readBodyCapped, withAbort } from "./web-ssrf.js";

export type BotSecretScope = { userId: string; spaceId: string; botId: string };
function scopeFields({ userId, spaceId, botId }: BotSecretScope): BotSecretScope {
  return { userId, spaceId, botId };
}

export function getFileDownloadCap(): number {
  const env = process.env.CORTEXAI_AGENT_HUB_SECRET_REQUEST_FILE_CAP_BYTES;
  if (!env) return 100 * 1024 * 1024;
  const parsed = parseInt(env, 10);
  return parsed > 0 ? parsed : 100 * 1024 * 1024;
}

function getRequestTimeoutMs(): number {
  const env = process.env.CORTEXAI_AGENT_HUB_SECRET_REQUEST_TIMEOUT_MS;
  if (!env) return 120_000; // 2 minutes default for 100 MB downloads
  const parsed = parseInt(env, 10);
  return parsed > 0 ? parsed : 120_000;
}

const TEXT_BODY_CAP = 1_000_000;

function isTextOrJsonContentType(contentType: string | null): boolean {
  // Untyped responses stay inline text, bounded by the text cap.
  if (!contentType) return true;
  const lower = contentType.toLowerCase();
  return (
    lower.includes("text/") ||
    lower.includes("application/json") ||
    lower.includes("application/javascript") ||
    lower.includes("+json")
  );
}

const UNSAFE_FILENAME_CHARACTERS = new Set(["/", "\\", ":", "|", "<", ">", "*", "?", '"', "'"]);

function safeFilename(raw: string, redact: (text: string) => string): string | undefined {
  let decoded = redact(raw);
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    /* Keep the raw name when it is not percent-encoded. */
  }
  // Redacted after decoding too, so an encoded credential never becomes a visible filename.
  const name = [...redact(decoded).trim()]
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code > 0x1f && code !== 0x7f && !UNSAFE_FILENAME_CHARACTERS.has(char);
    })
    .join("")
    .replace(/^\.+/, "");
  return name && name.length <= 255 ? name : undefined;
}

function sanitizeFilename(
  disposition: string | null,
  url: URL,
  contentType: string | null,
  redact: (text: string) => string,
): string {
  const fromDisposition =
    /filename\*\s*=\s*(?:[\w-]+'[^']*')?([^;]+)/i.exec(disposition ?? "")?.[1] ??
    /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i
      .exec(disposition ?? "")
      ?.slice(1)
      .find(Boolean);
  const fromUrl = redact(url.pathname).split("/").filter(Boolean).pop();
  const name =
    (fromDisposition && safeFilename(fromDisposition, redact)) ||
    (fromUrl && safeFilename(fromUrl, redact)) ||
    `download-${Date.now()}`;
  return withContentTypeExtension(name, contentType);
}

/** Extensionless endpoints like `/forms/<id>/pdf` get the extension attach_file recognizes. */
function withContentTypeExtension(name: string, contentType: string | null): string {
  const mimeType = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  const extension = attachmentExtensionForMimeType(mimeType);
  if (!extension || inferAttachmentMimeType(name) === mimeType) return name;
  return `${name.slice(0, 255 - extension.length)}${extension}`;
}

/** The saved name first, then timestamped variants, so a download never replaces a file. */
export function* downloadFilenameCandidates(filename: string): Generator<string> {
  yield filename;
  const dot = filename.lastIndexOf(".");
  const [base, ext] = dot > 0 ? [filename.slice(0, dot), filename.slice(dot)] : [filename, ""];
  const stamp = Date.now();
  yield `${base}-${stamp}${ext}`;
  for (let attempt = 2; attempt <= 20; attempt++) yield `${base}-${stamp}-${attempt}${ext}`;
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

// Owner-facing view: destination and timestamps only, never the row id or ciphertext.
const ownerMetadata = { ...metadata, createdAt: true, updatedAt: true } as const;

export function listBotSecretMetadata(prisma: PrismaClient, scope: BotSecretScope) {
  return prisma.botSecret.findMany({
    where: scopeFields(scope),
    select: ownerMetadata,
    orderBy: { name: "asc" },
    take: 100,
  });
}

export function getBotSecretMetadata(
  client: PrismaClient | Prisma.TransactionClient,
  scope: BotSecretScope,
  name: string,
) {
  return client.botSecret.findFirst({
    where: { ...scopeFields(scope), name },
    select: ownerMetadata,
  });
}

export async function forgetBotSecret(prisma: PrismaClient, scope: BotSecretScope, name: string) {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM bots WHERE id = ${scope.botId} FOR UPDATE`;
    await tx.botSecret.deleteMany({ where: { ...scopeFields(scope), name } });
  });
  return { removed: true };
}

/** Where a binary response is saved so the bot's file tools and computer can open it. */
export interface SecretDownloadTarget {
  /** Largest file this computer can receive. */
  maxBytes: number;
  /** Host directory the response streams into. */
  directory(): Promise<string>;
  /** Makes a finished file visible to the bot and returns its path relative to the bot home. */
  publish(hostPath: string, filename: string): Promise<string>;
}

/** A failure whose message is already safe and specific enough to show the bot. */
class SecretRequestFailure extends Error {}

/** Credentials are resolved only inside this destination-bound HTTP boundary. */
export async function requestWithBotSecret(input: {
  prisma: PrismaClient;
  secretStore: EncryptedSecretStore;
  scope: BotSecretScope;
  request: unknown;
  signal: AbortSignal;
  remote?: RemoteTransportDependencies;
  registerRedactions?: (values: string[]) => void;
  downloads?: SecretDownloadTarget;
}): Promise<unknown> {
  const parsed = SecretHttpRequest.safeParse(input.request);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`)
      .join("; ");
    return { error: `Invalid authenticated request — ${detail}` };
  }
  const request = parsed.data;
  if (!URL.canParse(request.url)) {
    return { error: "Invalid authenticated request — url: must be an absolute URL" };
  }
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
  const redact = (text: string) =>
    redactions.reduce((result, value) => result.replaceAll(value, "[REDACTED]"), text);
  const controller = new AbortController();
  const timeoutMs = getRequestTimeoutMs();
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = combineSignals(input.signal, controller.signal, timeout);
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

    const contentType = response.headers.get("content-type");
    const contentLength = response.headers.get("content-length");
    const declaredSize = contentLength ? parseInt(contentLength, 10) : undefined;

    // Binary/file mode: non-text/JSON content types
    if (!isTextOrJsonContentType(contentType)) {
      if (!input.downloads) {
        await response.body?.cancel().catch(() => undefined);
        return {
          error:
            "File downloads require a bot workspace. Use text/JSON endpoints or request support.",
        };
      }
      const fileCap = input.downloads.maxBytes;
      if (declaredSize !== undefined && declaredSize > fileCap) {
        await response.body?.cancel().catch(() => undefined);
        return {
          error: `Response size ${declaredSize} bytes exceeds the ${fileCap} byte file download limit for this computer.`,
        };
      }

      return await downloadToFile(response, {
        url,
        contentType,
        maxBytes: fileCap,
        target: input.downloads,
        signal,
        redact,
      });
    }

    // Text/JSON mode
    if (declaredSize !== undefined && declaredSize > TEXT_BODY_CAP) {
      await response.body?.cancel().catch(() => undefined);
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
    return {
      error: redact(secretRequestFailureMessage(error, url, timeout, input.signal, timeoutMs)),
    };
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

function secretRequestFailureMessage(
  error: unknown,
  url: URL,
  timeout: AbortSignal,
  cancel: AbortSignal,
  timeoutMs: number,
): string {
  if (timeout.aborted) {
    const seconds = Math.ceil(timeoutMs / 1000);
    return `Request timed out after ${seconds} second${seconds === 1 ? "" : "s"}.`;
  }
  if (cancel.aborted) return "Request was cancelled before it finished.";
  if (error instanceof RemoteRedirectError) {
    let target = "";
    if (error.location) {
      try {
        target = ` to ${new URL(error.location, url).hostname}`;
      } catch {
        target = " to an invalid location";
      }
    }
    return `Redirect not followed (HTTP ${error.status}${target}). Request the final URL directly.`;
  }
  if (error instanceof SecretRequestFailure) return error.message;
  const message = error instanceof Error ? error.message : "";
  const code = error instanceof Error && "code" in error ? String(error.code) : "";
  if (message === "Response is too large") {
    return `Response body exceeds the ${TEXT_BODY_CAP} byte text limit.`;
  }
  if (/private|must use HTTPS/i.test(message)) {
    return "Destination is blocked by network policy.";
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(`${code} ${message}`)) {
    return `DNS lookup failed for ${url.hostname}. Check the destination hostname.`;
  }
  if (message.startsWith("Could not reach")) return `Network error: ${message}.`;
  getLogger().error(`secret_request unexpected error: ${message || String(error)}`);
  return "Authenticated request failed. Check the destination and credential.";
}

async function downloadToFile(
  response: Response,
  {
    url,
    contentType,
    maxBytes,
    target,
    signal,
    redact,
  }: {
    url: URL;
    contentType: string | null;
    maxBytes: number;
    target: SecretDownloadTarget;
    signal: AbortSignal;
    redact: (text: string) => string;
  },
): Promise<unknown> {
  const directory = await target.directory().catch((error: unknown) => {
    getLogger().error("secret_request download directory", error);
    throw new SecretRequestFailure("Could not prepare the downloads folder in the bot workspace.");
  });
  const saveFailed = (error: unknown): never => {
    if (error instanceof SecretRequestFailure) throw error;
    getLogger().error("secret_request save download", error);
    throw new SecretRequestFailure("Could not save the downloaded file to the bot workspace.");
  };
  const temp = join(directory, `.${randomBytes(8).toString("hex")}.download`);
  const hash = createHash("sha256");
  let size = 0;
  try {
    const handle = await open(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o666,
    ).catch(saveFailed);
    try {
      const reader = response.body?.getReader();
      try {
        while (reader) {
          const { done, value } = await withAbort(reader.read(), signal).catch(() => {
            throw new SecretRequestFailure("Network error: the connection closed mid-download.");
          });
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) {
            throw new SecretRequestFailure(
              `Response exceeds the ${maxBytes} byte file download limit for this computer.`,
            );
          }
          hash.update(value);
          await handle.write(value).catch(saveFailed);
        }
      } finally {
        await reader?.cancel().catch(() => undefined);
      }
    } finally {
      await handle.close();
    }
    const filename = await linkWithoutReplacing(
      temp,
      directory,
      sanitizeFilename(response.headers.get("content-disposition"), url, contentType, redact),
    ).catch(saveFailed);
    const path = await target.publish(join(directory, filename), filename).catch(saveFailed);
    return {
      file: {
        path,
        filename: path.split("/").pop() ?? filename,
        size,
        contentType: contentType || "application/octet-stream",
        sha256: hash.digest("hex"),
      },
    };
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

async function linkWithoutReplacing(source: string, directory: string, filename: string) {
  for (const candidate of downloadFilenameCandidates(filename)) {
    try {
      await link(source, join(directory, candidate));
      return candidate;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
  }
  throw new SecretRequestFailure("Could not choose a free filename in downloads/.");
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
