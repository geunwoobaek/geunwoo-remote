import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getProjectPath } from '@/claude/utils/path';
import {
    findPendingToolUse,
    findToolUseOutcome,
    readLastLine,
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

    it('findPendingToolUse ignores an ExitPlanMode re-emitted after its result', () => {
        // Measured (Claude Code 2.1.319): after a plan rejection the transcript repeats the
        // ExitPlanMode call with the same id and input {} after its tool_result.
        const entries = [
            toolUseEntry([{ id: 'toolu_plan', name: 'ExitPlanMode', input: { plan: '# Plan' } }], 'msg_1'),
            toolResultEntry('toolu_plan', "The user doesn't want to proceed with this tool use.", true),
            toolUseEntry([{ id: 'toolu_plan', name: 'ExitPlanMode', input: {} }], 'msg_2'),
        ];

        expect(findPendingToolUse(entries)).toBeNull();
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

    it('reads the transcript of a session that moved into a worktree after it started', () => {
        const started = getProjectPath('/Users/tester/project');
        mkdirSync(started, { recursive: true });
        writeFileSync(join(started, 'sess-3.jsonl'), JSON.stringify(userText('hello')) + '\n');

        expect(readTranscriptEntries('/Users/tester/project/.claude/worktrees/feature', 'sess-3')).toHaveLength(1);
    });

    it('returns an empty list when the transcript does not exist', () => {
        expect(readTranscriptEntries('/Users/tester/project', 'missing')).toEqual([]);
    });
});

describe('readLastLine', () => {
    let configDir: string;
    let previousConfigDir: string | undefined;
    const cwd = '/Users/tester/project';

    const assistant = (content: unknown[], extra: Record<string, unknown> = {}) => ({
        type: 'assistant',
        ...extra,
        message: { id: 'msg', role: 'assistant', content },
    });

    function transcript(sessionId: string, entries: unknown[]): void {
        const projectPath = getProjectPath(cwd);
        mkdirSync(projectPath, { recursive: true });
        writeFileSync(join(projectPath, `${sessionId}.jsonl`), entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
    }

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

    it('takes the first non-blank line of the newest answer, passing over thinking, results and sub-agents', () => {
        transcript('s1', [
            assistant([{ type: 'text', text: 'older answer' }]),
            userText('next question'),
            assistant([{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: '\n\n## Done: tests pass\nmore' }]),
            toolResultEntry('toolu_9', 'output'),
            assistant([{ type: 'text', text: 'sub-agent chatter' }], { isSidechain: true }),
        ]);

        expect(readLastLine(cwd, 's1')).toBe('## Done: tests pass');
    });

    it('names a tool call by its description, else its name', () => {
        transcript('s2', [assistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: { description: 'Run the tests' } }])]);
        transcript('s3', [assistant([{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/x' } }])]);

        expect(readLastLine(cwd, 's2')).toBe('Run the tests');
        expect(readLastLine(cwd, 's3')).toBe('Read');
    });

    it('reads only the end of a long transcript and skips the line it cut', () => {
        transcript('s4', [userText('x'.repeat(200_000)), assistant([{ type: 'text', text: 'latest' }])]);

        expect(readLastLine(cwd, 's4')).toBe('latest');
    });

    it('is null without a transcript or an answer', () => {
        transcript('s5', [userText('only a question')]);

        expect(readLastLine(cwd, 's5')).toBeNull();
        expect(readLastLine(cwd, 'missing')).toBeNull();
    });
});
