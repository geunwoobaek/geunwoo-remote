import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AttachKey, AttachTerminal } from './attachTerminal';
import { createEchoFilter, createInputDelivery, hasSessionSurvey } from './inputDelivery';

const fixture = (name: string): string => readFileSync(join(__dirname, '__fixtures__', 'screens', `${name}.txt`), 'utf8');

const EMPTY = fixture('input-empty');
const TYPED = fixture('input-typed');
/** `-e` capture: the session survey above an input box that holds only a dim suggestion. */
const SURVEY_ANSI = fixture('input-suggestion-ansi');
/** Plain capture of the same screen: the suggestion cannot be told from typed text. */
const SURVEY_PLAIN = fixture('input-suggestion-and-survey');

type Call = string;

type FakeTerminal = AttachTerminal & { id: number; closed: boolean };

/** Terminals share one log. `screens` is what `screen()` returns; the last entry repeats. */
function createHarness(screens: string[] | ((log: Call[]) => string), extra: { pressChangesScreen?: (key: AttachKey) => string | null } = {}) {
    const log: Call[] = [];
    const terminals: FakeTerminal[] = [];
    let reads = 0;
    let override: string | null = null;
    const openTerminal = async (): Promise<AttachTerminal> => {
        const id = terminals.length + 1;
        log.push(`open#${id}`);
        const terminal: FakeTerminal = {
            id,
            closed: false,
            screen: async () => {
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
            },
            pasteText: async (text) => {
                log.push(`paste#${id}:${text}`);
            },
            press: async (keys) => {
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

    it('send does not type into a dialog', async () => {
        const { log, openTerminal } = createHarness([fixture('permission-bash')]);
        const delivery = createInputDelivery({ openTerminal, echo: createEchoFilter(), waitInputMs: 30, ...fast });
        expect(await delivery.send('hello')).toBe('busy-input');
        expect(log).toEqual(['open#1', 'close#1']);
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
