import { describe, expect, it } from 'vitest';
import type { AttachTerminal } from './attachTerminal';
import type { Metadata } from '@/api/types';
import { anyUndelivered, buildMirrorMetadata, decideAgentChange, entriesAfter, isInterruptMarker, mirrorTag, resetMirrorMetadata, serializeTerminalOpens, settleStaleRequests, shouldAbortReuse, transcriptLineModel } from './runClaudeAgentMirror';
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

describe('serializeTerminalOpens with a user terminal', () => {
    const terminal = (log: string[], name: string): AttachTerminal => ({
        screen: async () => '',
        typeText: async () => undefined,
        pasteText: async () => undefined,
        press: async () => undefined,
        close: async () => {
            log.push(`close:${name}`);
        },
    });
    const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

    it('the user terminal and the tmux terminal share one lock', async () => {
        const log: string[] = [];
        const open = serializeTerminalOpens(
            async () => {
                log.push('open:tmux');
                return terminal(log, 'tmux');
            },
            async () => {
                log.push('open:user');
                return terminal(log, 'user');
            },
        );

        const user = await open.user();
        const tmux = open().then((opened) => {
            log.push('tmux-resolved');
            return opened;
        });
        await tick();
        expect(log).toEqual(['open:user']);

        await user?.close();
        await (await tmux).close();
        expect(log).toEqual(['open:user', 'close:user', 'open:tmux', 'tmux-resolved', 'close:tmux']);
    });

    it('releases the lock at once when there is no user terminal, and when looking for one fails', async () => {
        let looks = 0;
        const open = serializeTerminalOpens(
            async () => terminal([], 'tmux'),
            async () => {
                looks += 1;
                if (looks === 2) {
                    throw new Error('cmux broke');
                }
                return null;
            },
        );

        expect(await open.user()).toBeNull();
        await expect(open.user()).rejects.toThrow('cmux broke');
        await (await open()).close();
        expect(looks).toBe(2);
    });

    it('user() is null without a user opener and never takes the lock', async () => {
        const open = serializeTerminalOpens(async () => terminal([], 'tmux'));
        const held = await open();
        expect(await open.user()).toBeNull();
        await held.close();
    });

    it('drain also waits for a user terminal', async () => {
        const open = serializeTerminalOpens(async () => terminal([], 'tmux'), async () => terminal([], 'user'));
        const held = await open.user();
        expect(await open.drain(20)).toBe(false);
        await held?.close();
        expect(await open.drain(1000)).toBe(true);
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

describe('anyUndelivered', () => {
    const typed = (uuid: string, content: unknown, extra: Record<string, unknown> = {}) => ({ type: 'user', uuid, message: { role: 'user', content }, ...extra });

    it('is false when every skipped phone message is a typed line of the transcript', () => {
        const entries = [typed('u1', 'run the tests'), typed('u2', [{ type: 'text', text: 'then  fix\nthe build' }])];
        expect(anyUndelivered(['run the tests', 'then fix the build '], entries)).toBe(false);
    });

    it('is true when a skipped phone message never reached the transcript', () => {
        const entries = [typed('u1', 'run the tests')];
        expect(anyUndelivered(['run the tests', 'and deploy'], entries)).toBe(true);
        expect(anyUndelivered(['and deploy'], [])).toBe(true);
    });

    it('does not count tool results, side-chain or meta lines as typed', () => {
        const entries = [
            typed('u1', [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'and deploy' }]),
            typed('u2', 'and deploy', { isSidechain: true }),
            typed('u3', 'and deploy', { isMeta: true }),
            { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: 'and deploy' }] } },
        ];
        expect(anyUndelivered(['and deploy'], entries)).toBe(true);
    });
});

describe('isInterruptMarker', () => {
    it('matches the two markers Claude Code writes for a stopped turn', () => {
        expect(isInterruptMarker('[Request interrupted by user]')).toBe(true);
        expect(isInterruptMarker('[Request interrupted by user for tool use]')).toBe(true);
        expect(isInterruptMarker('  [Request interrupted by user for tool use]\n')).toBe(true);
    });

    it('leaves text that only mentions the marker alone', () => {
        expect(isInterruptMarker('why did you write [Request interrupted by user]?')).toBe(false);
        expect(isInterruptMarker('[Request interrupted]')).toBe(false);
        expect(isInterruptMarker('')).toBe(false);
    });
});

describe('transcriptLineModel', () => {
    it('reads the model of a main-agent assistant line', () => {
        expect(transcriptLineModel({ type: 'assistant', message: { model: 'claude-haiku-5-5', content: [] } })).toBe('claude-haiku-5-5');
    });

    it('ignores synthetic, side-chain, model-less and non-assistant lines', () => {
        expect(transcriptLineModel({ type: 'assistant', message: { model: '<synthetic>', content: [] } })).toBeNull();
        expect(transcriptLineModel({ type: 'assistant', isSidechain: true, message: { model: 'claude-haiku-5-5', content: [] } })).toBeNull();
        expect(transcriptLineModel({ type: 'assistant', message: { content: [] } })).toBeNull();
        expect(transcriptLineModel({ type: 'assistant', message: { model: '  ', content: [] } })).toBeNull();
        expect(transcriptLineModel({ type: 'user', message: { model: 'claude-haiku-5-5', content: 'hi' } })).toBeNull();
        expect(transcriptLineModel(null)).toBeNull();
    });
});
