import { describe, expect, it } from 'vitest';
import { applyTaskMessage, createTaskTrackerState, taskActivity, taskSnapshot } from './taskTracker';

const base = { type: 'system', uuid: 'u', session_id: 's' };
const started = (task_id: string, extra: Record<string, unknown> = {}) =>
    ({ ...base, subtype: 'task_started', task_id, description: `task ${task_id}`, task_type: 'local_agent', ...extra });

describe('taskTracker', () => {
    it('tracks a started agent with its progress', () => {
        const state = createTaskTrackerState();
        expect(applyTaskMessage(state, started('a', { subagent_type: 'Explore', is_backgrounded: true }), 1000).changed).toBe(true);
        applyTaskMessage(state, {
            ...base, subtype: 'task_progress', task_id: 'a', description: 'task a',
            usage: { total_tokens: 1200, tool_uses: 3, duration_ms: 5000 }, last_tool_name: 'Grep', summary: 'Reading the mapper',
        }, 6000);

        expect(taskSnapshot(state, 6000)).toEqual([{
            id: 'a', kind: 'agent', title: 'task a', agentType: 'Explore', status: 'running', startedAt: 1000,
            background: true, tokens: 1200, toolUses: 3, lastTool: 'Grep', summary: 'Reading the mapper',
        }]);
    });

    it('names workflows by their script name and links children to parents', () => {
        const state = createTaskTrackerState();
        applyTaskMessage(state, started('w', { task_type: 'local_workflow', workflow_name: 'review-changes' }), 1);
        applyTaskMessage(state, started('c', { parent_task_id: 'w', task_type: 'local_bash' }), 2);

        const [workflow, child] = taskSnapshot(state, 3);
        expect(workflow).toMatchObject({ id: 'w', kind: 'workflow', title: 'review-changes' });
        expect(child).toMatchObject({ id: 'c', kind: 'shell', parentId: 'w' });
    });

    it('reports a finished task once and keeps it in the snapshot for a while', () => {
        const state = createTaskTrackerState();
        applyTaskMessage(state, started('a'), 1000);
        const finished = applyTaskMessage(state, {
            ...base, subtype: 'task_notification', task_id: 'a', status: 'completed', output_file: '/x', summary: 'Found 3 call sites',
            usage: { total_tokens: 900, tool_uses: 2, duration_ms: 4000 },
        }, 5000);

        expect(finished.finished).toMatchObject({ id: 'a', status: 'completed', summary: 'Found 3 call sites', endedAt: 5000 });
        expect(applyTaskMessage(state, { ...base, subtype: 'task_updated', task_id: 'a', patch: { status: 'completed' } }, 5001).finished).toBeUndefined();
        expect(taskSnapshot(state, 5000 + 5 * 60_000)).toHaveLength(1);
        expect(taskSnapshot(state, 5000 + 16 * 60_000)).toHaveLength(0);
    });

    it('maps task_updated status changes, including killed to stopped', () => {
        const state = createTaskTrackerState();
        applyTaskMessage(state, started('a'), 1);
        applyTaskMessage(state, { ...base, subtype: 'task_updated', task_id: 'a', patch: { status: 'paused' } }, 2);
        expect(taskSnapshot(state, 2)[0].status).toBe('paused');
        const result = applyTaskMessage(state, { ...base, subtype: 'task_updated', task_id: 'a', patch: { status: 'killed', end_time: 3 } }, 3);
        expect(result.finished).toMatchObject({ status: 'stopped', endedAt: 3 });
    });

    it('keeps ambient tasks in the snapshot but out of activity counts and finish reports', () => {
        const state = createTaskTrackerState();
        applyTaskMessage(state, started('m', { task_type: 'monitor', ambient: true }), 1);
        applyTaskMessage(state, started('a'), 1);
        applyTaskMessage(state, started('w', { task_type: 'local_workflow' }), 1);

        expect(taskSnapshot(state, 2).map((t) => t.id)).toEqual(['m', 'a', 'w']);
        // The app's metadata parser needs all four groups, or it drops the whole metadata.
        expect(taskActivity(state)).toEqual({
            subagents: { running: 1, queued: 0, total: 1 },
            workflows: { running: 1, total: 1 },
            processes: { running: 0 },
            tasks: { pending: 0, inProgress: 0, completed: 0, total: 0 },
        });
        const finished = applyTaskMessage(state, { ...base, subtype: 'task_notification', task_id: 'm', status: 'stopped', output_file: '', summary: '' }, 3);
        expect(finished).toEqual({ changed: true });
    });

    it('ignores unrelated messages and events for unknown tasks without a start', () => {
        const state = createTaskTrackerState();
        expect(applyTaskMessage(state, { type: 'assistant' }, 1)).toEqual({ changed: false });
        expect(applyTaskMessage(state, { ...base, subtype: 'init' }, 1)).toEqual({ changed: false });
        expect(applyTaskMessage(state, { ...base, subtype: 'task_updated', task_id: 'zz', patch: { status: 'running' } }, 1)).toEqual({ changed: false });
    });

    it('caps the snapshot, dropping the oldest finished tasks first', () => {
        const state = createTaskTrackerState();
        for (let i = 0; i < 40; i++) {
            applyTaskMessage(state, started(`t${i}`), i);
            if (i < 35) applyTaskMessage(state, { ...base, subtype: 'task_notification', task_id: `t${i}`, status: 'completed', output_file: '', summary: '' }, i);
        }
        const snapshot = taskSnapshot(state, 100);
        expect(snapshot).toHaveLength(30);
        expect(snapshot.filter((t) => t.status === 'running')).toHaveLength(5);
        expect(snapshot.some((t) => t.id === 't0')).toBe(false);
    });
});
