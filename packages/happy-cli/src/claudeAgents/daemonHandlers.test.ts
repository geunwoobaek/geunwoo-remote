import { describe, expect, it } from 'vitest';
import type { Metadata } from '@/api/types';
import {
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
        persistedMirrors: () => new Map(),
        spawnMirror: async (agentId, reconnect, cwd) => {
            spawns.push({ agentId, reconnect, cwd });
            return { type: 'success', sessionId: 'happy-new' };
        },
        ...overrides,
    };
    return { deps, spawns };
}

describe('list-claude-agents', () => {
    it('list reports claude-missing when claude cannot be found', async () => {
        const { deps } = makeDeps({ resolveClaude: async () => null });
        expect(await createClaudeAgentHandlers(deps).list()).toEqual({ agents: [], unavailable: 'claude-missing' });
    });

    it('list reports tmux-missing when tmux is absent', async () => {
        const { deps } = makeDeps({ tmuxInstalled: async () => false });
        expect(await createClaudeAgentHandlers(deps).list()).toEqual({ agents: [], unavailable: 'tmux-missing' });
    });

    it('list reports agents-command-failed instead of throwing when claude agents fails', async () => {
        const { deps } = makeDeps({ fetchAgents: async () => { throw new Error('boom'); } });
        expect(await createClaudeAgentHandlers(deps).list()).toEqual({ agents: [], unavailable: 'agents-command-failed' });
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
