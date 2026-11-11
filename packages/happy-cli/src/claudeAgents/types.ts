/**
 * Shared types for mirroring Claude Code background agents (`claude agents`).
 */

export type ClaudeAgentStatus = 'idle' | 'busy' | 'waiting';

export type ClaudeAgentState = 'working' | 'blocked' | 'done';

export type ClaudeAgent = {
    /** Short agent id (the stable key for a mirror; not the sessionId). */
    id: string;
    sessionId: string;
    name: string | null;
    cwd: string;
    pid: number;
    status: ClaudeAgentStatus;
    /** `claude agents`' grouping; the app prefers it to [status] (done with a shell open is still busy). */
    state: ClaudeAgentState | null;
    /** Epoch milliseconds. */
    startedAt: number;
};

export type ClaudeAgentsUnavailable = 'claude-missing' | 'tmux-missing' | 'agents-command-failed';

export type ClaudeAgentsListing = {
    agents: Array<ClaudeAgent & { mirrorSessionId?: string }>;
    unavailable?: ClaudeAgentsUnavailable;
    /** This daemon answers `start-claude-agent`; the app checks it before choosing that path. */
    startSupported: true;
};

/** `start-claude-agent`: starts `claude --bg` (no prompt) in `directory` and opens its mirror. */
export type StartClaudeAgentRequest = {
    directory: string;
    name: string;
    model?: string;
    permissionMode?: string;
    effort?: string;
    approvedNewDirectoryCreation?: boolean;
    /** The same id while a start is running, or after it succeeded (5 minutes), answers that start again. */
    clientRequestId?: string;
};

export type StartClaudeAgentErrorCode = 'untrusted-folder' | 'claude-missing' | 'tmux-missing' | 'start-failed';

export type StartClaudeAgentResult =
    | { type: 'success'; sessionId: string; agentId: string }
    | { type: 'requestToApproveDirectoryCreation'; directory: string }
    | { type: 'error'; code: StartClaudeAgentErrorCode; errorMessage: string; directory?: string };

export type DiscardClaudeAgentResult =
    | { type: 'success' }
    | { type: 'error'; code: 'not-started-here' | 'discard-failed'; errorMessage: string };

export type EnsureDirectoryResult =
    | { type: 'ok'; created: boolean }
    | { type: 'requestToApproveDirectoryCreation'; directory: string }
    | { type: 'error'; errorMessage: string };
