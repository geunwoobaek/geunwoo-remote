/**
 * Reads Claude Code dialogs off an attach screen and turns phone answers into key presses.
 *
 * The mirror presses keys inside a hidden `claude attach <id>` terminal only after checking from
 * the screen that the expected dialog is open (`classifyScreen`, gate ③) and that it is about the
 * pending tool call (`screenMatchesPending`, gate ④). Everything here was measured against real
 * Claude Code 2.1.319 screens (`__fixtures__/screens/`). Anything that does not look exactly like
 * a measured screen is treated as unknown so that no key is pressed: failing to answer is
 * acceptable, answering the wrong dialog is not.
 *
 * Measured behaviour the key maps rely on:
 * - Permission: options are numbered and a digit answers at once. The layout varies (`1. Yes /
 *   2. No` for an ask-rule Bash prompt, `1. Yes / 2. Yes, and … / 3. No` for a file write), so
 *   the digit is looked up on the screen by its label.
 * - Question: in a single-select question a digit picks and moves on; in a multi-select question
 *   digits toggle and Tab moves on. A lone single-select question submits on its digit; every
 *   other measured form (lone multi-select, multi then single, single then multi) ends on a review
 *   screen where `1` submits. Free text needs the cursor moved and typing
 *   mid-sequence, so it is not mapped.
 * - Plan: `1. Yes, and use auto mode / 2. Yes, manually approve edits / 3. Tell Claude what to
 *   change`. `3` focuses a feedback field; typed text and Enter reject with that feedback.
 * - Two digits sent in one burst are read as one number (`1`,`3` → "13"), so callers must press
 *   keys one at a time, `DIALOG_KEY_GAP_MS` apart.
 */

import type { AttachKey } from './attachTerminal';
import { sanitizeTypedText } from './attachTerminal';
import type { PendingToolUse } from './transcript';

export type DialogKind = 'none' | 'permission' | 'question' | 'plan' | 'unknown';

export type PlanKeys = {
    keys: AttachKey[];
    /** Text to type after `keys` (the rejection feedback). */
    thenType?: string;
    /** Keys to press after `thenType`. */
    thenPress?: AttachKey[];
};

/** Pause between two key presses. Consecutive digits sent together are merged into one number. */
export const DIALOG_KEY_GAP_MS = 600;

const SGR_OR_CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g;
const RULE = /^─{20,}$/;
const NAMED_RULE = /^─{3,} .+ ─$/;
const OPTION = /^(❯\s*)?(\d)\.\s+(.*)$/;
/** The dashed line above and below a dialog's preview or command block. */
const SEPARATOR = /^╌{10,}$/;
/** The question dialog's tab bar: `☐ Color`, `←  ☐ Toppings  ☐ Size  ✔ Submit  →`. */
const TAB_BAR = /^(?:←\s+)?[☐☒] \S/;
const ASK = /^Do you want to .+\?$/;
/** Measured file dialogs: header, the ask verb, and whether the path line sits under the header. */
const FILE_DIALOGS: Record<string, { header: string; ask: RegExp }[]> = {
    Write: [
        { header: 'Create file', ask: /^Do you want to create (.+)\?$/ },
        { header: 'Overwrite file', ask: /^Do you want to overwrite (.+)\?$/ },
    ],
    Edit: [{ header: 'Edit file', ask: /^Do you want to make this edit to (.+)\?$/ }],
};
const CHECKBOX = /^\[[ ✔]\]\s*/;
const SUBAGENT_HEADER = /· from the .+ agent/;
const PLAN_PROMPT = 'Claude has written up a plan and is ready to execute. Would you like to proceed?';
const PLAN_APPROVE_MANUAL = 'Yes, manually approve edits';
const PLAN_FEEDBACK = 'Tell Claude what to change';

type Option = { digit: number; label: string; focused: boolean };

type Dialog = {
    kind: DialogKind;
    options: Option[];
    /** The permission dialog's `Do you want to …?` line (the plan prompt for plans), else null. */
    ask: string | null;
};

type ParsedScreen = {
    lines: string[];
    /** Index range of the input box text lines, or null when no input box is drawn at the bottom. */
    input: { first: number; last: number } | null;
    /**
     * Trimmed lines of the dialog, from below its own top rule to above the closing named rule,
     * with trailing blank lines dropped. [] without a dialog.
     */
    region: string[];
};

function stripAnsi(text: string): string {
    return text.replace(OSC, '').replace(SGR_OR_CSI, '');
}

function isRule(line: string): boolean {
    const trimmed = line.trim();
    return RULE.test(trimmed) || NAMED_RULE.test(trimmed);
}

/**
 * The input box is a rule, a `❯` line (plus indented continuation lines), a plain rule, then at
 * most three status lines. While a dialog is open the box is not drawn and the screen ends with
 * the named rule instead.
 */
function findInputBox(lines: string[]): { first: number; last: number } | null {
    for (let bottom = lines.length - 1; bottom >= Math.max(1, lines.length - 4); bottom--) {
        if (!RULE.test(lines[bottom].trim())) {
            continue;
        }
        if (lines.slice(bottom + 1).some(isRule)) {
            return null;
        }
        let first = bottom - 1;
        while (first > 0 && lines[first].startsWith('  ') && !lines[first].trimStart().startsWith('❯')) {
            first--;
        }
        if (first <= 0 || !lines[first].startsWith('❯') || !isRule(lines[first - 1])) {
            return null;
        }
        return { first, last: bottom - 1 };
    }
    return null;
}

function parseScreen(screen: string): ParsedScreen {
    const lines = stripAnsi(screen).split('\n').map((line) => line.trimEnd());
    while (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
    }
    const input = findInputBox(lines);
    const endsWithRule = lines.length > 0 && isRule(lines[lines.length - 1]);
    const top = input === null && endsWithRule ? dialogTop(lines) : -1;
    const region = top >= 0 ? lines.slice(top + 1, -1).map((line) => line.trim()) : [];
    while (region.length > 0 && region[region.length - 1] === '') {
        region.pop();
    }
    return { lines, input, region };
}

/**
 * The dialog's own top rule: the lowest full-width rule above the closing rule that is not the
 * question dialog's inner rule (the one right above `N. Chat about this`). Rules higher up belong
 * to the conversation and are never part of the dialog.
 */
function dialogTop(lines: string[]): number {
    for (let index = lines.length - 2; index >= 0; index--) {
        if (RULE.test(lines[index].trim()) && !OPTION.test((lines[index + 1] ?? '').trim())) {
            return index;
        }
    }
    return -1;
}

function parseOptions(region: string[]): Option[] {
    return region.flatMap((line) => {
        const match = OPTION.exec(line);
        return match === null
            ? []
            : [{ digit: Number(match[2]), label: match[3].replace(CHECKBOX, '').trim(), focused: match[1] !== undefined }];
    });
}

/**
 * The dialog kind plus its answer options. Plan and permission options are read only below the
 * dialog's own question line, so numbered lines in a plan body, a file preview or a command
 * can never be taken for options.
 */
function analyse(parsed: ParsedScreen): Dialog {
    const { region } = parsed;
    const unknown: Dialog = { kind: parsed.input !== null ? 'none' : 'unknown', options: [], ask: null };
    if (parsed.input !== null || region.length === 0) {
        return unknown;
    }
    const planAt = region.lastIndexOf(PLAN_PROMPT);
    if (planAt >= 0) {
        const options = parseOptions(region.slice(planAt + 1));
        const option = (digit: number): Option | undefined => options.find((o) => o.digit === digit);
        const planShaped = option(1)?.label.startsWith('Yes, and ') === true && option(2)?.label === PLAN_APPROVE_MANUAL && option(3) !== undefined;
        return planShaped ? { kind: 'plan', options, ask: PLAN_PROMPT } : unknown;
    }
    const footer = region[region.length - 1];
    const questionOptions = parseOptions(region);
    const questionFooter = footer.startsWith('Enter to select') && footer.endsWith('Esc to cancel');
    if (TAB_BAR.test(region[0]) && ((questionFooter && questionOptions.length > 0) || region.includes('Ready to submit your answers?'))) {
        return { kind: 'question', options: questionOptions, ask: null };
    }
    const askAt = region.map((line) => ASK.test(line)).lastIndexOf(true);
    if (askAt < 0 || askAt < region.map((line) => SEPARATOR.test(line)).lastIndexOf(true) || !footer.startsWith('Esc to cancel')) {
        return unknown;
    }
    const options = parseOptions(region.slice(askAt + 1));
    return options[0]?.digit === 1 && options[0].label === 'Yes'
        ? { kind: 'permission', options, ask: region[askAt] }
        : unknown;
}

/** Which dialog the attach screen shows. `none` only when the empty or typed input box is visible. */
export function classifyScreen(screen: string): DialogKind {
    return analyse(parseScreen(screen)).kind;
}

function withoutWhitespace(text: string): string {
    return text.replace(/\s+/g, '');
}

/**
 * The lines between the first two separators, with the `│` border of a wrapped block removed.
 * Null unless the block sits right under the header and the optional description line.
 */
function previewBlock(region: string[]): string[] | null {
    const separators = region.flatMap((line, index) => (SEPARATOR.test(line) ? [index] : []));
    if (separators.length < 2 || separators[0] < 1 || separators[0] > 2 || separators[1] === separators[0] + 1) {
        return null;
    }
    return region.slice(separators[0] + 1, separators[1]).map((line) => line.replace(/^│\s?/, ''));
}

/** Both strings non-empty and equal once all whitespace is dropped (wrapped lines compare equal). */
function sameText(shown: string, expected: unknown): boolean {
    return typeof expected === 'string' && withoutWhitespace(expected).length > 0 && withoutWhitespace(shown) === withoutWhitespace(expected);
}

/**
 * Write/Edit: the measured header, a one-line relative path under it that the pending file path
 * ends with, the preview right below, and the ask line naming the same file.
 */
function fileDialogMatches(region: string[], ask: string | null, name: string, filePath: unknown): boolean {
    const path = region[1];
    if (typeof filePath !== 'string' || ask === null || path === undefined || path.length === 0 || !SEPARATOR.test(region[2] ?? '')) {
        return false;
    }
    const pathMatches = filePath === path || filePath.endsWith(`/${path}`);
    return pathMatches && (FILE_DIALOGS[name] ?? []).some((dialog) => region[0] === dialog.header && dialog.ask.exec(ask)?.[1] === path.split('/').at(-1));
}

/** The question text: the lines after the tab bar up to the first blank line below it. */
function questionText(region: string[]): string {
    const start = region.findIndex((line, index) => index > 0 && line !== '');
    const end = region.indexOf('', start);
    return start < 0 ? '' : region.slice(start, end < 0 ? undefined : end).join(' ');
}

function firstQuestion(input: Record<string, unknown>): unknown {
    const questions = input.questions;
    return Array.isArray(questions) && isRecord(questions[0]) ? questions[0].question : undefined;
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Gate ④: whether the open dialog is about `pending`, read only from the dialog's own lines
 * (never the conversation above it, a description line or a file preview):
 * - Bash: header `Bash command` and the command block equal to the whole command.
 * - Write/Edit: the measured header and ask wording, and the relative path under the header
 *   ending the pending file path. Read: header `Read file` and the block `Read(<file_path>)`.
 * - Questions: the question text right under the tab bar equal to the first question, untouched.
 * - Plans: untouched (option 1 focused). Other tools: the name as a whole word of the header.
 * Subagent dialogs and a pending `Task`/`Agent` call never match, because the tool being asked
 * about is not the one in the main transcript.
 */
export function screenMatchesPending(screen: string, pending: PendingToolUse): boolean {
    const parsed = parseScreen(screen);
    const { kind, options, ask } = analyse(parsed);
    const { region } = parsed;
    if (pending.name === 'Task' || pending.name === 'Agent' || region.some((line) => SUBAGENT_HEADER.test(line))) {
        return false;
    }
    switch (pending.name) {
        case 'Write':
        case 'Edit':
            return kind === 'permission' && fileDialogMatches(region, ask, pending.name, pending.input.file_path);
        case 'Read': {
            const block = previewBlock(region);
            const filePath = pending.input.file_path;
            return kind === 'permission' && region[0] === 'Read file' && block !== null && block.length === 1
                && typeof filePath === 'string' && filePath.length > 0 && block[0] === `Read(${filePath})`;
        }
        case 'Bash': {
            const block = previewBlock(region);
            return kind === 'permission' && region[0] === 'Bash command' && block !== null && sameText(block.join(''), pending.input.command);
        }
        case 'AskUserQuestion': {
            const pristine = !region.some((line) => line.includes('☒') || line.includes('[✔]'))
                && !region.includes('Ready to submit your answers?')
                && options.find((o) => o.focused)?.digit === 1;
            return kind === 'question' && pristine && sameText(questionText(region), firstQuestion(pending.input));
        }
        case 'ExitPlanMode':
            return kind === 'plan'
                && options.find((o) => o.focused)?.digit === 1
                && options.find((o) => o.digit === 3)?.label === PLAN_FEEDBACK;
        default:
            // Only the header right under the top rule (`Bash command`, `Create file`, …); the lines
            // below it are model-written descriptions and previews.
            return kind === 'permission' && pending.name.trim().length > 0
                && new RegExp(`(^|\\s)${escapeRegExp(pending.name)}(\\s|$)`).test(region[0]);
    }
}

/**
 * Keys that answer the open permission dialog: the digit of the option labelled exactly `Yes`
 * (approve) or `No` (deny). Null when the screen is not a permission dialog or has no such option.
 */
export function keysForPermission(approved: boolean, screen: string): AttachKey[] | null {
    const { kind, options } = analyse(parseScreen(screen));
    if (kind !== 'permission') {
        return null;
    }
    const target = approved ? 'Yes' : 'No';
    const matches = options.filter((option) => option.label === target);
    return matches.length === 1 ? [{ digit: matches[0].digit }] : null;
}

type Question = { question: string; multiSelect: boolean; labels: string[] };

function readQuestions(input: Record<string, unknown>): Question[] | null {
    const raw = input.questions;
    if (!Array.isArray(raw) || raw.length === 0) {
        return null;
    }
    const questions: Question[] = [];
    for (const item of raw) {
        if (!isRecord(item) || typeof item.question !== 'string' || !Array.isArray(item.options)) {
            return null;
        }
        const labels = item.options.map((option) => (isRecord(option) && typeof option.label === 'string' ? option.label : null));
        if (labels.length === 0 || labels.length > 8 || labels.some((label) => label === null) || new Set(labels).size !== labels.length) {
            return null;
        }
        questions.push({ question: item.question, multiSelect: item.multiSelect === true, labels: labels as string[] });
    }
    return questions;
}

/**
 * Keys that answer every question in order. `answers` maps question text to the chosen labels,
 * comma-joined (`"a, b"`) for multi-select, as the app sends them in `updatedInput.answers`.
 * Null when any answer is missing, is not one of the listed labels (free text included), or
 * cannot be split unambiguously.
 */
export function keysForQuestion(input: Record<string, unknown>, answers: Record<string, string>): AttachKey[] | null {
    const questions = readQuestions(input);
    if (questions === null) {
        return null;
    }
    const keys: AttachKey[] = [];
    for (const { question, multiSelect, labels } of questions) {
        const answer = answers[question];
        if (typeof answer !== 'string') {
            return null;
        }
        if (!multiSelect) {
            const index = labels.indexOf(answer);
            if (index < 0) {
                return null;
            }
            keys.push({ digit: index + 1 });
            continue;
        }
        if (labels.some((label) => label.includes(','))) {
            return null;
        }
        const chosen = answer.split(',').map((part) => part.trim());
        const indexes = chosen.map((label) => labels.indexOf(label));
        if (indexes.some((index) => index < 0) || new Set(indexes).size !== indexes.length) {
            return null;
        }
        keys.push(...indexes.sort((a, b) => a - b).map((index) => ({ digit: index + 1 })), 'tab');
    }
    const loneSingleSelect = questions.length === 1 && !questions[0].multiSelect;
    return loneSingleSelect ? keys : [...keys, { digit: 1 }];
}

/**
 * Keys for the plan approval dialog. Approval always picks "Yes, manually approve edits": the
 * dialog has no accept-edits option, and its other approval ("auto mode") allows more than any
 * mode the app sends, so every `mode` gets the manual option. Rejection picks "Tell Claude what to
 * change", types the reason as one line and submits it.
 */
export function keysForPlan(approved: boolean, mode: string | undefined, reason: string | undefined): PlanKeys {
    void mode;
    if (approved) {
        return { keys: [{ digit: 2 }] };
    }
    const feedback = sanitizeTypedText(reason ?? '').replace(/\s+/g, ' ').trim();
    return feedback.length > 0
        ? { keys: [{ digit: 3 }], thenType: feedback, thenPress: ['enter'] }
        : { keys: [{ digit: 3 }, 'enter'] };
}

/**
 * True when the input box is drawn and holds no text. A screen captured with escape sequences
 * (`capture-pane -e`) counts dim text, which is Claude Code's suggestion placeholder, as empty; on
 * a plain capture a suggestion cannot be told from typed text, so it counts as not empty.
 */
export function isInputBoxEmpty(screen: string): boolean {
    const parsed = parseScreen(screen);
    if (parsed.input === null) {
        return false;
    }
    const rawLines = screen.split('\n');
    for (let index = parsed.input.first; index <= parsed.input.last; index++) {
        if (visibleUndimmedText(rawLines[index] ?? '').replace(/^❯/, '').trim().length > 0) {
            return false;
        }
    }
    return true;
}

/** The characters of a raw captured line that are not drawn dim (SGR 2). */
function visibleUndimmedText(rawLine: string): string {
    let dim = false;
    let text = '';
    let rest = rawLine.replace(OSC, '');
    while (rest.length > 0) {
        const sgr = /^\x1b\[([0-9;]*)m/.exec(rest);
        if (sgr !== null) {
            for (const code of (sgr[1] === '' ? '0' : sgr[1]).split(';')) {
                if (code === '2') {
                    dim = true;
                } else if (code === '0' || code === '22') {
                    dim = false;
                }
            }
            rest = rest.slice(sgr[0].length);
            continue;
        }
        const other = /^\x1b\[[0-?]*[ -/]*[@-~]/.exec(rest);
        if (other !== null) {
            rest = rest.slice(other[0].length);
            continue;
        }
        if (!dim) {
            text += rest[0];
        }
        rest = rest.slice(1);
    }
    return text;
}
