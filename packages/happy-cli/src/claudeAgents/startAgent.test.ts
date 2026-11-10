import { describe, expect, it } from 'vitest';
import { agentNameFrom, buildBgArgs, claudeBgEnvironment, isUntrustedOutput, parseBackgroundedId } from './startAgent';

describe('parseBackgroundedId', () => {
    it('finds the id after a warning line', () => {
        expect(parseBackgroundedId('warning: something\nbackgrounded · 35d81094 · demo (idle — send a prompt to start)\n')).toBe('35d81094');
    });

    it('returns null when no backgrounded line is printed', () => {
        expect(parseBackgroundedId('error\n')).toBeNull();
    });
});

describe('isUntrustedOutput', () => {
    it('recognizes the untrusted workspace refusal', () => {
        expect(isUntrustedOutput('Workspace not trusted. Run `claude` in /Users/tester/project once and accept the trust prompt, then retry.\n')).toBe(true);
        expect(isUntrustedOutput('backgrounded · 35d81094 · demo (idle — send a prompt to start)\n')).toBe(false);
    });
});

describe('buildBgArgs', () => {
    it('drops Claude defaults and keeps effort', () => {
        expect(buildBgArgs({ name: 'demo', permissionMode: 'default', model: 'default', effort: 'high' }))
            .toEqual(['--bg', '--name', 'demo', '--effort', 'high']);
    });

    it('forwards a concrete permission mode and model', () => {
        expect(buildBgArgs({ name: 'demo', permissionMode: 'acceptEdits', model: 'opus' }))
            .toEqual(['--bg', '--name', 'demo', '--permission-mode', 'acceptEdits', '--model', 'opus']);
    });

    it('passes only the name when nothing else is chosen', () => {
        expect(buildBgArgs({ name: 'demo' })).toEqual(['--bg', '--name', 'demo']);
    });
});

describe('agentNameFrom', () => {
    it('uses the trimmed first line', () => {
        expect(agentNameFrom('  fix the login bug\nmore', '/Users/tester/project')).toBe('fix the login bug');
    });

    it('cuts a long first line to 40 characters', () => {
        const line = 'a'.repeat(30) + 'b'.repeat(30);
        expect(agentNameFrom(line, '/Users/tester/project')).toBe(line.slice(0, 40));
    });

    it('falls back to the folder name for a blank message', () => {
        expect(agentNameFrom('   ', '/Users/tester/project')).toBe('project');
        expect(agentNameFrom('', '/Users/tester/project/')).toBe('project');
    });

    it('never starts with a dash, so the name cannot read as an option', () => {
        expect(agentNameFrom('--help me', '/Users/tester/project')).toBe('help me');
        expect(agentNameFrom('---', '/Users/tester/project')).toBe('project');
    });
});

describe('claudeBgEnvironment', () => {
    it('removes Claude Code session markers and keeps configuration', () => {
        expect(claudeBgEnvironment({
            PATH: '/usr/bin',
            CLAUDECODE: '1',
            CLAUDE_CODE_ENTRYPOINT: 'cli',
            CLAUDE_CODE_SSE_PORT: '1234',
            CLAUDE_CODE_OAUTH_TOKEN: 'token',
        })).toEqual({ PATH: '/usr/bin', CLAUDE_CODE_OAUTH_TOKEN: 'token' });
    });
});
