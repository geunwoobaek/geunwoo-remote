import { describe, expect, it } from 'vitest';
import type { Metadata } from '@/api/types';
import {
    LATE_MIRROR_WAIT_MS,
    MIRROR_RESUME_REFUSAL,
    createClaudeAgentHandlers,
    isClaudeAgentMirror,
    pickPersistedMirrors,
    type ClaudeAgentHandlerDeps,
    type OpenClaudeAgentResult,
    type PersistedMirror,
} from './daemonHandlers';
import type { ClaudeAgent } from './types';

function agent(id: string, overrides: Partial<ClaudeAgent> = {}): ClaudeAgent {
    return {
        id,
        sessionId: `session-${id}`,
        name: 'demo-agent',
        cwd: '/Users/tester/project',
        pid: 100,
        status: 'idle',
        state: null,
        startedAt: 1,
        ...overrides,
    };
}

const persisted: PersistedMirror = {
    happySessionId: 'happy-old',
    encryptionKey: 'a2V5',
    encryptionVariant: 'dataKey',
    seq: 7,
    metadataVersion: 3,
    agentStateVersion: 4,
};

type SpawnCall = { agentId: string; reconnect: { happySessionId: string; env: Record<string, string> } | undefined; cwd: string };

function makeDeps(overrides: Partial<ClaudeAgentHandlerDeps> = {}): { deps: ClaudeAgentHandlerDeps; spawns: SpawnCall[] } {
    const spawns: SpawnCall[] = [];
    const deps: ClaudeAgentHandlerDeps = {
        resolveClaude: async () => '/usr/local/bin/claude',
        tmuxInstalled: async () => true,
        fetchAgents: async () => [agent('abc12345')],
        liveMirrors: () => new Map(),
        lastLine: () => null,
        mirrorStarting: () => false,
        persistedMirrors: () => new Map(),
        spawnMirror: async (agentId, reconnect, cwd) => {
            spawns.push({ agentId, reconnect, cwd });
            return { type: 'success', sessionId: 'happy-new' };
        },
        runClaudeBg: async () => { throw new Error('runClaudeBg not expected'); },
        stopAgent: async () => { throw new Error('stopAgent not expected'); },
        removeAgent: async () => { throw new Error('removeAgent not expected'); },
        ensureDirectory: async () => ({ type: 'ok', created: false }),
        sleep: async () => undefined,
        ...overrides,
    };
    return { deps, spawns };
}

describe('list-claude-agents', () => {
    it('list reports claude-missing when claude cannot be found', async () => {
        const { deps } = makeDeps({ resolveClaude: async () => null });
        expect(await createClaudeAgentHandlers(deps).list()).toEqual({ agents: [], unavailable: 'claude-missing', startSupported: true });
    });

    it('list reports tmux-missing when tmux is absent', async () => {
        const { deps } = makeDeps({ tmuxInstalled: async () => false });
        expect(await createClaudeAgentHandlers(deps).list()).toEqual({ agents: [], unavailable: 'tmux-missing', startSupported: true });
    });

    it('list reports agents-command-failed instead of throwing when claude agents fails', async () => {
        const { deps } = makeDeps({ fetchAgents: async () => { throw new Error('boom'); } });
        expect(await createClaudeAgentHandlers(deps).list()).toEqual({ agents: [], unavailable: 'agents-command-failed', startSupported: true });
    });

    it('list attaches mirrorSessionId for live mirrors', async () => {
        const { deps, spawns } = makeDeps({
            fetchAgents: async () => [agent('abc12345'), agent('def67890')],
            liveMirrors: () => new Map([['abc12345', 'happy-live']]),
        });
        const listing = await createClaudeAgentHandlers(deps).list();
        expect(listing.unavailable).toBeUndefined();
        expect(listing.agents.map((entry) => [entry.id, entry.mirrorSessionId])).toEqual([
            ['abc12345', 'happy-live'],
            ['def67890', undefined],
        ]);
        expect('mirrorSessionId' in listing.agents[1]).toBe(false);
        expect(spawns).toEqual([]);
    });

    it('list carries each session\'s last line and leaves it out when there is none', async () => {
        const { deps } = makeDeps({
            fetchAgents: async () => [agent('abc12345'), agent('def67890')],
            lastLine: (listed) => (listed.id === 'abc12345' ? 'Tests pass' : null),
        });
        const listing = await createClaudeAgentHandlers(deps).list();
        expect(listing.agents[0].lastLine).toBe('Tests pass');
        expect('lastLine' in listing.agents[1]).toBe(false);
    });

    it('listReportsStartSupported', async () => {
        const { deps } = makeDeps();
        const listing = await createClaudeAgentHandlers(deps).list();
        expect(listing.startSupported).toBe(true);
        expect(listing.unavailable).toBeUndefined();
    });
});

const BACKGROUNDED = 'warning: no prompt given\nbackgrounded · 35d81094 · fix the login bug (idle — send a prompt to start)\n';
const UNTRUSTED = 'Workspace not trusted. Run `claude` in /Users/tester/project once and accept the trust prompt, then retry.\n';

type StartFakes = {
    bgRuns: Array<{ claudePath: string; cwd: string; args: string[] }>;
    calls: string[];
    sleeps: number[];
    fetches: () => number;
};

/**
 * Deps for the start flow: `claude --bg` prints `output`, and the new agent is listed from the
 * `appearsOnFetch`-th `claude agents` call on (never when null).
 */
function makeStartDeps(
    options: { output?: { stdout: string; stderr: string; code: number | null }; appearsOnFetch?: number | null } = {},
    overrides: Partial<ClaudeAgentHandlerDeps> = {},
): { deps: ClaudeAgentHandlerDeps; spawns: SpawnCall[]; fakes: StartFakes } {
    const output = options.output ?? { stdout: BACKGROUNDED, stderr: '', code: 0 };
    const appearsOnFetch = options.appearsOnFetch === undefined ? 2 : options.appearsOnFetch;
    let fetchCount = 0;
    const fakes: StartFakes = { bgRuns: [], calls: [], sleeps: [], fetches: () => fetchCount };
    const made = makeDeps({
        fetchAgents: async () => {
            fetchCount += 1;
            return appearsOnFetch !== null && fetchCount >= appearsOnFetch ? [agent('35d81094')] : [];
        },
        runClaudeBg: async (claudePath, cwd, args) => {
            fakes.bgRuns.push({ claudePath, cwd, args });
            fakes.calls.push('bg');
            return output;
        },
        stopAgent: async (_claudePath, id) => { fakes.calls.push(`stop ${id}`); },
        removeAgent: async (_claudePath, id) => { fakes.calls.push(`rm ${id}`); },
        sleep: async (ms) => { fakes.sleeps.push(ms); },
        ...overrides,
    });
    return { ...made, fakes };
}

const startRequest = { directory: '/Users/tester/project', name: 'fix the login bug' };

describe('start-claude-agent', () => {
    it('startsInTheFolderAndOpensTheMirror', async () => {
        const { deps, spawns, fakes } = makeStartDeps({}, {});
        const result = await createClaudeAgentHandlers(deps).start({ ...startRequest, permissionMode: 'acceptEdits', model: 'opus', effort: 'high' });
        expect(result).toEqual({ type: 'success', sessionId: 'happy-new', agentId: '35d81094' });
        expect(fakes.bgRuns).toEqual([{
            claudePath: '/usr/local/bin/claude',
            cwd: '/Users/tester/project',
            args: ['--bg', '--name', 'fix the login bug', '--permission-mode', 'acceptEdits', '--model', 'opus', '--effort', 'high'],
        }]);
        // Not listed on the first poll, listed on the second; then the mirror open lists it once more.
        expect(fakes.sleeps).toEqual([500]);
        expect(spawns).toEqual([{ agentId: '35d81094', reconnect: undefined, cwd: '/Users/tester/project' }]);
        expect(fakes.calls).toEqual(['bg']);
    });

    it('answersUntrustedFolderWithTheDirectory', async () => {
        const { deps, spawns, fakes } = makeStartDeps({ output: { stdout: '', stderr: UNTRUSTED, code: 1 } });
        const result = await createClaudeAgentHandlers(deps).start(startRequest);
        expect(result).toMatchObject({ type: 'error', code: 'untrusted-folder', directory: '/Users/tester/project' });
        expect(fakes.calls).toEqual(['bg']);
        expect(fakes.fetches()).toBe(0);
        expect(spawns).toEqual([]);
    });

    it('answersStartFailedWhenTheIdCannotBeRead', async () => {
        const { deps, spawns, fakes } = makeStartDeps({ output: { stdout: 'error\n', stderr: '', code: 1 } });
        const result = await createClaudeAgentHandlers(deps).start(startRequest);
        expect(result).toMatchObject({ type: 'error', code: 'start-failed' });
        expect(fakes.calls).toEqual(['bg']);
        expect(spawns).toEqual([]);
    });

    it('cleansUpWhenTheAgentNeverAppears', async () => {
        const { deps, spawns, fakes } = makeStartDeps({ appearsOnFetch: null });
        const handlers = createClaudeAgentHandlers(deps);
        const result = await handlers.start(startRequest);
        expect(result).toMatchObject({ type: 'error', code: 'start-failed' });
        expect(fakes.sleeps.reduce((total, ms) => total + ms, 0)).toBe(10_000);
        expect(fakes.sleeps.every((ms) => ms === 500)).toBe(true);
        expect(fakes.calls).toEqual(['bg', 'stop 35d81094', 'rm 35d81094']);
        expect(spawns).toEqual([]);
        // Already removed: a later discard has nothing of ours to act on.
        expect(await handlers.discard('35d81094')).toMatchObject({ type: 'error', code: 'not-started-here' });
    });

    it('cleansUpWhenTheMirrorFailsToOpen', async () => {
        const { deps, fakes } = makeStartDeps({}, {
            spawnMirror: async () => ({ type: 'error', errorMessage: 'Session process 1 exited before connecting.' }),
        });
        const result = await createClaudeAgentHandlers(deps).start(startRequest);
        expect(result).toEqual({ type: 'error', code: 'start-failed', errorMessage: 'Session process 1 exited before connecting.' });
        expect(fakes.calls).toEqual(['bg', 'stop 35d81094', 'rm 35d81094']);
    });

    it('opens a mirror that reports after the webhook timeout, keeping the agent', async () => {
        let polls = 0;
        const { deps, fakes } = makeStartDeps({}, {
            spawnMirror: async () => ({ type: 'error', errorMessage: 'Session webhook timeout for PID 1' }),
            mirrorStarting: () => true,
            liveMirrors: () => (polls++ >= 3 ? new Map([['35d81094', 'happy-late']]) : new Map()),
        });
        const result = await createClaudeAgentHandlers(deps).start(startRequest);
        expect(result).toEqual({ type: 'success', sessionId: 'happy-late', agentId: '35d81094' });
        expect(fakes.calls).toEqual(['bg']);
    });

    it('keeps the agent when its mirror is still connecting after the extra wait', async () => {
        const { deps, fakes } = makeStartDeps({ appearsOnFetch: 1 }, {
            spawnMirror: async () => ({ type: 'error', errorMessage: 'Session webhook timeout for PID 1' }),
            mirrorStarting: () => true,
        });
        const handlers = createClaudeAgentHandlers(deps);
        const result = await handlers.start(startRequest);
        expect(result).toMatchObject({ type: 'error', code: 'start-failed' });
        expect((result as { errorMessage: string }).errorMessage).toContain('still connecting');
        expect(fakes.calls).toEqual(['bg']);
        expect(fakes.sleeps.reduce((total, ms) => total + ms, 0)).toBe(LATE_MIRROR_WAIT_MS);
        // Still ours: the user can discard it from the phone.
        expect(await handlers.discard('35d81094')).toMatchObject({ type: 'success' });
    });

    it('cleans up when opening the mirror throws', async () => {
        const { deps, fakes } = makeStartDeps({}, {
            spawnMirror: async () => { throw new Error('boom'); },
        });
        const result = await createClaudeAgentHandlers(deps).start(startRequest);
        expect(result).toMatchObject({ type: 'error', code: 'start-failed' });
        expect(fakes.calls).toEqual(['bg', 'stop 35d81094', 'rm 35d81094']);
    });

    it('still removes the agent when stop fails', async () => {
        const { deps, fakes } = makeStartDeps({ appearsOnFetch: null }, {
            stopAgent: async (_claudePath, id) => { fakes.calls.push(`stop ${id}`); throw new Error('already stopped'); },
        });
        const result = await createClaudeAgentHandlers(deps).start(startRequest);
        expect(result).toMatchObject({ type: 'error', code: 'start-failed' });
        expect(fakes.calls).toEqual(['bg', 'stop 35d81094', 'rm 35d81094']);
    });

    it('passesTheMissingToolCodes', async () => {
        const noClaude = makeStartDeps({}, { resolveClaude: async () => null });
        expect(await createClaudeAgentHandlers(noClaude.deps).start(startRequest)).toMatchObject({ type: 'error', code: 'claude-missing' });
        const noTmux = makeStartDeps({}, { tmuxInstalled: async () => false });
        expect(await createClaudeAgentHandlers(noTmux.deps).start(startRequest)).toMatchObject({ type: 'error', code: 'tmux-missing' });
        expect([...noClaude.fakes.calls, ...noTmux.fakes.calls]).toEqual([]);
    });

    it('asksBeforeCreatingAMissingFolder', async () => {
        const approvals: boolean[] = [];
        const { deps, fakes } = makeStartDeps({}, {
            ensureDirectory: async (directory, approved) => {
                approvals.push(approved);
                return approved ? { type: 'ok', created: true } : { type: 'requestToApproveDirectoryCreation', directory };
            },
        });
        const handlers = createClaudeAgentHandlers(deps);
        expect(await handlers.start({ ...startRequest, clientRequestId: 'r1' }))
            .toEqual({ type: 'requestToApproveDirectoryCreation', directory: '/Users/tester/project' });
        expect(fakes.calls).toEqual([]);
        // The app answers the question by retrying with the same request id and the approval.
        expect(await handlers.start({ ...startRequest, clientRequestId: 'r1', approvedNewDirectoryCreation: true }))
            .toMatchObject({ type: 'success', agentId: '35d81094' });
        expect(approvals).toEqual([false, true]);
        expect(fakes.calls).toEqual(['bg']);
    });

    it('answers start-failed when the folder cannot be created', async () => {
        const { deps, fakes } = makeStartDeps({}, {
            ensureDirectory: async () => ({ type: 'error', errorMessage: 'Unable to create directory.' }),
        });
        expect(await createClaudeAgentHandlers(deps).start({ ...startRequest, approvedNewDirectoryCreation: true }))
            .toEqual({ type: 'error', code: 'start-failed', errorMessage: 'Unable to create directory.', directory: '/Users/tester/project' });
        expect(fakes.calls).toEqual([]);
    });

    it('reusesTheResultForTheSameClientRequestId', async () => {
        let release!: () => void;
        const { deps, fakes } = makeStartDeps({}, {
            runClaudeBg: async (claudePath, cwd, args) => {
                fakes.bgRuns.push({ claudePath, cwd, args });
                await new Promise<void>((resolve) => { release = resolve; });
                return { stdout: BACKGROUNDED, stderr: '', code: 0 };
            },
        });
        const handlers = createClaudeAgentHandlers(deps);
        const first = handlers.start({ ...startRequest, clientRequestId: 'r1' });
        const second = handlers.start({ ...startRequest, clientRequestId: 'r1' });
        await new Promise((resolve) => setTimeout(resolve, 0));
        release();
        const expected = { type: 'success', sessionId: 'happy-new', agentId: '35d81094' };
        expect(await Promise.all([first, second])).toEqual([expected, expected]);
        // A retry after the answer was lost gets the same session back.
        expect(await handlers.start({ ...startRequest, clientRequestId: 'r1' })).toEqual(expected);
        expect(fakes.bgRuns).toHaveLength(1);
    });

    it('starts again for a request id whose earlier attempt failed', async () => {
        let runs = 0;
        const { deps } = makeStartDeps({}, {
            runClaudeBg: async () => {
                runs += 1;
                return runs === 1 ? { stdout: '', stderr: UNTRUSTED, code: 1 } : { stdout: BACKGROUNDED, stderr: '', code: 0 };
            },
        });
        const handlers = createClaudeAgentHandlers(deps);
        expect(await handlers.start({ ...startRequest, clientRequestId: 'r1' })).toMatchObject({ code: 'untrusted-folder' });
        expect(await handlers.start({ ...startRequest, clientRequestId: 'r1' })).toMatchObject({ type: 'success' });
        expect(runs).toBe(2);
    });
});

describe('discard-claude-agent', () => {
    it('discardsAnAgentItStarted', async () => {
        const { deps, fakes } = makeStartDeps();
        const handlers = createClaudeAgentHandlers(deps);
        await handlers.start({ ...startRequest, clientRequestId: 'r1' });
        expect(await handlers.discard('35d81094')).toEqual({ type: 'success' });
        expect(fakes.calls).toEqual(['bg', 'stop 35d81094', 'rm 35d81094']);
        // Gone from startedHere: a second discard is refused and runs nothing.
        expect(await handlers.discard('35d81094')).toMatchObject({ type: 'error', code: 'not-started-here' });
        expect(fakes.calls).toEqual(['bg', 'stop 35d81094', 'rm 35d81094']);
        // The discarded start is not answered again for its request id.
        await handlers.start({ ...startRequest, clientRequestId: 'r1' });
        expect(fakes.bgRuns).toHaveLength(2);
    });

    it('refusesToDiscardAnAgentItDidNotStart', async () => {
        const { deps, fakes } = makeStartDeps();
        const result = await createClaudeAgentHandlers(deps).discard('abc12345');
        expect(result).toMatchObject({ type: 'error', code: 'not-started-here' });
        expect(fakes.calls).toEqual([]);
    });

    it('answers discard-failed and keeps the id when removal fails', async () => {
        let failRemove = true;
        const { deps, fakes } = makeStartDeps({}, {
            removeAgent: async (_claudePath, id) => {
                fakes.calls.push(`rm ${id}`);
                if (failRemove) throw new Error('rm failed');
            },
        });
        const handlers = createClaudeAgentHandlers(deps);
        await handlers.start(startRequest);
        expect(await handlers.discard('35d81094')).toMatchObject({ type: 'error', code: 'discard-failed' });
        failRemove = false;
        expect(await handlers.discard('35d81094')).toEqual({ type: 'success' });
    });

    it('forgets the cached start even when removal fails', async () => {
        const { deps, fakes } = makeStartDeps({}, {
            removeAgent: async (_claudePath, id) => {
                fakes.calls.push(`rm ${id}`);
                throw new Error('rm failed');
            },
        });
        const handlers = createClaudeAgentHandlers(deps);
        await handlers.start({ ...startRequest, clientRequestId: 'r1' });
        expect(await handlers.discard('35d81094')).toMatchObject({ type: 'error', code: 'discard-failed' });
        // A retry of the same request is not answered with the session being discarded.
        await handlers.start({ ...startRequest, clientRequestId: 'r1' });
        expect(fakes.bgRuns).toHaveLength(2);
    });
});

describe('open-claude-agent', () => {
    it('open returns the live mirror without spawning', async () => {
        const { deps, spawns } = makeDeps({ liveMirrors: () => new Map([['abc12345', 'happy-live']]) });
        expect(await createClaudeAgentHandlers(deps).open('abc12345')).toEqual({ type: 'success', sessionId: 'happy-live' });
        expect(spawns).toEqual([]);
    });

    it('open reconnects with persisted keys when the mirror is not running', async () => {
        const { deps, spawns } = makeDeps({ persistedMirrors: () => new Map([['abc12345', persisted]]) });
        expect(await createClaudeAgentHandlers(deps).open('abc12345')).toEqual({ type: 'success', sessionId: 'happy-new' });
        expect(spawns).toEqual([{
            agentId: 'abc12345',
            cwd: '/Users/tester/project',
            reconnect: {
                happySessionId: 'happy-old',
                env: {
                    HAPPY_RECONNECT_SESSION_ID: 'happy-old',
                    HAPPY_RECONNECT_ENCRYPTION_KEY: 'a2V5',
                    HAPPY_RECONNECT_ENCRYPTION_VARIANT: 'dataKey',
                    HAPPY_RECONNECT_SEQ: '7',
                    HAPPY_RECONNECT_METADATA_VERSION: '3',
                    HAPPY_RECONNECT_AGENT_STATE_VERSION: '4',
                },
            },
        }]);
    });

    it('open spawns fresh when nothing is known', async () => {
        const { deps, spawns } = makeDeps();
        expect(await createClaudeAgentHandlers(deps).open('abc12345')).toEqual({ type: 'success', sessionId: 'happy-new' });
        expect(spawns).toEqual([{ agentId: 'abc12345', reconnect: undefined, cwd: '/Users/tester/project' }]);
    });

    it('open errors for an unknown agent id', async () => {
        const { deps, spawns } = makeDeps();
        const result = await createClaudeAgentHandlers(deps).open('nope');
        expect(result.type).toBe('error');
        expect(spawns).toEqual([]);
    });

    it('open errors when claude or tmux is missing, without spawning', async () => {
        const noClaude = makeDeps({ resolveClaude: async () => null });
        expect((await createClaudeAgentHandlers(noClaude.deps).open('abc12345')).type).toBe('error');
        const noTmux = makeDeps({ tmuxInstalled: async () => false });
        expect((await createClaudeAgentHandlers(noTmux.deps).open('abc12345')).type).toBe('error');
        expect([...noClaude.spawns, ...noTmux.spawns]).toEqual([]);
    });

    it('open turns a failing claude agents into an error result instead of throwing', async () => {
        const { deps, spawns } = makeDeps({ fetchAgents: async () => { throw new Error('boom'); } });
        const result = await createClaudeAgentHandlers(deps).open('abc12345');
        expect(result).toMatchObject({ type: 'error' });
        expect(spawns).toEqual([]);
    });

    it('open falls back to one fresh spawn when the reconnect spawn fails', async () => {
        const calls: SpawnCall[] = [];
        const { deps } = makeDeps({
            persistedMirrors: () => new Map([['abc12345', persisted]]),
            spawnMirror: async (agentId, reconnect, cwd): Promise<OpenClaudeAgentResult> => {
                calls.push({ agentId, reconnect, cwd });
                return reconnect
                    ? { type: 'error', errorMessage: 'Session process 1 exited before connecting.' }
                    : { type: 'success', sessionId: 'happy-fresh' };
            },
        });
        expect(await createClaudeAgentHandlers(deps).open('abc12345')).toEqual({ type: 'success', sessionId: 'happy-fresh' });
        expect(calls.map((call) => call.reconnect !== undefined)).toEqual([true, false]);
    });

    it('open waits for a late reconnect mirror instead of spawning a second one', async () => {
        let polls = 0;
        const calls: SpawnCall[] = [];
        const { deps } = makeDeps({
            persistedMirrors: () => new Map([['abc12345', persisted]]),
            spawnMirror: async (agentId, reconnect, cwd): Promise<OpenClaudeAgentResult> => {
                calls.push({ agentId, reconnect, cwd });
                return { type: 'error', errorMessage: 'Session webhook timeout for PID 1' };
            },
            mirrorStarting: () => true,
            // The two looks before any spawn see nothing; the mirror reports on the second poll after it.
            liveMirrors: () => (polls++ >= 4 ? new Map([['abc12345', 'happy-old']]) : new Map()),
        });
        expect(await createClaudeAgentHandlers(deps).open('abc12345')).toEqual({ type: 'success', sessionId: 'happy-old' });
        expect(calls.map((call) => call.reconnect !== undefined)).toEqual([true]);
    });

    it('open does not spawn fresh while the reconnect mirror is still starting', async () => {
        const calls: SpawnCall[] = [];
        const { deps } = makeDeps({
            persistedMirrors: () => new Map([['abc12345', persisted]]),
            spawnMirror: async (agentId, reconnect, cwd): Promise<OpenClaudeAgentResult> => {
                calls.push({ agentId, reconnect, cwd });
                return { type: 'error', errorMessage: 'Session webhook timeout for PID 1' };
            },
            mirrorStarting: () => true,
        });
        expect(await createClaudeAgentHandlers(deps).open('abc12345')).toEqual({ type: 'error', errorMessage: 'Session webhook timeout for PID 1' });
        expect(calls.map((call) => call.reconnect !== undefined)).toEqual([true]);
    });

    it('open returns the fresh spawn error when both the reconnect and the fresh spawn fail', async () => {
        const { deps } = makeDeps({
            persistedMirrors: () => new Map([['abc12345', persisted]]),
            spawnMirror: async (_agentId, reconnect): Promise<OpenClaudeAgentResult> => ({
                type: 'error',
                errorMessage: reconnect ? 'reconnect failed' : 'fresh failed',
            }),
        });
        expect(await createClaudeAgentHandlers(deps).open('abc12345')).toEqual({ type: 'error', errorMessage: 'fresh failed' });
    });

    it('two concurrent opens share one spawn and one sessionId', async () => {
        let release!: (result: OpenClaudeAgentResult) => void;
        let spawnCount = 0;
        const { deps } = makeDeps({
            spawnMirror: () => {
                spawnCount += 1;
                return new Promise<OpenClaudeAgentResult>((resolve) => { release = resolve; });
            },
        });
        const handlers = createClaudeAgentHandlers(deps);
        const first = handlers.open('abc12345');
        const second = handlers.open('abc12345');
        await new Promise((resolve) => setTimeout(resolve, 0));
        release({ type: 'success', sessionId: 'happy-new' });
        expect(await Promise.all([first, second])).toEqual([
            { type: 'success', sessionId: 'happy-new' },
            { type: 'success', sessionId: 'happy-new' },
        ]);
        expect(spawnCount).toBe(1);
    });

    it('opens of different agents run independently, and a settled open can be repeated', async () => {
        const { deps, spawns } = makeDeps({ fetchAgents: async () => [agent('abc12345'), agent('def67890')] });
        const handlers = createClaudeAgentHandlers(deps);
        await Promise.all([handlers.open('abc12345'), handlers.open('def67890')]);
        await handlers.open('abc12345');
        expect(spawns.map((call) => call.agentId)).toEqual(['abc12345', 'def67890', 'abc12345']);
    });
});

describe('mirror recognition and persistence', () => {
    it('resume refuses a mirror session', () => {
        const mirror = { claudeAgentId: 'abc12345' } as Metadata;
        expect(isClaudeAgentMirror(mirror)).toBe(true);
        expect(isClaudeAgentMirror({ claudeAgentId: '' } as Metadata)).toBe(false);
        expect(isClaudeAgentMirror({} as Metadata)).toBe(false);
        expect(isClaudeAgentMirror(undefined)).toBe(false);
        expect(MIRROR_RESUME_REFUSAL).toBe('This session mirrors a Mac background session. Open it from the background session list.');
    });

    it('picks the most recent persisted mirror per agent and ignores ordinary sessions', () => {
        const base = { encryptionKey: 'a2V5', encryptionVariant: 'dataKey' as const, seq: 1, metadataVersion: 1, agentStateVersion: 1 };
        const picked = pickPersistedMirrors({
            older: { ...base, metadata: { claudeAgentId: 'abc12345' } as Metadata, savedAt: 10 },
            newer: { ...base, seq: 9, metadata: { claudeAgentId: 'abc12345' } as Metadata, savedAt: 5, lastAliveAt: 20 },
            other: { ...base, metadata: { claudeAgentId: 'def67890' } as Metadata, savedAt: 1 },
            plain: { ...base, metadata: {} as Metadata, savedAt: 99 },
        });
        expect([...picked.keys()].sort()).toEqual(['abc12345', 'def67890']);
        expect(picked.get('abc12345')).toMatchObject({ happySessionId: 'newer', seq: 9 });
    });
});
