/**
 * Reads the list of Claude Code background agents by running `claude agents --json`, and runs
 * the other `claude` commands the daemon needs for them (`--bg`, `stop`, `rm`).
 * Only `kind === 'background'` entries are kept. The `claude` binary is located through
 * a login shell so a globally installed CLI is found (never the Agent SDK bundled one).
 */

import { execFile, spawn } from 'node:child_process';
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

const BG_TIMEOUT_MS = 30_000;
/** How long to keep reading output after `claude --bg` exited (a detached child may hold the pipes). */
const BG_OUTPUT_GRACE_MS = 1_000;
const AGENT_COMMAND_TIMEOUT_MS = 15_000;

/**
 * Runs `claude <args>` (for `claude --bg`) in `cwd` and resolves with its output and exit code,
 * whatever the code: the untrusted-folder refusal is read from the output of a failing run.
 * Settles shortly after the process exits even if a background child keeps the pipes open.
 * Rejects only when the process cannot be started.
 */
export function runClaudeBackground(
    claudePath: string,
    cwd: string,
    args: string[],
    env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
    return new Promise((resolve, reject) => {
        const child = spawn(claudePath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        let exitCode: number | null = null;
        let settled = false;
        let graceTimer: NodeJS.Timeout | undefined;
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });

        const finish = (): void => {
            if (settled) return;
            settled = true;
            clearTimeout(killTimer);
            clearTimeout(graceTimer);
            child.stdout.destroy();
            child.stderr.destroy();
            resolve({ stdout, stderr, code: exitCode });
        };
        const killTimer = setTimeout(() => {
            child.kill('SIGTERM');
            finish();
        }, BG_TIMEOUT_MS);

        child.on('error', (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(killTimer);
            clearTimeout(graceTimer);
            reject(error);
        });
        child.on('exit', (code) => {
            exitCode = code;
            graceTimer = setTimeout(finish, BG_OUTPUT_GRACE_MS);
        });
        child.on('close', finish);
    });
}

/** `claude stop <id>` (one id per call). */
export async function stopClaudeAgent(claudePath: string, id: string, env: NodeJS.ProcessEnv): Promise<void> {
    await execFileAsync(claudePath, ['stop', id], { env, timeout: AGENT_COMMAND_TIMEOUT_MS });
}

/** `claude rm <id>` (one id per call). */
export async function removeClaudeAgent(claudePath: string, id: string, env: NodeJS.ProcessEnv): Promise<void> {
    await execFileAsync(claudePath, ['rm', id], { env, timeout: AGENT_COMMAND_TIMEOUT_MS });
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
