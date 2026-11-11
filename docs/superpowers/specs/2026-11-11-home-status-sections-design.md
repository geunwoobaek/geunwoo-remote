# 홈 목록을 상태별 구역으로 나누기 설계

## 의도

Jarvis 홈 목록은 지금 세션을 한 줄씩 시간순으로만 늘어놓는다. 일하는 세션, 답을 기다리는 세션, 이미 끝난 세션이 섞여 있어서 "지금 내가 손대야 할 것"을 찾으려면 목록을 끝까지 훑어야 한다. 맥의 `claude agents` 화면은 같은 세션들을 Needs input / Working / Completed로 묶어 보여 주고, 사용자는 폰 홈도 그렇게 보이길 원했다(2026-11-11, 캡처 첨부).

목업 비교 뒤 사용자가 고른 모양은 "구역마다 카드(B) + 맨 위 요약 칩·줄마다 마지막 한 줄(C)"을 합친 것이다.

## 목표

1. 기본 보기("Flat list")에서 살아 있는 세션을 **Needs input → Working → Completed** 세 구역으로 나눠 보인다.
2. 맨 위 요약 칩으로 구역별 개수를 한눈에 보고, 칩을 누르면 그 구역으로 스크롤한다.
3. 줄 아래에는 폴더 이름 대신 그 세션의 **마지막 한 줄**(마지막 답 또는 도구 줄)을 보인다.
4. 오른쪽에 시간을 보인다. Needs input·Working은 그 상태가 된 지 얼마나 됐는지, Completed는 끝난 시각.
5. 무엇을 기다리는지 표시한다: 권한 요청이면 `Approve`, 질문·답 요청이면 `Reply`.

## 하지 않을 것

- **"Group by project" 보기 변경.** 그대로 둔다.
- **CLI·서버 변경.** 앱만 고친다.
- **꺼진 세션 처리 방식 변경.** 지금처럼 맨 아래 접힌 보관함(`▸ Archived · N`)에 남는다.

## 실패로 보는 것

- 손대야 할 세션(권한·질문 대기)이 Completed나 보관함에 섞여 묻히는 것.
- 마지막 한 줄을 뽑느라 홈이 느려지거나, 메시지가 올 때마다 모든 세션 기록을 다시 읽는 것.
- 세션 상태가 바뀔 때 줄이 구역 사이를 깜빡이며 오가는 것(같은 입력이면 같은 결과여야 한다).

## 지금 구조 (코드로 확인)

경로 앞부분 `H/` = `packages/happy-android/app/src/main/kotlin/com/slopus/happy/`.

- **목록 만들기.** `HomeListModel`(`H/ui/home/HomeList.kt` 262행)이 스냅숏·설정·안 읽음·맥 백그라운드 세션 목록을 묶어 `deriveHomeList`로 목록을 만든다. 기본 보기는 `flatRows`가 `buildFlatSessionRows(sortByActivity = true)`(`H/model/SessionList.kt` 391행)로 "활성 먼저, 그다음 최근 활동순" 한 줄 목록을 만든다.
- **상태.** `resolveSessionState`(`H/model/Session.kt` 37행): 꺼짐 → Disconnected, 권한 요청 있음 → PermissionRequired, 답 요청 있음 → InputRequired, 생각 중 → Thinking, 그 밖 → Waiting. 맥 백그라운드 세션만 있고 거울이 아직 없는 줄은 `backgroundAgentState`가 busy → Thinking, waiting → PermissionRequired로 정한다.
- **줄 모양.** `H/ui/home/FlatSessionRow.kt`. 일하는 중이면 제목 반짝임, 막혀 있으면 주황 점, 안 읽었으면 파란 점. 시간 표시는 없다(`formatSessionListTimestamp`는 `HomeFormat.kt`에 있다).
- **보관함.** 꺼진 세션은 `hideInactiveSessions`(기본 켬)일 때 맨 아래 접힌 줄로 간다.
- **시각 정보.** 권한 요청마다 `createdAt`(`H/chat/AgentState.kt`), 세션의 `metadata.lastMeaningfulMessageAt`(`activityAt()`), `thinkingAt`(활동 신호 시각, 시작 시각이 아님).
- **기기에 저장된 메시지.** `messages` 표는 `(session_id, seq)`가 기본 키다(`H/data/HappyDatabase.kt` 133행). 세션마다 최근 몇 개를 꺼내는 건 색인 범위 조회 한 번이다. `HappyStore.messages(sessionId, limit)`가 이미 있고, 내용은 복호화된 JSON이라 `ChatNormalizer.normalize`로 읽을 수 있다. 세션 행의 `messages_seq`가 그 세션의 최신 순번이다.

## 접근

마지막 한 줄을 어디서 얻느냐가 갈림길이었다.

1. **앱이 기기에 저장된 메시지에서 뽑는다 (선택).** 세션마다 최근 몇 개를 읽어 마지막 답·도구 줄을 고른다. 앱만 고치면 되고, 지금 돌고 있는 모든 세션에 바로 된다. 대신 기기가 아직 그 세션 메시지를 받지 않았으면 비어 있으므로 폴더 이름으로 대신한다.
2. CLI가 마지막 한 줄을 세션 메타데이터에 써 준다. 기기에 메시지가 없어도 보이지만 CLI·앱을 같이 고쳐야 하고, 이 브랜치 CLI로 띄운 세션에만 되며, 답마다 메타데이터 쓰기가 늘어난다. 버렸다.
3. 서버가 미리보기를 준다. 메시지가 종단간 암호화라 서버는 내용을 모른다. 불가능.

사용자가 1을 골랐다("진행!").

## 정한 것

### 구역 나누기 (사용자 결정: 안 A)
- **Needs input**: 상태가 PermissionRequired 또는 InputRequired.
- **Working**: Thinking.
- **Completed**: 살아 있는(또는 맥 `claude agents`에 아직 있는) 세션 중 Waiting, 즉 답을 끝내고 다음 지시를 기다리는 세션.
- 꺼진 세션은 지금처럼 맨 아래 보관함.
- 구역 안 순서: Needs input·Working은 그 상태가 된 지 오래된 것이 위(가장 오래 기다린 것부터), Completed는 최근에 끝난 것이 위.

### 모양 (사용자 승인 목업 "B + C")
- 맨 위 **요약 칩**: `● Needs input 1`, `Working 3`, `Done 8`. 비어 있는 구역은 칩도 카드도 숨긴다. 칩을 누르면 그 카드로 스크롤.
- 구역마다 둥근 **카드**, 왼쪽 색 띠: Needs input 주황 `#FF9500`, Working 파랑, Completed 회색. 카드 머리에 구역 이름과 개수.
- **Completed**는 최근 3개만 보이고 나머지는 `Show N more`. 누르면 펼친다.
- **줄**: 아바타, 제목(Working이면 반짝임), 그 아래 마지막 한 줄. 오른쪽 위에 상태 표시(`Approve`/`Reply`), 아래에 시간. Completed 줄은 제목을 살짝 흐리게.
- **파란 점**: 끝났는데 아직 안 열어 본 세션(지금의 안 읽음 표시 그대로).
- 주황 점은 `Approve`/`Reply` 표시로 바꾼다.
- 맨 아래 `▸ Archived · N`.

### 마지막 한 줄
- 세션의 최근 메시지(약 20개)를 최신부터 보며 처음 나오는 **에이전트 글** 또는 **도구 호출**을 쓴다. 글은 첫 줄만, 마크다운 기호를 걷고 한 줄로 자른다. 도구는 도구 제목(없으면 이름과 대표 인자)을 쓴다. 생각(thinking)·이벤트·사용자 메시지는 건너뛴다.
- 기기에 그 세션 메시지가 없거나 고를 줄이 없으면 지금처럼 폴더 이름.
- 다시 계산은 세션의 최신 순번(`messages_seq`)이 바뀐 세션만 한다. 나머지는 이전 결과를 그대로 쓴다.
- 홈에 보이는 살아 있는 세션만 계산한다. 보관함 세션은 계산하지 않는다.

### 시간
- **Needs input**: 기다리는 권한 요청 중 가장 이른 `createdAt`부터 지금까지. 시각이 없으면 앱이 그 상태를 처음 본 때부터.
- **Working**: 이번 차례를 시작한 사용자 메시지(기기에 있는 가장 최근 사용자 메시지)의 시각부터. 없으면 앱이 그 상태를 처음 본 때부터.
- **Completed**: `activityAt()`(마지막 의미 있는 메시지 시각)을 시각으로 보인다(`9:31`, 오늘이 아니면 기존 날짜 형식).
- 경과 시간은 `40s`, `12m`, `2h` 꼴. 화면에 Needs input·Working 줄이 있는 동안만 30초마다 다시 그린다.

### 상태 표시
- 권한 요청(PermissionRequired) → `Approve`.
- 질문·답 요청(InputRequired) → `Reply`.
- 거울 없이 맥 상태만 아는 막힌 줄(`claude agents`의 waiting) → 무엇을 기다리는지 모르므로 `Reply`.

## 내가 정한 것 (확인 부탁)
- 글자는 영어로 쓴다. 앱에 한국어 로케일이 없다.
- 이 변경은 "Flat list" 보기에만 적용하고 "Group by project"는 그대로 둔다.
- Completed는 3개만 먼저 보인다.
- Needs input·Working 안에서는 가장 오래 그 상태인 줄이 위다.
- 맥 상태만 아는 막힌 줄은 `Reply`.
- 칩을 누르면 스크롤만 한다(걸러 보기 아님).
- 마지막 한 줄이 없으면 폴더 이름.

## 만드는 사람에게 맡기는 것
- 마지막 한 줄 계산을 둘 자리(예: `HomeListModel` 입력에 세션별 미리보기 흐름 하나 추가)와 그 캐시 모양.
- 카드·칩의 정확한 여백·글자 크기(목업 비율을 따른다).
- 한 줄 자르기 길이와 마크다운 걷기 규칙의 세부.
- 단위 테스트는 구역 나누기·순서, 마지막 한 줄 고르기, 시간 문구, 상태 표시 대응을 덮는다. 기기 확인은 dev 앱을 폰에 깔아 눈으로 본다.
