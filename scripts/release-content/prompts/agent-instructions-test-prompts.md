# Agent instructions, Skills, custom agents와 bounded subagent 직접 테스트 프롬프트

모든 항목은 실제 제품 관찰용입니다. 예상 결과를 미리 PASS로 기록하지 마세요. 별도 임시 workspace와 Agent mode를 사용하고 `PASS`/`FAIL`/`BLOCKED`/`EXPLORATORY`, provider/model, top-level turn, selector, bounded tool trace, Child Run·Chat UI와 실제 file state를 함께 기록하세요. Source fixture, build와 artifact smoke는 actual provider/network E2E를 대체하지 않습니다.

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

Exact prompt B:

```text
Use $reload-check. 이제 이 Skill의 references/detail.md를 읽고 resource token을 포함하되 Skill body 전체를 그대로 따르세요.
```

Expected B: parent Agent의 `read_skill_resource`가 selection 뒤 필요한 시점에 exact identity `reload-check`와 relative `resource_path`로 lazy read됩니다. 답에는 full body 계약의 `SKILL-START`, resource body의 `RESOURCE-OK`, file 끝 계약의 `SKILL-END`가 모두 보입니다. resource에는 wrapper나 path marker가 붙지 않고, 다른 Skill이나 같은 이름의 외부 file로 fallback하지 않습니다.

Exact prompt C:

```text
Use $reload-check and $missing-skill together. 둘 다 적용할 수 있을 때만 답하세요.
```

Expected C: missing explicit selection 때문에 provider/history mutation 전에 전체 selection이 거부되고 valid Skill만 부분 적용한 `SKILL-START` 답을 만들지 않습니다. 추가로 body가 `../outside.md`를 resource로 요구하는 별도 fixture를 만들면 outside-root read가 fail-closed하고 다른 path로 fallback하지 않는지 `EXPLORATORY`로 기록합니다.

Record: selected identity / body end token / resource read 시점·path / atomic rejection / diagnostic / provider call 발생 여부.

## 3. Custom agent discovery와 named child

Setup: user 또는 trusted Project의 `.codex/agents/reviewer.toml`에 다음 role을 저장합니다.

```toml
name = "reviewer"
description = "Review a small source area and report correctness risks."
developer_instructions = "Inspect only. Separate facts from remaining risks."
sandbox_mode = "read-only"
```

Agent mode에서 입력창의 `@` menu를 열고 `Agent`를 선택합니다. Marker만 선택한 시점에는 Child Run이 생기지 않는지 먼저 봅니다.

Exact prompt:

```text
@Agent reviewer custom agent에게 현재 workspace의 최상위 file 이름을 읽기 전용으로 조사하도록 위임하세요. parent가 직접 대신 조사하지 말고 child 결과의 짧은 summary만 알려 주세요.
```

Expected: inert `@Agent` marker 자체가 아니라 parent의 `spawn_agent` call이 child를 시작하고 `agent_type`은 exact `reviewer`입니다. Child Run에는 role name과 short identity가 표시됩니다. Parent에는 bounded terminal receipt가 한 번 전달되고 raw child transcript는 복사되지 않습니다.

Negative variation: 같은 scope에 `name = "reviewer"`인 두 file을 두거나 `sandbox_mode = "workspace-write"`로 바꿉니다. Expected: 해당 scope identity가 provider dispatch 전에 거부되며 filename으로 name을 보정하거나 write permission으로 확대하지 않습니다.

Record: source scope / `agent_type` / Child Run role·status / diagnostic / provider call 발생 여부 / parent가 받은 receipt 수.

## 4. Four accepted, two running과 FIFO

Exact prompt:

```text
@Agent 서로 다른 네 direct child를 sequential spawn_agent call로 시작하세요. 각 child는 workspace의 서로 다른 최상위 항목 하나를 읽기 전용으로 조사해야 합니다. 네 child를 합치지 말고, 시작 뒤 wait_agent로 전체 상태와 완료 receipt를 수집하세요.
```

Expected: 한 parent generation에서 최대 `4 accepted`, 동시에 최대 `2 running`입니다. 세 번째와 네 번째 accepted child는 먼저 시작한 running slot이 끝날 때까지 `queued`이고 FIFO admission 순서로 승격됩니다. Child failure는 다른 child를 자동 중단하지 않습니다. Terminal child도 accepted quota를 반환하지 않으므로 다섯 번째 spawn 시도는 같은 generation에서 거부됩니다.

작업이 너무 빨라 두 running과 queue를 관찰하지 못하면 capacity header와 tool trace를 확인합니다. 둘 다 확보하지 못하면 timing 부분은 `BLOCKED`로 남기세요.

Record: spawn order / accepted·running·queued count / promotion order / fifth admission result / receipt order / duplicate receipt 여부.

## 5. Targeted wait와 interrupt

Exact prompt:

```text
@Agent 두 direct child를 시작하세요. 첫 child는 README를 조사하고, 둘째 child는 workspace의 파일 이름을 조사하게 하세요. 둘째 child만 targets에 넣어 wait_agent를 호출하고, 아직 queued 또는 running이면 interrupt_agent로 둘째 child만 중단하세요. 첫 child는 계속 두세요.
```

Expected: targeted `wait_agent`는 선택한 direct child만 관찰하고 result row는 spawn order를 유지합니다. `interrupt_agent`는 선택한 queued/running child만 `cancelled`로 한 번 settle하며 다른 child나 parent를 abort하지 않습니다. Child가 너무 빨리 terminal이 되어 interrupt 경계를 관찰할 수 없으면 `BLOCKED`로 기록하세요.

Record: wait targets / wake reason / selected·unselected final state / cancellation settlement 수 / receipt가 한 번만 전달됐는지.

## 6. Read-only refusal

Exact prompt:

```text
@Agent child에게 terminal 명령으로 should-not-exist.txt를 만들도록 위임하세요. parent가 대신 실행하거나 다른 tool로 우회하지 마세요.
```

Expected: child registry에는 `read_file`, `ls_dir`, `search_pathnames_only`, `search_for_files`, `search_in_file`만 있고 terminal/write/MCP/app tool은 없습니다. 요청은 mutation 없이 거부되거나 failed summary로 돌아오며 `should-not-exist.txt`는 생성되지 않습니다. UI/trace에는 다음 exact copy가 보입니다.

> Void application-level read-only — terminal disabled, no OS sandbox

Record: final state / 노출·호출 tool / file 부재 / exact permission copy. 이 check는 OS sandbox를 검증하지 않습니다.

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

## 8. Chat history와 transient composer draft

Chat A에 전송하지 않은 `draft-a`를 입력하고 Chat B로 이동해 `draft-b`를 입력한 뒤 A→B로 다시 이동합니다.

Expected: A와 B의 draft가 byte-for-byte 분리되어 복원됩니다. Current marker는 선택한 chat을 따르고 background child/parent work는 별도 `Running` 상태로 남습니다. Current 또는 active row에는 Delete action이 나타나지 않습니다. Composer는 `Error > Needs approval > Running > unavailable > idle` 우선순위에 맞는 Send/Stop 상태를 표시합니다.

Void를 정상 종료하고 같은 portable data로 다시 시작합니다. Expected: draft map은 memory-only이므로 A와 B의 unsent draft가 restart 뒤 복원되지 않습니다. Chat storage 또는 Project routing이 구현됐다고 추정하지 마세요.

Record: A/B draft / Current row / background status / Delete visibility / composer announcement·Send·Stop / restart 뒤 draft.

## 9. Bundled Search와 automatic fallback 경계

현재 Project에 이름이 `search-probe-alpha.txt`인 작은 saved file을 만들고 본문에 `SEARCH-PROBE-CONTENT`를 저장한 뒤, Agent가 `search_pathnames_only`와 `search_for_files`로 각각 찾게 하세요.

Expected: 정상 설치에서는 bundled Search backend 결과가 반환됩니다. Search fallback은 terminal tool이나 별도 approval을 노출하지 않습니다. fallback을 관찰하려고 설치 파일을 직접 이동하거나 수정하지 마세요. packaged release smoke가 recoverable copy에서 automatic controlled fallback을 별도로 검증합니다. 두 backend가 실제로 모두 unavailable인 환경이면 raw process output이나 command text 대신 exact `search_backend_unavailable`만 기록합니다.

검색 전에 editor에서 본문을 저장하세요. fallback은 saved-disk 결과만 다루므로 unsaved buffer, pathname fuzzy order와 모든 exclude/config parity를 검증하는 절차가 아닙니다.

한 file에 match가 매우 많아 bounded raw-match budget이 소진되면 later file page는 false empty가 아니라 `search_output_limit`가 될 수 있습니다. 이 경우 오류를 실제 결과로 기록하고 page가 비었다고 해석하지 마세요.

Record: saved file / pathname result / content result / approval count / terminal tool 노출 여부 / stable unavailable error 여부.

## 해석 주의

이 릴리스는 direct custom role과 bounded parallel direct children을 지원하지만 nested child, persistent group/restart replay, full child transcript history, arbitrary provider/MCP/terminal/write permission override와 plugin-local custom agent는 지원하지 않습니다. 테스트 중 다른 동작이 보이더라도 지원 계약으로 일반화하지 말고 실제 trace와 재현 조건을 기록하세요. Source fixture, compile, React/Windows build와 visible artifact smoke는 actual provider request, token usage 또는 performance를 증명하지 않습니다.
