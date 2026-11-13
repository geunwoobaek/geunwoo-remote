import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiMachineClient } from './apiMachine';
import type { Machine } from './types';
import type { ClaudeAgentHandlers } from '@/claudeAgents/daemonHandlers';

const { handlers } = vi.hoisted(() => ({
    handlers: new Map<string, (params: any) => Promise<any>>()
}));

vi.mock('socket.io-client', () => ({ io: vi.fn(() => ({ on: vi.fn(), connect: vi.fn(), emit: vi.fn(), io: { on: vi.fn() } })) }));
vi.mock('@/configuration', () => ({ configuration: { serverUrl: 'http://127.0.0.1:3005', currentCliVersion: 'test' } }));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), debugLargeJson: vi.fn() } }));
vi.mock('@/modules/common/registerCommonHandlers', () => ({ registerCommonHandlers: vi.fn() }));
vi.mock('@/utils/detectCLI', () => ({ detectCLIAvailability: vi.fn(() => ({ claude: false, codex: false, gemini: false, openclaw: false })) }));
vi.mock('@/utils/lidState', () => ({
    shouldReconnect: vi.fn(() => true),
    retainReconnectCapabilityMonitor: vi.fn(),
    releaseReconnectCapabilityMonitor: vi.fn()
}));
vi.mock('@/resume/localHappyAgentAuth', () => ({
    detectResumeSupport: vi.fn(() => ({
        rpcAvailable: false,
        requiresSameMachine: false,
        requiresHappyAgentAuth: false,
        happyAgentAuthenticated: false
    }))
}));
vi.mock('@/api/rpc/RpcHandlerManager', () => ({
    RpcHandlerManager: class {
        onSocketConnect = vi.fn();
        onSocketDisconnect = vi.fn();
        handleRequest = vi.fn(async () => '');
        registerHandler = vi.fn((method: string, handler: any) => { handlers.set(method, handler); });
        unregisterHandler = vi.fn((method: string) => { handlers.delete(method); });
        hasHandler = vi.fn((method: string) => handlers.has(method));
    }
}));

function makeMachine(): Machine {
    return {
        id: 'test-machine-id',
        metadata: {
            host: 'localhost',
            platform: 'darwin',
            happyCliVersion: 'test',
            homeDir: '/Users/tester',
            happyHomeDir: '/Users/tester/.happy',
            happyLibDir: '/Users/tester/.happy/lib'
        },
        metadataVersion: 0,
        daemonState: null,
        daemonStateVersion: 0,
        encryptionKey: new Uint8Array(32),
        encryptionVariant: 'legacy'
    };
}

describe('Claude background agent RPCs', () => {
    let claudeAgents: { [K in keyof ClaudeAgentHandlers]: ReturnType<typeof vi.fn> };

    beforeEach(() => {
        handlers.clear();
        claudeAgents = {
            list: vi.fn(async () => ({ agents: [], startSupported: true })),
            open: vi.fn(async () => ({ type: 'success', sessionId: 'happy-1' })),
            start: vi.fn(async () => ({ type: 'success', sessionId: 'happy-1', agentId: '35d81094' })),
            discard: vi.fn(async () => ({ type: 'success' })),
            revive: vi.fn(async () => ({ type: 'success', revived: true })),
            tasks: vi.fn(async () => ({ type: 'success', tasks: [], runningCount: 0, totalCount: 0, queuedInputs: 0 })),
        };
        new ApiMachineClient('fake-token', makeMachine()).setRPCHandlers({
            spawnSession: vi.fn(),
            stopSession: vi.fn(),
            requestShutdown: vi.fn(),
            claudeAgents,
        } as any);
    });

    it('registers start-claude-agent and passes the request through', async () => {
        const answer = await handlers.get('start-claude-agent')!({
            directory: '/Users/tester/project',
            name: 'fix the login bug',
            model: 'opus',
            permissionMode: 'acceptEdits',
            effort: 'high',
            approvedNewDirectoryCreation: true,
            clientRequestId: 'r1',
        });
        expect(answer).toEqual({ type: 'success', sessionId: 'happy-1', agentId: '35d81094' });
        expect(claudeAgents.start).toHaveBeenCalledWith({
            directory: '/Users/tester/project',
            name: 'fix the login bug',
            model: 'opus',
            permissionMode: 'acceptEdits',
            effort: 'high',
            approvedNewDirectoryCreation: true,
            clientRequestId: 'r1',
        });
    });

    it('does not approve folder creation unless the request does', async () => {
        await handlers.get('start-claude-agent')!({ directory: '/Users/tester/project', name: 'demo' });
        expect(claudeAgents.start).toHaveBeenCalledWith(expect.objectContaining({ approvedNewDirectoryCreation: false, clientRequestId: undefined }));
    });

    it('rejects a start without a directory or a name', async () => {
        expect(() => handlers.get('start-claude-agent')!({ name: 'demo' })).toThrow('directory is required');
        expect(() => handlers.get('start-claude-agent')!({ directory: '/Users/tester/project' })).toThrow('name is required');
        expect(claudeAgents.start).not.toHaveBeenCalled();
    });

    it('registers discard-claude-agent with the id', async () => {
        expect(await handlers.get('discard-claude-agent')!({ id: '35d81094' })).toEqual({ type: 'success' });
        expect(claudeAgents.discard).toHaveBeenCalledWith('35d81094');
        expect(() => handlers.get('discard-claude-agent')!({})).toThrow('id is required');
    });

    it('registers claude-agent-tasks with the id', async () => {
        expect(await handlers.get('claude-agent-tasks')!({ id: '35d81094' })).toMatchObject({ type: 'success', queuedInputs: 0 });
        expect(claudeAgents.tasks).toHaveBeenCalledWith('35d81094');
        expect(() => handlers.get('claude-agent-tasks')!({})).toThrow('id is required');
    });

    it('registers revive-claude-agent with the id', async () => {
        expect(await handlers.get('revive-claude-agent')!({ id: '35d81094' })).toEqual({ type: 'success', revived: true });
        expect(claudeAgents.revive).toHaveBeenCalledWith('35d81094');
        expect(() => handlers.get('revive-claude-agent')!({})).toThrow('id is required');
    });
});
