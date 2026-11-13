import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { countQueuedInputs, createAgentTasksCache, findWorkflowLaunch, readAgentTasks, type AgentTasksInput } from './subtasks';

const SESSION = '11111111-2222-3333-4444-555555555555';
/** The session's process started at this time (epoch ms); older writes belong to an earlier process. */
const STARTED = Date.parse('2026-11-14T05:00:00Z');

let root: string;
let input: AgentTasksInput;

function at(iso: string): Date {
    return new Date(iso);
}

/** A sub-agent pair (meta + transcript) whose transcript was last written at `written`. */
function subAgent(dir: string, id: string, meta: Record<string, unknown>, written: string): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.meta.json`), JSON.stringify(meta));
    writeFileSync(join(dir, `${id}.jsonl`), '{}\n');
    utimesSync(join(dir, `${id}.jsonl`), at(written), at(written));
}

function jobState(inFlight: Record<string, unknown>): void {
    writeFileSync(input.jobStatePath, JSON.stringify({ state: 'working', inFlight }));
}

function transcript(lines: unknown[]): void {
    writeFileSync(join(root, `${SESSION}.jsonl`), lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
}

const enqueue = (content: string) => ({ type: 'queue-operation', operation: 'enqueue', content });
const dequeue = { type: 'queue-operation', operation: 'dequeue' };
const remove = { type: 'queue-operation', operation: 'remove' };

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-tasks-'));
    input = { projectDir: root, sessionId: SESSION, jobStatePath: join(root, 'state.json'), parentAlive: true, parentStartedAt: STARTED };
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

describe('countQueuedInputs', () => {
    it('counts typed messages not yet taken off the queue', () => {
        const tail = [enqueue('first'), enqueue('second'), remove].map((line) => JSON.stringify(line)).join('\n');
        expect(countQueuedInputs(tail)).toBe(1);
    });

    it('passes over task notifications', () => {
        const tail = [enqueue('<task-notification>\n<task-id>x</task-id>'), enqueue('hello')].map((line) => JSON.stringify(line)).join('\n');
        expect(countQueuedInputs(tail)).toBe(1);
        expect(countQueuedInputs([enqueue('<task-notification>'), dequeue].map((line) => JSON.stringify(line)).join('\n'))).toBe(0);
    });

    it('is zero when everything was read, and ignores a removal with nothing queued', () => {
        const tail = [remove, enqueue('a'), dequeue].map((line) => JSON.stringify(line)).join('\n');
        expect(countQueuedInputs(tail)).toBe(0);
    });
});

describe('findWorkflowLaunch', () => {
    it("reads a running workflow's summary and script name from its launch result", () => {
        const result = {
            type: 'user',
            message: { content: [{ type: 'tool_result', content: `Workflow launched in background. Task ID: w1\nSummary: 화첩 패널 3명\nTranscript dir: /p/${SESSION}/subagents/workflows/wf_abc-123\nScript file: /tmp/jobs/x/game-panel.js\n` }] },
        };
        expect(findWorkflowLaunch(JSON.stringify(result), 'wf_abc-123')).toEqual({ label: 'game-panel', summary: '화첩 패널 3명' });
        expect(findWorkflowLaunch(JSON.stringify(result), 'wf_other')).toBeNull();
    });
});

describe('readAgentTasks', () => {
    it('marks sub-agents running, done, or cut off by an earlier process', () => {
        const dir = join(root, SESSION, 'subagents');
        subAgent(dir, 'agent-run', { description: '카드게임 다듬기', agentType: 'general-purpose', model: 'fable' }, '2026-11-14T06:00:00Z');
        subAgent(dir, 'agent-done', { description: '메모리 분리', agentType: 'Explore', finished: true }, '2026-11-14T05:30:00Z');
        subAgent(dir, 'agent-old', { description: '옛 프로세스 일' }, '2026-11-14T04:00:00Z');
        jobState({ tasks: 1, queued: 0, kinds: ['local_agent'] });
        const result = readAgentTasks(input, createAgentTasksCache());
        expect(result.runningCount).toBe(1);
        expect(result.tasks.map((task) => [task.id, task.status])).toEqual([
            ['agent-run', 'running'],
            ['agent-done', 'done'],
            ['agent-old', 'stopped'],
        ]);
        expect(result.tasks[0]).toMatchObject({ kind: 'agent', label: '카드게임 다듬기', detail: null, model: 'fable', endedAt: null });
        expect(result.tasks[1]).toMatchObject({ detail: 'Explore' });
    });

    it('counts no more running sub-agents than the session runs tasks', () => {
        const dir = join(root, SESSION, 'subagents');
        subAgent(dir, 'agent-a', { description: 'a' }, '2026-11-14T06:00:00Z');
        subAgent(dir, 'agent-b', { description: 'b' }, '2026-11-14T06:05:00Z');
        jobState({ tasks: 1 });
        expect(readAgentTasks(input, createAgentTasksCache()).tasks.map((task) => [task.id, task.status])).toEqual([
            ['agent-b', 'running'],
            ['agent-a', 'stopped'],
        ]);
        jobState({ tasks: 0 });
        expect(readAgentTasks(input, createAgentTasksCache()).runningCount).toBe(0);
    });

    it('shows nothing running once the session has ended', () => {
        const dir = join(root, SESSION, 'subagents');
        subAgent(dir, 'agent-a', { description: 'a' }, '2026-11-14T06:00:00Z');
        transcript([enqueue('waiting')]);
        const result = readAgentTasks({ ...input, parentAlive: false }, createAgentTasksCache());
        expect(result.tasks[0].status).toBe('stopped');
        expect(result.queuedInputs).toBe(0);
    });

    it('reads an ended workflow from its record and a running one from its agents and launch', () => {
        const runs = join(root, SESSION, 'subagents', 'workflows');
        subAgent(join(runs, 'wf_done-1'), 'agent-x', { agentType: 'workflow-subagent', description: '패널:A' }, '2026-11-14T05:10:00Z');
        mkdirSync(join(root, SESSION, 'workflows'), { recursive: true });
        writeFileSync(join(root, SESSION, 'workflows', 'wf_done-1.json'), JSON.stringify({
            workflowName: 'fun-harness', summary: '재미 검증', status: 'killed', startTime: STARTED, durationMs: 60_000, agentCount: 4, defaultModel: 'claude-opus-5-5',
        }));
        subAgent(join(runs, 'wf_live-2'), 'agent-y', { agentType: 'workflow-subagent', workflowPhase: '검증' }, '2026-11-14T06:00:00Z');
        subAgent(join(runs, 'wf_live-2'), 'agent-z', { agentType: 'workflow-subagent', workflowPhase: '패널' }, '2026-11-14T05:50:00Z');
        transcript([
            { type: 'user', message: { content: [{ type: 'tool_result', content: `Workflow launched in background.\nSummary: 떡봇 재미 패널\nTranscript dir: ${runs}/wf_live-2\nScript file: /tmp/tteokbot-fun.js\n` }] } },
            enqueue('지금 어때?'),
        ]);
        jobState({ tasks: 1 });
        const result = readAgentTasks(input, createAgentTasksCache());
        expect(result.queuedInputs).toBe(1);
        expect(result.tasks).toEqual([
            expect.objectContaining({ id: 'wf_live-2', kind: 'workflow', status: 'running', label: 'tteokbot-fun', detail: '떡봇 재미 패널', phase: '검증', agentCount: 2, endedAt: null }),
            expect.objectContaining({ id: 'wf_done-1', kind: 'workflow', status: 'stopped', label: 'fun-harness', detail: '재미 검증', agentCount: 4, endedAt: STARTED + 60_000 }),
        ]);
    });

    it('is empty for a session that started nothing', () => {
        expect(readAgentTasks(input, createAgentTasksCache())).toEqual({ tasks: [], runningCount: 0, totalCount: 0, queuedInputs: 0 });
    });
});
