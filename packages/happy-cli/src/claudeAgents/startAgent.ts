/**
 * Pure helpers for starting a Claude Code background agent with `claude --bg` (no prompt):
 * the argument list, the agent name, and reading the answer `claude --bg` prints.
 */

import { basename } from 'node:path';
import type { SpawnSessionOptions } from '@/modules/common/registerCommonHandlers';
import { appendDaemonSpawnModeArgs } from '@/daemon/spawnModeArgs';

/** The longest name given to `--name` (it shows in `claude agents` on the Mac and cannot be changed). */
export const AGENT_NAME_MAX_LENGTH = 40;

/**
 * `claude --bg --name <name> [--permission-mode <pm>] [--model <m>] [--effort <e>]`.
 * Mode arguments follow the daemon's spawn rules for Claude: `default` is not forwarded.
 */
export function buildBgArgs(options: { name: string; permissionMode?: string; model?: string; effort?: string }): string[] {
    const args = ['--bg', '--name', options.name];
    appendDaemonSpawnModeArgs(args, {
        directory: '',
        permissionMode: options.permissionMode,
        modelMode: options.model,
        effortLevel: options.effort,
    } as SpawnSessionOptions, 'claude');
    return args;
}

/**
 * The first line of the first message, trimmed and cut to 40 characters; the folder's last path
 * segment when that is empty. Leading dashes are dropped so the name can never read as an option.
 */
export function agentNameFrom(firstMessage: string, directory: string): string {
    const firstLine = (firstMessage.split(/\r?\n/)[0] ?? '').trim().replace(/^-+/, '').trim();
    const cut = Array.from(firstLine).slice(0, AGENT_NAME_MAX_LENGTH).join('').trim();
    if (cut.length > 0) {
        return cut;
    }
    const folder = basename(directory).replace(/^-+/, '');
    return folder.length > 0 ? folder : 'claude';
}

const BACKGROUNDED_RE = /backgrounded · ([0-9a-f]+)/;

/** The agent id from `backgrounded · <id> · …` anywhere in the output (a warning line may come first). */
export function parseBackgroundedId(output: string): string | null {
    return BACKGROUNDED_RE.exec(output)?.[1] ?? null;
}

/** True for `Workspace not trusted. Run \`claude\` in <dir> once and accept the trust prompt, then retry.` */
export function isUntrustedOutput(output: string): boolean {
    return output.includes('Workspace not trusted');
}

/**
 * The environment for `claude --bg`: the daemon's child environment minus the markers a Claude
 * Code session sets for its children, so a nested-session guard cannot refuse the start. Only
 * markers are removed; configuration such as `CLAUDE_CODE_OAUTH_TOKEN` is kept.
 */
export function claudeBgEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const cleaned: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(env)) {
        if (key.startsWith('CLAUDECODE') || CLAUDE_SESSION_MARKERS.has(key)) {
            continue;
        }
        cleaned[key] = value;
    }
    return cleaned;
}

const CLAUDE_SESSION_MARKERS = new Set(['CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT']);
