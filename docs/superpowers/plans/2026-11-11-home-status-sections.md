# 홈 목록 상태별 구역 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 기본 보기(Flat list)의 살아 있는 세션을 Needs input / Working / Completed 카드로 나누고, 요약 칩·마지막 한 줄·시간·Approve/Reply 표시를 붙인다.

**Architecture:** 구역 나누기와 줄 순서는 `deriveHomeList`의 순수 함수에서 정한다(새 `HomeRow` 종류: 칩, 구역 머리, 더 보기). 마지막 한 줄은 새 `SessionPreviews`가 기기 DB의 최근 메시지에서 뽑아 `HomeListModel` 입력으로 넣는다. 그리기는 기존 카드(`HomeCardRow`)와 `FlatSessionRow`에 구역 모드를 더한다.

**Tech Stack:** Kotlin, Jetpack Compose, kotlinx.coroutines Flow, SQLite(HappyStore), JUnit4 + Robolectric.

**Spec:** `docs/superpowers/specs/2026-11-11-home-status-sections-design.md`

경로 앞부분: `H/` = `packages/happy-android/app/src/main/kotlin/com/slopus/happy/`, `T/` = `packages/happy-android/app/src/test/kotlin/com/slopus/happy/`, `R/` = `packages/happy-android/app/src/main/res/`.
테스트 실행: `cd packages/happy-android && BORROW=local ./gradlew :app:testDebugUnitTest --tests "<클래스>"`.

## Global Constraints

- Flat list(`SessionListGrouping.Flat`)에만 적용. Project 보기 결과는 지금과 같아야 한다.
- CLI·서버는 고치지 않는다.
- 구역: PermissionRequired·InputRequired → Needs input, Thinking → Working, 그 밖(Waiting 등 살아 있는 줄) → Completed. 꺼진 세션은 지금처럼 보관함.
- 순서: Needs input·Working은 `stateSince` 오름차순(없으면 맨 뒤, 그다음 `lastActivityAt` 내림차순), Completed는 `lastActivityAt` 내림차순.
- Completed는 처음 3개만, 나머지는 `Show N more`.
- 색: Needs input `#FF9500`, Working `#007AFF`, Completed 회색(테마 `textSecondary`).
- 글자(영어): 구역 `Needs input`/`Working`/`Completed`, 칩 `Needs input %d`/`Working %d`/`Done %d`, 표시 `Approve`/`Reply`, `Show %d more`. 새 문자열은 `R/values/strings_home_sections.xml`에 두고 `values-*` 9개 언어 모두에 번역을 둔다(`AndroidStringsTranslatedTest`).
- 표시: PermissionRequired → `Approve`, InputRequired → `Reply`, 맥 상태만 아는 막힌 줄(`isBackgroundAgent` && PermissionRequired) → `Reply`.
- 마지막 한 줄: 최근 20개 메시지에서, 최신부터 처음 만나는 사이드체인 아닌 에이전트 글(첫 줄, 마크다운 앞 기호 제거, 공백 하나로, 120자) 또는 도구 호출(`title` 없으면 `name`). 없으면 `projectName`.
- 시간: Needs input = 기다리는 요청 중 가장 이른 `createdAt`, Working = 최근 사용자 메시지 시각, 둘 다 없으면 앱이 그 구역을 처음 본 시각. 경과 표기 `40s`/`12m`/`2h`/`3d`. Completed = `formatSessionListTimestamp(lastActivityAt)`. 경과 표기는 30초마다 다시 그린다.
- 공개 저장소: 시험 데이터 경로는 `/Users/tester/project`, 개인·회사 이름 금지.

## Review Focus

1. 같은 세션이 Working↔Completed를 오갈 때 처음 본 시각이 구역별로 새로 잡히는지 — `firstSeenResetsWhenTheSectionChanges` (Task 3).
2. 미리보기 재계산이 메시지 순번이 바뀐 세션만 읽는지 — `onlySessionsWithNewMessagesAreReadAgain` (Task 2).
3. 살아 있는 줄이 하나도 없을 때 칩·카드 없이 보관함 토글만 남는지 — `noLiveChatsLeaveOnlyTheArchiveToggle` (Task 3).
4. 두 구역 카드가 한 카드로 붙지 않는지(구역 머리가 새 카드를 연다) — `eachSectionIsItsOwnCard` (Task 3).
5. 에이전트 글이 아직 없고 사용자 메시지만 있는 세션은 폴더 이름으로 돌아가는지 — `aSessionWithOnlyUserMessagesHasNoLine` (Task 2).

---

### Task 1: 줄 데이터에 대기 시작 시각과 미리보기 자리

**Files:**
- Modify: `H/model/Session.kt` (`AgentAttention`)
- Modify: `H/model/SessionList.kt` (`SessionRowData`, `buildSessionRowData`)
- Test: `T/model/AgentAttentionSinceTest.kt`

**Interfaces:**
- Produces: `AgentAttention.waitingSince: Long?` (기본 null; `of(state)`가 열린 권한 요청 `createdAt`과 `selectPendingCommunications`의 `createdAt`(0 제외) 중 최솟값). `SessionRowData.stateSince: Long? = null`(막힌 상태일 때만 `attention.waitingSince`), `SessionRowData.preview: String? = null`.

- [ ] **Step 1: 실패하는 테스트**: `earliestOpenRequestOrQuestionIsTheWaitStart` — 요청 두 개(createdAt 200, 100)와 질문(createdAt 150)이 있는 `AgentState` → `waitingSince == 100`; 요청에 createdAt 없고 질문도 없으면 `null`. `blockedRowCarriesItsWaitStart` — PermissionRequired 세션의 `buildSessionRowData(...).stateSince == 100`, Thinking 세션은 `null`.
- [ ] **Step 2: 실행해 실패 확인.**
- [ ] **Step 3: 구현.** `AgentAttention`에 세 번째 필드 `waitingSince: Long? = null`을 더한다(기존 생성 호출은 그대로 컴파일돼야 한다).
- [ ] **Step 4: 실행해 통과 확인** + `HomeListTest`, `SessionListTest`(있으면) 통과.
- [ ] **Step 5: 커밋** `feat(android): know when a session started waiting`.

### Task 2: 마지막 한 줄 뽑기와 캐시

**Files:**
- Create: `H/model/SessionPreview.kt`
- Create: `H/ui/home/SessionPreviews.kt`
- Modify: `H/data/HappyStore.kt` (세션별 메시지 순번 한 번에 읽기)
- Test: `T/model/SessionPreviewTest.kt`, `T/ui/home/SessionPreviewsTest.kt`(Robolectric, 실제 `HappyStore`)

**Interfaces:**
- Produces:
  - `data class SessionPreview(val line: String?, val turnStartedAt: Long?)`
  - `fun previewOf(newestFirst: List<NormalizedMessage>): SessionPreview` — `line`은 위 규칙, `turnStartedAt`은 최신부터 처음 만나는 `Body.User`의 `createdAt`.
  - `fun HappyStore.messagesSeqs(ids: Collection<String>): Map<String, Long>` (`SELECT id, messages_seq FROM sessions WHERE id IN (...)`; 999개 넘으면 나눠 읽기).
  - `class SessionPreviews(store: HappyStore, limit: Int = 20)` + `fun previews(ids: Collection<String>): Map<String, SessionPreview>` — `(id, messages_seq)`가 지난번과 같으면 캐시를 돌려주고, 바뀐 세션만 `store.messages(id, limit)`를 `ChatNormalizer.normalize`로 읽는다. 순번 0인 세션은 읽지 않고 결과에서 뺀다.

- [ ] **Step 1: 실패하는 테스트** (`SessionPreviewTest`):
  - `newestAgentTextWinsAndKeepsItsFirstLine` — 최신 에이전트 글 `"## Done\n\nmore"` → `line == "Done"`.
  - `aToolCallIsALine` — 최신이 `ToolUse(name="Bash", title="Run tests")` → `"Run tests"`; title 없으면 `"Bash"`.
  - `thinkingSidechainAndEventsAreSkipped` — 최신 thinking, 사이드체인 글, 이벤트 뒤의 일반 글이 뽑힌다.
  - `aSessionWithOnlyUserMessagesHasNoLine` — 사용자 메시지만 → `line == null`, `turnStartedAt == 그 시각`.
  - `longLinesAreCutAt120` — 300자 글 → 길이 120 이하, 줄바꿈·연속 공백 없음.
- [ ] **Step 2: 실패하는 테스트** (`SessionPreviewsTest`): `onlySessionsWithNewMessagesAreReadAgain` — 두 세션 메시지를 넣고 `previews` 두 번 호출, 한 세션에만 메시지 추가 후 세 번째 호출에서 그 세션만 다시 읽힌다(읽은 세션 id를 세는 테스트용 훅 `onRead: (String) -> Unit = {}` 생성자 인자). `aSessionWithNoStoredMessagesIsLeftOut`.
- [ ] **Step 3: 실행해 실패 확인.**
- [ ] **Step 4: 구현.**
- [ ] **Step 5: 실행해 통과 확인.**
- [ ] **Step 6: 커밋** `feat(android): read each session's last line from stored messages`.

### Task 3: 구역으로 나눈 목록 만들기

**Files:**
- Create: `H/ui/home/HomeSections.kt` (`HomeSection`, 구역 나누기·정렬, `SectionClock`)
- Modify: `H/ui/home/HomeList.kt` (`HomeRow` 새 종류, `HomeListInputs`, `deriveHomeList`, `flatRows`, `homeCardEntries`, `HomeListModel`)
- Modify: `T/ui/home/HomeListTest.kt` (Flat 모양이 바뀐 기존 테스트 기대값 갱신)
- Test: `T/ui/home/HomeSectionsTest.kt`

**Interfaces:**
- Consumes: Task 1 `stateSince`, `preview`; Task 2 `SessionPreview`.
- Produces:
  - `enum class HomeSection { NeedsInput, Working, Completed }`, `fun homeSectionOf(state: SessionState): HomeSection`.
  - `HomeRow.SectionChips(val counts: List<Pair<HomeSection, Int>>)` key `"section-chips"` (카드 밖), `HomeRow.SectionHeader(val section: HomeSection, val count: Int)` key `"section-${section}"` (카드 줄, 항상 새 카드의 첫 줄), `HomeRow.ShowMore(val section: HomeSection, val hidden: Int)` key `"show-more-${section}"` (카드 줄). `HomeRow.Chat`에 `val section: HomeSection? = null`.
  - `HomeListInputs`에 `previews: Map<String, SessionPreview> = emptyMap()`, `completedExpanded: Boolean = false`.
  - `deriveHomeList(inputs, zone, today, firstSeen: (id: String, section: HomeSection) -> Long? = { _, _ -> null })`.
  - `class SectionClock(now: () -> Long)` + `fun firstSeen(id: String, section: HomeSection): Long` — 같은 (id, section)이면 처음 기록한 시각, 구역이 바뀌면 새로 기록, `retain(ids: Set<String>)`으로 사라진 세션 정리.
  - `HomeListModel`에 `previews: Flow<Map<String, SessionPreview>> = flowOf(emptyMap())` 생성자 인자, `val completedExpanded: MutableStateFlow<Boolean>`.
- Flat 줄 모양: `[SectionChips] + (구역마다 SectionHeader, Chat들, [ShowMore]) + [ArchiveToggle] + 보관함`. 빈 구역은 칩·머리 모두 없음. 살아 있는 줄이 없으면 칩도 없음. 각 Chat의 `row.session`은 `preview = previews[id]?.line`, `stateSince`는 Needs input이면 기존 값, Working이면 `previews[id]?.turnStartedAt`, 그래도 null이면 `firstSeen(id, section)`; Completed는 `stateSince = null`.

- [ ] **Step 1: 실패하는 테스트** (`HomeSectionsTest`, `HomeListTest`의 `cli`/`inputs` 꼴 도우미를 복사해 쓴다):
  - `liveChatsSplitIntoNeedsInputWorkingAndCompleted` — 권한 대기 1, 생각 중 2, 대기 2 → 모양 `chips, section:NeedsInput, chat…, section:Working, chat…, chat…, section:Completed, chat…, chat…`, 칩 counts `[(NeedsInput,1),(Working,2),(Completed,2)]`.
  - `waitingRowsPutTheLongestWaitFirst` — stateSince 300, 100 → 100이 먼저; null은 맨 뒤.
  - `completedShowsThreeThenShowMore` — 대기 5개 → Chat 3개 + `ShowMore(Completed, 2)`; `completedExpanded = true`면 5개, ShowMore 없음.
  - `emptySectionsHaveNoChipOrCard`, `noLiveChatsLeaveOnlyTheArchiveToggle`.
  - `eachSectionIsItsOwnCard` — `cards`에서 각 `SectionHeader`의 place.first == true이고 그 바로 앞 카드 줄의 place.last == true.
  - `previewAndTurnStartFillTheRow` — previews의 line이 `session.preview`, Working 줄의 `stateSince == turnStartedAt`.
  - `firstSeenFillsAMissingStart` — firstSeen 람다가 준 값이 들어간다.
  - `firstSeenResetsWhenTheSectionChanges` — `SectionClock`: (a, Working) t=10, 다시 t=20에 같은 값 10, (a, Completed) t=30 → 30, 다시 (a, Working) t=40 → 40.
  - `projectGroupingIsUnchanged` — Project 보기 결과에 새 행 종류가 없다.
- [ ] **Step 2: 실행해 실패 확인.**
- [ ] **Step 3: 구현.** `HomeListModel`은 `combine`에 previews와 completedExpanded를 넣고, `SectionClock(System::currentTimeMillis)`을 하나 들고 `deriveHomeList(..., firstSeen = clock::firstSeen)` 뒤 `clock.retain(살아 있는 id)`를 부른다. `HomeListHost`/`HomeScreen`의 `when (row)`에는 새 종류를 일단 `Unit`으로 둬 컴파일만 맞춘다(그리기는 Task 5).
- [ ] **Step 4: 기존 `HomeListTest`의 Flat 기대값을 새 모양으로 고친다**(뜻은 그대로: 활동순·보관함 날짜순·아카이빙 즉시 제외·맥 세션 섞임). 실행해 `HomeSectionsTest`, `HomeListTest`, `LargeDataTest` 통과.
- [ ] **Step 5: 커밋** `feat(android): group the home list by what each chat needs`.

### Task 4: 시간 문구와 글자

**Files:**
- Modify: `H/ui/home/HomeFormat.kt`
- Create: `R/values/strings_home_sections.xml` 와 `R/values-{b+zh+Hans,b+zh+Hant,ca,es,it,ja,pl,pt,ru}/strings_home_sections.xml`
- Test: `T/ui/home/HomeFormatSectionsTest.kt`

**Interfaces:**
- Produces: `fun formatElapsed(ms: Long): String` (`<60s` → `"${s}s"`, `<60m` → `"${m}m"`, `<24h` → `"${h}h"`, 그 위 `"${d}d"`, 음수는 `"0s"`). 문자열 이름: `home_section_needs_input`, `home_section_working`, `home_section_completed`, `home_chip_needs_input`(%d), `home_chip_working`(%d), `home_chip_done`(%d), `home_badge_approve`, `home_badge_reply`, `home_show_more`(%d).

- [ ] **Step 1: 실패하는 테스트** `elapsedUsesTheLargestWholeUnit` — 40_000→`40s`, 12*60_000→`12m`, 2*3_600_000+5→`2h`, 3*86_400_000→`3d`, -5→`0s`.
- [ ] **Step 2: 실패 확인 → 구현 → 통과 확인**, `AndroidStringsTranslatedTest` 통과.
- [ ] **Step 3: 커밋** `feat(android): words and times for the home sections`.

### Task 5: 그리기와 연결

**Files:**
- Create: `H/ui/home/HomeSectionRows.kt` (`SectionChipsRow`, `SectionHeaderRow`, `ShowMoreRow`, `rememberNow`)
- Modify: `H/ui/components/HomeCard.kt` (`HomeCardRow`에 `accent: Color? = null`: 카드 왼쪽 3dp 색 띠)
- Modify: `H/ui/home/FlatSessionRow.kt` (`section: HomeSection? = null` 인자)
- Modify: `H/ui/home/HomeScreen.kt` (`HomeCardItem`·탭릿 `rows` 분기, 칩 스크롤)
- Modify: `H/ui/home/HomeListCallbacks.kt` (`onShowMoreCompleted: () -> Unit = {}`), `H/ui/home/HomeListHost.kt` (연결)
- Modify: `H/ui/home/HomeServices.kt` (`SessionPreviews` 흐름을 `HomeListModel`에)
- Test: 기존 Compose/Robolectric 홈 테스트(`HomeLayoutTest` 등) 통과 + `T/ui/home/HomeSectionRowsTest.kt`

**Interfaces:**
- Consumes: Task 3의 `HomeRow` 종류와 `HomeSection`, Task 4의 문자열·`formatElapsed`.
- 줄(`section != null`): 2번째 줄은 `session.preview ?: projectName`. 오른쪽 위는 Needs input이면 표시 글자 칩(주황 바탕 옅게, 글자 `#FF9500`) 아래 경과 시간, Working이면 경과 시간, Completed면 `formatSessionListTimestamp(lastActivityAt)`와 안 읽음이면 파란 점. 주황 점은 그리지 않는다. Completed 줄 제목은 `textSecondary`. 줄 높이는 `FlatRowSpec.cardRowHeight()` 그대로.
- 구역 머리: 카드 첫 줄, 높이 36dp, 왼쪽에 구역 이름 13sp semibold, 오른쪽에 개수. 같은 구역의 모든 카드 줄(머리·줄·더 보기)에 `accent` 색 띠.
- 칩: 카드 밖 한 줄, 가로 간격 6dp, 누르면 `listState.animateScrollToItem(그 SectionHeader의 LazyColumn 위치)`.
- 경과 시간은 `rememberNow(30_000)`으로 다시 그린다.
- `SessionPreviews` 흐름: `HomeServices`에서 `combine(snapshots의 살아 있는 세션 id, graph.store.changes).debounce(300).map { previews.previews(ids) }.flowOn(Dispatchers.IO)`.

- [ ] **Step 1: 실패하는 테스트** (`HomeSectionRowsTest`, Robolectric Compose): `aBlockedRowShowsApproveAndNoDot`, `aQuestionShowsReply`, `aRowShowsItsLastLineInsteadOfTheFolder`, `tappingShowMoreAsksForTheRest`.
- [ ] **Step 2: 실패 확인 → 구현 → 통과 확인.** 홈 관련 테스트 전체(`com.slopus.happy.ui.home.*`, `com.slopus.happy.text.*`) 통과.
- [ ] **Step 3: 빌드** `./gradlew :app:assembleDebug -x lintVitalDebug` 성공.
- [ ] **Step 4: 커밋** `feat(android): draw the home sections`.

### Task 6: 폰 확인

- [ ] `./gradlew :app:installDebug`(dev 앱, USB `R3CW50AG2KM`, `--user 0`). 홈을 열어 스크린숏: 칩·카드·마지막 한 줄·시간이 보이는지, 칩을 누르면 스크롤되는지, `Show N more`가 펼쳐지는지. 사용자 세션 줄은 누르지 않는다(보기만).
- [ ] 확인 결과를 `.lanes/PHONE-CHECKLIST.md`에 적는다(커밋하지 않는다).
