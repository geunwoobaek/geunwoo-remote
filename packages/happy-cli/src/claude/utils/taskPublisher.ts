/**
 * Publishes background task state from a remote Claude session.
 *
 * Feeds SDK messages into the task tracker, pushes the resulting snapshot to
 * session metadata (`remoteTasks` for the panel, `activity` for the app's
 * existing counts) at most once per interval, and hands finished background
 * tasks and workflows to `onFinished` so they leave a card in the chat.
 */

import {
    applyTaskMessage,
    createTaskTrackerState,
    taskActivity,
    taskSnapshot,
    type RemoteTask,
    type RemoteTaskActivity,
    type RemoteTaskKind,
    type RemoteTaskStatus,
} from './taskTracker';

export type TaskMetadataPatch = { remoteTasks: RemoteTask[]; activity: RemoteTaskActivity };

const PUBLISH_INTERVAL_MS = 2000;
const KIND_LABEL: Record<RemoteTaskKind, string> = { workflow: '워크플로우', agent: '에이전트', shell: '셸 작업', other: '작업' };
const STATUS_LABEL: Partial<Record<RemoteTaskStatus, string>> = { completed: '✓ 완료', failed: '✗ 실패', stopped: '■ 중지' };

export function createTaskPublisher(opts: {
    publish: (patch: TaskMetadataPatch) => void;
    onFinished: (task: RemoteTask) => void;
}) {
    const state = createTaskTrackerState();
    let lastPublishedAt = -Infinity;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const publishNow = () => {
        if (timer) clearTimeout(timer);
        timer = null;
        lastPublishedAt = Date.now();
        opts.publish({ remoteTasks: taskSnapshot(state, lastPublishedAt), activity: taskActivity(state) });
    };
    const schedule = () => {
        const wait = lastPublishedAt + PUBLISH_INTERVAL_MS - Date.now();
        if (wait <= 0) publishNow();
        else timer ??= setTimeout(publishNow, wait);
    };

    return {
        onMessage(message: unknown): void {
            const result = applyTaskMessage(state, message, Date.now());
            if (!result.changed) return;
            const task = result.finished;
            if (task && !task.parentId && (task.background || task.kind === 'workflow')) opts.onFinished(task);
            schedule();
        },
        /** The Claude process ended: whatever was still running is gone with it. */
        stopAll(): void {
            const now = Date.now();
            for (const task of state.tasks.values()) {
                if (task.status === 'pending' || task.status === 'running' || task.status === 'paused') {
                    task.status = 'stopped';
                    task.endedAt = now;
                }
            }
            if (state.tasks.size > 0) publishNow();
        },
    };
}

/** One chat card for a finished task: status line, summary, duration and tokens. */
export function formatTaskCard(task: RemoteTask): string {
    const [mark, word] = (STATUS_LABEL[task.status] ?? '■ 중지').split(' ');
    const seconds = Math.round(((task.endedAt ?? task.startedAt) - task.startedAt) / 1000);
    const duration = seconds >= 60 ? `${Math.floor(seconds / 60)}분 ${seconds % 60}초` : `${seconds}초`;
    const usage = task.tokens ? ` · 토큰 ${(task.tokens / 1000).toFixed(1)}k` : '';
    return [`${mark} ${KIND_LABEL[task.kind]} ${word} · ${task.title}`, task.summary, `${duration}${usage}`]
        .filter(Boolean)
        .join('\n');
}
