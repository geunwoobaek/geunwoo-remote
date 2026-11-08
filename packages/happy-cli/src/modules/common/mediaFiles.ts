/**
 * Pictures and recordings for the phone.
 *
 * - `readFileChunk` reads a file a slice at a time, so a recording larger
 *   than one relay message (the server's socket buffer is 8 MB, and the
 *   payload is base64 inside encrypted base64) still reaches the phone.
 * - `mediaReadPolicy` lets a chunk read leave the working directory only
 *   for what the phone can show: pictures and recordings anywhere, and a
 *   web page's own files (html, css, js, svg, fonts) outside hidden
 *   folders. It judges the real (symlink-resolved) name, so Claude's
 *   screenshot or page in /tmp opens on the phone while a link named
 *   `x.png` pointing at a key does not.
 * - `captureScreen` runs macOS `screencapture` into ~/.happy/captures for
 *   a screenshot or a short recording. Nothing is captured until the phone
 *   asks; the first capture needs Screen Recording permission for the
 *   process that runs happy.
 */
import { execFile } from 'child_process';
import { mkdir, open, realpath, stat } from 'fs/promises';
import { homedir } from 'os';
import { extname, join, sep } from 'path';
import { promisify } from 'util';
import { PathValidationResult } from './pathSecurity';

const execFileAsync = promisify(execFile);

/** Lowercase extensions the phone shows as a picture or plays as a recording. */
export const MEDIA_EXTENSIONS: ReadonlySet<string> = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp',
    '.mp4', '.mov', '.m4v', '.webm',
]);

/** A web page's own files, readable outside the working directory unless a folder or the file is hidden. */
export const PAGE_EXTENSIONS: ReadonlySet<string> = new Set([
    '.html', '.htm', '.css', '.js', '.mjs', '.svg', '.woff', '.woff2', '.ttf', '.otf',
]);

/** The largest slice one chunk read returns: 3 MB raw stays well under the relay's 8 MB after two base64 passes. */
export const MAX_CHUNK_BYTES = 3 * 1024 * 1024;

/** The longest recording the phone may ask for, in seconds. */
export const MAX_RECORDING_SECONDS = 30;

export interface FileChunk {
    success: boolean;
    /** Base64 of the bytes from `offset`. */
    content?: string;
    /** The whole file's size in bytes. */
    size?: number;
    eof?: boolean;
    error?: string;
}

/**
 * Where a chunk read may go: wherever [checkPath] allows, and otherwise a
 * picture or recording anywhere, or a page file outside hidden folders,
 * by its real name.
 */
export async function mediaReadPolicy(path: string, checkPath: (path: string) => PathValidationResult): Promise<PathValidationResult> {
    const inside = checkPath(path);
    if (inside.valid) return inside;
    try {
        const real = await realpath(path);
        const extension = extname(real).toLowerCase();
        const hidden = real.split(sep).some((segment) => segment.startsWith('.'));
        if (MEDIA_EXTENSIONS.has(extension) || (PAGE_EXTENSIONS.has(extension) && !hidden)) return { valid: true, resolvedPath: real };
    } catch {
        // A missing file falls through to the working directory's refusal.
    }
    return inside;
}

/** Up to [length] bytes of [path] from [offset] (capped at [MAX_CHUNK_BYTES]). */
export async function readFileChunk(path: string, offset: number, length: number): Promise<FileChunk> {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) || length <= 0) {
        return { success: false, error: 'offset and length must be whole numbers' };
    }
    const handle = await open(path, 'r');
    try {
        const size = (await handle.stat()).size;
        const want = Math.max(0, Math.min(length, MAX_CHUNK_BYTES, size - offset));
        const buffer = Buffer.alloc(want);
        const { bytesRead } = want > 0 ? await handle.read(buffer, 0, want, offset) : { bytesRead: 0 };
        return {
            success: true,
            content: buffer.subarray(0, bytesRead).toString('base64'),
            size,
            eof: offset + bytesRead >= size,
        };
    } finally {
        await handle.close();
    }
}

export type CaptureKind = 'image' | 'video';

export interface CaptureResult {
    success: boolean;
    path?: string;
    /** False while a recording is still being made: ask [captureStatus] about [path]. */
    done?: boolean;
    size?: number;
    error?: string;
}

/** `screencapture`'s arguments: silent, the whole main screen, a PNG or a recording of [seconds]. */
export function captureArguments(kind: CaptureKind, seconds: number, file: string): string[] {
    if (kind === 'image') return ['-x', '-t', 'png', file];
    const limit = Math.min(MAX_RECORDING_SECONDS, Math.max(1, Math.round(seconds)));
    return ['-x', '-v', `-V${limit}`, file];
}

/** The folder captures land in. */
export function capturesDirectory(): string {
    return join(homedir(), '.happy', 'captures');
}

/** Recordings still being made, by path. */
const recordings = new Set<string>();
/** Finished recordings' errors, by path; null when written. */
const settled = new Map<string, string | null>();

/**
 * Captures the screen on macOS into [directory]. A screenshot returns
 * when written; a recording returns at once (the relay gives a call 30 s)
 * and [captureStatus] says when it is done. Elsewhere it refuses.
 */
export async function captureScreen(kind: CaptureKind, seconds: number, directory: string = capturesDirectory()): Promise<CaptureResult> {
    if (process.platform !== 'darwin') return { success: false, error: 'Screen capture works on macOS only' };
    await mkdir(directory, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = join(directory, `${kind === 'image' ? 'screenshot' : 'recording'}-${stamp}.${kind === 'image' ? 'png' : 'mov'}`);
    const run = execFileAsync('screencapture', captureArguments(kind, seconds, file), { timeout: (MAX_RECORDING_SECONDS + 30) * 1000 });
    if (kind === 'image') {
        await run;
        return { success: true, path: file, done: true, size: (await stat(file)).size };
    }
    recordings.add(file);
    run.then(
        () => settled.set(file, null),
        (error: unknown) => settled.set(file, error instanceof Error ? error.message : 'Recording failed'),
    ).finally(() => recordings.delete(file));
    return { success: true, path: file, done: false };
}

/** Whether the recording at [path] is written yet, and its size once it is. */
export async function captureStatus(path: string): Promise<CaptureResult> {
    if (recordings.has(path)) return { success: true, path, done: false };
    const error = settled.get(path);
    if (error) return { success: false, path, done: true, error };
    try {
        return { success: true, path, done: true, size: (await stat(path)).size };
    } catch {
        return { success: false, path, done: true, error: 'No such recording' };
    }
}
