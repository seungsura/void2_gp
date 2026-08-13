# Agent instructions, Skills, custom agents와 bounded subagent 안내

이 안내서는 현재 릴리스의 Agent mode에 포함된 instruction, Skills, custom agent와 bounded read-only child 범위를 설명합니다. source와 focused tests에서 확인한 계약을 실제 provider/network에서 이미 통과한 결과로 확대하지 마세요. 동봉 prompt는 현재 환경에서 UI와 tool trace를 직접 관찰하기 위한 절차입니다.

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

instruction 설정 allowlist는 `developer_instructions`와 `project_doc_max_bytes` 두 key입니다. user 값을 먼저 읽고 trusted Project가 같은 allowlisted key를 제공하면 Project 값이 우선합니다. untrusted Project의 config는 Project authority로 적용하지 않습니다.

```toml
developer_instructions = """
변경 전에 현재 파일을 읽고 결과를 짧게 요약하세요.
"""
project_doc_max_bytes = 32768
```

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

`$skill-name` 형식(예: `$review-check`)으로 직접 선택하거나 입력창에서 `@`를 열고 `Skill` 항목을 선택할 수 있습니다. 선택된 Skill instruction body는 EOF까지 exact full body로만 admit되며 말없이 partial truncate하지 않습니다. 한 입력에서 여러 Skill을 명시하면 모두 resolve·read·admit할 수 있을 때만 한꺼번에 적용합니다. 하나라도 실패하면 일부 Skill만 넣지 않고 전체 selection을 atomic하게 거부합니다.

references, scripts, templates와 assets는 discovery 때 eager load하지 않습니다. 선택된 Skill이 추가 자료를 실제로 필요로 할 때 parent Agent만 `read_skill_resource { skill, resource_path }`를 호출할 수 있습니다. `skill`은 이 top-level turn에 선택된 Skill의 exact identity여야 하고 `resource_path`는 그 Skill root 아래의 relative path여야 합니다. 이 도구는 read-only이며 write, execute 또는 MCP authority를 추가하지 않습니다. child의 exact-five registry에는 이 도구가 없습니다.

resource read는 exact-or-fail입니다. 성공하면 resource body만 원문 그대로 반환하며 wrapper, source path marker 또는 부분 내용은 덧붙이지 않습니다. missing, outside-root, stale Skill, unreadable/invalid UTF-8 또는 context admission 오류는 해당 resource call만 fail-closed하고 같은 이름의 다른 resource나 Skill로 fallback하지 않습니다. 이미 캡처한 current turn과 selected Skill body는 유지됩니다. invalid Skill은 해당 catalog item만 제외하고 이유를 diagnostic에 남기며 다른 valid Skill은 유지합니다.

model-facing Skill metadata catalog는 resolved context의 2%를 사용합니다. context size를 알 수 없으면 8,000 characters가 한도입니다. description을 먼저 줄이고 whole entry만 omit하며, model advertisement에서 빠진 enabled Skill도 typed selector의 전체 catalog에서는 찾을 수 있습니다.

## Custom agent role

Void는 다음 위치의 direct-child TOML file을 custom agent role로 읽습니다.

- user: `$HOME/.codex/agents/*.toml`
- trusted Project: `<root>/.codex/agents/*.toml`

각 file에는 `name`, `description`, `developer_instructions`가 필요합니다. 선택적으로 `model`, `model_reasoning_effort`, `sandbox_mode = "read-only"`와 exact-name `[[skills.config]]` rule을 사용할 수 있습니다.

```toml
name = "reviewer"
description = "Review a small change and report correctness risks."
developer_instructions = """
Inspect the requested scope and separate facts from remaining risks.
"""
model = "gpt-4.1"
model_reasoning_effort = "medium"
sandbox_mode = "read-only"

[[skills.config]]
name = "review-check"
enabled = true
```

Filename은 declared `name`을 대신하거나 고치지 않습니다. unknown key, malformed TOML, write-capable sandbox, MCP config 또는 invalid value가 있는 candidate는 격리되고 다른 valid role은 유지됩니다. 같은 scope의 duplicate identity는 그 scope에서 무효입니다. valid Project role은 같은 이름의 user role보다 우선하며, Project가 untrusted이면 Project role은 사용하지 않습니다.

명시적 role model은 parent와 같은 provider에서 현재 보이고 설정돼 있으며 native Agent tool format을 지원해야 합니다. reasoning 값도 그 model이 제공하는 값만 사용할 수 있습니다. 조건을 만족하지 않으면 provider dispatch 전에 role admission이 거부됩니다. model을 생략하면 generic child처럼 parent의 effective model을 상속합니다.

`@Agent` selection은 현재 top-level turn에 delegation authority를 열지만 selection만으로 child를 자동 시작하지 않습니다. parent가 `spawn_agent`의 optional `agent_type`에 catalog의 exact role name을 지정할 때 named child가 시작됩니다. role의 developer instruction은 Task/session developer instruction 뒤에 붙고, 기존 AGENTS revision은 그대로 유지됩니다. role Skill filter 뒤 명시된 Skill body를 모두 읽을 수 있을 때만 그 child admission을 atomic하게 완료합니다.

## Agent mode의 bounded read-only child group

Child는 Agent mode에서만 사용합니다. 사용자가 위임을 명시적으로 요청하고 typed selector에서 inert `@Agent`를 선택하면 그 top-level turn 동안 parent model이 child control을 사용할 권한을 얻습니다. 실제 실행은 parent가 sequential `spawn_agent` call을 할 때 시작됩니다.

한 parent generation은 최대 **4 accepted** direct child를 보유하고 동시에 최대 **2 running** child만 실행합니다. 나머지는 admission 순서대로 **FIFO** queue에 머뭅니다. admission 자체가 실패하면 reservation을 돌려주지만, accepted child가 terminal state가 되어도 그 generation의 4개 quota는 돌아오지 않습니다. Child depth는 1이고 child가 다시 child를 만드는 nesting은 허용하지 않습니다.

Generic child는 parent effective provider/model/reasoning을 상속합니다. Named child만 앞 절의 frozen same-provider role 설정을 적용합니다. 각 child는 parent history와 parent-selected Skill body 전체를 복제하지 않는 별도 context에서 delegated task 하나로 시작합니다. parent에는 bounded identity/status와 새 terminal `receipt` 또는 `receipts`만 전달하며 raw child transcript 전체를 복사하지 않습니다.

child에 노출되는 application-level built-in tool은 정확히 다음 다섯 개입니다.

1. `read_file`
2. `ls_dir`
3. `search_pathnames_only`
4. `search_for_files`
5. `search_in_file`

terminal, file write/edit/delete, MCP와 app tool은 제공하지 않으며 runtime에서도 fail-closed합니다. 이 경계는 OS sandbox가 아닙니다. UI와 trace의 정확한 설명은 다음과 같습니다.

> Void application-level read-only — terminal disabled, no OS sandbox

`wait_agent`는 target을 생략하면 current direct children 전체를 관찰합니다. `targets`를 사용하면 서로 다른 direct child 1~4개만 선택할 수 있습니다. 새 terminal, timeout 또는 removed event에 깨어나고 결과 순서는 spawn order를 유지합니다. 이미 전달한 terminal summary는 다시 주입하지 않습니다. `interrupt_agent`는 current generation의 선택된 queued 또는 running direct child를 취소합니다. parent Stop은 current group 전체에 fanout합니다. Child failure나 cancellation은 다른 child나 parent 전체를 자동 abort하지 않습니다.

Group 한도는 provider send 64회, shared deadline 240초와 stored terminal result 합계 32,000 characters입니다. 각 child는 최대 16 turns, 120초와 terminal summary 8,000 characters를 사용합니다. 자동 retry는 없습니다.

## Child, Chat history와 composer UI

Child Run panel은 transient 상태 `queued`, `running`, `completed`, `failed`, `cancelled`, accepted/running/queued capacity와 timing을 표시합니다. Failed child와 setup failure는 접힌 detail 밖에서도 `Action required`로 보이고, cancellation은 action-required로 표시하지 않습니다. Child, technical metadata와 diagnostics detail은 기본적으로 접혀 있습니다.

Local diagnostics는 parent generation마다 처음 **128 events**만 insertion order로 보존하고 이후 event는 `droppedEvents` count로만 남깁니다. prompt, transcript, tool argument, path, resource body, raw error와 child summary는 trace event에 저장하지 않습니다. Provider usage channel이 없으므로 synthetic token 또는 cost를 만들지 않고 UI에는 정확히 **Usage unavailable**로 표시합니다.

Chat history는 non-empty chat을 newest-first로 보여 주며 current row와 `Error > Action required > Needs approval > Running > Queued` 우선순위를 구분합니다. Current 또는 active parent/child row는 실행 중 삭제할 수 없습니다. Chat을 바꾸어도 background Running과 Current selection은 서로 다른 상태입니다.

Current Chat composer는 `Error > Needs approval > Running > unavailable > idle` 상태와 Send/Stop 가능 여부를 같은 기준으로 표시합니다. Running 중에도 draft를 편집할 수 있지만 전송되지는 않으며 Escape는 실제 stoppable work만 중단합니다. approval-only 상태에는 parent Stop이 없고 active child가 함께 있을 때만 child Stop을 제공합니다. 각 chat draft는 A→B→A 이동에서 독립적으로 복원되지만 memory-only이므로 restart 뒤에는 보존되지 않습니다.

## 현재 지원하지 않는 범위

이 릴리스는 direct user/Project custom role과 최대 4 accepted·2 running bounded group을 지원합니다. 다음 범위는 제공하지 않습니다.

- child가 child를 만드는 nested 실행
- 4개를 넘는 admission 또는 2개를 넘는 simultaneous running
- persistent child group, restart replay 또는 full child transcript history
- arbitrary provider, MCP, terminal, write 또는 permission override
- plugin-local custom agent package와 broader permission model
- Project persistence/routing 또는 full Task/Run history

## 관찰 결과 기록

동봉 `prompts/agent-instructions-test-prompts.md`는 작은 수동 관찰 절차이지 합격 증명서가 아닙니다. 실제 실행에서는 `PASS`/`FAIL`/`BLOCKED`/`EXPLORATORY`, provider/model, top-level turn, selector, bounded tool trace, Child Run과 Chat UI 상태, 실제 file state를 함께 기록하세요. Source fixture, build 또는 artifact smoke 성공만으로 actual provider 동작, token usage나 performance를 주장하지 마세요.
