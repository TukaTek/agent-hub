// Kept apart from bot-secrets.ts so a computer's workspace can take downloads without importing
// the vault, which would close an import cycle back to the computer lifecycle.

/** Where a binary response is saved so the bot's file tools and computer can open it. */
export interface SecretDownloadTarget {
  /** Largest file this computer can receive. */
  maxBytes: number;
  /** Host directory the response streams into. */
  directory(): Promise<string>;
  /** Makes a finished file visible to the bot and returns its path relative to the bot home. */
  publish(hostPath: string, filename: string): Promise<string>;
}

export function getFileDownloadCap(): number {
  const env = process.env.CORTEXAI_AGENT_HUB_SECRET_REQUEST_FILE_CAP_BYTES;
  if (!env) return 100 * 1024 * 1024;
  const parsed = parseInt(env, 10);
  return parsed > 0 ? parsed : 100 * 1024 * 1024;
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
