import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

/** What one [JsonlTail.readNew] found. */
export type JsonlTailRead = {
    /** The lines written since the previous read, without their newlines; blank lines included. */
    lines: string[];
    /** True when the file was replaced, shrank or was rewritten: [lines] then hold the whole file. */
    reset: boolean;
};

/** Reads a growing JSONL file a piece at a time. */
export type JsonlTail = {
    readNew(): JsonlTailRead;
};

/**
 * Follows one append-only JSONL file (a Claude Code transcript) by byte offset, so a poll reads
 * only what was appended since the last one instead of the whole file: transcripts of long
 * sessions reach hundreds of megabytes and are polled every few seconds.
 *
 * A line is handed out once its newline is written. A last line without one is handed out only
 * when it already parses as JSON (an object cannot be the prefix of a longer object), else it
 * waits for the rest. When the file is replaced (other inode), shrinks, or no longer has a newline
 * just before the offset (rewritten in place), it is read again from the start and `reset` is set.
 * A missing file reads as nothing and starts over once it shows up.
 */
export function openJsonlTail(file: string): JsonlTail {
    let offset = 0;
    let inode: number | null = null;

    return {
        readNew(): JsonlTailRead {
            let fd: number;
            try {
                fd = openSync(file, 'r');
            } catch {
                const reset = inode !== null;
                offset = 0;
                inode = null;
                return { lines: [], reset };
            }
            try {
                const { size, ino } = fstatSync(fd);
                let reset = false;
                if (inode !== null && (ino !== inode || size < offset || !newlineBefore(fd, offset))) {
                    offset = 0;
                    reset = true;
                }
                inode = ino;
                if (size === offset) {
                    return { lines: [], reset };
                }
                const chunk = Buffer.alloc(size - offset);
                const got = readFully(fd, chunk, offset);
                const bytes = got === chunk.length ? chunk : chunk.subarray(0, got);
                const lastNewline = bytes.lastIndexOf(0x0a);
                const lines = lastNewline === -1 ? [] : bytes.subarray(0, lastNewline).toString('utf8').split('\n');
                let consumed = lastNewline + 1;
                const rest = bytes.subarray(consumed).toString('utf8');
                if (rest.trim() !== '' && parses(rest)) {
                    lines.push(rest);
                    consumed = bytes.length;
                }
                offset += consumed;
                return { lines, reset };
            } finally {
                closeSync(fd);
            }
        },
    };
}

function newlineBefore(fd: number, offset: number): boolean {
    if (offset === 0) {
        return true;
    }
    const one = Buffer.alloc(1);
    // A complete last line handed out without its newline ends in `}`.
    return readSync(fd, one, 0, 1, offset - 1) === 1 && (one[0] === 0x0a || one[0] === 0x7d);
}

function readFully(fd: number, into: Buffer, position: number): number {
    let got = 0;
    while (got < into.length) {
        const n = readSync(fd, into, got, into.length - got, position + got);
        if (n === 0) {
            break;
        }
        got += n;
    }
    return got;
}

function parses(text: string): boolean {
    try {
        JSON.parse(text);
        return true;
    } catch {
        return false;
    }
}
