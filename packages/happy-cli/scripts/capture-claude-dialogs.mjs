#!/usr/bin/env node

/**
 * Captures real Claude Code dialog screens for `src/claudeAgents/dialogs.ts`.
 *
 * Starts ONE disposable background session (`claude --bg --model haiku --name jarvis-dialog-capture`)
 * in `~/workspace`, drives it through `claude attach <id>` inside a private tmux server
 * (`tmux -L jarvis-dialog-capture`), provokes each dialog, saves the screen, answers it with the
 * keys under test and records the transcript `tool_result` that came back.
 *
 * Safety:
 *   - Only the session started here (matched by exact name AND the id `claude --bg` printed) is
 *     attached to, typed into, stopped or removed. Every other agent is left alone.
 *   - `--safe-mode` keeps the user's hooks and plugins out of the run; `--permission-mode default`
 *     plus an `ask` rule for Bash/Write/Edit makes permission prompts appear even though the
 *     user's settings pre-allow Bash.
 *   - Everything the session writes goes into `~/workspace/.jarvis-dialog-capture-tmp/`, which is
 *     deleted at the end together with the plan files the plan-mode scenario created (only files
 *     that were not in `~/.claude/plans` before the run are deleted).
 *
 * Output: scrubbed screens in `src/claudeAgents/__fixtures__/screens/*.txt` and a scrubbed
 * `outcomes.json` (keys pressed + tool_result per scenario). Paths, user name and session name are
 * replaced with fake values (`/Users/tester/project`, `demo-agent`).
 *
 * Usage: node scripts/capture-claude-dialogs.mjs --run [--only basics,multi-select,edit-read]
 *   `--only` runs just the named scenario groups and merges their outcomes into the existing
 *   `outcomes.json` (entries of the same scenario name are replaced).
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const NAME = 'jarvis-dialog-capture';
const SOCKET = 'jarvis-dialog-capture';
const TMUX_SESSION = 'capture';
const HOME = homedir();
const WORKSPACE = join(HOME, 'workspace');
const SCRATCH = join(WORKSPACE, '.jarvis-dialog-capture-tmp');
const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../src/claudeAgents/__fixtures__/screens');
const PLANS_DIR = join(HOME, '.claude', 'plans');
/** Reads ask only inside the scratch folder (`//` marks an absolute path in a permission rule). */
const SETTINGS = JSON.stringify({ permissions: { ask: ['Bash', 'Write', 'Edit', `Read(/${SCRATCH}/**)`] } });
/** Pause between consecutive key presses; two digits sent in one burst are read as one number. */
const KEY_GAP_MS = 600;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(cmd, args, opts = {}) {
    const { stdout } = await execFileAsync(cmd, args, { cwd: WORKSPACE, timeout: 60_000, maxBuffer: 8 * 1024 * 1024, ...opts });
    return stdout;
}

const tmux = (...args) => run('tmux', ['-L', SOCKET, ...args]);

async function listAgents() {
    return JSON.parse(await run('claude', ['agents', '--json']));
}

// ---------------------------------------------------------------- session state

const state = { id: null, sessionId: null, attached: false, planFiles: new Set(), outcomes: [], recorded: new Set() };

async function myAgent() {
    const agents = await listAgents();
    return agents.find((a) => a.id === state.id && a.name === NAME) ?? null;
}

async function waitForStatus(status, timeoutMs = 90_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const agent = await myAgent();
        if (agent?.status === status) return;
        await sleep(1000);
    }
    throw new Error(`session did not become ${status}`);
}

function transcriptPath() {
    const slug = WORKSPACE.replace(/[^a-zA-Z0-9]/g, '-');
    return join(HOME, '.claude', 'projects', slug, `${state.sessionId}.jsonl`);
}

/** tool_use / tool_result blocks of the capture session, in file order. */
function toolBlocks() {
    const blocks = [];
    for (const line of readFileSync(transcriptPath(), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        const content = entry?.message?.content;
        if (!Array.isArray(content)) continue;
        for (const b of content) {
            if (b?.type === 'tool_use') blocks.push({ kind: 'use', id: b.id, name: b.name, input: b.input });
            if (b?.type === 'tool_result') blocks.push({ kind: 'result', id: b.tool_use_id, isError: b.is_error === true, content: b.content, toolUseResult: entry.toolUseResult });
        }
    }
    return blocks;
}

async function waitForResultAfter(previousCount, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        // Only results for tool calls that first appeared after `previousCount`: a result for an
        // earlier call can be flushed late and must not be taken for this scenario's answer.
        const blocks = toolBlocks();
        const earlier = new Set(blocks.slice(0, previousCount).filter((b) => b.kind === 'use').map((b) => b.id));
        const fresh = blocks.slice(previousCount);
        const result = fresh.filter((b) => b.kind === 'result' && !earlier.has(b.id) && !state.recorded.has(b.id)).at(-1);
        if (result) {
            const use = blocks.filter((b) => b.kind === 'use' && b.id === result.id && b.input && Object.keys(b.input).length > 0).at(0);
            return { use, result };
        }
        await sleep(1000);
    }
    return null;
}

// ---------------------------------------------------------------- terminal

async function attach() {
    await tmux('kill-session', '-t', TMUX_SESSION).catch(() => undefined);
    await tmux('new-session', '-d', '-s', TMUX_SESSION, '-x', '120', '-y', '40', '--', 'claude', 'attach', state.id);
    state.attached = true;
    await sleep(4000);
}

const screen = () => tmux('capture-pane', '-p', '-t', TMUX_SESSION);
const typeText = (text) => tmux('send-keys', '-l', '-t', TMUX_SESSION, '--', text);

async function press(...keys) {
    for (const key of keys) {
        await tmux('send-keys', '-t', TMUX_SESSION, key);
        await sleep(KEY_GAP_MS);
    }
}

async function prompt(text) {
    await typeText(text);
    await sleep(400);
    await press('Enter');
}

/**
 * Waits until `predicate(screen)` holds. The attach view sometimes stops redrawing mid-update,
 * so after half the timeout the terminal is re-attached once.
 */
async function waitForScreen(predicate, label, timeoutMs = 90_000) {
    const deadline = Date.now() + timeoutMs;
    let reattached = false;
    while (Date.now() < deadline) {
        const text = await screen();
        if (predicate(text)) {
            await sleep(800);
            return screen();
        }
        if (!reattached && Date.now() > deadline - timeoutMs / 2) {
            reattached = true;
            await attach();
            continue;
        }
        await sleep(700);
    }
    throw new Error(`screen "${label}" did not appear`);
}

// ---------------------------------------------------------------- scrubbing

function scrub(text) {
    const user = userInfo().username;
    let out = text
        .split(SCRATCH).join('/Users/tester/project')
        .split('.jarvis-dialog-capture-tmp').join('project')
        .split(HOME).join('/Users/tester')
        .split('~/workspace').join('~/project')
        .split(user).join('tester');
    for (const plan of state.planFiles) {
        out = out.split(plan).join('demo-plan');
    }
    if (state.sessionId) out = out.split(state.sessionId).join('00000000-0000-0000-0000-000000000000');
    if (state.id) out = out.split(state.id).join('0000demo');
    // Keep the bordered name line as wide as before.
    return out
        .split('\n')
        .map((line) => {
            const m = line.match(/^(─+) jarvis-dialog-capture ─$/);
            if (!m) return line.split(NAME).join('demo-agent');
            const width = m[1].length + ` ${NAME} ─`.length;
            const tail = ' demo-agent ─';
            return '─'.repeat(width - tail.length) + tail;
        })
        .join('\n');
}

function save(name, text) {
    writeFileSync(join(OUT_DIR, `${name}.txt`), scrub(text));
    console.log(`  saved ${name}.txt`);
}

function rememberPlanFiles(text) {
    for (const m of text.matchAll(/plans\/([a-z0-9-]+)\.md/g)) state.planFiles.add(m[1]);
}

async function record(scenario, keys, previousCount) {
    const found = await waitForResultAfter(previousCount);
    if (found) state.recorded.add(found.result.id);
    const short = (v) => scrub(typeof v === 'string' ? v : JSON.stringify(v ?? null)).slice(0, 400);
    const entry = found
        ? { scenario, keys, tool: found.use?.name ?? null, input: JSON.parse(scrub(JSON.stringify(found.use?.input ?? {}))), isError: found.result.isError, result: short(found.result.content), toolUseResult: short(found.result.toolUseResult) }
        : { scenario, keys, result: 'no tool_result within timeout' };
    state.outcomes.push(entry);
    console.log(`  ${scenario}: ${entry.isError ? 'error/denied' : 'ok'} ${entry.result.slice(0, 100)}`);
}

// ---------------------------------------------------------------- scenarios

const has = (...needles) => (text) => needles.every((n) => text.includes(n));
const idleInput = (text) => /\n❯\s*\n\s*─{20,}/.test(text) && !text.includes('esc to interrupt');

const p = (file) => join(SCRATCH, file);

async function basics() {
    save('input-empty', await waitForScreen(idleInput, 'idle input'));

    // Typed but not sent; then the Write permission for a new file, approved with 1.
    await typeText(`Use the Write tool to create the new file ${p('report-draft.md')} with the content draft. Do nothing else.`);
    await sleep(1000);
    save('input-typed', await screen());
    let count = toolBlocks().length;
    await press('Enter');
    save('permission-write', await waitForScreen(has('Do you want to create report-draft.md?'), 'write permission'));
    await press('1');
    await record('permission-write approve', ['1'], count);
    await waitForStatus('idle');

    // Write denied with the "No" option (3 on this layout).
    count = toolBlocks().length;
    await prompt(`Use the Write tool to create the new file ${p('denied.txt')} with the content no. Do nothing else.`);
    await waitForScreen(has('Do you want to create denied.txt?'), 'write permission (deny)');
    await press('3');
    await record('permission-write deny', ['3'], count);
    await waitForStatus('idle');

    // Bash permission (long, wrapping command), denied with "No" (2 on this layout).
    count = toolBlocks().length;
    await prompt(`Run exactly this single Bash command and nothing else: printf 'jarvis capture check with some padding text to make it long\\n' > ${p('bash-out.txt')} && ls -la ${SCRATCH}`);
    save('permission-bash', await waitForScreen(has('Bash command', 'Do you want to proceed?'), 'bash permission'));
    await press('2');
    await record('permission-bash deny', ['2'], count);
    await waitForStatus('idle');

    // Bash permission approved with 1.
    count = toolBlocks().length;
    await prompt(`Run exactly this single Bash command and nothing else: ls -la ${SCRATCH}`);
    save('permission-bash-short', await waitForScreen(has('Bash command', 'Do you want to proceed?'), 'bash permission (short)'));
    await press('1');
    await record('permission-bash approve', ['1'], count);
    await waitForStatus('idle');

    // Lone single-select question: one digit selects and submits.
    count = toolBlocks().length;
    await prompt("Use the AskUserQuestion tool to ask me exactly one single-select question. Question text: 'Which color should the demo button use?' header: 'Color', options with labels Red, Green, Blue (give each a short description). After I answer, just repeat my answer in one line and use no other tools.");
    save('question-single', await waitForScreen(has('Which color should the demo button use?', 'Enter to select'), 'single question'));
    await press('2');
    await record('question-single', ['2'], count);
    await waitForStatus('idle');

    // Two questions: multi-select (digits toggle, Tab moves on), then single-select (digit), then review (1).
    count = toolBlocks().length;
    await prompt("Use the AskUserQuestion tool once with exactly two questions. Question 1: 'Which toppings should the demo pizza have?' header 'Toppings', multiSelect true, options Cheese, Olives, Basil. Question 2: 'Which size should the demo pizza be?' header 'Size', multiSelect false, options Small, Medium, Large. Give each option a short description. After I answer, repeat my answers in one line and use no other tools.");
    save('question-multi', await waitForScreen(has('Which toppings should the demo pizza have?', 'Enter to select'), 'multi question'));
    await press('1', '3');
    save('question-multi-toggled', await screen());
    await press('Tab');
    save('question-multi-second', await waitForScreen(has('Which size should the demo pizza be?'), 'second question'));
    await press('2');
    save('question-review', await waitForScreen(has('Ready to submit your answers?'), 'review'));
    await press('1');
    await record('question-multi', ['1', '3', 'Tab', '2', '1'], count);
    await waitForStatus('idle');

    // Free text ("Type something"): move the cursor onto it and type; Tab, Enter on Submit, then 1.
    count = toolBlocks().length;
    await prompt("Use the AskUserQuestion tool once with exactly one question: 'Which extras should the demo logo get?' header 'Extras', multiSelect true, options Shadow, Outline, Gradient, each with a short description. After I answer, repeat my answer in one line and use no other tools.");
    await waitForScreen(has('Which extras should the demo logo get?', 'Enter to select'), 'other question');
    await press('Down', 'Down', 'Down');
    await typeText('Sparkle');
    await sleep(1000);
    save('question-other', await screen());
    await press('Tab', 'Enter');
    await waitForScreen(has('Ready to submit your answers?'), 'other review');
    await press('1');
    await record('question-other', ['Down', 'Down', 'Down', 'type:Sparkle', 'Tab', 'Enter', '1'], count);
    await waitForStatus('idle');

    // A subagent asking for permission: the parent's Agent call already has its result.
    count = toolBlocks().length;
    await prompt(`Use the Agent (Task) tool to launch one general-purpose subagent. Tell the subagent: use the Write tool to create ${p('sub-note.txt')} with content sub, and do nothing else. Do not write the file yourself.`);
    try {
        save('permission-subagent', await waitForScreen(has('from the', 'Do you want to create sub-note.txt?'), 'subagent permission', 120_000));
        await press('3');
        await sleep(3000);
        state.outcomes.push({ scenario: 'permission-subagent deny', keys: ['3'], parentPending: toolBlocks().slice(count).map((b) => `${b.kind}:${b.name ?? b.id}`).join(' ') });
    } catch (error) {
        // The model does not always delegate; record that instead of aborting the plan scenarios.
        state.outcomes.push({ scenario: 'permission-subagent', result: `not provoked: ${error.message}`, toolCalls: toolBlocks().slice(count).map((b) => `${b.kind}:${b.name ?? b.id}`).join(' ') });
        if ((await myAgent())?.status === 'waiting') await press('Escape');
    }
    await waitForStatus('idle', 180_000);

    // Plan mode via shift+tab (manual -> accept edits -> plan).
    await press('BTab', 'BTab');
    await waitForScreen(has('plan mode on'), 'plan mode');
    count = toolBlocks().length;
    await prompt(`Make a very short plan (three bullet steps) for writing a hello-world text file named greeting.txt inside ${SCRATCH}, then call ExitPlanMode to present it. Do not explore or read any files first.`);
    await answerPlanFilePrompts();
    const plan = await waitForScreen(has('Would you like to proceed?'), 'plan approval');
    rememberPlanFiles(plan);
    save('plan', plan);

    // Reject with a reason: 3 focuses the feedback field, type, Enter.
    await press('3');
    await typeText('Please name the file hello.txt instead');
    await sleep(800);
    save('plan-feedback-typed', await screen());
    await press('Enter');
    await record('plan reject with reason', ['3', 'type:reason', 'Enter'], count);

    // Reject without a reason: 3 then Enter on the empty field.
    count = toolBlocks().length;
    await answerPlanFilePrompts();
    rememberPlanFiles(await waitForScreen(has('Would you like to proceed?'), 'plan approval 2'));
    await press('3', 'Enter');
    await sleep(3000);
    save('plan-after-empty-reject', await screen());
    await record('plan reject without reason', ['3', 'Enter'], count);

    // Approve with 2 (manually approve edits); the following Write must prompt again.
    await sleep(2000);
    let text = await screen();
    if (!text.includes('Would you like to proceed?')) {
        await prompt('Present the same plan again with ExitPlanMode.');
        await answerPlanFilePrompts();
    }
    rememberPlanFiles(await waitForScreen(has('Would you like to proceed?'), 'plan approval 3'));
    count = toolBlocks().length;
    await press('2');
    await record('plan approve manual', ['2'], count);
    text = await waitForScreen((s) => s.includes('Do you want to create') || idleInput(s), 'after plan approval');
    save('after-plan-approve', text);
    if (text.includes('Do you want to create')) {
        count = toolBlocks().length;
        await press('3');
        await record('write after plan approval deny', ['3'], count);
    }
}

/**
 * Runs one dialog scenario that may not be provoked (the model does not always do what it is told).
 * A failure is recorded and the dialog, if any, is cancelled so that the next scenario can run.
 */
async function attempt(scenario, body) {
    try {
        await body();
    } catch (error) {
        save(`${scenario}-failed`, await screen());
        state.outcomes.push({ scenario, result: `not provoked: ${error.message}` });
        if ((await myAgent())?.status === 'waiting') await press('Escape');
    }
    await waitForStatus('idle', 180_000);
}

/** Multi-select shapes keysForQuestion maps: a lone multi-select question and a multi-select question last of several. */
async function multiSelect() {
    await attempt('question-lone-multi', async () => {
        const count = toolBlocks().length;
        await prompt("Use the AskUserQuestion tool once with exactly one question: 'Which days should the demo meeting use?' header 'Days', multiSelect true, options Monday, Wednesday, Friday, each with a short description. After I answer, repeat my answer in one line and use no other tools.");
        save('question-lone-multi', await waitForScreen(has('Which days should the demo meeting use?', 'Enter to select'), 'lone multi question'));
        await press('1', '3', 'Tab');
        save('question-lone-multi-after-tab', await waitForScreen(has('Ready to submit your answers?'), 'lone multi review', 20_000));
        await press('1');
        await record('question-lone-multi', ['1', '3', 'Tab', '1'], count);
    });
    await attempt('question-last-multi', async () => {
        const count = toolBlocks().length;
        await prompt("Use the AskUserQuestion tool once with exactly two questions. Question 1: 'Which shape should the demo badge be?' header 'Shape', multiSelect false, options Circle, Square, Star. Question 2: 'Which effects should the demo badge get?' header 'Effects', multiSelect true, options Shadow, Outline, Glow. Give each option a short description. After I answer, repeat my answers in one line and use no other tools.");
        await waitForScreen(has('Which shape should the demo badge be?', 'Enter to select'), 'last multi first question');
        await press('3');
        save('question-last-multi', await waitForScreen(has('Which effects should the demo badge get?'), 'last multi second question', 20_000));
        await press('1', '2', 'Tab');
        save('question-last-multi-after-tab', await waitForScreen(has('Ready to submit your answers?'), 'last multi review', 20_000));
        await press('1');
        await record('question-last-multi', ['3', '1', '2', 'Tab', '1'], count);
    });
}

/** Read and Edit permission dialogs on a scratch file: Read approved with 1, Edit denied with its `No` option. */
async function editRead() {
    writeFileSync(p('edit-me.txt'), 'alpha\n');
    await attempt('permission-read-edit', async () => {
        let count = toolBlocks().length;
        await prompt(`Use the Read tool to read ${p('edit-me.txt')}, then use the Edit tool to replace alpha with beta in it. Do nothing else.`);
        const editAsk = 'Do you want to make this edit to edit-me.txt?';
        const first = await waitForScreen((s) => s.includes(editAsk) || (s.includes('Do you want to') && s.includes('edit-me.txt')), 'read permission');
        if (first.includes(editAsk)) {
            state.outcomes.push({ scenario: 'permission-read approve', result: 'not provoked: the Read ran without a prompt' });
        } else {
            save('permission-read', first);
            await press('1');
            await record('permission-read approve', ['1'], count);
            count = toolBlocks().length;
        }
        const edit = await waitForScreen((s) => s.includes('Do you want to make this edit to edit-me.txt?'), 'edit permission');
        save('permission-edit', edit);
        const no = edit.split('\n').map((line) => /^\s*(?:❯\s*)?(\d)\.\s+No$/.exec(line)?.[1]).find(Boolean);
        if (!no) throw new Error('no "No" option on the edit dialog');
        await press(no);
        await record('permission-edit deny', [no], count);
    });
}

const GROUPS = { basics, 'multi-select': multiSelect, 'edit-read': editRead };

/** The blanket Write/Edit ask rule also asks before Claude writes its plan file; allow those. */
async function answerPlanFilePrompts() {
    for (let i = 0; i < 4; i++) {
        const text = await waitForScreen((s) => s.includes('Would you like to proceed?') || /Do you want to (create|overwrite|make this edit to) [a-z0-9-]+\.md\?/.test(s) || idleInput(s), 'plan or plan file');
        if (text.includes('Would you like to proceed?')) return;
        if (idleInput(text)) {
            await sleep(3000);
            continue;
        }
        rememberPlanFiles(text);
        if (!text.includes('plans/')) throw new Error('unexpected file prompt in plan mode');
        await press('1');
        await sleep(3000);
    }
}

// ---------------------------------------------------------------- main

async function main() {
    if (!process.argv.includes('--run')) {
        console.log('Usage: node scripts/capture-claude-dialogs.mjs --run   (starts a disposable Claude session in ~/workspace)');
        return;
    }
    const onlyAt = process.argv.indexOf('--only');
    const groups = onlyAt >= 0 ? (process.argv[onlyAt + 1] ?? '').split(',').filter(Boolean) : Object.keys(GROUPS);
    if (groups.length === 0 || groups.some((g) => !(g in GROUPS))) throw new Error(`--only takes a comma list of ${Object.keys(GROUPS).join(', ')}`);
    if (!existsSync(WORKSPACE)) throw new Error(`${WORKSPACE} does not exist`);
    const plansBefore = new Set(existsSync(PLANS_DIR) ? readdirSync(PLANS_DIR) : []);
    if ((await listAgents()).some((a) => a.name?.startsWith(NAME))) throw new Error(`a ${NAME} session already exists; remove it first`);
    const before = (await listAgents()).filter((a) => a.kind === 'background').map((a) => a.id);
    mkdirSync(SCRATCH, { recursive: true });
    mkdirSync(OUT_DIR, { recursive: true });

    try {
        const out = await run('claude', ['--bg', '--safe-mode', '--model', 'haiku', '--name', NAME, '--permission-mode', 'default', '--settings', SETTINGS, 'Reply with just the word READY and nothing else. Do not use any tools.']);
        const id = out.match(/backgrounded · ([0-9a-f]+) · jarvis-dialog-capture/)?.[1];
        if (!id) throw new Error(`could not read the new session id from: ${out}`);
        state.id = id;
        const agent = await myAgent();
        if (!agent || agent.kind !== 'background') throw new Error(`session ${id} is not a background ${NAME}`);
        state.sessionId = agent.sessionId;
        console.log(`started ${NAME} ${id}`);
        await attach();
        await waitForStatus('idle');
        for (const group of groups) await GROUPS[group]();
    } finally {
        if (state.attached) await tmux('kill-session', '-t', TMUX_SESSION).catch(() => undefined);
        if (state.id) {
            await run('claude', ['stop', state.id]).catch((e) => console.error('stop failed', e.message));
            await run('claude', ['rm', state.id]).catch((e) => console.error('rm failed', e.message));
        }
        rmSync(SCRATCH, { recursive: true, force: true });
        for (const plan of state.planFiles) {
            if (!plansBefore.has(`${plan}.md`)) rmSync(join(PLANS_DIR, `${plan}.md`), { force: true });
        }
        const outcomesPath = join(OUT_DIR, 'outcomes.json');
        const fresh = new Set(state.outcomes.map((o) => o.scenario));
        const kept = onlyAt >= 0 && existsSync(outcomesPath) ? JSON.parse(readFileSync(outcomesPath, 'utf8')).filter((o) => !fresh.has(o.scenario)) : [];
        writeFileSync(outcomesPath, `${JSON.stringify([...kept, ...state.outcomes], null, 2)}\n`);
        const after = await listAgents();
        const leftovers = after.filter((a) => a.name?.startsWith(NAME));
        const missing = before.filter((id) => !after.some((a) => a.id === id));
        console.log(`cleanup: leftovers=${leftovers.length} missing-background-ids=${missing.join(',') || 'none'} agents before=${before.length} after=${after.length}`);
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
