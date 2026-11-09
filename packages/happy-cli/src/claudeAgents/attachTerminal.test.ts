import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { openAttachTerminal, sanitizeTypedText, type AttachTerminal } from './attachTerminal';

const execFileAsync = promisify(execFile);
const SOCKET = 'jarvis-agents';

function tmuxPresent(): boolean {
    try {
        execFileSync('tmux', ['-V'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

const hasTmux = tmuxPresent();

async function tmuxRun(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
    try {
        const { stdout, stderr } = await execFileAsync('tmux', args);
        return { stdout, stderr, code: 0 };
    } catch (error) {
        const e = error as { stdout?: string; stderr?: string; code?: number };
        return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: typeof e.code === 'number' ? e.code : 1 };
    }
}

async function sessionNames(): Promise<string[]> {
    const result = await tmuxRun(['-L', SOCKET, 'list-sessions', '-F', '#{session_name}']);
    return result.code === 0 ? result.stdout.split('\n').filter(Boolean) : [];
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 4000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('waitFor timed out');
}

describe('sanitizeTypedText', () => {
    it('strips ESC sequences and control bytes', () => {
        expect(sanitizeTypedText('a\x1b[31mb\x03c')).toBe('abc');
    });

    it('keeps newlines and tabs', () => {
        expect(sanitizeTypedText('x\ny')).toBe('x\ny');
        expect(sanitizeTypedText('x\ty')).toBe('x\ty');
    });

    it('strips DEL and other C0 controls', () => {
        expect(sanitizeTypedText('a\x7fb\x00c\x08d\rE')).toBe('abcdE');
    });

    it('strips OSC sequences', () => {
        expect(sanitizeTypedText('a\x1b]0;title\x07b')).toBe('ab');
    });
});

describe.skipIf(!hasTmux)('attachTerminal (tmux)', () => {
    const opened: AttachTerminal[] = [];

    async function open(...args: Parameters<typeof openAttachTerminal>): Promise<AttachTerminal> {
        const terminal = await openAttachTerminal(...args);
        opened.push(terminal);
        return terminal;
    }

    afterEach(async () => {
        while (opened.length > 0) {
            await opened.pop()!.close();
        }
        // Safety net: only ever touch our own sessions on our own socket.
        for (const name of await sessionNames()) {
            if (name.startsWith('attach-')) {
                await tmuxRun(['-L', SOCKET, 'kill-session', '-t', name]);
            }
        }
    });

    const readyShell = ['sh', '-c', 'printf READY; read a; echo "got:$a"; sleep 5'];
    const sawReady = (screen: string) => screen.includes('READY');

    it('opens, types and reads the screen', async () => {
        const terminal = await open(readyShell, { isReady: sawReady });
        await terminal.typeText('hello');
        await terminal.press(['enter']);
        await waitFor(async () => (await terminal.screen()).includes('got:hello'));
        expect(await terminal.screen()).toContain('got:hello');
    });

    it('types text starting with a dash literally', async () => {
        const terminal = await open(readyShell, { isReady: sawReady });
        await terminal.typeText('-n x');
        await terminal.press(['enter']);
        await waitFor(async () => (await terminal.screen()).includes('got:-n x'));
    });

    it('pasteText delivers multi-line text as one paste', async () => {
        const terminal = await open(['cat'], { isReady: () => true });
        await terminal.pasteText('a\nb');
        // The tty echoes the pasted line break, so "a" lands on its own row and "b" on the next
        // one (where cat's own output of "a" is appended after the still-unterminated "b").
        const rows = async () => (await terminal.screen()).split('\n').map((line) => line.trim()).filter(Boolean);
        await waitFor(async () => {
            const lines = await rows();
            return lines[0] === 'a' && (lines[1] ?? '').includes('b');
        });
        const lines = await rows();
        expect(lines[0]).toBe('a');
        expect(lines[1]).toContain('b');
    });

    it('press maps navigation keys and digits', async () => {
        const terminal = await open(readyShell, { isReady: sawReady });
        await terminal.press([{ digit: 1 }, { digit: 2 }, 'backspace', 'space', { digit: 3 }, 'enter']);
        await waitFor(async () => (await terminal.screen()).includes('got:1 3'));
    });

    it('press rejects invalid digits', async () => {
        const terminal = await open(readyShell, { isReady: sawReady });
        await expect(terminal.press([{ digit: 10 }])).rejects.toThrow();
        await expect(terminal.press([{ digit: 1.5 }])).rejects.toThrow();
        await expect(terminal.press([{ digit: -1 }])).rejects.toThrow();
    });

    it('runs commands whose arguments contain spaces', async () => {
        const terminal = await open(
            ['sh', '-c', 'echo "[$1]"; sleep 5', 'sh', 'two words'],
            { isReady: (screen) => screen.includes('[two words]') },
        );
        expect(await terminal.screen()).toContain('[two words]');
    });

    it('uses a 120x40 terminal', async () => {
        const terminal = await open(
            ['sh', '-c', 'printf "SIZE:"; stty size; sleep 5'],
            { isReady: (screen) => /SIZE:\s*\d+ \d+/.test(screen) },
        );
        expect(await terminal.screen()).toContain('40 120');
    });

    it('close kills the tmux session', async () => {
        const terminal = await openAttachTerminal(readyShell, { isReady: sawReady });
        const [name] = (await sessionNames()).filter((n) => n.startsWith('attach-'));
        expect(name).toBeDefined();
        await terminal.close();
        const result = await tmuxRun(['-L', SOCKET, 'has-session', '-t', name]);
        expect(result.code).not.toBe(0);
        // closing twice is harmless
        await terminal.close();
    });

    it('closes the session and throws when it never becomes ready', async () => {
        await expect(
            openAttachTerminal(['sh', '-c', 'sleep 5'], { isReady: () => false, readyTimeoutMs: 600 }),
        ).rejects.toThrow(/ready/i);
        const leftovers = (await sessionNames()).filter((n) => n.startsWith('attach-'));
        expect(leftovers).toEqual([]);
    });

    it('gives concurrent terminals independent paste buffers', async () => {
        const [first, second] = await Promise.all([
            open(['cat'], { isReady: () => true }),
            open(['cat'], { isReady: () => true }),
        ]);
        await Promise.all([first.pasteText('one\n1'), second.pasteText('two\n2')]);
        await waitFor(async () => (await first.screen()).includes('one') && (await second.screen()).includes('two'));
        expect(await first.screen()).not.toContain('two');
        expect(await second.screen()).not.toContain('one');
    });

    it('does not touch the default tmux server', async () => {
        const before = await tmuxRun(['list-sessions']);
        const terminal = await open(readyShell, { isReady: sawReady });
        await terminal.typeText('x');
        const during = await tmuxRun(['list-sessions']);
        await terminal.close();
        const after = await tmuxRun(['list-sessions']);
        expect(during).toEqual(before);
        expect(after).toEqual(before);
    });
});
