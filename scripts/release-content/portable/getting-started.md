# Void portable 시작하기

## 1. 받은 파일 확인

배포 묶음을 받았다면 묶음의 `SHA256SUMS.txt`에서 portable ZIP 이름과 SHA-256을 확인하세요. standalone ZIP만 받았다면 신뢰하는 전달 경로에서 별도로 제공된 SHA-256과 비교하세요.

```powershell
Get-FileHash -Algorithm SHA256 .\Void-*-win32-x64-portable.zip
```

값이 다르면 압축을 풀거나 실행하지 말고 새 파일을 받으세요.

## 2. 새 폴더에 압축 해제

기존 설치 폴더나 이전 portable 위에 덮어쓰지 마세요. 버전마다 비어 있는 새 폴더를 사용합니다.

```powershell
Expand-Archive .\Void-*-win32-x64-portable.zip .\Void-portable
.\Void-portable\Void.exe
```

일반 사용자 권한으로 실행하세요. portable 설정, 로그, 확장과 작업 데이터는 압축을 푼 폴더의 `data/` 아래에 만들어집니다. portable 폴더를 교체하기 전에는 필요한 `data/`를 별도로 보관하세요.

## 3. 첫 Chat

이 portable은 조직용 연결과 model을 package가 관리합니다. provider나 model을 선택하거나 연결 정보를 입력할 필요가 없습니다. Chat에는 `gpt-5.6-luna`가 표시됩니다. 첫 대화와 도구 결과를 확인한 뒤 중요한 파일 작업을 시작하세요.

초기 Settings에는 edits, terminal, MCP tools와 LLM changes의 자동 승인이 켜져 있습니다. 필요하면 현재 Project의 작업 방식에 맞게 명시적으로 바꾸세요. 연결 오류가 나면 표시된 진단을 기록하고, 같은 요청을 반복하기 전에 원인을 확인하세요.

## 4. Agent instructions를 작은 workspace에서 확인

중요한 Project에 적용하기 전에 별도 임시 workspace에서 Chat을 여세요. Chat은 항상 Agent로 동작합니다. Project root의 `AGENTS.md`, user `$HOME/.codex/config.toml`, trusted Project의 `<root>/.codex/config.toml`, `.agents/skills/<name>/SKILL.md`와 필요한 `.codex/agents/<name>.toml` role을 작은 범위로 작성합니다. legacy `.voidrules`가 자동으로 옮겨지거나 새 instruction으로 읽힐 것이라 기대하지 마세요.

Child limit을 바꾸려면 user 또는 trusted Project config에 다음 table을 둡니다. Trusted Project 값이 user 값을 override하며 변경은 새 Task/session에서 확인하세요.

```toml
[agents]
max_accepted_children = 4
max_concurrent_threads_per_session = 2
max_depth = 1
```

`max_accepted_children`와 `max_concurrent_threads_per_session`은 양의 정수이고 concurrent는 accepted 이하이어야 합니다. `max_depth`는 0 이상 정수입니다. 이 값에는 별도 고정 상한이 없으며, 잘못된 값이나 unknown key는 bounded diagnostic을 만들고 authority를 확대하지 않습니다.

Custom role은 `capability_profile = "read_only"` 또는 `capability_profile = "inherit_parent_write"`를 사용할 수 있습니다. 먼저 `read_only`와 작은 read task로 role을 확인하세요. Inherited profile을 확인할 때에는 폐기 가능한 fixture file 하나만 사용하세요. manual approval policy에서도 다음 UI 경계를 유지합니다. Durable Child Activity card shows role/description when present, coarse capability, status, timing, and bounded summary/truncation/nesting/retention notices. Only the separate pending approval card shows title, category, parameters, and Approve/Reject. Frozen tool names and Undo availability are not shown on either card; verify them separately in the broker/tool trace and actual file state. 승인 뒤 실제 bytes와 editor Undo를 직접 확인하고 원래 bytes로 되돌리세요. 중요한 workspace에서 permission 경계를 처음 시험하지 마세요.

지원 경로와 precedence, top-level turn reload, `$`/`@` Skill selector, optional `@Agent`, custom role, default/override limits와 shared nested group budget은 [Agent instructions 안내](guides/agent-instructions-guide.md)를 먼저 읽으세요. 이어 [직접 테스트 프롬프트](prompts/agent-instructions-test-prompts.md)에서 named role, targeted `wait_agent`/`interrupt_agent`, read-only와 inherited profile, current Chat layout을 작은 fixture로 관찰하세요.

## 5. Production editor suggestion 상태 확인

Built production Settings에는 **Enable Ghost Chat code suggestions**와 **Show suggestions on select**가 표시되지 않습니다. 이전 portable의 profile에 해당 setting이 `true`로 남아 있어도 무시되며 automatic Ghost request, Ghost debounce와 selection helper widget은 사용할 수 없습니다.

이 비활성 경계는 Chat sidebar, Quick Edit와 Agent에 적용되지 않습니다. [Ghost Chat 안내](guides/ghost-chat-guide.md)를 읽고 [production 확인 프롬프트](prompts/ghost-chat-test-prompts.md)로 설정 부재와 zero automatic behavior만 확인하세요.

## 6. 파일 도구를 검토하며 사용

1. `read_file`로 작은 범위를 먼저 읽고 line 범위와 continuation 정보를 확인합니다.
2. 수정 전 현재 파일 snapshot과 receipt가 최신인지 확인합니다.
3. `write_file`이 제안한 create 또는 modify 내용을 editor review에서 읽습니다.
4. 승인한 뒤 실제 파일 결과를 다시 읽습니다. 예상과 다르면 Undo로 되돌리고 원인을 확인합니다.
5. 큰 파일과 중요한 파일은 안내서의 탐색적 prompt로 작은 사례부터 검증합니다.

현재 배포본의 실제 provider/network/UI 전체 E2E와 `read_file` 성능은 별도 관찰 대상입니다. focused tests, build와 artifact smoke 성공을 사용 환경의 provider 검증이나 성능 증명으로 확대 해석하지 마세요.

## 7. Settings switch를 확인할 때

Settings의 visible switch는 native checkbox가 click/Space interaction을 소유합니다. Reversible하고 중요하지 않은 setting 하나에서 accessible name, checked 변화와 disabled inert 상태를 확인한 뒤 원래 값으로 되돌리세요. Normal/dark theme의 track·knob·focus ring은 확인할 수 있지만 Chromium `forced-colors` fixture는 Windows OS High Contrast product 관찰을 대신하지 않습니다.
