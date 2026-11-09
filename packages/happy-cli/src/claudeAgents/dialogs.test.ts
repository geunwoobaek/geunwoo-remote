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

const daysQuestion = {
    questions: [
        {
            question: 'Which days should the demo meeting use?',
            header: 'Days',
            multiSelect: true,
            options: [{ label: 'Monday' }, { label: 'Wednesday' }, { label: 'Friday' }],
        },
    ],
};

const badgeQuestions = {
    questions: [
        {
            question: 'Which shape should the demo badge be?',
            header: 'Shape',
            multiSelect: false,
            options: [{ label: 'Circle' }, { label: 'Square' }, { label: 'Star' }],
        },
        {
            question: 'Which effects should the demo badge get?',
            header: 'Effects',
            multiSelect: true,
            options: [{ label: 'Shadow' }, { label: 'Outline' }, { label: 'Glow' }],
        },
    ],
};

const SEPARATOR = '╌'.repeat(120);
const FULL_RULE = '─'.repeat(120);

/** Hand-derived probe: a captured Bash dialog with its command block replaced by `lines`. */
function withCommandBlock(text: string, lines: string[]): string {
    const replaced = text.replace(/(\n Bash command\n.*\n╌+\n)[\s\S]*?(\n╌+\n)/, `$1${lines.join('\n')}$2`);
    expect(replaced).not.toBe(text);
    return replaced;
}

/** Hand-derived probe: the captured Write dialog with its file preview replaced by `lines`. */
function withWritePreview(lines: string[]): string {
    const replaced = screen('permission-write').replace('\n  1 draft\n', `\n${lines.join('\n')}\n`);
    expect(replaced).not.toBe(screen('permission-write'));
    return replaced;
}

const bashCommand = "printf 'jarvis capture check with some padding text to make it long\\n' > /Users/tester/project/bash-out.txt && ls -la /Users/tester/project";

describe('classifyScreen', () => {
    it.each([
        ['permission-write', 'permission'],
        ['permission-bash', 'permission'],
        ['permission-bash-short', 'permission'],
        ['permission-subagent', 'permission'],
        ['permission-bash-live', 'permission'],
        ['permission-read', 'permission'],
        ['permission-edit', 'permission'],
        ['question-single', 'question'],
        ['question-multi', 'question'],
        ['question-multi-toggled', 'question'],
        ['question-multi-second', 'question'],
        ['question-review', 'question'],
        ['question-other', 'question'],
        ['question-lone-multi', 'question'],
        ['question-lone-multi-after-tab', 'question'],
        ['question-last-multi', 'question'],
        ['question-last-multi-after-tab', 'question'],
        ['plan', 'plan'],
        ['plan-feedback-typed', 'plan'],
        ['after-plan-approve', 'permission'],
        ['plan-after-empty-reject', 'none'],
        ['input-empty', 'none'],
        ['input-typed', 'none'],
        ['input-suggestion-and-survey', 'none'],
        ['input-empty-live', 'none'],
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

    it('requires the Write dialog wording and the shown relative path to end the file path', () => {
        expect(screenMatchesPending(screen('permission-write'), pending('Write', { file_path: '/Users/tester/other/report-draft.md' }))).toBe(false);
        expect(screenMatchesPending(screen('permission-write'), pending('Write', { file_path: 'report-draft.md' }))).toBe(false);
        // Hand-derived from the captured create dialog with the overwrite wording seen while exploring.
        const overwrite = screen('permission-write').replace(' Create file', ' Overwrite file').replace('Do you want to create', 'Do you want to overwrite');
        expect(screenMatchesPending(overwrite, pending('Write', { file_path: '/Users/tester/project/report-draft.md' }))).toBe(true);
        const mixed = screen('permission-write').replace('Do you want to create', 'Do you want to overwrite');
        expect(screenMatchesPending(mixed, pending('Write', { file_path: '/Users/tester/project/report-draft.md' }))).toBe(false);
    });

    it('matches Edit only on the captured Edit dialog and Read only on the captured Read dialog', () => {
        const file = '/Users/tester/project/edit-me.txt';
        expect(screenMatchesPending(screen('permission-edit'), pending('Edit', { file_path: file, old_string: 'alpha', new_string: 'beta' }))).toBe(true);
        expect(screenMatchesPending(screen('permission-edit'), pending('Edit', { file_path: '/Users/tester/elsewhere/edit-me.txt' }))).toBe(false);
        expect(screenMatchesPending(screen('permission-edit'), pending('Write', { file_path: file }))).toBe(false);
        expect(screenMatchesPending(screen('permission-write'), pending('Edit', { file_path: '/Users/tester/project/report-draft.md' }))).toBe(false);
        expect(screenMatchesPending(screen('permission-read'), pending('Read', { file_path: file }))).toBe(true);
        expect(screenMatchesPending(screen('permission-read'), pending('Read', { file_path: '/Users/tester/project/edit-me.txt.bak' }))).toBe(false);
        expect(screenMatchesPending(screen('permission-read'), pending('Edit', { file_path: file }))).toBe(false);
        expect(screenMatchesPending(screen('permission-write'), pending('Read', { file_path: '/Users/tester/project/report-draft.md' }))).toBe(false);
        expect(screenMatchesPending(screen('permission-edit'), pending('Read', { file_path: file }))).toBe(false);
    });

    it('matches a Bash call only when the command block shows the whole command', () => {
        expect(screenMatchesPending(screen('permission-bash'), pending('Bash', { command: bashCommand }))).toBe(true);
        expect(screenMatchesPending(screen('permission-bash-short'), pending('Bash', { command: 'ls -la /Users/tester/project' }))).toBe(true);
        expect(screenMatchesPending(screen('permission-bash-short'), pending('Bash', { command: 'rm -rf /Users/tester/project' }))).toBe(false);
        expect(screenMatchesPending(screen('permission-bash-short'), pending('Bash', { command: 'ls -la /Users/tester/project && rm -rf /' }))).toBe(false);
        expect(screenMatchesPending(screen('permission-bash-short'), pending('Bash', { command: 'ls -la' }))).toBe(false);
    });

    it('refuses a Bash dialog showing another command with the same long prefix (probe a)', () => {
        const status = withCommandBlock(screen('permission-bash-short'), [' cd /Users/tester/project/packages/happy-cli && git status']);
        expect(screenMatchesPending(status, pending('Bash', { command: 'cd /Users/tester/project/packages/happy-cli && git push --force origin main' }))).toBe(false);
        expect(screenMatchesPending(status, pending('Bash', { command: 'cd /Users/tester/project/packages/happy-cli && git status' }))).toBe(true);
    });

    it('refuses a Bash dialog whose command block looks truncated', () => {
        const cut = withCommandBlock(screen('permission-bash-short'), [' ls -la /Users/tester/proj…']);
        expect(screenMatchesPending(cut, pending('Bash', { command: 'ls -la /Users/tester/project' }))).toBe(false);
        expect(screenMatchesPending(cut, pending('Bash', { command: 'ls -la /Users/tester/proj' }))).toBe(false);
    });

    it('refuses a Bash call against a Write dialog whose preview holds the command (probe b)', () => {
        const preview = withWritePreview([' ls -la /Users/tester/project']);
        expect(screenMatchesPending(preview, pending('Bash', { command: 'ls -la /Users/tester/project' }))).toBe(false);
    });

    it('ignores the command in the description line and in the conversation above the dialog (probes c, d)', () => {
        const described = withCommandBlock(screen('permission-bash-short'), [' echo hi'])
            .replace('List the temp directory contents', 'rm -rf /Users/tester/project');
        expect(screenMatchesPending(described, pending('Bash', { command: 'rm -rf /Users/tester/project' }))).toBe(false);
        // The conversation above already shows `$ ls -la /Users/tester/project`; add a whole fake dialog there too.
        const above = withCommandBlock(screen('permission-bash-short'), [' echo hi'])
            .replace('✻ Baked for 1s', `${FULL_RULE}\n Bash command\n List\n${SEPARATOR}\n ls -la /Users/tester/project\n${SEPARATOR}\n✻ Baked for 1s`);
        expect(classifyScreen(above)).toBe('permission');
        expect(screenMatchesPending(above, pending('Bash', { command: 'ls -la /Users/tester/project' }))).toBe(false);
        expect(screenMatchesPending(above, pending('Bash', { command: 'echo hi' }))).toBe(true);
    });

    it('works on a session with the user\'s hooks and two-line status line (no --safe-mode)', () => {
        expect(screenMatchesPending(screen('permission-bash-live'), pending('Bash', { command: 'ls -la /Users/tester/project' }))).toBe(true);
        expect(keysForPermission(false, screen('permission-bash-live'))).toEqual([{ digit: 2 }]);
        expect(isInputBoxEmpty(screen('input-empty-live'))).toBe(true);
    });

    it('matches other tools by the dialog header only, not by text in the preview', () => {
        expect(screenMatchesPending(screen('permission-bash'), pending('printf', {}))).toBe(false);
        expect(screenMatchesPending(screen('permission-bash'), pending('Bash command', {}))).toBe(true);
    });

    it('needs a non-empty tool name that is a whole word of the header', () => {
        expect(screenMatchesPending(screen('permission-write'), pending('', {}))).toBe(false);
        expect(screenMatchesPending(screen('permission-write'), pending('C', {}))).toBe(false);
        expect(screenMatchesPending(screen('permission-write'), pending('Creat', {}))).toBe(false);
        expect(screenMatchesPending(screen('permission-bash'), pending('Bash comm', {}))).toBe(false);
        expect(screenMatchesPending(screen('permission-bash'), pending('.*', {}))).toBe(false);
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

    it('matches the whole first question, not a prefix of it', () => {
        const longer = { questions: [{ ...colorQuestion.questions[0], question: 'Which color should the demo button use? Pick wisely' }] };
        expect(screenMatchesPending(screen('question-single'), pending('AskUserQuestion', longer))).toBe(false);
        const shorter = { questions: [{ ...colorQuestion.questions[0], question: 'Which color should the demo' }] };
        expect(screenMatchesPending(screen('question-single'), pending('AskUserQuestion', shorter))).toBe(false);
        expect(screenMatchesPending(screen('question-lone-multi'), pending('AskUserQuestion', daysQuestion))).toBe(true);
    });

    it('does not take a Write preview with question text and a question footer for a question', () => {
        const fake = withWritePreview([
            '←  ☐ Color  ✔ Submit  →',
            'Which color should the demo button use?',
            '❯ 1. Red',
            'Enter to select · ↑/↓ to navigate · Esc to cancel',
        ]);
        expect(classifyScreen(fake)).toBe('permission');
        expect(screenMatchesPending(fake, pending('AskUserQuestion', colorQuestion))).toBe(false);
    });

    it('refuses a question that was partly answered on the Mac', () => {
        expect(screenMatchesPending(screen('question-last-multi'), pending('AskUserQuestion', badgeQuestions))).toBe(false);
        expect(screenMatchesPending(screen('question-lone-multi-after-tab'), pending('AskUserQuestion', daysQuestion))).toBe(false);
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

    it('presses 3 for No on the Read and Edit dialogs', () => {
        expect(keysForPermission(true, screen('permission-read'))).toEqual([{ digit: 1 }]);
        expect(keysForPermission(false, screen('permission-read'))).toEqual([{ digit: 3 }]);
        expect(keysForPermission(false, screen('permission-edit'))).toEqual([{ digit: 3 }]);
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

    it('submits a lone multi-select question through the review screen (measured: 1, 3, Tab, 1)', () => {
        expect(keysForQuestion(daysQuestion, { 'Which days should the demo meeting use?': 'Monday, Friday' })).toEqual([{ digit: 1 }, { digit: 3 }, 'tab', { digit: 1 }]);
        expect(keysForQuestion(extrasQuestion, { 'Which extras should the demo logo get?': 'Outline' })).toEqual([{ digit: 2 }, 'tab', { digit: 1 }]);
    });

    it('ends on a multi-select question last of several with toggles, Tab, 1 (measured: 3, 1, 2, Tab, 1)', () => {
        const answers = { 'Which shape should the demo badge be?': 'Star', 'Which effects should the demo badge get?': 'Shadow, Outline' };
        expect(keysForQuestion(badgeQuestions, answers)).toEqual([{ digit: 3 }, { digit: 1 }, { digit: 2 }, 'tab', { digit: 1 }]);
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
