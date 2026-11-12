import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openJsonlTail } from './jsonlTail';

describe('openJsonlTail', () => {
    let dir: string;
    let file: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'jsonl-tail-'));
        file = join(dir, 'session.jsonl');
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('hands out each line once, only what was appended since the last read', () => {
        writeFileSync(file, '{"a":1}\n{"a":2}\n');
        const tail = openJsonlTail(file);
        expect(tail.readNew()).toEqual({ lines: ['{"a":1}', '{"a":2}'], reset: false });
        expect(tail.readNew()).toEqual({ lines: [], reset: false });
        appendFileSync(file, '{"a":3}\n');
        expect(tail.readNew()).toEqual({ lines: ['{"a":3}'], reset: false });
    });

    it('waits for the rest of a half-written line', () => {
        writeFileSync(file, '{"a":1}\n{"a":');
        const tail = openJsonlTail(file);
        expect(tail.readNew().lines).toEqual(['{"a":1}']);
        appendFileSync(file, '2}\n');
        expect(tail.readNew().lines).toEqual(['{"a":2}']);
    });

    it('hands out a complete last line before its newline, and not again after it', () => {
        writeFileSync(file, '{"a":1}');
        const tail = openJsonlTail(file);
        expect(tail.readNew()).toEqual({ lines: ['{"a":1}'], reset: false });
        appendFileSync(file, '\n{"a":2}\n');
        expect(tail.readNew()).toEqual({ lines: ['', '{"a":2}'], reset: false });
    });

    it('keeps multi-byte characters whole across reads', () => {
        writeFileSync(file, '{"t":"안녕"}\n');
        const tail = openJsonlTail(file);
        expect(tail.readNew().lines).toEqual(['{"t":"안녕"}']);
        appendFileSync(file, '{"t":"하세요"}\n');
        expect(tail.readNew().lines).toEqual(['{"t":"하세요"}']);
    });

    it('starts over when the file shrinks or is replaced', () => {
        writeFileSync(file, '{"a":1}\n{"a":2}\n');
        const tail = openJsonlTail(file);
        tail.readNew();
        writeFileSync(file, '{"b":1}\n');
        expect(tail.readNew()).toEqual({ lines: ['{"b":1}'], reset: true });

        unlinkSync(file);
        writeFileSync(file, '{"c":1}\n{"c":2}\n');
        expect(tail.readNew()).toEqual({ lines: ['{"c":1}', '{"c":2}'], reset: true });
    });

    it('starts over when the file was rewritten in place to a longer one', () => {
        writeFileSync(file, '{"a":1}\n');
        const tail = openJsonlTail(file);
        tail.readNew();
        // Same inode, longer, and the old offset now falls inside a line.
        writeFileSync(file, '{"bbbbbbbb":1}\n{"c":2}\n');
        expect(tail.readNew()).toEqual({ lines: ['{"bbbbbbbb":1}', '{"c":2}'], reset: true });
    });

    it('reads nothing while the file is missing and everything once it shows up', () => {
        const tail = openJsonlTail(file);
        expect(tail.readNew()).toEqual({ lines: [], reset: false });
        writeFileSync(file, '{"a":1}\n');
        expect(tail.readNew()).toEqual({ lines: ['{"a":1}'], reset: false });
    });
});
