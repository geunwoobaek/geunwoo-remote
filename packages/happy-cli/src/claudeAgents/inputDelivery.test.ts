import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AttachKey, AttachTerminal } from './attachTerminal';
import { guardUserPane, paneShowsAgent } from './cmuxTerminal';
import { createEchoFilter, createInputDelivery, hasSessionSurvey } from './inputDelivery';
import type { ClaudeAgent } from './types';

const fixture = (name: string): string => readFileSync(join(__dirname, '__fixtures__', 'screens', `${name}.txt`), 'utf8');

const EMPTY = fixture('input-empty');
const TYPED = fixture('input-typed');
/** `-e` capture: the session survey above an input box that holds only a dim suggestion. */
const SURVEY_ANSI = fixture('input-suggestion-ansi');
/** Plain capture of the same screen: the suggestion cannot be told from typed text. */
const SURVEY_PLAIN = fixture('input-suggestion-and-survey');
/** Real `claude attach` captures: the Mac user's half-written line, and the same line after Claude Code restored it. */
const DRAFT = fixture('input-draft-attach');
const RESTORED = fixture('input-draft-restored-attach');
/** The input box holding exactly `text`. */
const holding = (text: string): string => DRAFT.replace('half written mac line about the release notes', text);

type Call = string;

type FakeTerminal = AttachTerminal & { id: number; closed: boolean };

/** The calls since the last terminal was opened. */
const sinceOpen = (calls: Call[]): Call[] => calls.slice(calls.map((line) => line.startsWith('open#')).lastIndexOf(true));

/** Terminals share one log. `screens` is what `screen()` returns; the last entry repeats. */
function createHarness(screens: string[] | ((log: Call[]) => string), extra: { pressChangesScreen?: (key: AttachKey) => string | null } = {}) {
    const log: Call[] = [];
    const terminals: FakeTerminal[] = [];
    let reads = 0;
    let override: string | null = null;
    /** Like a real terminal, a typed text shows in the box until Enter (fixed screen lists only). */
    let typedShows = false;
    const openTerminal = async (): Promise<AttachTerminal> => {
        const id = terminals.length + 1;
        log.push(`open#${id}`);
        const terminal: FakeTerminal = {
            id,
            closed: false,
            screen: async () => {
                if (typeof screens !== 'function' && typedShows) {
                    return TYPED;
                }
                if (override !== null) {
                    return override;
                }
                if (typeof screens === 'function') {
                    return screens(log);
                }
                return screens[Math.min(reads++, screens.length - 1)];
            },
            typeText: async (text) => {
                log.push(`type#${id}:${text}`);
                typedShows = true;
            },
            pasteText: async (text) => {
                log.push(`paste#${id}:${text}`);
                typedShows = true;
            },
            press: async (keys) => {
                if (keys.includes('enter')) {
                    typedShows = false;
                }
                log.push(`press#${id}:${keys.map((key) => (typeof key === 'string' ? key : `digit${key.digit}`)).join(',')}`);
                for (const key of keys) {
                    const next = extra.pressChangesScreen?.(key) ?? null;
                    if (next !== null) {
                        override = next;
                    }
                }
            },
            close: async () => {
                terminal.closed = true;
                log.push(`close#${id}`);
            },
        };
        terminals.push(terminal);
        return terminal;
    };
    return { log, terminals, openTerminal };
}

/** The survey is two lines (title and options); drop them to get a plain idle screen. */
function withoutSurvey(screen: string): string {
    return screen.split('\n').filter((line) => !line.includes('Dismiss') && !line.includes('How is Claude doing')).join('\n');
}

const fast = { closeDelayMs: 1, pollIntervalMs: 5 };

describe('createEchoFilter', () => {
    it('skips only as many copies as were remembered', () => {
        const echo = createEchoFilter();
        echo.remember('hi');
        expect(echo.shouldSkip('hi')).toBe(true);
        expect(echo.shouldSkip('hi')).toBe(false);
    });

    it('compares after whitespace normalization', () => {
        const echo = createEchoFilter();
        echo.remember('  hello \n  world\t!  ');
        expect(echo.shouldSkip('hello world !')).toBe(true);
    });

    it('does not skip text that was never remembered', () => {
        const echo = createEchoFilter();
        echo.remember('a');
        expect(echo.shouldSkip('b')).toBe(false);
        expect(echo.shouldSkip('a')).toBe(true);
    });

    it('counts repeated remembers', () => {
        const echo = createEchoFilter();
        echo.remember('x');
        echo.remember('x');
        expect([echo.shouldSkip('x'), echo.shouldSkip('x'), echo.shouldSkip('x')]).toEqual([true, true, false]);
    });

    it('forget removes exactly one remembered copy', () => {
        const echo = createEchoFilter();
        echo.remember('x');
        echo.remember('x');
        echo.forget('x');
        expect([echo.shouldSkip('x'), echo.shouldSkip('x')]).toEqual([true, false]);
        echo.forget('never remembered');
        expect(echo.shouldSkip('never remembered')).toBe(false);
    });
});

describe('hasSessionSurvey', () => {
    it('sees the survey on plain and colour captures', () => {
        expect(hasSessionSurvey(SURVEY_ANSI)).toBe(true);
        expect(hasSessionSurvey(SURVEY_PLAIN)).toBe(true);
    });

    it('is false on screens without the survey', () => {
        expect(hasSessionSurvey(EMPTY)).toBe(false);
        expect(hasSessionSurvey(TYPED)).toBe(false);
        expect(hasSessionSurvey(fixture('permission-bash'))).toBe(false);
    });
});

describe('createInputDelivery', () => {
    it('send types single-line text then enter and closes', async () => {
        const { log, openTerminal } = createHarness([EMPTY]);
        const echo = createEchoFilter();
        const delivery = createInputDelivery({ openTerminal, echo, ...fast });
        expect(await delivery.send('hello there')).toBe('sent');
        expect(log).toEqual(['open#1', 'type#1:hello there', 'press#1:enter', 'close#1']);
        expect(echo.shouldSkip('hello there')).toBe(true);
    });

    it('send pastes multi-line text', async () => {
        const { log, openTerminal } = createHarness([EMPTY]);
        const delivery = createInputDelivery({ openTerminal, echo: createEchoFilter(), ...fast });
        expect(await delivery.send('line one\nline two')).toBe('sent');
        expect(log).toEqual(['open#1', 'paste#1:line one\nline two', 'press#1:enter', 'close#1']);
    });

    it('sends are serialized', async () => {
        const { log, terminals, openTerminal } = createHarness([EMPTY]);
        const delivery = createInputDelivery({ openTerminal, echo: createEchoFilter(), ...fast });
        const results = await Promise.all([delivery.send('first'), delivery.send('second')]);
        expect(results).toEqual(['sent', 'sent']);
        expect(log).toEqual([
            'open#1', 'type#1:first', 'press#1:enter', 'close#1',
            'open#2', 'type#2:second', 'press#2:enter', 'close#2',
        ]);
        expect(terminals.every((terminal) => terminal.closed)).toBe(true);
    });

    it('send waits for a non-empty input box and gives up with busy-input', async () => {
        const { log, openTerminal } = createHarness([TYPED]);
        const echo = createEchoFilter();
        const delivery = createInputDelivery({ openTerminal, echo, waitInputMs: 50, ...fast });
        expect(await delivery.send('hello')).toBe('busy-input');
        expect(log).toEqual(['open#1', 'close#1']);
        expect(echo.shouldSkip('hello')).toBe(false);
    });

    it('send waits until the input box becomes empty', async () => {
        const { log, openTerminal } = createHarness([TYPED, TYPED, EMPTY]);
        const delivery = createInputDelivery({ openTerminal, echo: createEchoFilter(), waitInputMs: 2000, ...fast });
        expect(await delivery.send('later')).toBe('sent');
        expect(log).toEqual(['open#1', 'type#1:later', 'press#1:enter', 'close#1']);
    });

    it('send presses Enter again when the first one was swallowed and the text still sits in the box', async () => {
        // A Mac just awake from sleep: the first Enter is lost, the typed text stays in the box.
        const enters = (log: Call[]): number => log.filter((line) => line.endsWith(':enter')).length;
        const { log, openTerminal } = createHarness((calls) => (calls.some((line) => line.startsWith('type')) && enters(calls) < 2 ? TYPED : EMPTY));
        const echo = createEchoFilter();
        const delivery = createInputDelivery({ openTerminal, echo, submitWaitMs: 30, ...fast });
        expect(await delivery.send('keep going')).toBe('sent');
        expect(log).toEqual(['open#1', 'type#1:keep going', 'press#1:enter', 'press#1:enter', 'close#1']);
        expect(echo.shouldSkip('keep going')).toBe(true);
    });

    it('send deletes a text that never submits and reports failed, so the next message is not blocked', async () => {
        let stuck = true;
        const { log, openTerminal } = createHarness((calls) => {
            const current = calls.slice(calls.map((line) => line.startsWith('open#')).lastIndexOf(true));
            if (!current.some((line) => line.startsWith('type'))) {
                return EMPTY;
            }
            const gone = stuck ? current.some((line) => line.includes('backspace')) : current.some((line) => line.endsWith(':enter'));
            return gone ? EMPTY : TYPED;
        });
        const echo = createEchoFilter();
        const delivery = createInputDelivery({ openTerminal, echo, submitWaitMs: 20, ...fast });
        expect(await delivery.send('hi')).toBe('failed');
        expect(log.filter((line) => line === 'press#1:enter')).toHaveLength(3);
        // One backspace per character plus spares, in one batch.
        expect(log).toContain(`press#1:${Array.from({ length: 6 }, () => 'backspace').join(',')}`);
        expect(log.at(-1)).toBe('close#1');
        expect(echo.shouldSkip('hi')).toBe(false);

        stuck = false;
        expect(await delivery.send('next')).toBe('sent');
    });

    it('send does not press Enter again over a dialog that replaced the input box', async () => {
        // Claude took the text and asked for a permission right away: Enter there would pick an option.
        const dialog = fixture('permission-bash');
        const { log, openTerminal } = createHarness((calls) => {
            if (calls.some((line) => line.endsWith(':enter'))) {
                return dialog;
            }
            return calls.some((line) => line.startsWith('type')) ? TYPED : EMPTY;
        });
        const delivery = createInputDelivery({ openTerminal, echo: createEchoFilter(), submitWaitMs: 20, ...fast });
        expect(await delivery.send('run it')).toBe('sent');
        expect(log).toEqual(['open#1', 'type#1:run it', 'press#1:enter', 'close#1']);
    });

    it('send presses Enter only once the typed text shows in the box', async () => {
        // A slow terminal draws the text late; an Enter before that would be lost.
        let readsAfterTyping = 0;
        const { log, openTerminal } = createHarness((calls) => {
            if (!calls.some((line) => line.startsWith('type'))) {
                return EMPTY;
            }
            if (calls.some((line) => line.endsWith(':enter'))) {
                return EMPTY;
            }
            readsAfterTyping++;
            if (readsAfterTyping < 4) {
                return EMPTY;
            }
            calls.push('shown');
            return TYPED;
        });
        const delivery = createInputDelivery({ openTerminal, echo: createEchoFilter(), submitWaitMs: 200, ...fast });
        expect(await delivery.send('slow')).toBe('sent');
        expect(log.indexOf('shown')).toBeGreaterThan(-1);
        expect(log.indexOf('shown')).toBeLessThan(log.indexOf('press#1:enter'));
        expect(log.filter((line) => line === 'press#1:enter')).toHaveLength(1);
    });

    it('send reports failed and presses no Enter when the typed keys never show', async () => {
        const { log, openTerminal } = createHarness([EMPTY]);
        const original = openTerminal;
        // A terminal that drops the keys: the box stays empty after typing.
        const dropping = async (): Promise<AttachTerminal> => ({ ...(await original()), typeText: async (text: string) => { log.push(`lost#1:${text}`); } });
        const echo = createEchoFilter();
        const delivery = createInputDelivery({ openTerminal: dropping, echo, submitWaitMs: 10, ...fast });
        expect(await delivery.send('gone')).toBe('failed');
        expect(log.some((line) => line.endsWith(':enter'))).toBe(false);
        expect(log.some((line) => line.includes('backspace'))).toBe(true);
        expect(echo.shouldSkip('gone')).toBe(false);
    });

    it('send counts a terminal that cannot be read after Enter as sent, so the phone does not resend', async () => {
        const { log, openTerminal } = createHarness((calls) => {
            if (calls.some((line) => line.endsWith(':enter'))) {
                throw new Error('tmux went away');
            }
            return calls.some((line) => line.startsWith('type')) ? TYPED : EMPTY;
        });
        const echo = createEchoFilter();
        const delivery = createInputDelivery({ openTerminal, echo, submitWaitMs: 20, ...fast });
        expect(await delivery.send('maybe in')).toBe('sent');
        expect(log.at(-1)).toBe('close#1');
        expect(echo.shouldSkip('maybe in')).toBe(true);
    });

    it('send does not type into a dialog', async () => {
        const { log, openTerminal } = createHarness([fixture('permission-bash')]);
        const delivery = createInputDelivery({ openTerminal, echo: createEchoFilter(), waitInputMs: 30, ...fast });
        expect(await delivery.send('hello')).toBe('busy-input');
        expect(log).toEqual(['open#1', 'close#1']);
    });

    it('sets a Mac draft aside, sends the phone text, and takes the restored draft as sent', async () => {
        // Claude Code puts the stashed draft back on submit; Enter over it would send the Mac line.
        const { log, openTerminal } = createHarness((calls) => {
            const current = sinceOpen(calls);
            if (current.some((line) => line.endsWith(':enter'))) {
                return RESTORED;
            }
            if (current.some((line) => line.startsWith('type'))) {
                return TYPED;
            }
            return current.some((line) => line.endsWith(':stash')) ? EMPTY : DRAFT;
        });
        const echo = createEchoFilter();
        const delivery = createInputDelivery({ openTerminal, echo, draftSettleMs: 10, submitWaitMs: 20, ...fast });
        expect(await delivery.send('from phone')).toBe('sent');
        expect(log).toEqual(['open#1', 'press#1:stash', 'type#1:from phone', 'press#1:enter', 'close#1']);
        expect(echo.shouldSkip('from phone')).toBe(true);
    });

    it('types nothing when the stash key does not empty the box', async () => {
        const { log, openTerminal } = createHarness([DRAFT]);
        const delivery = createInputDelivery({ openTerminal, echo: createEchoFilter(), draftSettleMs: 10, submitWaitMs: 20, ...fast });
        expect(await delivery.send('from phone')).toBe('busy-input');
        expect(log).toEqual(['open#1', 'press#1:stash', 'close#1']);
    });

    it('brings the Mac draft back when the phone text never submits', async () => {
        const { log, openTerminal } = createHarness((calls) => {
            const current = sinceOpen(calls);
            const stashes = current.filter((line) => line.endsWith(':stash')).length;
            if (stashes === 0 || stashes === 2) {
                return DRAFT;
            }
            const typed = current.some((line) => line.startsWith('type'));
            return typed && !current.some((line) => line.includes('backspace')) ? TYPED : EMPTY;
        });
        const echo = createEchoFilter();
        const delivery = createInputDelivery({ openTerminal, echo, draftSettleMs: 10, submitWaitMs: 20, ...fast });
        expect(await delivery.send('hi')).toBe('failed');
        const presses = log.filter((line) => line.startsWith('press#1:'));
        expect(presses[0]).toBe('press#1:stash');
        expect(presses.at(-2)).toContain('backspace');
        expect(presses.at(-1)).toBe('press#1:stash');
        expect(log.at(-1)).toBe('close#1');
        expect(echo.shouldSkip('hi')).toBe(false);
    });

    it('submits a leftover copy of the same phone text instead of setting it aside', async () => {
        // "계속" whose Enter was lost still sits in the box and the phone sends "계속" again: a restored
        // copy must not pass for sent, so the copy is submitted and only an empty box counts.
        const enters = (calls: Call[]): number => sinceOpen(calls).filter((line) => line.endsWith(':enter')).length;
        const { log, openTerminal } = createHarness((calls) => (enters(calls) < 2 ? holding('계속') : EMPTY));
        const echo = createEchoFilter();
        const delivery = createInputDelivery({ openTerminal, echo, draftSettleMs: 10, submitWaitMs: 20, ...fast });
        expect(await delivery.send('계속')).toBe('sent');
        expect(log).toEqual(['open#1', 'press#1:enter', 'press#1:enter', 'close#1']);
        expect(echo.shouldSkip('계속')).toBe(true);
    });

    it('reports failed when a leftover copy of the phone text never submits', async () => {
        const { log, openTerminal } = createHarness((calls) => (sinceOpen(calls).some((line) => line.includes('backspace')) ? EMPTY : holding('계속')));
        const delivery = createInputDelivery({ openTerminal, echo: createEchoFilter(), draftSettleMs: 10, submitWaitMs: 20, ...fast });
        expect(await delivery.send('계속')).toBe('failed');
        expect(log.some((line) => line.endsWith(':stash'))).toBe(false);
        expect(log.some((line) => line.includes('backspace'))).toBe(true);
    });

    it('leaves a line the Mac user is still typing alone', async () => {
        let keys = 0;
        const { log, openTerminal } = createHarness(() => holding(`still typing ${'x'.repeat(++keys)}`));
        const delivery = createInputDelivery({ openTerminal, echo: createEchoFilter(), draftSettleMs: 30, waitInputMs: 80, ...fast });
        expect(await delivery.send('from phone')).toBe('busy-input');
        expect(log).toEqual(['open#1', 'close#1']);
    });

    it('waits for text that is about to be submitted instead of setting it aside', async () => {
        // A box the Mac user just submitted empties before the settle time: no stash.
        const { log, openTerminal } = createHarness([TYPED, EMPTY]);
        const delivery = createInputDelivery({ openTerminal, echo: createEchoFilter(), draftSettleMs: 500, ...fast });
        expect(await delivery.send('after')).toBe('sent');
        expect(log).toEqual(['open#1', 'type#1:after', 'press#1:enter', 'close#1']);
    });

    it('send sanitizes control characters before typing', async () => {
        const { log, openTerminal } = createHarness([EMPTY]);
        const echo = createEchoFilter();
        const delivery = createInputDelivery({ openTerminal, echo, ...fast });
        expect(await delivery.send('a\x1b[31mb\x03c\x7f')).toBe('sent');
        expect(log).toContain('type#1:abc');
        expect(echo.shouldSkip('abc')).toBe(true);
    });

    it('echo entry is forgotten when typing throws', async () => {
        for (const failing of ['typeText', 'pasteText', 'press'] as const) {
            const { openTerminal } = createHarness([EMPTY]);
            const echo = createEchoFilter();
            const text = failing === 'pasteText' ? 'a\nb' : 'ok';
            const delivery = createInputDelivery({
                openTerminal: async () => {
                    const terminal = await openTerminal();
                    return { ...terminal, [failing]: async () => { throw new Error('tmux went away'); } };
                },
                echo,
                ...fast,
            });
            expect(await delivery.send(text)).toBe('failed');
            // A later identical line typed on the Mac must still be uploaded.
            expect(echo.shouldSkip(text)).toBe(false);
        }
    });

    it('send of text that is empty after sanitizing types nothing and opens nothing', async () => {
        const { log, openTerminal } = createHarness([EMPTY]);
        const echo = createEchoFilter();
        const delivery = createInputDelivery({ openTerminal, echo, ...fast });
        expect(await delivery.send('\x1b[31m \x03 \n')).toBe('sent');
        expect(log).toEqual([]);
    });

    it('interrupt presses escape once', async () => {
        const { log, openTerminal } = createHarness([EMPTY]);
        const delivery = createInputDelivery({ openTerminal, echo: createEchoFilter(), ...fast });
        await delivery.interrupt();
        expect(log).toEqual(['open#1', 'press#1:escape', 'close#1']);
    });

    it('interrupt is serialized with sends', async () => {
        const { log, openTerminal } = createHarness([EMPTY]);
        const delivery = createInputDelivery({ openTerminal, echo: createEchoFilter(), ...fast });
        await Promise.all([delivery.send('one'), delivery.interrupt(), delivery.send('two')]);
        expect(log).toEqual([
            'open#1', 'type#1:one', 'press#1:enter', 'close#1',
            'open#2', 'press#2:escape', 'close#2',
            'open#3', 'type#3:two', 'press#3:enter', 'close#3',
        ]);
    });

    it('send treats a dim suggestion as an empty input box', async () => {
        const { log, openTerminal } = createHarness([withoutSurvey(SURVEY_ANSI)]);
        const delivery = createInputDelivery({ openTerminal, echo: createEchoFilter(), ...fast });
        expect(SURVEY_ANSI).toContain('\x1b[2m');
        expect(await delivery.send('hi')).toBe('sent');
        expect(log).toContain('type#1:hi');
    });

    it('send dismisses the session survey with 0 before typing', async () => {
        const { log, openTerminal } = createHarness([SURVEY_ANSI], {
            pressChangesScreen: (key) => (typeof key === 'object' && key.digit === 0 ? EMPTY : null),
        });
        const delivery = createInputDelivery({ openTerminal, echo: createEchoFilter(), waitInputMs: 2000, ...fast });
        expect(await delivery.send('7 is my answer')).toBe('sent');
        expect(log).toEqual(['open#1', 'press#1:digit0', 'type#1:7 is my answer', 'press#1:enter', 'close#1']);
    });

    it('send returns busy-input when the survey does not go away, without typing', async () => {
        const { log, openTerminal } = createHarness([SURVEY_ANSI]);
        const echo = createEchoFilter();
        const delivery = createInputDelivery({ openTerminal, echo, waitInputMs: 50, ...fast });
        expect(await delivery.send('1 more thing')).toBe('busy-input');
        expect(log.filter((entry) => entry.startsWith('type') || entry.startsWith('paste'))).toEqual([]);
        expect(log.filter((entry) => entry === 'press#1:digit0')).toHaveLength(1);
        expect(log[log.length - 1]).toBe('close#1');
        expect(echo.shouldSkip('1 more thing')).toBe(false);
    });

    it('send does not press 0 when the survey shows but the input box holds text', async () => {
        const { log, openTerminal } = createHarness([SURVEY_PLAIN]);
        const delivery = createInputDelivery({ openTerminal, echo: createEchoFilter(), waitInputMs: 30, ...fast });
        expect(await delivery.send('x')).toBe('busy-input');
        expect(log).toEqual(['open#1', 'close#1']);
    });

    it('send returns failed and closes when typing throws, then keeps working', async () => {
        const { log, terminals, openTerminal } = createHarness([EMPTY]);
        let failNext = true;
        const flaky = async (): Promise<AttachTerminal> => {
            const terminal = await openTerminal();
            if (failNext) {
                failNext = false;
                terminal.typeText = async () => {
                    throw new Error('tmux died');
                };
            }
            return terminal;
        };
        const delivery = createInputDelivery({ openTerminal: flaky, echo: createEchoFilter(), ...fast });
        expect(await delivery.send('boom')).toBe('failed');
        expect(terminals[0].closed).toBe(true);
        expect(await delivery.send('ok')).toBe('sent');
        expect(log).toContain('type#2:ok');
    });

    /** Opens through `openTerminal` but makes `close` throw (after the real close ran). */
    function withThrowingClose(openTerminal: () => Promise<AttachTerminal>): () => Promise<AttachTerminal> {
        return async () => {
            const terminal = await openTerminal();
            const close = terminal.close;
            terminal.close = async () => {
                await close();
                throw new Error('kill-session failed');
            };
            return terminal;
        };
    }

    it('send still returns sent when close throws after a successful send', async () => {
        const { log, openTerminal } = createHarness([EMPTY]);
        const delivery = createInputDelivery({ openTerminal: withThrowingClose(openTerminal), echo: createEchoFilter(), ...fast });
        expect(await delivery.send('once')).toBe('sent');
        expect(log).toEqual(['open#1', 'type#1:once', 'press#1:enter', 'close#1']);
    });

    it('send still returns busy-input when close throws', async () => {
        const { openTerminal } = createHarness([TYPED]);
        const delivery = createInputDelivery({ openTerminal: withThrowingClose(openTerminal), echo: createEchoFilter(), waitInputMs: 30, ...fast });
        expect(await delivery.send('hello')).toBe('busy-input');
    });

    it('send reports the typing error, not the close error, when both throw', async () => {
        const { openTerminal } = createHarness([EMPTY]);
        const broken = async (): Promise<AttachTerminal> => {
            const terminal = await withThrowingClose(openTerminal)();
            terminal.typeText = async () => {
                throw new Error('tmux died');
            };
            return terminal;
        };
        const delivery = createInputDelivery({ openTerminal: broken, echo: createEchoFilter(), ...fast });
        expect(await delivery.send('x')).toBe('failed');
    });

    it('interrupt resolves when close throws and does not break the queue', async () => {
        const { log, openTerminal } = createHarness([EMPTY]);
        const delivery = createInputDelivery({ openTerminal: withThrowingClose(openTerminal), echo: createEchoFilter(), ...fast });
        await expect(delivery.interrupt()).resolves.toBeUndefined();
        expect(await delivery.send('after')).toBe('sent');
        expect(log).toContain('press#1:escape');
        expect(log).toContain('type#2:after');
    });

    it('send returns failed when the terminal cannot be opened', async () => {
        const delivery = createInputDelivery({
            openTerminal: async () => {
                throw new Error('no claude');
            },
            echo: createEchoFilter(),
            ...fast,
        });
        expect(await delivery.send('hi')).toBe('failed');
        await expect(delivery.interrupt()).resolves.toBeUndefined();
    });
});

type UserFailures = { screen?: boolean; type?: boolean; enter?: boolean; escape?: boolean };

/** The Mac user's own pane: reads the given screen, logs what is typed, can fail at each step. */
function createUserPane(screenText: string, failures: UserFailures = {}) {
    const log: Call[] = [];
    const openUserTerminal = async (): Promise<AttachTerminal> => {
        log.push('open');
        return {
            screen: async () => {
                if (failures.screen) {
                    throw new Error('cmux went away');
                }
                return screenText;
            },
            typeText: async (text) => {
                if (failures.type) {
                    throw new Error('cmux went away');
                }
                log.push(`type:${text}`);
            },
            pasteText: async () => {
                throw new Error('cmux cannot paste');
            },
            press: async (keys) => {
                const names = keys.map((key) => (typeof key === 'string' ? key : `digit${key.digit}`));
                if ((failures.enter && names.includes('enter')) || (failures.escape && names.includes('escape'))) {
                    throw new Error('cmux went away');
                }
                log.push(`press:${names.join(',')}`);
            },
            close: async () => {
                log.push('close');
            },
        };
    };
    return { log, openUserTerminal };
}

const typedOrPressed = (log: Call[]): Call[] => log.filter((line) => line.startsWith('type') || line.startsWith('press'));

describe('createInputDelivery with a user terminal', () => {
    it('sends through the user terminal when its box is empty', async () => {
        const pane = createUserPane(EMPTY);
        const { log, openTerminal } = createHarness([EMPTY]);
        const echo = createEchoFilter();
        const delivery = createInputDelivery({ openTerminal, openUserTerminal: pane.openUserTerminal, echo, ...fast });

        expect(await delivery.send('hello there')).toBe('sent');

        expect(pane.log).toEqual(['open', 'type:hello there', 'press:enter', 'close']);
        expect(log).toEqual([]);
        expect(echo.shouldSkip('hello there')).toBe(true);
    });

    it('falls back to tmux when the user is typing', async () => {
        const pane = createUserPane(TYPED);
        const { log, openTerminal } = createHarness([EMPTY]);
        const delivery = createInputDelivery({ openTerminal, openUserTerminal: pane.openUserTerminal, echo: createEchoFilter(), ...fast });

        expect(await delivery.send('hello there')).toBe('sent');

        expect(pane.log).toEqual(['open', 'close']);
        expect(log).toEqual(['open#1', 'type#1:hello there', 'press#1:enter', 'close#1']);
    });

    it('falls back to tmux when the user pane shows the session survey', async () => {
        const pane = createUserPane(SURVEY_PLAIN);
        const { log, openTerminal } = createHarness([EMPTY]);
        const delivery = createInputDelivery({ openTerminal, openUserTerminal: pane.openUserTerminal, echo: createEchoFilter(), ...fast });

        expect(await delivery.send('hi')).toBe('sent');

        expect(typedOrPressed(pane.log)).toEqual([]);
        expect(log).toContain('type#1:hi');
    });

    it('falls back to tmux for multi-line or backslash text', async () => {
        for (const text of ['one\ntwo', 'C:\\temp\\x']) {
            const pane = createUserPane(EMPTY);
            const { log, openTerminal } = createHarness([EMPTY]);
            const delivery = createInputDelivery({ openTerminal, openUserTerminal: pane.openUserTerminal, echo: createEchoFilter(), ...fast });

            expect(await delivery.send(text)).toBe('sent');

            expect(typedOrPressed(pane.log)).toEqual([]);
            expect(log).toHaveLength(4);
        }
    });

    it('falls back to tmux when the user terminal fails before typing', async () => {
        const pane = createUserPane(EMPTY, { screen: true });
        const { log, openTerminal } = createHarness([EMPTY]);
        const echo = createEchoFilter();
        const delivery = createInputDelivery({ openTerminal, openUserTerminal: pane.openUserTerminal, echo, ...fast });

        expect(await delivery.send('hello')).toBe('sent');

        expect(pane.log).toEqual(['open', 'close']);
        expect(log).toEqual(['open#1', 'type#1:hello', 'press#1:enter', 'close#1']);
        expect(echo.shouldSkip('hello')).toBe(true);
    });

    it('falls back to tmux when there is no user terminal or opening it fails', async () => {
        const openers: Array<() => Promise<AttachTerminal | null>> = [
            async () => null,
            async () => {
                throw new Error('no cmux');
            },
        ];
        for (const openUserTerminal of openers) {
            const { log, openTerminal } = createHarness([EMPTY]);
            const delivery = createInputDelivery({ openTerminal, openUserTerminal, echo: createEchoFilter(), ...fast });
            expect(await delivery.send('hello')).toBe('sent');
            expect(log).toEqual(['open#1', 'type#1:hello', 'press#1:enter', 'close#1']);
        }
    });

    it('does not resend through tmux after typing started', async () => {
        const pane = createUserPane(EMPTY, { enter: true });
        const { log, openTerminal } = createHarness([EMPTY]);
        const echo = createEchoFilter();
        const delivery = createInputDelivery({ openTerminal, openUserTerminal: pane.openUserTerminal, echo, ...fast });

        expect(await delivery.send('once only')).toBe('failed');

        expect(pane.log).toEqual(['open', 'type:once only', 'close']);
        expect(log).toEqual([]);
        expect(echo.shouldSkip('once only')).toBe(false);
    });

    it('does not resend through tmux when typeText itself fails', async () => {
        const pane = createUserPane(EMPTY, { type: true });
        const { log, openTerminal } = createHarness([EMPTY]);
        const echo = createEchoFilter();
        const delivery = createInputDelivery({ openTerminal, openUserTerminal: pane.openUserTerminal, echo, ...fast });

        expect(await delivery.send('once only')).toBe('failed');

        expect(log).toEqual([]);
        expect(echo.shouldSkip('once only')).toBe(false);
    });

    it('interrupt presses escape on the user terminal and falls back to tmux when that fails', async () => {
        const pane = createUserPane(EMPTY);
        const first = createHarness([EMPTY]);
        await createInputDelivery({ openTerminal: first.openTerminal, openUserTerminal: pane.openUserTerminal, echo: createEchoFilter(), ...fast }).interrupt();
        expect(pane.log).toEqual(['open', 'press:escape', 'close']);
        expect(first.log).toEqual([]);

        const broken = createUserPane(EMPTY, { escape: true });
        const second = createHarness([EMPTY]);
        await createInputDelivery({ openTerminal: second.openTerminal, openUserTerminal: broken.openUserTerminal, echo: createEchoFilter(), ...fast }).interrupt();
        expect(broken.log).toEqual(['open', 'close']);
        expect(second.log).toEqual(['open#1', 'press#1:escape', 'close#1']);
    });

    it('opens tmux only after the user terminal was released', async () => {
        const events: string[] = [];
        const open = async (name: string): Promise<AttachTerminal> => {
            events.push(`open:${name}`);
            return {
                screen: async () => (name === 'user' ? TYPED : EMPTY),
                typeText: async () => undefined,
                pasteText: async () => undefined,
                press: async () => undefined,
                close: async () => {
                    events.push(`close:${name}`);
                },
            };
        };
        const delivery = createInputDelivery({
            openTerminal: () => open('tmux'),
            openUserTerminal: () => open('user'),
            echo: createEchoFilter(),
            submitWaitMs: 5,
            ...fast,
        });
        await delivery.send('hi');
        expect(events).toEqual(['open:user', 'close:user', 'open:tmux', 'close:tmux']);
    });
});

describe('createInputDelivery with the user pane guarded by the session name', () => {
    const agents: ClaudeAgent[] = ['demo-agent', 'other-agent'].map((name, index) => ({
        id: `a${index + 1}`,
        sessionId: `session-${index + 1}`,
        name,
        cwd: '/Users/tester/project',
        pid: 1,
        status: 'idle',
        state: null,
        startedAt: 0,
    }));
    /** The pane as the mirror hands it out for agent a1 (`demo-agent`). */
    function guardedPane(screenText: string, listing: ClaudeAgent[] = agents) {
        const pane = createUserPane(screenText);
        const openUserTerminal = async (): Promise<AttachTerminal> =>
            guardUserPane(await pane.openUserTerminal(), (screen) => paneShowsAgent(screen, 'a1', listing));
        return { log: pane.log, openUserTerminal };
    }
    const otherAgentEmpty = EMPTY.replace(' demo-agent ─', ' other-agent ─');

    it("types nothing into a pane that shows another agent's session and sends through tmux", async () => {
        const pane = guardedPane(otherAgentEmpty);
        const { log, openTerminal } = createHarness([EMPTY]);
        const echo = createEchoFilter();
        const delivery = createInputDelivery({ openTerminal, openUserTerminal: pane.openUserTerminal, echo, ...fast });

        expect(await delivery.send('hello there')).toBe('sent');

        expect(typedOrPressed(pane.log)).toEqual([]);
        expect(log).toEqual(['open#1', 'type#1:hello there', 'press#1:enter', 'close#1']);
        expect(echo.shouldSkip('hello there')).toBe(true);
    });

    it('types into the pane when it shows the target session, also under a cut-short name', async () => {
        for (const screenText of [EMPTY, EMPTY.replace(' demo-agent ─', ' demo-ag… ─')]) {
            const pane = guardedPane(screenText);
            const { log, openTerminal } = createHarness([EMPTY]);
            const delivery = createInputDelivery({ openTerminal, openUserTerminal: pane.openUserTerminal, echo: createEchoFilter(), ...fast });

            expect(await delivery.send('hello there')).toBe('sent');

            expect(typedOrPressed(pane.log)).toEqual(['type:hello there', 'press:enter']);
            expect(log).toEqual([]);
        }
    });

    it('sends through tmux when a cut-short name on the pane also fits another agent', async () => {
        const listing = [...agents, { ...agents[0], id: 'a3', name: 'demo-agent-2' }];
        const pane = guardedPane(EMPTY.replace(' demo-agent ─', ' demo-ag… ─'), listing);
        const { log, openTerminal } = createHarness([EMPTY]);
        const delivery = createInputDelivery({ openTerminal, openUserTerminal: pane.openUserTerminal, echo: createEchoFilter(), ...fast });

        expect(await delivery.send('hi')).toBe('sent');

        expect(typedOrPressed(pane.log)).toEqual([]);
        expect(log).toContain('type#1:hi');
    });

    it("interrupt reads the pane first and presses Escape only on the target session's screen", async () => {
        const target = guardedPane(EMPTY);
        const first = createHarness([EMPTY]);
        await createInputDelivery({ openTerminal: first.openTerminal, openUserTerminal: target.openUserTerminal, echo: createEchoFilter(), ...fast }).interrupt();
        expect(target.log).toEqual(['open', 'press:escape', 'close']);
        expect(first.log).toEqual([]);

        const other = guardedPane(otherAgentEmpty);
        const second = createHarness([EMPTY]);
        await createInputDelivery({ openTerminal: second.openTerminal, openUserTerminal: other.openUserTerminal, echo: createEchoFilter(), ...fast }).interrupt();
        expect(typedOrPressed(other.log)).toEqual([]);
        expect(second.log).toEqual(['open#1', 'press#1:escape', 'close#1']);
    });
});

/** A capture without its colour codes, so the simulated session can edit the text it shows. */
const uncoloured = (screen: string): string => screen.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');

const MODE_SCREENS: Record<string, string> = {
    default: uncoloured(fixture('mode-manual')),
    acceptEdits: uncoloured(fixture('mode-accept-edits')),
    plan: uncoloured(fixture('mode-plan')),
    auto: uncoloured(fixture('mode-auto')),
};
const PICKER_SCREEN = uncoloured(fixture('model-picker'));
const CONFIRM_SCREEN = uncoloured(fixture('model-switch-confirm'));
const PICKER_LABELS = ['Default (recommended)', 'Opus 5.5', 'Fable 5.2', 'Sonnet 5.5', 'Haiku 5.5'];
const EFFORT_WORDS: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'xHigh', max: 'Max' };
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

type MacSessionOptions = {
    mode?: string;
    /** The modes Shift+Tab steps through, in order. */
    cycle?: string[];
    /** Index of the running model in PICKER_LABELS. */
    running?: number;
    effort?: string;
    /** "Switch model?" shows after `s`. */
    confirm?: boolean;
    /** The Mac user's half-written line in the input box. */
    draft?: string;
};

/**
 * A Mac background session driven only by the keys the delivery sends: Shift+Tab cycles the mode,
 * `/model` + Enter opens the picker, ↑/↓ and ←/→ move it, `s` applies the pick for this session,
 * Enter on "Switch model?" confirms. The screen is rebuilt by replaying the log on every read.
 * `violations` collects keys that would have done harm, such as Enter inside the picker.
 */
function macSession(options: MacSessionOptions = {}) {
    const cycle = options.cycle ?? ['default', 'acceptEdits', 'plan', 'auto'];
    const violations: string[] = [];
    const render = (log: Call[]): string => {
        let mode = options.mode ?? 'default';
        let running = options.running ?? 4;
        let effort = options.effort ?? 'medium';
        let box = options.draft ?? '';
        let stashed: string | null = null;
        let picker: { cursor: number; effort: string } | null = null;
        let confirming = false;
        let result: string | null = null;
        violations.length = 0;
        const apply = (): void => {
            running = picker!.cursor;
            effort = picker!.effort;
            result = running === 0 ? null : `Set model to ${PICKER_LABELS[running]} for this session only with ${effort} effort`;
            picker = null;
            confirming = false;
            if (stashed !== null) {
                box = stashed;
                stashed = null;
            }
        };
        for (const call of log) {
            const typed = /^type#\d+:(.*)$/s.exec(call);
            if (typed !== null) {
                if (picker !== null && !confirming && typed[1] === 's') {
                    if (options.confirm) {
                        confirming = true;
                    } else {
                        apply();
                    }
                } else if (picker === null) {
                    box += typed[1];
                }
                continue;
            }
            const pressed = /^press#\d+:(.*)$/.exec(call);
            for (const key of pressed === null ? [] : pressed[1].split(',')) {
                if (confirming) {
                    if (key === 'enter') {
                        apply();
                    } else if (key === 'escape') {
                        confirming = false;
                    }
                } else if (picker !== null) {
                    if (key === 'enter') {
                        violations.push('enter in the picker');
                    } else if (key === 'escape') {
                        picker = null;
                    } else if (key === 'down' || key === 'up') {
                        picker.cursor = Math.max(0, Math.min(PICKER_LABELS.length - 1, picker.cursor + (key === 'down' ? 1 : -1)));
                    } else if (key === 'left' || key === 'right') {
                        picker.effort = EFFORTS[Math.max(0, Math.min(EFFORTS.length - 1, EFFORTS.indexOf(picker.effort) + (key === 'right' ? 1 : -1)))];
                    } else {
                        violations.push(`${key} in the picker`);
                    }
                } else if (key === 'shift-tab') {
                    mode = cycle[(cycle.indexOf(mode) + 1) % cycle.length];
                } else if (key === 'enter') {
                    if (box === '/model') {
                        picker = { cursor: running, effort };
                    }
                    box = '';
                } else if (key === 'stash') {
                    if (stashed === null) {
                        stashed = box;
                        box = '';
                    } else {
                        box = stashed;
                        stashed = null;
                    }
                } else if (key === 'backspace') {
                    box = box.slice(0, -1);
                } else if (key === 'escape') {
                    violations.push('escape over the input box');
                }
            }
        }
        if (confirming) {
            return CONFIRM_SCREEN.replaceAll('Sonnet 5.5', PICKER_LABELS[picker!.cursor]);
        }
        if (picker !== null) {
            const open = picker;
            const lines = PICKER_SCREEN.split('\n').map((line) => {
                const row = /^\s*(?:❯\s+)?(\d)\.\s+/.exec(line);
                if (row === null) {
                    return line.replace(/◐ Medium effort \(default\)/, `◐ ${EFFORT_WORDS[open.effort]} effort`);
                }
                const index = Number(row[1]) - 1;
                return `   ${index === open.cursor ? '❯' : ' '} ${index + 1}.  ${PICKER_LABELS[index]}${index === running ? ' ✔' : ''}  About this model`;
            });
            return lines.join('\n');
        }
        const lines = MODE_SCREENS[mode].split('\n').map((line) => (/^❯\s*$/.test(line) ? `❯ ${box}` : line));
        if (result !== null) {
            lines[0] = `  ⎿  ${result}`;
        }
        return lines.join('\n');
    };
    return { render, violations };
}

describe('createInputDelivery configure', () => {
    const settle = { draftSettleMs: 10, submitWaitMs: 50, ...fast };

    it('steps the permission mode with Shift+Tab over the input box', async () => {
        const mac = macSession({ mode: 'default' });
        const { log, openTerminal } = createHarness(mac.render);
        const delivery = createInputDelivery({ openTerminal, echo: createEchoFilter(), ...settle });
        const result = await delivery.configure({ permissionMode: 'plan' });
        expect(result).toEqual({ ok: true, settings: { permissionMode: 'plan' } });
        expect(log).toEqual(['open#1', 'press#1:shift-tab', 'press#1:shift-tab', 'close#1']);
    });

    it('presses nothing over a dialog and reports busy', async () => {
        const { log, openTerminal } = createHarness([fixture('permission-bash')]);
        const delivery = createInputDelivery({ openTerminal, echo: createEchoFilter(), ...settle });
        const result = await delivery.configure({ permissionMode: 'auto', model: 'claude-opus-5-5' });
        expect(result).toEqual({ ok: false, reason: 'busy', settings: {} });
        expect(log).toEqual(['open#1', 'close#1']);
    });

    it('reports a mode the cycle never reaches as unsupported, back where it started', async () => {
        const mac = macSession({ mode: 'acceptEdits' });
        const { log, openTerminal } = createHarness(mac.render);
        const delivery = createInputDelivery({ openTerminal, echo: createEchoFilter(), ...settle });
        const result = await delivery.configure({ permissionMode: 'bypassPermissions' });
        expect(result).toEqual({ ok: false, reason: 'unsupported', settings: { permissionMode: 'acceptEdits' } });
        expect(log.filter((line) => line.endsWith(':shift-tab'))).toHaveLength(4);
    });

    it('picks a model and effort with s for this session only, never Enter in the picker', async () => {
        const mac = macSession({ running: 4, effort: 'medium' });
        const { log, openTerminal } = createHarness(mac.render);
        const delivery = createInputDelivery({ openTerminal, echo: createEchoFilter(), ...settle });
        const result = await delivery.configure({ model: 'claude-opus-5-5', effort: 'high' });
        expect(result).toEqual({
            ok: true,
            settings: {
                model: 'claude-opus-5-5',
                effort: 'high',
                permissionMode: 'default',
                models: [
                    { code: 'default', value: 'Default' },
                    { code: 'claude-opus-5-5', value: 'Opus 5.5' },
                    { code: 'claude-fable-5-2', value: 'Fable 5.2' },
                    { code: 'claude-sonnet-5-5', value: 'Sonnet 5.5' },
                    { code: 'claude-haiku-5-5', value: 'Haiku 5.5' },
                ],
            },
        });
        expect(log).toEqual([
            'open#1',
            'type#1:/model',
            'press#1:enter',
            'press#1:up',
            'press#1:up',
            'press#1:up',
            'press#1:right',
            'type#1:s',
            'close#1',
        ]);
        expect(mac.violations).toEqual([]);
    });

    it('changes only the effort on the running model', async () => {
        const mac = macSession({ running: 3, effort: 'medium' });
        const { log, openTerminal } = createHarness(mac.render);
        const delivery = createInputDelivery({ openTerminal, echo: createEchoFilter(), ...settle });
        const result = await delivery.configure({ effort: 'max' });
        expect(result.ok).toBe(true);
        expect(result.settings).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'max' });
        expect(log.filter((line) => line.startsWith('press#'))).toEqual(['press#1:enter', 'press#1:right', 'press#1:right', 'press#1:right']);
        expect(mac.violations).toEqual([]);
    });

    it('answers "Switch model?" with Enter, once', async () => {
        const mac = macSession({ running: 4, confirm: true });
        const { log, openTerminal } = createHarness(mac.render);
        const delivery = createInputDelivery({ openTerminal, echo: createEchoFilter(), ...settle });
        const result = await delivery.configure({ model: 'claude-sonnet-5-5' });
        expect(result.ok).toBe(true);
        expect(result.settings.model).toBe('claude-sonnet-5-5');
        expect(log.slice(log.indexOf('type#1:s'))).toEqual(['type#1:s', 'press#1:enter', 'close#1']);
        expect(mac.violations).toEqual([]);
    });

    it('closes the picker with Escape for a model it does not offer, and still reports what it saw', async () => {
        const mac = macSession({ running: 4 });
        const { log, openTerminal } = createHarness(mac.render);
        const delivery = createInputDelivery({ openTerminal, echo: createEchoFilter(), ...settle });
        const result = await delivery.configure({ model: 'claude-fable-5-1' });
        expect(result).toMatchObject({ ok: false, reason: 'unsupported', settings: { model: 'claude-haiku-5-5', effort: 'medium', permissionMode: 'default' } });
        expect(log).toEqual(['open#1', 'type#1:/model', 'press#1:enter', 'press#1:escape', 'close#1']);
        expect(mac.violations).toEqual([]);
    });

    it('sets a Mac draft aside for /model and leaves it restored', async () => {
        const mac = macSession({ running: 4, draft: 'half written mac line' });
        const { log, openTerminal } = createHarness(mac.render);
        const delivery = createInputDelivery({ openTerminal, echo: createEchoFilter(), ...settle });
        expect((await delivery.configure({ model: 'claude-opus-5-5' })).ok).toBe(true);
        expect(log.filter((line) => line.endsWith(':stash'))).toEqual(['press#1:stash']);
        expect(mac.render(log)).toContain('❯ half written mac line');
    });

    it('brings a Mac draft back when the picker was cancelled', async () => {
        const mac = macSession({ running: 4, draft: 'half written mac line' });
        const { log, openTerminal } = createHarness(mac.render);
        const delivery = createInputDelivery({ openTerminal, echo: createEchoFilter(), ...settle });
        expect((await delivery.configure({ model: 'claude-fable-5-1' })).ok).toBe(false);
        expect(log.filter((line) => line.endsWith(':stash'))).toEqual(['press#1:stash', 'press#1:stash']);
        expect(mac.render(log)).toContain('❯ half written mac line');
    });

    it('reads the permission mode on its own terminal', async () => {
        const mac = macSession({ mode: 'auto' });
        const { log, openTerminal } = createHarness(mac.render);
        const delivery = createInputDelivery({ openTerminal, echo: createEchoFilter(), ...settle });
        expect(await delivery.readPermissionMode()).toBe('auto');
        expect(log).toEqual(['open#1', 'close#1']);
    });
});

describe('createInputDelivery that never drops a phone message', () => {
    const PERMISSION = fixture('permission-bash');
    const patient = { retryBusyMs: 5, retryWaitInputMs: 20, waitInputMs: 30, ...fast };
    /** Shows `idle` once free, with a typed text in the box from typing until Enter in that terminal. */
    const echoing = (free: () => boolean, busy: () => string) => (calls: Call[]): string => {
        if (!free()) {
            return busy();
        }
        const current = sinceOpen(calls);
        const typed = current.map((line) => line.startsWith('type')).lastIndexOf(true);
        return typed >= 0 && !current.slice(typed).some((line) => line.endsWith(':enter')) ? TYPED : EMPTY;
    };

    it('keeps a message while a permission dialog shows and sends it once the dialog is answered', async () => {
        let answered = false;
        const { log, openTerminal } = createHarness(echoing(() => answered, () => PERMISSION));
        let waitingNotices = 0;
        const delivery = createInputDelivery({ openTerminal, echo: createEchoFilter(), onWaiting: () => waitingNotices++, ...patient });
        const sending = delivery.send('after the dialog');
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(log.filter((line) => line.startsWith('type'))).toEqual([]);
        answered = true;
        expect(await sending).toBe('sent');
        expect(log.filter((line) => line.startsWith('type') || line.startsWith('press')).map((line) => line.replace(/#\d+/, ''))).toEqual(['type:after the dialog', 'press:enter']);
        // Told once, after it had waited the normal input wait.
        expect(waitingNotices).toBe(1);
    });

    it('lets go of the terminal between tries, so an answer queued meanwhile gets it', async () => {
        let answered = false;
        const { log, openTerminal } = createHarness(echoing(() => answered, () => PERMISSION));
        const delivery = createInputDelivery({ openTerminal, echo: createEchoFilter(), ...patient });
        const sending = delivery.send('hello');
        await new Promise((resolve) => setTimeout(resolve, 40));
        // Something else (the phone's stop button here) is queued while the message waits.
        await delivery.interrupt();
        expect(log.filter((line) => line.startsWith('press')).at(-1)).toMatch(/:escape$/);
        answered = true;
        expect(await sending).toBe('sent');
        // Every terminal it opened was closed again.
        expect(log.filter((line) => line.startsWith('open')).length).toBe(log.filter((line) => line.startsWith('close')).length);
    });

    it('keeps later messages behind a waiting one, in the order they were sent', async () => {
        let answered = false;
        const { log, openTerminal } = createHarness(echoing(() => answered, () => PERMISSION));
        const delivery = createInputDelivery({ openTerminal, echo: createEchoFilter(), ...patient });
        const first = delivery.send('first');
        const second = delivery.send('second');
        await new Promise((resolve) => setTimeout(resolve, 60));
        answered = true;
        expect(await Promise.all([first, second])).toEqual(['sent', 'sent']);
        expect(log.filter((line) => line.startsWith('type')).map((line) => line.split(':')[1])).toEqual(['first', 'second']);
    });

    it('waits out a Mac user who keeps typing, without typing over them', async () => {
        let keys = 0;
        let stopped = false;
        const { log, openTerminal } = createHarness(echoing(() => stopped, () => holding(`still typing ${'x'.repeat(++keys)}`)));
        const delivery = createInputDelivery({ openTerminal, echo: createEchoFilter(), draftSettleMs: 1000, ...patient });
        const sending = delivery.send('from phone');
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(log.filter((line) => line.startsWith('type') || line.startsWith('press'))).toEqual([]);
        stopped = true;
        expect(await sending).toBe('sent');
        expect(log.filter((line) => line.startsWith('type'))).toHaveLength(1);
    });

    it('answers the survey with 0 only once across tries', async () => {
        const { log, openTerminal } = createHarness([SURVEY_ANSI]);
        const delivery = createInputDelivery({ openTerminal, echo: createEchoFilter(), ...patient });
        const sending = delivery.send('1 more thing');
        await new Promise((resolve) => setTimeout(resolve, 120));
        expect(delivery.abandon()).toBe(1);
        expect(await sending).toBe('failed');
        expect(log.filter((line) => line.endsWith(':digit0'))).toHaveLength(1);
        expect(log.filter((line) => line.startsWith('type'))).toEqual([]);
    });

    it('abandon resolves every waiting send as failed and counts them', async () => {
        const { log, openTerminal } = createHarness([PERMISSION]);
        const echo = createEchoFilter();
        const delivery = createInputDelivery({ openTerminal, echo, ...patient });
        const sends = [delivery.send('a'), delivery.send('b')];
        await new Promise((resolve) => setTimeout(resolve, 40));
        expect(delivery.abandon()).toBe(2);
        expect(await Promise.all(sends)).toEqual(['failed', 'failed']);
        expect(log.filter((line) => line.startsWith('type'))).toEqual([]);
        expect(echo.shouldSkip('a')).toBe(false);
    });

    it('still reports a send that typing broke as failed instead of trying it again', async () => {
        const { log, openTerminal } = createHarness([EMPTY]);
        let opened = 0;
        const breaking = async (): Promise<AttachTerminal> => {
            const terminal = await openTerminal();
            opened++;
            return { ...terminal, typeText: async () => { throw new Error('tmux went away'); } };
        };
        const delivery = createInputDelivery({ openTerminal: breaking, echo: createEchoFilter(), ...patient });
        expect(await delivery.send('once')).toBe('failed');
        expect(opened).toBe(1);
        expect(log.filter((line) => line.startsWith('type'))).toEqual([]);
    });
});
