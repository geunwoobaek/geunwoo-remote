import { describe, expect, it } from 'vitest';
import type { AttachTerminal } from './attachTerminal';
import type { Metadata } from '@/api/types';
import { buildMirrorMetadata, decideAgentChange, entriesAfter, mirrorTag, resetMirrorMetadata, serializeTerminalOpens, settleStaleRequests, shouldAbortReuse } from './runClaudeAgentMirror';
import type { ClaudeAgent } from './types';

const agent = (overrides: Partial<ClaudeAgent> = {}): ClaudeAgent => ({
    id: 'demo01',
    sessionId: 'session-a',
    name: 'demo-agent',
    cwd: '/Users/tester/project',
    pid: 4242,
    status: 'idle',
    state: null,
    startedAt: 1,
    ...overrides,
});

const base = {
    host: 'tester-mac',
    machineId: 'machine-1',
    homeDir: '/Users/tester',
    happyHomeDir: '/Users/tester/.happy',
    happyLibDir: '/lib/happy',
    happyToolsDir: '/lib/happy/tools/unpacked',
};

describe('buildMirrorMetadata', () => {
    it('buildMirrorMetadata sets claudeAgentId, claudeSessionId and path', () => {
        const metadata = buildMirrorMetadata(agent(), base);

        expect(metadata).toMatchObject({
            flavor: 'claude',
            path: '/Users/tester/project',
            cwd: '/Users/tester/project',
            claudeSessionId: 'session-a',
            claudeAgentId: 'demo01',
            startedBy: 'daemon',
            name: 'demo-agent',
            host: 'tester-mac',
            machineId: 'machine-1',
            lifecycleState: 'running',
        });
    });

    it('names the mirror after the folder when the agent has no name', () => {
        expect(buildMirrorMetadata(agent({ name: null }), base).name).toBe('project');
    });
});

describe('mirrorTag', () => {
    it('mirrorTag is stable per agent id', () => {
        expect(mirrorTag('demo01')).toBe('claude-agent-demo01');
        expect(mirrorTag('demo01')).toBe(mirrorTag('demo01'));
        expect(mirrorTag('demo02')).not.toBe(mirrorTag('demo01'));
    });
});

describe('entriesAfter', () => {
    const entries = [{ uuid: 'a' }, { uuid: 'b' }, { type: 'summary' }, { uuid: 'c' }];

    it('entriesAfter drops entries up to the saved uuid', () => {
        expect(entriesAfter(entries, 'b')).toEqual([{ type: 'summary' }, { uuid: 'c' }]);
        expect(entriesAfter(entries, 'c')).toEqual([]);
    });

    it('returns everything when the saved uuid is not in the entries or there is none', () => {
        expect(entriesAfter(entries, 'zzz')).toEqual(entries);
        expect(entriesAfter(entries, null)).toEqual(entries);
    });
});

describe('decideAgentChange', () => {
    it('decideAgentChange returns gone when the id is missing', () => {
        expect(decideAgentChange([agent({ id: 'other' })], 'demo01', 'session-a')).toBe('gone');
        expect(decideAgentChange([], 'demo01', 'session-a')).toBe('gone');
    });

    it('decideAgentChange returns switchTo when the sessionId changed', () => {
        expect(decideAgentChange([agent({ sessionId: 'session-b' })], 'demo01', 'session-a')).toEqual({ switchTo: 'session-b' });
    });

    it('decideAgentChange returns same otherwise', () => {
        expect(decideAgentChange([agent(), agent({ id: 'other', sessionId: 'x' })], 'demo01', 'session-a')).toBe('same');
    });
});

describe('serializeTerminalOpens', () => {
    function fakeTerminal(log: string[], name: string, failClose = false): AttachTerminal {
        return {
            screen: async () => '',
            typeText: async () => undefined,
            pasteText: async () => undefined,
            press: async () => undefined,
            close: async () => {
                log.push(`close:${name}`);
                if (failClose) {
                    throw new Error('close failed');
                }
            },
        };
    }

    const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

    it('two concurrent opens: the second resolves only after the first closes', async () => {
        const log: string[] = [];
        let n = 0;
        const open = serializeTerminalOpens(async () => {
            n += 1;
            log.push(`open:${n}`);
            return fakeTerminal(log, String(n));
        });

        const first = await open();
        const secondPromise = open().then((terminal) => {
            log.push('second-resolved');
            return terminal;
        });
        await tick();
        expect(log).toEqual(['open:1']);

        await first.close();
        const second = await secondPromise;
        expect(log).toEqual(['open:1', 'close:1', 'open:2', 'second-resolved']);
        await second.close();
    });

    it('releases once even when close throws or is called twice', async () => {
        const log: string[] = [];
        let n = 0;
        const open = serializeTerminalOpens(async () => {
            n += 1;
            return fakeTerminal(log, String(n), n === 1);
        });

        const first = await open();
        const secondPromise = open();
        const third = open();
        await expect(first.close()).rejects.toThrow('close failed');
        const second = await secondPromise;
        await first.close().catch(() => undefined);
        await tick();
        // The repeated close of the first terminal did not release the lock for the third open.
        expect(n).toBe(2);

        await second.close();
        await (await third).close();
        expect(n).toBe(3);
    });

    it('releases the lock when opening fails', async () => {
        let attempts = 0;
        const open = serializeTerminalOpens(async () => {
            attempts += 1;
            if (attempts === 1) {
                throw new Error('no tmux');
            }
            return fakeTerminal([], 'ok');
        });

        const failing = open();
        const next = open();
        await expect(failing).rejects.toThrow('no tmux');
        await (await next).close();
        expect(attempts).toBe(2);
    });
});

describe('serializeTerminalOpens drain', () => {
    const terminal = (): AttachTerminal => ({
        screen: async () => '',
        typeText: async () => undefined,
        pasteText: async () => undefined,
        press: async () => undefined,
        close: async () => undefined,
    });

    it('drain is true at once when nothing is open', async () => {
        const open = serializeTerminalOpens(async () => terminal());
        expect(await open.drain(50)).toBe(true);
    });

    it('drain waits for the open terminal to close and gives up after the timeout', async () => {
        const open = serializeTerminalOpens(async () => terminal());
        const held = await open();
        expect(await open.drain(20)).toBe(false);

        const draining = open.drain(1000);
        await held.close();
        expect(await draining).toBe(true);
    });

    it('drain also waits for opens that were already queued', async () => {
        const log: string[] = [];
        const open = serializeTerminalOpens(async () => {
            log.push('open');
            return terminal();
        });
        const first = await open();
        const queued = open();
        const draining = open.drain(1000);
        await first.close();
        const second = await queued;
        let done = false;
        void draining.then(() => {
            done = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(done).toBe(false);
        await second.close();
        expect(await draining).toBe(true);
    });
});

describe('shouldAbortReuse', () => {
    it('is true when the reused session metadata could not be decrypted', () => {
        expect(shouldAbortReuse(null)).toBe(true);
        expect(shouldAbortReuse(undefined)).toBe(true);
    });

    it('is false when metadata is readable', () => {
        expect(shouldAbortReuse({ path: '/x' })).toBe(false);
    });
});

describe('resetMirrorMetadata', () => {
    it('un-archives and points a reused session at the current agent', () => {
        const stale = {
            ...buildMirrorMetadata(agent({ sessionId: 'old-session' }), base),
            lifecycleState: 'archived',
            lifecycleStateSince: 1,
            archivedBy: 'cli',
            archiveReason: 'Background session ended',
            cwd: '/Users/tester/elsewhere',
        } satisfies Metadata;

        const reset = resetMirrorMetadata(stale, agent({ sessionId: 'session-b' }), 99);

        expect(reset).toMatchObject({
            claudeSessionId: 'session-b',
            claudeAgentId: 'demo01',
            cwd: '/Users/tester/project',
            lifecycleState: 'running',
            lifecycleStateSince: 99,
        });
        expect(reset.archivedBy).toBeUndefined();
        expect(reset.archiveReason).toBeUndefined();
    });
});

describe('settleStaleRequests', () => {
    const toolUse = (id: string) => ({ type: 'assistant', message: { id: `m_${id}`, content: [{ type: 'tool_use', id, name: 'Write', input: {} }] } });
    const toolResult = (id: string, isError = false) => ({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: 'x' }] },
    });
    const request = (tool = 'Write') => ({ tool, arguments: { file_path: '/Users/tester/project/a.md' }, createdAt: 5 });

    it('completes requests answered on the Mac while the mirror was down from the transcript', () => {
        const state = { requests: { toolu_ok: request(), toolu_no: request(), toolu_open: request(), 'screen:abc': request('Unknown') } };
        const entries = [toolUse('toolu_ok'), toolResult('toolu_ok'), toolUse('toolu_no'), toolResult('toolu_no', true), toolUse('toolu_open')];

        const settled = settleStaleRequests(state, entries, 77);

        expect(settled.requests).toEqual({});
        expect(settled.completedRequests?.toolu_ok).toMatchObject({ status: 'approved', decision: 'approved', toolUseId: 'toolu_ok', completedAt: 77, createdAt: 5 });
        expect(settled.completedRequests?.toolu_no).toMatchObject({ status: 'denied', decision: 'denied', toolUseId: 'toolu_no' });
        expect(settled.completedRequests?.toolu_open).toMatchObject({ status: 'canceled' });
        expect(settled.completedRequests?.['screen:abc']).toMatchObject({ status: 'canceled' });
    });

    it('keeps earlier completed requests and handles a state without requests', () => {
        const state = { completedRequests: { old: { tool: 'Bash', arguments: {}, createdAt: 1, completedAt: 2, status: 'approved' as const } } };

        const settled = settleStaleRequests(state, [], 77);

        expect(settled.completedRequests).toEqual(state.completedRequests);
        expect(settled.requests).toEqual({});
    });
});
