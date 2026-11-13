/**
 * `happy claude-agent-mirror <agentId>`: mirrors one Mac `claude agents` background session into a
 * Happy session so the same session can be continued from the phone and from the Mac.
 *
 * - The transcript is uploaded to the Happy session (`sessionScanner` + the same upload function the
 *   local mode uses). Lines the phone itself typed are skipped (echo filter), and after a restart
 *   only what comes after the last uploaded uuid goes up (`<happyHomeDir>/claude-agent-mirrors/<id>.json`).
 * - Phone messages are typed into the session through the Mac user's own cmux pane running
 *   `claude attach <id>` when there is one and its screen names this session, else through a
 *   hidden `claude attach` terminal opened at the pane's size
 *   (`inputDelivery`); the phone's stop button presses Esc there; dialogs (permission, question,
 *   plan) are bridged both ways by `permissionBridge`.
 * - `claude agents --json` is polled to follow `/clear` (same agent id, new sessionId) and to end
 *   the mirror when the agent is gone.
 *
 * The mirror only observes and types: it never stops or removes the background session. Delivery and
 * bridge share one terminal at a time (see `serializeTerminalOpens`).
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { basename, join, resolve } from 'node:path';
import { z } from 'zod';
import { ApiClient } from '@/api/api';
import type { ApiSessionClient } from '@/api/apiSession';
import { decodeBase64, encodeBase64 } from '@/api/encryption';
import type { AgentState, Metadata, Session as ApiSession } from '@/api/types';
import { findSessionProjectDir } from '@/claude/utils/path';
import { createAgentCwdTracker } from '@/claude/utils/agentCwd';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import type { PermissionResponse } from '@/claude/utils/permissionHandler';
import { openJsonlTail, type JsonlTail } from '@/claude/utils/jsonlTail';
import { createSessionScanner } from '@/claude/utils/sessionScanner';
import { RawJSONLinesSchema, type RawJSONLines } from '@/claude/types';
import { configuration } from '@/configuration';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import { ensureDaemonRunning } from '@/daemon/ensureDaemonRunning';
import { initialMachineMetadata } from '@/daemon/run';
import { readSettings } from '@/persistence';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { logger } from '@/ui/logger';
import { projectPath } from '../projectPath';
import packageJson from '../../package.json';
import { fetchClaudeAgents, resolveClaudeBinary, takeMirrorHandoff } from './agentsList';
import { isTmuxInstalled, openAttachTerminal, type AttachTerminal } from './attachTerminal';
import { findAgentSurface, guardUserPane, openCmuxTerminal, paneShowsAgent, userPaneSize } from './cmuxTerminal';
import { screenSessionName } from './dialogs';
import { createEchoFilter, createInputDelivery, type DeliveryResult } from './inputDelivery';
import { createPermissionBridge } from './permissionBridge';
import { findToolUseOutcome, parseTranscriptLines, readSessionStatus } from './transcript';
import type { ClaudeAgent, ClaudeAgentStatus } from './types';

/** Exit code when no background agent has the given id. */
const EXIT_AGENT_NOT_FOUND = 2;

const PERMISSION_TICK_MS = 1_000;
const AGENTS_POLL_MS = 3_000;
const KEEP_ALIVE_MS = 2_000;
/** Failed `claude agents` runs in a row before the agent counts as gone. */
const MAX_LIST_FAILURES = 3;
/** How long a shutdown waits for a tick that is still driving a terminal. */
const SHUTDOWN_IDLE_WAIT_MS = 3_000;
/** How long a shutdown waits for a delivery or answer that holds the attach terminal (input wait is 10s). */
const SHUTDOWN_DRAIN_MS = 12_000;
/** At most one "text only" notice per burst of attachments. */
const ATTACHMENT_NOTICE_GAP_MS = 2_000;

const NOTICE_TEXT_ONLY = '이 세션은 텍스트만 받습니다';
const NOTICE_BUSY_INPUT = '맥 화면이 다른 창(권한 질문 등)에 막혀 있어 보내지 못했습니다';
const NOTICE_FAILED = '맥에 보내지 못했습니다';

export type MirrorMetadataBase = {
    host: string;
    machineId: string;
    homeDir: string;
    happyHomeDir: string;
    happyLibDir: string;
    happyToolsDir: string;
};

/** The Happy session key of an agent's mirror; stable so the daemon can find it again. */
export function mirrorTag(agentId: string): string {
    return `claude-agent-${agentId}`;
}

/** Metadata of the mirror session. The app recognises a mirror by `claudeAgentId`. */
export function buildMirrorMetadata(agent: ClaudeAgent, base: MirrorMetadataBase): Metadata {
    return {
        path: agent.cwd,
        cwd: agent.cwd,
        host: base.host,
        version: packageJson.version,
        os: os.platform(),
        machineId: base.machineId,
        homeDir: base.homeDir,
        happyHomeDir: base.happyHomeDir,
        happyLibDir: base.happyLibDir,
        happyToolsDir: base.happyToolsDir,
        startedFromDaemon: true,
        hostPid: process.pid,
        startedBy: 'daemon',
        lifecycleState: 'running',
        lifecycleStateSince: Date.now(),
        flavor: 'claude',
        claudeSessionId: agent.sessionId,
        claudeAgentId: agent.id,
        name: agent.name ?? basename(agent.cwd),
    };
}

/** The entries after the one carrying `lastUuid`; all of them when `lastUuid` is null or not in the list. */
export function entriesAfter(entries: unknown[], lastUuid: string | null): unknown[] {
    if (lastUuid === null) {
        return entries;
    }
    const index = entries.findIndex((entry) => uuidOf(entry) === lastUuid);
    return index === -1 ? entries : entries.slice(index + 1);
}

/**
 * How many transcript lines a mirror uploads at most when it opens: the recent part of the
 * conversation. A background session can run for days (one measured 14,000 lines), and the app
 * shows nothing until it has received and laid out what was uploaded.
 */
export const BACKFILL_LINES = 300;

/** How far back the upload may begin so that the turn under way starts at its prompt. */
export const BACKFILL_MAX_LINES = 1000;

/** A line the user typed (not a tool result, not a stop marker): where a turn begins. */
function isPromptLine(entry: unknown): boolean {
    if (!isRecord(entry) || entry.type !== 'user' || !isRecord(entry.message)) {
        return false;
    }
    const text = typedUserText(entry as RawJSONLines);
    return text !== null && !isInterruptMarker(text);
}

/**
 * Index of the first transcript entry a mirror uploads: right after `lastUuid` when an earlier run
 * uploaded up to it, but never before the recent window of BACKFILL_LINES lines. The window opens
 * at the prompt of the turn it begins in, so no turn shows up cut; when that prompt lies more than
 * BACKFILL_MAX_LINES back, it opens at the first assistant line instead, so no tool result shows up
 * without its call.
 */
export function uploadStart(entries: unknown[], lastUuid: string | null): number {
    const resume = entries.length - entriesAfter(entries, lastUuid).length;
    if (entries.length <= BACKFILL_LINES) {
        return resume;
    }
    const floor = entries.length - BACKFILL_LINES;
    const ceiling = Math.max(0, entries.length - BACKFILL_MAX_LINES);
    let windowStart = floor;
    for (let i = floor; i >= ceiling; i--) {
        if (isPromptLine(entries[i])) {
            windowStart = i;
            break;
        }
    }
    if (windowStart === floor && !isPromptLine(entries[floor])) {
        const reply = entries.findIndex((entry, i) => i >= floor && isRecord(entry) && entry.type === 'assistant');
        windowStart = reply === -1 ? floor : reply;
    }
    return Math.max(resume, windowStart);
}

/** What the next `claude agents` listing means for a mirror that follows `currentSessionId`. */
export function decideAgentChange(
    agents: ClaudeAgent[],
    agentId: string,
    currentSessionId: string,
): 'same' | 'gone' | { switchTo: string } {
    const agent = agents.find((candidate) => candidate.id === agentId);
    if (agent === undefined) {
        return 'gone';
    }
    return agent.sessionId === currentSessionId ? 'same' : { switchTo: agent.sessionId };
}

/**
 * Wraps `open` so only one terminal exists at a time: a call waits until the terminal handed out
 * before it was closed. The lock is released exactly once per terminal, also when the underlying
 * `close` throws, and when opening fails. `openUser` (the Mac user's own cmux pane, or null when
 * there is none) takes the same lock through `.user()`, so a pane and a tmux terminal are never
 * open together; with no pane found the lock is released at once.
 */
export type SerializedOpen = (() => Promise<AttachTerminal>) & {
    /** The user's pane under the same lock; null (lock released) when there is none or no `openUser` was given. */
    user(): Promise<AttachTerminal | null>;
    /** True once every terminal opened or queued so far is closed; false if that takes longer than `timeoutMs`. */
    drain(timeoutMs: number): Promise<boolean>;
};

export function serializeTerminalOpens(open: () => Promise<AttachTerminal>, openUser?: () => Promise<AttachTerminal | null>): SerializedOpen {
    let tail: Promise<void> = Promise.resolve();
    /** Waits for the lock, runs `opener`, and hands out its terminal with a `close` that releases the lock. */
    async function locked<T extends AttachTerminal | null>(opener: () => Promise<T>): Promise<T> {
        const previous = tail;
        let release: () => void = () => undefined;
        tail = new Promise<void>((resolveTail) => {
            release = resolveTail;
        });
        await previous;
        let terminal: T;
        try {
            terminal = await opener();
        } catch (error) {
            release();
            throw error;
        }
        if (terminal === null) {
            release();
            return terminal;
        }
        const opened: AttachTerminal = terminal;
        let released = false;
        return {
            ...opened,
            close: async () => {
                try {
                    await opened.close();
                } finally {
                    if (!released) {
                        released = true;
                        release();
                    }
                }
            },
        } as T;
    }
    const serialized = (): Promise<AttachTerminal> => locked(open);
    const user = async (): Promise<AttachTerminal | null> => (openUser === undefined ? null : locked(openUser));
    const drain = async (timeoutMs: number): Promise<boolean> => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const observed = tail;
            const left = deadline - Date.now();
            let timer: ReturnType<typeof setTimeout> | undefined;
            const timedOut = new Promise<false>((resolveTimeout) => {
                timer = setTimeout(() => resolveTimeout(false), Math.max(left, 0));
            });
            const drained = await Promise.race([observed.then(() => true as const), timedOut]);
            clearTimeout(timer);
            if (!drained) {
                return false;
            }
            // An open that was waiting behind the terminal may have queued a newer tail by now.
            await new Promise<void>((resolveTick) => setImmediate(resolveTick));
            if (observed === tail) {
                return true;
            }
        }
    };
    return Object.assign(serialized, { user, drain });
}

/** True when a reused session's metadata could not be decrypted: the key is not ours, so nothing may be written or reported. */
export function shouldAbortReuse(metadata: unknown): boolean {
    return metadata === null || metadata === undefined;
}

/** Metadata of a session being (re)used by this mirror: running again, on the agent's current session and folder. */
export function resetMirrorMetadata(metadata: Metadata, agent: ClaudeAgent, now: number): Metadata {
    return {
        ...metadata,
        claudeSessionId: agent.sessionId,
        claudeAgentId: agent.id,
        cwd: agent.cwd,
        // The Mac session can be renamed while no mirror runs; the app has no rename of its own to keep.
        name: agent.name ?? metadata.name,
        lifecycleState: 'running',
        lifecycleStateSince: now,
        archivedBy: undefined,
        archiveReason: undefined,
    };
}

const STALE_REQUEST_REASON = 'Previous mirror exited before responding';

/**
 * Closes the cards a previous mirror process left open (the bridge starts empty and could never
 * finish them). A card whose tool call was answered on the Mac in the meantime gets that answer
 * from the transcript; the rest are canceled.
 */
export function settleStaleRequests(state: AgentState, entries: unknown[], now: number): AgentState {
    const completedRequests = { ...state.completedRequests };
    for (const [key, request] of Object.entries(state.requests ?? {})) {
        const outcome = findToolUseOutcome(entries, key);
        completedRequests[key] = {
            ...request,
            completedAt: now,
            ...(outcome === null
                ? { status: 'canceled' as const, reason: STALE_REQUEST_REASON }
                : { status: outcome.decision, decision: outcome.decision, toolUseId: key }),
        };
    }
    return { ...state, requests: {}, completedRequests };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function uuidOf(entry: unknown): string | null {
    return isRecord(entry) && typeof entry.uuid === 'string' ? entry.uuid : null;
}

/**
 * Whether typed text is one of the markers Claude Code writes as a user line when a turn is
 * stopped (Esc, or a denied permission). The Mac shows it as "Interrupted"; on the phone it would
 * read as something the user said.
 */
export function isInterruptMarker(text: string): boolean {
    return /^\[Request interrupted by user( for tool use)?\]$/.test(text.trim());
}

/**
 * The model a main-agent assistant line ran on, as the app's `metadata.runningModel`. Null for
 * side-chain lines (a sub-agent may run another model), Claude Code's `<synthetic>` lines, and
 * lines that name none.
 */
export function transcriptLineModel(line: unknown): string | null {
    if (!isRecord(line) || line.type !== 'assistant' || line.isSidechain === true || !isRecord(line.message)) {
        return null;
    }
    const model = typeof line.message.model === 'string' ? line.message.model.trim() : '';
    return model.length > 0 && model !== '<synthetic>' ? model : null;
}

/**
 * The text of a transcript line the user typed: a plain string, or text blocks only.
 * Null for anything else (tool results, images, side-chain and meta lines).
 */
function typedUserText(message: RawJSONLines): string | null {
    if (message.type !== 'user' || message.isSidechain === true || message.isMeta === true) {
        return null;
    }
    const content: unknown = message.message.content;
    if (typeof content === 'string') {
        return content;
    }
    if (!Array.isArray(content) || content.length === 0 || !content.every((block) => isRecord(block) && block.type === 'text' && typeof block.text === 'string')) {
        return null;
    }
    return content.map((block) => (block as { text: string }).text).join('\n');
}

/**
 * Whether any of `skippedTexts` (the phone's messages left at the end of the session's log, sent
 * while no mirror ran) was never typed on the Mac: it is not among the transcript's typed user
 * lines. Whitespace runs are collapsed on both sides. A message typed by a previous mirror whose
 * reply had not been uploaded yet is in the transcript, so it is not reported.
 */
export function anyUndelivered(skippedTexts: string[], entries: unknown[]): boolean {
    const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();
    const typed = new Set(entries.flatMap((entry) => {
        const parsed = RawJSONLinesSchema.safeParse(entry);
        const text = parsed.success ? typedUserText(parsed.data) : null;
        return text === null ? [] : [normalize(text)];
    }));
    return skippedTexts.some((text) => !typed.has(normalize(text)));
}

const mirrorStateSchema = z.object({ happySessionId: z.string(), lastUuid: z.string().nullable() });

type MirrorState = z.infer<typeof mirrorStateSchema>;

function mirrorStatePath(agentId: string): string {
    return join(configuration.happyHomeDir, 'claude-agent-mirrors', `${agentId}.json`);
}

/** The saved mirror state; null when the file is missing or broken. */
function readMirrorState(agentId: string): MirrorState | null {
    try {
        const parsed = mirrorStateSchema.safeParse(JSON.parse(readFileSync(mirrorStatePath(agentId), 'utf8')));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

function writeMirrorState(agentId: string, state: MirrorState): void {
    try {
        const file = mirrorStatePath(agentId);
        mkdirSync(join(configuration.happyHomeDir, 'claude-agent-mirrors'), { recursive: true, mode: 0o700 });
        writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
        chmodSync(file, 0o600);
    } catch (error) {
        logger.debug('[MIRROR] Could not save the mirror state', error);
    }
}

/**
 * Reads a transcript for the bridge (once a second) and the mirror's own checks, parsing only the
 * lines appended since the last read: long sessions have transcripts of hundreds of megabytes.
 * The returned array is never changed afterwards; new lines come in a new array.
 */
function createTranscriptReader(cwd: string): { read(sessionId: string): unknown[] } {
    let cached: { file: string; tail: JsonlTail; entries: unknown[] } | null = null;
    return {
        read(sessionId) {
            const file = join(findSessionProjectDir(cwd, sessionId), `${sessionId}.jsonl`);
            if (cached === null || cached.file !== file) {
                cached = { file, tail: openJsonlTail(file), entries: [] };
            }
            const { lines, reset } = cached.tail.readNew();
            if (reset) {
                cached.entries = [];
            }
            if (lines.length > 0) {
                cached.entries = cached.entries.concat(parseTranscriptLines(lines));
            }
            return cached.entries;
        },
    };
}

/** Runs `job` every `ms`, never overlapping itself; `idle()` resolves when no run is in flight. */
function everyWithoutOverlap(ms: number, job: () => Promise<void>): { stop(): void; idle(): Promise<void> } {
    let running: Promise<void> | null = null;
    const timer = setInterval(() => {
        if (running !== null) {
            return;
        }
        running = job()
            .catch((error: unknown) => logger.debug('[MIRROR] Loop job failed', error))
            .finally(() => {
                running = null;
            });
    }, ms);
    return {
        stop: () => clearInterval(timer),
        idle: async () => {
            await running;
        },
    };
}

const sleep = (ms: number): Promise<void> => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

/**
 * Connects to the Happy session of `agentId`: the one named by `HAPPY_RECONNECT_*` (the daemon
 * reopening a known mirror), else the one for `mirrorTag`.
 */
async function connectSession(api: ApiClient, metadata: Metadata, agentId: string): Promise<{ response: ApiSession | null; reconnected: boolean }> {
    const reconnectSessionId = process.env.HAPPY_RECONNECT_SESSION_ID;
    const reconnectKeyBase64 = process.env.HAPPY_RECONNECT_ENCRYPTION_KEY;
    const reconnectVariant = process.env.HAPPY_RECONNECT_ENCRYPTION_VARIANT as 'legacy' | 'dataKey' | undefined;
    if (reconnectSessionId && reconnectKeyBase64 && reconnectVariant) {
        logger.debug(`[MIRROR] Reconnecting to Happy session ${reconnectSessionId}`);
        return {
            reconnected: true,
            response: {
                id: reconnectSessionId,
                seq: parseInt(process.env.HAPPY_RECONNECT_SEQ || '0', 10),
                encryptionKey: decodeBase64(reconnectKeyBase64),
                encryptionVariant: reconnectVariant,
                metadata,
                metadataVersion: parseInt(process.env.HAPPY_RECONNECT_METADATA_VERSION || '0', 10),
                agentState: {},
                agentStateVersion: parseInt(process.env.HAPPY_RECONNECT_AGENT_STATE_VERSION || '0', 10),
            },
        };
    }
    return { reconnected: false, response: await api.getOrCreateSession({ tag: mirrorTag(agentId), metadata, state: {} }) };
}

/**
 * Runs the mirror until the agent is gone or the process is told to stop.
 * Exits the process with code 2 when no background agent has `opts.agentId`.
 */
export async function runClaudeAgentMirror(opts: { agentId: string }): Promise<void> {
    const { agentId } = opts;
    logger.debug(`[MIRROR] Starting mirror for agent ${agentId}`);

    // Spawned by the daemon, the mirror is handed what the daemon just found out (the `claude`
    // binary, tmux present, the listing, the daemon itself running and its machine registered),
    // so the phone's open does not wait for all of it a second time. Run by hand, it asks itself.
    const handoff = takeMirrorHandoff(process.env);
    const fromDaemon = handoff !== null && handoff.agents.some((candidate) => candidate.id === agentId) ? handoff : null;
    const claudePath = fromDaemon?.claudePath ?? (await resolveClaudeBinary());
    if (claudePath === null) {
        console.error('claude was not found in the login shell. Install Claude Code first.');
        process.exit(1);
    }
    if (fromDaemon === null && !(await isTmuxInstalled())) {
        console.error('tmux is required to mirror a background session.');
        process.exit(1);
    }

    const initialAgents = fromDaemon?.agents ?? await fetchClaudeAgents(claudePath).catch((error: unknown): ClaudeAgent[] => {
        logger.debug('[MIRROR] claude agents failed at startup', error);
        return [];
    });
    const found = initialAgents.find((candidate) => candidate.id === agentId);
    if (found === undefined) {
        console.error(`No background agent with id ${agentId}.`);
        process.exit(EXIT_AGENT_NOT_FOUND);
    }
    let agent: ClaudeAgent = found;
    /** The latest `claude agents` listing: the cmux pane check compares the session names in it. */
    let latestAgents: ClaudeAgent[] = initialAgents;
    let currentSessionId = agent.sessionId;

    const { credentials } = await authAndSetupMachineIfNeeded();
    if (fromDaemon === null) {
        await ensureDaemonRunning();
    }
    const api = await ApiClient.create(credentials);
    const settings = await readSettings();
    const machineId = settings?.machineId;
    if (!machineId) {
        console.error('No machine ID found in settings. Run `happy auth login` first.');
        process.exit(1);
    }
    if (fromDaemon === null) {
        await api.getOrCreateMachine({ machineId, metadata: initialMachineMetadata });
    }

    const metadata = buildMirrorMetadata(agent, {
        host: os.hostname(),
        machineId,
        homeDir: os.homedir(),
        happyHomeDir: configuration.happyHomeDir,
        happyLibDir: projectPath(),
        happyToolsDir: resolve(projectPath(), 'tools', 'unpacked'),
    });
    const connected = await connectSession(api, metadata, agentId);
    const { reconnected } = connected;
    let { response } = connected;
    if (response !== null && !reconnected && fromDaemon !== null && shouldAbortReuse(response.metadata)) {
        // The daemon starts a fresh mirror only when it holds no key for this agent's session, so the
        // tagged session's key is gone (its mirror died before the daemon stored it). No mirror can
        // write to it again, so it is deleted and the tag gets a new session.
        logger.debug(`[MIRROR] Session ${response.id} cannot be opened with any stored key: replacing it`);
        if (await api.deleteSession(response.id)) {
            response = await api.getOrCreateSession({ tag: mirrorTag(agentId), metadata, state: {} });
        }
    }
    if (response === null) {
        console.error('Could not reach the Happy server.');
        process.exit(1);
    }
    if (!reconnected && shouldAbortReuse(response.metadata)) {
        // The server returned an existing session for this tag, but its metadata does not decrypt
        // with the key this process just made. Reporting that key to the daemon would poison the
        // stored one, so nothing is reported or written.
        console.error(`The Happy session for agent ${agentId} already exists but cannot be opened without its stored key. Open it from the app (the daemon reconnects with the stored key).`);
        process.exit(1);
    }
    logger.debug(`[MIRROR] Happy session ${response.id}`);

    try {
        const result = await notifyDaemonSessionStarted(response.id, metadata, {
            encryptionKey: encodeBase64(response.encryptionKey),
            encryptionVariant: response.encryptionVariant,
            seq: response.seq,
            metadataVersion: response.metadataVersion,
            agentStateVersion: response.agentStateVersion,
        });
        if (result.error) {
            logger.debug('[MIRROR] Failed to report to daemon (may not be running):', result.error);
        }
    } catch (error) {
        logger.debug('[MIRROR] Failed to report to daemon (may not be running):', error);
    }

    const priorLifecycle = reconnected ? null : response.metadata?.lifecycleState;
    const session: ApiSessionClient = api.sessionSyncClient(response);
    // The log is uploaded in one go when the mirror opens; the app's newest page must hold its end.
    session.uploadOldestFirst();
    const notice =(message: string): void => session.sendSessionEvent({ type: 'message', message });

    // One parse of the transcript serves the start-up checks below and the bridge after them.
    const transcripts = createTranscriptReader(agent.cwd);
    // Whatever the phone sent before this process started must never be typed into the Mac session.
    // The phone showed it as sent, so say once that it did not reach the Mac.
    session.skipExistingMessages((texts) => {
        if (anyUndelivered(texts, transcripts.read(currentSessionId))) {
            logger.debug(`[claude-agent] ${texts.length} phone message(s) sent while no mirror ran were not typed on the Mac`);
            notice(NOTICE_FAILED);
        }
    });
    if (reconnected || priorLifecycle === 'archived' || priorLifecycle === 'archiveRequested') {
        session.suppressNextArchiveSignal();
    }
    session.updateMetadata((meta) => resetMirrorMetadata(meta, agent, Date.now()));
    // Cards left open by a previous mirror process can never be answered (the bridge starts empty).
    const entriesAtStart = transcripts.read(currentSessionId);
    session.updateAgentState((state) => ({ ...settleStaleRequests(state, entriesAtStart, Date.now()), controlledByUser: false }));

    let stopping = false;
    // One terminal at a time across delivery and bridge; once stopping, no new one is opened
    // (a queued send then fails and the phone is told).
    // The user's own cmux pane running `claude attach <agentId>` shares that lock; it is looked up
    // anew each time (panes come and go) and only ever read from and typed into, never closed.
    // The pane is used only while its screen names this agent's session and no other listed
    // agent's (the user can open another agent inside the same attach); else tmux is used.
    // A private tmux attach is opened at the pane's size so Claude Code does not redraw the pane.
    let userSurface: string | null = null;
    let refusedPaneName: string | null = null;
    const showsThisAgent = (screen: string): boolean => {
        const shows = paneShowsAgent(screen, agentId, latestAgents);
        const name = shows ? null : (screenSessionName(screen) ?? '(none)');
        if (name !== null && name !== refusedPaneName) {
            logger.debug(`[claude-agent] cmux ${userSurface ?? ''} shows session "${name}", not this agent's: using tmux`);
        }
        refusedPaneName = name;
        return shows;
    };
    const lockedOpen = serializeTerminalOpens(
        async () => openAttachTerminal([claudePath, 'attach', agentId], (await userPaneSize(agentId)) ?? {}),
        async () => {
            userSurface = await findAgentSurface(agentId);
            return userSurface === null ? null : guardUserPane(openCmuxTerminal(userSurface), showsThisAgent);
        },
    );
    const openTerminal = async (): Promise<AttachTerminal> => {
        if (stopping) {
            throw new Error('The mirror is stopping');
        }
        return lockedOpen();
    };
    const openUserTerminal = async (): Promise<AttachTerminal | null> => (stopping ? null : lockedOpen.user());
    const onRoute = (use: 'input' | 'interrupt' | 'answer', route: 'cmux' | 'tmux'): void => {
        logger.debug(`[claude-agent] ${use} via ${route === 'cmux' ? `cmux ${userSurface ?? ''}`.trim() : 'tmux'}`);
    };
    const echo = createEchoFilter();
    const delivery = createInputDelivery({ openTerminal, openUserTerminal, onRoute, echo });

    let lastStatus: ClaudeAgentStatus | null = null;
    const bridge = createPermissionBridge({
        readStatus: () => readSessionStatus(agent.pid),
        readEntries: () => transcripts.read(currentSessionId),
        openTerminal,
        openUserTerminal,
        onRoute,
        updateAgentState: (update: (state: AgentState) => AgentState) => session.updateAgentState(update),
        notifyPermission: (tool) => {
            api.push().sendSessionNotification({
                kind: 'permission',
                metadata: session.getMetadata(),
                data: { sessionId: session.sessionId, tool, type: 'permission_request', provider: 'claude' },
            });
        },
        now: () => Date.now(),
        cwd: agent.cwd,
    });

    // Upload: only the recent part of the log, skipping what a previous run already uploaded and
    // what the phone typed itself. Lines before the start count as uploaded so the scanner passes them.
    const saved = readMirrorState(agentId);
    let lastUuid: string | null = saved?.happySessionId === response.id ? saved.lastUuid : null;
    const alreadyUploaded = new Set<string>();
    const skipBeforeUploadStart = (sessionId: string, after: string | null): void => {
        const entries = transcripts.read(sessionId);
        for (const entry of entries.slice(0, uploadStart(entries, after))) {
            const uuid = uuidOf(entry);
            if (uuid !== null) {
                alreadyUploaded.add(uuid);
            }
        }
    };
    skipBeforeUploadStart(currentSessionId, lastUuid);
    const agentCwd = createAgentCwdTracker({
        initial: agent.cwd,
        publish: (cwd) => session.updateMetadata((current) => ({ ...current, cwd })),
    });
    // The model the agent runs on, for the app's model label; already-uploaded lines count too.
    let runningModel: string | null = null;
    const scanner = await createSessionScanner({
        sessionId: null,
        workingDirectory: agent.cwd,
        searchOtherProjects: true,
        onMessage: (message) => {
            agentCwd.observe(message);
            const model = transcriptLineModel(message);
            if (model !== null && model !== runningModel) {
                runningModel = model;
                session.updateMetadata((current) => ({ ...current, runningModel: model }));
            }
            const uuid = message.type === 'summary' ? null : message.uuid;
            if (uuid !== null && alreadyUploaded.has(uuid)) {
                return;
            }
            const typed = typedUserText(message);
            if (typed !== null && echo.shouldSkip(typed)) {
                return;
            }
            if (typed !== null && isInterruptMarker(typed)) {
                // Ends the turn as the marker's user line would have, without a user bubble.
                session.closeClaudeSessionTurn('completed');
            } else {
                void session.sendClaudeSessionMessageFromLocalTranscript(message);
            }
            if (uuid !== null) {
                lastUuid = uuid;
                writeMirrorState(agentId, { happySessionId: response.id, lastUuid });
            }
        },
    });
    await scanner.onNewSession(currentSessionId);

    // Phone to Mac.
    const reportDelivery = (result: DeliveryResult): void => {
        if (result === 'busy-input') {
            notice(NOTICE_BUSY_INPUT);
        } else if (result === 'failed') {
            notice(NOTICE_FAILED);
        }
    };
    session.onUserMessage((message) => {
        if (stopping) {
            notice(NOTICE_FAILED);
            return;
        }
        void delivery.send(message.content.text).then(reportDelivery, () => notice(NOTICE_FAILED));
    });
    let lastAttachmentNotice = 0;
    session.onFileEvent(() => {
        if (Date.now() - lastAttachmentNotice >= ATTACHMENT_NOTICE_GAP_MS) {
            lastAttachmentNotice = Date.now();
            notice(NOTICE_TEXT_ONLY);
        }
    });
    session.rpcHandlerManager.registerHandler('abort', async () => {
        if (!stopping) {
            await delivery.interrupt();
        }
    });
    session.rpcHandlerManager.registerHandler<PermissionResponse, void>('permission', async (answer) => {
        if (!stopping) {
            await bridge.answer(answer);
        }
    });

    const permissionLoop = everyWithoutOverlap(PERMISSION_TICK_MS, async () => {
        lastStatus = readSessionStatus(agent.pid);
        await bridge.tick();
    });
    let listFailures = 0;
    const agentsLoop = everyWithoutOverlap(AGENTS_POLL_MS, async () => {
        let agents: ClaudeAgent[];
        try {
            agents = await fetchClaudeAgents(claudePath);
        } catch (error) {
            listFailures += 1;
            logger.debug(`[MIRROR] claude agents failed (${listFailures}/${MAX_LIST_FAILURES})`, error);
            if (listFailures >= MAX_LIST_FAILURES) {
                void shutdown({ archive: true, reason: 'Background session ended', code: 0 });
            }
            return;
        }
        listFailures = 0;
        const change = decideAgentChange(agents, agentId, currentSessionId);
        if (change === 'gone') {
            void shutdown({ archive: true, reason: 'Background session ended', code: 0 });
            return;
        }
        const listed = agents.find((candidate) => candidate.id === agentId) ?? agent;
        if (listed.name !== null && listed.name !== agent.name) {
            // Renamed on the Mac while this mirror runs: the phone shows the new name.
            const name = listed.name;
            session.updateMetadata((current) => ({ ...current, name }));
        }
        agent = listed;
        latestAgents = agents;
        if (change !== 'same') {
            logger.debug(`[MIRROR] Session changed ${currentSessionId} -> ${change.switchTo}`);
            currentSessionId = change.switchTo;
            skipBeforeUploadStart(change.switchTo, null);
            await scanner.onNewSession(change.switchTo);
            session.updateMetadata((current) => ({ ...current, claudeSessionId: change.switchTo }));
        }
    });
    const keepAliveTimer = setInterval(() => session.keepAlive(lastStatus === 'busy', 'remote'), KEEP_ALIVE_MS);
    session.keepAlive(false, 'remote');

    async function shutdown(how: { archive: boolean; reason?: string; code: number }): Promise<void> {
        if (stopping) {
            return;
        }
        stopping = true;
        logger.debug(`[MIRROR] Shutting down (archive=${how.archive})`);
        permissionLoop.stop();
        agentsLoop.stop();
        clearInterval(keepAliveTimer);
        try {
            // A tick may still hold the terminal: let it close its tmux session first.
            await Promise.race([Promise.all([permissionLoop.idle(), agentsLoop.idle()]), sleep(SHUTDOWN_IDLE_WAIT_MS)]);
            // A delivery or answer may still hold the attach terminal: let it close its tmux session.
            if (!(await lockedOpen.drain(SHUTDOWN_DRAIN_MS))) {
                logger.debug('[MIRROR] A terminal was still open at shutdown');
            }
            await scanner.cleanup();
            if (how.archive) {
                session.updateMetadata((current) => ({
                    ...current,
                    lifecycleState: 'archived',
                    lifecycleStateSince: Date.now(),
                    archivedBy: 'cli',
                    archiveReason: how.reason ?? 'User terminated',
                }));
            }
            session.sendSessionDeath();
            await api.deactivateSession(session.sessionId).catch((error: unknown) => logger.debug('[MIRROR] deactivateSession failed', error));
            await session.flush();
            await session.close();
            process.exit(how.code);
        } catch (error) {
            logger.debug('[MIRROR] Error during shutdown', error);
            process.exit(1);
        }
    }

    session.on('archived', () => void shutdown({ archive: true, code: 0 }));
    registerKillSessionHandler(session.rpcHandlerManager, () => shutdown({ archive: true, code: 0 }));
    // Ctrl-C and SIGTERM mean "come back later": the mirror session stays visible.
    process.on('SIGTERM', () => void shutdown({ archive: false, code: 0 }));
    process.on('SIGINT', () => void shutdown({ archive: false, code: 0 }));
    process.on('uncaughtException', (error) => {
        logger.debug('[MIRROR] Uncaught exception', error);
        void shutdown({ archive: true, reason: 'Mirror crashed', code: 1 });
    });
    process.on('unhandledRejection', (reason) => {
        logger.debug('[MIRROR] Unhandled rejection', reason);
        void shutdown({ archive: true, reason: 'Mirror crashed', code: 1 });
    });

    // Keep the process alive until shutdown calls process.exit.
    await new Promise<never>(() => undefined);
}
