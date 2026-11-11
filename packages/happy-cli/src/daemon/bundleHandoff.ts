/**
 * When a running daemon may hand off to the bundle that replaced its own on disk.
 *
 * A rebuild (`pnpm build`, an install, a test run's global setup) empties `dist/`
 * and writes it again over several seconds. Handing off midway starts the new
 * daemon from a missing or half-written entrypoint; the old one has already let go,
 * so nothing is left running. The handoff therefore waits until the entrypoint is
 * there, differs from the one this daemon started from, and nothing in `dist/` has
 * changed for [BUNDLE_QUIET_MS].
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** How long `dist/` must stay untouched before a replaced bundle counts as finished. */
export const BUNDLE_QUIET_MS = 20_000;

/**
 * Whether `distDir/index.mjs` replaced the bundle this daemon started from
 * (modified at [startedMtimeMs]) and the rebuild that wrote it is over at [now].
 */
export function bundleReadyForHandoff(distDir: string, startedMtimeMs: number, now: number): boolean {
    try {
        const entrypointMtimeMs = statSync(join(distDir, 'index.mjs')).mtimeMs;
        if (entrypointMtimeMs === startedMtimeMs) {
            return false;
        }
        const newestMtimeMs = readdirSync(distDir).reduce(
            (newest, name) => Math.max(newest, statSync(join(distDir, name)).mtimeMs),
            entrypointMtimeMs,
        );
        return now - newestMtimeMs >= BUNDLE_QUIET_MS;
    } catch {
        // Missing mid-rebuild, or a file went away while listing: look again on the next heartbeat.
        return false;
    }
}
