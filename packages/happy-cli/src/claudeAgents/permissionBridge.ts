/**
 * Publishes a background Claude session's open dialog (permission prompt, AskUserQuestion,
 * ExitPlanMode) as a Happy permission request, and answers it from the phone by pressing keys in
 * a hidden `claude attach` terminal.
 *
 * `tick` watches the session: while it is `waiting` it reads the attach screen and publishes the
 * dialog as `agentState.requests[key]`. The key is the transcript `tool_use` id when the
 * transcript holds an unanswered call that matches the screen, else `screen:<dialogFingerprint>`
 * (Claude Code 2.1.319 often writes AskUserQuestion and some Write/Edit calls only after they are
 * answered). When the dialog goes away, the request is completed from the transcript's
 * `tool_result`, so an answer given on the Mac shows on the phone as approved or denied.
 *
 * `answer` types the phone's answer only when it is provably the same dialog:
 *   ① the session is still `waiting`;
 *   ② the dialog fingerprint equals the one stored when the request was made, and for a
 *      transcript-keyed request the pending `tool_use` id is still that id;
 *   ③ the screen shows a dialog of the request's kind (permission / question / plan);
 *   ④ the dialog is about that call: `screenMatchesPending` for a transcript-keyed request, or the
 *      dialog read off the screen again equal to the card the phone was shown for `screen:` keys.
 * Then each key is pressed on its own, `DIALOG_KEY_GAP_MS` apart. If any check fails or the
 * answer has no key mapping (free text, unknown dialog), nothing is pressed and the request is
 * completed as `canceled` with `reason: 'answer-on-mac'`.
 * Before every key after the first the screen is read again: the session must still be waiting
 * on a dialog of the same kind (for questions, the same tab names), and the committing key must
 * see its screen (the review screen before a question's final `1`; before a plan rejection's
 * Enter, option 3 focused showing the typed feedback, or the empty placeholder when there is no
 * reason). Otherwise no further key is pressed and the request is completed as `canceled` with
 * `reason: 'typing-failed'`.
 *
 * `tick` and `answer` run one at a time. Each opens its own terminal and closes it in `finally`
 * (close errors swallowed), so a caller may serialise terminal use around them.
 */

import { isDeepStrictEqual } from 'node:util';
import type { AgentState } from '@/api/types';
import type { PermissionResponse } from '@/claude/utils/permissionHandler';
import type { AttachKey, AttachTerminal } from './attachTerminal';
import {
    classifyScreen,
    DIALOG_KEY_GAP_MS,
    dialogFingerprint,
    keysForPermission,
    keysForPlan,
    keysForQuestion,
    PLAN_FEEDBACK,
    readDialogFromScreen,
    readDialogProgress,
    screenMatchesPending,
    type DialogKind,
    type DialogProgress,
} from './dialogs';
import { findPendingToolUse, findToolUseOutcome, type PendingToolUse, type ToolUseOutcome } from './transcript';
import type { ClaudeAgentStatus } from './types';

export type PermissionBridgeDeps = {
    readStatus(): ClaudeAgentStatus | null;
    readEntries(): unknown[];
    openTerminal(): Promise<AttachTerminal>;
    updateAgentState(update: (s: AgentState) => AgentState): void;
    notifyPermission(tool: string): void;
    now(): number;
    /**
     * The agent's launch cwd. Dialogs show paths relative to Claude's current cwd, which is read
     * from the transcript; this is the fallback when no transcript entry carries one.
     */
    cwd: string;
    /** Pause between key presses. Injectable for tests; defaults to a timer. */
    sleep?: (ms: number) => Promise<void>;
};

export type PermissionBridge = {
    tick(): Promise<void>;
    /**
     * `'typed'` once a key was pressed, `'refused'` when nothing was. Never throws. If pressing
     * fails after the first key, the request is completed as `canceled` with
     * `reason: 'typing-failed'` and `'typed'` is returned: the dialog may be half answered, so the
     * card must not be answerable again.
     */
    answer(response: PermissionResponse): Promise<'typed' | 'refused'>;
};

type Completion = {
    status: 'canceled' | 'denied' | 'approved';
    decision?: 'approved' | 'denied';
    reason?: string;
    mode?: PermissionResponse['mode'];
};

type OpenRequest = {
    key: string;
    tool: string;
    input: Record<string, unknown>;
    createdAt: number;
    /** The transcript `tool_use` id of a transcript-keyed request, null for `screen:` keys. */
    toolUseId: string | null;
    /** The screen the request was made from. */
    screen: string;
    fingerprint: string;
    /** Transcript length when the request was made: a Mac answer to a `screen:` request is looked for after it. */
    transcriptLength: number;
    /** Ticks in a row, none of them while the session was busy, that found the dialog gone but no outcome. */
    misses: number;
    /** A phone answer was refused: it stays completed as `answer-on-mac`, unless the Mac answer shows up. */
    refused: boolean;
};

/**
 * One key or one typed text. Every step after the first runs only when the screen re-read just
 * before it still shows the same dialog (see `answer`) and, when set, passes `expect`.
 */
type Step = ({ key: AttachKey } | { text: string }) & { expect?: (progress: DialogProgress) => boolean };

/** Ticks without an outcome before a request whose dialog is gone is canceled. */
const MAX_MISSES = 5;
const ANSWER_ON_MAC = 'answer-on-mac';
const TYPING_FAILED = 'typing-failed';
const ANSWERABLE: readonly DialogKind[] = ['permission', 'question', 'plan'];

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The dialog kind a tool is asked about in; `none` for `Unknown`, which never matches. */
function kindOfTool(tool: string): DialogKind {
    switch (tool) {
        case 'AskUserQuestion':
            return 'question';
        case 'ExitPlanMode':
            return 'plan';
        case 'Unknown':
            return 'none';
        default:
            return 'permission';
    }
}

/** Every `tool_use` block in `entries`, with the cwd of the line that carries it. */
function toolUsesOf(entries: unknown[]): Array<{ toolUse: PendingToolUse; cwd: string | null }> {
    return entries.flatMap((entry) => {
        if (!isRecord(entry) || entry.type !== 'assistant' || !isRecord(entry.message) || !Array.isArray(entry.message.content)) {
            return [];
        }
        const cwd = typeof entry.cwd === 'string' && entry.cwd.length > 0 ? entry.cwd : null;
        return entry.message.content
            .filter((block): block is Record<string, unknown> => isRecord(block) && block.type === 'tool_use' && typeof block.id === 'string')
            .map((block) => ({
                toolUse: {
                    id: block.id as string,
                    name: typeof block.name === 'string' ? block.name : '',
                    input: isRecord(block.input) ? block.input : {},
                },
                cwd,
            }));
    });
}

/**
 * Claude's cwd for the call `toolUseId`: the `cwd` of the transcript line carrying it, else of the
 * latest line that has one, else `fallback`.
 */
function cwdFor(entries: unknown[], toolUseId: string | null, fallback: string): string {
    const carrying = toolUseId === null ? undefined : toolUsesOf(entries).find(({ toolUse }) => toolUse.id === toolUseId)?.cwd;
    if (typeof carrying === 'string') {
        return carrying;
    }
    const latest = [...entries].reverse().find((entry) => isRecord(entry) && typeof entry.cwd === 'string' && entry.cwd.length > 0);
    return isRecord(latest) && typeof latest.cwd === 'string' ? latest.cwd : fallback;
}

function answersOf(response: PermissionResponse): Record<string, string> | null {
    const answers = response.updatedInput?.answers;
    return isRecord(answers) && Object.values(answers).every((value) => typeof value === 'string')
        ? (answers as Record<string, string>)
        : null;
}

async function closeQuietly(terminal: AttachTerminal): Promise<void> {
    try {
        await terminal.close();
    } catch {
        // The answer is decided by the keys, not by closing the terminal.
    }
}

export function createPermissionBridge(deps: PermissionBridgeDeps): PermissionBridge {
    const sleep = deps.sleep ?? defaultSleep;
    const open = new Map<string, OpenRequest>();
    /** Transcript length when each key was completed: a `screen:` key is published again only after it grew. */
    const completedAt = new Map<string, number>();
    /** The last screen read while waiting: skipped while the same request is open and the transcript is unchanged. */
    let lastSeen: { key: string; transcriptLength: number } | null = null;
    let queue: Promise<unknown> = Promise.resolve();

    function enqueue<T>(job: () => Promise<T>): Promise<T> {
        const run = queue.then(job, job);
        queue = run.catch(() => undefined);
        return run;
    }

    /** Moves `request` from `requests` to `completedRequests` with `completion`. */
    function complete(request: OpenRequest, completion: Completion, transcriptLength: number): void {
        open.delete(request.key);
        completedAt.set(request.key, transcriptLength);
        deps.updateAgentState((state) => {
            const requests = { ...state.requests };
            delete requests[request.key];
            return {
                ...state,
                requests,
                completedRequests: {
                    ...state.completedRequests,
                    [request.key]: {
                        tool: request.tool,
                        arguments: request.input,
                        createdAt: request.createdAt,
                        completedAt: deps.now(),
                        ...completion,
                        ...(request.toolUseId === null ? {} : { toolUseId: request.toolUseId }),
                    },
                },
            };
        });
    }

    function refuse(request: OpenRequest): 'refused' {
        request.refused = true;
        deps.updateAgentState((state) => {
            const requests = { ...state.requests };
            delete requests[request.key];
            return {
                ...state,
                requests,
                completedRequests: {
                    ...state.completedRequests,
                    [request.key]: {
                        tool: request.tool,
                        arguments: request.input,
                        createdAt: request.createdAt,
                        completedAt: deps.now(),
                        status: 'canceled',
                        reason: ANSWER_ON_MAC,
                        ...(request.toolUseId === null ? {} : { toolUseId: request.toolUseId }),
                    },
                },
            };
        });
        return 'refused';
    }

    /** How the request's call was answered, from the transcript; null while it has no result. */
    function outcomeOf(request: OpenRequest, entries: unknown[]): ToolUseOutcome | null {
        if (request.toolUseId !== null) {
            return findToolUseOutcome(entries, request.toolUseId);
        }
        const later = toolUsesOf(entries.slice(request.transcriptLength)).find(({ toolUse, cwd }) =>
            screenMatchesPending(request.screen, toolUse, cwd ?? cwdFor(entries, null, deps.cwd)),
        );
        return later === undefined ? null : findToolUseOutcome(entries, later.toolUse.id);
    }

    /**
     * The request's dialog is gone: complete it from the transcript, or cancel after `MAX_MISSES` tries.
     * A tick while the session is `busy` is not a miss: after an approval on the Mac the tool is
     * running and its `tool_result` is written only when it finishes, however long that takes.
     */
    function settle(request: OpenRequest, entries: unknown[], status: ClaudeAgentStatus | null): void {
        const outcome = outcomeOf(request, entries);
        if (outcome !== null) {
            complete(request, { status: outcome.decision, decision: outcome.decision }, entries.length);
            return;
        }
        if (status === 'busy') {
            return;
        }
        request.misses += 1;
        if (request.misses < MAX_MISSES) {
            return;
        }
        if (request.refused) {
            // Already shown as "answer on the Mac"; keep that.
            open.delete(request.key);
            completedAt.set(request.key, entries.length);
            return;
        }
        complete(request, { status: 'canceled' }, entries.length);
    }

    /**
     * Publishes the dialog on `screen` unless it is already open. Returns the key of the request
     * standing for it (open, or just completed and still drawn), or null when no answerable dialog
     * is shown.
     */
    function observe(screen: string, entries: unknown[]): string | null {
        const fingerprint = dialogFingerprint(screen);
        if (!ANSWERABLE.includes(classifyScreen(screen)) || fingerprint === null) {
            return null;
        }
        const pending = findPendingToolUse(entries);
        const matched = pending !== null && screenMatchesPending(screen, pending, cwdFor(entries, pending.id, deps.cwd));
        const existing = [...open.values()].find((request) => request.fingerprint === fingerprint || (matched && request.toolUseId === pending.id));
        if (existing !== undefined) {
            existing.misses = 0;
            return existing.key;
        }
        const key = matched ? pending.id : `screen:${fingerprint}`;
        const completedLength = completedAt.get(key);
        if (completedLength !== undefined && (matched || entries.length <= completedLength)) {
            // Answered already and Claude Code has not moved on: the same dialog is still drawn.
            return key;
        }
        completedAt.delete(key);
        const read = matched ? null : readDialogFromScreen(screen);
        const request: OpenRequest = {
            key,
            tool: matched ? pending.name : (read?.tool ?? 'Unknown'),
            input: matched ? pending.input : (read?.input ?? {}),
            createdAt: deps.now(),
            toolUseId: matched ? pending.id : null,
            screen,
            fingerprint,
            transcriptLength: entries.length,
            misses: 0,
            refused: false,
        };
        open.set(key, request);
        deps.updateAgentState((state) => {
            if (state.requests?.[key] !== undefined) {
                return state;
            }
            const completedRequests = state.completedRequests;
            const keepCompleted = completedRequests === undefined || completedRequests[key] === undefined;
            const rest = { ...completedRequests };
            delete rest[key];
            return {
                ...state,
                requests: { ...state.requests, [key]: { tool: request.tool, arguments: request.input, createdAt: request.createdAt } },
                ...(keepCompleted ? {} : { completedRequests: rest }),
            };
        });
        deps.notifyPermission(request.tool);
        return key;
    }

    async function readScreen(): Promise<string | null> {
        let terminal: AttachTerminal | null = null;
        try {
            terminal = await deps.openTerminal();
            return await terminal.screen();
        } catch {
            return null;
        } finally {
            if (terminal !== null) {
                await closeQuietly(terminal);
            }
        }
    }

    async function tick(): Promise<void> {
        const status = deps.readStatus();
        const entries = deps.readEntries();
        let shown: string | null = null;
        if (status === 'waiting') {
            if (lastSeen !== null && lastSeen.transcriptLength === entries.length && open.has(lastSeen.key)) {
                // Same open request, nothing written since: the dialog has not changed.
                return;
            }
            const screen = await readScreen();
            if (screen === null) {
                // Cannot see the dialog: leave every request as it is.
                return;
            }
            shown = observe(screen, entries);
            lastSeen = shown === null ? null : { key: shown, transcriptLength: entries.length };
        } else {
            lastSeen = null;
        }
        for (const request of [...open.values()]) {
            if (request.key !== shown) {
                settle(request, entries, status);
            }
        }
    }

    /** The keys that answer `request` on `screen`, or null when any gate fails or nothing maps. */
    function stepsFor(request: OpenRequest, response: PermissionResponse, screen: string, entries: unknown[]): Step[] | null {
        const kind = classifyScreen(screen);
        if (deps.readStatus() !== 'waiting' || dialogFingerprint(screen) !== request.fingerprint || kind !== kindOfTool(request.tool)) {
            return null;
        }
        if (request.toolUseId !== null) {
            const pending = findPendingToolUse(entries);
            if (pending?.id !== request.toolUseId || !screenMatchesPending(screen, pending, cwdFor(entries, pending.id, deps.cwd))) {
                return null;
            }
        } else if (!isDeepStrictEqual(readDialogFromScreen(screen), { tool: request.tool, input: request.input })) {
            return null;
        }
        const keys = (list: AttachKey[] | null): Step[] | null => (list === null ? null : list.map((key) => ({ key })));
        switch (kind) {
            case 'permission': {
                const digits = keysForPermission(response.approved, screen);
                // Approval is option 1 ("Yes") only, never an "and don't ask again" option.
                if (response.approved && !isDeepStrictEqual(digits, [{ digit: 1 }])) {
                    return null;
                }
                return keys(digits);
            }
            case 'question': {
                if (!response.approved) {
                    return keys(['escape']);
                }
                const answers = answersOf(response);
                const list = answers === null ? null : keysForQuestion(request.input, answers);
                // Several keys always end with `1` on the review screen, which submits every answer.
                return list === null
                    ? null
                    : list.map((key, index) => (index > 0 && index === list.length - 1 ? { key, expect: (p: DialogProgress) => p.review } : { key }));
            }
            case 'plan': {
                const plan = keysForPlan(response.approved, response.mode, response.reason);
                if (response.approved) {
                    return keys(plan.keys);
                }
                // A rejection without a reason (the phone clients send none) is 3 then Enter
                // (measured outcome). Enter only once option 3 is focused with its hint and still
                // shows the empty placeholder: on option 1 Enter would approve, and text the Mac
                // user typed into option 3 must not be submitted.
                const feedback = plan.thenType;
                if (feedback === undefined) {
                    return plan.keys.map((key, index) => (index === 0 ? { key } : { key, expect: (p: DialogProgress) => p.planFeedback === PLAN_FEEDBACK }));
                }
                // Text goes in only once option 3 is focused with its feedback hint (typed digits
                // on any other screen could pick an option), and Enter only once option 3 shows
                // exactly the typed feedback (measured: `plan-feedback-typed`).
                return [
                    ...plan.keys.map((key) => ({ key })),
                    { text: feedback, expect: (p: DialogProgress) => p.planFeedback !== null },
                    ...(plan.thenPress ?? []).map((key) => ({
                        key,
                        expect: (p: DialogProgress) => p.planFeedback !== null && p.planFeedback.replace(/\s+/g, '') === feedback.replace(/\s+/g, ''),
                    })),
                ];
            }
            default:
                return null;
        }
    }

    async function answer(response: PermissionResponse): Promise<'typed' | 'refused'> {
        const request = open.get(response.id);
        if (request === undefined || request.refused) {
            return 'refused';
        }
        let terminal: AttachTerminal | null = null;
        let entries: unknown[] = [];
        let pressed = false;
        try {
            terminal = await deps.openTerminal();
            const screen = await terminal.screen();
            entries = deps.readEntries();
            const steps = stepsFor(request, response, screen, entries);
            if (steps === null || steps.length === 0) {
                return refuse(request);
            }
            const initial = readDialogProgress(screen);
            for (const step of steps) {
                if (pressed) {
                    await sleep(DIALOG_KEY_GAP_MS);
                    // Re-read before every later key: still waiting, the same kind of dialog (the
                    // same question set), and the screen this key is meant for.
                    const now = readDialogProgress(await terminal.screen());
                    const same = deps.readStatus() === 'waiting' && now.kind === initial.kind && now.tabs === initial.tabs;
                    if (!same || (step.expect !== undefined && !step.expect(now))) {
                        complete(request, { status: 'canceled', reason: TYPING_FAILED }, entries.length);
                        return 'typed';
                    }
                }
                if ('key' in step) {
                    await terminal.press([step.key]);
                } else {
                    await terminal.typeText(step.text);
                }
                pressed = true;
            }
            const decision = response.approved ? 'approved' : 'denied';
            complete(request, {
                status: decision,
                decision,
                ...(response.reason === undefined ? {} : { reason: response.reason }),
                ...(response.mode === undefined ? {} : { mode: response.mode }),
            }, entries.length);
            return 'typed';
        } catch {
            if (!pressed) {
                return refuse(request);
            }
            complete(request, { status: 'canceled', reason: TYPING_FAILED }, entries.length);
            return 'typed';
        } finally {
            if (terminal !== null) {
                await closeQuietly(terminal);
            }
        }
    }

    return {
        tick: () => enqueue(tick),
        answer: (response) => enqueue(() => answer(response)).catch((): 'refused' => 'refused'),
    };
}
