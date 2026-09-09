# Void 1.99.6 Windows x64 배포 묶음

이 묶음은 사용자 문서가 내장된 portable 제품 ZIP과 `write_file`/`read_file`/Agent/Ghost Chat 안내서, 그리고 실제 제품 관찰용 프롬프트를 함께 전달합니다. 이 README의 값은 assembler가 실제 새 portable을 만든 뒤에만 확정합니다. placeholder를 hash 또는 통과 사실로 해석하지 마세요.

## 포함 파일

- `Void-1.99.6-win32-x64-portable.zip`: portable 제품 ZIP
- `SHA256SUMS.txt`: assembler가 placeholder 치환 뒤 생성하는 manifest
- `guides/write-tool-guide.md`, `guides/read-tool-guide.md`: 파일 도구 계약과 안전 경계
- `guides/agent-instructions-guide.md`: `AGENTS.md`, config, Skills, custom agents와 profile-aware bounded subagent 사용 안내
- `guides/ghost-chat-guide.md`: production Ghost Chat과 selection helper 비활성 상태 및 영향받지 않는 기능
- `prompts/write-tool-test-prompts.md`, `prompts/read-tool-test-prompts.md`, `prompts/agent-instructions-test-prompts.md`, `prompts/ghost-chat-test-prompts.md`: 탐색적 제품 테스트와 production suggestion 부재 확인 절차

portable ZIP 자체의 `docs/`에도 시작 안내, current-only release notes와 위 guide/prompt의 동일한 bytes가 들어 있습니다. release notes는 누적 내부 이력이 아니라 해당 portable에서 shipped되는 현재 동작만 설명합니다.

## 새 portable 정보 — assembler가 채울 값

- 크기: `{{PORTABLE_SIZE}}`
- SHA-256: `{{PORTABLE_SHA256}}`
- 검증된 ZIP entry 수: `{{PORTABLE_ENTRIES}}`
- source HEAD: `{{SOURCE_HEAD}}`
- build date (KST): `{{BUILD_DATE_KST}}`

필수 entry는 `Void.exe`, `resources/app/product.json`, `data/README.txt`입니다. portable 초기 데이터인 `data/argv.json`과 `data/user-data/`는 배포 ZIP에서 제외합니다. assembler는 새 portable의 hash/size/entry 및 필수 entry gate가 성공한 뒤에만 이 묶음을 게시해야 합니다.

portable ZIP을 새 폴더에 풀고 일반 사용자 권한으로 `Void.exe`를 실행하세요. portable 데이터는 압축 해제 폴더의 `data` 아래에 만들어집니다. 기존 설치본이나 다른 portable 복사본 위에 덮어 풀지 마세요.

이 portable은 조직용 연결과 model을 package가 관리합니다. provider나 model을 선택하거나 연결 정보를 입력할 필요가 없고 Chat에는 `gpt-5.6-luna`가 표시됩니다.

```powershell
Get-FileHash -Algorithm SHA256 .\Void-1.99.6-win32-x64-portable.zip
Expand-Archive .\Void-1.99.6-win32-x64-portable.zip .\Void-1.99.6-portable
.\Void-1.99.6-portable\Void.exe
```

## Agent instructions, Skills, custom agents와 bounded subagent

이 릴리스의 Chat은 항상 Agent로 동작하며 `AGENTS.md`, user/trusted Project `.codex/config.toml`, `.agents/skills` catalog와 user/trusted Project `.codex/agents/*.toml` custom role을 제공합니다. Native Agent route에서는 child control이 marker 없이 generic하게 제공됩니다. `@Agent`는 optional generic/named intent이며 named role selection은 exact `agent_type`을 고정합니다. 지원하지 않는 provider format이나 사용할 model이 없는 경우에는 history/provider send 전에 bounded diagnostic으로 중단합니다.

`[agents]`의 `max_accepted_children`, `max_concurrent_threads_per_session`, `max_depth` default는 각각 `4`, `2`, `1`입니다. accepted/concurrent는 양의 정수이고 concurrent는 accepted 이하이며 depth는 0 이상 정수입니다. Trusted Project 값이 user 값을 override합니다. FIFO와 shared nested group budget을 사용하며 `wait_agent`는 target `1..8`개를 받을 수 있습니다. Terminal child가 settle되면 open capacity는 다음 FIFO admission에 반환됩니다.

Role의 `read_only` profile은 exact five read tools만 제공하고 terminal, MCP와 mutation을 제공하지 않습니다. `inherit_parent_write` profile은 parent가 turn admission 때 가진 frozen parent tool snapshot만 broker를 통해 사용합니다. Captured parent approval policy가 적용되며 manual approval policy에서는 composer-adjacent approval card의 Approve/Reject를 기다립니다. Mutation-capable child는 한 번에 하나만 실행되고 nested child도 같은 group budget과 cancellation을 공유하며 live authority 또는 독립 elevation을 얻지 않습니다. The durable Child Activity card shows role/description when present, coarse capability, status, and timing. It can show a bounded terminal summary and, when applicable, Result compacted, nested activity rows, and ledger-retention notices. The separate pending approval card is the child-specific surface that shows the pending tool title, approval category, bounded parameters, and Approve/Reject. The durable card's Capability field is coarse. Exact read-only tool membership and inherited frozen authority are not exposed there. Treat full membership and authority as source/focused unless explicitly defined registry or broker instrumentation exists; a normal bounded tool trace proves only the calls it records. Verify Undo from actual file/editor state. A failed child can leave bounded failure context in the activity summary. The durable card has no separate scheduler-capacity, diagnostic, or technical-detail panel and no raw/full child transcript. The composer has no separate child progress/status/detail panel; the pending approval card is its only child-specific panel. When a queued/running child is the only active work and no higher-priority error, preparing, retry, or approval state applies, the generic composer announces `Running · Esc to stop`, with an unsent-draft suffix when applicable, and shows Stop.

`$`는 `@`의 기존 Skills catalog를 그대로 열어 filter하고 `$bare` 또는 `$qualified:identity`를 canonical selector text로 남깁니다. Markdown code의 selector-looking text는 literal이며 missing/ambiguous selection은 draft와 staging을 보존한 채 visible error로 중단합니다. `read_skill_resource`, `spawn_agent`, `wait_agent`, `list_agents`, `send_message`, `interrupt_agent`는 exact application cards로 표시되며 MCP fallback이나 generic approval UI를 빌리지 않습니다.

`spawn_agent`는 optional `model`, `reasoning_effort`, `fork_turns`(`none`/`all`/positive count, default `none`)를 지원하며 explicit 값이 role, parent보다 우선합니다. `list_agents`는 bounded tree/status/result를 비소비 조회하고, `send_message`는 active same-group target의 다음 안전 경계에 queue-only 전달합니다. Late completion은 Stop/new user turn/generation/owner fence 뒤 parent에 자동 전달되며 반복 wait는 retained terminal result와 delivery 상태를 구분합니다.

Composer 위에는 pending child tool의 approval card만 child-specific surface로 남고 별도 child progress/status/detail panel은 없습니다. queued/running child가 only active work이고 higher-priority 상태가 없을 때 generic current-run announcement와 Stop control은 계속 표시됩니다. Spawn receipt에 묶인 bounded expandable Child activity card는 위의 compact activity 정보만 durable 상태 기록으로 보여 줍니다. bounded summary에는 failure context가 포함될 수 있지만 별도 scheduler-capacity/diagnostic/technical panel이나 raw/full child transcript/session, exact tool/authority surface는 아닙니다. thread-level `ChildActivitiesLedger`는 그 thread의 retained root cards가 공유하며 combined total 32 records / UTF-8 64 KiB projection retention을 적용합니다. 이는 separate Queue/Steer inbox envelope의 32/64 상한과 독립적이고 per-card 상한이 아닙니다. Local trace retention and provider-usage projection are SOURCE/FOCUSED contracts. Neither the current composer nor the durable Child Activity card renders diagnostics or usage. Landing의 non-empty Chat history는 newest-first이며 persistent history is not rendered below the current Chat composer. Header의 `View Past Chats`가 landing access path입니다. 정확한 지원 경계와 직접 관찰 절차는 `guides/agent-instructions-guide.md`와 `prompts/agent-instructions-test-prompts.md`를 확인하세요.

전송하지 않은 composer draft는 memory-only라 restart 뒤 보존되지 않습니다. 이와 별도로 Queue/Steer pending inbox는 최대 32 records / UTF-8 64 KiB로 durable하게 보관됩니다. reload 뒤에는 dormant이며 자동 전송하지 않고, 사용자가 명시적으로 Resume하면 한 번만 재개합니다. 이는 source/focused 계약이며 실제 packaged process-restart 관찰은 아직 별도입니다.

Child/group 전체 run의 wall-clock·turn·cumulative-send quota는 없습니다. configured scheduler capacity와 operation-specific timeout/cancellation은 유지되고 provider dispatch는 실제 logical in-flight lease만 센다. finite manual run은 whole-run child/group quota 부재를 증명하지 않으며, 그 부재는 separate long-running evidence가 없으면 source/focused 결과로 남습니다. Provider-native batch는 durable declaration/provider ordinal을 보존합니다. approved contiguous exact-safe-read calls만 physical cap-two waves로 실행할 수 있고 physical completion order는 durable tool/provider row settlement를 바꾸지 않습니다. non-safe calls는 declaration-order barriers이며 mutation/terminal/MCP는 serialized/exclusive입니다. next provider continuation은 batch terminal or paused까지 기다립니다. literal `multi_tool_use.parallel`은 제공하지 않습니다. Plan과 orchestration은 main parent가 소유하며 새 Plan API/UI/storage와 same-child follow-up은 제공하지 않습니다.

Provider/tool loop의 native empty tool-call content는 fake display text로 바꾸지 않습니다. Exact `(empty message)` sentinel은 parent/child outbound history, persisted display와 renderer에 남지 않으며 non-empty reasoning-only content는 reasoning bubble로 계속 보입니다.

focused tests, compile·React·Windows build와 packaged fixed-start/Chat/child UI smoke는 release gate입니다. 다만 일반 provider matrix, mutation 결과와 performance 전체를 대신하는 증거는 아닙니다. prompt의 예상 결과를 미리 통과 사실로 기록하지 마세요.

## Ghost Chat

현재 built production에서는 **production automatic suggestions are unavailable**입니다. Settings는 **Enable Ghost Chat code suggestions**와 **Show suggestions on select**를 모두 표시하지 않습니다. 이전 profile에 두 setting의 `true` 값이 남아 있어도 무시되며 automatic Ghost request, Ghost debounce와 selection helper widget은 활성화되지 않습니다.

이 변경은 Chat sidebar, Quick Edit와 Agent 기능을 비활성화하지 않습니다. Production에서 두 설정과 자동 editor suggestion이 나타나지 않는지 확인하려면 `guides/ghost-chat-guide.md`와 `prompts/ghost-chat-test-prompts.md`를 사용하세요. Legacy FIM `/completions` retirement도 그대로 유지됩니다.

## Settings switch 표시 경계

Settings의 shared switch는 실제 native checkbox를 interaction owner로 유지하고, `role=switch`가 필요한 곳의 checked/disabled/Space와 accessible name을 보존합니다. 독립 Settings entry가 scoped CSS를 먼저 전달해 normal/dark와 Chromium `forced-colors` emulation에서 track, knob와 하나의 focus ring을 표시합니다. Windows OS High Contrast는 packaged product에서 직접 관찰해야 하는 boundary이며 source fixture 통과 사실로 대신하지 않습니다.

## OpenAI-compatible file tool contract

OpenAI-compatible Agent의 `write_file`은 root `type: object`, `create`/`modify` operation enum과 optional branch fields를 가진 flat model-facing schema를 사용합니다. `oneOf`, `anyOf`, `allOf`, `if`, `then`, `else`, `const`는 사용하지 않습니다. create/modify의 required·forbidden 조합, unknown key 거부, current read receipt와 stale snapshot 검사는 runtime이 계속 엄격하게 강제합니다.

새 파일 create도 전체 내용을 empty baseline에 대한 Chat diff로 표시하며 기존 Auto-accept 설정을 따릅니다. 사용자가 Reject하거나 Undo하면 파일은 삭제하지 않고 빈 파일로 남습니다. `wait_agent`는 timeout을 생략하면 최대 1시간 기다리되 child completion, coordination message 또는 같은 parent run의 Steer가 도착하면 즉시 깨어납니다. 결과가 없는 순수 timeout 행만 Chat 화면에서 숨기고 저장된 tool call/result 원장은 유지합니다.

완료 전에 닫힌 stream은 tool success로 처리하지 않습니다. 사용자에게 보이는 진단은 tool/schema posture와 stream phase를 구분할 수 있으며 secret 또는 request content를 기록하지 않아야 합니다. 중요한 파일을 변경하기 전 작은 임시 workspace에서 실제 chat, tool trace, editor 결과와 Undo를 함께 확인하세요.

## 현재 패키지 gate

정식 assembler는 manifest에 선언된 x64 runtime payload가 artifact와 ZIP에 모두 있고 non-empty인지, `Void.exe`, `resources/app/product.json`, `data/README.txt`가 존재하는지 확인합니다. 생성 사용자 데이터는 제외하고, 사용자 문서는 manifest exact whitelist·UTF-8·Windows-safe path·shared outer/portable byte identity를 통과해야 합니다. 새 portable과 outer 묶음의 hash, entry와 embedded ZIP identity가 모두 검증된 뒤에만 게시합니다.

이 항목은 새 portable의 실제 artifact/ZIP 검증이 성공한 뒤 확정되는 gate입니다. placeholder 상태의 이 staging 문서 자체가 새 portable 성공을 뜻하지 않습니다.

## 확인된 범위와 남은 경계

focused schema/planner/diagnostic, Agent orchestration과 production suggestion admission tests는 현재 source 계약을 확인합니다. 정식 package gate는 fixed startup, Agent workspace instruction/child UI와 한 번의 controlled Chat 관찰을 포함하지만, 전체 provider/UI matrix를 대신하지는 않습니다. Built production에서는 persisted setting 값과 관계없이 automatic Ghost request와 selection helper UI가 0이어야 합니다.

일반 provider 조합, 승인 UI, create/modify 적용과 Undo, AGENTS/Skill/custom-agent/subagent의 넓은 작업 사례는 동봉 prompt를 사용해 확인하세요. `read_file`의 실제 performance/closed-file streaming gate와 mutation workflow 전체도 별도 관찰 대상입니다.

프롬프트는 탐색적 테스트이지 통과 사실이 아닙니다. 실제 결과, provider/model, tool trace, UI 상태를 기록한 경우에만 해당 환경의 관찰 증거가 됩니다.
