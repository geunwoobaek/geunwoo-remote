import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export function getProjectPath(workingDirectory: string) {
    const projectId = resolve(workingDirectory).replace(/[^a-zA-Z0-9-]/g, '-');
    const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    return join(claudeConfigDir, 'projects', projectId);
}

/** Project directories found outside the working directory's own, by session id. */
const movedSessions = new Map<string, string>();

/**
 * The project directory that holds `<sessionId>.jsonl`. Claude Code keeps writing a session's
 * transcript under the directory it started in, even after the session moves elsewhere (for
 * example into a git worktree), so the working directory's own project is tried first and the
 * other projects are searched next. Falls back to the working directory's project when the
 * transcript is nowhere yet.
 */
export function findSessionProjectDir(workingDirectory: string, sessionId: string): string {
    const own = getProjectPath(workingDirectory);
    const file = `${sessionId}.jsonl`;
    if (existsSync(join(own, file))) {
        return own;
    }
    const known = movedSessions.get(sessionId);
    if (known !== undefined && existsSync(join(known, file))) {
        return known;
    }
    const projectsDir = dirname(own);
    try {
        for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
            const candidate = join(projectsDir, entry.name);
            if (entry.isDirectory() && existsSync(join(candidate, file))) {
                movedSessions.set(sessionId, candidate);
                return candidate;
            }
        }
    } catch {
        // No projects directory yet.
    }
    return own;
}
