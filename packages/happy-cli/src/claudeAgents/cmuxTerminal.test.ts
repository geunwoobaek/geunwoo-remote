import { describe, expect, it } from 'vitest';
import { attachPidsNewestFirst, cmuxTypable, openCmuxTerminal, surfaceForPid } from './cmuxTerminal';

const SETTINGS = '{"permissions":{"ask":["Bash", "Write"]}}';

/** `ps -axo pid=,etime=,args=`: two attach panes for one id (old and new), another id, and a look-alike prefix. */
const PS = [
    `38921 01:26:53 tmux -L e2e-mac new-session -d -s main`,
    `  400 01:02:03 /opt/homebrew/bin/claude --session-id aaaa --settings ${SETTINGS} attach 19f0c660`,
    `69804    00:05 /opt/homebrew/bin/claude --session-id bbbb --settings ${SETTINGS} attach 19f0c660`,
    `70001    00:09 /opt/homebrew/bin/claude --session-id cccc --settings ${SETTINGS} attach 77aa0000`,
    `70002    00:01 /opt/homebrew/bin/claude --session-id dddd --settings ${SETTINGS} attach 19f0c660x`,
    `70003    00:02 /opt/homebrew/bin/claude attach 19f0c660 --verbose`,
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
        const ps = ['11 2-00:00:01 claude attach abc', '12 05:00:00 claude attach abc', '13 59:59 claude attach abc'].join('\n');
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

describe('cmuxTypable', () => {
    it('accepts a plain line and refuses control characters and backslashes', () => {
        expect(cmuxTypable('hello 안녕')).toBe(true);
        expect(cmuxTypable('a\nb')).toBe(false);
        expect(cmuxTypable('a\rb')).toBe(false);
        expect(cmuxTypable('a\tb')).toBe(false);
        expect(cmuxTypable('a\\b')).toBe(false);
    });
});
