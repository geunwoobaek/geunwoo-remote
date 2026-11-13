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

import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
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
/** `NAMED_RULE` with the session name captured. */
const RULE_NAME = /^─{3,} (.+) ─$/;
/** Hangul, CJK and full-width forms: two terminal cells each. */
const WIDE_CHAR = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;
/** A terminal size read off a screen outside these bounds is not trusted. */
const SCREEN_COLS = { min: 40, max: 500 };
const SCREEN_ROWS = { min: 10, max: 300 };
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
/** Plan option 3's label, and what it shows while focused with nothing typed. */
export const PLAN_FEEDBACK = 'Tell Claude what to change';
/** The ask line of the measured Bash and Read dialogs. */
const PROCEED = 'Do you want to proceed?';
/** Headers a measured permission dialog starts with. A second one inside a dialog means a dialog drawn inside it. */
const KNOWN_HEADERS = ['Bash command', 'Create file', 'Overwrite file', 'Edit file', 'Read file'];
/** A dialog's last line of key hints. It changes on its own (e.g. with the number of background agents). */
const FOOTER = /^(?:Esc to cancel|Enter to select|ctrl\+g to edit)/;
/** What changes with the terminal width in a dialog's text: whitespace and the rule, dashed separator and box drawing characters. */
const WIDTH_DEPENDENT = /[\s─━│┃╭╮╰╯┌┐└┘├┤┬┴┼╌┄┈╍┅┉═]/g;
/** The single-question tab bars: `☐ Color` (lone single-select) and `←  ☐ Days  ✔ Submit  →` (lone multi-select). */
const SINGLE_QUESTION_TAB_BAR = /^(?:☐ [^☐☒✔]+|←\s+☐ [^☐☒✔]+✔ Submit\s+→)$/;
const TYPE_SOMETHING = /^(?:\[ \]\s*)?Type something\.?$/;

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
    /** Index in `lines` of the dialog's own top rule, or -1 without a dialog. */
    top: number;
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

/** Plan mode's `Planning: <plan file>` line, drawn between two full-width rules above a dialog. */
const PLANNING = /^Planning: \S/;

function parseScreen(screen: string): ParsedScreen {
    const drawn = stripAnsi(screen).split('\n').map((line) => line.trimEnd());
    while (drawn.length > 0 && drawn[drawn.length - 1] === '') {
        drawn.pop();
    }
    const input = findInputBox(drawn);
    const endsWithRule = drawn.length > 0 && isRule(drawn[drawn.length - 1]);
    const lines = input === null && endsWithRule ? withoutPlanningBlock(drawn) : drawn;
    const top = input === null && endsWithRule ? dialogTop(lines) : -1;
    const region = top >= 0 ? lines.slice(top + 1, -1).map((line) => line.trim()) : [];
    while (region.length > 0 && region[region.length - 1] === '') {
        region.pop();
    }
    return { lines, input, region, top };
}

/**
 * In plan mode Claude Code draws `rule / Planning: <path> / rule` between the conversation and the
 * dialog's header. That block is not part of the dialog: it is dropped together with the lower of
 * its two rules, which leaves the single top rule a dialog has otherwise. Only a block sitting
 * right on the dialog's own top rule (both rules at column 0) is dropped; a look-alike higher up
 * stays conversation.
 */
function withoutPlanningBlock(lines: string[]): string[] {
    const top = dialogTop(lines);
    const planning = top - 1;
    if (top < 2 || !RULE.test(lines[top]) || !PLANNING.test(lines[planning]) || !RULE.test(lines[planning - 1])) {
        return lines;
    }
    return [...lines.slice(0, planning), ...lines.slice(top + 1)];
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

/**
 * The session name in the rule Claude Code draws for the attached session: the rule right above
 * the `❯` input box, or the closing rule of an open dialog (`─── demo-agent ─`). Only those two
 * places count, so a look-alike line in the conversation is never read. Null when neither is drawn
 * or the rule carries no name (an unnamed session, the agents list, a screen this does not know).
 * A long name may be cut short with a trailing `…`.
 */
export function screenSessionName(screen: string): string | null {
    const { lines, input } = parseScreen(screen);
    const rule = input !== null ? lines[input.first - 1] : lines[lines.length - 1];
    const name = (rule === undefined ? null : RULE_NAME.exec(rule.trim()))?.[1].trim() ?? '';
    return name.length > 0 ? name : null;
}

/**
 * The terminal size a screen was drawn at: rows = its line count, columns = the widest drawn rule
 * (a rule spans the whole width; East Asian wide characters in a session name count two). Null
 * when no rule is drawn or the size is outside sane bounds.
 */
export function screenSize(screen: string): { cols: number; rows: number } | null {
    const lines = stripAnsi(screen).split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
    }
    const cols = Math.max(0, ...lines.map((line) => line.trimEnd()).filter(isRule).map(cellWidth));
    const rows = lines.length;
    const sane = cols >= SCREEN_COLS.min && cols <= SCREEN_COLS.max && rows >= SCREEN_ROWS.min && rows <= SCREEN_ROWS.max;
    return sane ? { cols, rows } : null;
}

/** Terminal cells taken by `text`: two for an East Asian wide character, one otherwise. */
function cellWidth(text: string): number {
    let width = 0;
    for (const char of text) {
        width += WIDE_CHAR.test(char) ? 2 : 1;
    }
    return width;
}

function withoutWhitespace(text: string): string {
    return text.replace(/\s+/g, '');
}

/**
 * The lines between the dialog's two separators, with the `│` border of a wrapped block removed.
 * Null unless the region has exactly two separators below the header (the description above the
 * block may wrap over several lines) with at least one line between them.
 */
function previewBlock(region: string[]): string[] | null {
    const separators = region.flatMap((line, index) => (SEPARATOR.test(line) ? [index] : []));
    if (separators.length !== 2 || separators[0] < 1 || separators[1] === separators[0] + 1) {
        return null;
    }
    return region.slice(separators[0] + 1, separators[1]).map((line) => line.replace(/^│\s?/, ''));
}

/** Both strings non-empty and equal once all whitespace is dropped (wrapped lines compare equal). */
function sameText(shown: string, expected: unknown): boolean {
    return typeof expected === 'string' && withoutWhitespace(expected).length > 0 && withoutWhitespace(shown) === withoutWhitespace(expected);
}

/**
 * Whether the path shown in a dialog is `filePath`. Claude Code shows paths relative to the
 * session's cwd (a file at the cwd root as its bare name, `../x` outside it) or absolute, so the
 * shown path is resolved against `cwd` and compared exactly. A `~/` path was never seen in a file
 * dialog and is refused, as is any comparison without an absolute cwd.
 */
function isShownPath(shown: string, filePath: unknown, cwd: string): boolean {
    return typeof filePath === 'string' && shown.length > 0 && !shown.startsWith('~') && isAbsolute(cwd)
        && filePath === resolve(cwd, shown);
}

/**
 * Write/Edit: the measured header, a one-line path under it that resolves to the pending file
 * path, the preview right below, and the ask line naming the same file.
 */
function fileDialogMatches(region: string[], ask: string | null, name: string, filePath: unknown, cwd: string): boolean {
    const path = region[1];
    if (ask === null || path === undefined || !SEPARATOR.test(region[2] ?? '') || !isShownPath(path, filePath, cwd)) {
        return false;
    }
    return (FILE_DIALOGS[name] ?? []).some((dialog) => region[0] === dialog.header && dialog.ask.exec(ask)?.[1] === path.split('/').at(-1));
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

function isKnownHeader(line: string): boolean {
    return KNOWN_HEADERS.includes(line.replace(SUBAGENT_HEADER, '').trim()) || TAB_BAR.test(line);
}

/**
 * Whether `line` (ANSI stripped, not trimmed) counts as a dialog's own rule when looking above a
 * dialog. Permission dialogs draw their rules at column 0 while commands, previews, tool output and
 * conversation lines are indented or glyph-led, so only an unindented rule counts. Question text is
 * model-written and drawn at column 0, and the plan box is indented, so for those any full-width
 * rule counts.
 */
function isStructuralRule(line: string, kind: DialogKind): boolean {
    return kind === 'permission' ? RULE.test(line) : RULE.test(line.trim());
}

/**
 * Whether a permission or question dialog may be drawn inside another one. `dialogTop` takes the
 * lowest full-width rule, so a command or preview that prints such a rule and a fake header would
 * otherwise become "the dialog" and its fake block would be checked instead of the real one.
 * Measured permission and question screens have no structural rule above their top rule and no
 * second dialog header before their ask line, so either one means the screen cannot be trusted.
 * An indented rule in tool output above a permission dialog is not structural and is ignored.
 */
function looksStacked(parsed: ParsedScreen, kind: DialogKind, ask: string | null): boolean {
    const end = ask === null ? parsed.region.length : parsed.region.lastIndexOf(ask);
    return parsed.lines.slice(0, parsed.top).some((line) => isStructuralRule(line, kind))
        || parsed.region.slice(1, end).some(isKnownHeader);
}

/**
 * The identity of the open dialog: the sha1 of its lines from the topmost structural rule
 * (`isStructuralRule`) down to (not including) the closing named rule, with escapes stripped,
 * the `❯` focus marker, blank lines and the key-hint footer dropped, then every whitespace and
 * rule, dashed separator and box drawing character removed (the terminal width moves line breaks, so a dialog read in a
 * 99-column cmux pane and in a 120-column tmux must match). The
 * conversation above, the session name in the closing rule, the footer and the focus are left out
 * so a redraw of the same dialog, or the Mac user moving the cursor in it, gives the same value
 * (answers press absolute digits, and the question and plan gates check focus themselves).
 * Starting at the topmost rule keeps a plan's body (inside the "Ready to code?" box, above the
 * inner rule) and anything a rule inside a command could hide; when a long plan has pushed its box
 * top off the screen, the whole screen above is used. Null when no dialog is open.
 */
export function dialogFingerprint(screen: string): string | null {
    const parsed = parseScreen(screen);
    if (parsed.top < 0 || parsed.region.length === 0) {
        return null;
    }
    const kind = analyse(parsed).kind;
    const firstRule = parsed.lines.findIndex((line) => isStructuralRule(line, kind));
    const start = kind === 'plan' && firstRule === parsed.top ? 0 : firstRule + 1;
    const body = parsed.lines
        .slice(start, -1)
        .map((line) => line.replace(/\s+/g, ' ').trim().replace(/^❯ ?/, ''))
        .filter((line) => line.length > 0);
    if (body.length > 0 && FOOTER.test(body[body.length - 1])) {
        body.pop();
    }
    // Whitespace and line-drawing characters go too: a narrower terminal wraps the same text at
    // other places (and the question box redraws its `│` margin on every wrapped line).
    return createHash('sha1').update(body.join('').replace(WIDTH_DEPENDENT, '')).digest('hex');
}

export type ScreenDialog = { tool: string; input: Record<string, unknown> };

/**
 * Bash: the command block exactly as shown (wrapped lines joined with `\n`, since a wrap cannot be
 * told from a newline in the command). Write/Edit: the path under the header as shown (relative
 * to the session cwd) when the ask line names the same file. Read: the `Read(<path>)` argument.
 */
function readPermission(region: string[], ask: string | null): ScreenDialog | null {
    const header = region[0];
    if (header === 'Bash command' || header === 'Read file') {
        const block = previewBlock(region)?.map((line) => line.trim());
        if (ask !== PROCEED || block === undefined || block.some((line) => line.length === 0 || line.endsWith('…'))) {
            return null;
        }
        if (header === 'Bash command') {
            return { tool: 'Bash', input: { command: block.join('\n') } };
        }
        const path = block.length === 1 ? /^Read\((.+)\)$/.exec(block[0])?.[1] : undefined;
        return path === undefined ? null : { tool: 'Read', input: { file_path: path } };
    }
    const path = region[1];
    const tool = Object.keys(FILE_DIALOGS).find((name) => FILE_DIALOGS[name].some((dialog) => dialog.header === header));
    const named = tool === undefined || ask === null || path === undefined
        ? false
        : FILE_DIALOGS[tool].some((dialog) => dialog.header === header && dialog.ask.exec(ask)?.[1] === path.split('/').at(-1));
    return tool !== undefined && named && SEPARATOR.test(region[2] ?? '') ? { tool, input: { file_path: path } } : null;
}

/**
 * The one question of an untouched lone question dialog: its text and the option labels above
 * `Type something`. Multi-select when the options carry checkboxes.
 */
function readQuestion(region: string[], options: Option[]): ScreenDialog | null {
    const pristine = SINGLE_QUESTION_TAB_BAR.test(region[0])
        && !region.some((line) => line.includes('☒') || line.includes('[✔]'))
        && !region.includes('Ready to submit your answers?')
        && options.find((o) => o.focused)?.digit === 1;
    const question = questionText(region);
    const raw = region.flatMap((line) => {
        const match = OPTION.exec(line);
        return match === null ? [] : [match[3]];
    });
    const typeAt = raw.findIndex((text) => TYPE_SOMETHING.test(text));
    if (!pristine || question.length === 0 || typeAt < 1) {
        return null;
    }
    const shown = raw.slice(0, typeAt);
    const multiSelect = shown.every((text) => text.startsWith('[ ] '));
    if (!multiSelect && shown.some((text) => CHECKBOX.test(text))) {
        return null;
    }
    const labels = shown.map((text) => text.replace(CHECKBOX, '').trim());
    if (labels.some((label) => label.length === 0) || options.slice(0, typeAt).some((o, index) => o.digit !== index + 1)) {
        return null;
    }
    return { tool: 'AskUserQuestion', input: { questions: [{ question, options: labels.map((label) => ({ label })), multiSelect }] } };
}

/**
 * The open dialog read from the screen alone, for when the transcript does not hold its tool call
 * yet: the tool name and target of a permission dialog, the one question of a lone question
 * dialog, or `{ plan: '' }` for an untouched plan dialog (the plan text is not read off the
 * screen). Null whenever any part cannot be read exactly: several question tabs, a touched
 * dialog, a truncated command, an unknown header or wording, a subagent's dialog, or a screen
 * that may hold a dialog drawn inside another.
 */
export function readDialogFromScreen(screen: string): ScreenDialog | null {
    const parsed = parseScreen(screen);
    const { kind, options, ask } = analyse(parsed);
    const { region } = parsed;
    if (region.some((line) => SUBAGENT_HEADER.test(line))) {
        return null;
    }
    switch (kind) {
        case 'permission':
            return looksStacked(parsed, kind, ask) ? null : readPermission(region, ask);
        case 'question':
            return looksStacked(parsed, kind, null) ? null : readQuestion(region, options);
        case 'plan':
            return options.find((o) => o.focused)?.digit === 1 && options.find((o) => o.digit === 3)?.label === PLAN_FEEDBACK
                ? { tool: 'ExitPlanMode', input: { plan: '' } }
                : null;
        default:
            return null;
    }
}

/**
 * What a multi-key answer checks between keys:
 * - `tabs`: a question dialog's tab bar with the ☐/☒ marks dropped. The measured screens of one
 *   question set keep the same tab names from the first question through the review screen, so a
 *   change means another question set (or none) is open.
 * - `review`: the measured review screen (`Ready to submit your answers?`, `1. Submit answers`).
 * - `planFeedback`: the text of a focused plan option 3 up to the measured `shift+tab to approve
 *   with this feedback` hint under it (the typed feedback, as in `plan-feedback-typed`), wrapped
 *   lines joined with a space. Null when option 3 is not focused or the hint is missing.
 */
export type DialogProgress = { kind: DialogKind; tabs: string | null; review: boolean; planFeedback: string | null };

const PLAN_FEEDBACK_HINT = 'shift+tab to approve with this feedback';

export function readDialogProgress(screen: string): DialogProgress {
    const parsed = parseScreen(screen);
    const { kind, options } = analyse(parsed);
    const { region } = parsed;
    const first = options[0];
    const review = kind === 'question'
        && region.includes('Ready to submit your answers?')
        && first?.digit === 1 && first.label === 'Submit answers';
    let planFeedback: string | null = null;
    if (kind === 'plan' && options.find((o) => o.focused)?.digit === 3) {
        // Below the plan prompt only: the plan body above it is model-written.
        const prompt = region.lastIndexOf(PLAN_PROMPT);
        const at = region.findIndex((line, index) => index > prompt && /^❯\s*3\.\s/.test(line));
        const hint = region.indexOf(PLAN_FEEDBACK_HINT, at);
        planFeedback = at < 0 || hint < 0
            ? null
            : [OPTION.exec(region[at])?.[3] ?? '', ...region.slice(at + 1, hint)].join(' ').replace(/\s+/g, ' ').trim();
    }
    return {
        kind,
        tabs: kind === 'question' ? region[0].replace(/[☐☒]/g, '').replace(/\s+/g, ' ').trim() : null,
        review,
        planFeedback,
    };
}

/**
 * Gate ④: whether the open dialog is about `pending`, read only from the dialog's own lines
 * (never the conversation above it, a description line or a file preview):
 * - Bash: header `Bash command` and the command block equal to the whole command.
 * - Write/Edit: the measured header and ask wording, and the path under the header resolving
 *   (against the session's `cwd`) to the pending file path. Read: header `Read file` and the
 *   block `Read(<path>)` resolving to the pending file path. Other tools ignore `cwd`.
 * - Questions: the question text right under the tab bar equal to the first question, untouched.
 * - Plans: untouched (option 1 focused). Other tools: the name as a whole word of the header.
 * Subagent dialogs and a pending `Task`/`Agent` call never match, because the tool being asked
 * about is not the one in the main transcript. Neither does a permission or question dialog that
 * may be drawn inside another (`looksStacked`).
 */
export function screenMatchesPending(screen: string, pending: PendingToolUse, cwd: string): boolean {
    const parsed = parseScreen(screen);
    const { kind, options, ask } = analyse(parsed);
    const { region } = parsed;
    if (pending.name === 'Task' || pending.name === 'Agent' || region.some((line) => SUBAGENT_HEADER.test(line))) {
        return false;
    }
    if ((kind === 'permission' || kind === 'question') && looksStacked(parsed, kind, ask)) {
        return false;
    }
    switch (pending.name) {
        case 'Write':
        case 'Edit':
            return kind === 'permission' && fileDialogMatches(region, ask, pending.name, pending.input.file_path, cwd);
        case 'Read': {
            const shown = previewBlock(region)?.join('\n').match(/^Read\((.+)\)$/)?.[1];
            return kind === 'permission' && region[0] === 'Read file' && shown !== undefined && isShownPath(shown, pending.input.file_path, cwd);
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

/** True when the input box is drawn and holds typed text (not just a dim suggestion). */
export function inputBoxHasText(screen: string): boolean {
    return parseScreen(screen).input !== null && !isInputBoxEmpty(screen);
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
