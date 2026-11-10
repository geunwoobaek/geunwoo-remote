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
/** When each session's last search of every project found nothing: it is not searched again until `MISSING_RETRY_MS` later. */
const missingSince = new Map<string, number>();
/** How long a fruitless search of every project directory stands before the next one. */
const MISSING_RETRY_MS = 10_000;
/** Entries kept per map; the oldest go first. A process follows a handful of sessions. */
const MAX_REMEMBERED_SESSIONS = 256;

function remember<V>(map: Map<string, V>, sessionId: string, value: V): void {
    map.delete(sessionId);
    map.set(sessionId, value);
    if (map.size > MAX_REMEMBERED_SESSIONS) {
        map.delete(map.keys().next().value as string);
    }
}

/**
 * The project directory that holds `<sessionId>.jsonl`. Claude Code keeps writing a session's
 * transcript under the directory it started in, even after the session moves elsewhere (for
 * example into a git worktree), so the working directory's own project is tried first and the
 * other projects are searched next. Falls back to the working directory's project when the
 * transcript is nowhere yet. A search that found nothing is not repeated for `MISSING_RETRY_MS`
 * (callers poll every second and there may be hundreds of projects); the working directory's
 * own project and the last known one are still checked on every call.
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
    const missing = missingSince.get(sessionId);
    if (missing !== undefined && Date.now() - missing < MISSING_RETRY_MS) {
        return own;
    }
    const projectsDir = dirname(own);
    try {
        for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
            const candidate = join(projectsDir, entry.name);
            if (entry.isDirectory() && existsSync(join(candidate, file))) {
                missingSince.delete(sessionId);
                remember(movedSessions, sessionId, candidate);
                return candidate;
            }
        }
    } catch {
        // No projects directory yet.
    }
    remember(missingSince, sessionId, Date.now());
    return own;
}
