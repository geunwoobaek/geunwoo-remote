import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Boots the real daemon closure (like run.resume.test.ts) with every outside world faked:
// no network, no real children, no tmux, no `claude`.
const mocks = vi.hoisted(() => ({
  handlers: null as any,
  webhook: null as any,
  persisted: {} as Record<string, any>,
  spawn: vi.fn(),
  runClaudeBackground: vi.fn(),
  stopClaudeAgent: vi.fn(async () => undefined),
  removeClaudeAgent: vi.fn(async () => undefined),
  persistSession: vi.fn(),
  logger: { debug: vi.fn(), debugLargeJson: vi.fn(), warn: vi.fn() },
}));

vi.mock('axios', () => ({ default: { get: vi.fn() } }));
vi.mock('os', async (importOriginal) => {
  const original = await importOriginal<typeof import('os')>();
  return { ...original, default: { ...original, homedir: () => process.env.HAPPY_HOME_DIR! } };
});
vi.mock('fs/promises', () => ({ default: { access: vi.fn(async () => undefined) } }));
vi.mock('@/ui/logger', () => ({ logger: mocks.logger }));
vi.mock('@/configuration', () => ({ configuration: { serverUrl: 'http://test.invalid', happyHomeDir: '/test-only' } }));
vi.mock('@/ui/auth', () => ({ authAndSetupMachineIfNeeded: async () => ({ credentials: { token: 'test-token' }, machineId: 'machine-1' }) }));
vi.mock('@/ui/doctor', () => ({ getEnvironmentInfo: () => ({}) }));
vi.mock('@/utils/caffeinate', () => ({ startCaffeinate: () => false, stopCaffeinate: vi.fn() }));
vi.mock('@/utils/detectCLI', () => ({ detectCLIAvailability: () => ({}) }));
vi.mock('@/utils/spawnHappyCLI', () => ({ spawnHappyCLI: mocks.spawn }));
vi.mock('@/utils/tmux', () => ({ isTmuxAvailable: async () => false }));
vi.mock('@/resume/localHappyAgentAuth', () => ({ detectResumeSupport: () => ({}), hasLocalHappyAgentAuth: () => false }));
vi.mock('@/claudeAgents/agentsList', async (importOriginal) => ({
  mirrorHandoffEnv: (await importOriginal<typeof import('@/claudeAgents/agentsList')>()).mirrorHandoffEnv,
  resolveClaudeBinary: async () => '/fake/claude',
  fetchClaudeAgents: async () => [{
    id: 'abc12345', sessionId: 'session-abc', name: 'demo-agent', cwd: '/Users/tester/project',
    pid: 1, status: 'idle', state: null, startedAt: 1,
  }],
  runClaudeBackground: mocks.runClaudeBackground,
  stopClaudeAgent: mocks.stopClaudeAgent,
  removeClaudeAgent: mocks.removeClaudeAgent,
}));
vi.mock('@/claudeAgents/attachTerminal', () => ({ isTmuxInstalled: async () => true }));
vi.mock('./happyTerminalBoot', () => ({ startHappyTerminalDaemon: vi.fn() }));
vi.mock('@/persistence', () => ({
  readPersistedSessions: () => mocks.persisted,
  persistSession: mocks.persistSession, markSessionStopped: vi.fn(), writeDaemonState: vi.fn(), readDaemonState: vi.fn(),
  acquireDaemonLock: async () => ({}), releaseDaemonLock: vi.fn(),
}));
vi.mock('./controlClient', () => ({
  isDaemonRunningCurrentlyInstalledHappyVersion: async () => false,
  stopDaemon: vi.fn(), cleanupDaemonState: vi.fn(),
}));
vi.mock('./controlServer', () => ({ startDaemonControlServer: async (options: any) => {
  mocks.webhook = options.onHappySessionWebhook;
  return { port: 0, stop: vi.fn() };
} }));
vi.mock('@/api/api', () => ({ ApiClient: { create: async () => ({
  getOrCreateMachine: async () => ({ id: 'machine-1' }),
  sessionAccess: async () => 'owned',
  machineSyncClient: () => ({
    setRPCHandlers: (handlers: any) => { mocks.handlers = handlers; },
    connect: () => { throw new Error('test boot complete'); },
  }),
}) } }));

import { startDaemon } from './run';

const dataKeyBase64 = Buffer.alloc(32, 1).toString('base64');
const mirrorMetadata = { path: '/Users/tester/project', machineId: 'machine-1', flavor: 'claude', claudeAgentId: 'abc12345' };
const storedMirror = {
  encryptionKey: dataKeyBase64, encryptionVariant: 'dataKey', seq: 7, metadataVersion: 3, agentStateVersion: 4,
  metadata: { ...mirrorMetadata, hostPid: 999 }, savedAt: Date.now() - 60_000, lastAliveAt: Date.now() - 60_000,
};

async function boot() {
  await expect(startDaemon()).rejects.toThrow('test exit');
}

describe('daemon Claude background agents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.persisted = {};
    vi.spyOn(process, 'on').mockReturnValue(process);
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('test exit'); });
    // Only the pids this test spawns are alive; a stored pid from "a previous daemon" is gone.
    vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === 999) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('opens a fresh mirror in the agent directory and lists it afterwards', async () => {
    await boot();
    mocks.spawn.mockImplementation(() => {
      queueMicrotask(() => mocks.webhook('happy-new', { ...mirrorMetadata, hostPid: 12345 }, {
        encryptionKey: new Uint8Array(32), encryptionVariant: 'dataKey', seq: 0, metadataVersion: 0, agentStateVersion: 0,
      }));
      return { pid: 12345, on: vi.fn() };
    });
    expect(await mocks.handlers.claudeAgents.open('abc12345')).toEqual({ type: 'success', sessionId: 'happy-new' });
    expect(mocks.spawn).toHaveBeenCalledWith(
      ['claude-agent-mirror', 'abc12345'],
      expect.objectContaining({ cwd: '/Users/tester/project' }),
    );
    expect(mocks.spawn.mock.calls[0][1].env.HAPPY_RECONNECT_SESSION_ID).toBeUndefined();
    // The mirror is handed what the daemon just found out instead of asking again.
    expect(mocks.spawn.mock.calls[0][1].env.HAPPY_MIRROR_CLAUDE_PATH).toBe('/fake/claude');
    expect(JSON.parse(mocks.spawn.mock.calls[0][1].env.HAPPY_MIRROR_AGENTS)).toMatchObject([{ id: 'abc12345', kind: 'background' }]);

    const listing = await mocks.handlers.claudeAgents.list();
    expect(listing.agents[0]).toMatchObject({ id: 'abc12345', mirrorSessionId: 'happy-new' });
    // The mirror is running: opening again must not start a second one.
    expect(await mocks.handlers.claudeAgents.open('abc12345')).toEqual({ type: 'success', sessionId: 'happy-new' });
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it('starts a background agent in the folder, opens its mirror, and discards only what it started', async () => {
    const saved = { CLAUDECODE: process.env.CLAUDECODE, CLAUDE_CODE_ENTRYPOINT: process.env.CLAUDE_CODE_ENTRYPOINT };
    process.env.CLAUDECODE = '1';
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
    try {
      await boot();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
    mocks.runClaudeBackground.mockResolvedValue({
      stdout: 'backgrounded · abc12345 · demo-agent (idle — send a prompt to start)\n', stderr: '', code: 0,
    });
    mocks.spawn.mockImplementation(() => {
      queueMicrotask(() => mocks.webhook('happy-new', { ...mirrorMetadata, hostPid: 12345 }, {
        encryptionKey: new Uint8Array(32), encryptionVariant: 'dataKey', seq: 0, metadataVersion: 0, agentStateVersion: 0,
      }));
      return { pid: 12345, on: vi.fn() };
    });

    expect(await mocks.handlers.claudeAgents.start({ directory: '/Users/tester/project', name: 'demo-agent', model: 'opus' }))
      .toEqual({ type: 'success', sessionId: 'happy-new', agentId: 'abc12345' });
    const [claudePath, cwd, args, env] = mocks.runClaudeBackground.mock.calls[0];
    expect([claudePath, cwd, args]).toEqual(['/fake/claude', '/Users/tester/project', ['--bg', '--name', 'demo-agent', '--model', 'opus']]);
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(mocks.spawn).toHaveBeenCalledWith(['claude-agent-mirror', 'abc12345'], expect.objectContaining({ cwd: '/Users/tester/project' }));
    expect((await mocks.handlers.claudeAgents.list()).startSupported).toBe(true);

    expect(await mocks.handlers.claudeAgents.discard('def67890')).toMatchObject({ type: 'error', code: 'not-started-here' });
    expect(mocks.stopClaudeAgent).not.toHaveBeenCalled();
    expect(await mocks.handlers.claudeAgents.discard('abc12345')).toEqual({ type: 'success' });
    expect(mocks.stopClaudeAgent).toHaveBeenCalledWith('/fake/claude', 'abc12345', expect.not.objectContaining({ CLAUDECODE: '1' }));
    expect(mocks.removeClaudeAgent).toHaveBeenCalledWith('/fake/claude', 'abc12345', expect.any(Object));
  });

  it('reconnects a stopped mirror with its stored keys', async () => {
    mocks.persisted = { 'happy-old': storedMirror };
    await boot();
    mocks.spawn.mockImplementation(() => {
      queueMicrotask(() => mocks.webhook('happy-old', { ...mirrorMetadata, hostPid: 12345 }));
      return { pid: 12345, on: vi.fn() };
    });
    expect(await mocks.handlers.claudeAgents.open('abc12345')).toEqual({ type: 'success', sessionId: 'happy-old' });
    expect(mocks.spawn.mock.calls[0][0]).toEqual(['claude-agent-mirror', 'abc12345']);
    expect(mocks.spawn.mock.calls[0][1].env).toMatchObject({
      HAPPY_RECONNECT_SESSION_ID: 'happy-old',
      HAPPY_RECONNECT_ENCRYPTION_KEY: dataKeyBase64,
      HAPPY_RECONNECT_ENCRYPTION_VARIANT: 'dataKey',
      HAPPY_RECONNECT_SEQ: '7',
      HAPPY_RECONNECT_METADATA_VERSION: '3',
      HAPPY_RECONNECT_AGENT_STATE_VERSION: '4',
    });
  });

  it('does not start a second mirror while the first is still starting after a timeout', async () => {
    vi.useFakeTimers();
    await boot();
    mocks.spawn.mockReturnValue({ pid: 12345, on: vi.fn() });
    const first = mocks.handlers.claudeAgents.open('abc12345');
    // The 15 s webhook timeout, then the extra wait for a mirror that is still running.
    await vi.advanceTimersByTimeAsync(31_000);
    expect(await first).toMatchObject({ type: 'error', errorMessage: expect.stringContaining('timeout') });
    const second = mocks.handlers.claudeAgents.open('abc12345');
    await vi.advanceTimersByTimeAsync(16_000);
    expect(await second).toMatchObject({ type: 'error' });
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it('opens a mirror whose webhook arrives after the timeout', async () => {
    vi.useFakeTimers();
    await boot();
    mocks.spawn.mockReturnValue({ pid: 12345, on: vi.fn() });
    const first = mocks.handlers.claudeAgents.open('abc12345');
    await vi.advanceTimersByTimeAsync(16_000);
    mocks.webhook('happy-late', { ...mirrorMetadata, hostPid: 12345 }, {
      encryptionKey: new Uint8Array(32), encryptionVariant: 'dataKey', seq: 0, metadataVersion: 0, agentStateVersion: 0,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await first).toEqual({ type: 'success', sessionId: 'happy-late' });
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  const REFUSAL = 'This session mirrors a Mac background session. Open it from the background session list.';
  // A mirror process of an earlier daemon that is still running (pid 888 answers kill(0)).
  const runningStoredMirror = { ...storedMirror, metadata: { ...mirrorMetadata, hostPid: 888 }, savedAt: Date.now() - 1000, lastAliveAt: Date.now() - 1000 };

  it('refuses to resume a live tracked mirror with the mirror refusal, not success', async () => {
    await boot();
    mocks.spawn.mockImplementation(() => {
      queueMicrotask(() => mocks.webhook('happy-new', { ...mirrorMetadata, hostPid: 12345 }, {
        encryptionKey: new Uint8Array(32), encryptionVariant: 'dataKey', seq: 0, metadataVersion: 0, agentStateVersion: 0,
      }));
      return { pid: 12345, on: vi.fn() };
    });
    await mocks.handlers.claudeAgents.open('abc12345');
    expect(await mocks.handlers.resumeSession('happy-new')).toEqual({ type: 'error', errorMessage: REFUSAL });
  });

  it('refuses to resume a mirror whose persisted process from a previous daemon is alive', async () => {
    mocks.persisted = { 'happy-old': runningStoredMirror };
    await boot();
    expect(await mocks.handlers.resumeSession('happy-old')).toEqual({ type: 'error', errorMessage: REFUSAL });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('after a daemon restart lists and opens a still-running mirror without spawning', async () => {
    mocks.persisted = { 'happy-old': runningStoredMirror };
    await boot();
    const listing = await mocks.handlers.claudeAgents.list();
    expect(listing.agents[0]).toMatchObject({ id: 'abc12345', mirrorSessionId: 'happy-old' });
    expect(await mocks.handlers.claudeAgents.open('abc12345')).toEqual({ type: 'success', sessionId: 'happy-old' });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('after a daemon restart with a dead mirror process shows no mirror and reconnects normally', async () => {
    mocks.persisted = { 'happy-old': storedMirror };
    await boot();
    const listing = await mocks.handlers.claudeAgents.list();
    expect('mirrorSessionId' in listing.agents[0]).toBe(false);
    mocks.spawn.mockImplementation(() => {
      queueMicrotask(() => mocks.webhook('happy-old', { ...mirrorMetadata, hostPid: 12345 }));
      return { pid: 12345, on: vi.fn() };
    });
    expect(await mocks.handlers.claudeAgents.open('abc12345')).toEqual({ type: 'success', sessionId: 'happy-old' });
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it('refuses to resume a mirror session', async () => {
    mocks.persisted = { 'happy-old': storedMirror };
    await boot();
    expect(await mocks.handlers.resumeSession('happy-old')).toEqual({
      type: 'error',
      errorMessage: 'This session mirrors a Mac background session. Open it from the background session list.',
    });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
