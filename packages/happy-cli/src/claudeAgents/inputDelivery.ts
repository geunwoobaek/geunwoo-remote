/**
 * Delivers phone messages into a background session as if they were typed on the Mac.
 *
 * Each delivery opens a hidden `claude attach` terminal, waits until the input box is drawn and
 * empty, types (or pastes) the text, presses Enter and closes the terminal again. Claude Code
 * queues input typed while the agent is working, so readiness is the input box, not the agent
 * status. Sends and interrupts share one queue so they never interleave on a terminal.
 *
 * When the Mac user has the session open in their own cmux pane (`openUserTerminal`), a plain
 * one-line text goes into that pane instead, provided its input box is empty right now; it is
 * typed and sent without waiting. A multi-line or backslash text, a busy input box, or a cmux
 * failure before anything was typed falls back to the hidden terminal. A failure after typing
 * started is final: retrying through tmux could type the text twice. Interrupts read the user's
 * pane and press Escape there first. Every use of the pane starts with a screen read: the mirror
 * hands out a pane whose `screen` throws (and whose keys are refused) unless the screen names
 * this session, which sends the text or the Escape through the hidden terminal. Accepted gap: a Mac user who starts typing between the empty-box read and
 * `cmux send` can get their text mixed with the phone text.
 *
 * Rules the delivery keeps:
 * - Text is typed only into an empty input box. A dim suggestion counts as empty (the screen is
 *   a `capture-pane -e` capture); a dialog means "not yet".
 * - A draft in the box (the Mac user's half-written line) does not hold the phone back: the hidden
 *   terminal sets it aside with Claude Code's stash (Ctrl+S), sends the phone text, and Claude Code
 *   puts the draft back by itself once that text is submitted ("Draft restored"). A draft that came
 *   back counts as "our text went", so Enter is never pressed over the user's draft. If the phone
 *   text has to be deleted again, the draft is brought back with a second Ctrl+S. Only a draft that
 *   held still for [draftSettleMs] is set aside, so a line the Mac user is typing right now is left
 *   alone. A draft that is the phone text itself (an earlier copy whose Enter was lost) is not set
 *   aside but submitted, and only an empty box counts as sent then. Accepted gap: a stash the user
 *   had already made is replaced by the new one (Claude Code keeps one).
 * - A session survey (`1: Bad 2: Fine 3: Good 0: Dismiss`) sits right above the input box and
 *   would take a leading digit as its answer, so it is dismissed with `0` first. If it will not
 *   go away, nothing is typed.
 * - The text is remembered in the echo filter just before it is typed, so the transcript line
 *   Claude Code writes for it is not uploaded to the phone a second time. If typing then fails
 *   the entry is forgotten again.
 * - In the hidden terminal, Enter is pressed only once the typed text shows in the input box, and
 *   a send counts only once the box is empty again after Enter. A slow terminal (a Mac
 *   just awake from sleep, a very long session being loaded) can swallow the Enter and leave the
 *   text sitting in the box: never submitted, and every later phone message then finds the box
 *   taken. So Enter is pressed again while the text is still there, and if it still will not go,
 *   the text is deleted and the send is `'failed'` (the phone says so and can send again).
 *   Enter is pressed again only over an input box with text in it, never over a dialog. The Mac
 *   user's own pane gets one Enter and no backspaces: what is in that box may be theirs.
 * - With [InputDeliveryDeps.retryBusyMs] a phone message is never dropped for want of an input box
 *   (a permission or other dialog on the Mac screen, the Mac user typing): it keeps its place and is
 *   tried again until it goes. Between tries the terminal is let go, so an answer to that dialog
 *   (from the phone or the Mac), an interrupt or a settings switch gets through in the meantime.
 *   Later phone messages wait behind it, so they still arrive in the order they were sent.
 */

import { sanitizeTypedText, type AttachKey, type AttachTerminal } from './attachTerminal';
import { cmuxTypable } from './cmuxTerminal';
import { classifyScreen, inputBoxHasText, inputBoxText, isInputBoxEmpty } from './dialogs';
import {
    MAC_EFFORT_LEVELS,
    isSwitchConfirmation,
    modelKeyOf,
    pickerLabelOf,
    pickerRowFor,
    readModelPicker,
    readModelResult,
    readPermissionMode,
    type MacEffortLevel,
    type MacPermissionMode,
    type ModelPicker,
} from './macSettings';

export type DeliveryResult = 'sent' | 'busy-input' | 'failed';

/** What the phone asks a background session to switch to; a field left out stays as it is. */
export type MacSettingsChange = {
    permissionMode?: MacPermissionMode;
    /** A phone model key (`claude-opus-5-5`, `default`). */
    model?: string;
    effort?: MacEffortLevel;
};

/** What the session was seen running with; a field is left out when it was not seen. */
export type MacSettings = {
    permissionMode?: MacPermissionMode;
    /** The model the picker marks current, as a phone model key. */
    model?: string;
    effort?: MacEffortLevel;
    /** The picker's rows, as phone model keys and labels. */
    models?: Array<{ code: string; value: string }>;
};

export type ConfigureResult =
    | { ok: true; settings: MacSettings }
    /** `busy`: a dialog or the Mac user's typing is in the way; `unsupported`: the session has no such choice. */
    | { ok: false; reason: 'busy' | 'unsupported' | 'failed'; settings: MacSettings };

export type EchoFilter = {
    /** Registers one expected copy of a user line that was typed from the phone. */
    remember(text: string): void;
    /** Removes one remembered copy of `text` again (typing it failed); no-op if there is none. */
    forget(text: string): void;
    /** True once per remembered copy of `userText` (compared with whitespace collapsed). */
    shouldSkip(userText: string): boolean;
};

export type InputDelivery = {
    send(text: string): Promise<DeliveryResult>;
    interrupt(): Promise<void>;
    /** Switches the session's permission mode, model and effort, in the same queue as sends. */
    configure(change: MacSettingsChange): Promise<ConfigureResult>;
    /** The permission mode under the input box right now; null when it cannot be read. */
    readPermissionMode(): Promise<MacPermissionMode | null>;
    /**
     * Stops retrying (the mirror is going away): sends still waiting resolve `'failed'`, none is
     * tried again. Returns how many sends had not gone yet.
     */
    abandon(): number;
};

export type InputDeliveryDeps = {
    openTerminal: () => Promise<AttachTerminal>;
    /**
     * Opens the Mac user's own pane running `claude attach` (cmux), or resolves null when there is
     * none. Tried first for sends and interrupts; the terminal must be closed before `openTerminal`
     * is called (they may share one lock). Without it everything goes through `openTerminal`.
     */
    openUserTerminal?: () => Promise<AttachTerminal | null>;
    /** Told which way a send, interrupt took, for the debug log. */
    onRoute?: (use: 'input' | 'interrupt', route: 'cmux' | 'tmux') => void;
    echo: EchoFilter;
    /** How long to wait for a usable input box before giving up with `busy-input`. Default 10000. */
    waitInputMs?: number;
    /**
     * Never give up on a send for want of an input box: wait this long and try again, until it goes
     * or [InputDelivery.abandon] is called. The pause doubles after each try, up to
     * [retryBusyMaxMs]. A try still waits up to [waitInputMs] for the box (a fresh `claude attach`
     * may take a while to draw it), but leaves after [retryWaitInputMs] when it sees what is in the
     * way, a dialog or a line being typed, so the terminal is free for other work between tries.
     * Unset: one try of [waitInputMs], then `busy-input`.
     */
    retryBusyMs?: number;
    /** With [retryBusyMs]: the longest pause between two tries. Default 3000. */
    retryBusyMaxMs?: number;
    /** With [retryBusyMs]: how long a try that sees a dialog or typing keeps waiting. Default 1500. */
    retryWaitInputMs?: number;
    /** With [retryBusyMs]: told once per send that has waited [waitInputMs] and is still waiting. */
    onWaiting?: () => void;
    /** With [retryBusyMs]: told after each try that found no usable box, with what was in the way. */
    onRetry?: (tries: number, blocker: Blocker) => void;
    /** Pause after Enter before the terminal is closed. Default 400. */
    closeDelayMs?: number;
    /** Pause between two screen reads. Default 200. */
    pollIntervalMs?: number;
    /** How long one Enter has to empty the input box before it is pressed again. Default 1500. */
    submitWaitMs?: number;
    /** How long the same text must sit in the box before it counts as a draft to set aside. Default 800. */
    draftSettleMs?: number;
};

const DEFAULT_WAIT_INPUT_MS = 10_000;
const DEFAULT_CLOSE_DELAY_MS = 400;
const DEFAULT_POLL_INTERVAL_MS = 200;
const DEFAULT_SUBMIT_WAIT_MS = 1_500;
const DEFAULT_DRAFT_SETTLE_MS = 800;
const DEFAULT_RETRY_WAIT_INPUT_MS = 1_500;
const DEFAULT_RETRY_BUSY_MAX_MS = 3_000;

/** What the hidden terminal found in the input box before typing. */
type InputBox = { kind: 'empty' } | { kind: 'blocked' } | { kind: 'draft'; text: string };
/**
 * What kept a try from typing: a dialog (permission, question, plan), the Mac user typing, a draft
 * the stash key would not move, a survey that will not go away, or no input box drawn at all.
 */
export type Blocker = 'dialog' | 'typing' | 'draft' | 'survey' | 'no-box';
/**
 * One send across its tries: the survey is answered with `0` once per send, never once per try.
 * `leaveEarlyMs` lets a try give up early on a dialog or typing (patient sends only); `blocker`
 * is what the last try saw.
 */
type SendTries = { surveyDismissed: boolean; leaveEarlyMs?: number; blocker?: Blocker };

/** Dialogs that stay until someone answers them; an `unknown` screen may still be drawing. */
function showsDialog(screen: string): boolean {
    const kind = classifyScreen(screen);
    return kind === 'permission' || kind === 'question' || kind === 'plan';
}
/** Extra Enters after the first one before the send is given up. */
const ENTER_RETRIES = 2;
/** Backspaces sent per key batch when deleting a text that would not submit. */
const BACKSPACE_BATCH = 100;
/** Shift+Tab presses before a mode is given up: one more than the longest cycle (five modes). */
const MODE_CYCLE_MAX = 5;
/** How long `/model` gets to open its picker. */
const PICKER_WAIT_MS = 4_000;
/** How long a switch gets to report "Set model to … for this session only" (a hook may run first). */
const MODEL_RESULT_WAIT_MS = 8_000;

const SGR_OR_CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const SURVEY_OPTIONS = /^\s*1: Bad\s+2: Fine\s+3: Good\s+0: Dismiss\s*$/m;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Best-effort cleanup: the outcome of a delivery is decided by the work, never by closing the
 * terminal, so a failing `close` must not turn a typed message into `'failed'` (callers may retry).
 */
async function closeQuietly(terminal: AttachTerminal): Promise<void> {
    try {
        await terminal.close();
    } catch {
        // Nothing to do: the tmux session is gone or will be reaped with the server.
    }
}

function normalize(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

/** True when the screen shows the session survey's option line. Works on plain and `-e` captures. */
export function hasSessionSurvey(screen: string): boolean {
    return SURVEY_OPTIONS.test(screen.replace(SGR_OR_CSI, ''));
}

/** Remembers texts typed from the phone so the mirror can skip their transcript lines. */
export function createEchoFilter(): EchoFilter {
    const pending = new Map<string, number>();
    /** Takes one pending copy of `key`; false when there is none. */
    const consume = (key: string): boolean => {
        const count = pending.get(key) ?? 0;
        if (count === 0) {
            return false;
        }
        if (count === 1) {
            pending.delete(key);
        } else {
            pending.set(key, count - 1);
        }
        return true;
    };
    return {
        remember(text) {
            const key = normalize(text);
            pending.set(key, (pending.get(key) ?? 0) + 1);
        },
        forget(text) {
            consume(normalize(text));
        },
        shouldSkip(userText) {
            return consume(normalize(userText));
        },
    };
}

/**
 * Serialized delivery of phone text and interrupts. Errors never escape: a failed send resolves
 * `'failed'` and a failed interrupt is dropped (the phone can press stop again).
 */
export function createInputDelivery(deps: InputDeliveryDeps): InputDelivery {
    const waitInputMs = deps.waitInputMs ?? DEFAULT_WAIT_INPUT_MS;
    const closeDelayMs = deps.closeDelayMs ?? DEFAULT_CLOSE_DELAY_MS;
    const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const submitWaitMs = deps.submitWaitMs ?? DEFAULT_SUBMIT_WAIT_MS;
    const draftSettleMs = deps.draftSettleMs ?? DEFAULT_DRAFT_SETTLE_MS;
    const retryWaitInputMs = deps.retryWaitInputMs ?? DEFAULT_RETRY_WAIT_INPUT_MS;
    let queue: Promise<unknown> = Promise.resolve();
    /** Sends in the order they came; a send that is still waiting for a box holds the ones after it. */
    let sends: Promise<unknown> = Promise.resolve();
    /** Sends not resolved yet (waiting, being typed, or queued behind one). */
    let unsent = 0;
    let abandoned = false;

    /** Runs `job` after everything queued so far, whatever happened to it. */
    function enqueue<T>(job: () => Promise<T>): Promise<T> {
        const run = queue.then(job, job);
        queue = run.catch(() => undefined);
        return run;
    }

    /**
     * Waits for an empty input box, dismissing the survey once if it shows. A draft once the same
     * text has sat in the box for [draftSettleMs] (a box that is being submitted empties sooner, a
     * line being typed keeps changing); blocked when no usable box showed up within `waitMs`.
     */
    async function waitForInputBox(terminal: AttachTerminal, waitMs: number = waitInputMs, tries: SendTries = { surveyDismissed: false }): Promise<InputBox> {
        const started = Date.now();
        let held: { text: string; since: number } | null = null;
        for (;;) {
            const screen = await terminal.screen();
            const empty = isInputBoxEmpty(screen);
            const survey = hasSessionSurvey(screen);
            if (empty && !survey) {
                return { kind: 'empty' };
            }
            if (empty && survey && !tries.surveyDismissed) {
                // Only with an empty box: a digit would otherwise land in the user's draft.
                tries.surveyDismissed = true;
                await terminal.press([{ digit: 0 }]);
            }
            const now = Date.now();
            const text = survey ? '' : (inputBoxText(screen) ?? '');
            held = text === '' ? null : held !== null && held.text === text ? held : { text, since: now };
            if (held !== null && now - held.since >= draftSettleMs) {
                return { kind: 'draft', text: held.text };
            }
            const blocker: Blocker = survey && empty ? 'survey' : held !== null ? 'typing' : showsDialog(screen) ? 'dialog' : 'no-box';
            tries.blocker = blocker;
            const seen = blocker === 'typing' || blocker === 'dialog';
            if (now - started >= waitMs || (seen && tries.leaveEarlyMs !== undefined && now - started >= tries.leaveEarlyMs)) {
                return { kind: 'blocked' };
            }
            await sleep(pollIntervalMs);
        }
    }

    /** Sets the draft in the box aside with the stash key. False when the box did not empty within [submitWaitMs]. */
    async function setDraftAside(terminal: AttachTerminal): Promise<boolean> {
        await terminal.press(['stash']);
        const deadline = Date.now() + submitWaitMs;
        for (;;) {
            if (isInputBoxEmpty(await terminal.screen())) {
                return true;
            }
            if (Date.now() >= deadline) {
                return false;
            }
            await sleep(pollIntervalMs);
        }
    }

    /** Brings a set-aside draft back into the box, which must be empty for the stash key to do that. */
    async function bringDraftBack(terminal: AttachTerminal): Promise<void> {
        try {
            if (isInputBoxEmpty(await terminal.screen())) {
                await terminal.press(['stash']);
            }
        } catch {
            // Claude Code also brings the draft back with the next submitted message.
        }
    }

    /**
     * After typing: waits until the text shows in the input box, so an Enter is never pressed
     * before the terminal took the keys. `'empty'` when the box stayed empty, `'none'` when no input
     * box is drawn (a dialog), both after [submitWaitMs] times ([ENTER_RETRIES] + 1).
     */
    async function waitForTypedText(terminal: AttachTerminal): Promise<'text' | 'empty' | 'none'> {
        const deadline = Date.now() + submitWaitMs * (ENTER_RETRIES + 1);
        for (;;) {
            const screen = await terminal.screen();
            if (inputBoxHasText(screen)) {
                return 'text';
            }
            if (Date.now() >= deadline) {
                return isInputBoxEmpty(screen) ? 'empty' : 'none';
            }
            await sleep(pollIntervalMs);
        }
    }

    /**
     * Called right after the first Enter, over a box that showed the text. `'sent'` once the box is
     * empty, or when it stays hidden (a dialog took over: the text was taken). While the text still
     * sits in the box after [submitWaitMs], Enter is pressed again, up to [ENTER_RETRIES] times; if
     * it never goes, the text is deleted and the send is `'failed'`. Once Enter was pressed, a
     * terminal that cannot be read counts as `'sent'`: the message may be in, and a resend from the
     * phone would then arrive twice. With a set-aside [draft], the draft showing again means the
     * phone text was submitted (Claude Code restores the draft on submit).
     */
    async function confirmSubmitted(terminal: AttachTerminal, text: string, draft: string | null): Promise<DeliveryResult> {
        try {
            for (let retries = 0; ; retries++) {
                const deadline = Date.now() + submitWaitMs;
                let holdsText = false;
                for (;;) {
                    const screen = await terminal.screen();
                    if (isInputBoxEmpty(screen) || (draft !== null && inputBoxText(screen) === draft)) {
                        return 'sent';
                    }
                    holdsText = inputBoxHasText(screen);
                    if (Date.now() >= deadline) {
                        break;
                    }
                    await sleep(pollIntervalMs);
                }
                if (!holdsText) {
                    return 'sent';
                }
                if (retries >= ENTER_RETRIES) {
                    break;
                }
                await terminal.press(['enter']);
            }
        } catch {
            return 'sent';
        }
        await clearUnsent(terminal, text);
        if (draft !== null) {
            await bringDraftBack(terminal);
        }
        deps.echo.forget(text);
        return 'failed';
    }

    /** Deletes a text that would not submit, so it does not block the next message. Best effort. */
    async function clearUnsent(terminal: AttachTerminal, text: string): Promise<void> {
        // One backspace per character, a few spare; a pasted block may show as one placeholder.
        let left = Array.from(text).length + 4;
        try {
            while (left > 0) {
                const batch = Math.min(left, BACKSPACE_BATCH);
                await terminal.press(Array.from({ length: batch }, (): AttachKey => 'backspace'));
                left -= batch;
            }
        } catch {
            // The terminal is going away anyway; the send is reported as failed regardless.
        }
    }

    /** The user's pane, or null when there is none or it cannot be opened. */
    async function openUser(): Promise<AttachTerminal | null> {
        try {
            return (await deps.openUserTerminal?.()) ?? null;
        } catch {
            return null;
        }
    }

    /**
     * Types `text` into the user's own pane when it is a plain line and the pane's input box is
     * empty. Null means "not sent, use tmux": nothing was typed. Once typing started the result is
     * final (a failure is `'failed'`), because tmux would type the same text a second time.
     */
    async function deliverToUser(text: string): Promise<DeliveryResult | null> {
        if (!cmuxTypable(text)) {
            return null;
        }
        const terminal = await openUser();
        if (terminal === null) {
            return null;
        }
        try {
            let screen: string;
            try {
                screen = await terminal.screen();
            } catch {
                return null;
            }
            if (!isInputBoxEmpty(screen) || hasSessionSurvey(screen)) {
                return null;
            }
            deps.echo.remember(text);
            try {
                await terminal.typeText(text);
                await terminal.press(['enter']);
            } catch {
                deps.echo.forget(text);
                return 'failed';
            }
            return 'sent';
        } finally {
            await closeQuietly(terminal);
        }
    }

    async function deliver(text: string, waitMs: number = waitInputMs, tries: SendTries = { surveyDismissed: false }): Promise<DeliveryResult> {
        const viaUser = await deliverToUser(text);
        if (viaUser !== null) {
            deps.onRoute?.('input', 'cmux');
            return viaUser;
        }
        deps.onRoute?.('input', 'tmux');
        const terminal = await deps.openTerminal();
        try {
            const box = await waitForInputBox(terminal, waitMs, tries);
            if (box.kind === 'blocked') {
                return 'busy-input';
            }
            // The phone text already waits in the box (an earlier copy whose Enter was lost): submit
            // that copy instead of setting it aside, or the restored copy would pass for "sent".
            const resubmit = box.kind === 'draft' && box.text === text.replace(/\s+/g, '');
            const draft = box.kind === 'draft' && !resubmit ? box.text : null;
            if (draft !== null && !(await setDraftAside(terminal))) {
                tries.blocker = 'draft';
                return 'busy-input';
            }
            deps.echo.remember(text);
            try {
                if (!resubmit) {
                    if (text.includes('\n')) {
                        await terminal.pasteText(text);
                    } else {
                        await terminal.typeText(text);
                    }
                    const shown = await waitForTypedText(terminal);
                    if (shown !== 'text') {
                        // The keys were lost (or a dialog took over): nothing to submit. Keys are taken in
                        // order, so backspaces also remove a text that only shows up later.
                        if (shown === 'empty') {
                            await clearUnsent(terminal, text);
                            if (draft !== null) {
                                await bringDraftBack(terminal);
                            }
                        }
                        deps.echo.forget(text);
                        return 'failed';
                    }
                }
                await terminal.press(['enter']);
            } catch (error) {
                // Not sent: the transcript will never show it, so it must not swallow a later identical Mac line.
                deps.echo.forget(text);
                throw error;
            }
            const result = await confirmSubmitted(terminal, text, draft);
            await sleep(closeDelayMs);
            return result;
        } finally {
            await closeQuietly(terminal);
        }
    }

    /** Reads the screen until `read` gives a value, for up to `ms`; null when it never does. */
    async function waitFor<T>(terminal: AttachTerminal, read: (screen: string) => T | null, ms: number): Promise<T | null> {
        const deadline = Date.now() + ms;
        for (;;) {
            const value = read(await terminal.screen());
            if (value !== null) {
                return value;
            }
            if (Date.now() >= deadline) {
                return null;
            }
            await sleep(pollIntervalMs);
        }
    }

    /**
     * Presses Shift+Tab until the mode line shows `target`. Only over the input box: an open
     * dialog takes Shift+Tab as one of its answers. Each press waits for the mode line to change,
     * and a cycle that comes back to where it started means the session does not offer `target`.
     */
    async function switchPermissionMode(terminal: AttachTerminal, target: MacPermissionMode): Promise<'ok' | 'busy' | 'unsupported' | 'failed'> {
        let start: MacPermissionMode | null = null;
        for (let presses = 0; presses <= MODE_CYCLE_MAX; presses++) {
            const screen = await terminal.screen();
            const mode = classifyScreen(screen) === 'none' ? readPermissionMode(screen) : null;
            if (mode === null) {
                return 'busy';
            }
            if (mode === target) {
                return 'ok';
            }
            if (start === null) {
                start = mode;
            } else if (mode === start) {
                return 'unsupported';
            }
            await terminal.press(['shift-tab']);
            const moved = await waitFor(terminal, (next) => {
                const now = readPermissionMode(next);
                return now !== null && now !== mode ? now : null;
            }, submitWaitMs);
            if (moved === null) {
                return 'failed';
            }
        }
        return 'unsupported';
    }

    /** Closes the picker with Escape, but only while it shows: Escape over the input box stops the turn. */
    async function closePicker(terminal: AttachTerminal): Promise<void> {
        try {
            if (readModelPicker(await terminal.screen()) !== null) {
                await terminal.press(['escape']);
            }
        } catch {
            // The terminal is going away; a picker left open closes with it.
        }
    }

    /** Moves the picker's cursor to `row` one key at a time, each key checked; null when it would not move. */
    async function moveCursor(terminal: AttachTerminal, picker: ModelPicker, row: number): Promise<ModelPicker | null> {
        let current = picker;
        for (let steps = 0; steps <= picker.rows.length; steps++) {
            const at = current.rows.findIndex((candidate) => candidate.cursor);
            if (at === row) {
                return current;
            }
            await terminal.press([at < row ? 'down' : 'up']);
            const moved = await waitFor(terminal, (screen) => {
                const next = readModelPicker(screen);
                return next !== null && next.rows.findIndex((candidate) => candidate.cursor) !== at ? next : null;
            }, submitWaitMs);
            if (moved === null) {
                return null;
            }
            current = moved;
        }
        return null;
    }

    /** Steps the picker's effort with ←/→ to `target`; 'unsupported' when it shows none or will not get there. */
    async function moveEffort(terminal: AttachTerminal, picker: ModelPicker, target: MacEffortLevel): Promise<ModelPicker | 'unsupported' | 'failed'> {
        let current = picker;
        for (let steps = 0; steps < MAC_EFFORT_LEVELS.length; steps++) {
            const effort = current.effort;
            if (effort === null) {
                return 'unsupported';
            }
            if (effort === target) {
                return current;
            }
            await terminal.press([MAC_EFFORT_LEVELS.indexOf(effort) < MAC_EFFORT_LEVELS.indexOf(target) ? 'right' : 'left']);
            const moved = await waitFor(terminal, (screen) => {
                const next = readModelPicker(screen);
                return next !== null && next.effort !== effort ? next : null;
            }, submitWaitMs);
            if (moved === null) {
                // The level did not move: the model stops short of `target`.
                return 'unsupported';
            }
            current = moved;
        }
        return 'unsupported';
    }

    /**
     * Opens `/model`, picks the row and effort and applies them with `s`, "use this session only",
     * confirming "Switch model?" when it asks. Enter is never pressed in the picker itself: there
     * it saves the pick as the default for every new session. Fills `seen` from the picker.
     */
    async function pickModel(terminal: AttachTerminal, change: MacSettingsChange, seen: MacSettings): Promise<'ok' | 'unsupported' | 'failed'> {
        await terminal.typeText('/model');
        const shown = await waitForTypedText(terminal);
        if (shown !== 'text') {
            if (shown === 'empty') {
                await clearUnsent(terminal, '/model');
            }
            return 'failed';
        }
        const before = await terminal.screen();
        await terminal.press(['enter']);
        const picker = await waitFor(terminal, readModelPicker, PICKER_WAIT_MS);
        if (picker === null) {
            if (inputBoxHasText(await terminal.screen())) {
                await clearUnsent(terminal, '/model');
            }
            return 'failed';
        }
        seen.models = picker.rows.map((row) => ({ code: modelKeyOf(row.label), value: row.label.replace(/\s*\(recommended\)$/, '') }));
        const running = picker.rows.find((row) => row.current);
        if (running !== undefined) {
            seen.model = modelKeyOf(running.label);
        }
        if (picker.effort !== null) {
            seen.effort = picker.effort;
        }
        const row = change.model === undefined ? picker.rows.findIndex((candidate) => candidate.current) : pickerRowFor(picker, change.model);
        if (row < 0) {
            await closePicker(terminal);
            return 'unsupported';
        }
        const placed = await moveCursor(terminal, picker, row);
        if (placed === null) {
            await closePicker(terminal);
            return 'failed';
        }
        const ready = change.effort === undefined ? placed : await moveEffort(terminal, placed, change.effort);
        if (typeof ready === 'string') {
            await closePicker(terminal);
            return ready;
        }
        const label = ready.rows[row].label;
        const resultLabel = /^Default\b/.test(label) ? null : label;
        // Already on the screen from an earlier switch: then only a closed picker tells it went.
        const shownBefore = resultLabel !== null && readModelResult(before, resultLabel) === 'session';
        await terminal.typeText('s');
        let confirmed = false;
        const deadline = Date.now() + MODEL_RESULT_WAIT_MS;
        for (;;) {
            const screen = await terminal.screen();
            if (isSwitchConfirmation(screen) && !confirmed) {
                confirmed = true;
                await terminal.press(['enter']);
            } else {
                const result = resultLabel === null ? null : readModelResult(screen, resultLabel);
                if (result === 'saved') {
                    // Never expected from `s`: say so rather than report a session-only switch.
                    return 'failed';
                }
                const closed = readModelPicker(screen) === null && !isSwitchConfirmation(screen) && classifyScreen(screen) === 'none';
                const reported = resultLabel === null || shownBefore || result === 'session';
                if (closed && reported) {
                    seen.model = modelKeyOf(label);
                    if (ready.effort !== null) {
                        seen.effort = ready.effort;
                    }
                    return 'ok';
                }
            }
            if (Date.now() >= deadline) {
                await closePicker(terminal);
                return 'failed';
            }
            await sleep(pollIntervalMs);
        }
    }

    /** Model and effort through the picker, with a Mac draft set aside while `/model` is typed. */
    async function switchModel(terminal: AttachTerminal, change: MacSettingsChange, seen: MacSettings): Promise<'ok' | 'busy' | 'unsupported' | 'failed'> {
        const box = await waitForInputBox(terminal);
        if (box.kind === 'blocked') {
            return 'busy';
        }
        const draft = box.kind === 'draft' ? box.text : null;
        if (draft !== null && !(await setDraftAside(terminal))) {
            return 'busy';
        }
        try {
            return await pickModel(terminal, change, seen);
        } finally {
            // Running `/model` brings the draft back by itself ("Draft restored"); a cancelled one may not.
            if (draft !== null && (await waitFor(terminal, (screen) => (inputBoxText(screen) === draft ? true : null), submitWaitMs).catch(() => null)) === null) {
                await bringDraftBack(terminal);
            }
        }
    }

    /**
     * One send with [InputDeliveryDeps.retryBusyMs]: tries until something other than `busy-input`
     * comes back. Each try is queued on its own, so whatever was queued meanwhile runs between tries.
     */
    async function deliverPatiently(text: string, retryBusyMs: number): Promise<DeliveryResult> {
        const started = Date.now();
        const maxPause = Math.max(retryBusyMs, deps.retryBusyMaxMs ?? DEFAULT_RETRY_BUSY_MAX_MS);
        const tries: SendTries = { surveyDismissed: false, leaveEarlyMs: retryWaitInputMs };
        let pause = retryBusyMs;
        let told = false;
        for (let count = 1; ; count++) {
            if (abandoned) {
                return 'failed';
            }
            tries.blocker = undefined;
            const result = await enqueue(() => (abandoned ? Promise.resolve<DeliveryResult>('failed') : deliver(text, waitInputMs, tries)).catch((): DeliveryResult => 'failed'));
            if (result !== 'busy-input') {
                return result;
            }
            deps.onRetry?.(count, tries.blocker ?? 'no-box');
            if (!told && Date.now() - started >= waitInputMs) {
                told = true;
                deps.onWaiting?.();
            }
            await sleep(pause);
            pause = Math.min(pause * 2, maxPause);
        }
    }

    async function configure(change: MacSettingsChange): Promise<ConfigureResult> {
        const seen: MacSettings = {};
        const terminal = await deps.openTerminal();
        try {
            if (change.permissionMode !== undefined) {
                const moved = await switchPermissionMode(terminal, change.permissionMode);
                if (moved !== 'ok') {
                    return { ok: false, reason: moved, settings: seen };
                }
            }
            if (change.model !== undefined || change.effort !== undefined) {
                const picked = await switchModel(terminal, change, seen);
                if (picked !== 'ok') {
                    return { ok: false, reason: picked, settings: seen };
                }
            }
            return { ok: true, settings: seen };
        } finally {
            const mode = await waitFor(terminal, readPermissionMode, submitWaitMs).catch(() => null);
            if (mode !== null) {
                seen.permissionMode = mode;
            }
            await closeQuietly(terminal);
        }
    }

    return {
        configure(change) {
            return enqueue(() => configure(change).catch((): ConfigureResult => ({ ok: false, reason: 'failed', settings: {} })));
        },
        readPermissionMode() {
            return enqueue(async () => {
                const terminal = await deps.openTerminal();
                try {
                    return await waitFor(terminal, readPermissionMode, submitWaitMs);
                } finally {
                    await closeQuietly(terminal);
                }
            }).catch(() => null);
        },
        send(text) {
            const clean = sanitizeTypedText(text);
            if (clean.trim().length === 0) {
                // Nothing to type once control characters are gone: a no-op that counts as delivered.
                return Promise.resolve('sent');
            }
            const retryBusyMs = deps.retryBusyMs;
            if (retryBusyMs === undefined) {
                return enqueue(() => deliver(clean).catch((): DeliveryResult => 'failed'));
            }
            unsent++;
            const run = sends.then(() => deliverPatiently(clean, retryBusyMs)).finally(() => {
                unsent--;
            });
            sends = run.catch(() => undefined);
            return run;
        },
        abandon() {
            abandoned = true;
            return unsent;
        },
        interrupt() {
            return enqueue(async () => {
                const user = await openUser();
                if (user !== null) {
                    try {
                        // Read first: the pane may refuse keys until its screen was checked
                        // (it must show this session), and a failed read goes to the hidden terminal.
                        await user.screen();
                        await user.press(['escape']);
                        deps.onRoute?.('interrupt', 'cmux');
                        return;
                    } catch {
                        // The user's pane failed: stop through the private terminal instead.
                    } finally {
                        await closeQuietly(user);
                    }
                }
                deps.onRoute?.('interrupt', 'tmux');
                const terminal = await deps.openTerminal();
                try {
                    await terminal.press(['escape']);
                } finally {
                    await closeQuietly(terminal);
                }
            }).catch(() => undefined);
        },
    };
}
