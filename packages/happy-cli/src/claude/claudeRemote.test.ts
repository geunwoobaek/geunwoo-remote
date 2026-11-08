import { beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeRemote } from './claudeRemote';
import { query } from '@/claude/sdk';
import type { EnhancedMode } from './loop';

// No provider process, credentials, transcript watcher, or real log files.
vi.mock('@/lib', () => ({ logger: { debug: vi.fn(), debugLargeJson: vi.fn() } }));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), debugLargeJson: vi.fn() } }));
vi.mock('./utils/claudeCheckSession', () => ({ claudeCheckSession: () => true }));
vi.mock('./utils/path', () => ({ getProjectPath: () => '/fixture/claude-project' }));
vi.mock('@/modules/watcher/awaitFileExist', () => ({ awaitFileExist: async () => true }));

vi.mock('@/claude/sdk', () => ({
    query: vi.fn(),
    AbortError: class AbortError extends Error {},
}));

const mode: EnhancedMode = {
    permissionMode: 'default',
};

describe('claudeRemote', () => {
    beforeEach(() => {
        vi.mocked(query).mockReset();
    });

    const expired = 'Failed to authenticate: OAuth session expired and could not be refreshed';
    const authAssistant = {
        type: 'assistant',
        error: 'authentication_failed',
        parent_tool_use_id: null,
        message: { role: 'assistant', content: [{ type: 'text', text: expired }] },
    };

    async function runMessages(sdkMessages: unknown[]) {
        vi.mocked(query).mockReturnValue({
            async *[Symbol.asyncIterator]() { yield* sdkMessages; },
        } as any);
        const onReady = vi.fn();
        const onCompletionEvent = vi.fn();
        const onMessage = vi.fn();
        const nextMessage = vi.fn()
            .mockResolvedValueOnce({ message: 'Original prompt', mode })
            .mockResolvedValue(null);
        await claudeRemote({
            sessionId: null,
            path: '/fixture/project',
            allowedTools: [],
            hookSettingsPath: '/fixture/settings.json',
            nextMessage, onReady, onCompletionEvent, onMessage,
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false,
            onSessionFound: vi.fn(),
        });
        return { onReady, onCompletionEvent, onMessage, nextMessage };
    }

    it('explains host OAuth expiry once and closes the turn as failed', async () => {
        const callbacks = await runMessages([
            authAssistant,
            { type: 'result', subtype: 'success', is_error: true, result: expired },
        ]);
        expect(callbacks.onCompletionEvent).toHaveBeenCalledOnce();
        expect(callbacks.onCompletionEvent).toHaveBeenCalledWith(expect.stringContaining('claude auth login'));
        expect(callbacks.onCompletionEvent).toHaveBeenCalledWith(expect.stringContaining('host'));
        expect(callbacks.onReady).toHaveBeenCalledWith('failed');
        expect(query).toHaveBeenCalledOnce();
    });

    it('recognizes the result-only SDK error surface', async () => {
        const callbacks = await runMessages([
            { type: 'result', subtype: 'error_during_execution', is_error: true, errors: [expired] },
        ]);
        expect(callbacks.onCompletionEvent).toHaveBeenCalledWith(expect.stringContaining('claude auth login'));
        expect(callbacks.onReady).toHaveBeenCalledWith('failed');
    });

    it('allows a later user retry in the same session without replaying the failed prompt', async () => {
        const received: unknown[] = [];
        vi.mocked(query).mockImplementation(({ prompt }) => ({
            async *[Symbol.asyncIterator]() {
                const input = (prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
                received.push((await input.next()).value);
                yield authAssistant;
                yield { type: 'result', subtype: 'success', is_error: true, result: expired };
                // Models the host login being fixed before the user sends a new prompt.
                received.push((await input.next()).value);
                yield { ...authAssistant, error: undefined, message: { role: 'assistant', content: [{ type: 'text', text: 'Recovered' }] } };
                yield { type: 'result', subtype: 'success', is_error: false, result: 'Recovered' };
                expect((await input.next()).done).toBe(true);
            },
        } as any));
        const onReady = vi.fn();
        const onCompletionEvent = vi.fn();
        const nextMessage = vi.fn()
            .mockResolvedValueOnce({ message: 'Original prompt', mode })
            .mockResolvedValueOnce({ message: 'User retry after login', mode })
            .mockResolvedValue(null);
        await claudeRemote({
            sessionId: 'fixture-session', path: '/fixture/project', allowedTools: [], hookSettingsPath: '/fixture/settings.json',
            nextMessage, onReady, onCompletionEvent,
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false, onSessionFound: vi.fn(), onMessage: vi.fn(),
        });
        expect(received).toEqual([
            expect.objectContaining({ message: { role: 'user', content: 'Original prompt' } }),
            expect.objectContaining({ message: { role: 'user', content: 'User retry after login' } }),
        ]);
        expect(onReady.mock.calls).toEqual([['failed'], []]);
        expect(onCompletionEvent).toHaveBeenCalledOnce();
        expect(query).toHaveBeenCalledOnce();
        expect(query).toHaveBeenCalledWith(expect.objectContaining({ options: expect.objectContaining({ resume: 'fixture-session' }) }));
    });

    it('does not interpret ordinary assistant text or a successful result as an auth failure', async () => {
        const callbacks = await runMessages([
            { ...authAssistant, error: undefined },
            { type: 'result', subtype: 'success', is_error: false, result: expired },
        ]);
        expect(callbacks.onCompletionEvent).not.toHaveBeenCalled();
        expect(callbacks.onReady).toHaveBeenCalledWith();
    });

    it.each(['/clear', 'Ordinary prompt'])('awaits the async ready callback for %s', async prompt => {
        vi.mocked(query).mockReturnValue({
            async *[Symbol.asyncIterator]() { yield { type: 'result', subtype: 'success', is_error: false, result: 'Done' }; },
        } as any);
        const failure = new Error('Fixture ready callback failed');
        const nextMessage = vi.fn().mockResolvedValueOnce({ message: prompt, mode }).mockResolvedValue(null);
        await expect(claudeRemote({
            sessionId: null, path: '/fixture/project', allowedTools: [], hookSettingsPath: '/fixture/settings.json',
            nextMessage,
            onReady: async () => { throw failure; },
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false, onSessionFound: vi.fn(), onMessage: vi.fn(),
        })).rejects.toBe(failure);
        // The steering pump may hold one call in flight (it resolves null here); nothing beyond that.
        expect(nextMessage.mock.calls.length).toBeLessThanOrEqual(2);
    });

    it('does not report successful compaction after a provider auth failure', async () => {
        vi.mocked(query).mockReturnValue({
            async *[Symbol.asyncIterator]() {
                yield authAssistant;
                yield { type: 'result', subtype: 'success', is_error: true, result: expired };
            },
        } as any);
        const onCompletionEvent = vi.fn();
        await claudeRemote({
            sessionId: null, path: '/fixture/project', allowedTools: [], hookSettingsPath: '/fixture/settings.json',
            nextMessage: vi.fn().mockResolvedValueOnce({ message: '/compact', mode }).mockResolvedValue(null),
            onReady: vi.fn(), onCompletionEvent,
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            isAborted: () => false, onSessionFound: vi.fn(), onMessage: vi.fn(),
        });
        expect(onCompletionEvent).not.toHaveBeenCalledWith('Compaction completed');
        expect(onCompletionEvent).toHaveBeenCalledWith(expect.stringContaining('claude auth login'));
    });

    it('marks /clear as a completed reset turn', async () => {
        const callbackOrder: string[] = [];
        const onCompletionEvent = vi.fn((message: string) => {
            callbackOrder.push(`event:${message}`);
        });
        const onSessionReset = vi.fn(() => {
            callbackOrder.push('reset');
        });
        const onReady = vi.fn(() => {
            callbackOrder.push('ready');
        });

        await claudeRemote({
            sessionId: null,
            path: process.cwd(),
            allowedTools: [],
            hookSettingsPath: '/tmp/happy-test-settings.json',
            nextMessage: async () => ({
                message: '/clear',
                mode,
            }),
            onReady,
            canCallTool: async () => ({ behavior: 'allow' }) as any,
            isAborted: () => false,
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            onMessage: vi.fn(),
            onCompletionEvent,
            onSessionReset,
        });

        expect(onCompletionEvent).toHaveBeenCalledWith('Context was reset');
        expect(onSessionReset).toHaveBeenCalledOnce();
        expect(onReady).toHaveBeenCalledOnce();
        expect(callbackOrder).toEqual(['event:Context was reset', 'reset', 'ready']);
    });

    it('marks assistant messages from /compact as compact summaries', async () => {
        const setPermissionMode = vi.fn();
        vi.mocked(query).mockReturnValue({
            setPermissionMode,
            async *[Symbol.asyncIterator]() {
                yield {
                    type: 'assistant',
                    message: {
                        role: 'assistant',
                        content: [{ type: 'text', text: 'Long compaction summary' }],
                    },
                };
                yield {
                    type: 'result',
                    subtype: 'success',
                };
            },
        } as any);

        const onMessage = vi.fn();
        let messageCount = 0;

        await claudeRemote({
            sessionId: null,
            path: process.cwd(),
            allowedTools: [],
            hookSettingsPath: '/tmp/happy-test-settings.json',
            nextMessage: async () => {
                messageCount += 1;
                return messageCount === 1
                    ? {
                        message: '/compact',
                        mode,
                    }
                    : null;
            },
            onReady: vi.fn(),
            canCallTool: async () => ({ behavior: 'allow' }) as any,
            isAborted: () => false,
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            onMessage,
            onCompletionEvent: vi.fn(),
            onSessionReset: vi.fn(),
        });

        expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'assistant',
            isCompactSummary: true,
        }));
    });

    describe('steering', () => {
        const assistant = (text: string) => ({
            type: 'assistant',
            parent_tool_use_id: null,
            message: { role: 'assistant', content: [{ type: 'text', text }] },
        });
        const success = { type: 'result', subtype: 'success', is_error: false, result: 'ok' };
        const notYet = Symbol('not delivered before result');
        const baseOpts = {
            sessionId: null, path: '/fixture/project', allowedTools: [], hookSettingsPath: '/fixture/settings.json',
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }) as any,
            isAborted: () => false, onSessionFound: vi.fn(), onMessage: vi.fn(),
        };

        it('delivers a message sent mid-turn to Claude before the turn ends', async () => {
            const received: unknown[] = [];
            vi.mocked(query).mockImplementation(({ prompt }) => ({
                async *[Symbol.asyncIterator]() {
                    const input = (prompt as AsyncIterable<any>)[Symbol.asyncIterator]();
                    received.push((await input.next()).value);
                    yield assistant('working');
                    // Claude is still mid-turn here; the steering message must already be on its way.
                    const steer = await Promise.race([
                        input.next().then((r) => r.value),
                        new Promise((resolve) => setTimeout(() => resolve(notYet), 200)),
                    ]);
                    received.push(steer);
                    yield success;
                    expect((await input.next()).done).toBe(true);
                },
            } as any));
            const nextMessage = vi.fn()
                .mockResolvedValueOnce({ message: 'Original prompt', mode })
                .mockResolvedValueOnce({ message: 'Also add tests', mode })
                .mockResolvedValue(null);
            const onReady = vi.fn();

            await claudeRemote({ ...baseOpts, nextMessage, onReady });

            expect(received).toEqual([
                expect.objectContaining({ message: { role: 'user', content: 'Original prompt' } }),
                expect.objectContaining({ message: { role: 'user', content: 'Also add tests' } }),
            ]);
            expect(onReady).toHaveBeenCalledOnce();
            expect(query).toHaveBeenCalledOnce();
        });

        it('stops asking for messages once nextMessage returns null', async () => {
            vi.mocked(query).mockImplementation(({ prompt }) => ({
                async *[Symbol.asyncIterator]() {
                    const input = (prompt as AsyncIterable<any>)[Symbol.asyncIterator]();
                    await input.next();
                    yield assistant('working');
                    // Ending the input mid-turn (mode change pending) still lets the turn finish.
                    expect((await input.next()).done).toBe(true);
                    yield success;
                },
            } as any));
            const nextMessage = vi.fn()
                .mockResolvedValueOnce({ message: 'Original prompt', mode })
                .mockResolvedValue(null);
            const onReady = vi.fn();

            await claudeRemote({ ...baseOpts, nextMessage, onReady });

            expect(nextMessage).toHaveBeenCalledTimes(2);
            expect(onReady).toHaveBeenCalledOnce();
        });

        it('does not request another message after the query exits early', async () => {
            vi.mocked(query).mockImplementation(({ prompt }) => ({
                async *[Symbol.asyncIterator]() {
                    const input = (prompt as AsyncIterable<any>)[Symbol.asyncIterator]();
                    await input.next();
                    throw new Error('claude process crashed');
                },
            } as any));
            let releaseSecond: (value: null) => void = () => {};
            const nextMessage = vi.fn()
                .mockResolvedValueOnce({ message: 'Original prompt', mode })
                .mockImplementationOnce(() => new Promise((resolve) => { releaseSecond = resolve; }))
                .mockResolvedValue({ message: 'must stay queued', mode });

            await expect(claudeRemote({ ...baseOpts, nextMessage, onReady: vi.fn() })).rejects.toThrow('claude process crashed');
            releaseSecond(null);
            await new Promise((resolve) => setTimeout(resolve, 10));

            expect(nextMessage).toHaveBeenCalledTimes(2);
        });

        it('hands back a message that arrives just after the query closed', async () => {
            vi.mocked(query).mockImplementation(({ prompt }) => ({
                async *[Symbol.asyncIterator]() {
                    const input = (prompt as AsyncIterable<any>)[Symbol.asyncIterator]();
                    await input.next();
                    throw new Error('claude process crashed');
                },
            } as any));
            let releaseSecond: (value: unknown) => void = () => {};
            const nextMessage = vi.fn()
                .mockResolvedValueOnce({ message: 'Original prompt', mode })
                .mockImplementationOnce(() => new Promise((resolve) => { releaseSecond = resolve; }))
                .mockResolvedValue({ message: 'must stay queued', mode });
            const onUndeliverable = vi.fn();

            await expect(claudeRemote({ ...baseOpts, nextMessage, onUndeliverable, onReady: vi.fn() })).rejects.toThrow('claude process crashed');
            releaseSecond({ message: 'Sent as the turn died', mode });
            await new Promise((resolve) => setTimeout(resolve, 10));

            expect(onUndeliverable).toHaveBeenCalledExactlyOnceWith({ message: 'Sent as the turn died', mode });
            expect(nextMessage).toHaveBeenCalledTimes(2);
        });

        it('marks the session as thinking again when a message arrives after the result', async () => {
            vi.mocked(query).mockImplementation(({ prompt }) => ({
                async *[Symbol.asyncIterator]() {
                    const input = (prompt as AsyncIterable<any>)[Symbol.asyncIterator]();
                    await input.next();
                    yield success;
                    await input.next();
                    yield assistant('second turn');
                    yield success;
                    expect((await input.next()).done).toBe(true);
                },
            } as any));
            let releaseSecond: (value: unknown) => void = () => {};
            const nextMessage = vi.fn()
                .mockResolvedValueOnce({ message: 'Original prompt', mode })
                .mockImplementationOnce(() => new Promise((resolve) => { releaseSecond = resolve; }))
                .mockResolvedValue(null);
            const onThinkingChange = vi.fn();
            const onReady = vi.fn(() => { releaseSecond({ message: 'Follow-up', mode }); });

            await claudeRemote({ ...baseOpts, nextMessage, onReady, onThinkingChange });

            expect(onThinkingChange.mock.calls).toEqual([[true], [false], [true], [false]]);
            expect(onReady).toHaveBeenCalledTimes(2);
        });
    });
});
