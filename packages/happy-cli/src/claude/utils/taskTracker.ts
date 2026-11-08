/**
 * Background task tracking for remote sessions.
 *
 * Folds the Claude Agent SDK's task events (task_started, task_progress,
 * task_updated, task_notification) into a small table of workflows, subagents
 * and shell jobs. The table is published as session metadata (`remoteTasks`)
 * for the app's task panel, and as the `activity` counts the app already
 * shows. Finished tasks are reported once so the caller can leave a
 * completion card in the chat history.
 */

export type RemoteTaskKind = 'workflow' | 'agent' | 'shell' | 'other';
export type RemoteTaskStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'stopped';

export type RemoteTask = {
    id: string;
    kind: RemoteTaskKind;
    title: string;
    status: RemoteTaskStatus;
    startedAt: number;
    endedAt?: number;
    agentType?: string;
    parentId?: string;
    background?: boolean;
    ambient?: boolean;
    summary?: string;
    lastTool?: string;
    tokens?: number;
    toolUses?: number;
};

/** Shape of the app's `metadata.activity`; every group is required by its parser. */
export type RemoteTaskActivity = {
    subagents: { running: number; queued: number; total: number };
    workflows: { running: number; total: number };
    processes: { running: number };
    tasks: { pending: number; inProgress: number; completed: number; total: number };
};

export type TaskTrackerState = { tasks: Map<string, RemoteTask> };

export type TaskMessageResult = { changed: boolean; finished?: RemoteTask };

const FINISHED_RETENTION_MS = 15 * 60_000;
const SNAPSHOT_LIMIT = 30;
const ACTIVE: ReadonlySet<RemoteTaskStatus> = new Set(['pending', 'running', 'paused']);
const KIND_BY_TASK_TYPE: Record<string, RemoteTaskKind> = {
    local_workflow: 'workflow',
    local_agent: 'agent',
    local_bash: 'shell',
};
const STATUS_BY_PATCH: Record<string, RemoteTaskStatus> = {
    pending: 'pending',
    running: 'running',
    paused: 'paused',
    completed: 'completed',
    failed: 'failed',
    killed: 'stopped',
};

type Usage = { total_tokens?: number; tool_uses?: number };

/** Loosely typed view of an SDK system message; fields are checked before use. */
type TaskMessage = {
    type?: unknown;
    subtype?: unknown;
    task_id?: unknown;
    task_type?: string;
    workflow_name?: string;
    description?: string;
    subagent_type?: string;
    parent_task_id?: string;
    is_backgrounded?: boolean;
    ambient?: boolean;
    skip_transcript?: boolean;
    usage?: Usage;
    last_tool_name?: string;
    summary?: string;
    status?: string;
    patch?: { status?: string; description?: string; end_time?: number; is_backgrounded?: boolean };
};

export function createTaskTrackerState(): TaskTrackerState {
    return { tasks: new Map() };
}

/**
 * Applies one SDK message. Returns whether the table changed, and the task if
 * this message finished it (reported once, never for ambient tasks).
 */
export function applyTaskMessage(state: TaskTrackerState, raw: unknown, now: number): TaskMessageResult {
    const message = raw as TaskMessage;
    if (message?.type !== 'system' || typeof message.task_id !== 'string') return { changed: false };
    const id = message.task_id;

    if (message.subtype === 'task_started') {
        state.tasks.set(id, withoutUndefined({
            id,
            kind: KIND_BY_TASK_TYPE[message.task_type ?? ''] ?? 'other',
            title: message.workflow_name || message.description || id,
            status: 'running',
            startedAt: now,
            agentType: message.subagent_type,
            parentId: message.parent_task_id,
            background: message.is_backgrounded,
            ambient: message.ambient || message.skip_transcript || undefined,
        }));
        return { changed: true };
    }

    const task = state.tasks.get(id);
    if (!task) return { changed: false };

    if (message.subtype === 'task_progress') {
        Object.assign(task, withoutUndefined({
            summary: message.summary,
            lastTool: message.last_tool_name,
            tokens: message.usage?.total_tokens,
            toolUses: message.usage?.tool_uses,
        }));
        return { changed: true };
    }

    if (message.subtype === 'task_updated') {
        const patch = message.patch ?? {};
        Object.assign(task, withoutUndefined({ background: patch.is_backgrounded }));
        if (patch.description && task.kind !== 'workflow') task.title = patch.description;
        const status = patch.status ? STATUS_BY_PATCH[patch.status] : undefined;
        return status ? setStatus(task, status, patch.end_time ?? now) : { changed: true };
    }

    if (message.subtype === 'task_notification') {
        Object.assign(task, withoutUndefined({
            summary: message.summary || undefined,
            tokens: message.usage?.total_tokens,
            toolUses: message.usage?.tool_uses,
        }));
        const status = message.status === 'completed' || message.status === 'failed' ? message.status : 'stopped';
        return setStatus(task, status, now);
    }

    return { changed: false };
}

/** Active tasks plus recently finished ones, oldest first, at most SNAPSHOT_LIMIT. */
export function taskSnapshot(state: TaskTrackerState, now: number): RemoteTask[] {
    for (const [id, task] of state.tasks) {
        if (task.endedAt !== undefined && now - task.endedAt > FINISHED_RETENTION_MS) state.tasks.delete(id);
    }
    const all = [...state.tasks.values()];
    const finished = all.filter((task) => !ACTIVE.has(task.status));
    const room = Math.max(0, SNAPSHOT_LIMIT - (all.length - finished.length));
    const keptFinished = new Set(finished.slice(Math.max(0, finished.length - room)));
    return all
        .filter((task) => ACTIVE.has(task.status) || keptFinished.has(task))
        .slice(-SNAPSHOT_LIMIT)
        .map((task) => ({ ...task }));
}

/** Counts for the app's existing activity display; ambient tasks are not activity. */
export function taskActivity(state: TaskTrackerState): RemoteTaskActivity {
    const counted = [...state.tasks.values()].filter((task) => !task.ambient);
    const running = (kind: RemoteTaskKind) => counted.filter((task) => task.kind === kind && task.status === 'running').length;
    const queued = (kind: RemoteTaskKind) => counted.filter((task) => task.kind === kind && task.status === 'pending').length;
    const total = (kind: RemoteTaskKind) => counted.filter((task) => task.kind === kind).length;
    return {
        subagents: { running: running('agent'), queued: queued('agent'), total: total('agent') },
        workflows: { running: running('workflow'), total: total('workflow') },
        processes: { running: running('shell') },
        tasks: { pending: 0, inProgress: 0, completed: 0, total: 0 },
    };
}

function setStatus(task: RemoteTask, status: RemoteTaskStatus, at: number): TaskMessageResult {
    const wasActive = ACTIVE.has(task.status);
    task.status = status;
    if (ACTIVE.has(status) || !wasActive) return { changed: true };
    task.endedAt = at;
    return task.ambient ? { changed: true } : { changed: true, finished: { ...task } };
}

function withoutUndefined<T extends object>(value: T): T {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}
