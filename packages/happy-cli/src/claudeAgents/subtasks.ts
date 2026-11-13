/**
 * What a background session runs under itself, for the phone: the sub-agents and workflows Claude
 * Code started from it, and the phone or Mac messages still waiting for the session to read them.
 *
 * Read from Claude Code's files, never from the session itself:
 * - `<project dir>/<sessionId>/subagents/agent-*.meta.json` (+ `.jsonl`): one sub-agent each;
 *   `finished: true` once it has reported back.
 * - `<project dir>/<sessionId>/subagents/workflows/wf_*` : the agents of one workflow run, and
 *   `<project dir>/<sessionId>/workflows/wf_*.json`: that run's record, written when it ends.
 * - `<claude home>/jobs/<agentId>/state.json` `inFlight.tasks`: how many tasks the session runs now.
 * - the session's transcript `queue-operation` lines: messages typed while it works wait there
 *   until its current step (often a long command) ends.
 *
 * Every read is cached by file modification time: the phone asks every few seconds while the
 * list is open, and a session can hold a hundred sub-agents.
 */

import { closeSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync, type Stats } from 'node:fs';
import { basename, join } from 'node:path';
import type { ClaudeAgentTask, ClaudeAgentTaskStatus, ClaudeAgentTasks } from './types';

/** Tasks returned at most: every running one first, then the most recently ended. */
export const MAX_TASKS = 30;
/** How much of the transcript's end is read for waiting messages. */
const QUEUE_TAIL_BYTES = 256 * 1024;
/** How much of the transcript's end is searched for a running workflow's launch line. */
const LAUNCH_TAIL_BYTES = 8 * 1024 * 1024;

export type AgentTasksInput = {
    /** The project directory that holds `<sessionId>.jsonl`. */
    projectDir: string;
    sessionId: string;
    /** `<claude home>/jobs/<agentId>/state.json`. */
    jobStatePath: string;
    /** The session's process runs (listed with a pid). */
    parentAlive: boolean;
    /** When that process started (epoch ms); work last written before it belongs to an earlier process. */
    parentStartedAt: number;
};

type Cached<T> = { mtimeMs: number; size: number; value: T };

/** Remembers parsed files between calls; one per daemon. */
export type AgentTasksCache = {
    files: Map<string, Cached<unknown>>;
    /** wf id → launch details found in the transcript (null: not found in the searched tail). */
    launches: Map<string, { label: string | null; summary: string | null } | null>;
};

export function createAgentTasksCache(): AgentTasksCache {
    return { files: new Map(), launches: new Map() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function statOrNull(path: string): Stats | null {
    try {
        return statSync(path);
    } catch {
        return null;
    }
}

function listOrEmpty(dir: string): string[] {
    try {
        return readdirSync(dir);
    } catch {
        return [];
    }
}

/** The file's JSON, parsed again only when it changed. Null when missing or broken. */
function readJson(cache: AgentTasksCache, path: string): unknown {
    const stats = statOrNull(path);
    if (stats === null) {
        return null;
    }
    const hit = cache.files.get(path);
    if (hit !== undefined && hit.mtimeMs === stats.mtimeMs && hit.size === stats.size) {
        return hit.value;
    }
    let value: unknown = null;
    try {
        value = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        value = null;
    }
    cache.files.set(path, { mtimeMs: stats.mtimeMs, size: stats.size, value });
    return value;
}

/** The last `bytes` of the file as text, without the first (cut) line. Empty when unreadable. */
function readTail(path: string, bytes: number): string {
    try {
        const fd = openSync(path, 'r');
        try {
            const size = fstatSync(fd).size;
            const length = Math.min(size, bytes);
            const buffer = Buffer.alloc(length);
            readSync(fd, buffer, 0, length, size - length);
            const tail = buffer.toString('utf8');
            return length < size ? tail.slice(tail.indexOf('\n') + 1) : tail;
        } finally {
            closeSync(fd);
        }
    } catch {
        return '';
    }
}

/**
 * Messages the session has not read yet: `queue-operation` enqueues (task notifications aside)
 * not yet taken off by a later `dequeue` or `remove`. The queue is first in, first out.
 */
export function countQueuedInputs(transcriptTail: string): number {
    const queue: boolean[] = [];
    for (const line of transcriptTail.split('\n')) {
        if (!line.includes('"queue-operation"')) {
            continue;
        }
        let entry: unknown;
        try {
            entry = JSON.parse(line);
        } catch {
            continue;
        }
        if (!isRecord(entry) || entry.type !== 'queue-operation') {
            continue;
        }
        if (entry.operation === 'enqueue') {
            const content = typeof entry.content === 'string' ? entry.content : '';
            queue.push(!content.trimStart().startsWith('<task-notification'));
        } else if (entry.operation === 'dequeue' || entry.operation === 'remove') {
            queue.shift();
        }
    }
    return queue.filter(Boolean).length;
}

/** `inFlight.tasks` of the job's state, or null when the file or field is missing. */
function inFlightTasks(cache: AgentTasksCache, jobStatePath: string): number | null {
    const state = readJson(cache, jobStatePath);
    const inFlight = isRecord(state) ? state.inFlight : undefined;
    return isRecord(inFlight) && typeof inFlight.tasks === 'number' ? inFlight.tasks : null;
}

/**
 * The `Workflow` launch result for run `wfId` in the transcript's end: its summary and script
 * name ("Summary: …\nTranscript dir: …/wf_x\nScript file: …/name.js").
 */
export function findWorkflowLaunch(transcriptTail: string, wfId: string): { label: string | null; summary: string | null } | null {
    const at = transcriptTail.lastIndexOf(`/${wfId}\\n`);
    if (at < 0) {
        return null;
    }
    const before = transcriptTail.slice(Math.max(0, at - 4000), at);
    const summaryAt = before.lastIndexOf('Summary: ');
    const summaryEnd = summaryAt < 0 ? -1 : before.indexOf('\\n', summaryAt);
    const summary = summaryAt < 0 || summaryEnd < 0 ? null : decodeJsonText(before.slice(summaryAt + 9, summaryEnd));
    const after = transcriptTail.slice(at, at + 2000).match(/Script file: ([^"\\]+)/);
    const label = after === null ? null : basename(after[1]).replace(/\.[cm]?[jt]s$/, '');
    return { label: text(label), summary: text(summary) };
}

/** A JSON string's inside (escapes and all) as plain text; the raw text when it does not parse. */
function decodeJsonText(raw: string): string {
    try {
        return JSON.parse(`"${raw}"`) as string;
    } catch {
        return raw;
    }
}

type SubAgentFile = { id: string; meta: Record<string, unknown>; jsonl: Stats };

function readSubAgents(cache: AgentTasksCache, dir: string): SubAgentFile[] {
    const agents: SubAgentFile[] = [];
    for (const name of listOrEmpty(dir)) {
        if (!name.endsWith('.meta.json')) {
            continue;
        }
        const id = name.slice(0, -'.meta.json'.length);
        const meta = readJson(cache, join(dir, name));
        const jsonl = statOrNull(join(dir, `${id}.jsonl`));
        if (isRecord(meta) && jsonl !== null) {
            agents.push({ id, meta, jsonl });
        }
    }
    return agents;
}

function workflowStatus(status: unknown): ClaudeAgentTaskStatus {
    if (status === 'completed') {
        return 'done';
    }
    return status === 'killed' || status === 'cancelled' || status === 'stopped' ? 'stopped' : 'failed';
}

/** The sub-agents and workflows of one session, running first, and its unread messages. */
export function readAgentTasks(input: AgentTasksInput, cache: AgentTasksCache): ClaudeAgentTasks {
    const sessionDir = join(input.projectDir, input.sessionId);
    const subagentsDir = join(sessionDir, 'subagents');
    const transcriptPath = join(input.projectDir, `${input.sessionId}.jsonl`);
    // Work written before this process started was cut off when the previous one ended.
    const ofThisProcess = (mtimeMs: number): boolean => input.parentAlive && mtimeMs >= input.parentStartedAt;
    const tasks: ClaudeAgentTask[] = [];

    // Sub-agents. A session reports how many tasks it runs; an unfinished agent beyond that count
    // (the oldest written ones) was cut off without a `finished` mark.
    const subAgents = readSubAgents(cache, subagentsDir);
    const capacity = inFlightTasks(cache, input.jobStatePath);
    const candidates = subAgents
        .filter((agent) => agent.meta.finished !== true && ofThisProcess(agent.jsonl.mtimeMs))
        .sort((a, b) => b.jsonl.mtimeMs - a.jsonl.mtimeMs);
    const running = new Set(candidates.slice(0, capacity ?? candidates.length).map((agent) => agent.id));
    for (const agent of subAgents) {
        const status: ClaudeAgentTaskStatus = running.has(agent.id) ? 'running' : agent.meta.finished === true ? 'done' : 'stopped';
        const agentType = text(agent.meta.agentType);
        tasks.push({
            id: agent.id,
            kind: 'agent',
            label: text(agent.meta.description) ?? agentType ?? 'Sub-agent',
            detail: agentType !== null && agentType !== 'general-purpose' ? agentType : null,
            phase: null,
            model: text(agent.meta.model),
            status,
            startedAt: Math.round(agent.jsonl.birthtimeMs),
            endedAt: status === 'running' ? null : Math.round(agent.jsonl.mtimeMs),
            agentCount: null,
        });
    }

    // Workflows: a run with a record has ended; one without is running while its agents write in
    // this process's lifetime, and was cut off otherwise.
    const workflowsDir = join(subagentsDir, 'workflows');
    let launchTail: string | null = null;
    for (const wfId of listOrEmpty(workflowsDir)) {
        if (!wfId.startsWith('wf_')) {
            continue;
        }
        const runDir = join(workflowsDir, wfId);
        const runStats = statOrNull(runDir);
        if (runStats === null || !runStats.isDirectory()) {
            continue;
        }
        const agents = readSubAgents(cache, runDir);
        const record = readJson(cache, join(sessionDir, 'workflows', `${wfId}.json`));
        if (isRecord(record)) {
            const startedAt = typeof record.startTime === 'number' ? record.startTime : Math.round(runStats.birthtimeMs);
            tasks.push({
                id: wfId,
                kind: 'workflow',
                label: text(record.workflowName) ?? 'Workflow',
                detail: text(record.summary),
                phase: null,
                model: text(record.defaultModel),
                status: workflowStatus(record.status),
                startedAt,
                endedAt: typeof record.durationMs === 'number' ? startedAt + record.durationMs : Math.round(runStats.mtimeMs),
                agentCount: typeof record.agentCount === 'number' ? record.agentCount : agents.length,
            });
            continue;
        }
        const newest = agents.reduce<SubAgentFile | null>((latest, agent) => (latest === null || agent.jsonl.mtimeMs > latest.jsonl.mtimeMs ? agent : latest), null);
        const lastWrite = Math.max(runStats.mtimeMs, newest?.jsonl.mtimeMs ?? 0);
        const status: ClaudeAgentTaskStatus = ofThisProcess(lastWrite) ? 'running' : 'stopped';
        if (!cache.launches.has(wfId) || (cache.launches.get(wfId) === null && status === 'running')) {
            launchTail ??= readTail(transcriptPath, LAUNCH_TAIL_BYTES);
            cache.launches.set(wfId, findWorkflowLaunch(launchTail, wfId));
        }
        const launch = cache.launches.get(wfId) ?? null;
        tasks.push({
            id: wfId,
            kind: 'workflow',
            label: launch?.label ?? 'Workflow',
            detail: launch?.summary ?? null,
            phase: newest === null ? null : text(newest.meta.workflowPhase),
            model: null,
            status,
            startedAt: Math.round(runStats.birthtimeMs),
            endedAt: status === 'running' ? null : Math.round(lastWrite),
            agentCount: agents.length,
        });
    }

    tasks.sort((a, b) => {
        if ((a.status === 'running') !== (b.status === 'running')) {
            return a.status === 'running' ? -1 : 1;
        }
        return a.status === 'running' ? b.startedAt - a.startedAt : (b.endedAt ?? 0) - (a.endedAt ?? 0);
    });
    return {
        tasks: tasks.slice(0, MAX_TASKS),
        runningCount: tasks.filter((task) => task.status === 'running').length,
        totalCount: tasks.length,
        queuedInputs: input.parentAlive ? countQueuedInputs(readTail(transcriptPath, QUEUE_TAIL_BYTES)) : 0,
    };
}
