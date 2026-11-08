/**
 * Follows the folder Claude is working in, so the app can find the files it
 * names.
 *
 * A session's `metadata.path` is the folder it started in. Claude often moves
 * from there into a worktree (`<path>/.claude/worktrees/<name>`, after
 * EnterWorktree) or another folder (`cd` in Bash) and names files relative to
 * where it is now. Claude Code writes that folder as `cwd` on every line of
 * its transcript, in local and SDK (remote) mode alike, so the transcript
 * tail tells us when it changes. The app reads the result as `metadata.cwd`;
 * `metadata.path` stays the session's root.
 */

/**
 * The folder a transcript line says Claude was in, or null when it doesn't
 * say. Sub-agent lines (`isSidechain`) are left out: a sub-agent may run in a
 * worktree of its own while the main agent stays where it is.
 */
export function transcriptLineCwd(line: unknown): string | null {
    if (!line || typeof line !== 'object') return null;
    const record = line as { cwd?: unknown; isSidechain?: unknown };
    if (record.isSidechain === true) return null;
    if (typeof record.cwd !== 'string') return null;
    const cwd = record.cwd.trim();
    return cwd.length > 0 ? cwd : null;
}

export type AgentCwdTracker = {
    /** A new transcript line; publishes its folder when it differs from the last one. */
    observe(line: unknown): void;
    /** Claude (re)started in [cwd] (its SessionStart hook); published when it differs. */
    reset(cwd: string | null | undefined): void;
};

/**
 * Publishes Claude's folder each time it changes, starting from [initial]
 * (what the metadata already says), so lines that repeat the same folder
 * never write the metadata again.
 */
export function createAgentCwdTracker(opts: {
    initial: string | null | undefined;
    publish: (cwd: string) => void;
}): AgentCwdTracker {
    let last = opts.initial ?? null;
    const take = (cwd: string | null) => {
        if (!cwd || cwd === last) return;
        last = cwd;
        opts.publish(cwd);
    };
    return {
        observe: (line) => take(transcriptLineCwd(line)),
        reset: (cwd) => take(typeof cwd === 'string' && cwd.trim().length > 0 ? cwd.trim() : null),
    };
}
