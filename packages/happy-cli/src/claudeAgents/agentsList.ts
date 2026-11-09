/**
 * Reads the list of Claude Code background agents by running `claude agents --json`.
 * Only `kind === 'background'` entries are kept. The `claude` binary is located through
 * a login shell so a globally installed CLI is found (never the Agent SDK bundled one).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { ClaudeAgent, ClaudeAgentStatus } from './types';

const execFileAsync = promisify(execFile);

const RESOLVE_TIMEOUT_MS = 5_000;
const AGENTS_TIMEOUT_MS = 10_000;
const AGENTS_MAX_BUFFER = 8 * 1024 * 1024;

const rawAgentSchema = z.object({
    id: z.string().min(1),
    sessionId: z.string().min(1),
    cwd: z.string().min(1),
    kind: z.literal('background'),
    pid: z.number().catch(0),
    name: z.string().nullish(),
    status: z.string().nullish(),
    state: z.string().nullish(),
    startedAt: z.union([z.number(), z.string()]).nullish(),
});

function normalizeStatus(status: string | null | undefined): ClaudeAgentStatus {
    return status === 'busy' || status === 'waiting' ? status : 'idle';
}

function normalizeStartedAt(startedAt: number | string | null | undefined): number {
    const ms = typeof startedAt === 'string' ? Date.parse(startedAt) : startedAt;
    return typeof ms === 'number' && Number.isFinite(ms) ? ms : 0;
}

/** Parses `claude agents --json` output into background agents; returns [] on any malformed input. */
export function parseClaudeAgents(json: string): ClaudeAgent[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        return [];
    }
    if (!Array.isArray(parsed)) {
        return [];
    }
    return parsed.flatMap((entry): ClaudeAgent[] => {
        const result = rawAgentSchema.safeParse(entry);
        if (!result.success) {
            return [];
        }
        const raw = result.data;
        return [{
            id: raw.id,
            sessionId: raw.sessionId,
            name: raw.name ?? null,
            cwd: raw.cwd,
            pid: raw.pid,
            status: normalizeStatus(raw.status),
            state: raw.state === 'working' || raw.state === 'done' ? raw.state : null,
            startedAt: normalizeStartedAt(raw.startedAt),
        }];
    });
}

/** Finds the `claude` binary via a login shell; null when it is not installed. */
export async function resolveClaudeBinary(): Promise<string | null> {
    try {
        const { stdout } = await execFileAsync('/bin/zsh', ['-lc', 'command -v claude'], { timeout: RESOLVE_TIMEOUT_MS });
        return stdout.split('\n')[0].trim() || null;
    } catch {
        return null;
    }
}

/**
 * Runs `claude agents --json` (10s limit) and returns the background agents.
 * Throws on command failure and when stdout is not a JSON array, so garbage output
 * from a zero-exit run is never mistaken for "no agents".
 */
export async function fetchClaudeAgents(claudePath: string): Promise<ClaudeAgent[]> {
    const { stdout } = await execFileAsync(claudePath, ['agents', '--json'], {
        timeout: AGENTS_TIMEOUT_MS,
        maxBuffer: AGENTS_MAX_BUFFER,
    });
    if (!Array.isArray(JSON.parse(stdout))) {
        throw new Error('claude agents --json did not print a JSON array');
    }
    return parseClaudeAgents(stdout);
}
