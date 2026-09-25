/**
 * Pinned-whip installer - one home for the "whip binary may be missing or
 * renamed" patch logic. Everything loupe needs to run harness "whip" lives
 * here; the harness in index.ts only calls resolveWhipBinary().
 *
 * Background: the upstream whip CLI renamed its binary to `whipcode` at v1.0.0
 * (and its config dir to ~/.whipcode/WHIPCODE_HOME). Environments that install
 * "latest" now have a renamed or missing `whip`, so loupe:
 *   1. identity-checks any `whip` on PATH (`whip --version` must report whip),
 *      rejecting renamings like whipcode masquerading as `whip`;
 *   2. falls back to a pinned release (PINNED_WHIP_TAG), downloaded on demand
 *      into a private cache dir; and
 *   3. single-flights the download so concurrent reviewers inside one loupe
 *      process share a single install instead of racing one another.
 */

import { spawn } from "node:child_process";
import {
  accessSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Logger } from "@loupe/logger";

/**
 * whip v0.6.5 - the pinned release loupe installs on demand. The latest whip
 * release (v1.0.0+) renamed the binary to `whipcode` and broke the harness, so
 * when a user selects harness "whip" and no genuine `whip` is on PATH, loupe
 * downloads this exact tag instead of failing with "CLI is not installed."
 * Bump deliberately when adopting the v1+ whipcode generation.
 */
export const PINNED_WHIP_TAG = "v0.6.5";

/** Minimal logging surface so this module works without a real logger. */
type WhipLogger = Pick<Logger, "info" | "warn">;

const noLogger: WhipLogger = {
  info: () => {},
  warn: () => {},
};

/**
 * Run `whip --version` and check the binary identifies itself as genuine whip
 * (output starting with "whip v"). The v1.0.0 release renamed the CLI to
 * whipcode, but many CI install steps still download "latest" and save it as
 * `whip` - so a PATH hit may actually be whipcode, which reads a different
 * config dir and rejects loupe's model panel:
 *   whipcode: unknown model "glm-5.3" (models: ...)
 */
export function isGenuineWhipOnPath(): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn("whip", ["--version"]);
    let stdout = "";
    p.on("error", () => resolve(false));
    p.on("close", () => resolve(/^\s*whip v/i.test(stdout)));
    p.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
  });
}

/** The cache path where the pinned binary lives once installed. */
export function pinnedWhipPath(): string {
  const home = process.env.HOME ?? tmpdir();
  return join(home, ".loupe", "bin", "whip");
}

/** True when a complete, executable binary is already at the cache path. */
function isInstalled(dest: string): boolean {
  try {
    accessSync(dest);
    chmodSync(dest, 0o755);
    return true;
  } catch {
    return false;
  }
}

/**
 * Single-flight wrapper: reviewers run concurrently inside one loupe process,
 * so simultaneous callers must share one download. The memoized promise makes
 * every caller await the same install; on completion or failure the memo
 * clears so the next attempt is a fresh one.
 */
let inFlight: Promise<string | null> | null = null;

export function installPinnedWhip(
  logger: WhipLogger | null,
): Promise<string | null> {
  if (inFlight) return inFlight;
  const log = logger ?? noLogger;
  const attempt = downloadPinnedWhip(log).then(
    (result) => {
      if (inFlight === attempt) inFlight = null;
      return result;
    },
    (err: unknown) => {
      if (inFlight === attempt) inFlight = null;
      throw err;
    },
  );
  inFlight = attempt;
  return attempt;
}

/**
 * One actual install attempt. Downloads into a unique temp dir and renames
 * into place, so the destination only ever exists complete; if another
 * attempt (or another process) won the rename while we were mid-flight, the
 * destination holds a valid binary and we return it.
 */
function downloadPinnedWhip(log: WhipLogger): Promise<string | null> {
  const dest = pinnedWhipPath();
  const binDir = join(dest, "..");
  mkdirSync(binDir, { recursive: true });
  if (isInstalled(dest)) return Promise.resolve(dest);
  const mode =
    process.platform === "darwin" && process.arch === "arm64"
      ? "darwin-arm64"
      : process.platform === "darwin"
        ? "darwin-x64"
        : process.platform === "linux" && process.arch === "arm64"
          ? "linux-arm64"
          : "linux-x64";
  const url = `https://github.com/context-labs/whip/releases/download/${PINNED_WHIP_TAG}/whip-${mode}`;
  // Unique staging dir per attempt: safe against same-process concurrency and
  // a same-machine second process. Inside binDir so rename stays on one fs.
  const stagingDir = mkdtempSync(join(binDir, ".download-"));
  const staging = join(stagingDir, "whip");
  return new Promise((resolve) => {
    const cleanup = (): void => {
      try {
        rmSync(stagingDir, { recursive: true, force: true });
      } catch {
        // best-effort; an orphaned .download-* temp dir is harmless
      }
    };
    const child = spawn("curl", ["-fsSL", "--retry", "2", "-o", staging, url]);
    child.on("error", (err) => {
      cleanup();
      log.warn("pinned whip download failed to start", { error: String(err) });
      resolve(null);
    });
    child.on("close", (code) => {
      if (code !== 0) {
        // A concurrent winner may have finished while we were downloading.
        cleanup();
        log.warn("pinned whip download failed", { code, url });
        resolve(isInstalled(dest) ? dest : null);
        return;
      }
      try {
        chmodSync(staging, 0o755);
        // Atomic within the same filesystem: dest only ever exists complete.
        // If another attempt renamed first, its binary is valid - use it.
        try {
          renameSync(staging, dest);
        } catch {
          if (!isInstalled(dest)) throw new Error("rename failed and no dest");
        }
        resolve(dest);
      } catch (err) {
        log.warn("failed to stage pinned whip", { error: String(err) });
        resolve(isInstalled(dest) ? dest : null);
      } finally {
        cleanup();
      }
    });
  });
}

/**
 * The one entry point the whip harness uses: resolve which binary to spawn.
 * Prefers a genuine `whip` on PATH (identity-checked), else installs/returns
 * the pinned release from the private cache. Returns null only when neither
 * is possible (no genuine PATH binary and the download failed).
 */
export async function resolveWhipBinary(
  logger: WhipLogger | null,
): Promise<string | null> {
  if (await isGenuineWhipOnPath()) return "whip";
  const installed = await installPinnedWhip(logger);
  if (installed && installed !== "whip") {
    logger?.info(
      `no genuine whip on PATH; using pinned release ${PINNED_WHIP_TAG} from ${installed}`,
    );
  }
  return installed;
}
