import { describe, expect, it } from 'vitest';
import { createAgentCwdTracker, transcriptLineCwd } from './agentCwd';

const root = '/Users/me/games';
const worktree = `${root}/.claude/worktrees/trapmark`;
const line = (cwd: unknown, extra: Record<string, unknown> = {}) => ({ type: 'assistant', uuid: 'u', cwd, ...extra });

function tracked(initial: string | null = root) {
    const published: string[] = [];
    const tracker = createAgentCwdTracker({ initial, publish: (cwd) => published.push(cwd) });
    return { tracker, published };
}

describe('agentCwd', () => {
    it('reads the folder a main-agent line names and ignores sub-agents and lines without one', () => {
        expect(transcriptLineCwd(line(worktree))).toBe(worktree);
        expect(transcriptLineCwd(line(worktree, { isSidechain: true }))).toBeNull();
        expect(transcriptLineCwd(line(undefined))).toBeNull();
        expect(transcriptLineCwd(line('  '))).toBeNull();
        expect(transcriptLineCwd(line(42))).toBeNull();
        expect(transcriptLineCwd(null)).toBeNull();
    });

    it('publishes nothing while Claude stays in the folder the session started in', () => {
        const { tracker, published } = tracked();
        tracker.observe(line(root));
        tracker.observe(line(root));
        expect(published).toEqual([]);
    });

    it('publishes a move into a worktree once, however many lines repeat it', () => {
        const { tracker, published } = tracked();
        tracker.observe(line(root));
        tracker.observe(line(worktree));
        tracker.observe(line(worktree));
        tracker.observe(line(worktree, { type: 'user' }));
        expect(published).toEqual([worktree]);
    });

    it('publishes the way back out of the worktree too', () => {
        const { tracker, published } = tracked();
        tracker.observe(line(worktree));
        tracker.observe(line(root));
        expect(published).toEqual([worktree, root]);
    });

    it('does not move the main agent when a sub-agent works in a worktree of its own', () => {
        const { tracker, published } = tracked();
        tracker.observe(line(`${root}/.claude/worktrees/agent-1`, { isSidechain: true }));
        expect(published).toEqual([]);
    });

    it('publishes a restart in another folder and ignores one that names none', () => {
        const { tracker, published } = tracked(worktree);
        tracker.reset(undefined);
        tracker.reset('');
        tracker.reset(root);
        tracker.observe(line(root));
        expect(published).toEqual([root]);
    });
});
