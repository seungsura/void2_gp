# Void portable 사용자 문서

이 `docs/` 트리는 standalone portable ZIP 안에서 바로 읽을 수 있는 사용자 안내입니다.

## 문서 목록

- [시작하기](getting-started.md): 무결성 확인, 새 폴더에 압축 해제, 첫 실행과 기본 도구 검토 흐름
- [현재 릴리스 노트](release-notes.md): 이전 Void와 현재 배포본의 차이, 확인된 범위와 미검증 경계
- [`write_file` 안내](guides/write-tool-guide.md)와 [직접 테스트 프롬프트](prompts/write-tool-test-prompts.md)
- [`read_file` 안내](guides/read-tool-guide.md)와 [직접 테스트 프롬프트](prompts/read-tool-test-prompts.md)
- [Agent instructions 안내](guides/agent-instructions-guide.md): `AGENTS.md`, config, Skills, custom agents와 profile-aware bounded subagent
- [Agent instructions 직접 테스트 프롬프트](prompts/agent-instructions-test-prompts.md)
- [Ghost Chat 안내](guides/ghost-chat-guide.md): production automatic suggestion 부재와 영향받지 않는 기능
- [Ghost Chat production 확인 프롬프트](prompts/ghost-chat-test-prompts.md)

`release-notes.md`는 누적 변경 이력이 아니라 이 portable에 대한 current-only 설명입니다. 다음 배포에서는 그 배포의 현재 상태로 교체됩니다.

이 portable은 조직용 연결과 model을 package가 관리합니다. provider나 model을 선택하거나 연결 정보를 입력할 필요가 없고 Chat에는 `gpt-5.6-luna`가 표시됩니다.

이 릴리스의 Agent manual은 marker 없이 제공되는 generic controls, optional `@Agent` exact-role intent, direct `.codex/agents/*.toml` role과 configurable bounded orchestration을 설명합니다. Limits의 default는 accepted `4`, concurrent `2`, depth `1`입니다. accepted/concurrent는 양의 정수이고 concurrent는 accepted 이하이며 depth는 0 이상 정수입니다. `read_only`는 exact-five/no-terminal/no-MCP이고 `inherit_parent_write`는 frozen parent tool snapshot, required approval categories, Undo와 one mutation-capable child 경계를 사용합니다. Terminal child가 settle되면 open capacity는 다음 FIFO admission에 반환됩니다. Captured parent approval policy가 적용되며 manual approval policy에서는 child가 card settlement를 기다립니다. Nested child는 같은 shared group budget/cancellation 안에서만 허용되며 live permission elevation은 없습니다.

`$`와 `@`는 같은 Skills catalog를 사용하고 application tools는 MCP가 아닌 exact cards로 표시됩니다. Running tool card는 elapsed와 exact card Stop 상태를 표시합니다. unsent composer draft는 memory-only이고 restart 뒤 남지 않습니다. 별도 Queue/Steer inbox는 최대 32 records / UTF-8 64 KiB이며 reload 뒤 dormant로 남고 자동 전송하지 않습니다. 사용자가 명시적으로 Resume하면 한 번만 재개합니다. 이는 source/focused 계약이며 packaged process-restart 관찰은 별도입니다. Landing에는 non-empty Chat history가 있지만 current composer 아래에는 persistent list가 없으며 `View Past Chats`로 돌아갑니다. Exact `(empty message)`는 저장·표시·outbound history에 남지 않고 non-empty reasoning-only UI는 유지됩니다.

Spawn receipt에 묶인 bounded expandable Child activity card는 볼 수 있지만 full child transcript/session은 아닙니다. thread-level `ChildActivitiesLedger`는 그 thread의 retained root cards가 공유하며 combined total 32 records / UTF-8 64 KiB projection retention을 적용합니다. 이는 separate Queue/Steer inbox envelope의 32/64 상한과 독립적이고 per-card 상한이 아닙니다. Child/group 전체 wall-clock·turn·cumulative-send quota는 없고 configured scheduler capacity와 operation-specific timeout/cancellation; finite manual run은 whole-run child/group quota 부재를 증명하지 않으며 source/focused 결과와 separate long-running evidence를 구분합니다, 실제 logical in-flight provider-dispatch lease만 적용됩니다. Provider-native batch는 durable declaration/provider ordinal을 보존합니다. approved contiguous exact-safe-read calls만 physical cap-two waves로 실행할 수 있고 physical completion order는 durable tool/provider row settlement를 바꾸지 않습니다. non-safe calls는 declaration-order barriers이며 mutation/terminal/MCP는 serialized/exclusive입니다. next provider continuation은 batch terminal or paused까지 기다립니다. literal `multi_tool_use.parallel`은 없습니다. Plan/orchestration은 main parent가 소유하며 새 Plan API/UI/storage나 same-child follow-up은 제공하지 않습니다.

Built production에서는 **Enable Ghost Chat code suggestions**와 **Show suggestions on select**가 Settings에 없고, 이전 persisted `true`도 automatic request, debounce 또는 selection widget을 활성화하지 않습니다. Chat, Quick Edit와 Agent는 이 경계의 영향을 받지 않습니다. Settings switch는 native checkbox interaction과 scoped track/knob/focus styling을 유지하지만 Windows OS High Contrast는 직접 product observation이 필요합니다. packaged fixed-start/Chat/child UI smoke는 release gate이지만 일반 provider matrix와 성능은 별도 관찰 대상이므로 동봉 prompt의 예상 결과를 통과 사실로 해석하지 마세요.
