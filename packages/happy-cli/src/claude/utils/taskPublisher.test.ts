import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTaskPublisher, formatTaskCard } from './taskPublisher';

const base = { type: 'system', uuid: 'u', session_id: 's' };
const started = (task_id: string, extra: Record<string, unknown> = {}) =>
    ({ ...base, subtype: 'task_started', task_id, description: `Review ${task_id}`, task_type: 'local_agent', is_backgrounded: true, ...extra });
const done = (task_id: string, extra: Record<string, unknown> = {}) =>
    ({ ...base, subtype: 'task_notification', task_id, status: 'completed', output_file: '', summary: 'All good', ...extra });

describe('taskPublisher', () => {
    beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
    afterEach(() => { vi.useRealTimers(); });

    it('publishes the first change at once and coalesces the rest into one trailing update', () => {
        const publish = vi.fn();
        const publisher = createTaskPublisher({ publish, onFinished: vi.fn() });
        publisher.onMessage(started('a'));
        publisher.onMessage(started('b'));
        publisher.onMessage(started('c'));
        expect(publish).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(2000);
        expect(publish).toHaveBeenCalledTimes(2);
        expect(publish.mock.calls[1][0].remoteTasks.map((t: { id: string }) => t.id)).toEqual(['a', 'b', 'c']);
        expect(publish.mock.calls[1][0].activity.subagents).toEqual({ running: 3, queued: 0, total: 3 });
    });

    it('ignores messages that are not task events', () => {
        const publish = vi.fn();
        const publisher = createTaskPublisher({ publish, onFinished: vi.fn() });
        publisher.onMessage({ type: 'assistant', message: { content: [] } });
        vi.advanceTimersByTime(5000);
        expect(publish).not.toHaveBeenCalled();
    });

    it('leaves a card for finished background tasks and workflows, not for foreground or nested ones', () => {
        const onFinished = vi.fn();
        const publisher = createTaskPublisher({ publish: vi.fn(), onFinished });
        publisher.onMessage(started('bg'));
        publisher.onMessage(started('fg', { is_backgrounded: false }));
        publisher.onMessage(started('wf', { task_type: 'local_workflow', workflow_name: 'review-changes', is_backgrounded: undefined }));
        publisher.onMessage(started('child', { parent_task_id: 'wf' }));
        for (const id of ['bg', 'fg', 'wf', 'child']) publisher.onMessage(done(id));

        expect(onFinished.mock.calls.map(([task]) => task.id)).toEqual(['bg', 'wf']);
    });

    it('marks tasks still running as stopped when the Claude process ends, without cards', () => {
        const publish = vi.fn();
        const onFinished = vi.fn();
        const publisher = createTaskPublisher({ publish, onFinished });
        publisher.onMessage(started('a'));
        publisher.stopAll();

        const last = publish.mock.calls.at(-1)![0];
        expect(last.remoteTasks[0]).toMatchObject({ id: 'a', status: 'stopped' });
        expect(last.activity.subagents.running).toBe(0);
        expect(onFinished).not.toHaveBeenCalled();
    });
});

describe('formatTaskCard', () => {
    it('writes kind, status, title, summary and usage on one card', () => {
        expect(formatTaskCard({
            id: 'a', kind: 'agent', title: 'Review mapper', status: 'completed', startedAt: 0, endedAt: 80_000,
            summary: 'Found 3 call sites', tokens: 12_345,
        })).toBe('✓ 에이전트 완료 · Review mapper\nFound 3 call sites\n1분 20초 · 토큰 12.3k');
    });

    it('marks failures and keeps short cards short', () => {
        expect(formatTaskCard({ id: 'w', kind: 'workflow', title: 'review-changes', status: 'failed', startedAt: 0, endedAt: 4_000 }))
            .toBe('✗ 워크플로우 실패 · review-changes\n4초');
    });
});
