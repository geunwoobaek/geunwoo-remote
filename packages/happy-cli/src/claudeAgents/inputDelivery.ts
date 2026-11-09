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
 * started is final: retrying through tmux could type the text twice. Interrupts press Escape in
 * the user's pane first. Accepted gap: a Mac user who starts typing between the empty-box read and
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
 */

import { sanitizeTypedText, type AttachTerminal } from './attachTerminal';
import { cmuxTypable } from './cmuxTerminal';
import { isInputBoxEmpty } from './dialogs';

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
};

const DEFAULT_WAIT_INPUT_MS = 10_000;
const DEFAULT_CLOSE_DELAY_MS = 400;
const DEFAULT_POLL_INTERVAL_MS = 200;

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
                await terminal.press(['enter']);
            } catch (error) {
                // Not sent: the transcript will never show it, so it must not swallow a later identical Mac line.
                deps.echo.forget(text);
                throw error;
            }
            await sleep(closeDelayMs);
            return 'sent';
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
