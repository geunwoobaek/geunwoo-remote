# 긴 채팅 최근 부분만 먼저 보이기 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 메시지가 몇 개든 채팅을 열면 최근 약 300개로 첫 화면을 그리고, 사용자가 맨 위에 닿을 때마다 그 이전 약 300개를 한 묶음씩 덧붙인다.

**Architecture:** `MessageSync`가 세션마다 "창"(하한 순번 floor)을 들고, 채팅 화면은 폰 DB에서 `seq >= floor`만 읽는다. 하한은 내려가기만 하고, 처음 값과 내릴 값은 순수 함수 `RecentWindow`가 레코드에서 고른다(한 차례의 시작에 맞춤). 받기·저장(`catchUp`, `loadOlder`, `prefetchOlder`)은 그대로 두고, 위로 올리기는 새 `showOlder`가 DB를 먼저 쓰고 모자랄 때만 서버를 부른다.

**Tech Stack:** Kotlin, Jetpack Compose, SQLite(`HappyStore`), JUnit + Robolectric(`app/src/test`), 기기 측정은 `app/src/androidTest`.

**Spec:** `docs/superpowers/specs/2026-11-10-chat-recent-window-design.md` — 실행자는 이 계획과 설계 문서를 함께 읽는다.

경로 앞부분 `H/` = `packages/happy-android/app/src/main/kotlin/com/slopus/happy/`, `T/` = `packages/happy-android/app/src/test/kotlin/com/slopus/happy/`, `A/` = `packages/happy-android/app/src/androidTest/kotlin/com/slopus/happy/`.

## Global Constraints

- 처음 창: 최신에서 **300번째** 레코드를 기준점으로, 그 앞 가장 가까운 사용자 입력까지 내려가되 최신에서 **1000번째**보다 더 내려가지 않는다. 300개 이하 채팅은 전부 읽는다.
- 하한은 **내려가기만** 한다. 미끄러지는 "최신 N개" 창 금지.
- 위로 올리기: 맨 위에 한 번 닿으면 **한 묶음만**(약 300개, 한 차례 시작에 맞춤, 최대 1000개). 연쇄 금지. 서버 페이지는 기존 100개 단위.
- 사용자 입력 = `ChatNormalizer`가 `Body.User`로 만드는 레코드 중 하위 에이전트(sidechain) 것과 중단 표시(`^\[Request interrupted by user( for tool use)?\]$`, 앞뒤 공백 무시)를 뺀 것. CLI `isPromptLine`/`isInterruptMarker`(runClaudeAgentMirror.ts 130·310행)와 같은 규칙.
- 합격선: 메시지 1만 개 채팅을 갤럭시 S23 Ultra에서 열 때 첫 화면 **2초 안**, 맨 위에 닿아 한 묶음이 붙는 데 **1초 안**, 새 메시지가 올 때 멈칫 없음.
- 창 수명: 그 채팅 화면(내비게이션 항목)이 살아 있는 동안 유지. 상세 화면에 갔다 와도, 앱을 잠깐 내렸다 올려도 그대로. 채팅을 새로 열거나 앱 프로세스가 다시 시작되면 처음 창부터.
- 범위 밖: 서버 수정, 폰 DB에서 메시지 지우기, `ui/conversation/`(에이전트 API 채팅, `ConversationScreen.kt` 679행의 자체 `nearOldest`)는 건드리지 않는다. 백그라운드 세션의 아직 안 올라온 맥 기록 불러오기도 범위 밖.
- 기기: adb는 USB만, serial `R3CW50AG2KM`, `--user 0`. 측정 앱은 `-Phappy.applicationId=com.slopus.happy.chatbench`로 **dev 앱 옆에** 설치한다(dev 앱 위에 깔면 로그인이 지워진다, research/telegram-chat.md "Running the benchmark"). 사용자의 실제 세션은 열지 않는다.
- 공개 포크: 픽스처 경로·이름은 가짜 값(`/Users/tester/project`). 개인·회사 정보 금지.
- 커밋은 명시한 경로만 `git add`. 커밋 메시지 끝 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. 푸시는 `git push geunwoo HEAD:remote-ux`만. `.superpowers/`, `.playwright-mcp/` 커밋 금지.
- 안드로이드 단위 시험 실행: `cd packages/happy-android && ./gradlew :app:testDebugUnitTest --tests '<클래스>'` (zsh에서는 glob을 따옴표로).

## Review Focus

1. **보이던 메시지가 창이 정해질 때 사라짐.** 처음 열 때 DB가 0 → 라이브 1개 → 최신 100개 → 미리 받기 500개로 자라는 동안 창을 너무 일찍(1개일 때) 정하면 100개 페이지가 하한 아래로 숨고, 너무 늦게(라이브로 300을 넘을 때) 정하면 보던 위쪽이 잘린다. 기대: 한 번 화면에 나온 순번은 그 화면이 살아 있는 동안 계속 보인다. Task 4 시험 `nothingShownDisappearsWhileTheWindowSettles`.
2. **라이브 메시지가 따라잡기보다 먼저 도착.** DB가 비어 있는 채팅에 라이브 메시지 하나가 먼저 저장된 뒤 최신 페이지가 온다. 기대: 최신 페이지 전체가 보인다. Task 4 같은 시험의 첫 단계.
3. **중단 표시를 차례 시작으로 오인.** `[Request interrupted by user]`가 하한 기준이 되면 도구 결과가 호출 없이 잘린다. 기대: 중단 표시는 건너뛴다. Task 2 `interruptMarkerIsNotATurnStart`.
4. **하위 에이전트의 사용자 프롬프트 메아리.** 세션 봉투 `role:"user"`에 `subagent`가 있는 레코드는 `ChatNormalizer`(128행)가 `isSidechain`을 세우지 않는다. 기대: 차례 시작이 아니다. Task 2 `subagentUserEchoIsNotATurnStart`.
5. **창 밖 도구를 상세 화면으로 바로 열기(딥 링크, 채팅 화면 없음).** 기대: 창을 한 묶음씩(최대 10번) 내려 찾고, 끝내 없을 때만 뒤로 간다. Task 7 `detailFindsAToolBelowTheWindow`.

---

### Task 1: 기기에서 15초가 어디서 쓰이는지 재기

기존 `ChatListBenchmark`/`HeavyChat`은 `ui/conversation`(에이전트 API) 화면 모델을 그리므로 이 작업의 경로(DB 읽기 → `ChatNormalizer` → `ChatReduction.apply` → `groupChatRowsForDisplay`)를 재지 않는다. 그래서 새 측정을 만든다.

**Files:**
- Create: `A/bench/LongSessionProfile.kt`

**Interfaces:**
- Produces: 기기 파일 `/sdcard/Android/data/com.slopus.happy.chatbench/files/long-session-profile.txt`, 단계별 밀리초. 이후 Task 8이 같은 측정을 다시 돌려 비교한다.

- [ ] **Step 1: 측정 시험 작성** — `@RunWith(AndroidJUnit4::class) class LongSessionProfile`, 시험 `profileTenThousandRecords`. 메모리 DB(`HappyDatabase(context, name = null)`)에 세션 `"s"` 하나와 레코드 10,000개를 넣는다. 레코드 모양은 `T/chat/ChatFeedTest.kt` 20~28행의 `user`/`agent` 빌더를 복사하고, 도구 호출·결과 레코드도 섞는다(한 차례 = 사용자 1 + 에이전트 텍스트 2 + 도구 호출 4 + 결과 4, 고정 seed). 측정(`SystemClock.elapsedRealtimeNanos`, 각 3회 중 중앙값): ① `store.messages("s")` 전체 ② ①의 결과에 `ChatReduction().apply(ChatPage(records, loaded = true), info)` ③ 300개(`store.messages("s", 300)`)로 같은 ② ④ `groupChatRowsForDisplay(rows, groupToolCalls = true, currentTurnComplete = true)` 1만 개 행·300개 행. 결과를 위 파일에 한 줄씩 쓴다.
- [ ] **Step 2: 빌드·설치·실행** (research/telegram-chat.md의 순서 그대로)

```sh
cd packages/happy-android
./gradlew -Phappy.debuggable=false -Phappy.applicationId=com.slopus.happy.chatbench \
  :app:assembleDebug :app:assembleDebugAndroidTest -x lintVitalDebug
adb -s R3CW50AG2KM install -r -t --user 0 app/build/outputs/apk/debug/app-debug.apk
adb -s R3CW50AG2KM install -r -t --user 0 app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb -s R3CW50AG2KM shell cmd package compile -m speed -f com.slopus.happy.chatbench
adb -s R3CW50AG2KM shell am instrument -w --user 0 \
  -e class com.slopus.happy.bench.LongSessionProfile#profileTenThousandRecords \
  com.slopus.happy.chatbench.test/androidx.test.runner.AndroidJUnitRunner
adb -s R3CW50AG2KM shell cat /sdcard/Android/data/com.slopus.happy.chatbench/files/long-session-profile.txt
```

Expected: `OK (1 test)`와 단계별 숫자. 숫자를 보고서에 적는다. 300개 경로 합(①을 300개로 바꾼 값 + ③ + ④ 300행)이 2초를 넘으면 그 사실과 가장 큰 단계를 보고서 첫 줄에 쓴다(Task 8이 그것을 고친다).
- [ ] **Step 3: 커밋** — `git add packages/happy-android/app/src/androidTest/kotlin/com/slopus/happy/bench/LongSessionProfile.kt` 후 `perf(android): profile a 10k-record session's open path on device`.

---

### Task 2: 창 하한을 고르는 순수 함수

**Files:**
- Create: `H/chat/RecentWindow.kt`
- Create: `T/chat/RecentWindowTest.kt`

**Interfaces:**
- Produces:
  - `object RecentWindow { const val SPAN = 300; const val MAX_SPAN = 1000 }`
  - `fun RecentWindow.isTurnStart(record: MessageRecord): Boolean`
  - `fun RecentWindow.floor(records: List<MessageRecord>, atBeginning: Boolean): Long?` — `records`는 오름차순, 현재 하한 바로 아래(처음 창이면 최신 쪽) 최대 `MAX_SPAN`개. `atBeginning` = `records.first()`가 대화의 맨 처음(폰 DB에도 서버에도 더 오래된 것이 없음). 비면 `null`.

- [ ] **Step 1: 실패하는 시험 작성** (`ChatFeedTest`의 `user`/`agent` 빌더를 이 파일에 복사, 도구 결과 레코드 빌더 `toolResultRecord(id, toolUseId)` 추가)
  - `fewerThanSpanAtBeginningReadsAll`: 레코드 120개, `atBeginning = true` → 첫 레코드 seq.
  - `snapsBackToTheNearestTurnStart`: 1000개, 사용자 입력이 seq 650·720 → 기준점 index 700(seq 701) 이하에서 가장 가까운 차례 시작 seq 650.
  - `searchesBackAsFarAsTheRecordsGiven`: 1000개, 사용자 입력이 seq 1·990뿐 → 650이 아니라 seq 1(1000개 안에서 찾음).
  - `noTurnStartFallsToFirstSafeAgentRecord`: 1000개, 사용자 입력 없음, seq 701이 도구 결과, 702가 에이전트 텍스트 → 702.
  - `noTurnStartAtBeginningStartsAtTheFirstRecord`: 200개, 사용자 입력 없음, `atBeginning = true` → 첫 seq.
  - `interruptMarkerIsNotATurnStart`: 기준점 바로 앞 사용자 텍스트 `"[Request interrupted by user for tool use]"` → 그보다 앞의 진짜 입력으로 간다.
  - `subagentUserEchoIsNotATurnStart`: 세션 봉투 `{"role":"session","content":{"id":"e1","time":1,"role":"user","subagent":"task-1","ev":{"t":"text","text":"do it"}}}` → `isTurnStart == false`; 같은 것에서 `subagent`를 뺀 것 → `true`.
  - `phoneAndMacInputsBothCount`: `{"role":"user","content":{"type":"text",...}}`(폰) → `true`.
- [ ] **Step 2: 실행해 실패 확인** — `./gradlew :app:testDebugUnitTest --tests 'com.slopus.happy.chat.RecentWindowTest'` → 컴파일 실패(`RecentWindow` 없음).
- [ ] **Step 3: 구현** — `isTurnStart`: `ChatNormalizer.normalize(record)`의 `body`가 `Body.User`이고 `!isSidechain`이고 텍스트가 중단 표시가 아니고, 레코드 내용이 세션 봉투일 때 `content.subagent`가 없음(JSON을 한 번 더 파싱해 확인). "안전한 시작" = `isTurnStart` 또는 `Body.Agent`이면서 `!isSidechain`이고 첫 블록이 `AgentContent.ToolResult`가 아닌 것. `floor` 알고리즘:

```text
n = records.size; if n == 0 → null
if n <= SPAN && atBeginning → records[0].seq
a = max(0, n - SPAN)
i = a 이하에서 가장 큰 index with isTurnStart → 있으면 records[i].seq
atBeginning → records[0].seq
j = a 이상에서 가장 작은 index with 안전한 시작 → 있으면 records[j].seq
records[a].seq
```

- [ ] **Step 4: 시험 통과 확인** — 같은 명령, Expected: 8개 PASS.
- [ ] **Step 5: 커밋** — 두 파일만 add, `feat(android): pick a chat window floor at a turn start`.

---

### Task 3: 하한 기준 DB 읽기

**Files:**
- Modify: `H/data/HappyStore.kt` (441행 `messages` 옆)
- Test: `T/data/HappyStoreTest.kt`

**Interfaces:**
- Produces:
  - `fun HappyStore.messagesFrom(sessionId: String, fromSeq: Long): List<MessageRecord>` — `seq >= fromSeq`, 오름차순.
  - `fun HappyStore.messagesBelow(sessionId: String, beforeSeq: Long, limit: Int): List<MessageRecord>` — `seq < beforeSeq` 중 가장 새 `limit`개, 오름차순.

- [ ] **Step 1: 실패하는 시험** — `HappyStoreTest`에 `readsFromAFloor`(seq 1..10 저장 → `messagesFrom("s", 7)`의 seq == `[7,8,9,10]`, 다른 세션 레코드는 안 섞임), `readsTheNewestBelowAFloor`(`messagesBelow("s", 7, 3)` == `[4,5,6]`, `messagesBelow("s", 1, 3)` == 빈 목록).
- [ ] **Step 2: 실패 확인** — `--tests 'com.slopus.happy.data.HappyStoreTest'` → 컴파일 실패.
- [ ] **Step 3: 구현** — 기존 `messages`와 같은 `$MESSAGE_COLUMNS`·`query` 모양으로. `messagesBelow`는 `ORDER BY seq DESC LIMIT ?` 하위 질의를 오름차순으로 감싼다.
- [ ] **Step 4: 통과 확인** — 같은 명령 PASS.
- [ ] **Step 5: 커밋** — `feat(android): read a session's messages from or below a seq`.

---

### Task 4: `MessageSync`의 창

**Files:**
- Modify: `H/sync/MessageSync.kt`
- Modify: `H/chat/ChatSeams.kt` (`ChatMessagesSource`, `SyncChatMessagesSource`, `StoreChatMessagesSource`)
- Modify: `H/chat/ChatFeed.kt` (`state`)
- Modify: `H/ui/chat/ChatRoutes.kt` (161행 근처: 창 토큰)
- Test: `T/sync/MessageSyncTest.kt`, `T/chat/ChatFeedTest.kt`

**Interfaces:**
- Consumes: Task 2 `RecentWindow.floor`, Task 3 `messagesFrom`/`messagesBelow`.
- Produces:
  - `fun MessageSync.messages(sessionId: String, windowToken: String? = null): Flow<List<MessageRecord>>` — `windowToken`이 지금 창의 토큰과 다른 non-null이면 새 창을 연다. `null`이면 지금 창에 붙는다(없으면 새로 연다).
  - `fun MessageSync.paging(sessionId: String): Flow<MessagePaging>` — `hasMoreOlder = (floor != null && floor > history.oldestSeq) || history.hasOlder`. `isLoadingOlder` = 기존 `loadingOlder` 또는 `showOlder` 진행 중.
  - `suspend fun MessageSync.showOlder(sessionId: String): Boolean` — 하한을 한 묶음 내린다. 내려갔으면 true.
  - `interface ChatMessagesSource { fun messages(sessionId: String, windowToken: String? = null): Flow<ChatPage>; suspend fun loadOlder(sessionId: String): Boolean }` — `SyncChatMessagesSource.loadOlder`는 `sync.showOlder`를 부른다.
  - `fun ChatFeed.state(sessionId: String, windowToken: String? = null): Flow<ChatState>`
  - 기존 `MessageSync.loadOlder`(서버 한 페이지를 DB에 저장)와 `prefetchOlder`는 **이름·동작 그대로** 둔다. 기존 `MessageSyncTest`가 그대로 통과해야 한다.

창 규칙(이 Task의 결정, 실행자는 그대로 따른다):
- 창 상태: 세션별 `{ token: String?, floor: Long?(null = 아직 안 정함), shownOldest: Long? }`를 `MutableStateFlow`로. `forget(sessionId)`에서 지운다. `viewing` 수로 지우지 않는다(앱을 잠깐 내려도 유지돼야 한다).
- 읽기: 하한을 정한 뒤에는 `messagesFrom(sessionId, floor)`. 정하기 전에는 `messages(sessionId, MAX_SPAN)`.
- **하한을 정하는 때:** `history.isLoaded`이고 (`읽은 개수 >= SPAN` 또는 `!history.hasOlder`)일 때 한 번. 정할 때 `floor = min(RecentWindow.floor(newest MAX_SPAN, atBeginning), shownOldest ?: +∞)`. `shownOldest` = 직전에 내보낸 목록의 첫 seq. 이렇게 해서 이미 보인 것은 숨지 않는다.
- `showOlder`: 하한이 없으면 false. `below = messagesBelow(floor, MAX_SPAN)`. `below`가 `SPAN`보다 적고, `below` 안에 기준점 이하 차례 시작이 없고, `history.hasOlder`이고, 이번 묶음에서 받은 개수 < `MAX_SPAN`인 동안 기존 `loadOlder`로 서버 한 페이지씩 받고 `below`를 다시 읽는다. 그 뒤 `RecentWindow.floor(below, atBeginning = !hasOlder && below.first().seq == oldestSeq)`로 새 하한. 묶음 내내 "보여 주는 중" 표시 하나를 켜 둔다(페이지마다 깜빡이지 않게).
- 토큰: `ChatRoutes`의 채팅 경로가 `rememberSaveable { UUID.randomUUID().toString() }`로 만들어 `feed.state(sessionId, token)`에 넘긴다. 상세 화면은 `null`(붙기만).
- `StoreChatMessagesSource`(로그아웃 상태)는 창 없이 전부 읽는다(나의 결정: 동기화가 없어 길어질 일이 드물다).

- [ ] **Step 1: 실패하는 시험** — `MessageSyncTest`에 세션 봉투 내용으로 메시지를 넣는 도우미(`server.appendMessage("s", <ChatFeedTest의 user/agent JSON 내용>)`)를 추가하고:
  - `opensOnTheNewestThreeHundredSnappedToATurn`: 서버 1,200개(10개마다 사용자 입력)를 DB에 모두 저장 → `sync.messages("s", "t1").first { it.isNotEmpty() }`의 첫 레코드 = 최신에서 300번째 이하 가장 가까운 사용자 입력, 개수 300~309.
  - `showOlderUsesTheDeviceBeforeTheServer`: 위 상태에서 `showOlder` → 서버 요청 수 변화 0, 첫 seq가 약 300 내려감. DB 바닥까지 내린 뒤 `history.hasOlder`인 서버에서 `showOlder` → 서버 요청이 생기고 true.
  - `oneTopReachIsOneBatch`: `showOlder` 1번 = 하한 1번 이동(연속 호출 없이 두 번째 묶음이 붙지 않음).
  - `nothingShownDisappearsWhileTheWindowSettles`: 빈 DB, 서버 700개. ① 라이브 메시지 하나를 `store.insertMessages`로 먼저 저장 ② `catchUp` ③ `prefetchOlder` ④ 라이브 10개 추가. `messages("s","t1")`의 연속된 모든 방출에서 "앞 방출의 seq 집합 ⊆ 다음 방출의 seq 집합".
  - `newTokenStartsAFreshWindowAndNullJoins`: `showOlder` 뒤 같은 토큰·`null`로 다시 모으면 낮아진 하한 그대로, 새 토큰이면 처음 창.
  - `pagingSaysMoreWhileTheFloorIsAboveTheDevice`: DB 전부 있음·서버 끝, 하한이 DB 최저보다 위 → `hasMoreOlder == true`; 바닥까지 내린 뒤 false.
  - `ChatFeedTest`에 `newMessagesDoNotReReduceTheWindow`: 창이 정해진 뒤 새 레코드가 붙어도 기존 행 인스턴스가 같다(`===`).
- [ ] **Step 2: 실패 확인** — `--tests 'com.slopus.happy.sync.MessageSyncTest' --tests 'com.slopus.happy.chat.ChatFeedTest'` → 컴파일 실패.
- [ ] **Step 3: 구현** — 위 규칙대로. `messages`는 `combine(store.messageChanges(id), windowFlow)`로 다시 읽는다. `ChatSeams`, `ChatFeed.state`, `ChatRoutes` 연결.
- [ ] **Step 4: 통과 확인** — 같은 명령 + 기존 `MessageSyncTest`·`MessagePreloadTest`·`ChatFeedTest` 전부 PASS.
- [ ] **Step 5: 커밋** — `feat(android): open chats on a recent window that only grows downward`.

---

### Task 5: 정리 단계(reducer) 창 경계 처리

**Files:**
- Modify: `H/chat/ChatReducer.kt` (`ReducerOptions`, 0.5단계 230~234행, 0단계 298행 이후 `completedRequests` 고리)
- Modify: `H/chat/ChatFeed.kt` (`ChatReduction.apply`가 옵션을 채움)
- Test: `T/chat/ChatReducerTest.kt`, `T/chat/WorkGroupsTest.kt`

**Interfaces:**
- Produces: `ReducerOptions(..., windowStartAt: Long? = null)`. `ChatReduction.apply`는 `windowStartAt = if (page.hasMoreOlder) page.records.firstOrNull()?.createdAt else null`.

- [ ] **Step 1: 실패하는 시험**
  - `ChatReducerTest.completedRequestBeforeTheWindowMakesNoRow`: `completedRequests`에 `createdAt = 100`, 짝 도구 줄 없음, `windowStartAt = 500` → 가짜 도구 줄이 생기지 않음. 같은 것에 `windowStartAt = null` → 지금처럼 생김.
  - `ChatReducerTest.pendingRequestBeforeTheWindowStillShows`: `requests`(진행 중)는 `windowStartAt`과 상관없이 카드가 생긴다.
  - `ChatReducerTest.olderContextResetDoesNotWipeNewerTodos`: 최신 할 일(시각 900)을 먼저 넣고, 나중 묶음으로 시각 100의 `"Context was reset"`을 넣음 → 할 일·사용량이 그대로. 시각 1000의 것은 지금처럼 비운다. `"Compaction completed"`도 같은 두 경우.
  - `ChatReducerTest.subagentWhoseTaskIsBelowTheWindowIsNotAStrayTopRow`: Task 호출 없이 그 하위 대화 레코드만 들어옴 → 최상위 행으로 보이지 않는다. 나중에 Task 호출이 들어오면 그 아래에 붙는다(기존 `processOrphans` 경로). 이미 통과하면 시험만 남기고 코드는 바꾸지 않는다.
  - `WorkGroupsTest.topTurnWithoutAUserMessageGroups`: 사용자 입력 없이 에이전트·도구 행으로 시작하는 목록 → 예외 없이 묶이고 첫 행이 보인다.
- [ ] **Step 2: 실패 확인** — `--tests 'com.slopus.happy.chat.ChatReducerTest' --tests 'com.slopus.happy.chat.WorkGroupsTest'`.
- [ ] **Step 3: 구현** — 0단계: `completed.createdAt`이 있고 `windowStartAt`보다 이르고 짝 도구 줄이 없으면 가짜 줄을 만들지 않는다(`permissions` 기록은 남긴다). 0.5단계: `latestTodos`/`latestUsage`의 시각보다 이른 이벤트는 덮지 않는다.
- [ ] **Step 4: 통과 확인** — 같은 명령 + `ChatFeedTest` PASS.
- [ ] **Step 5: 커밋** — `fix(android): keep window edges from inventing stale permission rows or wiping newer todos`.

---

### Task 6: 맨 위에 닿을 때 한 번만 부르기

**Files:**
- Modify: `H/ui/chat/ChatList.kt` (`OlderPager` 135~172행, `olderStatus` 178행, `nearOldest` 251행, 288~292행)
- Create: `T/ui/chat/OlderPagerTest.kt`

**Interfaces:**
- Produces:
  - `OlderPager.onOldestVisible(visible: Boolean, request: suspend () -> Unit)` — 보이지 않다가 보이게 된 순간(상승 가장자리)에만 한 번 `request`. 처음 화면이 이미 맨 위면(목록이 짧으면) 그 첫 순간도 상승으로 친다.
  - `OlderPager.awaitingTap: Boolean` — 한 묶음이 붙었는데 맨 위가 여전히 보이면 true. `loadMore()`가 바로 한 묶음을 부르고 false로.
  - `olderStatus(blocked, hasMoreOlder, isLoadingOlder, awaitingTap: Boolean = false)` — `awaitingTap && hasMoreOlder && !isLoadingOlder` → `OlderStatus.LoadMore`.
  - "맨 위 보임" = 가장 오래된 채팅 행을 담은 목록 항목이 `layoutInfo.visibleItemsInfo` 안에 있음(접힌 묶음 개수가 아니라 실제 항목 위치). 지금의 "한 화면 안" 미리 부르기는 없앤다.
  - `EmptyMessages`(ChatPlaceholders.kt 96행)의 자동 반복은 그대로(기존 5회 예산이 막는다).

- [ ] **Step 1: 실패하는 시험** — `OlderPagerTest`(코루틴 시험): `requestsOnceOnReachingTheTop`(false→true 1회 요청, true 유지 동안 추가 요청 0), `reachingAgainRequestsAgain`(true→false→true 2회), `stillAtTopAfterABatchWaitsForTap`(요청 끝난 뒤 여전히 true → `awaitingTap == true`, `olderStatus(...)== LoadMore`, `loadMore()` 뒤 1회 더 요청).
- [ ] **Step 2: 실패 확인** — `--tests 'com.slopus.happy.ui.chat.OlderPagerTest'`.
- [ ] **Step 3: 구현** — `ChatList`의 288행 `LaunchedEffect`를 `snapshotFlow { 맨 위 보임 }`을 모아 `pager.onOldestVisible`로 넘기는 것으로 바꾸고, `OlderEnd`에 `awaitingTap`을 반영한다.
- [ ] **Step 4: 통과 확인** — 같은 명령 + `ChatRecompositionTest`, `ChatOlderInsetTest`, `ChatWorkGroupsTest` PASS.
- [ ] **Step 5: 커밋** — `fix(android): load one older batch per reach of the top, never a chain`.

---

### Task 7: 창 밖 메시지 상세 열기

**Files:**
- Modify: `H/ui/files/FilesRoutes.kt` (`toolPressRoute` 112행, `findMessage` 331행, `MessageDetailRouteScreen` 340~357행)
- Modify: `H/ui/chat/ChatRoutes.kt` 117행 (`onToolFilePress`)
- Test: `T/ui/files/MessageDetailLookupTest.kt` (Create)

**Interfaces:**
- 행 id(`m<n>`)는 정리 순서에 따라 달라 상세 화면의 새 정리와 맞지 않는다. 그래서 도구 상세의 키는 `ToolCall.callId`로 바꾼다.
- Produces:
  - `fun detailKey(message: ChatMessage.ToolCallMessage): String = message.tool.callId`
  - `internal fun findMessage(rows: List<ChatMessage>, key: String): ChatMessage?` — `id == key` 또는 `ToolCallMessage`의 `tool.callId == key`, 하위(children)까지.
  - 상세 화면: 다 읽었는데 없고 `hasMoreOlder`면 `loadOlder`(=`showOlder`)를 부르고 다시 찾는다. 최대 10번. 그래도 없거나 `!hasMoreOlder`면 지금처럼 `onBack()`.

- [ ] **Step 1: 실패하는 시험** — `MessageDetailLookupTest`: `findsByCallIdAcrossReductions`(같은 레코드를 두 순서(최신 먼저/전부 한 번)로 정리한 두 결과에서 `detailKey`로 같은 도구를 찾음), `findsNestedSubagentTool`, `oldIdStillResolves`(`m3` 같은 행 id로도 찾음). `detailFindsAToolBelowTheWindow`: `ChatFeed` + 가짜 `ChatMessagesSource`(첫 페이지에 그 도구 없음, `loadOlder` 뒤 페이지에 있음) → 찾고 `onBack` 안 부름; 10번 뒤에도 없으면 `onBack` 1회.
- [ ] **Step 2: 실패 확인** — `--tests 'com.slopus.happy.ui.files.MessageDetailLookupTest'`.
- [ ] **Step 3: 구현** — `toolPressRoute`와 `onToolFilePress`가 `MessageDetailRoute(sessionId, detailKey(message), ...)`. 찾기 반복은 상세 화면의 `LaunchedEffect`로.
- [ ] **Step 4: 통과 확인** — 같은 명령 + `FilesLayoutTest` PASS.
- [ ] **Step 5: 커밋** — `fix(android): open tool details by call id, lowering the window to find them`.

---

### Task 8: 기기 확인과 합격선

**Files:**
- Modify(필요할 때만): Task 1 측정에서 가장 큰 단계의 파일.

- [ ] **Step 1: 측정 다시** — Task 1 Step 2 명령 그대로. 300개 경로 합을 Task 1 숫자와 나란히 보고서에 적는다.
- [ ] **Step 2: 앱 전체 단위 시험** — `cd packages/happy-android && ./gradlew :app:testDebugUnitTest` → BUILD SUCCESSFUL.
- [ ] **Step 3: 실제 앱 확인** — dev 앱(`com.slopus.happy.dev`)을 `./gradlew :app:installDebug`로 설치(같은 서명, 로그인 유지). 일회용 세션: 맥에서 `~/workspace` 아래 일회용 폴더에 `happy`로 짧은 세션을 띄우고, 이 세션에 대화 레코드를 1,200개 넘게 넣는다(일회용 세션만, 사용자 세션 금지). 폰에서 그 세션만 열어 확인: ① 첫 화면 시간(`adb logcat`의 `ActivityTaskManager: Displayed`가 아니라 화면 녹화 `adb shell screenrecord` 프레임으로 탭→마지막 답 표시까지) 2초 안 ② 맨 위로 올릴 때 한 번에 한 묶음만 붙음(진행 표시 1회) ③ 붙을 때 보던 줄이 튀지 않음. 끝나면 일회용 세션을 멈추고 지운다.
- [ ] **Step 4: 합격선 미달이면** — Step 1 숫자에서 가장 큰 단계 하나를 고치고(예: 300행 전체 `groupChatRowsForDisplay` 재계산을 바뀐 차례만으로) 그 단계의 단위 시험을 더한 뒤 Step 1~3을 다시 한다.
- [ ] **Step 5: 커밋·푸시** — 바뀐 파일만 add, 커밋 후 `git push geunwoo HEAD:remote-ux`.
