/**
 * Saved Claude Code workflows a session can run, for the phone's "Skills &
 * tools" screen.
 *
 * A workflow is a script in `<project>/.claude/workflows/` or
 * `~/.claude/workflows/` that begins with a literal
 * `export const meta = { name: '...', description: '...', phases: [...] }`.
 * The meta is read as text, never executed: a script is code the phone
 * didn't write, and listing must not run it. A file whose meta can't be read
 * (no `export const meta`, no name, a syntax we don't follow) is skipped.
 */

import { open, readdir, stat } from 'fs/promises';
import { dirname, join, resolve, sep } from 'path';

export type WorkflowScope = 'project' | 'user';

export interface SavedWorkflow {
    name: string;
    description?: string;
    /** When the script says to reach for it (`meta.whenToUse`). */
    whenToUse?: string;
    /** Each phase's title, in order. */
    phases: string[];
    scope: WorkflowScope;
    /** Absolute path of the script. */
    path: string;
    /** Whether the path is inside the session's folder, where the session's file reads may open it. */
    inWorkingDirectory: boolean;
}

export interface ListWorkflowsResponse {
    success: boolean;
    workflows?: SavedWorkflow[];
    error?: string;
}

export interface WorkflowMeta {
    name: string;
    description?: string;
    whenToUse?: string;
    phases: string[];
}

/** Script extensions a workflow may have. */
const SCRIPT_EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts'];

/** Only the head of a script is read: the meta comes first. */
const MAX_HEAD_BYTES = 64 * 1024;

/**
 * The workflows saved for a session in [workingDirectory]: its own
 * `.claude/workflows`, its git root's when that is another folder, then the
 * user's in [homeDir]. Each folder is listed once, a folder that is both a
 * project's and the user's (a session started in the home folder) counts as
 * the user's. Sorted by scope, then name.
 */
export async function listSavedWorkflows(workingDirectory: string | null, homeDir: string): Promise<SavedWorkflow[]> {
    const userDir = resolve(homeDir, '.claude', 'workflows');
    const folders: { dir: string; scope: WorkflowScope }[] = [];
    if (workingDirectory !== null) {
        const cwd = resolve(workingDirectory);
        const projectRoots = [cwd];
        const gitRoot = await findGitRoot(cwd);
        if (gitRoot !== null && gitRoot !== cwd) projectRoots.push(gitRoot);
        for (const root of projectRoots) {
            const dir = join(root, '.claude', 'workflows');
            if (dir !== userDir) folders.push({ dir, scope: 'project' });
        }
    }
    folders.push({ dir: userDir, scope: 'user' });

    const workflows: SavedWorkflow[] = [];
    for (const { dir, scope } of folders) {
        for (const path of await scriptsIn(dir)) {
            const meta = parseWorkflowMeta(await readHead(path));
            if (meta === null) continue;
            workflows.push({
                ...meta,
                scope,
                path,
                inWorkingDirectory: workingDirectory !== null && isInside(path, resolve(workingDirectory)),
            });
        }
    }
    return workflows.sort((a, b) => a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name));
}

/** The nearest folder at or above [dir] that holds `.git` (a folder, or a worktree's file), or null. */
export async function findGitRoot(dir: string): Promise<string | null> {
    let current = resolve(dir);
    for (;;) {
        try {
            await stat(join(current, '.git'));
            return current;
        } catch {
            const parent = dirname(current);
            if (parent === current) return null;
            current = parent;
        }
    }
}

/**
 * The meta of a workflow script's [source], or null when it has none we can
 * read. The literal after `export const meta =` is parsed as data (objects,
 * arrays, strings, numbers, booleans); anything else in it, such as a call or
 * a template with `${}`, is passed over and its key left out.
 */
export function parseWorkflowMeta(source: string): WorkflowMeta | null {
    const start = /export\s+const\s+meta\s*(?::[^=]+)?=\s*\{/.exec(source);
    if (start === null) return null;
    const parser = new LiteralParser(source, start.index + start[0].length - 1);
    let value: unknown;
    try {
        value = parser.value();
    } catch {
        return null;
    }
    if (!isRecord(value) || typeof value.name !== 'string' || value.name.trim() === '') return null;
    const phases = Array.isArray(value.phases)
        ? value.phases.flatMap((phase) => {
            const title = isRecord(phase) ? phase.title ?? phase.name : phase;
            return typeof title === 'string' ? [title] : [];
        })
        : [];
    return {
        name: value.name.trim(),
        description: typeof value.description === 'string' ? value.description : undefined,
        whenToUse: typeof value.whenToUse === 'string' ? value.whenToUse : undefined,
        phases,
    };
}

async function scriptsIn(dir: string): Promise<string[]> {
    try {
        const entries = await readdir(dir, { withFileTypes: true });
        return entries
            .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && SCRIPT_EXTENSIONS.some((ext) => entry.name.endsWith(ext)))
            .map((entry) => join(dir, entry.name))
            .sort();
    } catch {
        return [];
    }
}

async function readHead(path: string): Promise<string> {
    try {
        const file = await open(path, 'r');
        try {
            const buffer = Buffer.alloc(MAX_HEAD_BYTES);
            const { bytesRead } = await file.read(buffer, 0, MAX_HEAD_BYTES, 0);
            return buffer.subarray(0, bytesRead).toString('utf8');
        } finally {
            await file.close();
        }
    } catch {
        return '';
    }
}

function isInside(path: string, dir: string): boolean {
    return path.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Marks a value that isn't plain data; its key is left out. */
const SKIPPED = Symbol('skipped');

/**
 * A reader for the data subset of a JavaScript literal: `{}` with bare,
 * quoted or computed-free keys, `[]`, quoted and `${}`-free template
 * strings, numbers, true, false, null, and comments between tokens.
 */
class LiteralParser {
    constructor(private readonly text: string, private at: number) {}

    value(): unknown {
        this.space();
        const char = this.text[this.at];
        if (char === '{') return this.object();
        if (char === '[') return this.array();
        if (char === '\'' || char === '"' || char === '`') return this.string();
        const word = /^(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?|true|false|null)(?![\w$])/i.exec(this.text.slice(this.at, this.at + 64));
        if (word !== null) {
            this.at += word[0].length;
            const token = word[1];
            return token === 'true' ? true : token === 'false' ? false : token === 'null' ? null : Number(token);
        }
        this.skipValue();
        return SKIPPED;
    }

    private object(): Record<string, unknown> {
        const out: Record<string, unknown> = {};
        this.at++;
        for (;;) {
            this.space();
            if (this.text[this.at] === '}') {
                this.at++;
                return out;
            }
            const key = this.key();
            this.space();
            if (this.text[this.at] === ':') {
                this.at++;
                const value = this.value();
                if (value !== SKIPPED) out[key] = value;
            }
            this.space();
            if (this.text[this.at] === ',') this.at++;
            else if (this.text[this.at] !== '}') throw new Error(`Unexpected ${this.text[this.at] ?? 'end'} in meta`);
        }
    }

    private array(): unknown[] {
        const out: unknown[] = [];
        this.at++;
        for (;;) {
            this.space();
            if (this.text[this.at] === ']') {
                this.at++;
                return out;
            }
            const value = this.value();
            if (value !== SKIPPED) out.push(value);
            this.space();
            if (this.text[this.at] === ',') this.at++;
            else if (this.text[this.at] !== ']') throw new Error(`Unexpected ${this.text[this.at] ?? 'end'} in meta`);
        }
    }

    private key(): string {
        const char = this.text[this.at];
        if (char === '\'' || char === '"') return this.string();
        const word = /^[\w$]+/.exec(this.text.slice(this.at, this.at + 256));
        if (word === null) throw new Error('Unreadable key in meta');
        this.at += word[0].length;
        return word[0];
    }

    private string(): string {
        const quote = this.text[this.at++];
        let out = '';
        for (;;) {
            const char = this.text[this.at++];
            if (char === undefined) throw new Error('Unterminated string in meta');
            if (char === quote) return out;
            if (quote === '`' && char === '$' && this.text[this.at] === '{') throw new Error('Template in meta');
            if (char === '\\') {
                const next = this.text[this.at++];
                out += next === 'n' ? '\n' : next === 't' ? '\t' : next === '\n' ? '' : next ?? '';
                continue;
            }
            if (char === '\n' && quote !== '`') throw new Error('Line break in string in meta');
            out += char;
        }
    }

    /** Passes over a value we don't read, up to the comma or bracket that ends it. */
    private skipValue(): void {
        let depth = 0;
        for (;;) {
            const char = this.text[this.at];
            if (char === undefined) throw new Error('Unterminated meta');
            if (char === '\'' || char === '"' || char === '`') {
                this.skipString(char);
                continue;
            }
            if (char === '{' || char === '[' || char === '(') depth++;
            if (char === '}' || char === ']' || char === ')') {
                if (depth === 0) return;
                depth--;
            }
            if (char === ',' && depth === 0) return;
            this.at++;
        }
    }

    private skipString(quote: string): void {
        this.at++;
        for (;;) {
            const char = this.text[this.at++];
            if (char === undefined) throw new Error('Unterminated string in meta');
            if (char === '\\') this.at++;
            else if (char === quote) return;
        }
    }

    private space(): void {
        for (;;) {
            const rest = this.text.slice(this.at, this.at + 2);
            if (/^\s/.test(rest)) this.at++;
            else if (rest === '//') {
                const end = this.text.indexOf('\n', this.at);
                this.at = end === -1 ? this.text.length : end + 1;
            } else if (rest === '/*') {
                const end = this.text.indexOf('*/', this.at + 2);
                if (end === -1) throw new Error('Unterminated comment in meta');
                this.at = end + 2;
            } else return;
        }
    }
}
