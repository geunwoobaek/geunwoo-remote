import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fetchClaudeAgents, parseClaudeAgents, removeClaudeAgent, runClaudeBackground, stopClaudeAgent } from './agentsList';

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

describe('fetchClaudeAgents', () => {
    let dir: string;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'fake-claude-'));
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    async function fakeClaude(stdout: string): Promise<string> {
        const path = join(dir, 'claude');
        await writeFile(path, `#!/bin/sh\ncat <<'JSON'\n${stdout}\nJSON\n`);
        await chmod(path, 0o755);
        return path;
    }

    it('rejects when a zero-exit run prints non-JSON', async () => {
        const claudePath = await fakeClaude('not json at all');

        await expect(fetchClaudeAgents(claudePath)).rejects.toThrow();
    });

    it('rejects when a zero-exit run prints a JSON object instead of an array', async () => {
        const claudePath = await fakeClaude('{"error": "boom"}');

        await expect(fetchClaudeAgents(claudePath)).rejects.toThrow();
    });

    it('resolves to the background entries for a valid array', async () => {
        const claudePath = await fakeClaude(JSON.stringify([
            { pid: 1, cwd: '/Users/tester/project', kind: 'interactive', startedAt: 1794025195936, sessionId: 'interactive-1' },
            background({ id: 'aaaa1111', sessionId: 's-1' }),
        ]));

        const agents = await fetchClaudeAgents(claudePath);

        expect(agents.map((a) => a.id)).toEqual(['aaaa1111']);
    });

    it('resolves to [] for an empty array', async () => {
        const claudePath = await fakeClaude('[]');

        await expect(fetchClaudeAgents(claudePath)).resolves.toEqual([]);
    });
});

// A shell script stands in for `claude`; the real binary is never run.
describe('running claude for background agents', () => {
    let dir: string;

    beforeEach(async () => {
        dir = await realpath(await mkdtemp(join(tmpdir(), 'fake-claude-')));
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    async function fakeClaude(script: string): Promise<string> {
        const path = join(dir, 'claude');
        await writeFile(path, `#!/bin/sh\n${script}\n`);
        await chmod(path, 0o755);
        return path;
    }

    it('runs in the given folder and returns the output of a successful run', async () => {
        const claudePath = await fakeClaude('echo "warning: no prompt" >&2; echo "backgrounded · 35d81094 · demo $*"; pwd -P > "$FAKE_OUT"');
        const out = join(dir, 'pwd.txt');
        const result = await runClaudeBackground(claudePath, dir, ['--bg', '--name', 'demo'], { ...process.env, FAKE_OUT: out });
        expect(result.code).toBe(0);
        expect(result.stdout).toContain('backgrounded · 35d81094 · demo --bg --name demo');
        expect(result.stderr).toContain('warning: no prompt');
        expect((await readFile(out, 'utf8')).trim()).toBe(dir);
    });

    it('returns the output of a failing run instead of rejecting', async () => {
        const claudePath = await fakeClaude('echo "Workspace not trusted. Run claude in $PWD once and accept the trust prompt, then retry." >&2; exit 1');
        const result = await runClaudeBackground(claudePath, dir, ['--bg'], process.env);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('Workspace not trusted');
    });

    it('settles soon after exit when a detached child keeps the output open', async () => {
        const claudePath = await fakeClaude('echo "backgrounded · 35d81094 · demo"; sleep 8 & exit 0');
        const started = Date.now();
        const result = await runClaudeBackground(claudePath, dir, ['--bg'], process.env);
        expect(result.stdout).toContain('backgrounded · 35d81094');
        expect(Date.now() - started).toBeLessThan(5_000);
    });

    it('rejects when the binary cannot be started', async () => {
        await expect(runClaudeBackground(join(dir, 'missing'), dir, ['--bg'], process.env)).rejects.toThrow();
    });

    it('stop and rm each pass exactly one id', async () => {
        const log = join(dir, 'args.txt');
        const claudePath = await fakeClaude(`echo "$*" >> "${log}"`);
        await stopClaudeAgent(claudePath, '35d81094', process.env);
        await removeClaudeAgent(claudePath, '35d81094', process.env);
        expect((await readFile(log, 'utf8')).trim().split('\n')).toEqual(['stop 35d81094', 'rm 35d81094']);
    });
});
