import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    isSwitchConfirmation,
    modelKeyOf,
    pickerLabelOf,
    pickerRowFor,
    readModelPicker,
    readModelResult,
    readPermissionMode,
} from './macSettings';

const fixture = (name: string): string => readFileSync(join(__dirname, '__fixtures__', 'screens', `${name}.txt`), 'utf8');
/** A capture without its colour codes, so a test can edit the text it shows. */
const uncoloured = (screen: string): string => screen.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');

const PICKER = fixture('model-picker');
const CONFIRM = fixture('model-switch-confirm');
const SET_SESSION_ONLY = fixture('model-set-session-only');

describe('readPermissionMode', () => {
    it('reads each mode Shift+Tab steps through from the line under the input box', () => {
        expect(readPermissionMode(fixture('mode-manual'))).toBe('default');
        expect(readPermissionMode(fixture('mode-accept-edits'))).toBe('acceptEdits');
        expect(readPermissionMode(fixture('mode-plan'))).toBe('plan');
        expect(readPermissionMode(fixture('mode-auto'))).toBe('auto');
    });

    it('takes a box without a mode line for manual mode', () => {
        expect(readPermissionMode(fixture('input-empty'))).toBe('default');
    });

    it('is null while a dialog or the model picker covers the input box', () => {
        expect(readPermissionMode(fixture('permission-bash'))).toBeNull();
        expect(readPermissionMode(PICKER)).toBeNull();
        expect(readPermissionMode(CONFIRM)).toBeNull();
    });
});

describe('readModelPicker', () => {
    it('reads the rows, the cursor, the running model and the effort', () => {
        const picker = readModelPicker(PICKER);
        expect(picker).toEqual({
            rows: [
                { label: 'Default (recommended)', cursor: false, current: false },
                { label: 'Opus 5.5', cursor: false, current: false },
                { label: 'Fable 5.2', cursor: false, current: false },
                { label: 'Sonnet 5.5', cursor: false, current: false },
                { label: 'Haiku 5.5', cursor: true, current: true },
            ],
            effort: 'medium',
        });
    });

    it('reads a moved cursor and another effort level', () => {
        const moved = uncoloured(PICKER).replace('❯ 5.', '  5.').replace('  2.', '❯ 2.').replace('Medium effort (default)', 'xHigh effort');
        const picker = readModelPicker(moved);
        expect(picker?.rows.findIndex((row) => row.cursor)).toBe(1);
        expect(picker?.effort).toBe('xhigh');
    });

    it('is null without the picker', () => {
        expect(readModelPicker(fixture('mode-manual'))).toBeNull();
        expect(readModelPicker(CONFIRM)).toBeNull();
        expect(readModelPicker(SET_SESSION_ONLY)).toBeNull();
    });
});

describe('isSwitchConfirmation', () => {
    it('sees "Switch model?" with the cursor on Yes', () => {
        expect(isSwitchConfirmation(CONFIRM)).toBe(true);
    });

    it('is false with the cursor on No, and on other screens', () => {
        expect(isSwitchConfirmation(uncoloured(CONFIRM).replace('❯ 1. Yes', '  1. Yes').replace('  2. No', '❯ 2. No'))).toBe(false);
        expect(isSwitchConfirmation(PICKER)).toBe(false);
        expect(isSwitchConfirmation(fixture('permission-bash'))).toBe(false);
    });
});

describe('readModelResult', () => {
    it('finds the session-only switch to the given model', () => {
        expect(readModelResult(SET_SESSION_ONLY, 'Sonnet 5.5')).toBe('session');
        expect(readModelResult(SET_SESSION_ONLY, 'Opus 5.5')).toBeNull();
    });

    it('tells a switch that was saved as the default apart', () => {
        const saved = uncoloured(SET_SESSION_ONLY).replace('for this session only with xhigh effort', 'and saved as your default for new sessions');
        expect(readModelResult(saved, 'Sonnet 5.5')).toBe('saved');
    });
});

describe('model keys and picker labels', () => {
    it('maps phone keys to picker labels and back', () => {
        expect(pickerLabelOf('claude-opus-5-5')).toBe('Opus 5.5');
        expect(pickerLabelOf('claude-fable-5')).toBe('Fable 5');
        expect(pickerLabelOf('default')).toBe('Default');
        expect(pickerLabelOf('gpt-6-sol')).toBeNull();
        expect(modelKeyOf('Opus 5.5')).toBe('claude-opus-5-5');
        expect(modelKeyOf('Default (recommended)')).toBe('default');
    });

    it('finds the row of a model the picker offers, and none for one it does not', () => {
        const picker = readModelPicker(PICKER)!;
        expect(pickerRowFor(picker, 'claude-opus-5-5')).toBe(1);
        expect(pickerRowFor(picker, 'default')).toBe(0);
        expect(pickerRowFor(picker, 'claude-fable-5-1')).toBe(-1);
    });
});
