/**
 * Delivers phone messages into a background session as if they were typed on the Mac.
 *
 * Each delivery opens a hidden `claude attach` terminal, waits until the input box is drawn and
 * empty, types (or pastes) the text, presses Enter and closes the terminal again. Claude Code
 * queues input typed while the agent is working, so readiness is the input box, not the agent
 * status. Sends and interrupts share one queue so they never interleave on a terminal.
 *
 * Rules the delivery keeps:
 * - Text is typed only into an empty input box. A dim suggestion counts as empty (the screen is
 *   a `capture-pane -e` capture); a dialog or typed text means "not yet".
 * - A session survey (`1: Bad 2: Fine 3: Good 0: Dismiss`) sits right above the input box and
 *   would take a leading digit as its answer, so it is dismissed with `0` first. If it will not
 *   go away, nothing is typed.
 * - The text is remembered in the echo filter just before it is typed, so the transcript line
 *   Claude Code writes for it is not uploaded to the phone a second time.
 */

import { sanitizeTypedText, type AttachTerminal } from './attachTerminal';
import { isInputBoxEmpty } from './dialogs';

export type DeliveryResult = 'sent' | 'busy-input' | 'failed';

export type EchoFilter = {
    /** Registers one expected copy of a user line that was typed from the phone. */
    remember(text: string): void;
    /** True once per remembered copy of `userText` (compared with whitespace collapsed). */
    shouldSkip(userText: string): boolean;
};

export type InputDelivery = {
    send(text: string): Promise<DeliveryResult>;
    interrupt(): Promise<void>;
};

export type InputDeliveryDeps = {
    openTerminal: () => Promise<AttachTerminal>;
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
    return {
        remember(text) {
            const key = normalize(text);
            pending.set(key, (pending.get(key) ?? 0) + 1);
        },
        shouldSkip(userText) {
            const key = normalize(userText);
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

    async function deliver(text: string): Promise<DeliveryResult> {
        const terminal = await deps.openTerminal();
        try {
            if (!(await waitForEmptyInput(terminal))) {
                return 'busy-input';
            }
            deps.echo.remember(text);
            if (text.includes('\n')) {
                await terminal.pasteText(text);
            } else {
                await terminal.typeText(text);
            }
            await terminal.press(['enter']);
            await sleep(closeDelayMs);
            return 'sent';
        } finally {
            await terminal.close();
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
                const terminal = await deps.openTerminal();
                try {
                    await terminal.press(['escape']);
                } finally {
                    await terminal.close();
                }
            }).catch(() => undefined);
        },
    };
}
