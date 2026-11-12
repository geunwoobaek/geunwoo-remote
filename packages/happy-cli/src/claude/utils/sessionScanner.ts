import { InvalidateSync } from "@/utils/sync";
import { RawJSONLines, RawJSONLinesSchema } from "../types";
import { parseClaudeGoalStatusTranscriptEvent, type ClaudeGoalStatusTranscriptEvent } from "../claudeGoalStatus";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { logger } from "@/ui/logger";
import { startFileWatcher } from "@/modules/watcher/startFileWatcher";
import { findSessionProjectDir, getProjectPath } from "./path";
import { openJsonlTail, type JsonlTail } from "./jsonlTail";

/**
 * Known internal Claude Code event types that should be silently skipped.
 * These are written to session JSONL files by Claude Code but are not 
 * actual conversation messages - they're internal state/tracking events.
 */
const INTERNAL_CLAUDE_EVENT_TYPES = new Set([
    'file-history-snapshot',
    'change',
    'queue-operation',
]);

export type ScannerTranscriptEvent = ClaudeGoalStatusTranscriptEvent;

type SessionLogEntry =
    | { kind: 'message'; key: string; message: RawJSONLines }
    | { kind: 'transcript-event'; key: string; event: ScannerTranscriptEvent };

export async function createSessionScanner(opts: {
    sessionId: string | null,
    workingDirectory: string
    onMessage: (message: RawJSONLines) => void
    onTranscriptEvent?: (event: ScannerTranscriptEvent) => void
    /**
     * How long the transcript's parent directory may stay unwatchable before
     * its watcher gives up. This does not bound a late transcript file.
     */
    missingFileTimeoutMs?: number
    /**
     * Look for each session's transcript in every project directory when it is not under the
     * working directory's own (a session that moved into a worktree keeps writing where it
     * started). Off by default: Happy's own sessions always write under their working directory.
     */
    searchOtherProjects?: boolean
}) {

    // Resolve project directory
    const projectDir = getProjectPath(opts.workingDirectory);
    const projectDirFor = (sessionId: string): string =>
        opts.searchOtherProjects ? findSessionProjectDir(opts.workingDirectory, sessionId) : projectDir;

    // Finished, pending finishing and current session
    let finishedSessions = new Set<string>();
    let pendingSessions = new Set<string>();
    let currentSessionId: string | null = null;
    let watchers = new Map<string, (() => void)>();
    let processedEntryKeys = new Set<string>();
    // Sessions whose project directory stayed unwatchable. Their watcher gave
    // up, so do not keep re-creating it on every sync. A merely absent file is
    // watched through its parent directory and never enters this set.
    let deadSessions = new Set<string>();
    // One tail per transcript file: each sync reads only what was appended since the last one.
    // Every entry the scanner hands out is keyed, so re-reading a file from the start is harmless.
    const tails = new Map<string, JsonlTail>();
    const readNewEntries = (sessionId: string): SessionLogEntry[] => {
        const file = join(projectDirFor(sessionId), `${sessionId}.jsonl`);
        let tail = tails.get(file);
        if (tail === undefined) {
            logger.debug(`[SESSION_SCANNER] Reading session file: ${file}`);
            tail = openJsonlTail(file);
            tails.set(file, tail);
        }
        return parseSessionEntries(tail.readNew().lines);
    };

    // Mark existing entries as processed and start watching the initial session
    if (opts.sessionId) {
        let entries = readNewEntries(opts.sessionId);
        logger.debug(`[SESSION_SCANNER] Marking ${entries.length} existing entries as processed from session ${opts.sessionId}`);
        for (let entry of entries) {
            processedEntryKeys.add(entry.key);
        }
        // IMPORTANT: Also start watching the initial session file because Claude Code
        // may continue writing to it even after creating a new session with --resume
        // (agent tasks and other updates can still write to the original session file)
        currentSessionId = opts.sessionId;
    }

    // Main sync function
    const sync = new InvalidateSync(async () => {

        // Collect session ids - include ALL sessions that have watchers
        // This ensures we continue processing sessions that Claude Code may still write to
        let sessions: string[] = [];
        for (let p of pendingSessions) {
            if (!deadSessions.has(p)) {
                sessions.push(p);
            }
        }
        if (currentSessionId && !pendingSessions.has(currentSessionId) && !deadSessions.has(currentSessionId)) {
            sessions.push(currentSessionId);
        }
        // Also process sessions that have active watchers (they may still receive updates)
        for (let [sessionId] of watchers) {
            if (!sessions.includes(sessionId) && !deadSessions.has(sessionId)) {
                sessions.push(sessionId);
            }
        }

        // Process sessions
        for (let session of sessions) {
            const sessionEntries = readNewEntries(session);
            let skipped = 0;
            let sentMessages = 0;
            let sentTranscriptEvents = 0;
            for (let entry of sessionEntries) {
                if (processedEntryKeys.has(entry.key)) {
                    skipped++;
                    continue;
                }
                processedEntryKeys.add(entry.key);
                // The file is not read again from the start, so one failing entry must not
                // cost the ones after it.
                try {
                    if (entry.kind === 'message') {
                        logger.debug(`[SESSION_SCANNER] Sending new message: type=${entry.message.type}, uuid=${entry.message.type === 'summary' ? entry.message.leafUuid : entry.message.uuid}`);
                        opts.onMessage(entry.message);
                        sentMessages++;
                    } else {
                        logger.debug(`[SESSION_SCANNER] Sending new transcript event: type=${entry.event.type}, uuid=${entry.event.uuid}`);
                        opts.onTranscriptEvent?.(entry.event);
                        sentTranscriptEvents++;
                    }
                } catch (error) {
                    logger.debug(`[SESSION_SCANNER] Handling entry ${entry.key} failed`, error);
                }
            }
            if (sessionEntries.length > 0) {
                logger.debug(`[SESSION_SCANNER] Session ${session}: found=${sessionEntries.length}, skipped=${skipped}, sentMessages=${sentMessages}, sentTranscriptEvents=${sentTranscriptEvents}`);
            }
        }

        // With searchOtherProjects, a transcript that is nowhere yet resolves to the working
        // directory's own project, which for a session that moved into a worktree may never exist:
        // a watcher there would give up and drop the session. Such a session gets no watcher and
        // stays pending; every sync resolves it again until its file shows up.
        const unresolved = new Set(opts.searchOtherProjects
            ? sessions.filter((p) => !existsSync(join(projectDirFor(p), `${p}.jsonl`)))
            : []);

        // Move pending sessions to finished sessions (but keep processing them via watchers)
        for (let p of sessions) {
            if (pendingSessions.has(p) && !unresolved.has(p)) {
                pendingSessions.delete(p);
                finishedSessions.add(p);
            }
        }

        // Update watchers for all sessions
        for (let p of sessions) {
            if (!watchers.has(p) && !deadSessions.has(p) && !unresolved.has(p)) {
                logger.debug(`[SESSION_SCANNER] Starting watcher for session: ${p}`);
                watchers.set(p, startFileWatcher(
                    join(projectDirFor(p), `${p}.jsonl`),
                    () => { sync.invalidate(); },
                    {
                        missingFileTimeoutMs: opts.missingFileTimeoutMs,
                        onGaveUp: () => {
                            // The project directory stayed unwatchable. Tear
                            // down and blacklist the session so the collection
                            // loop does not resurrect the failed watcher.
                            logger.debug(`[SESSION_SCANNER] Session ${p} transcript unreachable (directory unwatchable) — dropping it`);
                            watchers.get(p)?.();
                            watchers.delete(p);
                            deadSessions.add(p);
                            pendingSessions.delete(p);
                        },
                    },
                ));
            }
        }
    });
    await sync.invalidateAndAwait();

    // Periodic sync
    const intervalId = setInterval(() => { sync.invalidate(); }, 3000);

    // Public interface
    return {
        cleanup: async () => {
            clearInterval(intervalId);
            // The final sync can create watchers, so flush and stop before
            // disposing the map. Otherwise cleanup can leak newly-created
            // directory watchers.
            await sync.invalidateAndAwait();
            sync.stop();
            for (let w of watchers.values()) {
                w();
            }
            watchers.clear();
        },
        onNewSession: async (sessionId: string, options?: { treatExistingAsProcessed?: boolean }) => {
            const wasDead = deadSessions.delete(sessionId);
            if (wasDead) {
                logger.debug(`[SESSION_SCANNER] Reviving previously-dropped session: ${sessionId}`);
            }
            if (currentSessionId === sessionId) {
                if (wasDead) {
                    // A re-announced current session may have been dropped
                    // while its directory was unavailable. Do not let the
                    // same-id fast path prevent its watcher from returning.
                    sync.invalidate();
                } else {
                    logger.debug(`[SESSION_SCANNER] New session: ${sessionId} is the same as the current session, skipping`);
                }
                return;
            }
            if (!wasDead && finishedSessions.has(sessionId)) {
                logger.debug(`[SESSION_SCANNER] New session: ${sessionId} is already finished, skipping`);
                return;
            }
            if (!wasDead && pendingSessions.has(sessionId)) {
                logger.debug(`[SESSION_SCANNER] New session: ${sessionId} is already pending, skipping`);
                return;
            }
            // When the caller already has these messages (typical for
            // happy-reconnect — the server holds the history from prior
            // turns and metadata.claudeSessionId simply hadn't propagated
            // by the time we built the scanner), pre-mark whatever is on
            // disk so the first invalidate() does not replay the entire
            // file as fresh user prompts. Without this, every previous
            // user message re-appears in the chat after reconnect.
            if (options?.treatExistingAsProcessed) {
                const existing = readNewEntries(sessionId);
                logger.debug(`[SESSION_SCANNER] Pre-marking ${existing.length} existing entries as processed for new session ${sessionId}`);
                for (const entry of existing) {
                    processedEntryKeys.add(entry.key);
                }
            }
            if (currentSessionId) {
                pendingSessions.add(currentSessionId);
            }
            logger.debug(`[SESSION_SCANNER] New session: ${sessionId}`)
            currentSessionId = sessionId;
            sync.invalidate();
        },
    }
}

export type SessionScanner = ReturnType<typeof createSessionScanner>;


//
// Helpers
//

function messageKey(message: RawJSONLines): string {
    if (message.type === 'user') {
        return message.uuid;
    } else if (message.type === 'assistant') {
        return message.uuid;
    } else if (message.type === 'summary') {
        return 'summary: ' + message.leafUuid + ': ' + message.summary;
    } else if (message.type === 'system') {
        return message.uuid;
    } else {
        throw Error() // Impossible
    }
}

function transcriptEventKey(event: ScannerTranscriptEvent): string {
    return `event:${event.uuid}`;
}

/**
 * Parses transcript lines into the scanner's entries: valid conversation messages and recognized
 * side-channel events, silently skipping internal events.
 */
function parseSessionEntries(lines: string[]): SessionLogEntry[] {
    let entries: SessionLogEntry[] = [];
    for (let l of lines) {
        try {
            if (l.trim() === '') {
                continue;
            }
            let message = JSON.parse(l);
            
            // Silently skip known internal Claude Code events
            // These are state/tracking events, not conversation messages
            if (message.type && INTERNAL_CLAUDE_EVENT_TYPES.has(message.type)) {
                continue;
            }

            const transcriptEvent = parseClaudeGoalStatusTranscriptEvent(message);
            if (transcriptEvent) {
                entries.push({
                    kind: 'transcript-event',
                    key: transcriptEventKey(transcriptEvent),
                    event: transcriptEvent,
                });
                continue;
            }
            
            let parsed = RawJSONLinesSchema.safeParse(message);
            if (!parsed.success) {
                // Unknown message types are silently skipped
                continue;
            }
            entries.push({
                kind: 'message',
                key: messageKey(parsed.data),
                message: parsed.data,
            });
        } catch (e) {
            logger.debug(`[SESSION_SCANNER] Error processing message: ${e}`);
            continue;
        }
    }
    return entries;
}
