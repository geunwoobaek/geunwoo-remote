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
 *   a `capture-pane -e` capture); a dialog or typed text means "not yet".
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
 */

import { sanitizeTypedText, type AttachKey, type AttachTerminal } from './attachTerminal';
import { cmuxTypable } from './cmuxTerminal';
import { inputBoxHasText, isInputBoxEmpty } from './dialogs';

export type DeliveryResult = 'sent' | 'busy-input' | 'failed';

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
    /** Pause after Enter before the terminal is closed. Default 400. */
    closeDelayMs?: number;
    /** Pause between two screen reads. Default 200. */
    pollIntervalMs?: number;
    /** How long one Enter has to empty the input box before it is pressed again. Default 1500. */
    submitWaitMs?: number;
};

const DEFAULT_WAIT_INPUT_MS = 10_000;
const DEFAULT_CLOSE_DELAY_MS = 400;
const DEFAULT_POLL_INTERVAL_MS = 200;
const DEFAULT_SUBMIT_WAIT_MS = 1_500;
/** Extra Enters after the first one before the send is given up. */
const ENTER_RETRIES = 2;
/** Backspaces sent per key batch when deleting a text that would not submit. */
const BACKSPACE_BATCH = 100;

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
    let queue: Promise<unknown> = Promise.resolve();

    /** Runs `job` after everything queued so far, whatever happened to it. */
    function enqueue<T>(job: () => Promise<T>): Promise<T> {
        const run = queue.then(job, job);
        queue = run.catch(() => undefined);
        return run;
    }

    /** Waits for an empty input box, dismissing the survey once if it shows. False on timeout. */
    async function waitForEmptyInput(terminal: AttachTerminal): Promise<boolean> {
        const deadline = Date.now() + waitInputMs;
        let dismissed = false;
        for (;;) {
            const screen = await terminal.screen();
            const empty = isInputBoxEmpty(screen);
            const survey = hasSessionSurvey(screen);
            if (empty && !survey) {
                return true;
            }
            if (empty && survey && !dismissed) {
                // Only with an empty box: a digit would otherwise land in the user's draft.
                dismissed = true;
                await terminal.press([{ digit: 0 }]);
            }
            if (Date.now() >= deadline) {
                return false;
            }
            await sleep(pollIntervalMs);
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
     * phone would then arrive twice.
     */
    async function confirmSubmitted(terminal: AttachTerminal, text: string): Promise<DeliveryResult> {
        try {
            for (let retries = 0; ; retries++) {
                const deadline = Date.now() + submitWaitMs;
                let holdsText = false;
                for (;;) {
                    const screen = await terminal.screen();
                    if (isInputBoxEmpty(screen)) {
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

    async function deliver(text: string): Promise<DeliveryResult> {
        const viaUser = await deliverToUser(text);
        if (viaUser !== null) {
            deps.onRoute?.('input', 'cmux');
            return viaUser;
        }
        deps.onRoute?.('input', 'tmux');
        const terminal = await deps.openTerminal();
        try {
            if (!(await waitForEmptyInput(terminal))) {
                return 'busy-input';
            }
            deps.echo.remember(text);
            try {
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
                    }
                    deps.echo.forget(text);
                    return 'failed';
                }
                await terminal.press(['enter']);
            } catch (error) {
                // Not sent: the transcript will never show it, so it must not swallow a later identical Mac line.
                deps.echo.forget(text);
                throw error;
            }
            const result = await confirmSubmitted(terminal, text);
            await sleep(closeDelayMs);
            return result;
        } finally {
            await closeQuietly(terminal);
        }
    }

    return {
        send(text) {
            const clean = sanitizeTypedText(text);
            if (clean.trim().length === 0) {
                // Nothing to type once control characters are gone: a no-op that counts as delivered.
                return Promise.resolve('sent');
            }
            return enqueue(() => deliver(clean).catch((): DeliveryResult => 'failed'));
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
