import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PendingToolUse } from './transcript';
import {
    classifyScreen,
    dialogFingerprint,
    isInputBoxEmpty,
    keysForPermission,
    keysForPlan,
    keysForQuestion,
    readDialogFromScreen,
    readDialogProgress,
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

/**
 * The capture session's cwd after scrubbing. The scrub maps the scratch folder `<cwd>/<scratch>`
 * to `/Users/tester/project` and the dialogs show it as `project/…`, so the cwd is `/Users/tester`.
 */
const CWD = '/Users/tester';

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

/**
 * Hand-derived probe: plan mode draws `Planning: <path>` between two rules above the dialog's own
 * top rule. Turns a captured screen into the plan-mode one by inserting that block right above the
 * dialog's top rule (the first full-width rule at the line start that is followed by a header).
 */
function inPlanMode(text: string, topRuleAt: number): string {
    const lines = text.split('\n');
    const planning = ['Planning: /Users/tester/.claude/plans/demo-plan.md', FULL_RULE];
    lines.splice(topRuleAt + 1, 0, ...planning);
    return lines.join('\n');
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
        ['question-lone-multi-plan-mode', 'question'],
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
        expect(screenMatchesPending(numbered, pending('ExitPlanMode', { plan: '# Plan' }), CWD)).toBe(true);
    });

    it('tolerates trailing blank lines and spaces like a raw 40-row capture', () => {
        expect(classifyScreen(`${screen('permission-bash-short')}\n   \n\n`)).toBe('permission');
    });
});

describe('screenMatchesPending', () => {
    it('matches a Write by file name and rejects another file name', () => {
        expect(screenMatchesPending(screen('permission-write'), pending('Write', { file_path: '/Users/tester/project/report-draft.md', content: 'draft' }), CWD)).toBe(true);
        expect(screenMatchesPending(screen('permission-write'), pending('Write', { file_path: '/Users/tester/project/other.md', content: 'draft' }), CWD)).toBe(false);
    });

    it('takes the file name from the dialog question, not from elsewhere on the screen', () => {
        // A Write dialog that names greeting.txt somewhere other than its question line.
        const mentioned = screen('permission-write').replace('Create file', 'Create file (see greeting.txt)');
        expect(screenMatchesPending(mentioned, pending('Write', { file_path: '/Users/tester/project/greeting.txt' }), CWD)).toBe(false);
    });

    it('requires the Write dialog wording and the shown relative path to end the file path', () => {
        expect(screenMatchesPending(screen('permission-write'), pending('Write', { file_path: '/Users/tester/other/report-draft.md' }), CWD)).toBe(false);
        expect(screenMatchesPending(screen('permission-write'), pending('Write', { file_path: 'report-draft.md' }), CWD)).toBe(false);
        // Hand-derived from the captured create dialog with the overwrite wording seen while exploring.
        const overwrite = screen('permission-write').replace(' Create file', ' Overwrite file').replace('Do you want to create', 'Do you want to overwrite');
        expect(screenMatchesPending(overwrite, pending('Write', { file_path: '/Users/tester/project/report-draft.md' }), CWD)).toBe(true);
        const mixed = screen('permission-write').replace('Do you want to create', 'Do you want to overwrite');
        expect(screenMatchesPending(mixed, pending('Write', { file_path: '/Users/tester/project/report-draft.md' }), CWD)).toBe(false);
    });

    it('resolves the shown path against the session cwd, so a bare name at the cwd root matches only that file', () => {
        // Hand-made from the captured Edit dialog: a file at the cwd root is shown as its bare name.
        const root = screen('permission-edit').replace('\n project/edit-me.txt\n', '\n edit-me.txt\n');
        expect(root).not.toBe(screen('permission-edit'));
        const edit = (file_path: string, cwd: string = CWD): boolean => screenMatchesPending(root, pending('Edit', { file_path }), cwd);
        expect(edit('/Users/tester/edit-me.txt')).toBe(true);
        expect(edit('/Users/tester/project/packages/x/edit-me.txt')).toBe(false);
        expect(edit('/tmp/edit-me.txt')).toBe(false);
        expect(edit('/Users/tester/project/edit-me.txt')).toBe(false);
        expect(edit('/Users/tester/project/edit-me.txt', '/Users/tester/project')).toBe(true);
    });

    it('refuses a shown relative path under the wrong cwd, and any file dialog without an absolute cwd', () => {
        const write = pending('Write', { file_path: '/Users/tester/project/report-draft.md' });
        expect(screenMatchesPending(screen('permission-write'), write, '/Users/tester/project')).toBe(false);
        expect(screenMatchesPending(screen('permission-write'), write, '/Users/other')).toBe(false);
        expect(screenMatchesPending(screen('permission-write'), write, '')).toBe(false);
        expect(screenMatchesPending(screen('permission-write'), write, 'tester')).toBe(false);
        expect(screenMatchesPending(screen('permission-edit'), pending('Edit', { file_path: '/Users/tester/project/edit-me.txt' }), '')).toBe(false);
        expect(screenMatchesPending(screen('permission-read'), pending('Read', { file_path: '/Users/tester/project/edit-me.txt' }), '')).toBe(false);
    });

    it('resolves a ../ path outside the cwd and refuses a ~/ path', () => {
        // Hand-made from the captured create dialog with the `../` form seen while exploring.
        const outside = screen('permission-write').replace('\n project/report-draft.md\n', '\n ../notes/report-draft.md\n');
        expect(screenMatchesPending(outside, pending('Write', { file_path: '/Users/notes/report-draft.md' }), CWD)).toBe(true);
        expect(screenMatchesPending(outside, pending('Write', { file_path: '/Users/tester/notes/report-draft.md' }), CWD)).toBe(false);
        const home = screen('permission-write').replace('\n project/report-draft.md\n', '\n ~/project/report-draft.md\n');
        expect(screenMatchesPending(home, pending('Write', { file_path: '/Users/tester/project/report-draft.md' }), CWD)).toBe(false);
    });

    it('ignores cwd for Bash, questions and plans', () => {
        expect(screenMatchesPending(screen('permission-bash-short'), pending('Bash', { command: 'ls -la /Users/tester/project' }), '')).toBe(true);
        expect(screenMatchesPending(screen('question-single'), pending('AskUserQuestion', colorQuestion), '')).toBe(true);
        expect(screenMatchesPending(screen('plan'), pending('ExitPlanMode', { plan: '# Plan' }), '')).toBe(true);
    });

    it('matches Edit only on the captured Edit dialog and Read only on the captured Read dialog', () => {
        const file = '/Users/tester/project/edit-me.txt';
        expect(screenMatchesPending(screen('permission-edit'), pending('Edit', { file_path: file, old_string: 'alpha', new_string: 'beta' }), CWD)).toBe(true);
        expect(screenMatchesPending(screen('permission-edit'), pending('Edit', { file_path: '/Users/tester/elsewhere/edit-me.txt' }), CWD)).toBe(false);
        expect(screenMatchesPending(screen('permission-edit'), pending('Write', { file_path: file }), CWD)).toBe(false);
        expect(screenMatchesPending(screen('permission-write'), pending('Edit', { file_path: '/Users/tester/project/report-draft.md' }), CWD)).toBe(false);
        expect(screenMatchesPending(screen('permission-read'), pending('Read', { file_path: file }), CWD)).toBe(true);
        expect(screenMatchesPending(screen('permission-read'), pending('Read', { file_path: '/Users/tester/project/edit-me.txt.bak' }), CWD)).toBe(false);
        expect(screenMatchesPending(screen('permission-read'), pending('Edit', { file_path: file }), CWD)).toBe(false);
        expect(screenMatchesPending(screen('permission-write'), pending('Read', { file_path: '/Users/tester/project/report-draft.md' }), CWD)).toBe(false);
        expect(screenMatchesPending(screen('permission-edit'), pending('Read', { file_path: file }), CWD)).toBe(false);
    });

    it('matches a Bash call only when the command block shows the whole command', () => {
        expect(screenMatchesPending(screen('permission-bash'), pending('Bash', { command: bashCommand }), CWD)).toBe(true);
        expect(screenMatchesPending(screen('permission-bash-short'), pending('Bash', { command: 'ls -la /Users/tester/project' }), CWD)).toBe(true);
        expect(screenMatchesPending(screen('permission-bash-short'), pending('Bash', { command: 'rm -rf /Users/tester/project' }), CWD)).toBe(false);
        expect(screenMatchesPending(screen('permission-bash-short'), pending('Bash', { command: 'ls -la /Users/tester/project && rm -rf /' }), CWD)).toBe(false);
        expect(screenMatchesPending(screen('permission-bash-short'), pending('Bash', { command: 'ls -la' }), CWD)).toBe(false);
    });

    it('refuses a Bash dialog showing another command with the same long prefix (probe a)', () => {
        const status = withCommandBlock(screen('permission-bash-short'), [' cd /Users/tester/project/packages/happy-cli && git status']);
        expect(screenMatchesPending(status, pending('Bash', { command: 'cd /Users/tester/project/packages/happy-cli && git push --force origin main' }), CWD)).toBe(false);
        expect(screenMatchesPending(status, pending('Bash', { command: 'cd /Users/tester/project/packages/happy-cli && git status' }), CWD)).toBe(true);
    });

    it('reads the command block under a description that wraps to two lines', () => {
        // Hand-made from the captured long Bash dialog with its description wrapped onto a second line.
        const wrapped = screen('permission-bash').replace(
            ' Write test line to bash-out.txt and list the temp directory\n',
            ' Write test line to bash-out.txt and list the temp directory, then\n check that the listing shows it\n',
        );
        expect(wrapped).not.toBe(screen('permission-bash'));
        expect(screenMatchesPending(wrapped, pending('Bash', { command: bashCommand }), CWD)).toBe(true);
        // A separator-shaped line in the description gives three separators: refused.
        const extra = screen('permission-bash').replace(' Write test line to bash-out.txt and list the temp directory\n', ` x\n${SEPARATOR}\n echo hi\n`);
        expect(screenMatchesPending(extra, pending('Bash', { command: 'echo hi' }), CWD)).toBe(false);
        expect(screenMatchesPending(extra, pending('Bash', { command: bashCommand }), CWD)).toBe(false);
    });

    it('refuses a Bash dialog whose command block looks truncated', () => {
        const cut = withCommandBlock(screen('permission-bash-short'), [' ls -la /Users/tester/proj…']);
        expect(screenMatchesPending(cut, pending('Bash', { command: 'ls -la /Users/tester/project' }), CWD)).toBe(false);
        expect(screenMatchesPending(cut, pending('Bash', { command: 'ls -la /Users/tester/proj' }), CWD)).toBe(false);
    });

    it('refuses a Bash call against a Write dialog whose preview holds the command (probe b)', () => {
        const preview = withWritePreview([' ls -la /Users/tester/project']);
        expect(screenMatchesPending(preview, pending('Bash', { command: 'ls -la /Users/tester/project' }), CWD)).toBe(false);
    });

    it('ignores the command in the description line and in the conversation above the dialog (probes c, d)', () => {
        const described = withCommandBlock(screen('permission-bash-short'), [' echo hi'])
            .replace('List the temp directory contents', 'rm -rf /Users/tester/project');
        expect(screenMatchesPending(described, pending('Bash', { command: 'rm -rf /Users/tester/project' }), CWD)).toBe(false);
        // The conversation above already shows `$ ls -la /Users/tester/project`; add a whole fake dialog there too.
        const above = withCommandBlock(screen('permission-bash-short'), [' echo hi'])
            .replace('✻ Baked for 1s', `${FULL_RULE}\n Bash command\n List\n${SEPARATOR}\n ls -la /Users/tester/project\n${SEPARATOR}\n✻ Baked for 1s`);
        expect(classifyScreen(above)).toBe('permission');
        expect(screenMatchesPending(above, pending('Bash', { command: 'ls -la /Users/tester/project' }), CWD)).toBe(false);
        // The fake dialog's rule is drawn at column 0, like a real dialog's own rule. A whole fake
        // dialog above the real one cannot be told from a command that draws a rule and a fake
        // dialog inside the real dialog (the real header then sits above the lowest rule), so an
        // unindented full-width rule above a permission dialog refuses it, the real call included.
        // An indented rule (tool output, a command preview) does not; see the hardening tests.
        expect(screenMatchesPending(above, pending('Bash', { command: 'echo hi' }), CWD)).toBe(false);
        expect(screenMatchesPending(withCommandBlock(screen('permission-bash-short'), [' echo hi']), pending('Bash', { command: 'echo hi' }), CWD)).toBe(true);
    });

    it('works on a session with the user\'s hooks and two-line status line (no --safe-mode)', () => {
        expect(screenMatchesPending(screen('permission-bash-live'), pending('Bash', { command: 'ls -la /Users/tester/project' }), CWD)).toBe(true);
        expect(keysForPermission(false, screen('permission-bash-live'))).toEqual([{ digit: 2 }]);
        expect(isInputBoxEmpty(screen('input-empty-live'))).toBe(true);
    });

    it('matches other tools by the dialog header only, not by text in the preview', () => {
        expect(screenMatchesPending(screen('permission-bash'), pending('printf', {}), CWD)).toBe(false);
        expect(screenMatchesPending(screen('permission-bash'), pending('Bash command', {}), CWD)).toBe(true);
    });

    it('needs a non-empty tool name that is a whole word of the header', () => {
        expect(screenMatchesPending(screen('permission-write'), pending('', {}), CWD)).toBe(false);
        expect(screenMatchesPending(screen('permission-write'), pending('C', {}), CWD)).toBe(false);
        expect(screenMatchesPending(screen('permission-write'), pending('Creat', {}), CWD)).toBe(false);
        expect(screenMatchesPending(screen('permission-bash'), pending('Bash comm', {}), CWD)).toBe(false);
        expect(screenMatchesPending(screen('permission-bash'), pending('.*', {}), CWD)).toBe(false);
    });

    it('never matches a subagent dialog', () => {
        const subagentScreen = screen('permission-subagent');
        expect(screenMatchesPending(subagentScreen, pending('Task', { prompt: 'write sub-note.txt' }), CWD)).toBe(false);
        expect(screenMatchesPending(subagentScreen, pending('Agent', { prompt: 'write sub-note.txt' }), CWD)).toBe(false);
        expect(screenMatchesPending(subagentScreen, pending('Write', { file_path: '/Users/tester/project/sub-note.txt' }), CWD)).toBe(false);
    });

    it('never matches when the pending call is Task or Agent', () => {
        expect(screenMatchesPending(screen('permission-write'), pending('Task', { file_path: '/Users/tester/project/report-draft.md' }), CWD)).toBe(false);
    });

    it('matches an untouched question by its first question text only', () => {
        expect(screenMatchesPending(screen('question-single'), pending('AskUserQuestion', colorQuestion), CWD)).toBe(true);
        expect(screenMatchesPending(screen('question-multi'), pending('AskUserQuestion', pizzaQuestions), CWD)).toBe(true);
        expect(screenMatchesPending(screen('question-single'), pending('AskUserQuestion', pizzaQuestions), CWD)).toBe(false);
    });

    it('matches a question dialog drawn under the plan-mode Planning block', () => {
        const fruitsQuestion = {
            questions: [{
                question: 'Which fruits?',
                header: 'Fruits',
                multiSelect: true,
                options: [{ label: 'Apple', description: 'Apple' }, { label: 'Banana', description: 'Banana' }, { label: 'Cherry', description: 'Cherry' }],
            }],
        };
        expect(screenMatchesPending(screen('question-lone-multi-plan-mode'), pending('AskUserQuestion', fruitsQuestion), CWD)).toBe(true);
        expect(screenMatchesPending(screen('question-lone-multi-plan-mode'), pending('AskUserQuestion', daysQuestion), CWD)).toBe(false);
        const bash = inPlanMode(screen('permission-bash-short'), 25);
        expect(screenMatchesPending(bash, pending('Bash', { command: 'ls -la /Users/tester/project' }), CWD)).toBe(true);
    });

    it('matches the whole first question, not a prefix of it', () => {
        const longer = { questions: [{ ...colorQuestion.questions[0], question: 'Which color should the demo button use? Pick wisely' }] };
        expect(screenMatchesPending(screen('question-single'), pending('AskUserQuestion', longer), CWD)).toBe(false);
        const shorter = { questions: [{ ...colorQuestion.questions[0], question: 'Which color should the demo' }] };
        expect(screenMatchesPending(screen('question-single'), pending('AskUserQuestion', shorter), CWD)).toBe(false);
        expect(screenMatchesPending(screen('question-lone-multi'), pending('AskUserQuestion', daysQuestion), CWD)).toBe(true);
    });

    it('does not take a Write preview with question text and a question footer for a question', () => {
        const fake = withWritePreview([
            '←  ☐ Color  ✔ Submit  →',
            'Which color should the demo button use?',
            '❯ 1. Red',
            'Enter to select · ↑/↓ to navigate · Esc to cancel',
        ]);
        expect(classifyScreen(fake)).toBe('permission');
        expect(screenMatchesPending(fake, pending('AskUserQuestion', colorQuestion), CWD)).toBe(false);
    });

    it('refuses a question that was partly answered on the Mac', () => {
        expect(screenMatchesPending(screen('question-last-multi'), pending('AskUserQuestion', badgeQuestions), CWD)).toBe(false);
        expect(screenMatchesPending(screen('question-lone-multi-after-tab'), pending('AskUserQuestion', daysQuestion), CWD)).toBe(false);
        expect(screenMatchesPending(screen('question-multi-toggled'), pending('AskUserQuestion', pizzaQuestions), CWD)).toBe(false);
        expect(screenMatchesPending(screen('question-multi-second'), pending('AskUserQuestion', pizzaQuestions), CWD)).toBe(false);
        expect(screenMatchesPending(screen('question-review'), pending('AskUserQuestion', pizzaQuestions), CWD)).toBe(false);
    });

    it('matches an untouched plan dialog and refuses one with feedback typed', () => {
        expect(screenMatchesPending(screen('plan'), pending('ExitPlanMode', { plan: '# Plan' }), CWD)).toBe(true);
        expect(screenMatchesPending(screen('plan-feedback-typed'), pending('ExitPlanMode', { plan: '# Plan' }), CWD)).toBe(false);
    });

    it('does not match a dialog of another kind or the idle input box', () => {
        expect(screenMatchesPending(screen('plan'), pending('Write', { file_path: '/Users/tester/project/greeting.txt' }), CWD)).toBe(false);
        expect(screenMatchesPending(screen('permission-write'), pending('ExitPlanMode', {}), CWD)).toBe(false);
        expect(screenMatchesPending(screen('input-typed'), pending('Write', { file_path: '/Users/tester/project/report-draft.md' }), CWD)).toBe(false);
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

    it('answers the plan-mode lone multi-select question (Which fruits?) through the review screen', () => {
        const input = { questions: [{ question: 'Which fruits?', multiSelect: true, options: [{ label: 'Apple' }, { label: 'Banana' }, { label: 'Cherry' }] }] };
        expect(keysForQuestion(input, { 'Which fruits?': 'Apple, Cherry' })).toEqual([{ digit: 1 }, { digit: 3 }, 'tab', { digit: 1 }]);
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

/** The same screen as a `capture-pane -e` capture would give it: colour escapes around every line. */
function withColours(text: string): string {
    return text
        .split('\n')
        .map((line, index) => (line === '' ? line : `\x1b[38;5;${index % 250}m${line.replace(/(\d\.)/g, '\x1b[1m$1\x1b[22m')}\x1b[39m`))
        .join('\n');
}

/** Hand-derived probe: a captured Bash dialog whose command block draws a full-width rule and a fake dialog header. */
function stackedBashScreen(): string {
    return withCommandBlock(screen('permission-bash-short'), [
        "echo 'harmless'",
        FULL_RULE,
        ' Bash command',
        ' List the temp directory contents',
        SEPARATOR,
        'ls -la /Users/tester/project',
    ]);
}

describe('dialog hardening against a dialog drawn inside a command', () => {
    it('refuses a command block that draws a full-width rule and a fake Bash header', () => {
        const stacked = stackedBashScreen();
        expect(classifyScreen(stacked)).toBe('permission');
        expect(screenMatchesPending(stacked, pending('Bash', { command: 'ls -la /Users/tester/project' }), CWD)).toBe(false);
        expect(readDialogFromScreen(stacked)).toBeNull();
    });

    it('refuses a second known dialog header between the header and the ask line', () => {
        const command = 'Edit file\nls -la /Users/tester/project';
        const doubled = withCommandBlock(screen('permission-bash-short'), command.split('\n'));
        expect(screenMatchesPending(doubled, pending('Bash', { command }), CWD)).toBe(false);
        expect(readDialogFromScreen(doubled)).toBeNull();
    });

    it('ignores an indented full-width rule in tool output above a permission dialog', () => {
        // Hand-derived: tool output above the dialog that prints 40 `─`, indented like all output.
        const clean = screen('permission-bash-short');
        const indented = clean.replace('✻ Baked for 1s', `  ${'─'.repeat(40)}\n✻ Baked for 1s`);
        expect(indented).not.toBe(clean);
        expect(classifyScreen(indented)).toBe('permission');
        expect(screenMatchesPending(indented, pending('Bash', { command: 'ls -la /Users/tester/project' }), CWD)).toBe(true);
        expect(readDialogFromScreen(indented)).toEqual({ tool: 'Bash', input: { command: 'ls -la /Users/tester/project' } });
        expect(readDialogFromScreen(withColours(indented))).toEqual({ tool: 'Bash', input: { command: 'ls -la /Users/tester/project' } });
        // The fingerprint starts at the dialog's own (column-0) rule, so the indented rule and the
        // conversation between it and the dialog are not part of it.
        expect(dialogFingerprint(indented)).toBe(dialogFingerprint(clean));
    });

    it('refuses a column-0 full-width rule and a fake Bash header above a permission dialog', () => {
        // Hand-derived: an unindented rule and a fake header in the conversation above the real dialog.
        const above = screen('permission-bash-short').replace('✻ Baked for 1s', `${FULL_RULE}\n Bash command\n✻ Baked for 1s`);
        expect(classifyScreen(above)).toBe('permission');
        expect(screenMatchesPending(above, pending('Bash', { command: 'ls -la /Users/tester/project' }), CWD)).toBe(false);
        expect(readDialogFromScreen(above)).toBeNull();
    });

    it('refuses a question dialog with any full-width rule above it, indented or not', () => {
        // Hand-derived: the captured question with an indented rule in the conversation above.
        const indented = screen('question-single').replace('✻ Cooked for 8s', `  ${'─'.repeat(40)}\n✻ Cooked for 8s`);
        expect(indented).not.toBe(screen('question-single'));
        expect(classifyScreen(indented)).toBe('question');
        expect(screenMatchesPending(indented, pending('AskUserQuestion', colorQuestion), CWD)).toBe(false);
        expect(readDialogFromScreen(indented)).toBeNull();
    });

    it('still matches the captured dialogs', () => {
        expect(screenMatchesPending(screen('permission-bash-short'), pending('Bash', { command: 'ls -la /Users/tester/project' }), CWD)).toBe(true);
        expect(screenMatchesPending(screen('question-single'), pending('AskUserQuestion', colorQuestion), CWD)).toBe(true);
        expect(screenMatchesPending(screen('plan'), pending('ExitPlanMode', { plan: '# Plan' }), CWD)).toBe(true);
    });
});

describe('dialogFingerprint', () => {
    it('dialogFingerprint is stable across a redraw and differs between dialogs', () => {
        const write = dialogFingerprint(screen('permission-write'));
        expect(write).toMatch(/^[0-9a-f]{40}$/);
        expect(dialogFingerprint(withColours(screen('permission-write')))).toBe(write);
        expect(dialogFingerprint(`${screen('permission-write')}\n   \n\n`)).toBe(write);
        // The conversation above the dialog and the closing rule's session name are not part of it.
        const elsewhere = screen('permission-write').replace('Reply with just the word READY', 'Reply with just the word OK').replace(' demo-agent ', ' other-name ');
        expect(elsewhere).not.toBe(screen('permission-write'));
        expect(dialogFingerprint(elsewhere)).toBe(write);
        // Nor is the footer line, which changes with background agents.
        const footer = screen('permission-write').replace('Esc to cancel · Tab to amend', 'Esc to cancel · Tab to amend · ctrl+x ctrl+k twice to stop background agents');
        expect(dialogFingerprint(footer)).toBe(write);

        const names = ['permission-write', 'permission-bash', 'permission-bash-short', 'permission-edit', 'permission-read', 'question-single', 'question-multi', 'question-multi-toggled', 'plan', 'plan-feedback-typed'];
        const fingerprints = names.map((name) => dialogFingerprint(screen(name)));
        expect(fingerprints.every((value) => value !== null)).toBe(true);
        expect(new Set(fingerprints).size).toBe(fingerprints.length);
        expect(dialogFingerprint(screen('permission-write').replaceAll('report-draft.md', 'report-final.md'))).not.toBe(write);
    });

    it('does not depend on the plan-mode Planning block', () => {
        const plain = screen('permission-bash-short');
        expect(dialogFingerprint(inPlanMode(plain, 25))).toBe(dialogFingerprint(plain));
        expect(dialogFingerprint(screen('question-lone-multi-plan-mode'))).toMatch(/^[0-9a-f]{40}$/);
        const unplanned = screen('question-lone-multi-plan-mode').replace(/\n─+\nPlanning: [^\n]*\n(─+\n)/, '\n$1');
        expect(unplanned).not.toBe(screen('question-lone-multi-plan-mode'));
        expect(dialogFingerprint(screen('question-lone-multi-plan-mode'))).toBe(dialogFingerprint(unplanned));
    });

    it('does not change when the focus moves inside the same dialog', () => {
        // Hand-derived: the Mac user moved the cursor from option 1 to another option.
        const write = screen('permission-write');
        const writeMoved = write.replace(' ❯ 1. Yes', '   1. Yes').replace('   3. No', ' ❯ 3. No');
        expect(writeMoved).not.toBe(write);
        expect(dialogFingerprint(writeMoved)).toBe(dialogFingerprint(write));
        const question = screen('question-single');
        const questionMoved = question.replace('❯ 1. Red', '  1. Red').replace('  2. Green', '❯ 2. Green');
        expect(questionMoved).not.toBe(question);
        expect(dialogFingerprint(questionMoved)).toBe(dialogFingerprint(question));
        // Checkbox state is still part of it.
        expect(dialogFingerprint(screen('question-multi-toggled'))).not.toBe(dialogFingerprint(screen('question-multi')));
    });

    it('covers the plan body, so two plans with the same options differ', () => {
        const plan = dialogFingerprint(screen('plan'));
        expect(dialogFingerprint(screen('plan').replace('Plan: hello-world greeting.txt', 'Plan: delete everything'))).not.toBe(plan);
        expect(dialogFingerprint(withColours(screen('plan')))).toBe(plan);
    });

    it('is null without a dialog', () => {
        expect(dialogFingerprint(screen('input-empty'))).toBeNull();
        expect(dialogFingerprint(screen('input-suggestion-ansi'))).toBeNull();
        expect(dialogFingerprint('')).toBeNull();
    });
});

describe('readDialogFromScreen', () => {
    it.each([
        ['permission-bash-short', { tool: 'Bash', input: { command: 'ls -la /Users/tester/project' } }],
        ['permission-bash-live', { tool: 'Bash', input: { command: 'ls -la /Users/tester/project' } }],
        ['permission-bash', {
            tool: 'Bash',
            input: { command: "printf 'jarvis capture check with some padding text to make it long\\n' >\n/Users/tester/project/bash-out.txt && ls -la\n/Users/tester/project" },
        }],
        ['permission-write', { tool: 'Write', input: { file_path: 'project/report-draft.md' } }],
        ['permission-edit', { tool: 'Edit', input: { file_path: 'project/edit-me.txt' } }],
        ['permission-read', { tool: 'Read', input: { file_path: '/Users/tester/project/edit-me.txt' } }],
        ['question-single', {
            tool: 'AskUserQuestion',
            input: { questions: [{ question: 'Which color should the demo button use?', options: [{ label: 'Red' }, { label: 'Green' }, { label: 'Blue' }], multiSelect: false }] },
        }],
        ['question-lone-multi', {
            tool: 'AskUserQuestion',
            input: { questions: [{ question: 'Which days should the demo meeting use?', options: [{ label: 'Monday' }, { label: 'Wednesday' }, { label: 'Friday' }], multiSelect: true }] },
        }],
        ['question-lone-multi-plan-mode', {
            tool: 'AskUserQuestion',
            input: { questions: [{ question: 'Which fruits?', options: [{ label: 'Apple' }, { label: 'Banana' }, { label: 'Cherry' }], multiSelect: true }] },
        }],
        ['plan', { tool: 'ExitPlanMode', input: { plan: '' } }],
    ])('reads %s', (name, expected) => {
        expect(readDialogFromScreen(screen(name))).toEqual(expected);
        expect(readDialogFromScreen(withColours(screen(name)))).toEqual(expected);
    });

    it.each([
        'permission-subagent',
        'question-multi',
        'question-multi-toggled',
        'question-multi-second',
        'question-review',
        'question-other',
        'question-lone-multi-after-tab',
        'question-last-multi',
        'plan-feedback-typed',
        'input-empty',
        'input-typed',
    ])('cannot read %s', (name) => {
        expect(readDialogFromScreen(screen(name))).toBeNull();
    });

    it('reads a permission dialog under the plan-mode Planning block like the plain one', () => {
        const plain = screen('permission-bash-short');
        const planMode = inPlanMode(plain, 25);
        expect(planMode).not.toBe(plain);
        expect(classifyScreen(planMode)).toBe('permission');
        expect(readDialogFromScreen(planMode)).toEqual(readDialogFromScreen(plain));
        expect(readDialogFromScreen(planMode)).toEqual({ tool: 'Bash', input: { command: 'ls -la /Users/tester/project' } });
    });

    it('cannot read a truncated command, an unknown header or unknown wording', () => {
        expect(readDialogFromScreen(withCommandBlock(screen('permission-bash-short'), ['ls -la /Users/tester/proj…']))).toBeNull();
        expect(readDialogFromScreen(screen('permission-bash-short').replace('\n Bash command\n', '\n Fetch\n'))).toBeNull();
        expect(readDialogFromScreen(screen('permission-write').replace('Do you want to create report-draft.md?', 'Do you want to create other.md?'))).toBeNull();
        expect(readDialogFromScreen(screen('permission-bash-short').replace('Do you want to proceed?', 'Do you want to run this?'))).toBeNull();
    });
});

/** Hand-derived: the captured plan dialog with the focus moved to option 3 and nothing typed (not captured). */
function planFocusedOnFeedback(): string {
    const moved = screen('plan')
        .replace('   ❯ 1. Yes, and use auto mode', '     1. Yes, and use auto mode')
        .replace('     3. Tell Claude what to change', '   ❯ 3. Tell Claude what to change');
    expect(moved).not.toBe(screen('plan'));
    return moved;
}

describe('readDialogProgress', () => {
    it('keeps the question tab names across toggles, Tab and the review screen', () => {
        const names = ['question-multi', 'question-multi-toggled', 'question-multi-second', 'question-review'];
        const progress = names.map((name) => readDialogProgress(screen(name)));
        expect(progress.map((p) => p.kind)).toEqual(['question', 'question', 'question', 'question']);
        expect(new Set(progress.map((p) => p.tabs))).toEqual(new Set(['← Toppings Size ✔ Submit →']));
        expect(progress.map((p) => p.review)).toEqual([false, false, false, true]);
        expect(readDialogProgress(withColours(screen('question-review')))).toEqual(progress[3]);
        expect(readDialogProgress(screen('question-single')).tabs).toBe('Color');
    });

    it('sees the measured review screens', () => {
        for (const name of ['question-review', 'question-lone-multi-after-tab', 'question-last-multi-after-tab']) {
            expect(readDialogProgress(screen(name)).review).toBe(true);
        }
        for (const name of ['question-lone-multi', 'question-last-multi', 'question-single', 'question-other']) {
            expect(readDialogProgress(screen(name)).review).toBe(false);
        }
        expect(readDialogProgress(screen('question-lone-multi')).tabs).toBe(readDialogProgress(screen('question-lone-multi-after-tab')).tabs);
    });

    it('reads the plan feedback shown in a focused option 3 only', () => {
        expect(readDialogProgress(screen('plan'))).toEqual({ kind: 'plan', tabs: null, review: false, planFeedback: null });
        expect(readDialogProgress(screen('plan-feedback-typed')).planFeedback).toBe('Please name the file hello.txt instead');
        expect(readDialogProgress(withColours(screen('plan-feedback-typed'))).planFeedback).toBe('Please name the file hello.txt instead');
        expect(readDialogProgress(planFocusedOnFeedback()).planFeedback).toBe('Tell Claude what to change');
        // Without the hint line under option 3 the feedback cannot be told apart from other text.
        expect(readDialogProgress(screen('plan-feedback-typed').replace('shift+tab to approve with this feedback', '')).planFeedback).toBeNull();
    });

    it('has no tabs, review or feedback for other screens', () => {
        expect(readDialogProgress(screen('permission-write'))).toEqual({ kind: 'permission', tabs: null, review: false, planFeedback: null });
        expect(readDialogProgress(screen('input-empty'))).toEqual({ kind: 'none', tabs: null, review: false, planFeedback: null });
    });
});
