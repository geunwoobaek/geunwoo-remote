/**
 * The Mac user's own cmux pane as an `AttachTerminal`.
 *
 * When the user already runs `claude attach <agentId>` in a cmux pane, phone input and answers can
 * go straight into that pane instead of a private tmux. `findAgentSurface` finds the pane (the
 * newest `claude ... attach <agentId>` process whose parents lead to a `surface:N` in `cmux top`),
 * and `openCmuxTerminal` drives it through the `cmux` CLI. The pane belongs to the user, so
 * `close()` never touches it, and everything that cannot be done safely through `cmux send`
 * (pasting, newlines, tabs, backslashes) is refused so the caller can use the tmux terminal.
 * Nothing here is cached: panes come and go, so every lookup asks `ps` and `cmux` again.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AttachKey, AttachTerminal } from './attachTerminal';

const execFileAsync = promisify(execFile);

const CMUX_APP_BINARY = '/Applications/cmux.app/Contents/Resources/bin/cmux';
const COMMAND_TIMEOUT_MS = 10_000;
const MAX_BUFFER = 16 * 1024 * 1024;
const MAX_PARENT_DEPTH = 64;
/** Text `cmux send` would interpret (newline, carriage return, tab) or escape (backslash). */
const UNTYPABLE = /[\n\r\t\\]/;
const SURFACE_REF = /^surface:\d+$/;
const ETIME = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/;

const NAMED_KEYS: ReadonlySet<string> = new Set(['enter', 'escape', 'up', 'down', 'space', 'tab', 'backspace']);

/** Runs `cmux <args>` and resolves its stdout. Injectable so tests never start a process. */
type RunCmux = (args: string[]) => Promise<string>;

/** Runs `cmux` from the PATH, or from the app bundle when the PATH has none. */
const runCmuxCommand: RunCmux = async (args) => {
    const options = { timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_BUFFER };
    try {
        return (await execFileAsync('cmux', args, options)).stdout;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
        }
        return (await execFileAsync(CMUX_APP_BINARY, args, options)).stdout;
    }
};

/** Seconds in a `ps` `etime` (`[[dd-]hh:]mm:ss`), or null when it is not one. */
function elapsedSeconds(etime: string): number | null {
    const match = ETIME.exec(etime);
    if (match === null) {
        return null;
    }
    const [days, hours, minutes, seconds] = [match[1], match[2], match[3], match[4]].map((part) => Number(part ?? 0));
    return ((days * 24 + hours) * 60 + minutes) * 60 + seconds;
}

/**
 * Pids of the `claude ... attach <agentId>` processes in `ps -axo pid=,etime=,args=` output,
 * youngest first. Only lines whose last two arguments are exactly `attach` and the id count: the
 * `--settings` JSON in between contains spaces, so no positional field can be trusted.
 */
export function attachPidsNewestFirst(psOutput: string, agentId: string): number[] {
    const found: Array<{ pid: number; age: number }> = [];
    for (const line of psOutput.split('\n')) {
        const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
        if (match === null) {
            continue;
        }
        const tokens = match[3].trim().split(/\s+/);
        const age = elapsedSeconds(match[2]);
        if (age !== null && tokens.length >= 2 && tokens[tokens.length - 2] === 'attach' && tokens[tokens.length - 1] === agentId) {
            found.push({ pid: Number(match[1]), age });
        }
    }
    return found.sort((a, b) => a.age - b.age).map((entry) => entry.pid);
}

/**
 * The `surface:N` that process `pid` lives under in `cmux top --all --processes --format tsv`
 * (columns cpu, mem, count, type, id, parent, name), found by following parents. Null when the
 * pid is not listed, has no surface above it (a tmux-launched attach), or the parents loop or are
 * deeper than 64 rows.
 */
export function surfaceForPid(topTsv: string, pid: number): string | null {
    const parents = new Map<string, string>();
    for (const line of topTsv.split('\n')) {
        const columns = line.split('\t');
        if (columns.length >= 6 && columns[4] !== '') {
            parents.set(columns[4], columns[5]);
        }
    }
    const seen = new Set<string>();
    let current = parents.get(String(pid));
    for (let depth = 0; depth < MAX_PARENT_DEPTH && current !== undefined && current !== ''; depth += 1) {
        if (SURFACE_REF.test(current)) {
            return current;
        }
        if (seen.has(current)) {
            return null;
        }
        seen.add(current);
        current = parents.get(current);
    }
    return null;
}

/**
 * The cmux surface running `claude attach <agentId>`, newest process first, or null when there is
 * none or anything goes wrong (no cmux, no permission, odd output): the caller then uses tmux.
 */
export async function findAgentSurface(agentId: string): Promise<string | null> {
    try {
        const { stdout: ps } = await execFileAsync('ps', ['-axo', 'pid=,etime=,args='], { timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_BUFFER });
        const pids = attachPidsNewestFirst(ps, agentId);
        if (pids.length === 0) {
            return null;
        }
        const top = await runCmuxCommand(['top', '--all', '--processes', '--format', 'tsv']);
        for (const pid of pids) {
            const surface = surfaceForPid(top, pid);
            if (surface !== null) {
                return surface;
            }
        }
        return null;
    } catch {
        return null;
    }
}

/** True when `typeText` accepts `text`: no newline, carriage return, tab or backslash. */
export function cmuxTypable(text: string): boolean {
    return !UNTYPABLE.test(text);
}

/** The cmux arguments that press `key`, or throws for an invalid key. */
function keyCommand(surface: string, key: AttachKey): string[] {
    if (typeof key === 'string') {
        if (!NAMED_KEYS.has(key)) {
            throw new Error(`Invalid key: ${key}`);
        }
        return ['send-key', '--surface', surface, key];
    }
    if (!Number.isInteger(key.digit) || key.digit < 0 || key.digit > 9) {
        throw new Error(`Invalid digit key: ${String(key.digit)}`);
    }
    return ['send', '--surface', surface, '--', String(key.digit)];
}

/**
 * Drives cmux pane `surface` (`surface:N`). `run` is only for tests; by default the real `cmux`
 * runs. `typeText` refuses text `cmuxTypable` rejects before sending anything; `pasteText` is
 * never supported; `close` leaves the user's pane alone.
 */
export function openCmuxTerminal(surface: string, run: RunCmux = runCmuxCommand): AttachTerminal {
    return {
        screen: () => run(['read-screen', '--surface', surface]),
        typeText: async (text) => {
            if (!cmuxTypable(text)) {
                throw new Error('This text cannot be typed through cmux');
            }
            if (text.length > 0) {
                await run(['send', '--surface', surface, '--', text]);
            }
        },
        pasteText: async () => {
            throw new Error('cmux terminals cannot paste');
        },
        press: async (keys) => {
            // Every key is checked first so an invalid one sends nothing.
            const commands = keys.map((key) => keyCommand(surface, key));
            for (const command of commands) {
                await run(command);
            }
        },
        close: async () => undefined,
    };
}
