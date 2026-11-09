import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentState } from '@/api/types';
import type { PermissionResponse } from '@/claude/utils/permissionHandler';
import type { AttachKey, AttachTerminal } from './attachTerminal';
import { DIALOG_KEY_GAP_MS, dialogFingerprint } from './dialogs';
import { createPermissionBridge } from './permissionBridge';
import type { ClaudeAgentStatus } from './types';

const screen = (name: string): string => readFileSync(join(__dirname, '__fixtures__', 'screens', `${name}.txt`), 'utf8');

/** The capture session's cwd after scrubbing (see dialogs.test.ts): dialogs show `project/…`. */
const CWD = '/Users/tester';
const WRITE_PATH = '/Users/tester/project/report-draft.md';
const NOW = 1_000;

const userText = (text: string, cwd: string | null = CWD) => ({ type: 'user', ...(cwd === null ? {} : { cwd }), message: { role: 'user', content: text } });

const toolUse = (id: string, name: string, input: Record<string, unknown>, cwd: string | null = CWD) => ({
    type: 'assistant',
    ...(cwd === null ? {} : { cwd }),
    message: { id: `msg_${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});

const toolResult = (id: string, content: string, isError = false) => ({
    type: 'user',
    cwd: CWD,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content }] },
});

const REJECTED = "The user doesn't want to proceed with this tool use. The tool use was rejected.";

const writeInput = { file_path: WRITE_PATH, content: 'draft' };

const colorQuestion = {
    questions: [
        {
            question: 'Which color should the demo button use?',
            header: 'Color',
            multiSelect: false,
            options: [{ label: 'Red' }, { label: 'Green' }, { label: 'Blue' }],
        },
    ],
};

const pizzaQuestions = {
    questions: [
        {
            question: 'Which toppings should the demo pizza have?',
            header: 'Toppings',
            multiSelect: true,
            options: [{ label: 'Cheese' }, { label: 'Olives' }, { label: 'Basil' }],
        },
        {
            question: 'Which size should the demo pizza be?',
            header: 'Size',
            multiSelect: false,
            options: [{ label: 'Small' }, { label: 'Medium' }, { label: 'Large' }],
        },
    ],
};

type Harness = {
    status: ClaudeAgentStatus | null;
    entries: unknown[];
    screen: string;
    state: AgentState;
    notified: string[];
    /** Everything the terminal and the sleep saw, in order. */
    log: string[];
    opened: number;
    /** Make `press` throw on this call number (1-based). */
    failPressAt?: number;
    failOpen?: boolean;
    failClose?: boolean;
};

function keyName(key: AttachKey): string {
    return typeof key === 'string' ? key : String(key.digit);
}

function setup(initial: { status?: ClaudeAgentStatus | null; entries?: unknown[]; screen: string; cwd?: string }) {
    const h: Harness = {
        status: initial.status === undefined ? 'waiting' : initial.status,
        entries: initial.entries ?? [userText('start')],
        screen: initial.screen,
        state: {},
        notified: [],
        log: [],
        opened: 0,
    };
    let presses = 0;
    const terminal: AttachTerminal = {
        async screen() {
            return h.screen;
        },
        async typeText(text) {
            h.log.push(`type:${text}`);
        },
        async pasteText(text) {
            h.log.push(`paste:${text}`);
        },
        async press(keys) {
            presses += 1;
            if (h.failPressAt === presses) {
                throw new Error('tmux went away');
            }
            h.log.push(`press:${keys.map(keyName).join(',')}`);
        },
        async close() {
            h.log.push('close');
            if (h.failClose) {
                throw new Error('close failed');
            }
        },
    };
    const bridge = createPermissionBridge({
        readStatus: () => h.status,
        readEntries: () => h.entries,
        openTerminal: async () => {
            if (h.failOpen) {
                throw new Error('no tmux');
            }
            h.opened += 1;
            h.log.push('open');
            return terminal;
        },
        updateAgentState: (update) => {
            h.state = update(h.state);
        },
        notifyPermission: (tool) => h.notified.push(tool),
        now: () => NOW,
        cwd: initial.cwd ?? CWD,
        sleep: async (ms) => {
            h.log.push(`sleep:${ms}`);
        },
    });
    return { h, bridge };
}

const typing = (log: string[]): string[] => log.filter((line) => /^(press|type|paste|sleep):/.test(line));

const response = (id: string, approved: boolean, extra: Partial<PermissionResponse> = {}): PermissionResponse => ({ id, approved, ...extra });

function onlyRequestKey(state: AgentState): string {
    const keys = Object.keys(state.requests ?? {});
    expect(keys).toHaveLength(1);
    return keys[0];
}

describe('createPermissionBridge tick', () => {
    it('tick publishes a request when the session is already waiting', async () => {
        const { h, bridge } = setup({ screen: screen('permission-write'), entries: [userText('write it'), toolUse('toolu_write', 'Write', writeInput)] });

        await bridge.tick();

        expect(h.state.requests).toEqual({ toolu_write: { tool: 'Write', arguments: writeInput, createdAt: NOW } });
        expect(h.notified).toEqual(['Write']);
        expect(h.log).toEqual(['open', 'close']);
    });

    it('tick does not notify twice for the same request', async () => {
        const { h, bridge } = setup({ screen: screen('permission-write'), entries: [userText('write it'), toolUse('toolu_write', 'Write', writeInput)] });

        await bridge.tick();
        await bridge.tick();
        await bridge.tick();

        expect(Object.keys(h.state.requests ?? {})).toEqual(['toolu_write']);
        expect(h.notified).toEqual(['Write']);
    });

    it('tick does not open the terminal while the session is not waiting', async () => {
        const { h, bridge } = setup({ status: 'busy', screen: screen('permission-write') });

        await bridge.tick();

        expect(h.opened).toBe(0);
        expect(h.state).toEqual({});
    });

    it('tick publishes a screen: request when the transcript has no pending tool_use', async () => {
        const { h, bridge } = setup({ screen: screen('question-single') });

        await bridge.tick();

        const key = `screen:${dialogFingerprint(screen('question-single'))}`;
        expect(h.state.requests).toEqual({
            [key]: {
                tool: 'AskUserQuestion',
                arguments: { questions: [{ question: 'Which color should the demo button use?', options: [{ label: 'Red' }, { label: 'Green' }, { label: 'Blue' }], multiSelect: false }] },
                createdAt: NOW,
            },
        });
        expect(h.notified).toEqual(['AskUserQuestion']);
    });

    it('takes gate ④ cwd from the entry carrying the tool_use, then the latest entry, then the launch cwd', async () => {
        const fromEntry = setup({ cwd: '/Users/elsewhere', screen: screen('permission-write'), entries: [toolUse('toolu_write', 'Write', writeInput, CWD)] });
        await fromEntry.bridge.tick();
        expect(onlyRequestKey(fromEntry.h.state)).toBe('toolu_write');

        const fromLatest = setup({ cwd: '/Users/elsewhere', screen: screen('permission-write'), entries: [userText('go', CWD), toolUse('toolu_write', 'Write', writeInput, null)] });
        await fromLatest.bridge.tick();
        expect(onlyRequestKey(fromLatest.h.state)).toBe('toolu_write');

        const fromLaunch = setup({ cwd: CWD, screen: screen('permission-write'), entries: [userText('go', null), toolUse('toolu_write', 'Write', writeInput, null)] });
        await fromLaunch.bridge.tick();
        expect(onlyRequestKey(fromLaunch.h.state)).toBe('toolu_write');

        const wrongEntry = setup({ cwd: CWD, screen: screen('permission-write'), entries: [toolUse('toolu_write', 'Write', writeInput, '/Users/elsewhere')] });
        await wrongEntry.bridge.tick();
        expect(onlyRequestKey(wrongEntry.h.state)).toMatch(/^screen:/);
    });

    it('tick records a Mac-side approval as approved', async () => {
        const { h, bridge } = setup({ screen: screen('permission-write'), entries: [userText('write it'), toolUse('toolu_write', 'Write', writeInput)] });
        await bridge.tick();

        h.entries = [...h.entries, toolResult('toolu_write', 'File created successfully')];
        h.status = 'idle';
        await bridge.tick();

        expect(h.state.requests).toEqual({});
        expect(h.state.completedRequests).toEqual({
            toolu_write: { tool: 'Write', arguments: writeInput, createdAt: NOW, completedAt: NOW, status: 'approved', decision: 'approved', toolUseId: 'toolu_write' },
        });
        expect(h.opened).toBe(1);
    });

    it('tick records a Mac-side rejection as denied', async () => {
        const { h, bridge } = setup({ screen: screen('permission-write'), entries: [userText('write it'), toolUse('toolu_write', 'Write', writeInput)] });
        await bridge.tick();

        h.entries = [...h.entries, toolResult('toolu_write', REJECTED, true)];
        h.status = 'idle';
        await bridge.tick();

        expect(h.state.completedRequests?.toolu_write).toMatchObject({ status: 'denied', decision: 'denied', toolUseId: 'toolu_write' });
        expect(h.state.requests).toEqual({});
    });

    it('tick completes a request whose dialog is gone while the session still waits', async () => {
        const { h, bridge } = setup({ screen: screen('permission-write'), entries: [userText('write it'), toolUse('toolu_write', 'Write', writeInput)] });
        await bridge.tick();

        h.entries = [...h.entries, toolResult('toolu_write', 'File created successfully'), toolUse('toolu_bash', 'Bash', { command: 'ls -la /Users/tester/project' })];
        h.screen = screen('permission-bash-short');
        await bridge.tick();

        expect(h.state.completedRequests?.toolu_write).toMatchObject({ status: 'approved' });
        expect(Object.keys(h.state.requests ?? {})).toEqual(['toolu_bash']);
        expect(h.notified).toEqual(['Write', 'Bash']);
    });

    it('tick cancels after five ticks without an outcome', async () => {
        const { h, bridge } = setup({ screen: screen('permission-write'), entries: [userText('write it'), toolUse('toolu_write', 'Write', writeInput)] });
        await bridge.tick();
        h.status = 'idle';

        for (let i = 0; i < 4; i++) {
            await bridge.tick();
        }
        expect(Object.keys(h.state.requests ?? {})).toEqual(['toolu_write']);
        expect(h.state.completedRequests).toBeUndefined();

        await bridge.tick();
        expect(h.state.requests).toEqual({});
        expect(h.state.completedRequests?.toolu_write).toMatchObject({ status: 'canceled' });
    });

    it('a Mac-side answer to a screen: request completes from the later tool_use', async () => {
        const { h, bridge } = setup({ screen: screen('question-single'), entries: [userText('ask me')] });
        await bridge.tick();
        const key = onlyRequestKey(h.state);

        // Answered on the Mac: the call and its result appear only now.
        h.entries = [
            ...h.entries,
            toolUse('toolu_q', 'AskUserQuestion', colorQuestion),
            toolResult('toolu_q', 'User has answered your questions: "Which color should the demo button use?"="Green".'),
        ];
        h.status = 'busy';
        await bridge.tick();

        expect(h.state.requests).toEqual({});
        const completed = h.state.completedRequests?.[key];
        expect(completed).toMatchObject({ tool: 'AskUserQuestion', status: 'approved', decision: 'approved', completedAt: NOW });
        expect(completed).not.toHaveProperty('toolUseId');
    });

    it('a screen: request ignores tool_use entries that were already there when it was made', async () => {
        const before = [userText('ask me'), toolUse('toolu_old', 'AskUserQuestion', colorQuestion), toolResult('toolu_old', 'User has answered your questions')];
        const { h, bridge } = setup({ screen: screen('question-single'), entries: before });
        await bridge.tick();
        const key = onlyRequestKey(h.state);

        h.status = 'idle';
        await bridge.tick();

        expect(h.state.completedRequests?.[key]).toBeUndefined();
        expect(Object.keys(h.state.requests ?? {})).toEqual([key]);
    });

    it('an unreadable dialog publishes a request that refuses answers', async () => {
        const { h, bridge } = setup({ screen: screen('question-multi') });
        await bridge.tick();
        const key = onlyRequestKey(h.state);
        expect(h.state.requests?.[key]).toMatchObject({ tool: 'Unknown' });
        expect(h.notified).toEqual(['Unknown']);

        const result = await bridge.answer(response(key, true, { updatedInput: { answers: { 'Which toppings should the demo pizza have?': 'Cheese' } } }));

        expect(result).toBe('refused');
        expect(typing(h.log)).toEqual([]);
        expect(h.state.completedRequests?.[key]).toMatchObject({ tool: 'Unknown', status: 'canceled', reason: 'answer-on-mac' });
    });

    it('does not publish a completed screen: dialog again until the transcript moves on', async () => {
        const { h, bridge } = setup({ screen: screen('question-single'), entries: [userText('ask me')] });
        await bridge.tick();
        const key = onlyRequestKey(h.state);
        expect(await bridge.answer(response(key, true, { updatedInput: { answers: { 'Which color should the demo button use?': 'Green' } } }))).toBe('typed');

        // Claude Code has not redrawn yet: the same dialog is still on screen.
        await bridge.tick();
        expect(h.state.requests).toEqual({});
        expect(h.notified).toEqual(['AskUserQuestion']);

        // The answer reached the transcript and Claude asks the very same question again.
        h.entries = [...h.entries, toolUse('toolu_q', 'AskUserQuestion', colorQuestion), toolResult('toolu_q', 'User has answered your questions')];
        await bridge.tick();
        expect(Object.keys(h.state.requests ?? {})).toEqual([key]);
        expect(h.state.completedRequests?.[key]).toBeUndefined();
        expect(h.notified).toEqual(['AskUserQuestion', 'AskUserQuestion']);
    });
});

describe('createPermissionBridge answer', () => {
    async function publishedWrite() {
        const ctx = setup({ screen: screen('permission-write'), entries: [userText('write it'), toolUse('toolu_write', 'Write', writeInput)] });
        await ctx.bridge.tick();
        ctx.h.log = [];
        return ctx;
    }

    it('answer types the permission keys when all four checks pass', async () => {
        const { h, bridge } = await publishedWrite();

        expect(await bridge.answer(response('toolu_write', true))).toBe('typed');

        expect(h.log).toEqual(['open', 'press:1', 'close']);
        expect(h.state.requests).toEqual({});
        expect(h.state.completedRequests?.toolu_write).toEqual({
            tool: 'Write',
            arguments: writeInput,
            createdAt: NOW,
            completedAt: NOW,
            status: 'approved',
            decision: 'approved',
            toolUseId: 'toolu_write',
        });
    });

    it('answer types the deny digit read from the screen', async () => {
        const { h, bridge } = await publishedWrite();

        expect(await bridge.answer(response('toolu_write', false, { reason: 'no' }))).toBe('typed');

        expect(typing(h.log)).toEqual(['press:3']);
        expect(h.state.completedRequests?.toolu_write).toMatchObject({ status: 'denied', decision: 'denied', reason: 'no' });
    });

    it('answer refuses when the status is no longer waiting', async () => {
        const { h, bridge } = await publishedWrite();
        h.status = 'busy';

        expect(await bridge.answer(response('toolu_write', true))).toBe('refused');

        expect(typing(h.log)).toEqual([]);
        expect(h.state.requests).toEqual({});
        expect(h.state.completedRequests?.toolu_write).toMatchObject({ status: 'canceled', reason: 'answer-on-mac' });
    });

    it('answer refuses when the pending id changed', async () => {
        const { h, bridge } = await publishedWrite();
        // The Mac answered and Claude asked for the very same file again: same screen, new id.
        h.entries = [...h.entries, toolResult('toolu_write', 'File created successfully'), toolUse('toolu_write_2', 'Write', writeInput)];

        expect(await bridge.answer(response('toolu_write', true))).toBe('refused');
        expect(typing(h.log)).toEqual([]);
    });

    it('answer refuses when the screen shows a different file', async () => {
        const { h, bridge } = await publishedWrite();
        h.screen = screen('permission-write').replaceAll('report-draft.md', 'other.md');

        expect(await bridge.answer(response('toolu_write', true))).toBe('refused');
        expect(typing(h.log)).toEqual([]);
        expect(h.state.completedRequests?.toolu_write).toMatchObject({ status: 'canceled', reason: 'answer-on-mac' });
    });

    it('answer refuses when the pending tool is Task', async () => {
        const { h, bridge } = setup({ screen: screen('permission-subagent'), entries: [userText('delegate'), toolUse('toolu_task', 'Task', { prompt: 'write sub-note.txt' })] });
        await bridge.tick();
        const key = onlyRequestKey(h.state);
        expect(key).toMatch(/^screen:/);
        expect(h.state.requests?.[key]).toMatchObject({ tool: 'Unknown' });

        expect(await bridge.answer(response(key, true))).toBe('refused');
        expect(await bridge.answer(response('toolu_task', true))).toBe('refused');
        expect(typing(h.log)).toEqual([]);
    });

    it('answer refuses when the dialog fingerprint changed', async () => {
        const { h, bridge } = setup({ screen: screen('question-single') });
        await bridge.tick();
        const key = onlyRequestKey(h.state);
        h.screen = screen('question-single').replace('A bold, high-attention color', 'A loud color');

        const result = await bridge.answer(response(key, true, { updatedInput: { answers: { 'Which color should the demo button use?': 'Green' } } }));

        expect(result).toBe('refused');
        expect(typing(h.log)).toEqual([]);
    });

    it('answer types question keys from updatedInput.answers', async () => {
        const { h, bridge } = setup({ screen: screen('question-single') });
        await bridge.tick();
        const key = onlyRequestKey(h.state);

        const result = await bridge.answer(response(key, true, { updatedInput: { answers: { 'Which color should the demo button use?': 'Green' } } }));

        expect(result).toBe('typed');
        expect(typing(h.log)).toEqual(['press:2']);
        expect(h.state.completedRequests?.[key]).toMatchObject({ status: 'approved', decision: 'approved' });
        expect(h.state.completedRequests?.[key]).not.toHaveProperty('toolUseId');
    });

    it('answer presses Escape when a question is denied', async () => {
        const { h, bridge } = setup({ screen: screen('question-single') });
        await bridge.tick();
        const key = onlyRequestKey(h.state);

        expect(await bridge.answer(response(key, false))).toBe('typed');

        expect(typing(h.log)).toEqual(['press:escape']);
        expect(h.state.completedRequests?.[key]).toMatchObject({ status: 'denied', decision: 'denied' });
    });

    it('answer refuses when only gate ④ fails because Claude moved to another cwd', async () => {
        const { h, bridge } = setup({ cwd: '', screen: screen('permission-write'), entries: [userText('go', CWD), toolUse('toolu_write', 'Write', writeInput, null)] });
        await bridge.tick();
        expect(onlyRequestKey(h.state)).toBe('toolu_write');
        // Same screen, same pending id; the latest cwd now resolves `project/report-draft.md` elsewhere.
        h.entries = [...h.entries, userText('cd elsewhere', '/Users/elsewhere')];

        expect(await bridge.answer(response('toolu_write', true))).toBe('refused');
        expect(typing(h.log)).toEqual([]);
    });

    it('answer refuses a free-text question answer', async () => {
        const { h, bridge } = setup({ screen: screen('question-single') });
        await bridge.tick();
        const key = onlyRequestKey(h.state);

        const result = await bridge.answer(response(key, true, { updatedInput: { answers: { 'Which color should the demo button use?': 'Purple' } } }));

        expect(result).toBe('refused');
        expect(typing(h.log)).toEqual([]);
        expect(h.state.completedRequests?.[key]).toMatchObject({ status: 'canceled', reason: 'answer-on-mac' });
    });

    it('answer presses keys one at a time with the gap', async () => {
        const { h, bridge } = setup({ screen: screen('question-multi'), entries: [userText('ask me'), toolUse('toolu_pizza', 'AskUserQuestion', pizzaQuestions)] });
        await bridge.tick();
        expect(onlyRequestKey(h.state)).toBe('toolu_pizza');

        const answers = { 'Which toppings should the demo pizza have?': 'Cheese, Basil', 'Which size should the demo pizza be?': 'Medium' };
        expect(await bridge.answer(response('toolu_pizza', true, { updatedInput: { answers } }))).toBe('typed');

        const gap = `sleep:${DIALOG_KEY_GAP_MS}`;
        expect(typing(h.log)).toEqual(['press:1', gap, 'press:3', gap, 'press:tab', gap, 'press:2', gap, 'press:1']);
    });

    it('answer types plan approval keys for mode acceptEdits', async () => {
        const { h, bridge } = setup({ screen: screen('plan'), entries: [userText('plan it'), toolUse('toolu_plan', 'ExitPlanMode', { plan: '# Plan: hello-world greeting.txt' })] });
        await bridge.tick();
        expect(onlyRequestKey(h.state)).toBe('toolu_plan');

        expect(await bridge.answer(response('toolu_plan', true, { mode: 'acceptEdits' }))).toBe('typed');

        expect(typing(h.log)).toEqual(['press:2']);
        expect(h.state.completedRequests?.toolu_plan).toMatchObject({ status: 'approved', mode: 'acceptEdits' });
    });

    it('answer rejects a plan with option 3, the sanitized reason and Enter', async () => {
        const { h, bridge } = setup({ screen: screen('plan'), entries: [userText('plan it'), toolUse('toolu_plan', 'ExitPlanMode', { plan: '# Plan' })] });
        await bridge.tick();

        expect(await bridge.answer(response('toolu_plan', false, { reason: 'Name it\nhello.txt\x1b[31m' }))).toBe('typed');

        const gap = `sleep:${DIALOG_KEY_GAP_MS}`;
        expect(typing(h.log)).toEqual(['press:3', gap, 'type:Name it hello.txt', gap, 'press:enter']);
        expect(h.state.completedRequests?.toolu_plan).toMatchObject({ status: 'denied', decision: 'denied' });
    });

    it('answer refuses an unknown key without opening the terminal', async () => {
        const { h, bridge } = await publishedWrite();

        expect(await bridge.answer(response('toolu_missing', true))).toBe('refused');

        expect(h.opened).toBe(1);
        expect(h.state.completedRequests).toBeUndefined();
    });

    it('answer refuses a second answer to the same request', async () => {
        const { h, bridge } = await publishedWrite();
        expect(await bridge.answer(response('toolu_write', true))).toBe('typed');

        expect(await bridge.answer(response('toolu_write', false))).toBe('refused');
        expect(typing(h.log)).toEqual(['press:1']);
        expect(h.state.completedRequests?.toolu_write).toMatchObject({ status: 'approved' });
    });

    it('answer refuses when the terminal cannot be opened, and does not throw', async () => {
        const { h, bridge } = await publishedWrite();
        h.failOpen = true;

        expect(await bridge.answer(response('toolu_write', true))).toBe('refused');
        expect(h.state.completedRequests?.toolu_write).toMatchObject({ status: 'canceled', reason: 'answer-on-mac' });
    });

    it('answer keeps the typed result when closing the terminal fails', async () => {
        const { h, bridge } = await publishedWrite();
        h.failClose = true;

        expect(await bridge.answer(response('toolu_write', true))).toBe('typed');
        expect(h.state.completedRequests?.toolu_write).toMatchObject({ status: 'approved' });
    });

    it('answer records typing-failed when a key fails after typing started', async () => {
        const { h, bridge } = setup({ screen: screen('question-multi'), entries: [userText('ask me'), toolUse('toolu_pizza', 'AskUserQuestion', pizzaQuestions)] });
        await bridge.tick();
        h.failPressAt = 2;

        const answers = { 'Which toppings should the demo pizza have?': 'Cheese, Basil', 'Which size should the demo pizza be?': 'Medium' };
        expect(await bridge.answer(response('toolu_pizza', true, { updatedInput: { answers } }))).toBe('typed');

        expect(typing(h.log)).toEqual(['press:1', `sleep:${DIALOG_KEY_GAP_MS}`]);
        expect(h.log.at(-1)).toBe('close');
        expect(h.state.completedRequests?.toolu_pizza).toMatchObject({ status: 'canceled', reason: 'typing-failed' });
    });

    it('a Mac answer after a refused phone answer still completes the card', async () => {
        const { h, bridge } = await publishedWrite();
        h.status = 'busy';
        expect(await bridge.answer(response('toolu_write', true))).toBe('refused');

        h.entries = [...h.entries, toolResult('toolu_write', REJECTED, true)];
        h.status = 'idle';
        await bridge.tick();

        expect(h.state.completedRequests?.toolu_write).toMatchObject({ status: 'denied', decision: 'denied' });
        expect(h.state.completedRequests?.toolu_write).not.toHaveProperty('reason');
    });
});
