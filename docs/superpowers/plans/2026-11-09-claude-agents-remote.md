# 맥 Claude 백그라운드 세션 폰에서 이어 쓰기 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Jarvis 앱에서 맥의 `claude agents` 백그라운드 세션을 골라 열고, 폰과 맥 어느 쪽에서 입력·응답해도 같은 세션에 사용자 본인의 입력으로 반영되게 한다.

**Architecture:** 데몬이 `claude agents --json`으로 목록을 알려 주고, 열기 요청이 오면 거울 자식 프로세스(`happy claude-agent-mirror <id>`)를 띄운다. 거울은 기록 파일을 읽어 Happy 세션에 올리고, 폰의 입력·응답은 전용 tmux 소켓 안의 `claude attach <id>`에 키로 넣는다. 권한·질문·계획 창은 세션 상태 파일과 기록 파일로 감지해 기존 `agentState.requests` 통로로 폰에 보낸다.

**Tech Stack:** TypeScript(Node, vitest) — `packages/happy-cli`, Kotlin(Compose, JUnit) — `packages/happy-android`, tmux.

**Spec:** `docs/superpowers/specs/2026-11-09-claude-agents-remote-design.md` — 실행자는 이 계획과 설계 문서를 함께 읽는다.

## Global Constraints

- Claude Remote Control은 어디에도 쓰지 않는다. 세션 간 메시지 소켓(`/tmp/cc-socks/*.sock`)도 쓰지 않는다.
- 대상은 `kind === 'background'` 세션만. 거울의 기준 키는 에이전트 `id`(sessionId 아님).
- tmux는 전용 소켓 `tmux -L jarvis-agents`로만 부른다. 터미널 크기 120×40. 새 npm 의존성 추가 금지.
- 맥 사용자가 cmux에 열어 둔 `claude attach` 창은 Task 12 규칙으로만 쓰고(읽기·입력·키), 절대 닫거나 크기를 바꾸지 않는다. 화면 읽기는 터미널 폭·높이에 기대지 않는다.
- `claude` 경로는 로그인 셸 `command -v claude`로 찾는다. Agent SDK에 묶인 Claude는 쓰지 않는다.
- 거울 메타데이터에 `claudeAgentId: <id>`를 넣는다. 앱과 데몬은 이 필드로 거울을 알아본다.
- 권한·질문·계획에 키를 넣기 전에 네 조건(①`waiting` ②폰에 보인 창과 같은 창: 창 지문이 같고, 기록에서 얻은 id가 있으면 id도 같음 ③화면에 해당 창 ④화면 내용이 그 도구와 일치)을 모두 확인한다. 키는 한 번에 하나씩 `DIALOG_KEY_GAP_MS`(600ms) 간격으로 넣는다. 하나라도 어긋나면 넣지 않고 폰에 "맥에서 답해 주세요"를 보인다.
- 맥에서 먼저 답하면 기록 파일의 tool_result로 `completedRequests[id]`를 `approved`/`denied`로 쓴다. 폰 카드를 지우지 않는다.
- CLI의 기존 파일은 등록과 짧은 조건 추가만 한다. 새 코드는 `packages/happy-cli/src/claudeAgents/`에 둔다. 앱의 새 컴포저블은 새 파일에 둔다.
- 공개 포크라 픽스처의 경로·이름은 가짜 값(`/Users/tester/project`, `demo-agent`)으로 바꾼다. 개인·회사 정보 금지.
- 테스트·실험용 Claude 세션은 신뢰된 폴더 `~/workspace`에서 `claude --bg --model haiku`로 띄운 일회용만 쓰고, 끝나면 `claude stop`·`claude rm`으로 지운다. 사용자의 실제 세션에는 절대 입력하지 않는다.
- 맥 전역 CLI 교체(포크 빌드 설치)는 사용자의 별도 승인 후에만 한다(Task 11).
- 커밋 메시지 끝: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. 푸시는 `git push geunwoo HEAD:remote-ux`만. `.playwright-mcp/`는 커밋하지 않는다.

## Review Focus

1. 맥에서 같은 세션에 attach해 타이핑하던 중 폰 메시지가 들어오는 경우 — 맥 입력창의 미완성 글자와 폰 글자가 섞이지 않아야 한다(폰 입력 전 `screen()`에서 입력창이 비어 있지 않으면 비워질 때까지 최대 10초 기다렸다가, 그래도 차 있으면 거절하고 폰에 알린다). Task 5에서 테스트.
2. 같은 문장을 폰과 맥에서 연달아 보낸 경우 — 에코 필터가 맥에서 친 두 번째 문장까지 삼키면 안 된다(기억한 횟수만큼만 건너뛴다). Task 5에서 테스트.
3. 세션이 거울을 연 직후 이미 `waiting`인 경우 — 열자마자 폰에 카드가 떠야 한다(처음 tick에서 감지). Task 6에서 테스트.
4. 백그라운드 세션이 `claude rm`으로 사라진 상태에서 폰이 메시지를 보낸 경우 — 조용히 사라지지 않고 세션이 끝남 상태로 바뀌어야 한다. Task 7에서 테스트(`decideAgentChange`).
5. 폰 메시지에 제어 문자·ESC 시퀀스가 섞인 경우 — 터미널 키로 해석되지 않아야 한다(`sanitizeTypedText`). Task 3에서 테스트.

---

### Task 1: 에이전트 목록 읽기

**Files:**
- Create: `packages/happy-cli/src/claudeAgents/types.ts`, `packages/happy-cli/src/claudeAgents/agentsList.ts`
- Test: `packages/happy-cli/src/claudeAgents/agentsList.test.ts`

**Interfaces:**
- Produces:
  - `type ClaudeAgentStatus = 'idle' | 'busy' | 'waiting'`
  - `type ClaudeAgent = { id: string; sessionId: string; name: string | null; cwd: string; pid: number; status: ClaudeAgentStatus; state: 'working' | 'done' | null; startedAt: number /* ms */ }`
  - `type ClaudeAgentsUnavailable = 'claude-missing' | 'tmux-missing' | 'agents-command-failed'`
  - `type ClaudeAgentsListing = { agents: Array<ClaudeAgent & { mirrorSessionId?: string }>; unavailable?: ClaudeAgentsUnavailable }`
  - `parseClaudeAgents(json: string): ClaudeAgent[]`
  - `resolveClaudeBinary(): Promise<string | null>`
  - `fetchClaudeAgents(claudePath: string): Promise<ClaudeAgent[]>` (`claude agents --json` 실행, 10초 제한)

- [ ] **Step 1: 실패하는 테스트 작성** — `agentsList.test.ts`:
  - `parseClaudeAgents keeps only background entries`: interactive 1개 + background 2개 입력 → 길이 2, 모두 `kind` 원본이 background였던 것.
  - `parseClaudeAgents normalizes startedAt`: 숫자(ms)와 ISO 문자열 둘 다 → 같은 ms 숫자.
  - `parseClaudeAgents drops entries missing id, sessionId or cwd` → 해당 항목 제외.
  - `parseClaudeAgents returns [] for invalid JSON` → `[]`, 예외 없음.
  - `parseClaudeAgents maps unknown status to idle`.
- [ ] **Step 2: 실행해 실패 확인** — `cd packages/happy-cli && npx vitest run --project unit src/claudeAgents/agentsList.test.ts` → FAIL(모듈 없음).
- [ ] **Step 3: 구현** — 세 함수. `resolveClaudeBinary`는 `/bin/zsh -lc 'command -v claude'`(execFile, 5초)의 첫 줄, 실패 시 null.
- [ ] **Step 4: 통과 확인** — 같은 명령 → PASS. `npx tsc --noEmit` → 오류 없음.
- [ ] **Step 5: 커밋** — `feat(cli): read Claude background agents`.

### Task 2: 기록 파일·상태 파일 해석

**Files:**
- Create: `packages/happy-cli/src/claudeAgents/transcript.ts`
- Test: `packages/happy-cli/src/claudeAgents/transcript.test.ts`

**Interfaces:**
- Consumes: `ClaudeAgentStatus`(Task 1)
- Produces:
  - `type PendingToolUse = { id: string; name: string; input: Record<string, unknown> }`
  - `type ToolUseOutcome = { decision: 'approved' | 'denied'; text: string }`
  - `findPendingToolUse(entries: unknown[]): PendingToolUse | null` — 마지막 assistant 메시지의 `tool_use` 중 뒤따르는 user `tool_result`(같은 `tool_use_id`)가 없는 마지막 것.
  - `findToolUseOutcome(entries: unknown[], toolUseId: string): ToolUseOutcome | null` — `is_error: true`면 denied, 아니면 approved. `text`는 결과 본문 문자열.
  - `readTranscriptEntries(cwd: string, sessionId: string): unknown[]` — 경로는 기존 `getProjectPath`(`claude/utils/path.ts`) + `<sessionId>.jsonl`. 깨진 줄은 건너뜀.
  - `readSessionStatus(pid: number, claudeHome?: string): ClaudeAgentStatus | null` — `~/.claude/sessions/<pid>.json`의 `status`.

- [ ] **Step 1: 실패하는 테스트 작성** — 픽스처는 테스트 파일 안의 작은 배열(가짜 경로).
  - `findPendingToolUse returns the Write call with no result` → `{ id: 'toolu_1', name: 'Write' }`.
  - `findPendingToolUse returns null once a tool_result follows`.
  - `findPendingToolUse picks the last unanswered of parallel calls` (tool_use 2개 중 1개만 결과) → 결과 없는 것.
  - `findToolUseOutcome reads is_error as denied` / `reads a normal result as approved`.
  - `readSessionStatus reads waiting from a temp claude home` / `returns null when the file is missing`.
- [ ] **Step 2: 실패 확인** — `npx vitest run --project unit src/claudeAgents/transcript.test.ts` → FAIL.
- [ ] **Step 3: 구현.**
- [ ] **Step 4: 통과 확인** → PASS.
- [ ] **Step 5: 커밋** — `feat(cli): find pending tool calls in Claude transcripts`.

### Task 3: 보이지 않는 attach 터미널(tmux)

**Files:**
- Create: `packages/happy-cli/src/claudeAgents/attachTerminal.ts`
- Test: `packages/happy-cli/src/claudeAgents/attachTerminal.test.ts`

**Interfaces:**
- Produces:
  - `type AttachKey = 'enter' | 'escape' | 'up' | 'down' | 'space' | 'tab' | 'backspace' | { digit: number }`
  - `type AttachTerminal = { screen(): Promise<string>; typeText(text: string): Promise<void>; pasteText(text: string): Promise<void>; press(keys: AttachKey[]): Promise<void>; close(): Promise<void> }`
  - `openAttachTerminal(command: string[], opts?: { cols?: number; rows?: number; readyTimeoutMs?: number; isReady?: (screen: string) => boolean }): Promise<AttachTerminal>` — 소켓 `-L jarvis-agents`, 세션 이름 `attach-<random>`, `new-session -d -x 120 -y 40`. 준비는 `isReady(screen)`가 참이 될 때까지 200ms 간격 폴링(기본 제한 8초, 넘으면 close 후 throw).
  - `typeText`는 `send-keys -l`, `pasteText`는 `set-buffer` + `paste-buffer -p -d`, `screen`은 `capture-pane -p`, `close`는 `kill-session`.
  - `sanitizeTypedText(text: string): string` — `\n`과 `\t`를 뺀 C0 제어 문자와 DEL, ESC 시퀀스 제거.
  - `isTmuxInstalled(): Promise<boolean>`
- [ ] **Step 1: 실패하는 테스트 작성** — claude 대신 `sh -c 'printf READY; read a; echo "got:$a"; sleep 5'`를 띄운다.
  - `opens, types and reads the screen` → `typeText('hello')` + `press(['enter'])` 뒤 `screen()`에 `got:hello`.
  - `pasteText delivers multi-line text as one paste` → `cat`을 띄워 `'a\nb'` 붙여 넣기 → 화면에 `a`와 `b` 두 줄.
  - `close kills the tmux session` → `tmux -L jarvis-agents has-session -t <name>` 실패.
  - `does not touch the default tmux server` → 테스트 전후 `tmux list-sessions`(기본 소켓) 출력 동일.
  - `sanitizeTypedText strips ESC sequences and control bytes` → `'a\x1b[31mb\x03c'` → `'abc'`. `'x\ny'`는 그대로.
  - tmux가 없으면 `describe.skipIf(!tmux)`.
- [ ] **Step 2: 실패 확인** → FAIL.
- [ ] **Step 3: 구현** — `execFile('tmux', ['-L', 'jarvis-agents', ...])`. 기존 `utils/tmux.ts`는 기본 서버를 쓰므로 재사용하지 않는다.
- [ ] **Step 4: 통과 확인** → PASS.
- [ ] **Step 5: 커밋** — `feat(cli): drive claude attach in a private tmux server`.

### Task 4: 창 화면 실측과 키 매핑

이 작업은 실제 Claude Code 화면을 일회용 세션으로 찍어 픽스처로 남기고, 그 픽스처로 화면 판별·키 매핑을 고정한다.

**Files:**
- Create: `packages/happy-cli/src/claudeAgents/dialogs.ts`, `packages/happy-cli/src/claudeAgents/__fixtures__/screens/*.txt`, `packages/happy-cli/scripts/capture-claude-dialogs.mjs`
- Test: `packages/happy-cli/src/claudeAgents/dialogs.test.ts`

**Interfaces:**
- Consumes: `openAttachTerminal`(Task 3), `PendingToolUse`(Task 2)
- Produces:
  - `type DialogKind = 'none' | 'permission' | 'question' | 'plan' | 'unknown'`
  - `classifyScreen(screen: string): DialogKind`
  - `screenMatchesPending(screen: string, pending: PendingToolUse, cwd: string): boolean` — 조건 ④. 창 자체의 줄(창 맨 위 가로줄부터 맨 아래 줄까지)만 본다. Write·Edit·Read는 창 제목·묻는 문구가 도구와 맞고 `file_path === resolve(cwd, 화면의 경로)`(cwd가 비면 false). Bash는 제목 `Bash command`이고 명령 칸 전체가 `command`와 같다(공백 무시, 잘려 보이면 false). AskUserQuestion은 탭 줄 바로 아래 질문 문장 전체가 첫 질문과 같고 손대지 않은 상태. ExitPlanMode는 손대지 않은 계획 창. 나머지 도구는 이름이 비지 않고 창 제목의 한 단어로 들어 있을 때. 마지막 `tool_use`가 `Task`/`Agent`이면 항상 false.
  - `keysForPermission(approved: boolean, screen: string): AttachKey[] | null` — 화면에서 `Yes`/`No` 선택지 번호를 읽는다(창마다 `No`가 2 또는 3). 못 읽으면 null.
  - `keysForQuestion(input: Record<string, unknown>, answers: Record<string, string>): AttachKey[] | null` — `answers`는 앱이 보내는 `updatedInput.answers`(질문 문장 → `"a, b"`). 매핑할 수 없으면 null.
  - `keysForPlan(approved: boolean, mode: string | undefined, reason: string | undefined): { keys: AttachKey[]; thenType?: string; thenPress?: AttachKey[] }` — 승인은 항상 수동 승인(2번).
  - `DIALOG_KEY_GAP_MS = 600` — 키 사이 간격.
  - `isInputBoxEmpty(screen: string): boolean` — Review Focus 1용.

- [ ] **Step 1: 화면 수집 스크립트 작성·실행** — `capture-claude-dialogs.mjs`는 `~/workspace`에서 일회용 `claude --bg --model haiku --name jarvis-dialog-capture`를 띄운다. 그다음 attach 터미널로 프롬프트를 넣어 아래 화면을 `capture-pane`으로 찍는다.
  - 화면: Write 권한 창, Bash 권한 창, 단일 선택 질문, 여러 개 선택 질문, "기타" 입력, 계획 승인 창, 입력창이 빈 화면, 입력창에 글자가 있는 화면, 서브에이전트 권한 창.
  - 각 화면에서 키를 넣은 뒤의 결과(기록 파일의 tool_result)도 함께 기록한다.
  - 끝나면 `claude stop`·`claude rm`으로 지운다.
  - 픽스처의 경로·이름은 가짜 값으로 바꿔 `__fixtures__/screens/`에 저장한다.
  - 확인한 키 순서(번호·이동·확정 키)는 이 Task의 커밋 메시지 본문에 적는다.
- [ ] **Step 2: 실패하는 테스트 작성** — 픽스처마다.
  - `classifyScreen` 기대값: 권한 창 2개는 permission, 질문 3개는 question, 계획은 plan, 빈 입력창은 none.
  - `screenMatchesPending`: 맞는 pending에는 true. 파일 이름이 다른 pending에는 false. 서브에이전트 창에 Task pending을 주면 false.
  - `keysForPermission(true)`·`(false)`: 실측 키와 같다.
  - `keysForQuestion`: 단일·여러 개·기타 실측 키와 같다. 선택지에 없는 답이면 null.
  - `keysForPlan`: 승인(mode 둘)·거부+이유 실측 키와 같다.
  - `isInputBoxEmpty`: 빈 화면 true, 글자 있는 화면 false.
- [ ] **Step 3: 실패 확인** → FAIL.
- [ ] **Step 4: 구현.**
- [ ] **Step 5: 통과 확인** → PASS.
- [ ] **Step 6: 커밋** — `feat(cli): recognise Claude Code dialogs and map answers to keys`. 픽스처에 개인 경로가 없는지 `grep -r "/Users/" src/claudeAgents/__fixtures__`로 확인(가짜 `/Users/tester`만).

### Task 5: 폰 입력 전달과 중복 방지

**Files:**
- Create: `packages/happy-cli/src/claudeAgents/inputDelivery.ts`
- Modify: `packages/happy-cli/src/claudeAgents/attachTerminal.ts`(`screen()`을 `capture-pane -p -e`로: 색 정보 포함), `attachTerminal.test.ts`
- Test: `packages/happy-cli/src/claudeAgents/inputDelivery.test.ts`

**Interfaces:**
- Consumes: `AttachTerminal`, `sanitizeTypedText`(Task 3), `isInputBoxEmpty`(Task 4, `-e` 화면에서 흐린 제안 글자를 빈 칸으로 본다)
- `screen()`은 ANSI가 섞인 화면을 돌려준다. Task 4의 판별 함수들은 ANSI를 지우고 읽는다.
- 입력창 위에 세션 설문(`1: Bad 2: Fine 3: Good 0: Dismiss`)이 보이면 `0`을 눌러 닫고 화면을 다시 읽은 뒤 넣는다.
- Produces:
  - `createEchoFilter(): { remember(text: string): void; shouldSkip(userText: string): boolean }` — 공백 정리 후 비교. 기억한 횟수만큼만 건너뛴다.
  - `type DeliveryResult = 'sent' | 'busy-input' | 'failed'`
  - `createInputDelivery(deps: { openTerminal: () => Promise<AttachTerminal>; echo: ReturnType<typeof createEchoFilter>; waitInputMs?: number }): { send(text: string): Promise<DeliveryResult>; interrupt(): Promise<void> }` — 직렬 처리. 한 줄이면 `typeText`, 여러 줄이면 `pasteText`, 그다음 `enter`, 400ms 뒤 close. 입력창이 차 있으면 `waitInputMs`(기본 10000)까지 기다렸다가 `busy-input`. `interrupt`는 `escape` 한 번.
- [ ] **Step 1: 실패하는 테스트 작성** — 가짜 `AttachTerminal`(화면 문자열과 입력 기록을 가진 객체)을 쓴다.
  - `send types single-line text then enter and closes`.
  - `send pastes multi-line text`.
  - `sends are serialized`: 동시에 2개 → 기록 순서 유지, 터미널 2번 열고 닫음.
  - `send waits for a non-empty input box and gives up with busy-input` (`waitInputMs: 50`).
  - `send sanitizes control characters before typing`.
  - `echo filter skips only as many copies as were remembered`: remember('hi') 1회 → shouldSkip('hi') true, 다음 shouldSkip('hi') false.
  - `interrupt presses escape once`.
  - `send treats a dim suggestion as an empty input box` (Task 4 픽스처 `input-suggestion-ansi`).
  - `send dismisses the session survey with 0 before typing` (Task 4 픽스처 `input-suggestion-and-survey`).
  - `attachTerminal`: `screen() keeps colour escapes`.
- [ ] **Step 2: 실패 확인** → FAIL.
- [ ] **Step 3: 구현.**
- [ ] **Step 4: 통과 확인** → PASS.
- [ ] **Step 5: 커밋** — `feat(cli): deliver phone messages to a background session`.

### Task 6: 권한·질문·계획 다리

**Files:**
- Create: `packages/happy-cli/src/claudeAgents/permissionBridge.ts`
- Test: `packages/happy-cli/src/claudeAgents/permissionBridge.test.ts`

**Interfaces:**
- Consumes: Task 2·3·4의 함수와 타입, `AgentState`·`PermissionResponse` 타입(`api/types.ts`, `claude/utils/permissionHandler.ts`)
- Produces:
  - `createPermissionBridge(deps: { readStatus(): ClaudeAgentStatus | null; readEntries(): unknown[]; openTerminal(): Promise<AttachTerminal>; updateAgentState(update: (s: AgentState) => AgentState): void; notifyPermission(tool: string): void; now(): number }): { tick(): Promise<void>; answer(response: PermissionResponse): Promise<'typed' | 'refused'> }`
  - `dialogs.ts`에 추가(화면만 보고 창을 읽는 부분):
    - `dialogFingerprint(screen: string): string | null` — 창 영역(첫 가로줄~맨 아래 가로줄, ANSI 제거, 공백 정리, 상태줄 제외)의 sha1. 창이 없으면 null. 같은 창을 다시 그려도 같아야 한다.
    - `readDialogFromScreen(screen: string): { tool: string; input: Record<string, unknown> } | null` — 권한 창은 도구 이름과 대상(`file_path`의 파일 이름, Bash `command`), 질문 창은 지금 질문 하나의 `{ questions: [{ question, options: [{label}], multiSelect }] }`, 계획 창은 `{ plan: '' }`. 다 읽을 수 없으면(여러 질문 탭, 잘린 명령, 모르는 문구, `· from the … agent`) null.
  - `tick`:
    - `waiting`이고 `classifyScreen`이 permission/question/plan이면 요청을 만든다. 키는 기록에 결과 없는 `tool_use`가 있고 화면과 맞으면 그 id, 아니면 `screen:<dialogFingerprint>`. 내용은 그 `tool_use` 입력, 없으면 `readDialogFromScreen`. 그것도 null이면 `tool: 'Unknown'` 안내 요청(답하면 거절됨). 요청마다 화면·지문·만든 시점의 기록 길이를 메모리에 둔다. `requests[키]`를 쓰고(이미 있으면 그대로) 처음 쓸 때 한 번 알린다.
    - 창이 사라졌거나 `waiting`이 아니면 남은 요청을 완료한다. 기록 id 요청은 `findToolUseOutcome`. `screen:` 요청은 만든 뒤 새로 생긴 `tool_use` 중 저장한 화면과 `screenMatchesPending`이 참인 것을 찾아 그 결과를 쓴다. `completedRequests[키] = { …, completedAt, status, decision }`(`screen:`이면 `toolUseId` 없음). 결과가 없으면 다음 tick에서 다시 본다. 5회 연속 없으면 `canceled`.
  - `answer`:
    - 네 조건을 확인한다(`readStatus()==='waiting'`, 지금 화면의 `dialogFingerprint`가 저장한 지문과 같고 기록 id 요청이면 `findPendingToolUse()?.id`도 같음, `classifyScreen` 결과가 도구 종류와 일치, `screenMatchesPending`).
    - 모두 맞으면 도구에 맞는 키를 하나씩 `DIALOG_KEY_GAP_MS` 간격으로 넣는다(권한은 `keysForPermission(approved, screen)`, AskUserQuestion은 `keysForQuestion(input, response.updatedInput?.answers)`, ExitPlanMode는 `keysForPlan(...)`의 `keys` → `thenType` → `thenPress`). 그 뒤 `completedRequests`로 옮기고 `'typed'`를 돌려준다.
    - 하나라도 어긋나거나 키 매핑이 null이면 키를 넣지 않는다. `completedRequests[키]`를 `canceled`로 쓰고 `reason: 'answer-on-mac'`을 붙인 뒤 `'refused'`를 돌려준다.
- [ ] **Step 1: 실패하는 테스트 작성** — Task 4 픽스처 화면을 가짜 터미널에 물린다.
  - `tick publishes a request when the session is already waiting` (Review Focus 3).
  - `tick does not notify twice for the same request`.
  - `answer types the permission keys when all four checks pass`.
  - `answer refuses when the status is no longer waiting` / `when the pending id changed` / `when the screen shows a different file` / `when the pending tool is Task`.
  - `answer types question keys from updatedInput.answers`.
  - `answer types plan approval keys for mode acceptEdits`.
  - `tick records a Mac-side approval as approved` / `a Mac-side rejection as denied` (기록 파일에 tool_result 추가 후 status idle).
  - `tick cancels after five ticks without an outcome`.
  - `tick publishes a screen: request when the transcript has no pending tool_use` / `answer refuses when the dialog fingerprint changed` / `answer presses keys one at a time with the gap` / `a Mac-side answer to a screen: request completes from the later tool_use` / `an unreadable dialog publishes a request that refuses answers`.
  - `dialogFingerprint is stable across a redraw and differs between dialogs`, `readDialogFromScreen` 픽스처별 기대값.
  - `transcript.test.ts`: `findPendingToolUse ignores an ExitPlanMode re-emitted after its result`.
- [ ] **Step 2: 실패 확인** → FAIL.
- [ ] **Step 3: 구현.**
- [ ] **Step 4: 통과 확인** → PASS.
- [ ] **Step 5: 커밋** — `feat(cli): answer background session dialogs from the phone`.

### Task 7: 거울 프로세스

**Files:**
- Create: `packages/happy-cli/src/claudeAgents/runClaudeAgentMirror.ts`
- Modify: `packages/happy-cli/src/index.ts`(하위 명령 `claude-agent-mirror` 분기 추가, `resume` 분기 옆), `packages/happy-cli/src/api/types.ts:296`(`Metadata`에 `claudeAgentId?: string`)
- Test: `packages/happy-cli/src/claudeAgents/runClaudeAgentMirror.test.ts`

**Interfaces:**
- Consumes: Task 1~6 전부. `ApiClient.getOrCreateSession`·`sessionSyncClient`(`api/api.ts`), `createSessionScanner`(`claude/utils/sessionScanner.ts`), `sendClaudeSessionMessageFromLocalTranscript`, `onUserMessage`, `notifyDaemonSessionStarted`(`daemon/controlClient.ts`), `HAPPY_RECONNECT_*` 처리 방식(`claude/runClaude.ts:157-180`).
- Produces:
  - `runClaudeAgentMirror(opts: { agentId: string }): Promise<void>` — 명령: `happy claude-agent-mirror <agentId>`.
  - `buildMirrorMetadata(agent: ClaudeAgent, base: { host: string; machineId: string; homeDir: string; happyHomeDir: string; happyLibDir: string; happyToolsDir: string }): Metadata` — `flavor: 'claude'`, `path`·`cwd: agent.cwd`, `claudeSessionId: agent.sessionId`, `claudeAgentId: agent.id`, `startedBy: 'daemon'`, `name: agent.name ?? basename(cwd)`.
  - `mirrorTag(agentId: string): string` → `claude-agent-${agentId}`.
- 동작 순서:
  1. `fetchClaudeAgents`로 대상 찾기. 없으면 종료 코드 2.
  2. `HAPPY_RECONNECT_*`가 있으면 그 키로 붙고, 없으면 `getOrCreateSession({ tag: mirrorTag(id) })`.
  3. `notifyDaemonSessionStarted(sessionId, metadata, encryption)`로 데몬에 신고(데몬이 키를 저장).
  4. 스캐너를 `onNewSession(agent.sessionId)`로 시작한다. 업로드 시 `echo.shouldSkip`인 사용자 메시지는 건너뛴다. 재연결이면 이미 올린 메시지를 다시 올리지 않는다. 마지막으로 올린 uuid는 거울 전용 파일 `<happyHomeDir>/claude-agent-mirrors/<agentId>.json`(`{ happySessionId, lastUuid }`, 권한 0600)에 올릴 때마다 저장한다. 다시 열 때는 이 파일의 `happySessionId`가 같을 때만 `lastUuid`를 쓴다.
  5. `onUserMessage` → `echo.remember(text)` → `delivery.send(text)`. `busy-input`이면 세션 이벤트 메시지로 "맥에서 입력 중이라 보내지 못했습니다"를 보낸다. 첨부가 있으면 "이 세션은 텍스트만 받습니다".
  6. 중단 RPC(기존 abort 처리 이름 그대로) → `delivery.interrupt()`.
  7. 세션 RPC `permission` → `bridge.answer`.
  8. 1초 간격: `bridge.tick()`.
  9. 3초 간격: `fetchClaudeAgents` → `decideAgentChange(agents, agentId, currentSessionId)`. `'gone'`이면 Happy 세션을 끝남 상태로 바꾸고 종료한다(Review Focus 4). `{ switchTo }`이면 `onNewSession(switchTo)`을 부르고 메타데이터 `claudeSessionId`를 갱신한다. `fetchClaudeAgents` 자체가 실패하면(명령 오류) 3번 연속일 때만 `'gone'`으로 본다.
- 추가 export: `decideAgentChange(agents: ClaudeAgent[], agentId: string, currentSessionId: string): 'same' | 'gone' | { switchTo: string }`.
- [ ] **Step 1: 실패하는 테스트 작성** — 네트워크 없는 순수 부분만.
  - `buildMirrorMetadata sets claudeAgentId, claudeSessionId and path`.
  - `mirrorTag is stable per agent id`.
  - `entriesAfter drops entries up to the saved uuid`(이 순수 함수 `entriesAfter(entries: unknown[], lastUuid: string | null): unknown[]`를 이 파일에서 내보낸다). 저장된 uuid가 기록에 없으면 전체를 돌려준다.
  - `decideAgentChange returns gone when the id is missing` / `switchTo when the sessionId changed` / `same otherwise`.
- [ ] **Step 2: 실패 확인** → FAIL.
- [ ] **Step 3: 구현.**
- [ ] **Step 4: 통과 확인** → PASS. `npx tsc --noEmit` → 오류 없음.
- [ ] **Step 5: 커밋** — `feat(cli): mirror a Claude background session into a Happy session`.

### Task 8: 데몬 RPC와 resume 거절

**Files:**
- Create: `packages/happy-cli/src/claudeAgents/daemonHandlers.ts`
- Modify:
  - `packages/happy-cli/src/api/apiMachine.ts:123-128`: `MachineRpcHandlers`에 `claudeAgents?: ClaudeAgentHandlers`.
  - 같은 파일 `setRPCHandlers`: 있으면 `list-claude-agents`·`open-claude-agent` 등록.
  - `packages/happy-cli/src/daemon/run.ts`: `setRPCHandlers` 호출(1010행 부근)에 handlers 연결. `resumeSession`(728행)에서 persisted metadata에 `claudeAgentId`가 있으면 오류 반환.
- Test: `packages/happy-cli/src/claudeAgents/daemonHandlers.test.ts`

**Interfaces:**
- Consumes: Task 1(`fetchClaudeAgents`, `resolveClaudeBinary`, `isTmuxInstalled`), `readPersistedSessions`(`persistence.ts:473`), 데몬의 `spawnTrackedHappyProcess`(`daemon/run.ts:601`)와 `pidToTrackedSession`.
- Produces:
  - `type ClaudeAgentHandlers = { list(): Promise<ClaudeAgentsListing>; open(agentId: string): Promise<{ type: 'success'; sessionId: string } | { type: 'error'; errorMessage: string }> }`
  - `createClaudeAgentHandlers(deps: { resolveClaude(): Promise<string | null>; tmuxInstalled(): Promise<boolean>; fetchAgents(claudePath: string): Promise<ClaudeAgent[]>; liveMirrors(): Map<string, string> /* agentId → happySessionId */; persistedMirrors(): Map<string, { happySessionId: string; encryptionKey: string; encryptionVariant: 'legacy' | 'dataKey'; seq: number; metadataVersion: number; agentStateVersion: number }>; spawnMirror(agentId: string, reconnect?: { happySessionId: string; env: Record<string, string> }): Promise<{ type: 'success'; sessionId: string } | { type: 'error'; errorMessage: string }> }): ClaudeAgentHandlers`
  - RPC 응답:
    - `list-claude-agents` → `ClaudeAgentsListing`(살아 있는 거울은 `mirrorSessionId`).
    - `open-claude-agent { id }` → 위 open 결과.
  - resume 거절 문구: `"This session mirrors a Mac background session. Open it from the background session list."`
- [ ] **Step 1: 실패하는 테스트 작성** — deps를 가짜로.
  - `list reports claude-missing when claude cannot be found` / `tmux-missing when tmux is absent`.
  - `list attaches mirrorSessionId for live mirrors`.
  - `open returns the live mirror without spawning`.
  - `open reconnects with persisted keys when the mirror is not running` → `spawnMirror`가 `HAPPY_RECONNECT_SESSION_ID` 등 6개 env와 함께 불림.
  - `open spawns fresh when nothing is known`.
  - `open errors for an unknown agent id`.
  - `resume refuses a mirror session` — `daemon/run.ts`의 거절 조건은 `isClaudeAgentMirror(metadata: Metadata | undefined): boolean`(daemonHandlers.ts에서 export)로 테스트.
- [ ] **Step 2: 실패 확인** → FAIL.
- [ ] **Step 3: 구현** — `spawnMirror`는 `spawnTrackedHappyProcess({ args: ['claude-agent-mirror', agentId], cwd: agent.cwd, env, reconnect })` 후 기존 awaiter로 webhook의 sessionId를 기다린다.
- [ ] **Step 4: 통과 확인** → `npx vitest run --project unit src/claudeAgents` PASS. `npx tsc --noEmit` 오류 없음. 전체 `npx vitest run --project unit` 기존 테스트 회귀 없음.
- [ ] **Step 5: 커밋** — `feat(cli): list and open Claude background agents over machine RPC`.

### Task 9: 앱 — 거울 세션 알아보기와 막을 조작

**Files:**
- Create: `packages/happy-android/app/src/main/kotlin/com/slopus/happy/model/ClaudeAgentMirror.kt`
- Modify:
  - `model/SessionMetadata.kt`: 필드 `claudeAgentId: String? = null`(278행 부근), 파서 `f.optional("claudeAgentId", Read.string)`(389행 부근).
  - `model/SessionPresentation.kt:114` `forkSource()`: 거울이면 null. fork·복제·되감기·사이드챗이 함께 막힌다.
  - `ui/home/SessionQuickActions.kt:28` `resumeAvailability`: 거울이면 `Hidden`.
  - `chat/ComposerModes.kt:42,45,48`: 거울이면 모델·추론·권한 모드 선택 false.
  - `ui/attachments/ComposerAttachments.kt:58`, `attachments/AttachmentSupport.kt:56`: 거울이면 첨부 false.
  - `ui/chat/ChatHeader.kt`: 거울이면 제목 아래 "맥 백그라운드 세션" 한 줄.
  - `chat/ChatReducer.kt`: 거울 세션에서 완료된 `screen:` 권한 카드(독립 도구 메시지) 뒤에 같은 도구 이름의 실제 도구 메시지가 오면 `screen:` 카드를 숨긴다. 계획 승인 카드의 자동 수락 선택지는 거울에서 숨긴다(승인은 항상 수동 승인).
- Test: `packages/happy-android/app/src/test/kotlin/com/slopus/happy/model/ClaudeAgentMirrorTest.kt`

**Interfaces:**
- Produces: `fun SessionMetadata?.isClaudeAgentMirror(): Boolean` (`!claudeAgentId.isNullOrBlank()`)
- [ ] **Step 1: 실패하는 테스트 작성** — `ClaudeAgentMirrorTest`:
  - `parses claudeAgentId from metadata JSON`.
  - `forkSource is null for a mirror`.
  - `resumeAvailability hides resume for a mirror`.
  - `model and permission selection are off for a mirror`.
  - `attachments are off for a mirror`.
  - `a normal Claude session keeps fork and resume`(회귀 방지).
  - `a completed screen: card is hidden once the real tool message arrives`.
- [ ] **Step 2: 실패 확인** — `cd packages/happy-android && ./gradlew :app:testDebugUnitTest --tests 'com.slopus.happy.model.ClaudeAgentMirrorTest'` → FAIL.
- [ ] **Step 3: 구현.** 새 문구는 `packages/happy-i18n/translations/*.json`에 넣고 `node packages/happy-android/tools/translations/generate.mjs`로 생성한다(영어 원문 "Mac background session", 다른 로케일은 같은 뜻으로 번역).
- [ ] **Step 4: 통과 확인** — 같은 명령 → PASS. 그다음 `./gradlew :app:testDebugUnitTest` 전체 → 실패 0.
- [ ] **Step 5: 커밋** — `feat(android): treat Mac background session mirrors as their own kind`.

### Task 10: 앱 — 홈의 "Claude 백그라운드 세션" 섹션

**Files:**
- Create:
  - `packages/happy-android/app/src/main/kotlin/com/slopus/happy/sync/ClaudeAgents.kt`(응답 모델·파서)
  - `ui/home/ClaudeAgentsSection.kt`(컴포저블 + 상태 로더)
- Modify:
  - `sync/MachineOps.kt`: `listClaudeAgents`, `openClaudeAgent` 추가. 다른 머신 RPC와 같은 모양.
  - `ui/home/HomeListHost.kt`: 목록 위에 섹션 연결.
  - i18n 카탈로그.
- Test: `app/src/test/kotlin/com/slopus/happy/sync/ClaudeAgentsTest.kt`, 기존 `sync/MachineOpsTest.kt`에 케이스 추가.

**Interfaces:**
- Consumes: Task 8 RPC 응답 모양, `isClaudeAgentMirror`(Task 9)
- Produces:
  - `data class ClaudeAgentEntry(val id: String, val sessionId: String, val name: String?, val cwd: String, val status: String, val startedAt: Long, val mirrorSessionId: String?)`
  - `data class ClaudeAgentsListing(val agents: List<ClaudeAgentEntry>, val unavailable: String?)`
  - `fun parseClaudeAgentsListing(json: JsonElement?): ClaudeAgentsListing`
  - `suspend fun MachineOps.listClaudeAgents(machineId: String): ClaudeAgentsListing` — RPC 실패(옛 데몬)면 `ClaudeAgentsListing(emptyList(), "unsupported")`.
  - `sealed interface OpenClaudeAgentResult { data class Success(val sessionId: String); data class Error(val message: String) }`
  - `suspend fun MachineOps.openClaudeAgent(machineId: String, id: String): OpenClaudeAgentResult`
- 화면 규칙:
  - 온라인 머신마다 섹션을 그린다. 홈 진입 때와 당겨서 새로고침할 때 다시 부른다.
  - 행: 이름(없으면 폴더 끝부분), 폴더 끝부분, 상태(일하는 중 / 대기 / 권한 기다림).
  - 이미 홈에 거울 세션 행이 있는 항목(`mirrorSessionId`가 홈 세션 목록에 있음)은 섹션에서 뺀다.
  - 누르면 `openClaudeAgent` 뒤 받은 sessionId로 채팅 화면을 연다.
  - `unavailable`: `"unsupported"`면 섹션을 숨긴다. `"tmux-missing"`·`"claude-missing"`이면 안내 한 줄. 목록이 비면 섹션을 숨긴다.
- [ ] **Step 1: 실패하는 테스트 작성**
  - `parseClaudeAgentsListing reads agents and unavailable`.
  - `listClaudeAgents maps an RPC error to unsupported`.
  - `openClaudeAgent returns Success with sessionId` / `Error with errorMessage`.
  - `section hides agents that already have a mirror row`(필터 함수 `visibleAgents(listing, homeSessionIds): List<ClaudeAgentEntry>`를 `ClaudeAgentsSection.kt`에서 export).
- [ ] **Step 2: 실패 확인** — `./gradlew :app:testDebugUnitTest --tests 'com.slopus.happy.sync.ClaudeAgentsTest' --tests 'com.slopus.happy.sync.MachineOpsTest'` → FAIL.
- [ ] **Step 3: 구현.** 행 스타일은 기존 홈 세션 행(`FlatSessionRow.kt`)을 따른다.
- [ ] **Step 4: 통과 확인** → PASS. 전체 `./gradlew :app:testDebugUnitTest` 실패 0.
- [ ] **Step 5: 커밋** — `feat(android): list and open Mac background Claude sessions from home`.

### Task 11: 실기기 종단 확인

**Files:** 없음(확인만). 결과는 `docs/superpowers/specs/2026-11-09-claude-agents-remote-design.md` 끝에 "확인 기록" 절로 덧붙인다.

- [ ] **Step 1: 사용자 승인 받기** — 맥 전역 CLI를 포크 빌드로 바꾼다고 알리고 승인을 받는다. 데몬이 재시작되면 실행 중인 Happy 세션이 끊길 수 있다는 점도 알린다. 백업은 `~/workspace/happy-fork/global-backup/happy-1.2.6-official`. 승인 전에는 Step 2 이후를 하지 않는다.
- [ ] **Step 2: 설치** — `cd packages/happy-cli && pnpm run build` 뒤 사용자가 승인한 방식으로 전역 설치, `happy daemon stop` → `happy daemon start`.
- [ ] **Step 3: 앱 설치** — `zsh ~/.config/jarvis-remote/build.sh <다음 versionCode> assembleRelease` 대신 디버그 빌드 `./gradlew :app:installDebug`를 USB 폰(R3CW50AG2KM, `--user 0`)에 설치.
- [ ] **Step 4: 흐름 확인** — `~/workspace`에서 일회용 `claude --bg --model haiku --name jarvis-e2e` 세션으로 확인한다.
  - 앱 홈에 보인다 → 누르면 기록이 보인다.
  - 폰 입력이 맥 `claude attach jarvis-e2e` 화면에 사용자 입력으로 뜨고, 답이 폰에 온다.
  - 맥에서 입력하면 폰에 뜬다(중복 없음).
  - 권한 창: 폰 허용, 폰 거부, 맥에서 먼저 허용(폰 카드가 허용으로 바뀜).
  - 질문: 단일·여러 개·기타. 계획: 승인·거부.
  - 중단 버튼이 동작한다.
  - 맥에서 `/clear` 뒤에도 따라간다.
  - `claude stop`·`rm` 뒤 폰 세션이 끝남으로 바뀐다.
  - 거울 세션에서 resume·fork·첨부·모델 선택이 안 보인다.
- [ ] **Step 5: 정리와 커밋** — 일회용 세션 `claude stop`·`claude rm`. 확인 기록을 덧붙여 `docs: record end-to-end check for background session mirroring` 커밋, `git push geunwoo HEAD:remote-ux`.

### Task 12: 맥에 열어 둔 cmux 창 먼저 쓰기 (2단 방식)

스펙 5-1절. 맥 사용자가 cmux 창에서 `claude attach <agentId>`를 열어 두었으면 폰 입력·답을 그 창에 넣고, 없거나 쓸 수 없으면 지금처럼 전용 tmux로 간다. 사용자 창은 절대 닫지 않는다.

**Files:**
- Create: `packages/happy-cli/src/claudeAgents/cmuxTerminal.ts`, `cmuxTerminal.test.ts`
- Create fixtures (이미 비식별화됨, 그대로 복사): `<scratch>/t12-fixtures/{w120,w99,q120,q99}.txt` → `__fixtures__/screens/{write-perm-120,write-perm-99,question-long-120,question-long-99}.txt` + README 표에 4행(“같은 대화상자를 tmux 120×40·cmux 99×35에서 캡처”).
- Modify: `dialogs.ts`(`dialogFingerprint`), `inputDelivery.ts`, `permissionBridge.ts`, `runClaudeAgentMirror.ts`.

**Interfaces:**
- Consumes: `AttachTerminal`/`AttachKey`(Task 3), `isInputBoxEmpty`·`hasSessionSurvey`·`classifyScreen`·`dialogFingerprint`(Task 4·5), `serializeTerminalOpens`(Task 7).
- Produces:
  - `export function attachPidsNewestFirst(psOutput: string, agentId: string): number[]` — 입력은 `ps -axo pid=,etime=,args=` 출력. args 토큰의 마지막 두 개가 `attach`, `<agentId>`인 줄만. `etime`(`[[dd-]hh:]mm:ss`)이 작은 것(새것)부터.
  - `export function surfaceForPid(topTsv: string, pid: number): string | null` — 입력은 `cmux top --all --processes --format tsv`. 열: cpu, mem, count, type, id, parent, name. 프로세스 행의 parent를 따라 올라가 `surface:N`을 만나면 그 ref, 못 만나면 null(전용 tmux로 띄운 attach는 cmux 표면 밑에 없으므로 자연히 빠진다). 순환·깊이 64 초과는 null.
  - `export async function findAgentSurface(agentId: string): Promise<string | null>` — 위 두 명령을 매번 새로 실행(캐시 없음), 새 pid부터 처음 찾은 surface. 어떤 실패든 null.
  - `export function openCmuxTerminal(surface: string): AttachTerminal`:
    - `screen()` → `cmux read-screen --surface <ref>`.
    - `typeText(t)` → `t`에 `\n`·`\r`·`\t`·`\\`가 있으면 throw(아무것도 보내지 않음), 아니면 `cmux send --surface <ref> -- <t>`.
    - `pasteText()` → 항상 throw.
    - `press(keys)` → 이름 키는 `cmux send-key --surface <ref> <enter|escape|up|down|space|tab|backspace>`, `{digit}`은 `cmux send --surface <ref> -- <d>`.
    - `close()` → 아무것도 안 함.
  - `export function cmuxTypable(text: string): boolean` — 위 typeText가 받아들이는지.
  - cmux 실행 파일: PATH의 `cmux`, 없으면 `/Applications/cmux.app/Contents/Resources/bin/cmux`. 둘 다 없으면 `findAgentSurface`가 null. 새 npm 의존성 없음(`child_process.execFile`).
  - `InputDeliveryDeps`·`PermissionBridgeDeps`에 선택 필드 `openUserTerminal?: () => Promise<AttachTerminal | null>` 추가. 없으면 지금 동작 그대로(기존 테스트 무수정 통과).

**동작 규칙(구현 판단 지점):**
- 잠금: 거울에서 cmux 창과 tmux 여는 일은 같은 `serializeTerminalOpens` 잠금 하나를 쓴다(한 번에 한 터미널). `openUserTerminal`은 잠금 안에서 `findAgentSurface`를 부르고, null이면 잠금을 바로 푼다.
- 입력(`deliver`): 사용자 창이 있고, 화면 한 번 읽어 `isInputBoxEmpty && !hasSessionSurvey`이고, 글이 한 줄이며 `cmuxTypable`이면 → `echo.remember` → `typeText` → `enter` → `'sent'`(기다리지 않음). 조건 하나라도 아니면, 또는 글자를 보내기 전에 cmux 명령이 실패하면 → 지금의 tmux 경로. `typeText`가 시작된 뒤 실패하면 tmux로 다시 보내지 않고 `'failed'` + `echo.forget`(같은 글이 두 번 들어가는 일 금지).
- 멈춤(`interrupt`): 사용자 창이 있으면 그 창에 `escape`, cmux가 실패하면 tmux.
- 다리 `tick`: 사용자 창이 있으면 그 화면을, 없거나 읽기 실패면 tmux 화면을 쓴다.
- 다리 `answer`: 먼저 사용자 창에서 지금의 네 가지 확인 + `stepsFor`. 결과가 null/빈 목록이거나, 단계 중 `typeText` 글이 `cmuxTypable`이 아니거나, 첫 키 전에 cmux가 실패하면 → 그 창은 두고 tmux를 열어 같은 확인부터 다시. 둘 다 안 되면 지금처럼 refuse. 키를 하나라도 누른 뒤의 실패는 지금처럼 canceled(다른 터미널로 재시도 금지).
- 지문: `dialogFingerprint`는 지금 고른 영역에서 모든 공백과 줄긋기 문자(`─━│┃╭╮╰╯┌┐└┘├┤┬┴┼`)를 지운 뒤 해시한다. 그래서 폭이 달라 줄바꿈 위치가 달라도 같은 대화상자는 같은 값.

- [ ] **Step 1: 실패하는 테스트 작성**
  - `cmuxTerminal.test.ts`:
    - `attachPidsNewestFirst picks only attach <id> and orders newest first` — 고정 ps 문자열(같은 id 2개 etime `01:02:03`·`00:05`, 다른 id 1개, `attach 19f0c660x` 같은 접두 비슷한 것 1개) → 새 pid 하나, 옛 pid 하나 순서.
    - `surfaceForPid walks parents to a surface` — 고정 tsv: pid → zsh pid → `surface:8` → `surface:8`. 표면 밑에 없는 pid → null. 순환 → null.
    - `typeText refuses newline, tab and backslash without sending` — `openCmuxTerminal`이 실행기를 주입받을 수 있게 둘째 인자 `run?: (args: string[]) => Promise<string>`(테스트 전용, 기본은 실제 실행). 거절 시 `run` 호출 0회.
    - `press sends named keys with send-key and digits with send` — 기록된 args 비교.
    - `close does nothing` — `run` 호출 0회.
  - `dialogs.test.ts`:
    - `fingerprint ignores terminal width` — `dialogFingerprint(write-perm-120) === dialogFingerprint(write-perm-99)`, `question-long-120` === `question-long-99`, 둘 다 null 아님.
    - `width does not change what is read` — 두 폭에서 `classifyScreen`·`readDialogFromScreen`이 같다.
    - 기존 지문 테스트는 값이 바뀌어도 “같다/다르다” 관계만 유지되면 된다(다른 대화상자끼리는 여전히 다름).
  - `inputDelivery.test.ts`(가짜 터미널, 기존 스타일):
    - `sends through the user terminal when its box is empty` — tmux opener 호출 0회.
    - `falls back to tmux when the user is typing` — 사용자 창 화면의 입력칸에 글자 → tmux로 전달, 사용자 창엔 키 0개.
    - `falls back to tmux for multi-line or backslash text`.
    - `falls back to tmux when the user terminal fails before typing`.
    - `does not resend through tmux after typing started` — 사용자 창 `press(enter)`가 throw → `'failed'`, tmux 호출 0회.
  - `permissionBridge.test.ts`:
    - `answers on the user terminal when the four checks pass` — tmux opener 0회.
    - `answers through tmux when the user terminal shows another screen` — 사용자 창 화면이 다른 대화상자 → tmux에서 같은 확인 후 키.
    - `does not retry on tmux after a key was pressed on the user terminal`.
    - `tick publishes from the user terminal screen` — 사용자 창 99폭 화면으로 만든 요청을 tmux 120폭 화면에서 답할 수 있다(지문 같음).
- [ ] **Step 2: 실패 확인** — `cd packages/happy-cli && npx vitest run src/claudeAgents/cmuxTerminal.test.ts src/claudeAgents/dialogs.test.ts src/claudeAgents/inputDelivery.test.ts src/claudeAgents/permissionBridge.test.ts` → FAIL.
- [ ] **Step 3: 구현.** 위 규칙대로. `runClaudeAgentMirror.ts`에서 `openUserTerminal = () => findAgentSurface(agentId)` 결과로 `openCmuxTerminal`을 만들어 delivery·bridge 둘 다에 넘긴다(잠금 공유). cmux 경로를 탔는지는 디버그 로그 한 줄(`[claude-agent] input via cmux surface:N` / `via tmux`).
- [ ] **Step 4: 통과 확인** — 같은 명령 PASS, 이어서 `npx vitest run src/claudeAgents` 전체 PASS, `npx tsc --noEmit` 오류 0.
- [ ] **Step 5: 커밋** — `feat(cli): drive the Mac's open cmux attach pane before the private tmux`.
