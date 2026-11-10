import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AttachTerminal } from './attachTerminal';
import {
    attachPidsNewestFirst,
    cmuxTypable,
    findAgentSurface,
    guardUserPane,
    openCmuxTerminal,
    paneShowsAgent,
    sessionNamesMatch,
    surfaceForPid,
    userPaneSize,
    userPaneSurface,
    type SurfaceLookupRunners,
} from './cmuxTerminal';
import type { ClaudeAgent } from './types';

const fixture = (name: string): string => readFileSync(join(__dirname, '__fixtures__', 'screens', `${name}.txt`), 'utf8');

const agent = (id: string, name: string | null): ClaudeAgent => ({
    id,
    sessionId: `session-${id}`,
    name,
    cwd: '/Users/tester/project',
    pid: 1,
    status: 'idle',
    state: null,
    startedAt: 0,
});

/** `input-empty` with the session name in the rule above the box replaced. */
const showing = (name: string): string => fixture('input-empty').replace(' demo-agent ─', ` ${name} ─`);

const SETTINGS = '{"permissions":{"ask":["Bash", "Write"]}}';

/**
 * `ps -axo pid=,ppid=,etime=,args=`: two attach panes for one id (old and new), another id, and a
 * look-alike prefix. 69804 runs in a cmux pane (zsh 66290 -> login 66280 -> cmux app 62303); 400 is
 * a private tmux attach whose server (38921) was daemonized to pid 1.
 */
const PS = [
    `62303     1 02:00:00 /Applications/cmux.app/Contents/MacOS/cmux`,
    `66280 62303 01:00:00 /usr/bin/login -flp tester /bin/zsh`,
    `66290 66280 01:00:00 -/bin/zsh`,
    `38921     1 01:26:53 tmux -L e2e-mac new-session -d -s main`,
    `  400 38921 01:02:03 /opt/homebrew/bin/claude --session-id aaaa --settings ${SETTINGS} attach 19f0c660`,
    `69804 66290    00:05 /opt/homebrew/bin/claude --session-id bbbb --settings ${SETTINGS} attach 19f0c660`,
    `70001 66290    00:09 /opt/homebrew/bin/claude --session-id cccc --settings ${SETTINGS} attach 77aa0000`,
    `70002 66290    00:01 /opt/homebrew/bin/claude --session-id dddd --settings ${SETTINGS} attach 19f0c660x`,
    `70003 66290    00:02 /opt/homebrew/bin/claude attach 19f0c660 --verbose`,
    `5001  5002    00:01 loop`,
    `5002  5001    00:01 loop`,
].join('\n');

const TOP = [
    '265.4\t30552103592\t411\ttotal\ttotal\t\t',
    '265.4\t30552103592\t411\twindow\twindow:1\ttotal\t',
    '17.3\t557664056\t1\tprocess\t62303\twindow:1\tcmux',
    '248.0\t29917646264\t408\tworkspace\tworkspace:1\twindow:1\t◐ some-workspace',
    '248.0\t29912321056\t407\tpane\tpane:6\tworkspace:1\t',
    '0.0\t76793272\t2\tsurface\tsurface:8\tpane:6\t✳ demo-agent',
    '0.0\t71451680\t1\tprocess\t69804\t66290\tclaude',
    '0.0\t5341592\t1\tprocess\t66290\tsurface:8\tzsh',
    '0.0\t5341592\t1\tprocess\t38922\twindow:1\tclaude',
    // cmux files every process started from a pane under that pane, even after it is daemonized:
    // the private tmux attach 400 (parent tmux 38921, parent pid 1) still shows under surface:8.
    '0.0\t100\t1\tprocess\t38921\tsurface:8\ttmux',
    '0.0\t100\t1\tprocess\t400\tsurface:8\tclaude',
    '0.0\t100\t1\tprocess\t5001\t5002\tloop',
    '0.0\t100\t1\tprocess\t5002\t5001\tloop',
].join('\n');

function recorder() {
    const calls: string[][] = [];
    const run = async (args: string[]): Promise<string> => {
        calls.push(args);
        return '';
    };
    return { calls, run };
}

describe('attachPidsNewestFirst', () => {
    it('attachPidsNewestFirst picks only attach <id> and orders newest first', () => {
        expect(attachPidsNewestFirst(PS, '19f0c660')).toEqual([69804, 400]);
    });

    it('attachPidsNewestFirst orders days, hours and minutes by elapsed time', () => {
        const ps = ['11 1 2-00:00:01 claude attach abc', '12 1 05:00:00 claude attach abc', '13 1 59:59 claude attach abc'].join('\n');
        expect(attachPidsNewestFirst(ps, 'abc')).toEqual([13, 12, 11]);
    });
});

describe('surfaceForPid', () => {
    it('surfaceForPid walks parents to a surface', () => {
        expect(surfaceForPid(TOP, 66290)).toBe('surface:8');
        expect(surfaceForPid(TOP, 69804)).toBe('surface:8');
    });

    it('surfaceForPid is null for a pid that is not under a surface or not listed', () => {
        expect(surfaceForPid(TOP, 38922)).toBeNull();
        expect(surfaceForPid(TOP, 123456)).toBeNull();
    });

    it('surfaceForPid is null for a parent cycle', () => {
        expect(surfaceForPid(TOP, 5001)).toBeNull();
    });
});

describe('userPaneSurface', () => {
    it('userPaneSurface accepts an attach whose parents reach the cmux app', () => {
        expect(userPaneSurface(PS, TOP, 69804)).toBe('surface:8');
    });

    it('userPaneSurface rejects a daemonized tmux attach that cmux still files under a pane', () => {
        expect(surfaceForPid(TOP, 400)).toBe('surface:8');
        expect(userPaneSurface(PS, TOP, 400)).toBeNull();
    });

    it('userPaneSurface is null for an unknown pid or a parent cycle', () => {
        expect(userPaneSurface(PS, TOP, 123456)).toBeNull();
        expect(userPaneSurface(PS, TOP, 5001)).toBeNull();
    });
});

describe('openCmuxTerminal', () => {
    it('screen reads the surface with read-screen', async () => {
        const calls: string[][] = [];
        const terminal = openCmuxTerminal('surface:8', async (args) => {
            calls.push(args);
            return 'the screen';
        });
        expect(await terminal.screen()).toBe('the screen');
        expect(calls).toEqual([['read-screen', '--surface', 'surface:8']]);
    });

    it('typeText sends one line verbatim after --', async () => {
        const { calls, run } = recorder();
        await openCmuxTerminal('surface:8', run).typeText('-n hello there');
        expect(calls).toEqual([['send', '--surface', 'surface:8', '--', '-n hello there']]);
    });

    it('typeText refuses newline, tab and backslash without sending', async () => {
        const { calls, run } = recorder();
        const terminal = openCmuxTerminal('surface:8', run);
        for (const text of ['a\nb', 'a\rb', 'a\tb', 'a\\nb']) {
            await expect(terminal.typeText(text)).rejects.toThrow();
        }
        expect(calls).toEqual([]);
    });

    it('pasteText always throws', async () => {
        const { calls, run } = recorder();
        await expect(openCmuxTerminal('surface:8', run).pasteText('x')).rejects.toThrow();
        expect(calls).toEqual([]);
    });

    it('press sends named keys with send-key and digits with send', async () => {
        const { calls, run } = recorder();
        const terminal = openCmuxTerminal('surface:8', run);
        await terminal.press(['enter', 'escape', 'up', 'down', 'space', 'tab', 'backspace']);
        await terminal.press([{ digit: 3 }]);
        expect(calls).toEqual([
            ['send-key', '--surface', 'surface:8', 'enter'],
            ['send-key', '--surface', 'surface:8', 'escape'],
            ['send-key', '--surface', 'surface:8', 'up'],
            ['send-key', '--surface', 'surface:8', 'down'],
            ['send-key', '--surface', 'surface:8', 'space'],
            ['send-key', '--surface', 'surface:8', 'tab'],
            ['send-key', '--surface', 'surface:8', 'backspace'],
            ['send', '--surface', 'surface:8', '--', '3'],
        ]);
    });

    it('press rejects an invalid digit without sending anything', async () => {
        const { calls, run } = recorder();
        await expect(openCmuxTerminal('surface:8', run).press(['enter', { digit: 12 }])).rejects.toThrow();
        expect(calls).toEqual([]);
    });

    it('close does nothing', async () => {
        const { calls, run } = recorder();
        await openCmuxTerminal('surface:8', run).close();
        expect(calls).toEqual([]);
    });
});

describe('findAgentSurface', () => {
    /** Runners answering `ps` and `cmux top` with the given text; every cmux call is recorded. */
    function runners(ps: string | Error, top: string | Error = TOP) {
        const cmuxCalls: string[][] = [];
        const run: SurfaceLookupRunners = {
            ps: async () => {
                if (ps instanceof Error) {
                    throw ps;
                }
                return ps;
            },
            cmux: async (args) => {
                cmuxCalls.push(args);
                if (args[0] === 'read-screen') {
                    return fixture('write-perm-99');
                }
                if (top instanceof Error) {
                    throw top;
                }
                return top;
            },
        };
        return { run, cmuxCalls };
    }

    it('returns the surface of the newest attach whose parents reach the cmux app', async () => {
        const { run, cmuxCalls } = runners(PS);
        expect(await findAgentSurface('19f0c660', run)).toBe('surface:8');
        expect(cmuxCalls).toEqual([['top', '--all', '--processes', '--format', 'tsv']]);
    });

    it('does not ask cmux when no process attaches to the agent', async () => {
        const { run, cmuxCalls } = runners(PS);
        expect(await findAgentSurface('nobody00', run)).toBeNull();
        expect(cmuxCalls).toEqual([]);
    });

    it('is null when only a daemonized tmux attach exists', async () => {
        const ps = PS.split('\n').filter((line) => !line.startsWith('69804')).join('\n');
        expect(await findAgentSurface('19f0c660', runners(ps).run)).toBeNull();
    });

    it('is null when cmux lists no app process, or ps or cmux fails', async () => {
        const noApp = TOP.split('\n').filter((line) => !line.includes('\t62303\t')).join('\n');
        expect(await findAgentSurface('19f0c660', runners(PS, noApp).run)).toBeNull();
        expect(await findAgentSurface('19f0c660', runners(new Error('ps failed')).run)).toBeNull();
        expect(await findAgentSurface('19f0c660', runners(PS, new Error('cmux socket refused')).run)).toBeNull();
    });

    it('userPaneSize reads the found pane and is null without one', async () => {
        const { run, cmuxCalls } = runners(PS);
        expect(await userPaneSize('19f0c660', run)).toEqual({ cols: 99, rows: 35 });
        expect(cmuxCalls[1]).toEqual(['read-screen', '--surface', 'surface:8']);
        expect(await userPaneSize('nobody00', runners(PS).run)).toBeNull();
    });
});

describe('sessionNamesMatch', () => {
    it('matches equal names only when neither is cut short', () => {
        expect(sessionNamesMatch('demo-agent', 'demo-agent')).toBe(true);
        expect(sessionNamesMatch(' demo-agent ', 'demo-agent')).toBe(true);
        expect(sessionNamesMatch('demo-agent', 'demo-agent-2')).toBe(false);
        expect(sessionNamesMatch('demo', 'demo-agent')).toBe(false);
    });

    it('matches a name cut short with … by prefix, on either side', () => {
        expect(sessionNamesMatch('demo-agent-continue-cooperative-…', 'demo-agent-continue-cooperative-chat')).toBe(true);
        expect(sessionNamesMatch('demo-agent-continue-cooperative-chat', 'demo-agent-continue-c…')).toBe(true);
        expect(sessionNamesMatch('demo-agent-continue-cooperative-…', 'demo-agent-continue-c…')).toBe(true);
        expect(sessionNamesMatch('demo-agent-…', 'other-agent')).toBe(false);
        expect(sessionNamesMatch('demo-agent-…', 'demo-agent')).toBe(false);
    });

    it('never matches an empty name or a bare ellipsis', () => {
        expect(sessionNamesMatch('', '')).toBe(false);
        expect(sessionNamesMatch('…', 'demo-agent')).toBe(false);
        expect(sessionNamesMatch('demo-agent', '…')).toBe(false);
    });
});

describe('paneShowsAgent', () => {
    const agents = [agent('a1', 'demo-agent'), agent('b2', 'other-agent'), agent('c3', null)];

    it('accepts the screen of the target agent', () => {
        expect(paneShowsAgent(fixture('input-empty'), 'a1', agents)).toBe(true);
        expect(paneShowsAgent(fixture('permission-write'), 'a1', agents)).toBe(true);
    });

    it("rejects another agent's screen", () => {
        expect(paneShowsAgent(showing('other-agent'), 'a1', agents)).toBe(false);
        expect(paneShowsAgent(fixture('permission-write').replace(' demo-agent ─', ' other-agent ─'), 'a1', agents)).toBe(false);
    });

    it('rejects an unnamed target, an unlisted target and a rule without a name', () => {
        expect(paneShowsAgent(fixture('input-empty'), 'c3', agents)).toBe(false);
        expect(paneShowsAgent(fixture('input-empty'), 'zz', agents)).toBe(false);
        expect(paneShowsAgent(fixture('input-empty').replace(' demo-agent ─', '─────────────'), 'a1', agents)).toBe(false);
    });

    it('accepts a cut-short name on the screen or in the listing', () => {
        expect(paneShowsAgent(showing('demo-ag…'), 'a1', agents)).toBe(true);
        expect(paneShowsAgent(fixture('input-empty'), 'a1', [agent('a1', 'demo-ag…'), agent('b2', 'other-agent')])).toBe(true);
    });

    it('rejects a name another listed agent also matches', () => {
        expect(paneShowsAgent(fixture('input-empty'), 'a1', [...agents, agent('d4', 'demo-agent')])).toBe(false);
        expect(paneShowsAgent(showing('demo-ag…'), 'a1', [...agents, agent('d4', 'demo-agent-2')])).toBe(false);
        expect(paneShowsAgent(fixture('input-empty'), 'a1', [agent('a1', 'demo-agent'), agent('d4', 'demo-…')])).toBe(false);
    });
});

describe('guardUserPane', () => {
    function pane(screen: string) {
        const sent: string[] = [];
        const terminal: AttachTerminal = {
            screen: async () => screen,
            typeText: async (text) => {
                sent.push(`type:${text}`);
            },
            pasteText: async (text) => {
                sent.push(`paste:${text}`);
            },
            press: async (keys) => {
                sent.push(`press:${keys.length}`);
            },
            close: async () => {
                sent.push('close');
            },
        };
        return { terminal, sent };
    }
    const agents = [agent('a1', 'demo-agent'), agent('b2', 'other-agent')];
    const guard = (terminal: AttachTerminal): AttachTerminal => guardUserPane(terminal, (screen) => paneShowsAgent(screen, 'a1', agents));

    it('passes keys and text on after a read that shows the target session', async () => {
        const { terminal, sent } = pane(fixture('input-empty'));
        const guarded = guard(terminal);
        expect(await guarded.screen()).toBe(fixture('input-empty'));
        await guarded.typeText('hi');
        await guarded.press(['enter']);
        await guarded.close();
        expect(sent).toEqual(['type:hi', 'press:1', 'close']);
    });

    it("throws on another session's screen and sends nothing after it", async () => {
        const { terminal, sent } = pane(showing('other-agent'));
        const guarded = guard(terminal);
        await expect(guarded.screen()).rejects.toThrow();
        await expect(guarded.typeText('hi')).rejects.toThrow();
        await expect(guarded.press(['escape'])).rejects.toThrow();
        await expect(guarded.pasteText('hi')).rejects.toThrow();
        expect(sent).toEqual([]);
    });

    it('refuses keys before any read', async () => {
        const { terminal, sent } = pane(fixture('input-empty'));
        await expect(guard(terminal).press(['escape'])).rejects.toThrow();
        expect(sent).toEqual([]);
    });

    it('refuses keys again once a later read shows another session', async () => {
        let current = fixture('input-empty');
        const { terminal, sent } = pane('');
        const guarded = guard({ ...terminal, screen: async () => current });
        await guarded.screen();
        await guarded.press([{ digit: 1 }]);
        current = showing('other-agent');
        await expect(guarded.screen()).rejects.toThrow();
        await expect(guarded.press([{ digit: 2 }])).rejects.toThrow();
        expect(sent).toEqual(['press:1']);
    });
});

describe('cmuxTypable', () => {
    it('accepts a plain line and refuses control characters and backslashes', () => {
        expect(cmuxTypable('hello 안녕')).toBe(true);
        expect(cmuxTypable('a\nb')).toBe(false);
        expect(cmuxTypable('a\rb')).toBe(false);
        expect(cmuxTypable('a\tb')).toBe(false);
        expect(cmuxTypable('a\\b')).toBe(false);
    });
});
