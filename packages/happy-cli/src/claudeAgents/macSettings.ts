/**
 * Reads the settings a background session runs with from its attach screen, and the screens met
 * while changing them: the permission mode under the input box, Claude Code's `/model` picker, the
 * "Switch model?" confirmation and the line `/model` leaves behind.
 *
 * Only for the phone's mode, model and effort pickers on a Mac background session. Every reader
 * works on plain and `capture-pane -e` captures and returns null for a screen it does not know, so
 * the caller never presses a key on a guess.
 *
 * Models are named the way the phone names Claude models (`claude-opus-5-5`) and matched against
 * the picker's rows by their label (`Opus 5.5`). `/model <name>` and Enter in the picker save the
 * pick as the default for every new session, so a change only ever goes through the picker's
 * `s` ("use this session only").
 */

import { inputBoxFooter } from './dialogs';

/** The permission modes a background session can be switched between with Shift+Tab. */
export const MAC_PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'] as const;
export type MacPermissionMode = (typeof MAC_PERMISSION_MODES)[number];

/** The effort levels of the `/model` picker, in the order ←/→ step through them. */
export const MAC_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type MacEffortLevel = (typeof MAC_EFFORT_LEVELS)[number];

export type ModelPickerRow = {
    /** The model's label, `Opus 5.5`; `Default (recommended)` for the default row. */
    label: string;
    /** The `❯` cursor is on this row. */
    cursor: boolean;
    /** The session runs this model (`✔`). */
    current: boolean;
};

export type ModelPicker = {
    rows: ModelPickerRow[];
    /** The effort the picker would apply, or null when it shows none (a model without levels). */
    effort: MacEffortLevel | null;
};

const SGR_OR_CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g;

const MODE_LINES: Array<[RegExp, MacPermissionMode]> = [
    [/^⏸ manual mode on\b/, 'default'],
    [/^⏵⏵ accept edits on\b/, 'acceptEdits'],
    [/^⏸ plan mode on\b/, 'plan'],
    [/^⏵⏵ auto mode on\b/, 'auto'],
    [/^⏵⏵ bypass permissions on\b/, 'bypassPermissions'],
];

const PICKER_TITLE = /^Select model$/;
const PICKER_FOOTER = /\bs to use this session only\b/;
const PICKER_ROW = /^(❯\s+)?\d+\.\s+(.+?)(\s+✔)?(?:\s{2,}.*)?$/;
const PICKER_EFFORT = /^[○◐●◉]\s+(\S+) effort\b/;
const SWITCH_TITLE = /^Switch model\?$/;
const SWITCH_YES = /^❯\s*1\.\s+Yes\b/;

function plainLines(screen: string): string[] {
    return screen
        .replace(OSC, '')
        .replace(SGR_OR_CSI, '')
        .split('\n')
        .map((line) => line.trim());
}

/**
 * The permission mode the session runs in, read from the line under the input box. Manual mode
 * shows `⏸ manual mode on` or, without it, no mode line at all; null when no input box is drawn.
 */
export function readPermissionMode(screen: string): MacPermissionMode | null {
    const footer = inputBoxFooter(screen);
    if (footer === null) {
        return null;
    }
    for (const line of footer) {
        const found = MODE_LINES.find(([pattern]) => pattern.test(line));
        if (found !== undefined) {
            return found[1];
        }
    }
    return 'default';
}

/** The `/model` picker, or null when it is not open. */
export function readModelPicker(screen: string): ModelPicker | null {
    const lines = plainLines(screen);
    const title = lines.findIndex((line) => PICKER_TITLE.test(line));
    if (title < 0 || !lines.slice(title).some((line) => PICKER_FOOTER.test(line))) {
        return null;
    }
    const rows: ModelPickerRow[] = [];
    let effort: MacEffortLevel | null = null;
    for (const line of lines.slice(title + 1)) {
        const row = PICKER_ROW.exec(line);
        if (row !== null) {
            rows.push({ label: row[2].trim(), cursor: row[1] !== undefined, current: row[3] !== undefined });
            continue;
        }
        const level = PICKER_EFFORT.exec(line)?.[1].toLowerCase();
        if (level !== undefined) {
            effort = (MAC_EFFORT_LEVELS as readonly string[]).includes(level) ? (level as MacEffortLevel) : null;
        }
    }
    return rows.length > 0 && rows.filter((row) => row.cursor).length === 1 ? { rows, effort } : null;
}

/** True when the "Switch model?" confirmation is open with the cursor on `1. Yes`. */
export function isSwitchConfirmation(screen: string): boolean {
    const lines = plainLines(screen);
    const title = lines.findIndex((line) => SWITCH_TITLE.test(line));
    return title >= 0 && lines.slice(title + 1).some((line) => SWITCH_YES.test(line));
}

/**
 * What `/model` reported for the model labelled `label`: `session` for "Set model to <label> for
 * this session only", `saved` for "Set model to <label> and saved as your default…", null when the
 * screen shows neither. The line sits under the echoed `/model`, or, while the session works, in
 * the notice at the right of the input box, so the whole screen is searched.
 */
export function readModelResult(screen: string, label: string): 'session' | 'saved' | null {
    const lines = plainLines(screen);
    if (lines.some((line) => line.includes(`Set model to ${label} and saved as your default`))) {
        return 'saved';
    }
    return lines.some((line) => line.includes(`Set model to ${label} for this session only`)) ? 'session' : null;
}

/**
 * The picker label of a phone model key: `claude-opus-5-5` → `Opus 5.5`, `claude-fable-5` →
 * `Fable 5`, `default` → `Default`. Null for a key that names no Claude model.
 */
export function pickerLabelOf(model: string): string | null {
    if (model === 'default') {
        return 'Default';
    }
    const match = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(model);
    if (match === null) {
        return null;
    }
    const family = match[1].charAt(0).toUpperCase() + match[1].slice(1);
    return `${family} ${match[2]}${match[3] === undefined ? '' : `.${match[3]}`}`;
}

/** The phone model key of a picker row: `Opus 5.5` → `claude-opus-5-5`, `Default (recommended)` → `default`. */
export function modelKeyOf(label: string): string {
    if (/^Default\b/.test(label)) {
        return 'default';
    }
    return `claude-${label.toLowerCase().replace(/[\s.]+/g, '-')}`;
}

/** The index of the row for `model`, or -1 when the picker has none. */
export function pickerRowFor(picker: ModelPicker, model: string): number {
    const label = pickerLabelOf(model);
    if (label === null) {
        return -1;
    }
    return picker.rows.findIndex((row) => row.label === label || (label === 'Default' && /^Default\b/.test(row.label)));
}
