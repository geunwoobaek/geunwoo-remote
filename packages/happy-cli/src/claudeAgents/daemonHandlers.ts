/**
 * Machine RPC handlers for Claude Code background agents (`claude agents`):
 * `list-claude-agents` lists them, `open-claude-agent` opens the mirror session of one
 * (the daemon spawns, or reconnects, `happy claude-agent-mirror <agentId>`).
 *
 * Everything the daemon owns (tracked processes, persisted keys, spawning) comes in through
 * `deps`, so this module has no daemon state of its own beyond the in-flight `open` calls.
 */

import type { Metadata } from '@/api/types';
import type { ClaudeAgent, ClaudeAgentsListing } from './types';

/** Refusal for the ordinary `resume-happy-session` path: a mirror is reopened as an agent, not resumed. */
export const MIRROR_RESUME_REFUSAL = 'This session mirrors a Mac background session. Open it from the background session list.';

export type OpenClaudeAgentResult =
    | { type: 'success'; sessionId: string }
    | { type: 'error'; errorMessage: string };

export type ClaudeAgentHandlers = {
    list(): Promise<ClaudeAgentsListing>;
    open(agentId: string): Promise<OpenClaudeAgentResult>;
};

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
                return { agents: [], unavailable: 'claude-missing' };
            }
            if (!(await deps.tmuxInstalled())) {
                return { agents: [], unavailable: 'tmux-missing' };
            }
            const agents = await deps.fetchAgents(claudePath);
            const live = deps.liveMirrors();
            return {
                agents: agents.map((agent) => {
                    const mirrorSessionId = live.get(agent.id);
                    return mirrorSessionId === undefined ? agent : { ...agent, mirrorSessionId };
                }),
            };
        } catch {
            return { agents: [], unavailable: 'agents-command-failed' };
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
            const reconnected = await deps.spawnMirror(
                agentId,
                { happySessionId: persisted.happySessionId, env: reconnectEnv(persisted) },
                agent.cwd,
            );
            if (reconnected.type === 'success') {
                return reconnected;
            }
            // The stored keys may no longer open the session (the mirror exits before it reports,
            // or never reports within the daemon's webhook timeout). Start one fresh instead.
        }
        return deps.spawnMirror(agentId, undefined, agent.cwd);
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

    return { list, open };
}
