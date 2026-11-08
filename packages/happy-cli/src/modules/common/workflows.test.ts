import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { findGitRoot, listSavedWorkflows, parseWorkflowMeta } from './workflows';

describe('parseWorkflowMeta', () => {
    it('reads the name, description, when to use and phase titles', () => {
        const source = `export const meta = {
  name: 'fun-harness',
  description: "Make it fun: measure, panel, repeat",
  whenToUse: \`When a prototype survived\`,
  phases: [
    { title: 'Motive', detail: 'once' },
    { title: 'Improve', detail: 'it\\'s the core' },
  ],
}

export default async function run() { throw new Error('never run') }`;
        expect(parseWorkflowMeta(source)).toEqual({
            name: 'fun-harness',
            description: 'Make it fun: measure, panel, repeat',
            whenToUse: 'When a prototype survived',
            phases: ['Motive', 'Improve'],
        });
    });

    it('keeps the top-level name when a phase has one too', () => {
        const source = `export const meta = { phases: [{ name: 'inner' }], name: 'outer' }`;
        expect(parseWorkflowMeta(source)?.name).toBe('outer');
        expect(parseWorkflowMeta(source)?.phases).toEqual(['inner']);
    });

    it('passes over values that are not plain data, and comments', () => {
        const source = `// a saved workflow
export const meta: Meta = {
  /* the id */ name: 'deploy', // trailing
  args: makeArgs({ a: [1, 2] }),
  description: 'Ship it',
  count: 3, ok: true, none: null,
}`;
        expect(parseWorkflowMeta(source)).toEqual({ name: 'deploy', description: 'Ship it', whenToUse: undefined, phases: [] });
    });

    it('gives nothing for a script without a readable meta', () => {
        expect(parseWorkflowMeta('export default {}')).toBeNull();
        expect(parseWorkflowMeta(`export const meta = { description: 'no name' }`)).toBeNull();
        expect(parseWorkflowMeta(`export const meta = { name: 'cut off`)).toBeNull();
        expect(parseWorkflowMeta('export const meta = { name: `x${y}` }')).toBeNull();
        expect(parseWorkflowMeta(`export const meta = { name: 'a' description: 'b' }`)).toBeNull();
    });
});

describe('listSavedWorkflows', () => {
    let root: string;
    let home: string;
    let repo: string;
    let cwd: string;

    beforeAll(async () => {
        root = await mkdtemp(join(tmpdir(), 'happy-workflows-'));
        home = join(root, 'home');
        repo = join(root, 'repo');
        cwd = join(repo, 'packages', 'app');
        await mkdir(join(home, '.claude', 'workflows'), { recursive: true });
        await mkdir(join(repo, '.git'), { recursive: true });
        await mkdir(join(repo, '.claude', 'workflows'), { recursive: true });
        await mkdir(join(cwd, '.claude', 'workflows'), { recursive: true });
        await writeFile(join(home, '.claude', 'workflows', 'review.js'), `export const meta = { name: 'review', description: 'Mine, everywhere' }`);
        await writeFile(join(home, '.claude', 'workflows', 'broken.js'), `export const meta = { name: `);
        await writeFile(join(home, '.claude', 'workflows', 'notes.md'), `export const meta = { name: 'not a script' }`);
        await writeFile(join(repo, '.claude', 'workflows', 'release.mjs'), `export const meta = { name: 'release', phases: [{ title: 'Build' }] }`);
        await writeFile(join(cwd, '.claude', 'workflows', 'app-qa.ts'), `export const meta = { name: 'app-qa', description: 'QA the app' }`);
    });

    afterAll(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it('finds the folder that holds .git, or none', async () => {
        expect(await findGitRoot(cwd)).toBe(repo);
        expect(await findGitRoot(home)).toBeNull();
    });

    it('lists the session folder, its git root and the home folder, skipping what it cannot read', async () => {
        const workflows = await listSavedWorkflows(cwd, home);
        expect(workflows.map((w) => [w.scope, w.name, w.path, w.inWorkingDirectory])).toEqual([
            ['project', 'app-qa', join(cwd, '.claude', 'workflows', 'app-qa.ts'), true],
            ['project', 'release', join(repo, '.claude', 'workflows', 'release.mjs'), false],
            ['user', 'review', join(home, '.claude', 'workflows', 'review.js'), false],
        ]);
        expect(workflows[1].phases).toEqual(['Build']);
        expect(workflows[2].description).toBe('Mine, everywhere');
    });

    it('counts a session started in the home folder once, as the user', async () => {
        const workflows = await listSavedWorkflows(home, home);
        expect(workflows.map((w) => [w.scope, w.name, w.inWorkingDirectory])).toEqual([['user', 'review', true]]);
    });

    it('lists only the user folder without a session folder, and nothing when there is none', async () => {
        expect((await listSavedWorkflows(null, home)).map((w) => w.name)).toEqual(['review']);
        expect(await listSavedWorkflows(join(root, 'missing'), join(root, 'nobody'))).toEqual([]);
    });
});
