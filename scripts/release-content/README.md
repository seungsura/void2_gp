# Void 1.99.3 Windows x64 배포 묶음

이 묶음은 사용자 문서가 내장된 portable 제품 ZIP과 `write_file`/`read_file`/Agent/Ghost Chat 안내서, 그리고 실제 제품 관찰용 프롬프트를 함께 전달합니다. 이 README의 값은 assembler가 실제 새 portable을 만든 뒤에만 확정합니다. placeholder를 hash 또는 통과 사실로 해석하지 마세요.

## 포함 파일

- `Void-1.99.3-win32-x64-portable.zip`: portable 제품 ZIP
- `SHA256SUMS.txt`: assembler가 placeholder 치환 뒤 생성하는 manifest
- `guides/write-tool-guide.md`, `guides/read-tool-guide.md`: 파일 도구 계약과 안전 경계
- `guides/agent-instructions-guide.md`: `AGENTS.md`, config, Skills, custom agents와 bounded read-only subagent 사용 안내
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

```powershell
Get-FileHash -Algorithm SHA256 .\Void-1.99.3-win32-x64-portable.zip
Expand-Archive .\Void-1.99.3-win32-x64-portable.zip .\Void-1.99.3-portable
.\Void-1.99.3-portable\Void.exe
```

## Agent instructions, Skills, custom agents와 bounded subagent

이 릴리스는 Agent mode에서 `AGENTS.md`, user/trusted Project `.codex/config.toml`의 제한된 instruction 설정, `.agents/skills` 기반 Skills와 user/trusted Project `.codex/agents/*.toml` custom role을 제공합니다. Typed `@Agent` authority 아래 parent generation마다 최대 4 accepted, 2 running direct child와 FIFO queue를 사용하며 `wait_agent`와 `interrupt_agent`로 결과 전달과 선택 취소를 제어합니다. Child는 application-level exact-five read-only tool만 받고 nesting은 허용하지 않습니다.

Child Run UI는 capacity/status, 실패와 bounded timing/timeline을 표시합니다. Local trace는 first 128 events와 이후 dropped count만 보존하고 provider usage가 없으면 `Usage unavailable`로 표시합니다. Chat history의 Current/Running/action-required 상태, current composer의 Send/Stop/announcement와 per-chat memory-only draft도 현재 UI에 포함됩니다. 정확한 지원 경계와 직접 관찰 절차는 `guides/agent-instructions-guide.md`와 `prompts/agent-instructions-test-prompts.md`를 확인하세요.

focused tests, compile·React·Windows build와 visible artifact smoke는 actual provider/network E2E 증거가 아닙니다. prompt의 예상 결과를 미리 통과 사실로 기록하지 마세요.

## Ghost Chat

현재 built production에서는 **production automatic suggestions are unavailable**입니다. Settings는 **Enable Ghost Chat code suggestions**와 **Show suggestions on select**를 모두 표시하지 않습니다. 이전 profile에 두 setting의 `true` 값이 남아 있어도 무시되며 automatic Ghost request, Ghost debounce와 selection helper widget은 활성화되지 않습니다.

이 변경은 Chat sidebar, Quick Edit와 Agent 기능을 비활성화하지 않습니다. Production에서 두 설정과 자동 editor suggestion이 나타나지 않는지 확인하려면 `guides/ghost-chat-guide.md`와 `prompts/ghost-chat-test-prompts.md`를 사용하세요. Legacy FIM `/completions` retirement도 그대로 유지됩니다.

## OpenAI-compatible file tool contract

OpenAI-compatible Agent의 `write_file`은 root `type: object`, `create`/`modify` operation enum과 optional branch fields를 가진 flat model-facing schema를 사용합니다. `oneOf`, `anyOf`, `allOf`, `if`, `then`, `else`, `const`는 사용하지 않습니다. create/modify의 required·forbidden 조합, unknown key 거부, current read receipt와 stale snapshot 검사는 runtime이 계속 엄격하게 강제합니다.

완료 전에 닫힌 stream은 tool success로 처리하지 않습니다. 사용자에게 보이는 진단은 configured route, tool/schema posture와 stream phase를 구분할 수 있으며 API key, custom headers, request content를 기록하지 않아야 합니다. 중요한 파일을 변경하기 전 작은 임시 workspace에서 실제 chat, tool trace, editor 결과와 Undo를 함께 확인하세요.

## 현재 패키지 gate

정식 assembler는 manifest에 선언된 x64 runtime payload가 artifact와 ZIP에 모두 있고 non-empty인지, `Void.exe`, `resources/app/product.json`, `data/README.txt`가 존재하는지 확인합니다. 생성 사용자 데이터는 제외하고, 사용자 문서는 manifest exact whitelist·UTF-8·Windows-safe path·shared outer/portable byte identity를 통과해야 합니다. 새 portable과 outer 묶음의 hash, entry와 embedded ZIP identity가 모두 검증된 뒤에만 게시합니다.

이 항목은 새 portable의 실제 artifact/ZIP 검증이 성공한 뒤 확정되는 gate입니다. placeholder 상태의 이 staging 문서 자체가 새 portable 성공을 뜻하지 않습니다.

## 확인된 범위와 남은 경계

focused schema/planner/diagnostic, Agent orchestration과 production suggestion admission tests는 현재 source 계약을 확인하지만 전체 actual-provider/UI E2E를 대신하지 않습니다. Built production에서는 persisted setting 값과 관계없이 automatic Ghost request와 selection helper UI가 0이어야 합니다.

실제 chat/provider request, 승인 UI, create/modify 적용과 Undo, AGENTS/Skill/custom-agent/subagent 동작은 동봉 prompt를 사용해 확인하세요. `read_file`의 실제 provider/UI E2E와 read performance/closed-file streaming gate도 미검증입니다.

프롬프트는 탐색적 테스트이지 통과 사실이 아닙니다. 실제 결과, provider/model, tool trace, UI 상태를 기록한 경우에만 해당 환경의 관찰 증거가 됩니다.
