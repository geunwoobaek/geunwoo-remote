# New Chats As Mac Background Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new Claude chat started in Jarvis becomes a Mac `claude --bg` session that the phone joins through the existing mirror, and the home screen shows every session as one kind of row.

**Architecture:** The daemon gets two machine RPCs next to `open-claude-agent`: `start-claude-agent` (runs `claude --bg` in the chosen folder, waits for the id in `claude agents --json`, then reuses the mirror-open path) and `discard-claude-agent` (stops and removes only sessions this daemon started). `list-claude-agents` gains `startSupported: true`, which is how the app decides up front whether to use the new path. On Android, `SessionStarter` routes non-fork Claude chats through the new RPC, and the home list folds Mac background sessions into the ordinary session rows; `ClaudeAgentsSection` goes away.

**Tech Stack:** TypeScript + vitest (`packages/happy-cli`), Kotlin + Compose + JUnit (`packages/happy-android`).

**Spec:** `docs/superpowers/specs/2026-11-10-new-chats-as-background-sessions-design.md`

## Global Constraints

- Only chats with `agent == Claude` that are not fork / start-from-message / side chat / duplicate take the new path. Codex, Gemini, OpenClaw, Agy, rig and every fork path are unchanged.
- Path choice is decided **before** starting, from the target machine's `list-claude-agents` answer: `startSupported == true` and `unavailable == null` → `start-claude-agent`; anything else (old daemon, `unavailable` set, listing failed) → today's `spawn-happy-session`. An error from `start-claude-agent` never falls back automatically.
- `claude --bg` is run with the folder as process cwd and **no prompt**: `claude --bg --name <name> [--permission-mode <pm>] [--model <m>] [--effort <e>]`. Mode args follow `daemon/spawnModeArgs.ts` (`default` is not forwarded for Claude).
- Name: the first line of the first message, trimmed, cut to 40 characters; if empty, the folder's last path segment.
- Output parsing: find the line matching `backgrounded · <id>` anywhere in stdout+stderr (a warning line may come first). Id is `[0-9a-f]+`.
- Untrusted folder: output contains `Workspace not trusted` (full text: ``Workspace not trusted. Run `claude` in <dir> once and accept the trust prompt, then retry.``; the process exits). Answer `{type:'error', code:'untrusted-folder', errorMessage, directory}`.
- Wait for the id in `claude agents --json` for at most 10 000 ms (poll every 500 ms).
- After `claude --bg` succeeded, any later failure in the start flow runs `claude stop <id>` then `claude rm <id>` (one id per call) before answering the error.
- `discard-claude-agent {id}` acts only on ids in the daemon's in-memory `startedHere` set; any other id answers `{type:'error', code:'not-started-here'}` and runs nothing. Never stop or remove a session the daemon did not start.
- `clientRequestId` dedup for `start-claude-agent`: the same id while in flight returns the same promise; a finished result is reused for 5 minutes.
- English UI strings (the app has no Korean locale), used verbatim:
  - untrusted title `Folder not trusted on the Mac`
  - untrusted body ``Claude on the Mac doesn't trust %1$s yet. Open a terminal there, run `claude` once and accept the prompt, then try again.``
  - untrusted alternate button `Open as regular session`
  - start-only hint under the mode pickers `Model, mode and effort apply when the chat starts.`
- Public fork: fixtures use `/Users/tester/project`; no personal or company data in code, tests or docs.
- Never run `connectedAndroidTest`. Android unit tests: `./gradlew :app:testDebugUnitTest` from `packages/happy-android`. CLI tests: `yarn vitest run <file>` from `packages/happy-cli`.

## Review Focus

1. A slow Mac: `claude --bg` succeeds but the id is not listed within 10 s → the Mac session is removed and the phone shows an error; nothing falls back to a plain session (CLI task test `cleansUpWhenTheAgentNeverAppears`).
2. The same start request twice (app retry after a dropped answer) → one Mac session (CLI test `reusesTheResultForTheSameClientRequestId`; app test `retriesReuseTheSameRequestIdForBackgroundStarts`).
3. A user's own Mac session must never be stopped by the app: `discard-claude-agent` on a foreign id → refused, no `claude stop` (CLI test `refusesToDiscardAnAgentItDidNotStart`).
4. A Mac session whose mirror Happy session was archived but which is still alive → one row in the live list, not in the archive (home test `archivedMirrorOfALiveAgentStaysInTheLiveList`).
5. A row whose mirror process died (daemon restart) → tapping reopens the mirror before navigating (home test `tapOnADeadMirrorReopensItFirst`).

---

### Task 1: Daemon — `start-claude-agent`, `discard-claude-agent`, `startSupported` (CLI lane)

**Files:**
- Modify: `packages/happy-cli/src/claudeAgents/daemonHandlers.ts`, `packages/happy-cli/src/claudeAgents/types.ts`, `packages/happy-cli/src/claudeAgents/agentsList.ts`, `packages/happy-cli/src/api/apiMachine.ts:185-193`, `packages/happy-cli/src/daemon/run.ts:984-997`
- Create: `packages/happy-cli/src/claudeAgents/startAgent.ts` (pure: `buildBgArgs`, `parseBackgroundedId`, `isUntrustedOutput`, `agentNameFrom`)
- Test: `packages/happy-cli/src/claudeAgents/startAgent.test.ts`, `packages/happy-cli/src/claudeAgents/daemonHandlers.test.ts`, `packages/happy-cli/src/daemon/run.claudeAgents.test.ts`

**Interfaces:**
- Produces (wire):
  - `start-claude-agent` request `{ directory: string, name: string, model?: string, permissionMode?: string, effort?: string, approvedNewDirectoryCreation?: boolean, clientRequestId?: string }`
  - answer `{type:'success', sessionId, agentId}` | `{type:'requestToApproveDirectoryCreation', directory}` | `{type:'error', code: 'untrusted-folder'|'claude-missing'|'tmux-missing'|'start-failed', errorMessage, directory?}`
  - `discard-claude-agent` request `{ id }` → `{type:'success'}` | `{type:'error', code:'not-started-here'|'discard-failed', errorMessage}`
  - `list-claude-agents` answer gains `startSupported: true`.
- New `ClaudeAgentHandlerDeps` members (injected, faked in tests): `runClaudeBg(claudePath: string, cwd: string, args: string[]): Promise<{stdout: string, stderr: string, code: number|null}>`, `stopAgent(claudePath: string, id: string): Promise<void>`, `removeAgent(claudePath: string, id: string): Promise<void>`, `ensureDirectory(directory: string, approved: boolean): Promise<{type:'ok'}|{type:'requestToApproveDirectoryCreation', directory}|{type:'error', errorMessage}>`, `sleep(ms: number): Promise<void>`.
- `ClaudeAgentHandlers` gains `start(req): Promise<StartClaudeAgentResult>` and `discard(id): Promise<DiscardClaudeAgentResult>`.

- [ ] **Step 1: Pure helper tests** in `startAgent.test.ts`: `parseBackgroundedId` finds `35d81094` in `"warning: something\nbackgrounded · 35d81094 · demo (idle — send a prompt to start)\n"` and returns null for `"error\n"`; `isUntrustedOutput` is true for the full untrusted text; `buildBgArgs({name:'demo', permissionMode:'default', model:'default', effort:'high'})` → `['--bg','--name','demo','--effort','high']`, and `{permissionMode:'acceptEdits', model:'opus'}` → `['--bg','--name','demo','--permission-mode','acceptEdits','--model','opus']` (reuse `shouldForwardDaemonPermissionMode` with agent `'claude'`); `agentNameFrom('  fix the login bug\nmore', '/Users/tester/project')` → `'fix the login bug'`, a 60-char first line → its first 40 chars, `'   '` → `'project'`.
- [ ] **Step 2: Run, see them fail; implement `startAgent.ts`; run, see them pass.**
- [ ] **Step 3: Handler tests** in `daemonHandlers.test.ts` (new `describe('start-claude-agent')` and `describe('discard-claude-agent')`, extending `makeDeps`):
  - `startsInTheFolderAndOpensTheMirror`: `runClaudeBg` called with cwd `/Users/tester/project`; the agent appears on the 2nd `fetchAgents` poll; `spawnMirror` called with that id and cwd; answer `{type:'success', sessionId, agentId:'35d81094'}`.
  - `answersUntrustedFolderWithTheDirectory` (no `stopAgent` call).
  - `answersStartFailedWhenTheIdCannotBeRead` (no `stopAgent` call).
  - `cleansUpWhenTheAgentNeverAppears`: 10 s of polls without the id → `stopAgent` then `removeAgent` with that id, `code:'start-failed'`.
  - `cleansUpWhenTheMirrorFailsToOpen`.
  - `passesTheMissingToolCodes` (`claude-missing`, `tmux-missing`).
  - `asksBeforeCreatingAMissingFolder`.
  - `reusesTheResultForTheSameClientRequestId`: two concurrent calls with `clientRequestId:'r1'` → one `runClaudeBg`.
  - `discardsAnAgentItStarted`: `stopAgent` then `removeAgent`, and the id leaves `startedHere`.
  - `refusesToDiscardAnAgentItDidNotStart`: no `stopAgent` call, `code:'not-started-here'`.
  - `listReportsStartSupported`.
- [ ] **Step 4: Implement** in `daemonHandlers.ts`, reusing `openUncached` for step 5 of the spec flow. Real deps in `run.ts`: `runClaudeBg` via `execFile(claudePath, args, {cwd, timeout: 30000})` with the env that `spawnMirror` uses, minus any `CLAUDECODE*` / `CLAUDE_CODE_ENTRYPOINT` vars; `stopAgent`/`removeAgent` via `execFile(claudePath, ['stop'|'rm', id])`; `ensureDirectory` extracted from `spawnSession`'s access/mkdir block (`run.ts:286-330`) so both share it; register both RPCs in `apiMachine.ts` inside the `if (claudeAgents)` block.
- [ ] **Step 5: Run** `yarn vitest run src/claudeAgents src/daemon/run.claudeAgents.test.ts src/daemon/spawnModeArgs.test.ts` and `yarn tsc --noEmit` from `packages/happy-cli`. All pass.

### Task 2: App — start flow through `start-claude-agent` (starter lane)

**Files:**
- Create: `A/sync/StartClaudeAgent.kt` (`StartClaudeAgentRequest`, `sealed interface StartClaudeAgentResult { Success(sessionId, agentId); NeedsDirectoryApproval(directory); Untrusted(directory, message); Failed(code, message) }`, `DiscardClaudeAgentResult`, JSON body + parser)
- Modify: `A/sync/MachineOps.kt` (append `startClaudeAgent(machineId, request)` and `discardClaudeAgent(machineId, agentId)`; success waits with `awaitSyncBriefly` like `openClaudeAgent`), `A/sync/ClaudeAgents.kt` (only: parse `startSupported` into `ClaudeAgentsListing.startSupported: Boolean = false`), `A/ui/home/SessionStartServices.kt` (`MachineActions.startClaudeAgent`, `discardClaudeAgent`, `backgroundStartSupported(machineId): Boolean`), `A/ui/home/SessionStarter.kt`, new-chat screen mode-picker area (start-only hint, hide attachments for the background path)
- Test: `A/sync/StartClaudeAgentTest.kt`, `A/ui/home/SessionStarterTest.kt`

**Interfaces:**
- Consumes: Task 1 wire format.
- Produces: `ClaudeAgentsListing.startSupported` (Task 3 reads it, does not redefine it).

- [ ] **Step 1: Parser tests** in `StartClaudeAgentTest.kt`: each Task 1 answer shape → the matching `StartClaudeAgentResult`; garbage → `Failed("unreadable", SpawnSessionResult.UNREADABLE)`; request body carries `directory`, `name`, `clientRequestId` and omits null modes; listing JSON with `"startSupported":true` → `startSupported == true`, without → false.
- [ ] **Step 2: Starter tests** in `SessionStarterTest.kt` (extend the fake `MachineActions`):
  - `claudeChatsStartAsBackgroundSessions`: supported machine → `startClaudeAgent` called with the name from the first message, `spawnSession` not called; the prompt is sent once via `sender.send`; `pinModes` not called.
  - `codexAndForksKeepTheRegularPath`.
  - `unsupportedMachinesKeepTheRegularPath` (`backgroundStartSupported` false).
  - `retriesReuseTheSameRequestIdForBackgroundStarts`.
  - `untrustedFolderReturnsARefusalThatCanOpenARegularSession`: result is `Refused(StartRefusal.UntrustedFolder(directory))`; calling `start` again with `forceRegular = true` uses `spawnSession`.
  - `abandoningABackgroundStartDiscardsTheMacSession`: cancel after success → `stopSession` for the mirror, then `discardClaudeAgent(agentId)`.
  - `abandoningARegularStartDoesNotDiscard`.
  - `worktreeChatsStartInsideTheNewWorktree` (background path gets the worktree path as `directory`).
- [ ] **Step 3: Implement.** The path is chosen in `prepare()` and stored on `Prepared.Ready` as `background: Boolean` plus `agentName`. `create()` branches; `NeedsDirectoryApproval` goes through the existing `confirmDirectory` loop. Directory approval and the `clientRequestId` come from the same `requestIds.getOrPut(signature)`. `stopAbandoned` calls `discardClaudeAgent` only when `prepared.background` and an `agentId` is known. `backgroundStartSupported` reads the home's latest listing for that machine; if none, it calls `listClaudeAgents` once. The untrusted dialog uses the Global Constraints strings, and its alternate button restarts with `forceRegular = true`.
- [ ] **Step 4: Run** `./gradlew :app:testDebugUnitTest --tests '*SessionStarterTest' --tests '*StartClaudeAgentTest' --tests '*MachineOpsTest' --tests '*ClaudeAgentsTest'`. All pass.

### Task 3: App — one home list (home lane)

**Files:**
- Delete: `A/ui/home/ClaudeAgentsSection.kt`, `app/src/test/.../ui/home/ClaudeAgentsSectionTest.kt`
- Create: `A/ui/home/ClaudeAgentsModel.kt` (move `ClaudeAgentsModel`, `claudeAgentsNotice`, `CLAUDE_AGENTS_RELIST_MS`), `A/model/BackgroundAgentRows.kt` (pure merge)
- Modify: `A/ui/home/HomeList.kt`, `A/model/SessionList.kt`, `A/ui/home/HomeData.kt`, `A/ui/home/HomeListHost.kt`, `A/ui/home/HomeScreen.kt:167,214,301,326-328`, `A/model/ProjectHomeRows.kt`
- Test: `A/model/BackgroundAgentRowsTest.kt`, `ui/home/HomeListTest.kt`, `model/HomeModelFixtures.kt`, `sync/MachineOpsTest.kt` (only imports, if `ClaudeAgentsModel` moves)

**Interfaces:**
- Consumes: `ClaudeAgentsListing` (`agents`, `unavailable`; the machine id is the key of `ClaudeAgentsModel.listings`), mirror metadata `claudeAgentId`.
- Produces: `fun mergeBackgroundAgents(sessions: List<Session>, listings: Map<String, ClaudeAgentsListing>, opening: Set<String>): List<SessionRowSource>`, where an unopened agent becomes a `SessionRowData` with `id = "agent:<machineId>:<agentId>"`, `avatarId = "<machineId>:<cwd>"`, `name = agent.name ?: folderTail(cwd)`, `path = cwd`, `machineId`, `createdAt = lastActivityAt = startedAt`, `state` = thinking when `busy`, permission-required when `waiting`, idle otherwise, `active = true`, `archived = false`; and a mirror session whose `(machineId, claudeAgentId)` is live in a listing is forced to `active = true, archived = false`.

- [ ] **Step 1: Merge tests** in `BackgroundAgentRowsTest.kt`: `anUnopenedAgentBecomesARow` (fields above), `anOpenedAgentShowsOnlyItsHappySession` (one row, the Happy session), `archivedMirrorOfALiveAgentStaysInTheLiveList`, `aFinishedAgentsMirrorGoesToTheArchive` (agent gone from the listing → mirror stays archived), `sameAgentIdOnTwoMachinesStaysTwoRows`, `busyAgentShimmersAndWaitingAgentShowsTheOrangeDot` (via `resolveFlatRowPresentation`).
- [ ] **Step 2: Home tests** in `HomeListTest.kt`: unopened agents sort with sessions by `lastActivityAt`; project grouping puts an unopened agent under the project whose path matches `cwd`; `tapOnAnUnopenedAgentOpensTheMirror`; `tapOnADeadMirrorReopensItFirst` (mirror session not active, agent live → `open-claude-agent`, then navigate to the returned id); the unavailable notice renders once above the list.
- [ ] **Step 3: Implement.** Merge happens in `deriveHomeList` inputs, before `buildSessionListViewData`, so flat and project grouping both get it. Row taps for `agent:` ids and for dead mirrors of live agents call `ClaudeAgentsModel.open`; the row shows the existing opening progress while its id is in `opening`. Remove `item(key="claude-agents")` and the `claudeAgents` params; `NoSessionsWithAgents` becomes the plain empty state plus the notice. The 10-second relist while home is resumed stays.
- [ ] **Step 4: Run** `./gradlew :app:testDebugUnitTest --tests '*Home*' --tests '*SessionList*' --tests '*ProjectHomeRows*' --tests '*BackgroundAgentRows*' --tests '*MachineOpsTest'`. All pass.

### Task 4: Earlier design doc wording

**Files:** Modify `docs/superpowers/specs/2026-11-09-claude-agents-remote-design.md`.

- [ ] Rewrite, with no revision marks: the `alias claude=happy` sentence under the regular-terminal-session non-goal (new Jarvis chats now start as background sessions); "기존 Happy 세션 동작이 바뀌는 것" under failures (existing regular sessions keep working as before); the "1. 목록" goal and the home-section paragraph (background sessions appear as rows in the single session list).

### Task 5: Device check (needs the phone)

Follow the spec's 시험 → 기기 list on a throwaway non-git folder under `~/workspace` with haiku. Clean up with `claude stop <id>`, `claude rm <id>` and delete the folder. Never type into the user's own sessions.
