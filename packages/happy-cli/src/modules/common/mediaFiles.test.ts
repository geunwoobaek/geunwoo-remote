import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile, symlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { captureArguments, captureStatus, mediaReadPolicy, readFileChunk, MAX_CHUNK_BYTES } from './mediaFiles';
import { validatePath } from './pathSecurity';

describe('mediaFiles', () => {
    let root: string;
    let work: string;
    let outside: string;

    beforeAll(async () => {
        root = await mkdtemp(join(tmpdir(), 'happy-media-'));
        work = join(root, 'work');
        outside = join(root, 'outside');
        await mkdir(work);
        await mkdir(outside);
        await writeFile(join(work, 'notes.txt'), 'hello');
        await writeFile(join(outside, 'shot.PNG'), Buffer.from([1, 2, 3]));
        await writeFile(join(outside, 'secret.key'), 'nope');
        await symlink(join(outside, 'secret.key'), join(outside, 'disguised.png'));
        await writeFile(join(outside, 'clip.mov'), Buffer.alloc(10, 7));
        await writeFile(join(outside, 'page.html'), '<p>hi</p>');
        await mkdir(join(outside, '.config'));
        await writeFile(join(outside, '.config', 'settings.js'), 'token');
        await writeFile(join(outside, '.config', 'shot.png'), Buffer.from([1]));
        await writeFile(join(outside, 'data.json'), '{}');
    });

    afterAll(async () => {
        await rm(root, { recursive: true, force: true });
    });

    const policy = (path: string) => mediaReadPolicy(path, (p) => validatePath(p, work));

    it('allows the working directory and media anywhere, by real name', async () => {
        expect((await policy('notes.txt')).valid).toBe(true);
        expect(await policy(join(outside, 'shot.PNG'))).toMatchObject({ valid: true });
        expect((await policy(join(outside, 'clip.mov'))).valid).toBe(true);
    });

    it('allows page files outside hidden folders, pictures even inside them', async () => {
        expect((await policy(join(outside, 'page.html'))).valid).toBe(true);
        expect((await policy(join(outside, '.config', 'shot.png'))).valid).toBe(true);
        expect((await policy(join(outside, '.config', 'settings.js'))).valid).toBe(false);
        expect((await policy(join(outside, 'data.json'))).valid).toBe(false);
    });

    it('refuses other files outside, links dressed as pictures, and missing files', async () => {
        expect((await policy(join(outside, 'secret.key'))).valid).toBe(false);
        expect((await policy(join(outside, 'disguised.png'))).valid).toBe(false);
        expect((await policy('../outside/secret.key')).valid).toBe(false);
        expect((await policy(join(outside, 'missing.png'))).valid).toBe(false);
    });

    it('reads a file in slices and says when it has ended', async () => {
        const file = join(outside, 'clip.mov');
        const first = await readFileChunk(file, 0, 4);
        expect(first).toMatchObject({ success: true, size: 10, eof: false });
        expect(Buffer.from(first.content!, 'base64')).toEqual(Buffer.alloc(4, 7));
        const last = await readFileChunk(file, 8, 4);
        expect(last).toMatchObject({ success: true, size: 10, eof: true });
        expect(Buffer.from(last.content!, 'base64').length).toBe(2);
        expect(await readFileChunk(file, 10, 4)).toMatchObject({ success: true, content: '', eof: true });
        expect((await readFileChunk(file, -1, 4)).success).toBe(false);
        expect(MAX_CHUNK_BYTES).toBeLessThanOrEqual(3 * 1024 * 1024);
    });

    it('builds silent screencapture arguments with a capped recording length', () => {
        expect(captureArguments('image', 0, '/c/s.png')).toEqual(['-x', '-t', 'png', '/c/s.png']);
        expect(captureArguments('video', 15, '/c/r.mov')).toEqual(['-x', '-v', '-V15', '/c/r.mov']);
        expect(captureArguments('video', 600, '/c/r.mov')).toEqual(['-x', '-v', '-V30', '/c/r.mov']);
        expect(captureArguments('video', 0, '/c/r.mov')).toEqual(['-x', '-v', '-V1', '/c/r.mov']);
    });

    it('reports a recording on disk as done and an unknown one as missing', async () => {
        expect(await captureStatus(join(outside, 'clip.mov'))).toMatchObject({ success: true, done: true, size: 10 });
        expect(await captureStatus(join(outside, 'never.mov'))).toMatchObject({ success: false, done: true });
    });
});
