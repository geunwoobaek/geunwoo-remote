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
    /** What happens on the Mac after the Nth key press or typed text (1-based), e.g. a redraw. */
    after?: Record<number, () => void>;
    /** The Mac user's own pane. `null`: there is none. What it saw and did goes to `userLog`. */
    userScreen: string | null;
    userLog: string[];
    userOpened: number;
    /** Make the user pane's `screen` throw. */
    failUserScreen?: boolean;
    /** Make the user pane's `press` throw on this call number (1-based). */
    failUserPressAt?: number;
};

function keyName(key: AttachKey): string {
    return typeof key === 'string' ? key : String(key.digit);
}

function setup(initial: { status?: ClaudeAgentStatus | null; entries?: unknown[]; screen: string; cwd?: string; userScreen?: string }) {
    const h: Harness = {
        status: initial.status === undefined ? 'waiting' : initial.status,
        entries: initial.entries ?? [userText('start')],
        screen: initial.screen,
        state: {},
        notified: [],
        log: [],
        opened: 0,
        userScreen: initial.userScreen ?? null,
        userLog: [],
        userOpened: 0,
    };
    let userPresses = 0;
    const userTerminal: AttachTerminal = {
        async screen() {
            if (h.failUserScreen || h.userScreen === null) {
                throw new Error('cmux went away');
            }
            return h.userScreen;
        },
        async typeText(text) {
            h.userLog.push(`type:${text}`);
        },
        async pasteText() {
            throw new Error('cmux cannot paste');
        },
        async press(keys) {
            userPresses += 1;
            if (h.failUserPressAt === userPresses) {
                throw new Error('cmux went away');
            }
            h.userLog.push(`press:${keys.map(keyName).join(',')}`);
        },
        async close() {
            h.userLog.push('close');
        },
    };
    let presses = 0;
    let actions = 0;
    const acted = (): void => {
        actions += 1;
        h.after?.[actions]?.();
    };
    const terminal: AttachTerminal = {
        async screen() {
            return h.screen;
        },
        async typeText(text) {
            h.log.push(`type:${text}`);
            acted();
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
            acted();
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
        ...(initial.userScreen === undefined
            ? {}
            : {
                  openUserTerminal: async (): Promise<AttachTerminal | null> => {
                      if (h.userScreen === null) {
                          return null;
                      }
                      h.userOpened += 1;
                      h.userLog.push('open');
                      return userTerminal;
                  },
              }),
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

/** Hand-derived: the captured plan dialog with the focus moved to option 3 and nothing typed (not captured). */
function planFocusedOnFeedback(): string {
    const moved = screen('plan')
        .replace('   ❯ 1. Yes, and use auto mode', '     1. Yes, and use auto mode')
        .replace('     3. Tell Claude what to change', '   ❯ 3. Tell Claude what to change');
    expect(moved).not.toBe(screen('plan'));
    return moved;
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

        const key = onlyRequestKey(h.state);
        expect(key).toMatch(new RegExp(`^screen:${dialogFingerprint(screen('question-single'))}:.+`));
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

    it('tick does not count ticks while the session is busy running the approved tool', async () => {
        const { h, bridge } = setup({ screen: screen('permission-write'), entries: [userText('write it'), toolUse('toolu_write', 'Write', writeInput)] });
        await bridge.tick();

        // Approved on the Mac: the dialog is gone and the tool runs; its tool_result is written only when it finishes.
        h.status = 'busy';
        for (let i = 0; i < 10; i++) {
            await bridge.tick();
        }
        expect(Object.keys(h.state.requests ?? {})).toEqual(['toolu_write']);
        expect(h.state.completedRequests).toBeUndefined();

        h.entries = [...h.entries, toolResult('toolu_write', 'File created successfully')];
        await bridge.tick();
        expect(h.state.requests).toEqual({});
        expect(h.state.completedRequests?.toolu_write).toMatchObject({ status: 'approved', decision: 'approved' });
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
        const second = onlyRequestKey(h.state);
        expect(second).not.toBe(key);
        expect(h.state.completedRequests?.[key]).toMatchObject({ tool: 'AskUserQuestion' });
        expect(h.notified).toEqual(['AskUserQuestion', 'AskUserQuestion']);
    });

    it('a second identical dialog after the first completed publishes a new screen: key', async () => {
        const { h, bridge } = setup({ screen: screen('question-single'), entries: [userText('ask me')] });
        await bridge.tick();
        const first = onlyRequestKey(h.state);
        expect(await bridge.answer(response(first, true, { updatedInput: { answers: { 'Which color should the demo button use?': 'Green' } } }))).toBe('typed');
        expect(h.state.completedRequests?.[first]).toBeDefined();

        h.entries = [...h.entries, userText('go on')];
        await bridge.tick();

        const second = onlyRequestKey(h.state);
        expect(second).toMatch(/^screen:/);
        expect(second).not.toBe(first);
        // The first card stays completed under its own key; the new one is open, not completed.
        expect(Object.keys(h.state.completedRequests ?? {})).toEqual([first]);
        expect(h.state.completedRequests?.[second]).toBeUndefined();

        // The same dialog still drawn on later ticks does not open a third one.
        await bridge.tick();
        expect(Object.keys(h.state.requests ?? {})).toEqual([second]);
    });

    it('does not publish a second card when the Mac user moves the focus in a screen: dialog', async () => {
        const { h, bridge } = setup({ screen: screen('question-single'), entries: [userText('ask me')] });
        await bridge.tick();
        const key = onlyRequestKey(h.state);

        // Hand-derived: the cursor moved from Red to Green; the transcript grew, so tick reads the screen again.
        h.screen = screen('question-single').replace('❯ 1. Red', '  1. Red').replace('  2. Green', '❯ 2. Green');
        h.entries = [...h.entries, userText('unrelated line')];
        await bridge.tick();

        expect(Object.keys(h.state.requests ?? {})).toEqual([key]);
        expect(h.state.completedRequests).toBeUndefined();
        expect(h.notified).toEqual(['AskUserQuestion']);
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

    it('answer presses the absolute digit after the Mac user moved the focus', async () => {
        const { h, bridge } = await publishedWrite();
        h.screen = screen('permission-write').replace(' ❯ 1. Yes', '   1. Yes').replace('   3. No', ' ❯ 3. No');

        expect(await bridge.answer(response('toolu_write', true))).toBe('typed');

        expect(typing(h.log)).toEqual(['press:1']);
        expect(h.state.completedRequests?.toolu_write).toMatchObject({ status: 'approved' });
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
        // The measured screens of this scenario (outcomes.json "question-multi": 1, 3, Tab, 2, 1).
        h.after = {
            2: () => { h.screen = screen('question-multi-toggled'); },
            3: () => { h.screen = screen('question-multi-second'); },
            4: () => { h.screen = screen('question-review'); },
        };

        const answers = { 'Which toppings should the demo pizza have?': 'Cheese, Basil', 'Which size should the demo pizza be?': 'Medium' };
        expect(await bridge.answer(response('toolu_pizza', true, { updatedInput: { answers } }))).toBe('typed');

        const gap = `sleep:${DIALOG_KEY_GAP_MS}`;
        expect(typing(h.log)).toEqual(['press:1', gap, 'press:3', gap, 'press:tab', gap, 'press:2', gap, 'press:1']);
        expect(h.state.completedRequests?.toolu_pizza).toMatchObject({ status: 'approved' });
    });

    it('answer submits a lone multi-select question through the measured review screen', async () => {
        const { h, bridge } = setup({ screen: screen('question-lone-multi'), entries: [userText('ask me')] });
        await bridge.tick();
        const key = onlyRequestKey(h.state);
        // outcomes.json "question-lone-multi": 1, 3, Tab, 1.
        h.after = { 3: () => { h.screen = screen('question-lone-multi-after-tab'); } };

        const answers = { 'Which days should the demo meeting use?': 'Monday, Friday' };
        expect(await bridge.answer(response(key, true, { updatedInput: { answers } }))).toBe('typed');

        const gap = `sleep:${DIALOG_KEY_GAP_MS}`;
        expect(typing(h.log)).toEqual(['press:1', gap, 'press:3', gap, 'press:tab', gap, 'press:1']);
        expect(h.state.completedRequests?.[key]).toMatchObject({ status: 'approved' });
    });

    it('answer does not press the final 1 when a permission dialog appears before it', async () => {
        const { h, bridge } = setup({ screen: screen('question-multi'), entries: [userText('ask me'), toolUse('toolu_pizza', 'AskUserQuestion', pizzaQuestions)] });
        await bridge.tick();
        h.after = {
            2: () => { h.screen = screen('question-multi-toggled'); },
            3: () => { h.screen = screen('question-multi-second'); },
            4: () => { h.screen = screen('permission-write'); },
        };

        const answers = { 'Which toppings should the demo pizza have?': 'Cheese, Basil', 'Which size should the demo pizza be?': 'Medium' };
        expect(await bridge.answer(response('toolu_pizza', true, { updatedInput: { answers } }))).toBe('typed');

        const gap = `sleep:${DIALOG_KEY_GAP_MS}`;
        expect(typing(h.log)).toEqual(['press:1', gap, 'press:3', gap, 'press:tab', gap, 'press:2', gap]);
        expect(h.log.at(-1)).toBe('close');
        expect(h.state.completedRequests?.toolu_pizza).toMatchObject({ status: 'canceled', reason: 'typing-failed' });
    });

    it('answer does not press the final 1 when the review screen does not show', async () => {
        const { h, bridge } = setup({ screen: screen('question-multi'), entries: [userText('ask me'), toolUse('toolu_pizza', 'AskUserQuestion', pizzaQuestions)] });
        await bridge.tick();
        // The size question is still on screen after 2 (the key was lost), so 1 would pick Small.
        h.after = { 3: () => { h.screen = screen('question-multi-second'); } };

        const answers = { 'Which toppings should the demo pizza have?': 'Cheese, Basil', 'Which size should the demo pizza be?': 'Medium' };
        expect(await bridge.answer(response('toolu_pizza', true, { updatedInput: { answers } }))).toBe('typed');

        const gap = `sleep:${DIALOG_KEY_GAP_MS}`;
        expect(typing(h.log)).toEqual(['press:1', gap, 'press:3', gap, 'press:tab', gap, 'press:2', gap]);
        expect(h.state.completedRequests?.toolu_pizza).toMatchObject({ status: 'canceled', reason: 'typing-failed' });
    });

    it('answer stops between keys when another question, another kind or a busy session shows', async () => {
        const answers = { 'Which toppings should the demo pizza have?': 'Cheese, Basil', 'Which size should the demo pizza be?': 'Medium' };
        const gap = `sleep:${DIALOG_KEY_GAP_MS}`;
        const changes: ((h: Harness) => void)[] = [
            (h) => { h.screen = screen('question-single'); },
            (h) => { h.screen = screen('input-empty'); },
            (h) => { h.status = 'busy'; },
        ];
        for (const change of changes) {
            const { h, bridge } = setup({ screen: screen('question-multi'), entries: [userText('ask me'), toolUse('toolu_pizza', 'AskUserQuestion', pizzaQuestions)] });
            await bridge.tick();
            h.after = { 1: () => change(h) };

            expect(await bridge.answer(response('toolu_pizza', true, { updatedInput: { answers } }))).toBe('typed');

            expect(typing(h.log)).toEqual(['press:1', gap]);
            expect(h.state.completedRequests?.toolu_pizza).toMatchObject({ status: 'canceled', reason: 'typing-failed' });
        }
    });

    it('answer types plan approval keys for mode acceptEdits', async () => {
        const { h, bridge } = setup({ screen: screen('plan'), entries: [userText('plan it'), toolUse('toolu_plan', 'ExitPlanMode', { plan: '# Plan: hello-world greeting.txt' })] });
        await bridge.tick();
        expect(onlyRequestKey(h.state)).toBe('toolu_plan');

        expect(await bridge.answer(response('toolu_plan', true, { mode: 'acceptEdits' }))).toBe('typed');

        expect(typing(h.log)).toEqual(['press:2']);
        expect(h.state.completedRequests?.toolu_plan).toMatchObject({ status: 'approved', mode: 'acceptEdits' });
    });

    async function publishedPlan() {
        const ctx = setup({ screen: screen('plan'), entries: [userText('plan it'), toolUse('toolu_plan', 'ExitPlanMode', { plan: '# Plan' })] });
        await ctx.bridge.tick();
        expect(onlyRequestKey(ctx.h.state)).toBe('toolu_plan');
        return ctx;
    }

    const PLAN_REASON = 'Please name the file\nhello.txt instead\x1b[31m';
    const PLAN_FEEDBACK_TYPED = 'type:Please name the file hello.txt instead';

    it('answer rejects a plan with option 3, the sanitized reason and Enter once the reason shows', async () => {
        const { h, bridge } = await publishedPlan();
        h.after = {
            1: () => { h.screen = planFocusedOnFeedback(); },
            2: () => { h.screen = screen('plan-feedback-typed'); },
        };

        expect(await bridge.answer(response('toolu_plan', false, { reason: PLAN_REASON }))).toBe('typed');

        const gap = `sleep:${DIALOG_KEY_GAP_MS}`;
        expect(typing(h.log)).toEqual(['press:3', gap, PLAN_FEEDBACK_TYPED, gap, 'press:enter']);
        expect(h.state.completedRequests?.toolu_plan).toMatchObject({ status: 'denied', decision: 'denied' });
    });

    it('answer types no reason and no Enter when option 3 is not focused after 3', async () => {
        const { h, bridge } = await publishedPlan();
        // The screen after 3 is still the untouched plan dialog: typed text could pick an option.

        expect(await bridge.answer(response('toolu_plan', false, { reason: PLAN_REASON }))).toBe('typed');

        expect(typing(h.log)).toEqual(['press:3', `sleep:${DIALOG_KEY_GAP_MS}`]);
        expect(h.state.completedRequests?.toolu_plan).toMatchObject({ status: 'canceled', reason: 'typing-failed' });
    });

    it('answer presses no Enter when the typed reason does not show in option 3', async () => {
        const { h, bridge } = await publishedPlan();
        h.after = { 1: () => { h.screen = planFocusedOnFeedback(); } };

        expect(await bridge.answer(response('toolu_plan', false, { reason: PLAN_REASON }))).toBe('typed');

        const gap = `sleep:${DIALOG_KEY_GAP_MS}`;
        expect(typing(h.log)).toEqual(['press:3', gap, PLAN_FEEDBACK_TYPED, gap]);
        expect(h.state.completedRequests?.toolu_plan).toMatchObject({ status: 'canceled', reason: 'typing-failed' });
    });

    it('answer rejects a plan without a reason with 3, then Enter once option 3 shows the empty feedback', async () => {
        // The phone clients send no reason on deny; outcomes.json "plan reject without reason": 3, Enter.
        for (const extra of [{}, { reason: ' \n ' }]) {
            const { h, bridge } = await publishedPlan();
            h.after = { 1: () => { h.screen = planFocusedOnFeedback(); } };

            expect(await bridge.answer(response('toolu_plan', false, extra))).toBe('typed');

            expect(typing(h.log)).toEqual(['press:3', `sleep:${DIALOG_KEY_GAP_MS}`, 'press:enter']);
            expect(h.state.completedRequests?.toolu_plan).toMatchObject({ status: 'denied', decision: 'denied' });
        }
    });

    it('answer presses no Enter for a plan rejection without a reason when option 3 is not focused after 3', async () => {
        const { h, bridge } = await publishedPlan();
        // Still the untouched plan: Enter here would pick option 1 "Yes, and use auto mode".

        expect(await bridge.answer(response('toolu_plan', false))).toBe('typed');

        expect(typing(h.log)).toEqual(['press:3', `sleep:${DIALOG_KEY_GAP_MS}`]);
        expect(h.state.completedRequests?.toolu_plan).toMatchObject({ status: 'canceled', reason: 'typing-failed' });
    });

    it('answer presses no Enter for a plan rejection without a reason when option 3 holds text typed on the Mac', async () => {
        const { h, bridge } = await publishedPlan();
        h.after = { 1: () => { h.screen = screen('plan-feedback-typed'); } };

        expect(await bridge.answer(response('toolu_plan', false))).toBe('typed');

        expect(typing(h.log)).toEqual(['press:3', `sleep:${DIALOG_KEY_GAP_MS}`]);
        expect(h.state.completedRequests?.toolu_plan).toMatchObject({ status: 'canceled', reason: 'typing-failed' });
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

describe('createPermissionBridge with a user terminal', () => {
    const writeEntries = [userText('write it'), toolUse('toolu_write', 'Write', writeInput)];
    const pizzaEntries = [userText('ask me'), toolUse('toolu_pizza', 'AskUserQuestion', pizzaQuestions)];
    const pizzaAnswers = { 'Which toppings should the demo pizza have?': 'Cheese, Basil', 'Which size should the demo pizza be?': 'Medium' };

    it('answers on the user terminal when the four checks pass', async () => {
        const { h, bridge } = setup({ screen: screen('permission-write'), userScreen: screen('permission-write'), entries: writeEntries });
        await bridge.tick();
        expect(h.opened).toBe(0);

        expect(await bridge.answer(response('toolu_write', true))).toBe('typed');

        expect(h.userLog.slice(-3)).toEqual(['open', 'press:1', 'close']);
        expect(h.opened).toBe(0);
        expect(h.state.completedRequests?.toolu_write).toMatchObject({ status: 'approved', decision: 'approved' });
    });

    it('answers through tmux when the user terminal shows another screen', async () => {
        const { h, bridge } = setup({ screen: screen('permission-write'), userScreen: screen('permission-write'), entries: writeEntries });
        await bridge.tick();
        h.userLog = [];
        h.userScreen = screen('permission-bash-short');

        expect(await bridge.answer(response('toolu_write', true))).toBe('typed');

        expect(h.userLog).toEqual(['open', 'close']);
        expect(h.log).toEqual(['open', 'press:1', 'close']);
        expect(h.state.completedRequests?.toolu_write).toMatchObject({ status: 'approved' });
    });

    it('answers through tmux when the user terminal cannot be read or is gone', async () => {
        const { h, bridge } = setup({ screen: screen('permission-write'), userScreen: screen('permission-write'), entries: writeEntries });
        await bridge.tick();
        h.log = [];
        h.userLog = [];
        h.failUserScreen = true;

        expect(await bridge.answer(response('toolu_write', true))).toBe('typed');

        expect(h.userLog).toEqual(['open', 'close']);
        expect(h.log).toEqual(['open', 'press:1', 'close']);
    });

    it('goes to tmux when the answer needs text the user terminal cannot type', async () => {
        // Hand-derived: the captured plan dialog with option 3 focused, then with the reason (it contains a backslash) typed into option 3.
        const reason = 'use C:\\temp instead';
        const focused = planFocusedOnFeedback();
        const typed = screen('plan-feedback-typed').replace('Please name the file hello.txt instead', reason);
        expect(typed).not.toBe(screen('plan-feedback-typed'));
        const { h, bridge } = setup({ screen: screen('plan'), userScreen: screen('plan'), entries: [userText('plan it'), toolUse('toolu_plan', 'ExitPlanMode', { plan: '# Plan' })] });
        await bridge.tick();
        h.log = [];
        h.userLog = [];
        h.after = {
            1: () => { h.screen = focused; },
            2: () => { h.screen = typed; },
        };

        expect(await bridge.answer(response('toolu_plan', false, { reason }))).toBe('typed');

        expect(h.userLog).toEqual(['open', 'close']);
        expect(typing(h.log)).toEqual(['press:3', `sleep:${DIALOG_KEY_GAP_MS}`, `type:${reason}`, `sleep:${DIALOG_KEY_GAP_MS}`, 'press:enter']);
        expect(h.opened).toBe(1);
        expect(h.state.completedRequests?.toolu_plan).toMatchObject({ status: 'denied', decision: 'denied' });
    });

    it('does not retry on tmux after a key was pressed on the user terminal', async () => {
        const { h, bridge } = setup({ screen: screen('question-multi'), userScreen: screen('question-multi'), entries: pizzaEntries });
        await bridge.tick();
        h.failUserPressAt = 2;

        expect(await bridge.answer(response('toolu_pizza', true, { updatedInput: { answers: pizzaAnswers } }))).toBe('typed');

        expect(h.userLog.filter((line) => line.startsWith('press'))).toEqual(['press:1']);
        expect(h.opened).toBe(0);
        expect(h.state.completedRequests?.toolu_pizza).toMatchObject({ status: 'canceled', reason: 'typing-failed' });
    });

    it('goes to tmux when the first key fails on the user terminal', async () => {
        const { h, bridge } = setup({ screen: screen('permission-write'), userScreen: screen('permission-write'), entries: writeEntries });
        await bridge.tick();
        h.failUserPressAt = 1;

        expect(await bridge.answer(response('toolu_write', true))).toBe('typed');

        expect(h.log).toEqual(['open', 'press:1', 'close']);
        expect(h.state.completedRequests?.toolu_write).toMatchObject({ status: 'approved' });
    });

    it('refuses when neither terminal shows the dialog', async () => {
        const { h, bridge } = setup({ screen: screen('permission-write'), userScreen: screen('permission-write'), entries: writeEntries });
        await bridge.tick();
        h.userScreen = screen('input-empty');
        h.screen = screen('input-empty');

        expect(await bridge.answer(response('toolu_write', true))).toBe('refused');

        expect(h.userLog.filter((line) => line.startsWith('press'))).toEqual([]);
        expect(typing(h.log)).toEqual([]);
    });

    it('tick publishes from the user terminal screen', async () => {
        const { h, bridge } = setup({ screen: screen('write-perm-120'), userScreen: screen('write-perm-99') });

        await bridge.tick();

        const key = onlyRequestKey(h.state);
        expect(key).toMatch(new RegExp(`^screen:${dialogFingerprint(screen('write-perm-99'))}:.+`));
        expect(h.opened).toBe(0);
        // The same dialog captured in the tmux client answers it (width independence itself is proved in dialogs.test.ts).
        h.userScreen = null;

        expect(await bridge.answer(response(key, true))).toBe('typed');

        expect(h.log).toEqual(['open', 'press:1', 'close']);
    });

    it('tick falls back to the tmux screen when the user terminal cannot be read', async () => {
        const { h, bridge } = setup({ screen: screen('permission-write'), userScreen: screen('permission-write'), entries: writeEntries });
        h.failUserScreen = true;

        await bridge.tick();

        expect(onlyRequestKey(h.state)).toBe('toolu_write');
        expect(h.opened).toBe(1);
    });
});
