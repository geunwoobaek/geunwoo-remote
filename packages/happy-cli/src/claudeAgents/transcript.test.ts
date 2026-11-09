import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getProjectPath } from '@/claude/utils/path';
import {
    findPendingToolUse,
    findToolUseOutcome,
    readSessionStatus,
    readTranscriptEntries,
} from './transcript';

const toolUseEntry = (blocks: Array<{ id: string; name: string; input?: Record<string, unknown> }>, messageId = 'msg_1') => ({
    type: 'assistant',
    uuid: `uuid-${blocks.map((b) => b.id).join('-')}`,
    message: {
        id: messageId,
        role: 'assistant',
        content: blocks.map((b) => ({ type: 'tool_use', id: b.id, name: b.name, input: b.input ?? {} })),
    },
});

const toolResultEntry = (toolUseId: string, content: unknown, isError?: boolean) => ({
    type: 'user',
    message: {
        role: 'user',
        content: [
            {
                type: 'tool_result',
                tool_use_id: toolUseId,
                ...(isError === undefined ? {} : { is_error: isError }),
                content,
            },
        ],
    },
});

const userText = (text: string) => ({ type: 'user', message: { role: 'user', content: text } });

describe('findPendingToolUse', () => {
    it('returns the Write call with no result', () => {
        const entries = [
            userText('write a file'),
            toolUseEntry([{ id: 'toolu_1', name: 'Write', input: { file_path: '/Users/tester/project/a.txt', content: 'hi' } }]),
        ];

        expect(findPendingToolUse(entries)).toEqual({
            id: 'toolu_1',
            name: 'Write',
            input: { file_path: '/Users/tester/project/a.txt', content: 'hi' },
        });
    });

    it('returns null once a tool_result follows', () => {
        const entries = [
            userText('write a file'),
            toolUseEntry([{ id: 'toolu_1', name: 'Write' }]),
            toolResultEntry('toolu_1', 'File created'),
        ];

        expect(findPendingToolUse(entries)).toBeNull();
    });

    it('picks the last unanswered of parallel calls', () => {
        const entries = [
            userText('do two things'),
            toolUseEntry([
                { id: 'toolu_1', name: 'Read' },
                { id: 'toolu_2', name: 'Write' },
            ]),
            toolResultEntry('toolu_1', 'contents'),
        ];

        expect(findPendingToolUse(entries)?.id).toBe('toolu_2');
    });

    it('handles parallel calls split across assistant lines of one message', () => {
        const entries = [
            userText('do two things'),
            toolUseEntry([{ id: 'toolu_1', name: 'Read' }], 'msg_9'),
            toolUseEntry([{ id: 'toolu_2', name: 'Write' }], 'msg_9'),
            toolResultEntry('toolu_2', 'ok'),
        ];

        expect(findPendingToolUse(entries)?.id).toBe('toolu_1');
    });

    it('ignores unanswered calls from earlier assistant messages', () => {
        const entries = [
            toolUseEntry([{ id: 'toolu_old', name: 'Bash' }], 'msg_1'),
            userText('never mind'),
            { type: 'assistant', message: { id: 'msg_2', role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
        ];

        expect(findPendingToolUse(entries)).toBeNull();
    });

    it('returns null for empty or malformed entries', () => {
        expect(findPendingToolUse([])).toBeNull();
        expect(findPendingToolUse([null, 'x', 42, {}, { type: 'assistant' }])).toBeNull();
    });
});

describe('findToolUseOutcome', () => {
    it('reads is_error as denied', () => {
        const entries = [
            toolUseEntry([{ id: 'toolu_1', name: 'Write' }]),
            toolResultEntry('toolu_1', "The user doesn't want to proceed with this tool use.", true),
        ];

        expect(findToolUseOutcome(entries, 'toolu_1')).toEqual({
            decision: 'denied',
            text: "The user doesn't want to proceed with this tool use.",
        });
    });

    it('reads a normal result as approved', () => {
        const entries = [
            toolUseEntry([{ id: 'toolu_1', name: 'Write' }]),
            toolResultEntry('toolu_1', [{ type: 'text', text: 'File created' }, { type: 'text', text: 'successfully' }]),
        ];

        expect(findToolUseOutcome(entries, 'toolu_1')).toEqual({
            decision: 'approved',
            text: 'File created\nsuccessfully',
        });
    });

    it('returns null when no result exists for the id', () => {
        const entries = [toolUseEntry([{ id: 'toolu_1', name: 'Write' }]), toolResultEntry('toolu_2', 'other')];

        expect(findToolUseOutcome(entries, 'toolu_1')).toBeNull();
    });
});

describe('readSessionStatus', () => {
    let claudeHome: string;

    beforeEach(() => {
        claudeHome = mkdtempSync(join(tmpdir(), 'claude-home-'));
        mkdirSync(join(claudeHome, 'sessions'));
    });

    afterEach(() => {
        rmSync(claudeHome, { recursive: true, force: true });
    });

    it('reads waiting from a temp claude home', () => {
        writeFileSync(join(claudeHome, 'sessions', '4242.json'), JSON.stringify({ pid: 4242, status: 'waiting', kind: 'background' }));

        expect(readSessionStatus(4242, claudeHome)).toBe('waiting');
    });

    it('returns null when the file is missing', () => {
        expect(readSessionStatus(9999, claudeHome)).toBeNull();
    });

    it('returns null for broken JSON or an unknown status', () => {
        writeFileSync(join(claudeHome, 'sessions', '1.json'), '{not json');
        writeFileSync(join(claudeHome, 'sessions', '2.json'), JSON.stringify({ status: 'sleeping' }));

        expect(readSessionStatus(1, claudeHome)).toBeNull();
        expect(readSessionStatus(2, claudeHome)).toBeNull();
    });
});

describe('readTranscriptEntries', () => {
    let configDir: string;
    let previousConfigDir: string | undefined;

    beforeEach(() => {
        configDir = mkdtempSync(join(tmpdir(), 'claude-config-'));
        previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
        process.env.CLAUDE_CONFIG_DIR = configDir;
    });

    afterEach(() => {
        if (previousConfigDir === undefined) {
            delete process.env.CLAUDE_CONFIG_DIR;
        } else {
            process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
        }
        rmSync(configDir, { recursive: true, force: true });
    });

    it('parses the jsonl under the project path and skips broken lines', () => {
        const cwd = '/Users/tester/project';
        const projectPath = getProjectPath(cwd);
        mkdirSync(projectPath, { recursive: true });
        const lines = [
            JSON.stringify(userText('hello')),
            '{broken',
            '',
            JSON.stringify(toolUseEntry([{ id: 'toolu_1', name: 'Write' }])),
        ];
        writeFileSync(join(projectPath, 'sess-1.jsonl'), lines.join('\n') + '\n');

        const entries = readTranscriptEntries(cwd, 'sess-1');

        expect(entries).toHaveLength(2);
        expect(findPendingToolUse(entries)?.id).toBe('toolu_1');
    });

    it('returns an empty list when the transcript does not exist', () => {
        expect(readTranscriptEntries('/Users/tester/project', 'missing')).toEqual([]);
    });
});
