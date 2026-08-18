# Agent instructions, Skills, custom agents와 profile-aware bounded subagent 안내

이 안내서는 현재 릴리스의 Agent mode에 포함된 instruction, Skills, custom role, configurable child limits와 capability profile을 설명합니다. Source와 focused tests에서 확인한 계약을 실제 provider/network에서 이미 통과한 결과로 확대하지 마세요. 동봉 prompt는 현재 환경에서 UI와 tool trace를 직접 관찰하기 위한 절차입니다.

## `AGENTS.md`: owner root, CWD와 turn revision

한 Run은 active owner Project 하나와 CWD 하나를 사용합니다. 현재 Agent mode의 CWD는 owner workspace folder root이며 active file이나 tool target 때문에 자동 이동하지 않습니다. resolver는 owner root부터 CWD까지 각 level의 non-empty UTF-8 `AGENTS.md` 내용을 root→CWD 순서로 append합니다. 가까운 directory의 내용이 뒤에 오므로 의미상 나중 지침이 우선합니다. 현재 일반적인 root=CWD Run에서는 root의 `AGENTS.md` 하나가 적용됩니다.

combined project instruction의 기본 한도는 32 KiB입니다. `project_doc_max_bytes`로 한도를 설정할 수 있지만 허용된 전체 bytes를 넘은 내용을 무제한으로 주입하지 않습니다.

AGENTS chain은 각 top-level user turn 시작에 disk에서 다시 읽습니다. 같은 turn의 retry, tool continuation과 그 turn에서 시작한 child는 이미 캡처한 same-turn immutable revision을 사용합니다. turn 도중 `AGENTS.md`를 바꾸면 현재 turn을 바꾸지 않고 다음 top-level user turn부터 반영됩니다.

현재 discovery는 `AGENTS.md` only입니다. 다음 항목은 지원하지 않으며 alias나 migration source로도 읽지 않습니다.

- `AGENTS.override.md`
- configured fallback filename (`project_doc_fallback_filenames`)
- `.voidrules`의 자동 migration, fallback 또는 alias

## user와 trusted Project config

추가 developer 지침은 다음 두 위치의 TOML을 사용합니다.

- user: `$HOME/.codex/config.toml`
- trusted Project: `<root>/.codex/config.toml`

Instruction 설정은 `developer_instructions`와 `project_doc_max_bytes`를 지원합니다. User 값을 먼저 읽고 trusted Project가 같은 allowlisted key를 제공하면 Project 값이 우선합니다. Untrusted Project의 config는 Project authority로 적용하지 않습니다.

```toml
developer_instructions = """
변경 전에 현재 파일을 읽고 결과를 짧게 요약하세요.
"""
project_doc_max_bytes = 32768
```

같은 config의 `[agents]` table은 child limit을 설정합니다.

```toml
[agents]
max_accepted_children = 4
max_concurrent_threads_per_session = 2
max_depth = 1
```

- `max_accepted_children`: `1..8`, default `4`
- `max_concurrent_threads_per_session`: `1..4`이면서 accepted 이하, default `2`
- `max_depth`: `1..2`, default `1`

각 key는 user 값 뒤 trusted Project 값이 override합니다. Invalid integer/range, unknown `[agents]` key와 concurrent가 accepted를 넘는 조합은 bounded `agent_delegation_limits_invalid` diagnostic을 남기며 더 큰 authority로 보정하지 않습니다. Valid lower-precedence 값 또는 default가 유지되고 concurrent는 effective accepted를 넘지 않습니다. Config 변경을 확실히 적용하려면 새 Task/session을 시작하세요.

config는 Task/session 시작에 resolve되어 그 Task에서 유지됩니다. config 변경을 확실히 적용하려면 새 Task/session을 시작하세요. 반면 `AGENTS.md`는 앞 절처럼 top-level user turn마다 reload됩니다. model-visible logical authority와 조합 순서는 `developer_instructions → AGENTS.md`입니다. provider wire role은 adapter capability에 따라 달라집니다. developer role을 지원하는 OpenAI-compatible Chat 경로에서는 developer message를 사용하고, 다른 adapter는 system role, 분리된 system field 또는 보호된 fallback 경로를 사용할 수 있습니다. wire 형식이 달라도 이 logical order는 바뀌지 않습니다.

Skill enable/disable 규칙은 같은 두 config 위치의 `[[skills.config]]`에 별도로 둡니다. 각 rule은 `name` 또는 `path` 중 정확히 하나와 boolean `enabled`만 가져야 합니다. `name`은 catalog의 exact Skill identity이고, `path`는 해당 `SKILL.md`로 끝나는 OS absolute path여야 합니다.

```toml
[[skills.config]]
name = "review-check"
enabled = false

[[skills.config]]
name = "review-check"
enabled = true
```

rule은 user config 순서 뒤에 trusted Project config 순서로 적용되며 같은 Skill에 마지막으로 match한 rule이 이깁니다. 위 예에서는 최종적으로 enabled입니다. `name`과 `path`를 함께 쓰거나 둘 다 생략한 rule, boolean이 아닌 `enabled`, unknown field와 유효하지 않은 absolute `SKILL.md` path는 적용하지 않고 `skill_config_invalid` diagnostic을 남깁니다. TOML 전체가 malformed이거나 strict UTF-8이 아니면 그 config source의 allowlisted projection을 적용하지 않습니다. 유효하지 않은 rule을 임의로 보정하거나 다른 Skill에 fallback하지 않습니다. untrusted Project에서는 Project rules와 그 diagnostics를 적용하지 않고 user rules만 유지합니다.

## Skills authoring과 선택

현재 지원하는 authoring source는 다음과 같습니다.

- repository: `<root>/.agents/skills/<name>/SKILL.md`
- user: `$HOME/.agents/skills/<name>/SKILL.md`
- enabled Codex-compatible plugin:
  - `<plugin-root>/.codex-plugin/plugin.json` marker
  - 그 marker와 같은 plugin root의 `./skills/<name>/SKILL.md`

현재 bundle은 shipped bundled Skills가 있다고 주장하지 않습니다. `.codex/skills`도 repository Skill 위치로 사용하지 않습니다.

directory 이름과 `name`은 같아야 하며 lowercase alphanumeric과 hyphen만 사용합니다. 다음은 `.agents/skills/review-check/SKILL.md`의 최소 valid 예입니다.

```markdown
---
name: review-check
description: Review a small change and report correctness risks when explicitly selected.
---

# Review check

현재 diff를 읽고 확인한 사실과 남은 위험을 구분해 답하세요.
```

입력창에서 `$`를 누르면 `@`의 기존 Skills catalog가 바로 열리고 현재 `$query`로 filter됩니다. `@` menu의 `Skill` 경로도 그대로 유지됩니다. Select하면 query 전체가 catalog의 canonical `$identity` text로 바뀝니다. Outside-code plain `$bare`와 `$qualified:identity`는 direct invocation이고, inline code와 backtick/tilde fenced Markdown code 안의 `$missing`은 literal입니다. 첫 selector delimiter에서는 menu가 닫히고 일반 입력/submit이 계속됩니다.

Missing 또는 ambiguous selector는 provider/history/resource read 전에 bounded visible error로 중단하며 draft bytes와 staged selection을 그대로 보존합니다. Empty catalog, duplicate identity와 ambiguous bare name은 disabled diagnostic으로 보이고 임의 winner를 선택하지 않습니다. Menu cancel, no-result와 disabled Enter도 selector text를 잃지 않습니다. Typed/direct와 staged multi-selection은 first-seen identity로 dedupe한 뒤 모두 resolve·read·admit할 수 있을 때만 atomic 적용합니다.

선택된 Skill instruction body는 EOF까지 exact full body로만 admit되며 말없이 partial truncate하지 않습니다. 한 입력에서 여러 Skill을 명시하면 하나라도 실패할 때 valid Skill만 부분 적용하지 않습니다.

references, scripts, templates와 assets는 discovery 때 eager load하지 않습니다. 선택된 Skill이 추가 자료를 실제로 필요로 할 때 parent Agent만 `read_skill_resource { skill, resource_path }`를 호출할 수 있습니다. `skill`은 이 top-level turn에 선택된 Skill의 exact identity여야 하고 `resource_path`는 그 Skill root 아래의 relative path여야 합니다. 이 도구는 read-only이며 write, execute 또는 MCP authority를 추가하지 않습니다. child의 exact-five registry에는 이 도구가 없습니다.

resource read는 exact-or-fail입니다. 성공하면 resource body만 원문 그대로 반환하며 wrapper, source path marker 또는 부분 내용은 덧붙이지 않습니다. missing, outside-root, stale Skill, unreadable/invalid UTF-8 또는 context admission 오류는 해당 resource call만 fail-closed하고 같은 이름의 다른 resource나 Skill로 fallback하지 않습니다. 이미 캡처한 current turn과 selected Skill body는 유지됩니다. invalid Skill은 해당 catalog item만 제외하고 이유를 diagnostic에 남기며 다른 valid Skill은 유지합니다.

UI에서 `read_skill_resource`, `spawn_agent`, `wait_agent`, `interrupt_agent`는 순서대로 **Read Skill resource**, **Start child Agent**, **Wait for child Agent**, **Interrupt child Agent** application card를 사용합니다. 상태는 **Running / Completed / Failed / Rejected / Invalid request / Cancelled / Requested** 중 하나이고 params/result/error는 bounded detail입니다. 이 네 name은 MCP title/stringify fallback과 generic tool approval button을 사용하지 않습니다. 실제 MCP tool의 title과 approval path는 바뀌지 않습니다.

model-facing Skill metadata catalog는 resolved context의 2%를 사용합니다. context size를 알 수 없으면 8,000 characters가 한도입니다. description을 먼저 줄이고 whole entry만 omit하며, model advertisement에서 빠진 enabled Skill도 typed selector의 전체 catalog에서는 찾을 수 있습니다.

## Custom agent role

Void는 다음 위치의 direct-child TOML file을 custom agent role로 읽습니다.

- user: `$HOME/.codex/agents/*.toml`
- trusted Project: `<root>/.codex/agents/*.toml`

각 file에는 `name`, `description`, `developer_instructions`가 필요합니다. 선택적으로 `model`, `model_reasoning_effort`, `capability_profile = "read_only" | "inherit_parent_write"`와 exact-name `[[skills.config]]` rule을 사용할 수 있습니다. Legacy `sandbox_mode = "read-only"`는 `read_only` compatibility spelling일 뿐 OS sandbox가 아닙니다.

```toml
name = "reviewer"
description = "Review a small change and report correctness risks."
developer_instructions = """
Inspect the requested scope and separate facts from remaining risks.
"""
model = "gpt-4.1"
model_reasoning_effort = "medium"
capability_profile = "read_only"

[[skills.config]]
name = "review-check"
enabled = true
```

Filename은 declared `name`을 대신하거나 고치지 않습니다. Unknown key, malformed TOML, unknown profile, conflicting legacy `sandbox_mode = "read-only"` + `inherit_parent_write`, role-local MCP config 또는 invalid value가 있는 candidate는 격리되고 다른 valid role은 유지됩니다. 같은 scope의 duplicate identity는 그 scope에서 무효입니다. Valid Project role은 같은 이름의 user role보다 우선하며, Project가 untrusted이면 Project role은 사용하지 않습니다. Picker는 generic entry, valid exact role과 최대 8개 bounded disabled diagnostic을 같은 catalog에서 보여 줍니다.

명시적 role model은 parent와 같은 provider에서 현재 보이고 설정돼 있으며 native Agent tool format을 지원해야 합니다. reasoning 값도 그 model이 제공하는 값만 사용할 수 있습니다. 조건을 만족하지 않으면 provider dispatch 전에 role admission이 거부됩니다. model을 생략하면 generic child처럼 parent의 effective model을 상속합니다.

Native Agent tool format을 지원하는 Agent route는 marker가 없어도 generic `spawn_agent`, `wait_agent`, `interrupt_agent` controls를 노출합니다. `@Agent`는 optional generic/named intent이고 selection만으로 child를 자동 시작하지 않습니다. Named role을 고르면 그 turn의 revision-pinned exact intent가 되어 `spawn_agent.agent_type`은 그 exact role이어야 합니다. Unsupported provider format이나 usable model 부재는 history/provider send 전에 visible diagnostic으로 중단합니다.

Role catalog 또는 selected role revision이 send 전에 바뀌면 stale role로 fail-closed하고 reselect를 요구합니다. Stop, Task reset/purge, delete/replacement와 disposal은 해당 generation authority와 child work를 revoke/cancel합니다. 다른 Chat을 단순히 선택하는 동작이 새 authority를 부여하지 않습니다. Role의 developer instruction은 Task/session developer instruction 뒤에 붙고 기존 AGENTS revision은 유지되며, role Skill body 전체를 읽을 수 있을 때만 child admission을 atomic하게 완료합니다.

## Agent mode의 configurable child group

Child는 Agent mode의 supported native route에서만 사용합니다. `@Agent` selection 유무와 관계없이 실제 실행은 parent가 `spawn_agent`를 호출할 때 시작됩니다.

Default group은 accepted `4`, concurrent `2`, depth `1`이고 `[agents]` config의 ceiling은 accepted `8`, concurrent `4`, depth `2`입니다. 전체 parent group은 direct와 nested child를 함께 세며 나머지는 admission 순서대로 **FIFO** queue에 머뭅니다. Admission 자체가 실패하면 reservation을 돌려주지만 accepted child가 terminal state가 되어도 그 generation quota는 돌아오지 않습니다. Depth `2`일 때만 child가 nested child를 요청할 수 있고 nested child도 동일한 root owner, frozen authority와 shared nested group budget을 사용합니다.

Generic child는 parent effective provider/model/reasoning을 상속합니다. Named child만 앞 절의 frozen same-provider role 설정을 적용합니다. 각 child는 parent history와 parent-selected Skill body 전체를 복제하지 않는 별도 context에서 delegated task 하나로 시작합니다. parent에는 bounded identity/status와 새 terminal `receipt` 또는 `receipts`만 전달하며 raw child transcript 전체를 복사하지 않습니다.

### `read_only` profile

Generic child와 `read_only` role에 노출되는 application-level built-in tool은 정확히 다음 다섯 개입니다.

1. `read_file`
2. `ls_dir`
3. `search_pathnames_only`
4. `search_for_files`
5. `search_in_file`

Terminal, file write/edit/delete, MCP와 app tool은 제공하지 않으며 runtime에서도 fail-closed합니다. 이 경계는 OS sandbox가 아닙니다. UI와 trace의 정확한 설명은 다음과 같습니다.

> Void application-level read-only — terminal disabled, no OS sandbox

### `inherit_parent_write` profile

이 role은 admission 때 parent가 가진 current authority, owner/root/CWD/trust와 frozen parent tool snapshot을 capture합니다. Child는 그 exact snapshot의 unique built-in/MCP entry만 parent broker를 통해 호출할 수 있습니다. Live settings, catalog 또는 tool lookup으로 새 tool을 얻거나 parent보다 높은 approval/permission으로 elevation하지 않습니다.

Child Run은 frozen available tool names, required approval categories, Undo availability와 동일한 no-OS-sandbox application boundary를 표시합니다. Captured parent approval policy가 적용되며 manual approval policy인 built-in/MCP mutation은 parent approval card를 통과해야 합니다. `write_file`은 child-owned read receipt와 editor Undo transaction을 유지합니다. 동시에 lease를 갖는 one mutation-capable child만 허용됩니다. Cancellation은 provider/broker/underlying result settlement와 stale-result fence를 통과한 뒤 lease를 놓으며 nested child도 같은 mutation/concurrency/group budget을 사용합니다. Parent history와 parent stream tool request는 child broker가 수정하지 않습니다.

## Search backend fallback

`search_pathnames_only`와 `search_for_files`는 bundled Search backend를 먼저 사용합니다. 번들 backend를 시작할 수 없을 때만 Search 내부의 automatic controlled fallback이 system ripgrep을 찾습니다. 이 경로는 terminal capability를 child나 model에 추가하지 않고 extra approval도 요구하지 않습니다. 두 backend를 모두 사용할 수 없으면 도구는 안정적인 `search_backend_unavailable` 오류를 반환합니다. `search_in_file`은 이 fallback을 사용하지 않고 현재 in-process 구현을 유지합니다.

Fallback은 saved-disk ripgrep 결과만 사용합니다. 따라서 저장하지 않은 editor buffer를 합치지 않으며 pathname의 fuzzy matching/order와 VS Code의 모든 exclude/config 결과가 bundled primary와 같다고 보장하지 않습니다. regex, ignore, binary 처리와 결과·시간 한도는 ripgrep 경계 안에 유지되지만, fallback 결과는 degraded disk-search evidence로 해석하세요.

Content primary는 bounded raw-match budget을 유지합니다. 한 file의 많은 match가 그 budget을 먼저 소진해 requested later file page를 확정할 수 없으면 빈 terminal page라고 단정하지 않고 `search_output_limit`로 중단합니다.

`wait_agent`는 target을 생략하면 current children 전체를 관찰합니다. `targets`를 사용하면 서로 다른 child `1..8`개를 선택할 수 있습니다. 새 terminal, timeout 또는 removed event에 깨어나고 결과 순서는 spawn order를 유지합니다. 이미 전달한 terminal summary는 다시 주입하지 않습니다. `interrupt_agent`는 current generation의 선택된 queued 또는 running child를 취소합니다. Parent Stop은 nested work를 포함한 current group 전체에 fanout합니다. Child failure나 targeted cancellation은 다른 child나 parent 전체를 자동 abort하지 않습니다.

Group 한도는 provider send 64회, shared deadline 240초와 stored terminal result 합계 32,000 characters입니다. 각 child는 최대 16 turns, 120초와 terminal summary 8,000 characters를 사용합니다. 자동 retry는 없습니다.

Direct/nested child의 provider send, accepted/concurrent count, group deadline과 result characters는 root group 하나에서 차감됩니다. Nested wait 중인 parent child는 scheduler state를 별도로 표시하지만 별도 quota나 live authority를 만들지 않습니다.

## Child, Chat history와 composer UI

Child Run panel은 transient 상태 `queued`, `running`, `completed`, `failed`, `cancelled`, accepted/running/queued capacity와 timing을 표시합니다. Failed child와 setup failure는 접힌 detail 밖에서도 `Action required`로 보이고, cancellation은 action-required로 표시하지 않습니다. Child, technical metadata와 diagnostics detail은 기본적으로 접혀 있습니다.

Local diagnostics는 parent generation마다 처음 **128 events**만 insertion order로 보존하고 이후 event는 `droppedEvents` count로만 남깁니다. prompt, transcript, tool argument, path, resource body, raw error와 child summary는 trace event에 저장하지 않습니다. Provider usage channel이 없으므로 synthetic token 또는 cost를 만들지 않고 UI에는 정확히 **Usage unavailable**로 표시합니다.

Landing의 Chat history는 non-empty chat을 newest-first로 보여 주며 current row와 `Error > Action required > Needs approval > Running > Queued` 우선순위를 구분합니다. Persistent history is not rendered below the current Chat composer. Header의 `View Past Chats` action은 New Chat landing으로 돌아가는 현재 access path입니다. Current 또는 active parent/child row는 실행 중 삭제할 수 없고 삭제 뒤 focus는 남은 safe row/header로 이동합니다. Chat을 바꾸어도 background Running과 Current selection은 서로 다른 상태입니다.

Current Chat composer는 `Error > Needs approval > Running > unavailable > idle` 상태와 Send/Stop 가능 여부를 같은 기준으로 표시합니다. Running 중에도 draft를 편집할 수 있지만 전송되지는 않으며 Escape는 실제 stoppable work만 중단합니다. approval-only 상태에는 parent Stop이 없고 active child가 함께 있을 때만 child Stop을 제공합니다. 각 chat draft는 A→B→A 이동에서 독립적으로 복원되지만 memory-only이므로 restart 뒤에는 보존되지 않습니다.

## Assistant message와 native tool-only history

OpenAI/OpenAI-Compatible native tool-call assistant는 empty content와 `tool_calls`를 유지하고, Anthropic/Gemini tool-only form은 fake text block을 만들지 않습니다. XML route는 재구성한 non-empty tool XML을 유지합니다. General reasoning-only assistant entry는 fake sentinel을 outbound history에 주입하지 않습니다.

Exact `(empty message)` sentinel은 parent storage, child history/summary, converter input과 visible renderer 경계에서 empty display로 sanitize됩니다. 주변의 legitimate text는 숨기지 않습니다. Non-empty reasoning-only content는 display text가 없어도 reasoning bubble로 계속 보입니다. Whitespace-only reasoning edge는 이 문서에서 더 넓은 계약으로 주장하지 않습니다.

## 현재 지원하지 않는 범위

이 릴리스는 direct user/Project custom role, configurable depth-2 ceiling과 profile-aware bounded group을 지원합니다. 다음 범위는 제공하지 않습니다.

- persistent child group, restart replay 또는 full child transcript history
- configured ceiling을 넘는 admission/concurrency/depth
- arbitrary live provider/tool/permission override, independent child elevation 또는 broker 밖 mutation
- plugin-local custom agent package와 broader permission model
- Project persistence/routing 또는 full Task/Run history

## 관찰 결과 기록

동봉 `prompts/agent-instructions-test-prompts.md`는 작은 수동 관찰 절차이지 합격 증명서가 아닙니다. 실제 실행에서는 `PASS`/`FAIL`/`BLOCKED`/`EXPLORATORY`, provider/model, top-level turn, selector, bounded tool trace, Child Run과 Chat UI 상태, 실제 file state를 함께 기록하세요. Source fixture, build 또는 artifact smoke 성공만으로 actual provider 동작, token usage나 performance를 주장하지 마세요.
