# Void {{PRODUCT_VERSION}} 현재 릴리스 노트

이 문서는 이 portable의 현재 사용자 동작과 검증 경계만 설명합니다. 누적 변경 이력, 내부 장애 기록 또는 향후 계획은 포함하지 않습니다.

## Fixed start

이 portable은 조직용 연결과 model을 package가 관리합니다. provider나 model을 선택하거나 연결 정보를 입력할 필요가 없고 Chat에는 `gpt-5.6-luna`가 표시됩니다. 초기 Settings에는 edits, terminal, MCP tools와 LLM changes의 자동 승인이 켜져 있습니다.

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
- user와 trusted Project의 `.codex/config.toml`에서 제한된 developer instruction, Skill enable/disable과 `[agents]` limits를 읽습니다. `max_accepted_children`, `max_concurrent_threads_per_session`, `max_depth`의 default는 `4`, `2`, `1`입니다. accepted/concurrent는 양의 정수이고 concurrent는 accepted 이하이며 depth는 0 이상 정수입니다. Trusted Project 값이 우선합니다.
- `$` direct selector와 `@` menu는 같은 repository/user/plugin `.agents/skills/<name>/SKILL.md` catalog를 사용합니다. Markdown code는 literal이고 missing/ambiguous selection은 draft/staging을 보존한 visible error로 중단합니다.
- user와 trusted Project의 `.codex/agents/*.toml`은 strict named role을 제공합니다. Duplicate/invalid role은 bounded diagnostic으로 격리되며 stale selection은 provider send 전에 reselect를 요구합니다.
- Native Agent route는 generic child controls를 marker 없이 제공합니다. `@Agent`는 optional intent이며 named selection은 exact `agent_type`을 고정합니다. Unsupported/no-model route는 provider send 전에 진단됩니다.

## Profile-aware bounded subagent와 current Chat UI

- Default group limit은 accepted `4`, concurrent `2`, depth `1`입니다. FIFO와 shared nested group budget을 사용하고 `wait_agent` targets는 `1..8`개입니다. Terminal child가 settle되면 open capacity는 다음 FIFO admission에 반환되고 retained terminal result는 capacity-derived budget 안에서 truthful truncation metadata를 표시할 수 있습니다.
- `read_only` role은 `read_file`, `ls_dir`, `search_pathnames_only`, `search_for_files`, `search_in_file`만 노출하며 exact copy는 **Void application-level read-only — terminal disabled, no OS sandbox**입니다.
- `inherit_parent_write` role은 frozen parent tool snapshot을 broker로 사용합니다. Captured parent approval policy가 적용되는 pending manual approval은 composer-adjacent Approve/Reject card에서 처리합니다. One mutation-capable child만 동시에 실행되며 nested child도 같은 group budget/cancellation을 공유하고 live authority를 얻지 않습니다. The durable Child Activity card shows role/description when present, coarse capability, status, and timing. It can show a bounded terminal summary and, when applicable, Result compacted, nested activity rows, and ledger-retention notices. The separate pending approval card is the child-specific surface that shows the pending tool title, approval category, bounded parameters, and Approve/Reject. The durable card's Capability field is coarse. Exact read-only tool membership and inherited frozen authority are not exposed there. Treat full membership and authority as source/focused unless explicitly defined registry or broker instrumentation exists; a normal bounded tool trace proves only the calls it records. Verify Undo from actual file/editor state. A failed child can leave bounded failure context in the activity summary. The durable card has no separate scheduler-capacity, diagnostic, or technical-detail panel and no raw/full child transcript. The composer has no separate child progress/status/detail panel; the pending approval card is its only child-specific panel. When a queued/running child is the only active work and no higher-priority error, preparing, retry, or approval state applies, the generic composer announces `Running · Esc to stop`, with an unsent-draft suffix when applicable, and shows Stop.
- `read_skill_resource`, `spawn_agent`, `wait_agent`, `interrupt_agent`는 각각 **Read Skill resource**, **Start child Agent**, **Wait for child Agent**, **Interrupt child Agent** application card를 사용합니다. Running/Completed/Failed/Rejected/Invalid request/Cancelled/Requested 상태를 표시하고 MCP fallback이나 generic approval을 사용하지 않습니다.
- Composer 위에는 pending child tool의 approval card만 child-specific surface로 표시하고 별도 child progress/status/detail panel은 표시하지 않습니다. queued/running child가 only active work이고 higher-priority 상태가 없을 때 generic current-run announcement와 Stop control은 유지됩니다. Spawn receipt에 묶인 bounded expandable Child activity card의 bounded summary에는 failure context가 포함될 수 있지만, 이 card는 별도 scheduler-capacity/diagnostic/technical panel, raw/full child transcript/session, exact tool/frozen-authority/Undo surface가 아닙니다. thread-level `ChildActivitiesLedger`는 그 thread의 retained root cards가 공유하며 combined total 32 records / UTF-8 64 KiB projection retention을 적용합니다. 이는 separate Queue/Steer inbox envelope의 32/64 상한과 독립적이고 per-card 상한이 아닙니다. Running tool card는 always-visible elapsed와 exact card Stop 또는 unavailable reason을 보여 줍니다. Local trace는 first 128 lifecycle events와 이후 dropped count만 보존하지만 composer UI에 노출하지 않고, provider usage가 없으면 `Usage unavailable`을 표시합니다.
- Landing의 non-empty Chat history는 newest-first로 Current와 background Running/action-required 상태를 분리합니다. Persistent history is not rendered below the current Chat composer; header의 `View Past Chats`로 landing에 돌아갑니다. Current/active row의 Delete guard와 focus handoff를 유지합니다. Chat별 unsent composer draft는 이동 뒤 복원되지만 memory-only라 restart 뒤 보존되지 않습니다. 별도 Queue/Steer inbox는 최대 32 records / UTF-8 64 KiB로 durable하며 reload 뒤 dormant이고 자동 전송하지 않습니다. 사용자가 명시적으로 Resume하면 한 번만 재개합니다. 이는 source/focused 계약이고 packaged process-restart E2E는 아직 관찰하지 않았습니다.
- Child/group 전체 wall-clock·turn·cumulative-send quota는 없습니다. configured scheduler capacity와 operation-specific timeout/cancellation은 유지되고 actual logical in-flight provider-dispatch lease만 센다. finite manual run은 whole-run child/group quota 부재를 증명하지 않으며, 그 부재는 separate long-running evidence가 없으면 source/focused 결과로 남습니다. Provider-native batch는 durable declaration/provider ordinal을 보존합니다. approved contiguous exact-safe-read calls만 physical cap-two waves로 실행할 수 있고 physical completion order는 durable tool/provider row settlement를 바꾸지 않습니다. non-safe calls는 declaration-order barriers이며 mutation/terminal/MCP는 serialized/exclusive입니다. next provider continuation은 batch terminal or paused까지 기다립니다. literal `multi_tool_use.parallel`은 없습니다. Plan/orchestration은 main parent가 소유하며 새 Plan API/UI/storage와 same-child follow-up은 제공하지 않습니다.

## Assistant message 표시

- Native OpenAI tool-call assistant는 empty content와 tool calls를 유지하고 Anthropic/Gemini tool-only form에도 fake text를 넣지 않습니다.
- Exact `(empty message)` sentinel은 outbound parent/child history, persisted `displayContent`와 visible renderer에 남지 않습니다. Surrounding legitimate text는 보존합니다.
- Non-empty reasoning-only response는 display text가 없어도 reasoning bubble로 보입니다. Whitespace-only edge를 일반화하지 않으며 actual provider behavior는 별도 관찰 대상입니다.

## Controlled Search fallback

- `search_pathnames_only`와 `search_for_files`는 bundled Search backend를 먼저 사용하며, 그 executable을 시작할 수 없을 때만 automatic controlled fallback이 system ripgrep을 사용합니다.
- fallback은 terminal capability를 부여하거나 extra approval을 요구하지 않습니다. system ripgrep도 없으면 stable `search_backend_unavailable` 오류를 반환합니다. `search_in_file`은 기존 in-process 경로를 유지합니다.
- fallback은 saved-disk 결과이므로 unsaved editor buffer를 합치지 않습니다. pathname fuzzy matching/order와 모든 exclude/config 동작은 bundled primary보다 degraded될 수 있습니다.
- content primary의 bounded raw-match budget 때문에 later file page를 확정할 수 없으면 false empty 대신 `search_output_limit`를 반환합니다.

## Ghost Chat code suggestions

- Built production Settings는 **Enable Ghost Chat code suggestions**와 **Show suggestions on select**를 표시하지 않습니다.
- 이전 profile에 persisted `true`가 남아 있어도 automatic Ghost request, Ghost debounce와 selection helper widget은 활성화되지 않습니다.
- **production automatic suggestions are unavailable**이며 legacy FIM `/completions` retirement도 유지됩니다.
- Chat sidebar, Quick Edit와 Agent는 이 비활성 경계의 영향을 받지 않습니다.

## Settings switch styling

- Shared switch는 native checkbox를 interaction owner로 유지하고 필요한 곳에서 `role=switch`, checked/disabled/Space와 accessible name을 보존합니다.
- Independent Settings entry의 scoped CSS는 normal/dark와 Chromium `forced-colors` emulation에서 track, knob와 한 focus ring을 제공합니다.
- Windows OS High Contrast는 final product에서 직접 관찰해야 하며 source fixture 결과만으로 통과했다고 기록하지 않습니다.

## Portable package contract

- 정식 package는 manifest에 선언된 x64 runtime payload와 필수 `Void.exe`, `resources/app/product.json`, `data/README.txt`를 검증합니다.
- 생성 사용자 데이터인 `data/argv.json`과 `data/user-data/`는 ZIP에서 제외합니다.
- 내장 `docs/`는 release-content manifest exact whitelist, UTF-8/non-empty, Windows-safe path와 outer/portable shared-byte identity를 통과해야 합니다.
- 새 portable과 outer 묶음의 SHA-256, entry 목록과 embedded portable identity가 모두 일치해야 게시할 수 있습니다.

## 확인된 범위와 남은 관찰

Focused schema/planner/service/UI tests는 위 source 계약을 확인합니다. 정식 package gate는 fixed startup, controlled Chat 관찰과 project instruction child UI를 포함합니다. Queue/Steer restart recovery, expanded Child activity, inherited-write, provider multi-tool과 scheduler 동작은 source/focused로 확인됐지만 packaged UI/provider/process-restart E2E로 주장하지 않습니다. 일반 chat/tool/UI provider matrix, `read_file`의 실제 환경 성능, persistent child group/restart replay, full child transcript history와 arbitrary live provider/tool/permission elevation은 검증 또는 지원 범위를 넘어섭니다. Configured depth nesting과 inherited frozen-parent profile을 arbitrary child authority로 확대 해석하지 마세요. 동봉 prompt의 예상 결과를 통과 사실로 간주하지 말고 실제 환경에서 별도로 기록하세요.
