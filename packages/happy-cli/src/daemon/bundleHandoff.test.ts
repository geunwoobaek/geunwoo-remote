import { mkdir, mkdtemp, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUNDLE_QUIET_MS, bundleReadyForHandoff } from './bundleHandoff';

describe('bundleReadyForHandoff', () => {
    let dist: string;
    const started = 1_000_000;
    const rebuilt = 2_000_000;

    async function file(name: string, mtimeMs: number): Promise<void> {
        const path = join(dist, name);
        await writeFile(path, 'x');
        await utimes(path, mtimeMs / 1000, mtimeMs / 1000);
    }

    beforeEach(async () => {
        dist = await mkdtemp(join(tmpdir(), 'happy-dist-'));
    });

    afterEach(async () => {
        await rm(dist, { recursive: true, force: true });
    });

    it('keeps the daemon while its own bundle is in place', async () => {
        await file('index.mjs', started);

        expect(bundleReadyForHandoff(dist, started, started + 10 * BUNDLE_QUIET_MS)).toBe(false);
    });

    it('waits while the entrypoint is missing mid-rebuild', async () => {
        await file('index.mjs', started);
        await unlink(join(dist, 'index.mjs'));

        expect(bundleReadyForHandoff(dist, started, rebuilt + 10 * BUNDLE_QUIET_MS)).toBe(false);
    });

    it('waits until nothing in dist has changed for the quiet time', async () => {
        await file('index.mjs', rebuilt);
        await file('index-abc.mjs', rebuilt + 5_000);

        expect(bundleReadyForHandoff(dist, started, rebuilt + BUNDLE_QUIET_MS)).toBe(false);
        expect(bundleReadyForHandoff(dist, started, rebuilt + 5_000 + BUNDLE_QUIET_MS)).toBe(true);
    });

    it('counts files the build writes into subdirectories', async () => {
        await file('index.mjs', rebuilt);
        await mkdir(join(dist, 'codex'));
        await file('codex/bridge.mjs', rebuilt + 5_000);
        // The directory's own time moves when files come and go in it, and counts as well.
        await utimes(join(dist, 'codex'), rebuilt / 1000, rebuilt / 1000);

        expect(bundleReadyForHandoff(dist, started, rebuilt + BUNDLE_QUIET_MS)).toBe(false);
        expect(bundleReadyForHandoff(dist, started, rebuilt + 5_000 + BUNDLE_QUIET_MS)).toBe(true);
    });
});
