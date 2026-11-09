import { describe, expect, it } from 'vitest';
import { parseClaudeAgents } from './agentsList';

const background = (overrides: Record<string, unknown> = {}) => ({
    pid: 1001,
    id: 'aaaa1111',
    cwd: '/Users/tester/project',
    kind: 'background',
    startedAt: 1794025195936,
    sessionId: 'aaaa1111-0000-0000-0000-000000000001',
    name: 'demo-agent',
    status: 'busy',
    state: 'working',
    ...overrides,
});

describe('parseClaudeAgents', () => {
    it('keeps only background entries', () => {
        const json = JSON.stringify([
            { pid: 1, cwd: '/Users/tester/project', kind: 'interactive', startedAt: 1794025195936, sessionId: 'interactive-1', status: 'idle' },
            background({ id: 'aaaa1111', sessionId: 's-1' }),
            background({ id: 'bbbb2222', sessionId: 's-2' }),
        ]);

        const agents = parseClaudeAgents(json);

        expect(agents).toHaveLength(2);
        expect(agents.map((a) => a.id)).toEqual(['aaaa1111', 'bbbb2222']);
    });

    it('normalizes startedAt', () => {
        const ms = 1794025195936;
        const json = JSON.stringify([
            background({ id: 'a', sessionId: 's-a', startedAt: ms }),
            background({ id: 'b', sessionId: 's-b', startedAt: new Date(ms).toISOString() }),
        ]);

        const agents = parseClaudeAgents(json);

        expect(agents.map((a) => a.startedAt)).toEqual([ms, ms]);
    });

    it('drops entries missing id, sessionId or cwd', () => {
        const json = JSON.stringify([
            background({ id: undefined }),
            background({ sessionId: undefined }),
            background({ cwd: undefined }),
            background({ id: 'ok', sessionId: 's-ok' }),
        ]);

        const agents = parseClaudeAgents(json);

        expect(agents.map((a) => a.id)).toEqual(['ok']);
    });

    it('returns [] for invalid JSON', () => {
        expect(parseClaudeAgents('not json {')).toEqual([]);
        expect(parseClaudeAgents('{"agents": []}')).toEqual([]);
    });

    it('maps unknown status to idle', () => {
        const json = JSON.stringify([
            background({ id: 'a', sessionId: 's-a', status: 'sleeping' }),
            background({ id: 'b', sessionId: 's-b', status: undefined }),
            background({ id: 'c', sessionId: 's-c', status: 'waiting' }),
        ]);

        const agents = parseClaudeAgents(json);

        expect(agents.map((a) => a.status)).toEqual(['idle', 'idle', 'waiting']);
    });

    it('maps fields and nulls missing name and state', () => {
        const json = JSON.stringify([background({ name: undefined, state: undefined })]);

        const [agent] = parseClaudeAgents(json);

        expect(agent).toEqual({
            id: 'aaaa1111',
            sessionId: 'aaaa1111-0000-0000-0000-000000000001',
            name: null,
            cwd: '/Users/tester/project',
            pid: 1001,
            status: 'busy',
            state: null,
            startedAt: 1794025195936,
        });
    });
});
