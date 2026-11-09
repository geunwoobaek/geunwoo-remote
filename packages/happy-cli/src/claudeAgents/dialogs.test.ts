import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PendingToolUse } from './transcript';
import {
    classifyScreen,
    isInputBoxEmpty,
    keysForPermission,
    keysForPlan,
    keysForQuestion,
    screenMatchesPending,
} from './dialogs';

const screen = (name: string): string => readFileSync(join(__dirname, '__fixtures__', 'screens', `${name}.txt`), 'utf8');

const pending = (name: string, input: Record<string, unknown>): PendingToolUse => ({ id: 'toolu_demo', name, input });

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

const extrasQuestion = {
    questions: [
        {
            question: 'Which extras should the demo logo get?',
            header: 'Extras',
            multiSelect: true,
            options: [{ label: 'Shadow' }, { label: 'Outline' }, { label: 'Gradient' }],
        },
    ],
};

const bashCommand = "printf 'jarvis capture check with some padding text to make it long\\n' > /Users/tester/project/bash-out.txt && ls -la /Users/tester/project";

describe('classifyScreen', () => {
    it.each([
        ['permission-write', 'permission'],
        ['permission-bash', 'permission'],
        ['permission-bash-short', 'permission'],
        ['permission-subagent', 'permission'],
        ['question-single', 'question'],
        ['question-multi', 'question'],
        ['question-multi-toggled', 'question'],
        ['question-multi-second', 'question'],
        ['question-review', 'question'],
        ['question-other', 'question'],
        ['plan', 'plan'],
        ['plan-feedback-typed', 'plan'],
        ['after-plan-approve', 'permission'],
        ['plan-after-empty-reject', 'none'],
        ['input-empty', 'none'],
        ['input-typed', 'none'],
        ['input-suggestion-and-survey', 'none'],
    ])('%s is %s', (name, kind) => {
        expect(classifyScreen(screen(name))).toBe(kind);
    });

    it('is unknown for a blank screen and for a dialog it has not seen', () => {
        expect(classifyScreen('\n\n   \n')).toBe('unknown');
        const unseen = screen('permission-write').replace('Do you want to create report-draft.md?', 'Pick one');
        expect(classifyScreen(unseen)).toBe('unknown');
    });

    it('reads plan options below the prompt only, so a numbered plan body is still a plan', () => {
        const numbered = screen('plan').replace('   - Use the Write tool', '   1. Use the Write tool').replace('   - Confirm the file', '   2. Confirm the file');
        expect(numbered).toContain('1. Use the Write tool');
        expect(classifyScreen(numbered)).toBe('plan');
        expect(screenMatchesPending(numbered, pending('ExitPlanMode', { plan: '# Plan' }))).toBe(true);
    });

    it('tolerates trailing blank lines and spaces like a raw 40-row capture', () => {
        expect(classifyScreen(`${screen('permission-bash-short')}\n   \n\n`)).toBe('permission');
    });
});

describe('screenMatchesPending', () => {
    it('matches a Write by file name and rejects another file name', () => {
        expect(screenMatchesPending(screen('permission-write'), pending('Write', { file_path: '/Users/tester/project/report-draft.md', content: 'draft' }))).toBe(true);
        expect(screenMatchesPending(screen('permission-write'), pending('Write', { file_path: '/Users/tester/project/other.md', content: 'draft' }))).toBe(false);
    });

    it('takes the file name from the dialog question, not from elsewhere on the screen', () => {
        // A Write dialog that names greeting.txt somewhere other than its question line.
        const mentioned = screen('permission-write').replace('Create file', 'Create file (see greeting.txt)');
        expect(screenMatchesPending(mentioned, pending('Write', { file_path: '/Users/tester/project/greeting.txt' }))).toBe(false);
    });

    it('matches a wrapped Bash command by its first 40 characters', () => {
        expect(screenMatchesPending(screen('permission-bash'), pending('Bash', { command: bashCommand }))).toBe(true);
        expect(screenMatchesPending(screen('permission-bash-short'), pending('Bash', { command: 'ls -la /Users/tester/project' }))).toBe(true);
        expect(screenMatchesPending(screen('permission-bash-short'), pending('Bash', { command: 'rm -rf /Users/tester/project' }))).toBe(false);
    });

    it('never matches a subagent dialog', () => {
        const subagentScreen = screen('permission-subagent');
        expect(screenMatchesPending(subagentScreen, pending('Task', { prompt: 'write sub-note.txt' }))).toBe(false);
        expect(screenMatchesPending(subagentScreen, pending('Agent', { prompt: 'write sub-note.txt' }))).toBe(false);
        expect(screenMatchesPending(subagentScreen, pending('Write', { file_path: '/Users/tester/project/sub-note.txt' }))).toBe(false);
    });

    it('never matches when the pending call is Task or Agent', () => {
        expect(screenMatchesPending(screen('permission-write'), pending('Task', { file_path: '/Users/tester/project/report-draft.md' }))).toBe(false);
    });

    it('matches an untouched question by its first question text only', () => {
        expect(screenMatchesPending(screen('question-single'), pending('AskUserQuestion', colorQuestion))).toBe(true);
        expect(screenMatchesPending(screen('question-multi'), pending('AskUserQuestion', pizzaQuestions))).toBe(true);
        expect(screenMatchesPending(screen('question-single'), pending('AskUserQuestion', pizzaQuestions))).toBe(false);
    });

    it('refuses a question that was partly answered on the Mac', () => {
        expect(screenMatchesPending(screen('question-multi-toggled'), pending('AskUserQuestion', pizzaQuestions))).toBe(false);
        expect(screenMatchesPending(screen('question-multi-second'), pending('AskUserQuestion', pizzaQuestions))).toBe(false);
        expect(screenMatchesPending(screen('question-review'), pending('AskUserQuestion', pizzaQuestions))).toBe(false);
    });

    it('matches an untouched plan dialog and refuses one with feedback typed', () => {
        expect(screenMatchesPending(screen('plan'), pending('ExitPlanMode', { plan: '# Plan' }))).toBe(true);
        expect(screenMatchesPending(screen('plan-feedback-typed'), pending('ExitPlanMode', { plan: '# Plan' }))).toBe(false);
    });

    it('does not match a dialog of another kind or the idle input box', () => {
        expect(screenMatchesPending(screen('plan'), pending('Write', { file_path: '/Users/tester/project/greeting.txt' }))).toBe(false);
        expect(screenMatchesPending(screen('permission-write'), pending('ExitPlanMode', {}))).toBe(false);
        expect(screenMatchesPending(screen('input-typed'), pending('Write', { file_path: '/Users/tester/project/report-draft.md' }))).toBe(false);
    });
});

describe('keysForPermission', () => {
    it('presses the digit of the Yes / No option shown (3 = No on a file write)', () => {
        expect(keysForPermission(true, screen('permission-write'))).toEqual([{ digit: 1 }]);
        expect(keysForPermission(false, screen('permission-write'))).toEqual([{ digit: 3 }]);
    });

    it('presses 2 for No when the Bash dialog only offers Yes / No', () => {
        expect(keysForPermission(true, screen('permission-bash'))).toEqual([{ digit: 1 }]);
        expect(keysForPermission(false, screen('permission-bash'))).toEqual([{ digit: 2 }]);
    });

    it('returns null when no permission dialog is open', () => {
        expect(keysForPermission(true, screen('input-empty'))).toBeNull();
        expect(keysForPermission(false, screen('question-single'))).toBeNull();
        expect(keysForPermission(true, screen('plan'))).toBeNull();
    });
});

describe('keysForQuestion', () => {
    it('answers a lone single-select question with one digit (no review screen)', () => {
        expect(keysForQuestion(colorQuestion, { 'Which color should the demo button use?': 'Green' })).toEqual([{ digit: 2 }]);
    });

    it('toggles multi-select digits, tabs on, picks the single-select digit and submits the review', () => {
        const answers = {
            'Which toppings should the demo pizza have?': 'Cheese, Basil',
            'Which size should the demo pizza be?': 'Medium',
        };
        expect(keysForQuestion(pizzaQuestions, answers)).toEqual([{ digit: 1 }, { digit: 3 }, 'tab', { digit: 2 }, { digit: 1 }]);
    });

    it('submits a lone multi-select question through the review screen', () => {
        expect(keysForQuestion(extrasQuestion, { 'Which extras should the demo logo get?': 'Outline' })).toEqual([{ digit: 2 }, 'tab', { digit: 1 }]);
    });

    it('returns null for free text ("Type something") and for answers that are not options', () => {
        expect(keysForQuestion(extrasQuestion, { 'Which extras should the demo logo get?': 'Sparkle' })).toBeNull();
        expect(keysForQuestion(colorQuestion, { 'Which color should the demo button use?': 'Purple' })).toBeNull();
        expect(keysForQuestion(pizzaQuestions, { 'Which toppings should the demo pizza have?': 'Cheese, Ham', 'Which size should the demo pizza be?': 'Small' })).toBeNull();
    });

    it('returns null when an answer is missing or the input is malformed', () => {
        expect(keysForQuestion(pizzaQuestions, { 'Which toppings should the demo pizza have?': 'Cheese' })).toBeNull();
        expect(keysForQuestion({ questions: 'nope' }, {})).toBeNull();
        expect(keysForQuestion({ questions: [] }, {})).toBeNull();
    });

    it('returns null when a multi-select label contains a comma', () => {
        const input = { questions: [{ question: 'Q?', multiSelect: true, options: [{ label: 'a, b' }, { label: 'c' }] }] };
        expect(keysForQuestion(input, { 'Q?': 'a, b' })).toBeNull();
    });
});

describe('keysForPlan', () => {
    it('approves with "Yes, manually approve edits" for every mode', () => {
        expect(keysForPlan(true, 'default', undefined)).toEqual({ keys: [{ digit: 2 }] });
        expect(keysForPlan(true, 'acceptEdits', undefined)).toEqual({ keys: [{ digit: 2 }] });
        expect(keysForPlan(true, undefined, undefined)).toEqual({ keys: [{ digit: 2 }] });
    });

    it('rejects with feedback: 3, then the reason on one line, then Enter', () => {
        expect(keysForPlan(false, undefined, 'Please name the file\nhello.txt instead\x1b[2J')).toEqual({
            keys: [{ digit: 3 }],
            thenType: 'Please name the file hello.txt instead',
            thenPress: ['enter'],
        });
    });

    it('rejects without a reason with 3 and Enter', () => {
        expect(keysForPlan(false, 'default', undefined)).toEqual({ keys: [{ digit: 3 }, 'enter'] });
        expect(keysForPlan(false, 'default', '   ')).toEqual({ keys: [{ digit: 3 }, 'enter'] });
    });
});

describe('isInputBoxEmpty', () => {
    it('is true for the empty input box and false with typed text', () => {
        expect(isInputBoxEmpty(screen('input-empty'))).toBe(true);
        expect(isInputBoxEmpty(screen('input-typed'))).toBe(false);
    });

    it('is false while a dialog is open', () => {
        expect(isInputBoxEmpty(screen('permission-write'))).toBe(false);
        expect(isInputBoxEmpty(screen('question-single'))).toBe(false);
    });

    it('treats a dim suggestion as empty only when the capture keeps escape sequences', () => {
        expect(isInputBoxEmpty(screen('input-suggestion-and-survey'))).toBe(false);
        expect(isInputBoxEmpty(screen('input-suggestion-ansi'))).toBe(true);
    });
});
