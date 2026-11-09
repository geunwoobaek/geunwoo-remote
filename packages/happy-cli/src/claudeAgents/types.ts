/**
 * Shared types for mirroring Claude Code background agents (`claude agents`).
 */

export type ClaudeAgentStatus = 'idle' | 'busy' | 'waiting';

export type ClaudeAgent = {
    /** Short agent id (the stable key for a mirror; not the sessionId). */
    id: string;
    sessionId: string;
    name: string | null;
    cwd: string;
    pid: number;
    status: ClaudeAgentStatus;
    state: 'working' | 'done' | null;
    /** Epoch milliseconds. */
    startedAt: number;
};

export type ClaudeAgentsUnavailable = 'claude-missing' | 'tmux-missing' | 'agents-command-failed';

export type ClaudeAgentsListing = {
    agents: Array<ClaudeAgent & { mirrorSessionId?: string }>;
    unavailable?: ClaudeAgentsUnavailable;
};
