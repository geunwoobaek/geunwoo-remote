/**
 * The Mac user's own cmux pane as an `AttachTerminal`.
 *
 * When the user already runs `claude attach <agentId>` in a cmux pane, phone input and answers can
 * go straight into that pane instead of a private tmux. `findAgentSurface` finds the pane (the
 * newest `claude ... attach <agentId>` process whose parents lead to a `surface:N` in `cmux top`),
 * and `openCmuxTerminal` drives it through the `cmux` CLI. cmux files every process started from a
 * pane under that pane even after it detaches (the daemon's private tmux attaches included), so a
 * pane only counts when the attach's real parents (`ps`) lead to the cmux app itself. The pane belongs to the user, so
 * `close()` never touches it, and everything that cannot be done safely through `cmux send`
 * (pasting, newlines, tabs, backslashes) is refused so the caller can use the tmux terminal.
 * Nothing here is cached: panes come and go, so every lookup asks `ps` and `cmux` again.
 *
 * The process arguments say which agent the pane attached to, not what it shows: inside
 * `claude attach` the user can open another agent from the agents list (`←`). `guardUserPane`
 * therefore lets the pane be typed or keyed into only right after a screen read that names the
 * target session (`paneShowsAgent`); any other screen counts as "no pane", so the caller uses
 * tmux, which always attaches the exact id.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '@/ui/logger';
import type { AttachKey, AttachTerminal } from './attachTerminal';
import { screenSessionName, screenSize } from './dialogs';
import type { ClaudeAgent } from './types';

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

/** The commands `findAgentSurface` and `userPaneSize` run. Injectable so tests never start a process. */
export type SurfaceLookupRunners = {
    /** `ps -axo pid=,ppid=,etime=,args=` output. */
    ps: () => Promise<string>;
    cmux: RunCmux;
};

/** A trailing `…` marks a session name cut short (by Claude Code's rule or by `claude agents`). */
const ELLIPSIS = '…';

/** Set once the "cmux answered but lists no app process" case was logged. */
let loggedNoAppPid = false;

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

const defaultRunners: SurfaceLookupRunners = {
    ps: async () => (await execFileAsync('ps', ['-axo', 'pid=,ppid=,etime=,args='], { timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_BUFFER })).stdout,
    cmux: runCmuxCommand,
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
 * Pids of the `claude ... attach <agentId>` processes in `ps -axo pid=,ppid=,etime=,args=` output,
 * youngest first. Only lines whose last two arguments are exactly `attach` and the id count: the
 * `--settings` JSON in between contains spaces, so no positional field can be trusted.
 */
export function attachPidsNewestFirst(psOutput: string, agentId: string): number[] {
    const found: Array<{ pid: number; age: number }> = [];
    for (const line of psOutput.split('\n')) {
        const match = /^\s*(\d+)\s+\d+\s+(\S+)\s+(.*)$/.exec(line);
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
 * The surface of `pid` from `surfaceForPid`, but only when its real parents in `ps -axo
 * pid=,ppid=,...` output reach a cmux app process (a `process` row whose parent is a `window:N`)
 * within 64 steps. A daemonized process (a tmux server, the Happy daemon) breaks that chain at pid 1,
 * so a private tmux attach is never taken for the user's pane. Null otherwise.
 */
export function userPaneSurface(psOutput: string, topTsv: string, pid: number): string | null {
    const appPids = cmuxAppPids(topTsv);
    const parentOf = new Map<number, number>();
    for (const line of psOutput.split('\n')) {
        const match = /^\s*(\d+)\s+(\d+)\s/.exec(line);
        if (match !== null) {
            parentOf.set(Number(match[1]), Number(match[2]));
        }
    }
    let current = parentOf.get(pid);
    for (let depth = 0; depth < MAX_PARENT_DEPTH && current !== undefined && current > 1; depth += 1) {
        if (appPids.has(current)) {
            return surfaceForPid(topTsv, pid);
        }
        current = parentOf.get(current);
    }
    return null;
}

/** The cmux app processes in `cmux top` output: `process` rows whose parent is a `window:N`. */
function cmuxAppPids(topTsv: string): Set<number> {
    const appPids = new Set<number>();
    for (const line of topTsv.split('\n')) {
        const columns = line.split('\t');
        if (columns.length >= 6 && columns[3] === 'process' && columns[5].startsWith('window:')) {
            appPids.add(Number(columns[4]));
        }
    }
    return appPids;
}

/**
 * The cmux surface running `claude attach <agentId>`, newest process first, or null when there is
 * none or anything goes wrong (no cmux, no permission, odd output): the caller then uses tmux.
 * `run` is only for tests; by default the real `ps` and `cmux` run.
 */
export async function findAgentSurface(agentId: string, run: SurfaceLookupRunners = defaultRunners): Promise<string | null> {
    try {
        const ps = await run.ps();
        const pids = attachPidsNewestFirst(ps, agentId);
        if (pids.length === 0) {
            return null;
        }
        const top = await run.cmux(['top', '--all', '--processes', '--format', 'tsv']);
        if (!loggedNoAppPid && cmuxAppPids(top).size === 0) {
            // Every lookup now falls back to tmux; make that visible once (cmux may have changed `top`).
            loggedNoAppPid = true;
            logger.debug('[claude-agent] cmux top lists no cmux app process, so no cmux pane is used');
        }
        for (const pid of pids) {
            const surface = userPaneSurface(ps, top, pid);
            if (surface !== null) {
                return surface;
            }
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * The size of the user's cmux pane for `agentId` (`screenSize` of its screen), or null when there
 * is no pane or it cannot be read. A private tmux attach opened at this size keeps Claude Code
 * from redrawing the user's pane at another size. This only reads the pane.
 */
export async function userPaneSize(agentId: string, run: SurfaceLookupRunners = defaultRunners): Promise<{ cols: number; rows: number } | null> {
    const surface = await findAgentSurface(agentId, run);
    if (surface === null) {
        return null;
    }
    try {
        return screenSize(await run.cmux(['read-screen', '--surface', surface]));
    } catch {
        return null;
    }
}

/**
 * True when two session names may name the same session. Equal names match; when one ends in `…`
 * (cut short), its stem must be a prefix of the other name (of the other's stem when both are
 * cut). An empty name or stem never matches.
 */
export function sessionNamesMatch(first: string, second: string): boolean {
    const [a, b] = [first.trim(), second.trim()].map((name) =>
        name.endsWith(ELLIPSIS) ? { stem: name.slice(0, -ELLIPSIS.length), cut: true } : { stem: name, cut: false },
    );
    if (a.stem.length === 0 || b.stem.length === 0) {
        return false;
    }
    if (!a.cut && !b.cut) {
        return a.stem === b.stem;
    }
    const [shorter, longer] = a.stem.length <= b.stem.length ? [a, b] : [b, a];
    // Only a cut name may stand for a longer one.
    return shorter.cut && longer.stem.startsWith(shorter.stem);
}

/**
 * True when `screen` names agent `agentId`'s session: the session name in its rule
 * (`screenSessionName`) matches that agent's name in `agents` (the latest `claude agents`
 * listing) and no other listed agent's name. False when the agent has no name or is not listed,
 * or the rule shows no name.
 */
export function paneShowsAgent(screen: string, agentId: string, agents: readonly ClaudeAgent[]): boolean {
    const shown = screenSessionName(screen);
    const target = agents.find((agent) => agent.id === agentId)?.name ?? null;
    if (shown === null || target === null || !sessionNamesMatch(target, shown)) {
        return false;
    }
    return !agents.some((agent) => agent.id !== agentId && agent.name !== null && sessionNamesMatch(agent.name, shown));
}

/**
 * Wraps the user's pane so it is typed or keyed into only right after a screen read that
 * `showsTarget` accepted. `screen` throws when the screen it read is not the target session (the
 * callers then use tmux, or stop when a key was already pressed); `typeText`, `pasteText` and
 * `press` throw without sending anything unless the latest read was accepted.
 */
export function guardUserPane(terminal: AttachTerminal, showsTarget: (screen: string) => boolean): AttachTerminal {
    let verified = false;
    const checked = async (send: () => Promise<void>): Promise<void> => {
        if (!verified) {
            throw new Error('The pane was not checked to show the target session');
        }
        await send();
    };
    return {
        screen: async () => {
            verified = false;
            const screen = await terminal.screen();
            if (!showsTarget(screen)) {
                throw new Error('The pane shows another session');
            }
            verified = true;
            return screen;
        },
        typeText: (text) => checked(() => terminal.typeText(text)),
        pasteText: (text) => checked(() => terminal.pasteText(text)),
        press: (keys) => checked(() => terminal.press(keys)),
        close: () => terminal.close(),
    };
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
