/**
 * Machine RPC handlers for Claude Code background agents (`claude agents`):
 * `list-claude-agents` lists them, `open-claude-agent` opens the mirror session of one
 * (the daemon spawns, or reconnects, `happy claude-agent-mirror <agentId>`),
 * `start-claude-agent` starts a new one with `claude --bg` and opens its mirror, and
 * `discard-claude-agent` stops and removes one that this daemon started.
 *
 * Everything the daemon owns (tracked processes, persisted keys, spawning, running `claude`)
 * comes in through `deps`, so this module's own state is limited to in-flight calls, recent
 * start results and the ids of the agents it started.
 */

import type { Metadata } from '@/api/types';
import { agentNameFrom, buildBgArgs, isUntrustedOutput, parseBackgroundedId } from './startAgent';
import type {
    ClaudeAgent,
    ClaudeAgentsListing,
    DiscardClaudeAgentResult,
    EnsureDirectoryResult,
    StartClaudeAgentRequest,
    StartClaudeAgentResult,
} from './types';

/** Refusal for the ordinary `resume-happy-session` path: a mirror is reopened as an agent, not resumed. */
export const MIRROR_RESUME_REFUSAL = 'This session mirrors a Mac background session. Open it from the background session list.';

export type OpenClaudeAgentResult =
    | { type: 'success'; sessionId: string }
    | { type: 'error'; errorMessage: string };

export type ClaudeAgentHandlers = {
    list(): Promise<ClaudeAgentsListing>;
    open(agentId: string): Promise<OpenClaudeAgentResult>;
    start(request: StartClaudeAgentRequest): Promise<StartClaudeAgentResult>;
    discard(agentId: string): Promise<DiscardClaudeAgentResult>;
};

/** How long a started agent may take to show up in `claude agents --json`. */
export const START_APPEAR_TIMEOUT_MS = 10_000;
export const START_POLL_INTERVAL_MS = 500;
/**
 * How much longer to wait for a mirror that missed the daemon's 15 s webhook timeout but is still
 * running. A busy Mac can take that long just to load the CLI. With `claude --bg`, the 10 s
 * appear wait and the 15 s webhook wait, a start stays under the app's 50 s RPC timeout.
 */
export const LATE_MIRROR_WAIT_MS = 15_000;
/** How long a successful start is answered again for a repeated `clientRequestId`. */
export const START_RESULT_REUSE_MS = 5 * 60_000;

export type PersistedMirror = {
    happySessionId: string;
    /** Base64, exactly as persisted. */
    encryptionKey: string;
    encryptionVariant: 'legacy' | 'dataKey';
    seq: number;
    metadataVersion: number;
    agentStateVersion: number;
};

export type ClaudeAgentHandlerDeps = {
    resolveClaude(): Promise<string | null>;
    tmuxInstalled(): Promise<boolean>;
    fetchAgents(claudePath: string): Promise<ClaudeAgent[]>;
    /** agentId → happySessionId of the mirror processes that are running right now. */
    liveMirrors(): Map<string, string>;
    /** What the agent's session said last, from the end of its transcript; null when there is nothing to show. */
    lastLine(agent: ClaudeAgent): string | null;
    /** True while a mirror process this daemon spawned for the agent is alive but has not reported its session yet. */
    mirrorStarting(agentId: string): boolean;
    /** agentId → the stored keys of its most recent mirror session. */
    persistedMirrors(): Map<string, PersistedMirror>;
    /**
     * Starts `happy claude-agent-mirror <agentId>` in `cwd` and resolves once the mirror has
     * reported its Happy session. With `reconnect` the mirror reuses that session and its keys.
     * (`cwd` is the agent's directory; the brief's two-argument form had no way to carry it.)
     */
    spawnMirror(
        agentId: string,
        reconnect: { happySessionId: string; env: Record<string, string> } | undefined,
        cwd: string,
    ): Promise<OpenClaudeAgentResult>;
    /** Runs `claude <args>` in `cwd`; resolves with its output whatever the exit code. */
    runClaudeBg(claudePath: string, cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }>;
    /** `claude stop <id>`. */
    stopAgent(claudePath: string, id: string): Promise<void>;
    /** `claude rm <id>`. */
    removeAgent(claudePath: string, id: string): Promise<void>;
    /** Uses `directory` when it exists, otherwise creates it once `approved` (the `spawn-happy-session` rules). */
    ensureDirectory(directory: string, approved: boolean): Promise<EnsureDirectoryResult>;
    sleep(ms: number): Promise<void>;
};

/** True when the session is the mirror of a Claude background agent. */
export function isClaudeAgentMirror(metadata: Metadata | undefined): boolean {
    const agentId = metadata?.claudeAgentId;
    return typeof agentId === 'string' && agentId.length > 0;
}

/**
 * The most recent persisted session per agent id. Recency is `lastAliveAt`, falling back to
 * `savedAt` for records written by older versions.
 */
export function pickPersistedMirrors(
    sessions: Record<string, {
        encryptionKey: string;
        encryptionVariant: 'legacy' | 'dataKey';
        seq: number;
        metadataVersion: number;
        agentStateVersion: number;
        metadata: Metadata;
        savedAt: number;
        lastAliveAt?: number;
    }>,
): Map<string, PersistedMirror> {
    const newest = new Map<string, { at: number; mirror: PersistedMirror }>();
    for (const [happySessionId, session] of Object.entries(sessions)) {
        if (!isClaudeAgentMirror(session.metadata)) {
            continue;
        }
        const agentId = session.metadata.claudeAgentId!;
        const at = session.lastAliveAt ?? session.savedAt;
        const known = newest.get(agentId);
        if (known !== undefined && known.at >= at) {
            continue;
        }
        newest.set(agentId, {
            at,
            mirror: {
                happySessionId,
                encryptionKey: session.encryptionKey,
                encryptionVariant: session.encryptionVariant,
                seq: session.seq,
                metadataVersion: session.metadataVersion,
                agentStateVersion: session.agentStateVersion,
            },
        });
    }
    return new Map([...newest].map(([agentId, { mirror }]) => [agentId, mirror]));
}

/** The six `HAPPY_RECONNECT_*` variables `runClaudeAgentMirror` reads to reuse a session. */
export function reconnectEnv(mirror: PersistedMirror): Record<string, string> {
    return {
        HAPPY_RECONNECT_SESSION_ID: mirror.happySessionId,
        HAPPY_RECONNECT_ENCRYPTION_KEY: mirror.encryptionKey,
        HAPPY_RECONNECT_ENCRYPTION_VARIANT: mirror.encryptionVariant,
        HAPPY_RECONNECT_SEQ: String(mirror.seq),
        HAPPY_RECONNECT_METADATA_VERSION: String(mirror.metadataVersion),
        HAPPY_RECONNECT_AGENT_STATE_VERSION: String(mirror.agentStateVersion),
    };
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function createClaudeAgentHandlers(deps: ClaudeAgentHandlerDeps): ClaudeAgentHandlers {
    // Two phone taps (or a retry) on the same agent must not start two mirrors: each mirror
    // opens its own attach client and would type every phone message into the Mac session twice.
    const opensInFlight = new Map<string, Promise<OpenClaudeAgentResult>>();

    async function list(): Promise<ClaudeAgentsListing> {
        try {
            const claudePath = await deps.resolveClaude();
            if (claudePath === null) {
                return { agents: [], unavailable: 'claude-missing', startSupported: true };
            }
            if (!(await deps.tmuxInstalled())) {
                return { agents: [], unavailable: 'tmux-missing', startSupported: true };
            }
            const agents = await deps.fetchAgents(claudePath);
            const live = deps.liveMirrors();
            return {
                // The last line keeps the app's row current while no mirror streams the chat.
                agents: agents.map((agent) => {
                    const mirrorSessionId = live.get(agent.id);
                    const lastLine = deps.lastLine(agent);
                    return {
                        ...agent,
                        ...(mirrorSessionId === undefined ? {} : { mirrorSessionId }),
                        ...(lastLine === null ? {} : { lastLine }),
                    };
                }),
                startSupported: true,
            };
        } catch {
            return { agents: [], unavailable: 'agents-command-failed', startSupported: true };
        }
    }

    /**
     * A spawn that timed out may still be a mirror coming up: wait for it to report instead of
     * failing (or spawning a second mirror next to it). Any other failure is returned as is.
     */
    async function awaitLateMirror(agentId: string, spawned: OpenClaudeAgentResult): Promise<OpenClaudeAgentResult> {
        if (spawned.type === 'success') {
            return spawned;
        }
        for (let waited = 0; ; waited += START_POLL_INTERVAL_MS) {
            const sessionId = deps.liveMirrors().get(agentId);
            if (sessionId !== undefined) {
                return { type: 'success', sessionId };
            }
            if (!deps.mirrorStarting(agentId) || waited >= LATE_MIRROR_WAIT_MS) {
                return spawned;
            }
            await deps.sleep(START_POLL_INTERVAL_MS);
        }
    }

    async function openUncached(agentId: string): Promise<OpenClaudeAgentResult> {
        const liveSessionId = deps.liveMirrors().get(agentId);
        if (liveSessionId !== undefined) {
            return { type: 'success', sessionId: liveSessionId };
        }

        const claudePath = await deps.resolveClaude();
        if (claudePath === null) {
            return { type: 'error', errorMessage: 'claude was not found in the login shell. Install Claude Code first.' };
        }
        if (!(await deps.tmuxInstalled())) {
            return { type: 'error', errorMessage: 'tmux is required to mirror a background session.' };
        }
        const agents = await deps.fetchAgents(claudePath);
        const agent = agents.find((candidate) => candidate.id === agentId);
        if (agent === undefined) {
            return { type: 'error', errorMessage: `No background agent with id ${agentId}.` };
        }

        // The listing above took a moment: a mirror may have come up in the meantime.
        const liveNow = deps.liveMirrors().get(agentId);
        if (liveNow !== undefined) {
            return { type: 'success', sessionId: liveNow };
        }

        const persisted = deps.persistedMirrors().get(agentId);
        if (persisted !== undefined) {
            const reconnected = await awaitLateMirror(agentId, await deps.spawnMirror(
                agentId,
                { happySessionId: persisted.happySessionId, env: reconnectEnv(persisted) },
                agent.cwd,
            ));
            if (reconnected.type === 'success' || deps.mirrorStarting(agentId)) {
                return reconnected;
            }
            // The stored keys may no longer open the session (the mirror exited before it reported).
            // Start one fresh instead.
        }
        return awaitLateMirror(agentId, await deps.spawnMirror(agentId, undefined, agent.cwd));
    }

    function open(agentId: string): Promise<OpenClaudeAgentResult> {
        const running = opensInFlight.get(agentId);
        if (running !== undefined) {
            return running;
        }
        const attempt = openUncached(agentId)
            .catch((error: unknown): OpenClaudeAgentResult => ({
                type: 'error',
                errorMessage: `Failed to open background session: ${describeError(error)}`,
            }))
            .finally(() => {
                opensInFlight.delete(agentId);
            });
        opensInFlight.set(agentId, attempt);
        return attempt;
    }

    // Ids of the agents `start` created. `discard` acts on these only: a session the user started
    // on the Mac must never be stopped from the phone.
    const startedHere = new Set<string>();
    const startsInFlight = new Map<string, Promise<StartClaudeAgentResult>>();
    const startSuccesses = new Map<string, { at: number; result: StartClaudeAgentResult & { type: 'success' } }>();

    /** `claude stop` then `claude rm`; `rm` is tried even when `stop` fails (the agent may already be stopped). */
    async function stopAndRemove(claudePath: string, agentId: string): Promise<void> {
        try {
            await deps.stopAgent(claudePath, agentId);
        } catch {
            // `rm` below decides whether the agent is gone.
        }
        await deps.removeAgent(claudePath, agentId);
        startedHere.delete(agentId);
    }

    async function failAfterStart(claudePath: string, agentId: string, errorMessage: string): Promise<StartClaudeAgentResult> {
        try {
            await stopAndRemove(claudePath, agentId);
        } catch {
            // Cleanup is best effort; the agent stays in `startedHere` so a discard can retry it.
        }
        return { type: 'error', code: 'start-failed', errorMessage };
    }

    async function waitForAgent(claudePath: string, agentId: string): Promise<boolean> {
        const deadline = Date.now() + START_APPEAR_TIMEOUT_MS;
        for (let waited = 0; ; waited += START_POLL_INTERVAL_MS) {
            try {
                if ((await deps.fetchAgents(claudePath)).some((candidate) => candidate.id === agentId)) {
                    return true;
                }
            } catch {
                // A listing that fails once is retried like one that does not show the agent yet.
            }
            if (waited >= START_APPEAR_TIMEOUT_MS || Date.now() >= deadline) {
                return false;
            }
            await deps.sleep(START_POLL_INTERVAL_MS);
        }
    }

    async function startUncached(request: StartClaudeAgentRequest): Promise<StartClaudeAgentResult> {
        const { directory } = request;
        const claudePath = await deps.resolveClaude();
        if (claudePath === null) {
            return { type: 'error', code: 'claude-missing', errorMessage: 'claude was not found in the login shell. Install Claude Code first.' };
        }
        if (!(await deps.tmuxInstalled())) {
            return { type: 'error', code: 'tmux-missing', errorMessage: 'tmux is required to run a background session.' };
        }

        const folder = await deps.ensureDirectory(directory, request.approvedNewDirectoryCreation === true);
        if (folder.type === 'requestToApproveDirectoryCreation') {
            return folder;
        }
        if (folder.type === 'error') {
            return { type: 'error', code: 'start-failed', errorMessage: folder.errorMessage, directory };
        }

        // Normalized again here: the name is the last thing before exec, and must never read as an option.
        const name = agentNameFrom(request.name, directory);
        const args = buildBgArgs({ name, permissionMode: request.permissionMode, model: request.model, effort: request.effort });
        const ran = await deps.runClaudeBg(claudePath, directory, args);
        const output = `${ran.stdout}\n${ran.stderr}`;
        if (isUntrustedOutput(output)) {
            return {
                type: 'error',
                code: 'untrusted-folder',
                errorMessage: `Claude on the Mac does not trust ${directory} yet. Run claude there once and accept the trust prompt, then try again.`,
                directory,
            };
        }
        const agentId = parseBackgroundedId(output);
        if (agentId === null) {
            const printed = output.trim().slice(0, 300);
            return {
                type: 'error',
                code: 'start-failed',
                errorMessage: `claude --bg did not report a background session (exit code ${ran.code ?? 'none'})${printed ? `: ${printed}` : '.'}`,
            };
        }

        // From here on the Mac has a session: every failure removes it before answering, except
        // a mirror that is still connecting (see below).
        startedHere.add(agentId);
        try {
            if (!(await waitForAgent(claudePath, agentId))) {
                return failAfterStart(claudePath, agentId, `Background session ${agentId} did not appear in claude agents within ${START_APPEAR_TIMEOUT_MS / 1000} seconds.`);
            }
            const opened = await open(agentId);
            if (opened.type === 'error') {
                if (deps.mirrorStarting(agentId)) {
                    // Removing the agent now would also take down a mirror that is about to connect.
                    // It stays ours, so the phone can still discard it.
                    return {
                        type: 'error',
                        code: 'start-failed',
                        errorMessage: `Background session ${agentId} is running on the Mac, but its mirror is still connecting. It will show in the session list shortly.`,
                    };
                }
                return failAfterStart(claudePath, agentId, opened.errorMessage);
            }
            return { type: 'success', sessionId: opened.sessionId, agentId };
        } catch (error) {
            return failAfterStart(claudePath, agentId, `Failed to start background session: ${describeError(error)}`);
        }
    }

    function start(request: StartClaudeAgentRequest): Promise<StartClaudeAgentResult> {
        const requestId = request.clientRequestId;
        if (requestId !== undefined) {
            const known = startSuccesses.get(requestId);
            if (known !== undefined && Date.now() - known.at < START_RESULT_REUSE_MS) {
                return Promise.resolve(known.result);
            }
            startSuccesses.delete(requestId);
            const running = startsInFlight.get(requestId);
            if (running !== undefined) {
                return running;
            }
        }
        const attempt = startUncached(request)
            .catch((error: unknown): StartClaudeAgentResult => ({
                type: 'error',
                code: 'start-failed',
                errorMessage: `Failed to start background session: ${describeError(error)}`,
            }));
        if (requestId === undefined) {
            return attempt;
        }
        // Only a success is kept: it is the answer that left a session on the Mac. Directory
        // approval and errors are asked again, since the app retries those with the same id.
        const tracked = attempt
            .then((result) => {
                if (result.type === 'success') {
                    // Expired answers go as a new one comes in, so a long-lived daemon does not keep them all.
                    const now = Date.now();
                    for (const [id, known] of startSuccesses) {
                        if (now - known.at >= START_RESULT_REUSE_MS) startSuccesses.delete(id);
                    }
                    startSuccesses.set(requestId, { at: now, result });
                }
                return result;
            })
            .finally(() => {
                startsInFlight.delete(requestId);
            });
        startsInFlight.set(requestId, tracked);
        return tracked;
    }

    async function discard(agentId: string): Promise<DiscardClaudeAgentResult> {
        if (!startedHere.has(agentId)) {
            return {
                type: 'error',
                code: 'not-started-here',
                errorMessage: `Background session ${agentId} was not started by this daemon, so it is left running.`,
            };
        }
        // Forgotten before anything is tried, and whatever happens next: a retry of the start that made it
        // must never be handed a session being torn down.
        for (const [requestId, known] of startSuccesses) {
            if (known.result.agentId === agentId) {
                startSuccesses.delete(requestId);
            }
        }
        try {
            const claudePath = await deps.resolveClaude();
            if (claudePath === null) {
                return { type: 'error', code: 'discard-failed', errorMessage: 'claude was not found in the login shell.' };
            }
            await stopAndRemove(claudePath, agentId);
            return { type: 'success' };
        } catch (error) {
            return { type: 'error', code: 'discard-failed', errorMessage: `Failed to remove background session ${agentId}: ${describeError(error)}` };
        }
    }

    return { list, open, start, discard };
}
