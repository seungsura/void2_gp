# Agent instructions, Skills, custom agents와 bounded subagent 직접 테스트 프롬프트

모든 항목은 실제 제품 관찰용입니다. 예상 결과를 미리 PASS로 기록하지 마세요. 별도 임시 workspace에서 Chat을 사용하세요. Chat은 항상 Agent로 동작합니다. `PASS`/`FAIL`/`BLOCKED`/`EXPLORATORY`, provider/model, top-level turn, selector, bounded tool trace, Child Run·Chat UI와 실제 file state를 함께 기록하세요. Source fixture, build와 artifact smoke는 actual provider/network E2E를 대체하지 않습니다.

## 1. `AGENTS.md` next-turn reload와 same-turn revision

Setup A: workspace root의 `AGENTS.md`에 다음 한 줄을 저장합니다.

```text
End every user-facing answer with the exact token [RULE-A].
```

Exact prompt A:

```text
현재 적용된 규칙을 따르며 한 문장으로 READY라고 답하세요.
```

Expected A: 첫 top-level turn의 답이 `[RULE-A]`로 끝납니다. turn이 완전히 끝난 뒤 `AGENTS.md`의 token을 `[RULE-B]`로 바꾸고 저장합니다.

Exact prompt B:

```text
새 top-level turn입니다. 현재 적용된 규칙을 따르며 한 문장으로 READY라고 답하세요.
```

Expected B: 새 turn은 `[RULE-B]`로 끝납니다. approval 또는 tool continuation 중 pause를 만들 수 있다면 같은 turn 도중 A→B로 바꾼 뒤 continuation은 `[RULE-A]`, 다음 top-level turn은 `[RULE-B]`인지 추가 관찰합니다. pause를 재현하지 못하면 same-turn 항목은 `BLOCKED`로 남기고 추정하지 않습니다.

Record: turn 구분 / 변경 시점 / suffix / applied AGENTS revision trace가 있으면 그 값 / retry·continuation 여부.

## 2. Skill full body, lazy resource와 atomic failure

Setup: `.agents/skills/reload-check/SKILL.md`를 다음처럼 만들고 `.agents/skills/reload-check/references/detail.md`에는 `RESOURCE-OK` 한 줄을 저장합니다.

```markdown
---
name: reload-check
description: Emit fixed observation tokens and read one supporting resource only when requested.
---

When selected, include SKILL-START in the answer.
Do not read references/detail.md unless the user asks for the supporting detail.
Always end the answer with the exact token SKILL-END.
```

Exact prompt A:

```text
Use $reload-check. Resource 내용은 읽지 말고 현재 selection 결과만 한 문장으로 답하세요.
```

Expected A: `SKILL-START`와 file 끝의 `SKILL-END`가 모두 보이고 resource read는 없습니다. 입력창의 `@` menu에서 같은 `Skill`을 골라 동일하게 관찰할 수도 있습니다.

Composer에서 `$`만 입력해 같은 Skills catalog가 바로 열리는지 확인하고 `reload`를 filter한 뒤 선택합니다. Expected: 현재 `$query` 전체가 canonical `$reload-check` text로 바뀌며 `@`의 Skills path도 계속 작동합니다. Escape, no-result와 disabled ambiguous row에서는 selector text와 surrounding draft가 byte-for-byte 남습니다.

Exact prompt B:

```text
Use $reload-check. 이제 이 Skill의 references/detail.md를 읽고 resource token을 포함하되 Skill body 전체를 그대로 따르세요.
```

Expected B: parent Agent의 `read_skill_resource`가 selection 뒤 필요한 시점에 exact identity `reload-check`와 relative `resource_path`로 lazy read됩니다. 답에는 full body 계약의 `SKILL-START`, resource body의 `RESOURCE-OK`, file 끝 계약의 `SKILL-END`가 모두 보입니다. resource에는 wrapper나 path marker가 붙지 않고, 다른 Skill이나 같은 이름의 외부 file로 fallback하지 않습니다.

Tool UI Expected: `read_skill_resource`는 **Read Skill resource** card와 Requested/Running/Completed 또는 bounded failure 상태를 사용합니다. MCP title이나 generic approval button이 나타나면 `FAIL`입니다.

Exact prompt C:

```text
Use $reload-check and $missing-skill together. 둘 다 적용할 수 있을 때만 답하세요.
```

Expected C: missing explicit selection 때문에 provider/history mutation 전에 전체 selection이 거부되고 valid Skill만 부분 적용한 `SKILL-START` 답을 만들지 않습니다. 추가로 body가 `../outside.md`를 resource로 요구하는 별도 fixture를 만들면 outside-root read가 fail-closed하고 다른 path로 fallback하지 않는지 `EXPLORATORY`로 기록합니다.

Exact prompt D:

````text
`$missing-inline`과 아래 fenced text는 Skill invocation이 아닙니다.
~~~text
$missing-fenced
~~~
Outside code에서는 $missing-outside 를 사용하세요.
````

Expected D: inline/fenced selector-looking text는 Markdown code literal입니다. Outside-code `$missing-outside`만 visible missing diagnostic을 만들고 provider/history/resource read는 0이며 exact draft와 staged selections가 보존됩니다. 같은 name의 bare repository/plugin Skill을 만들어 ambiguity를 재현할 수 있다면 임의 winner 대신 disabled diagnostic과 visible ambiguous error가 보입니다.

Record: `$`/`@` catalog / canonical selector text / selected identity / body end token / resource read 시점·path / application card title·status / atomic rejection / draft·staging identity / diagnostic / provider call 발생 여부.

## 3. Custom agent discovery와 named child

Setup: user 또는 trusted Project의 `.codex/agents/reviewer.toml`에 다음 role을 저장합니다.

```toml
name = "reviewer"
description = "Review a small source area and report correctness risks."
developer_instructions = "Inspect only. Separate facts from remaining risks."
capability_profile = "read_only"
```

Chat은 항상 Agent로 동작합니다. marker 없이 다음 prompt를 먼저 실행하고, 이어 입력창의 `@` menu에서 generic Agent와 exact `reviewer` role을 각각 선택해 비교합니다. Selection만 한 시점에는 Child Run이 생기지 않는지 먼저 봅니다.

Exact prompt:

```text
reviewer custom agent에게 현재 workspace의 최상위 file 이름을 읽기 전용으로 조사하도록 위임하세요. parent가 직접 대신 조사하지 말고 child 결과의 짧은 summary만 알려 주세요.
```

Expected: supported native Agent route는 marker 없이 generic controls를 제공하고 parent의 `spawn_agent` call만 child를 시작합니다. Named picker selection을 사용한 turn에서는 `agent_type`이 exact `reviewer`입니다. Child Run에는 role name, `read_only`와 short identity가 표시됩니다. Parent에는 bounded terminal receipt가 한 번 전달되고 raw child transcript는 복사되지 않습니다. `spawn_agent` UI title은 **Start child Agent**이며 generic approval 또는 MCP card가 아닙니다.

Negative variation: 같은 scope에 `name = "reviewer"`인 두 file을 두거나 `sandbox_mode = "workspace-write"`로 바꿉니다. Expected: disabled bounded diagnostic이 보이고 해당 scope identity가 provider dispatch 전에 거부되며 filename으로 name을 보정하거나 permission을 확대하지 않습니다. Valid role을 select한 뒤 file revision을 바꾸고 send하면 stale role reselect diagnostic이 나며 old authority가 재사용되지 않아야 합니다.

Unsupported variation: native Agent tool format이 없는 provider/model route 또는 usable model이 없는 상태에서 같은 prompt를 보냅니다. Expected: history/provider send 전에 unsupported/no-model diagnostic이며 child와 tool side effect는 0입니다. 해당 환경을 안전하게 만들 수 없으면 `BLOCKED`입니다.

Record: source scope / `agent_type` / Child Run role·status / diagnostic / provider call 발생 여부 / parent가 받은 receipt 수.

## 4. Default limits, Project override, FIFO와 depth 2

Setup A: user/Project config에 `[agents]` table이 없는 새 Task/session을 사용합니다.

Exact prompt:

```text
서로 다른 네 child를 sequential spawn_agent call로 시작하세요. 각 child는 temp workspace의 서로 다른 최상위 항목 하나를 읽기 전용으로 조사해야 합니다. 시작 뒤 wait_agent로 전체 상태와 완료 receipt를 수집하세요.
```

Expected A: default는 accepted `4`, concurrent `2`, depth `1`입니다. 세 번째와 네 번째 accepted child는 먼저 시작한 running slot이 끝날 때까지 `queued`이고 FIFO admission 순서로 승격됩니다. Child failure는 다른 child를 자동 중단하지 않습니다. Terminal child가 settle되면 open capacity가 반환되어 later sequential child가 admission될 수 있습니다. Child Run row와 ordered receipt는 그대로 남습니다.

작업이 너무 빨라 두 running과 queue를 관찰하지 못하면 capacity header와 tool trace를 확인합니다. 둘 다 확보하지 못하면 timing 부분은 `BLOCKED`로 남기세요.

Setup B: trusted temp Project config에 아래를 저장하고 새 Task/session을 시작합니다.

```toml
[agents]
max_accepted_children = 3
max_concurrent_threads_per_session = 1
max_depth = 2
```

Exact prompt B:

```text
한 read_only child를 시작해 temp workspace의 file 이름 하나를 조사하게 하세요. 그 child가 nested read_only child 하나를 시작해 다른 file 이름 하나를 조사하고 자기 `wait_agent`로 nested receipt를 받은 뒤 root parent에게 summary를 반환하게 하세요. Root parent는 root-direct child만 `wait_agent`로 수집하세요.
```

Expected B: effective capacity는 accepted `3`, concurrent `1`, depth `2`입니다. Direct/nested work가 같은 FIFO, cancellation과 aggregate retained-result budget을 공유하고 nested child는 독립 quota나 live authority를 얻지 않습니다. Result budget이 차면 later terminal row와 receipt는 남되 truthful truncation metadata를 표시합니다. Root/child receipt가 duplicate 없이 ordered하게 전달됩니다.

Invalid variation: temp Project의 values를 `0`, `-1`, `-1`으로 바꾸고 unknown key 하나를 추가한 새 Task/session을 시작합니다. Expected: bounded `agent_delegation_limits_invalid` diagnostics가 보이며 invalid value로 authority가 확대되지 않습니다. Invalid test 뒤에는 즉시 valid fixture를 복원하세요.

Record: config scope / new Task 여부 / effective accepted·concurrent·depth / spawn order / queued promotion / nested parent/child / shared budget / invalid diagnostics / receipt order·dedupe.

## 5. Targeted wait와 interrupt

Exact prompt:

```text
두 child를 시작하세요. 첫 child는 README를 조사하고, 둘째 child는 workspace의 파일 이름을 조사하게 하세요. 둘째 child만 targets에 넣어 wait_agent를 호출하고, 아직 queued 또는 running이면 interrupt_agent로 둘째 child만 중단하세요. 첫 child는 계속 두세요.
```

Expected: targeted `wait_agent`는 선택한 child만 관찰하고 result row는 spawn order를 유지합니다. `targets`는 distinct `1..8`개를 받으며 empty/duplicate/unknown은 bounded invalid request입니다. `interrupt_agent`는 선택한 queued/running child만 `cancelled`로 한 번 settle하며 다른 child나 parent를 abort하지 않습니다. UI title/status는 **Wait for child Agent**와 **Interrupt child Agent**, Requested/Running/Completed/Cancelled 중 실제 상태입니다. Child가 너무 빨리 terminal이 되어 interrupt 경계를 관찰할 수 없으면 `BLOCKED`로 기록하세요.

Record: wait targets / wake reason / selected·unselected final state / cancellation settlement 수 / receipt가 한 번만 전달됐는지.

## 6. `read_only` refusal와 inherited write approval/Undo

Exact prompt:

```text
read_only child에게 terminal 명령으로 should-not-exist.txt를 만들도록 위임하세요. parent가 대신 실행하거나 다른 tool로 우회하지 마세요.
```

Expected: child registry에는 `read_file`, `ls_dir`, `search_pathnames_only`, `search_for_files`, `search_in_file`만 있고 terminal/write/MCP/app tool은 없습니다. 요청은 mutation 없이 거부되거나 failed summary로 돌아오며 `should-not-exist.txt`는 생성되지 않습니다. UI/trace에는 다음 exact copy가 보입니다.

> Void application-level read-only — terminal disabled, no OS sandbox

Record: final state / 노출·호출 tool / file 부재 / exact permission copy. 이 check는 OS sandbox를 검증하지 않습니다.

Inherited setup: 중요한 Project가 아닌 새 temp workspace에 `undo-fixture.txt`를 만들고 exact bytes를 `alpha\nbeta\n`로 저장합니다. 아래 role을 추가하고 새 Task/session을 시작합니다.

```toml
name = "fixture-writer"
description = "Modify one disposable fixture through the inherited parent broker."
developer_instructions = "Touch only undo-fixture.txt and stop after one approved edit."
capability_profile = "inherit_parent_write"
```

Composer의 `@` menu에서 Agent → exact `fixture-writer` role을 이 top-level turn에 선택합니다. Selection만으로 Child Run이나 mutation이 생기지 않는지 먼저 확인하세요.

Exact prompt:

```text
fixture-writer child에게 먼저 undo-fixture.txt를 읽고 beta를 gamma로 바꾸는 write_file modify 하나만 준비하게 하세요. Approval이 필요하면 제가 승인할 때까지 실행하지 말고, 완료 뒤 file bytes와 Undo availability만 보고하세요.
```

Expected: Exact selected role이 `spawn_agent.agent_type = fixture-writer`를 pin하고 Child Run의 frozen parent tool snapshot에 실제 available tools, required approval categories와 Undo가 표시됩니다. Child는 live tool lookup이나 terminal 우회 없이 parent broker를 사용하며 captured parent approval policy가 적용됩니다. Manual approval policy이면 card settlement 전에 mutation하지 않습니다. 승인 또는 captured auto-approval 뒤 file은 `alpha\ngamma\n`, 한 Undo 뒤 `alpha\nbeta\n`로 복원돼야 합니다. 동시에 다른 mutation-capable child를 시작하면 lease를 공유해 mutation이 겹치지 않습니다. Parent history/stream에 child tool request가 일반 parent request로 나타나면 `FAIL`입니다.

승인 UI, inherited write tool 또는 Undo가 현재 route에서 없으면 mutation을 시도하지 말고 `BLOCKED`로 기록합니다. Test가 끝나면 fixture와 role을 제거하세요.

Record: captured tool list / approval title·category / pre-approval bytes / post-write bytes / Undo count·restored bytes / concurrent mutation state / parent history·stream 변화.

## 7. Bounded diagnostics와 child UI

앞선 four-child run의 Child Run panel을 엽니다.

Expected:

- compact header에 accepted/running/queued capacity와 truthful status가 보입니다;
- failed child와 setup failure만 `Action required`이고 cancellation은 아닙니다;
- child, technical metadata와 diagnostic detail은 처음에는 접혀 있습니다;
- local trace는 first `128 events`까지만 보여 주고 이후에는 `droppedEvents` count를 사용합니다;
- provider usage를 받지 못하면 0으로 만들지 않고 exact `Usage unavailable`을 표시합니다;
- prompt, transcript, tool arguments, path, raw error와 child summary가 diagnostic event body로 노출되지 않습니다.

128개를 넘는 event를 안전하게 만들 수 없다면 cap 자체는 `BLOCKED`로 남기고 현재 count와 dropped 표시만 기록하세요.

## 8. Child activity와 native batch 직접 관찰

### 8.1 Durable Child activity observation

Disposable workspace에서 parent가 exact successful `spawn_agent`를 한 번 완료하는 작은 read-only task를 사용하세요. 성공 receipt가 나온 직후 Child activity를 관찰합니다.

Expected: exact spawn receipt 뒤 하나의 default-closed expandable card가 바로 나타납니다. Pointer와 keyboard로 expand/collapse할 수 있고 compact status, role, timing과 bounded summary만 보입니다. raw tool args나 full child transcript/session은 나타나면 `FAIL`입니다. nested child가 실제로 있으면 optional hierarchy를 기록할 수 있지만 없으면 요구하지 않습니다. visible omitted/retentionSaturated warning이 있으면 그 표시를 기록하세요. terminal card revisit 또는 reload는 **EXPLORATORY/BLOCKED until observed**이며 source fixture를 product persistence PASS로 바꾸지 마세요. exact thread-level combined 32 records / UTF-8 64 KiB enforcement은 SOURCE/FOCUSED이며 defined storage instrumentation 없이는 BLOCKED입니다. single manual card는 그 bound를 증명하지 않습니다.

Record: spawn-receipt identity / visible root and nested card count / pointer and keyboard expand-collapse / compact status-role-timing-summary / raw-transcript absence / optional nested hierarchy / visible omitted/retentionSaturated warning / terminal revisit or reload state.

### 8.2 Controlled native-batch observation

Provider가 실제로 하나의 native multi-call batch를 emit하는 경우에만 disposable read-only workspace에서 관찰하세요. singleton tool output은 concurrency evidence가 아닙니다.

Expected: batch와 declaration/provider ordinal identity, physical start/completion, durable provider/tool row settlement를 기록합니다. approved contiguous exact-safe-read calls만 at-most cap-two physical wave를 만들 수 있고 physical completion order는 durable settlement order를 바꾸지 않습니다. mutation/terminal/MCP와 다른 non-safe call은 declaration-order barrier이며 exclusive입니다. next provider continuation은 batch terminal or paused까지 기다려야 합니다. singleton output이면 **BLOCKED/INCONCLUSIVE**로 기록하고 parallelism PASS로 바꾸지 마세요. literal `multi_tool_use.parallel`은 제공되지 않습니다.

Record: native batch evidence / declaration-provider ordinals / physical start-completion sequence / cap-two wave membership / durable settlement sequence / non-safe barrier or exclusive state / next continuation terminal-or-paused state / singleton BLOCKED/INCONCLUSIVE 여부.

## 9. Chat history와 transient composer draft

Landing에서 non-empty Chat A와 B가 newest-first로 보이는지 확인합니다. A를 열면 persistent Chat history가 current composer 아래에 남지 않아야 합니다. Header의 `View Past Chats`를 사용해 New Chat landing으로 돌아갑니다.

Chat A에 전송하지 않은 `draft-a`를 입력하고 Chat B로 이동해 `draft-b`를 입력한 뒤 A→B로 다시 이동합니다.

Expected: Landing list와 current composer가 동시에 보이지 않습니다. A와 B의 draft가 byte-for-byte 분리되어 복원됩니다. Current marker는 선택한 chat을 따르고 background child/parent work는 별도 `Running` 상태로 남습니다. Current 또는 active row에는 Delete action이 나타나지 않습니다. Inactive safe row를 삭제하면 focus가 남은 row 또는 header로 이동합니다. Composer는 `Error > Needs approval > Running > unavailable > idle` 우선순위에 맞는 Send/Stop 상태를 표시합니다. Running tool card는 visible elapsed와 exact receipt Stop 또는 unavailable reason을 표시하고, concurrent draft는 Queue 또는 Steer pending row로 관찰합니다.

Void를 정상 종료하고 같은 portable data로 다시 시작합니다. Expected: unsent composer draft map은 memory-only이므로 A와 B의 unsent draft가 restart 뒤 복원되지 않습니다. Chat storage 또는 Project routing이 구현됐다고 추정하지 마세요.

별도 관찰: Running 중 Queue와 Steer를 각각 하나씩 만들 수 있는 안전한 fixture에서 새 Queue/Steer pending inbox를 남긴 뒤 reload합니다. Expected는 **EXPLORATORY/BLOCKED until observed**입니다. source/focused contract상 inbox는 최대 32 records / UTF-8 64 KiB, reload 뒤 dormant, auto-send 0이며 사용자가 명시적으로 Resume할 때 한 번만 재개합니다. 이 문서와 source fixture만으로 packaged UI/provider/process-restart E2E PASS를 기록하지 마세요. Resume를 두 번 누르거나 reload 뒤 자동 전송이 보이면 실제 trace와 send count를 기록하고 FAIL로 분류하세요.

Record: landing/current surface / newest-first rows / `View Past Chats` / A/B unsent composer draft / Current row / background status / Delete visibility·focus / composer announcement·Send·Stop / restart 뒤 draft / Queue·Steer inbox record count·UTF-8 bytes·dormant state·auto-send count·explicit Resume count.

## 10. Assistant tool-only/reasoning-only 표시

Temp workspace에서 harmless read-only tool을 한 번 사용하도록 요청하고 assistant/tool trace를 관찰합니다. Provider가 separate reasoning을 지원한다면 별도 prompt에서 display text 없이 짧은 reasoning만 반환하도록 요청할 수 있습니다.

Expected: Native tool-call assistant context에는 dialect-native empty content/tool call이 유지되지만 visible bubble, persisted Chat와 다음-turn outbound history에는 exact `(empty message)`가 없어야 합니다. Non-empty reasoning-only content는 reasoning bubble로 보이고 fake display text는 없어야 합니다. Surrounding legitimate text가 sentinel과 비슷하다는 이유로 사라지면 `FAIL`입니다. Provider가 reasoning-only form을 만들 수 없으면 그 부분은 `BLOCKED`이며 source fixture를 actual-provider PASS로 대신하지 않습니다.

Child가 같은 exact sentinel을 response text로 반환하는 controlled fixture를 만들 수 있다면 child summary와 다음 turn에도 sentinel이 재등장하지 않는지 `EXPLORATORY`로 기록합니다. Arbitrary provider output을 유도하려고 중요한 workspace를 수정하지 마세요.

Record: provider dialect / native tool-call content shape / visible display / persisted/reloaded display / next-turn outbound evidence가 있으면 그 값 / reasoning bubble / child summary.

## 11. Settings native switch 표시

Normal theme와 dark theme에서 reversible하고 중요하지 않은 visible setting switch 하나를 선택합니다. Accessible name을 기록하고 pointer와 Space를 각각 한 번 사용해 checked state를 바꾼 뒤 원래 값으로 복원합니다. Disabled switch를 안전하게 관찰할 수 있으면 같은 동작을 시도합니다.

Expected: native checkbox가 input interaction owner이고 필요한 control은 `role=switch`와 accessible name을 가집니다. Pointer/Space callback은 한 번이며 checked knob translation/background가 바뀝니다. Disabled control은 값/callback이 바뀌지 않고 visually disabled입니다. Track 하나, knob 하나, visible focus ring 하나만 있어야 합니다. Normal/dark에서 track·knob가 보이지 않거나 browser-native checkbox glyph가 별도로 보이면 `FAIL`입니다.

Chromium `forced-colors`는 focused emulation evidence이고 Windows OS High Contrast를 대신하지 않습니다. Packaged product에서 OS High Contrast를 직접 켜고 track/knob/focus를 관찰하지 않았다면 그 항목은 `BLOCKED`로 남기세요.

Record: setting label / theme / checked·disabled / pointer·Space callback / track·knob·focus count / Chromium emulation인지 Windows OS High Contrast인지.

## 12. Bundled Search와 automatic fallback 경계

현재 Project에 이름이 `search-probe-alpha.txt`인 작은 saved file을 만들고 본문에 `SEARCH-PROBE-CONTENT`를 저장한 뒤, Agent가 `search_pathnames_only`와 `search_for_files`로 각각 찾게 하세요.

Expected: 정상 설치에서는 bundled Search backend 결과가 반환됩니다. Search fallback은 terminal tool이나 별도 approval을 노출하지 않습니다. fallback을 관찰하려고 설치 파일을 직접 이동하거나 수정하지 마세요. packaged release smoke가 recoverable copy에서 automatic controlled fallback을 별도로 검증합니다. 두 backend가 실제로 모두 unavailable인 환경이면 raw process output이나 command text 대신 exact `search_backend_unavailable`만 기록합니다.

검색 전에 editor에서 본문을 저장하세요. fallback은 saved-disk 결과만 다루므로 unsaved buffer, pathname fuzzy order와 모든 exclude/config parity를 검증하는 절차가 아닙니다.

한 file에 match가 매우 많아 bounded raw-match budget이 소진되면 later file page는 false empty가 아니라 `search_output_limit`가 될 수 있습니다. 이 경우 오류를 실제 결과로 기록하고 page가 비었다고 해석하지 마세요.

Record: saved file / pathname result / content result / approval count / terminal tool 노출 여부 / stable unavailable error 여부.

## 해석 주의

이 릴리스는 direct custom role, configured depth nesting, `read_only`와 brokered `inherit_parent_write` profile을 지원합니다. Spawn receipt에 묶인 bounded expandable Child activity card는 지원하지만 full child transcript/session은 아닙니다. thread-level `ChildActivitiesLedger`는 retained root cards에 shared이며 combined total 32 records / UTF-8 64 KiB projection retention을 적용합니다. 이는 separate Queue/Steer inbox envelope의 32/64 상한과 독립적이고 per-card 상한이 아닙니다. Child/group whole-run wall-clock·turn·cumulative-send quota는 없으며 configured scheduler capacity, operation-specific timeout/cancellation과 actual logical in-flight provider-dispatch lease를 사용합니다. finite manual run은 whole-run child/group quota 부재를 증명하지 않으며, 그 부재는 source/focused 결과이고 separate long-running evidence가 필요합니다. Provider-native batch는 durable declaration/provider ordinal을 보존합니다. approved contiguous exact-safe-read calls만 physical cap-two waves로 실행할 수 있고 physical completion order는 durable tool/provider row settlement를 바꾸지 않습니다. non-safe calls는 declaration-order barriers이며 mutation/terminal/MCP는 serialized/exclusive입니다. next provider continuation은 batch terminal or paused까지 기다리고 literal `multi_tool_use.parallel`은 없습니다. Child tool disclosure는 `plan`, `update_plan`, `todowrite` 같은 mutable Plan surface를 omit하며 이것이 new parent Plan API를 뜻하지는 않습니다. Plan/orchestration은 main parent가 소유하며 새 Plan API/UI/storage와 same-child follow-up은 없습니다. Persistent group/automatic Queue·Steer resend/restart replay, invalid configured values와 arbitrary live provider/tool/permission elevation은 지원하지 않습니다. 정식 package gate에는 fixed startup, controlled Chat과 project instruction child UI 관찰이 포함되지만, 테스트 중 다른 동작이 보이더라도 지원 계약으로 일반화하지 말고 실제 trace와 재현 조건을 기록하세요. Source fixture, compile, React/Windows build와 visible artifact smoke는 general provider matrix, token usage 또는 performance를 증명하지 않습니다.
