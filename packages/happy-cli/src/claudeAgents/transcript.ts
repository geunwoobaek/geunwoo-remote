/**
 * Readers for Claude Code's on-disk state: transcript files
 * (`<claude config>/projects/<slug>/<sessionId>.jsonl`) and per-process session
 * status files (`<claude home>/sessions/<pid>.json`).
 *
 * Used by the background-agent mirror to detect an unanswered permission prompt
 * (a `tool_use` without a `tool_result`) and to learn how it was answered.
 */

import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { findSessionProjectDir } from '@/claude/utils/path';
import type { ClaudeAgentStatus } from './types';

export type PendingToolUse = { id: string; name: string; input: Record<string, unknown> };

export type ToolUseOutcome = { decision: 'approved' | 'denied'; text: string };

type ContentBlock = Record<string, unknown>;

const AGENT_STATUSES: readonly string[] = ['idle', 'busy', 'waiting'];

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The content blocks of an entry's message, or [] when the entry has none (string content included). */
function blocksOf(entry: unknown): ContentBlock[] {
    if (!isRecord(entry) || !isRecord(entry.message) || !Array.isArray(entry.message.content)) {
        return [];
    }
    return entry.message.content.filter(isRecord);
}

function isAssistant(entry: unknown): entry is Record<string, unknown> {
    return isRecord(entry) && entry.type === 'assistant';
}

function toolResultsOf(entry: unknown): ContentBlock[] {
    return isRecord(entry) && entry.type === 'user'
        ? blocksOf(entry).filter((block) => block.type === 'tool_result')
        : [];
}

function messageIdOf(entry: Record<string, unknown>): string | null {
    const message = entry.message;
    return isRecord(message) && typeof message.id === 'string' ? message.id : null;
}

/**
 * The last `tool_use` of the last assistant message that has no matching user `tool_result`.
 * Claude Code may write one assistant message as several lines sharing `message.id`,
 * so every line of that message is considered.
 */
export function findPendingToolUse(entries: unknown[]): PendingToolUse | null {
    const lastAssistant = entries.filter(isAssistant).at(-1);
    if (lastAssistant === undefined) {
        return null;
    }
    const messageId = messageIdOf(lastAssistant);
    const lastMessageEntries = entries.filter(
        (entry): entry is Record<string, unknown> =>
            isAssistant(entry) && (messageId === null ? entry === lastAssistant : messageIdOf(entry) === messageId),
    );

    const answered = new Set(
        entries.flatMap(toolResultsOf).map((block) => block.tool_use_id),
    );
    const pending = lastMessageEntries
        .flatMap(blocksOf)
        .filter((block) => block.type === 'tool_use' && typeof block.id === 'string' && !answered.has(block.id))
        .at(-1);

    return pending === undefined
        ? null
        : {
            id: pending.id as string,
            name: typeof pending.name === 'string' ? pending.name : '',
            input: isRecord(pending.input) ? pending.input : {},
        };
}

function resultText(content: unknown): string {
    if (typeof content === 'string') {
        return content;
    }
    if (Array.isArray(content)) {
        return content
            .filter(isRecord)
            .map((block) => (typeof block.text === 'string' ? block.text : ''))
            .filter((text) => text.length > 0)
            .join('\n');
    }
    return '';
}

/** How the tool call `toolUseId` was answered: `is_error: true` means the user denied it. */
export function findToolUseOutcome(entries: unknown[], toolUseId: string): ToolUseOutcome | null {
    const result = entries.flatMap(toolResultsOf).find((block) => block.tool_use_id === toolUseId);
    return result === undefined
        ? null
        : { decision: result.is_error === true ? 'denied' : 'approved', text: resultText(result.content) };
}

/** Parsed lines of a session transcript; broken lines are skipped and a missing file yields []. */
export function readTranscriptEntries(cwd: string, sessionId: string): unknown[] {
    const file = join(findSessionProjectDir(cwd, sessionId), `${sessionId}.jsonl`);
    if (!existsSync(file)) {
        return [];
    }
    return readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line): unknown[] => {
            try {
                return line.trim() === '' ? [] : [JSON.parse(line)];
            } catch {
                return [];
            }
        });
}

/** How much of a transcript's end [readLastLine] reads; tool results can be long, answers rarely are. */
const LAST_LINE_TAIL_BYTES = 64 * 1024;
/** The longest line [readLastLine] returns; the app shortens it further for its rows. */
const LAST_LINE_MAX = 500;

/**
 * What the session said last, for the app's row of a session no mirror follows: read from the
 * end of the transcript, the newest answer outside a sub-agent gives its last text block's first
 * non-blank line, or its last tool call's `description`, else the tool's name. Thinking and tool
 * results are passed over. Null without a transcript or with no answer in its last
 * [LAST_LINE_TAIL_BYTES]. Only the file's end is read: the daemon asks for every session on
 * each listing.
 */
export function readLastLine(cwd: string, sessionId: string): string | null {
    let text: string;
    let cut: boolean;
    try {
        const fd = openSync(join(findSessionProjectDir(cwd, sessionId), `${sessionId}.jsonl`), 'r');
        try {
            const size = fstatSync(fd).size;
            const length = Math.min(size, LAST_LINE_TAIL_BYTES);
            const buffer = Buffer.alloc(length);
            readSync(fd, buffer, 0, length, size - length);
            text = buffer.toString('utf8');
            cut = length < size;
        } finally {
            closeSync(fd);
        }
    } catch {
        return null;
    }
    // A cut tail starts mid-line: that line is dropped.
    const lines = text.split('\n').slice(cut ? 1 : 0).reverse();
    for (const line of lines) {
        let entry: unknown;
        try {
            entry = line.trim() === '' ? null : JSON.parse(line);
        } catch {
            continue;
        }
        if (!isAssistant(entry) || entry.isSidechain === true) {
            continue;
        }
        for (const block of blocksOf(entry).reverse()) {
            const said = block.type === 'text' && typeof block.text === 'string'
                ? block.text.split('\n').map((part) => part.trim()).find((part) => part !== '')
                : block.type === 'tool_use'
                    ? (isRecord(block.input) && typeof block.input.description === 'string' && block.input.description.trim() !== ''
                        ? block.input.description.trim()
                        : typeof block.name === 'string' ? block.name : undefined)
                    : undefined;
            if (said !== undefined) {
                return said.slice(0, LAST_LINE_MAX);
            }
        }
    }
    return null;
}

/** The `status` of `<claude home>/sessions/<pid>.json`, or null if missing, broken or unrecognised. */
export function readSessionStatus(
    pid: number,
    claudeHome: string = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
): ClaudeAgentStatus | null {
    try {
        const parsed: unknown = JSON.parse(readFileSync(join(claudeHome, 'sessions', `${pid}.json`), 'utf8'));
        const status = isRecord(parsed) ? parsed.status : undefined;
        return typeof status === 'string' && AGENT_STATUSES.includes(status) ? (status as ClaudeAgentStatus) : null;
    } catch {
        return null;
    }
}
