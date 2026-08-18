# Void {{PRODUCT_VERSION}} 현재 릴리스 노트

이 문서는 이 portable의 현재 사용자 동작과 검증 경계만 설명합니다. 누적 변경 이력, 내부 장애 기록 또는 향후 계획은 포함하지 않습니다.

## Native file tools

### `write_file`

- native structured `write_file` 하나가 create와 snapshot 기반 modify를 처리합니다.
- model-facing schema는 flat root object와 `create`/`modify` operation을 사용합니다. branch별 required·forbidden 조합, unknown key, exact/unique edit와 current read receipt는 runtime이 검사합니다.
- 수정은 editor review와 Undo 가능한 transaction으로 적용됩니다. stale receipt, ambiguous match와 invalid branch는 mutation 전에 거부됩니다.

### `read_file`

- 1-based inclusive line 범위, UTF-8 byte continuation과 동적 output cap을 사용합니다.
- 가능한 경우 saved disk가 아니라 current live editor snapshot을 읽고, owner·document version·range가 연결된 opaque receipt를 반환합니다.
- 진행할 수 없는 page, invalid cursor와 history budget 초과를 성공처럼 반환하지 않습니다. 변경 또는 Undo 뒤에는 새 read와 새 receipt가 필요합니다.

## OpenAI-compatible transport

OpenAI-compatible Agent의 flat tool schema는 conditional composition에 의존하지 않습니다. Stream이 completion 전에 닫히면 tool success로 처리하지 않고 configured route, tool/schema posture와 stream phase를 구분하는 진단을 표시할 수 있습니다. 진단 기록에는 credential, provider header values와 request content를 복사하지 마세요.

## Agent instructions, Skills와 custom agents

- active owner Project의 `AGENTS.md` chain은 top-level user turn마다 reload되고 같은 turn에는 동일 revision을 유지합니다.
- user와 trusted Project의 `.codex/config.toml`에서 제한된 developer instruction과 Skill enable/disable 설정을 읽습니다.
- repository/user/plugin `.agents/skills/<name>/SKILL.md` catalog는 exact full-body admission과 confined lazy resource read를 사용합니다.
- user와 trusted Project의 `.codex/agents/*.toml`은 strict named direct-child role을 제공합니다. Role은 required metadata와 read-only boundary를 검증한 뒤 admit됩니다.

## Bounded read-only subagent와 current Chat UI

- Agent mode의 parent generation마다 최대 4 accepted direct child, 동시에 최대 2 running과 FIFO queue를 사용합니다.
- Child depth는 1입니다. Child에는 `read_file`, `ls_dir`, `search_pathnames_only`, `search_for_files`, `search_in_file`만 노출되며 terminal/write/MCP/app tool은 없습니다.
- `wait_agent`는 전체 또는 선택 target의 결과를 spawn order로 전달하고, `interrupt_agent`는 선택한 queued/running child만 취소합니다.
- transient Child Run panel은 capacity, state, timing과 failure를 표시합니다. Local trace는 first 128 lifecycle events와 이후 dropped count만 보존하며 provider usage가 없으면 `Usage unavailable`을 표시합니다.
- Chat history는 Current와 background Running/action-required 상태를 분리합니다. Current composer는 Error, Needs approval, Running, unavailable과 idle에 맞는 Send/Stop 상태를 사용합니다. Chat별 unsent draft는 이동 뒤 복원되지만 restart에는 persist하지 않습니다.

## Ghost Chat code suggestions

- Built production Settings는 **Enable Ghost Chat code suggestions**와 **Show suggestions on select**를 표시하지 않습니다.
- 이전 profile에 persisted `true`가 남아 있어도 automatic Ghost request, Ghost debounce와 selection helper widget은 활성화되지 않습니다.
- **production automatic suggestions are unavailable**이며 legacy FIM `/completions` retirement도 유지됩니다.
- Chat sidebar, Quick Edit와 Agent는 이 비활성 경계의 영향을 받지 않습니다.

## Portable package contract

- 정식 package는 manifest에 선언된 x64 runtime payload와 필수 `Void.exe`, `resources/app/product.json`, `data/README.txt`를 검증합니다.
- 생성 사용자 데이터인 `data/argv.json`과 `data/user-data/`는 ZIP에서 제외합니다.
- 내장 `docs/`는 release-content manifest exact whitelist, UTF-8/non-empty, Windows-safe path와 outer/portable shared-byte identity를 통과해야 합니다.
- 새 portable과 outer 묶음의 SHA-256, entry 목록과 embedded portable identity가 모두 일치해야 게시할 수 있습니다.

## 확인된 범위와 남은 관찰

Focused schema/planner/service/UI tests는 위 source 계약을 확인합니다. 전체 chat/tool/UI provider E2E, `read_file`의 실제 환경 성능, nested child, persistent child group/restart replay, full child transcript history와 arbitrary provider/MCP/terminal/write permission override는 검증 또는 지원 범위를 넘어섭니다. 동봉 prompt의 예상 결과를 통과 사실로 간주하지 말고 실제 환경에서 별도로 기록하세요.
