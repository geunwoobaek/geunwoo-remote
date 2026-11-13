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
    /** [lastLine]: the session's newest answer line or tool call, read from its transcript. */
    agents: Array<ClaudeAgent & { mirrorSessionId?: string; lastLine?: string }>;
    unavailable?: ClaudeAgentsUnavailable;
    /** This daemon answers `start-claude-agent`; the app checks it before choosing that path. */
    startSupported: true;
    /** This daemon answers `revive-claude-agent`. */
    reviveSupported: true;
};

export type ReviveClaudeAgentErrorCode = 'not-found' | 'folder-missing' | 'claude-missing' | 'tmux-missing' | 'revive-failed';

/**
 * `revive-claude-agent`: brings back a background session whose process has exited
 * (`claude respawn`), so a phone message can reach it. `revived` is false when it was running.
 */
export type ReviveClaudeAgentResult =
    | { type: 'success'; revived: boolean }
    | { type: 'error'; code: ReviveClaudeAgentErrorCode; errorMessage: string };

export type ClaudeAgentTaskStatus = 'running' | 'done' | 'stopped' | 'failed';

/** One sub-agent or workflow a background session started (`claude-agent-tasks`). */
export type ClaudeAgentTask = {
    /** `agent-…` for a sub-agent, `wf_…` for a workflow run. */
    id: string;
    kind: 'agent' | 'workflow';
    /** The sub-agent's description, or the workflow's name. */
    label: string;
    /** A sub-agent's type when not the general one; a workflow's summary. */
    detail: string | null;
    /** A running workflow's current phase. */
    phase: string | null;
    model: string | null;
    status: ClaudeAgentTaskStatus;
    /** Epoch milliseconds. */
    startedAt: number;
    /** Epoch milliseconds; null while running. */
    endedAt: number | null;
    /** A workflow's agents so far. */
    agentCount: number | null;
};

/** What a background session runs under itself, and how many typed messages it has not read yet. */
export type ClaudeAgentTasks = {
    /** Running first, then the most recently ended; at most a few dozen. */
    tasks: ClaudeAgentTask[];
    runningCount: number;
    totalCount: number;
    /** Messages waiting for the session's current step (often a long command) to end. */
    queuedInputs: number;
};

export type ClaudeAgentTasksResult =
    | ({ type: 'success' } & ClaudeAgentTasks)
    | { type: 'error'; code: 'not-found' | 'claude-missing' | 'tmux-missing' | 'read-failed'; errorMessage: string };

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
