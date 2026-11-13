/**
 * An invisible terminal for driving `claude attach <id>`.
 *
 * Each terminal is a detached tmux session on a private tmux server (`tmux -L jarvis-agents`),
 * so the user's own tmux server and sessions are never touched. The screen can be read, text
 * typed or pasted, and individual keys pressed, all without any visible window.
 * Deliberately independent from `utils/tmux.ts`, which talks to the default server.
 */

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const TMUX_SOCKET = 'jarvis-agents';
const TMUX_TIMEOUT_MS = 10_000;
const TMUX_MAX_BUFFER = 4 * 1024 * 1024;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;
const DEFAULT_READY_TIMEOUT_MS = 8_000;
const READY_POLL_INTERVAL_MS = 200;

export type AttachKey =
    | 'enter'
    | 'escape'
    | 'up'
    | 'down'
    | 'space'
    | 'tab'
    | 'backspace'
    | 'left'
    | 'right'
    /** Shift+Tab: cycles the permission mode under the input box. */
    | 'shift-tab'
    /** Ctrl+S, Claude Code's `chat:stash`: sets a draft aside (or brings it back into an empty box). */
    | 'stash'
    | { digit: number };

export type AttachTerminal = {
    /** Current visible screen with colour escapes kept (`capture-pane -p -e`); strip them before reading text. */
    screen(): Promise<string>;
    /**
     * Types text key by key (`send-keys -l`). Sends exactly what it is given, so callers
     * should pass user input through `sanitizeTypedText` first.
     */
    typeText(text: string): Promise<void>;
    /**
     * Pastes text (newlines included) as a single paste through a per-terminal tmux buffer.
     * Sends exactly what it is given, so callers should pass user input through
     * `sanitizeTypedText` first.
     */
    pasteText(text: string): Promise<void>;
    /** Presses keys in order. Throws before sending anything if a key is invalid. */
    press(keys: AttachKey[]): Promise<void>;
    /** Kills the tmux session. Safe to call more than once. */
    close(): Promise<void>;
};

export type OpenAttachTerminalOptions = {
    cols?: number;
    rows?: number;
    readyTimeoutMs?: number;
    /** Decides whether the program has drawn enough to be driven. Defaults to "screen is not blank". */
    isReady?: (screen: string) => boolean;
    /**
     * Name of the tmux server socket. Internal, for tests that must not share the production
     * server; production callers leave it unset and always get `jarvis-agents`.
     */
    socketName?: string;
};

const NAMED_KEYS: Record<Exclude<AttachKey, { digit: number }>, string> = {
    enter: 'Enter',
    escape: 'Escape',
    up: 'Up',
    down: 'Down',
    space: 'Space',
    tab: 'Tab',
    backspace: 'BSpace',
    left: 'Left',
    right: 'Right',
    'shift-tab': 'BTab',
    stash: 'C-s',
};

// OSC (ESC ] ... BEL | ESC \), CSI (ESC [ ... final), other two-byte ESC sequences, then C0 (minus \n and \t) and DEL.
const OSC_SEQUENCE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g;
const CSI_SEQUENCE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ESC_PAIR = /\x1b[@-_]/g;
const CONTROL_BYTES = /[\x00-\x08\x0b-\x1f\x7f]/g;

/** Removes ESC sequences and control bytes (keeping `\n` and `\t`) so typed text cannot inject terminal commands. */
export function sanitizeTypedText(text: string): string {
    return text
        .replace(OSC_SEQUENCE, '')
        .replace(CSI_SEQUENCE, '')
        .replace(ESC_PAIR, '')
        .replace(CONTROL_BYTES, '');
}

async function tmux(socket: string, args: string[], stdin?: string): Promise<string> {
    const pending = execFileAsync('tmux', ['-L', socket, ...args], {
        timeout: TMUX_TIMEOUT_MS,
        maxBuffer: TMUX_MAX_BUFFER,
    });
    if (stdin !== undefined) {
        pending.child.stdin?.end(stdin);
    }
    return (await pending).stdout;
}

/**
 * tmux treats a trailing `;` in an argv element as a command separator and silently drops it.
 * An element ending in `\;` keeps a literal `;` (one backslash is consumed), so a trailing
 * `;` gets one extra backslash in front of it. This also round-trips text that already ends in `\;`.
 */
function escapeTrailingSemicolon(arg: string): string {
    return arg.endsWith(';') ? `${arg.slice(0, -1)}\\;` : arg;
}

/** True when a `tmux` binary can be run. */
export async function isTmuxInstalled(): Promise<boolean> {
    try {
        await execFileAsync('tmux', ['-V'], { timeout: TMUX_TIMEOUT_MS });
        return true;
    } catch {
        return false;
    }
}

function toTmuxKey(key: AttachKey): string {
    if (typeof key === 'string') {
        return NAMED_KEYS[key];
    }
    if (!Number.isInteger(key.digit) || key.digit < 0 || key.digit > 9) {
        throw new Error(`Invalid digit key: ${String(key.digit)}`);
    }
    return String(key.digit);
}

/**
 * Starts `command` (argv, run without a shell) in a new detached tmux session and waits until
 * `isReady(screen)` is true. Closes the session and throws if that takes longer than `readyTimeoutMs`.
 */
export async function openAttachTerminal(command: string[], opts: OpenAttachTerminalOptions = {}): Promise<AttachTerminal> {
    if (command.length === 0) {
        throw new Error('openAttachTerminal needs a command');
    }
    const cols = opts.cols ?? DEFAULT_COLS;
    const rows = opts.rows ?? DEFAULT_ROWS;
    const readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    const isReady = opts.isReady ?? ((screen: string) => screen.trim().length > 0);

    const socket = opts.socketName ?? TMUX_SOCKET;
    const suffix = randomBytes(6).toString('hex');
    const session = `attach-${suffix}`;
    const buffer = `paste-${suffix}`;

    await tmux(socket, ['new-session', '-d', '-s', session, '-x', String(cols), '-y', String(rows), '--', ...command.map(escapeTrailingSemicolon)]);

    const terminal: AttachTerminal = {
        screen: () => tmux(socket, ['capture-pane', '-p', '-e', '-t', session]),
        typeText: async (text) => {
            if (text.length > 0) {
                await tmux(socket, ['send-keys', '-l', '-t', session, '--', escapeTrailingSemicolon(text)]);
            }
        },
        pasteText: async (text) => {
            if (text.length === 0) {
                return;
            }
            // The text goes through stdin so tmux never parses it as a command line.
            await tmux(socket, ['load-buffer', '-b', buffer, '-'], text);
            try {
                await tmux(socket, ['paste-buffer', '-p', '-d', '-b', buffer, '-t', session]);
            } catch (error) {
                await tmux(socket, ['delete-buffer', '-b', buffer]).catch(() => undefined);
                throw error;
            }
        },
        press: async (keys) => {
            const names = keys.map(toTmuxKey);
            if (names.length > 0) {
                await tmux(socket, ['send-keys', '-t', session, ...names]);
            }
        },
        close: async () => {
            await tmux(socket, ['kill-session', '-t', session]).catch(() => undefined);
        },
    };

    const deadline = Date.now() + readyTimeoutMs;
    for (;;) {
        let screen: string;
        try {
            screen = await terminal.screen();
        } catch (error) {
            await terminal.close();
            throw new Error(`Attach terminal exited before it was ready: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (isReady(screen)) {
            return terminal;
        }
        if (Date.now() >= deadline) {
            await terminal.close();
            throw new Error(`Attach terminal was not ready within ${readyTimeoutMs}ms`);
        }
        await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS));
    }
}
