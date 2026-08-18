# Void portable 사용자 문서

이 `docs/` 트리는 standalone portable ZIP 안에서 바로 읽을 수 있는 사용자 안내입니다.

## 문서 목록

- [시작하기](getting-started.md): 무결성 확인, 새 폴더에 압축 해제, 첫 실행과 기본 도구 검토 흐름
- [현재 릴리스 노트](release-notes.md): 이전 Void와 현재 배포본의 차이, 확인된 범위와 미검증 경계
- [`write_file` 안내](guides/write-tool-guide.md)와 [직접 테스트 프롬프트](prompts/write-tool-test-prompts.md)
- [`read_file` 안내](guides/read-tool-guide.md)와 [직접 테스트 프롬프트](prompts/read-tool-test-prompts.md)
- [Agent instructions 안내](guides/agent-instructions-guide.md): `AGENTS.md`, config, Skills, custom agents와 bounded read-only subagent
- [Agent instructions 직접 테스트 프롬프트](prompts/agent-instructions-test-prompts.md)
- [Ghost Chat 안내](guides/ghost-chat-guide.md): production automatic suggestion 부재와 영향받지 않는 기능
- [Ghost Chat production 확인 프롬프트](prompts/ghost-chat-test-prompts.md)

`release-notes.md`는 누적 변경 이력이 아니라 이 portable에 대한 current-only 설명입니다. 다음 배포에서는 그 배포의 현재 상태로 교체됩니다.

이 릴리스의 Agent manual은 direct `.codex/agents/*.toml` role, 최대 4 accepted·2 running·FIFO direct-child orchestration과 current child/history/composer UI를 포함한 현재 계약을 설명합니다. Child nesting, persistent group과 arbitrary provider/tool/permission override는 제공하지 않습니다. Built production에서는 **Enable Ghost Chat code suggestions**와 **Show suggestions on select**가 Settings에 없고, 이전 persisted `true`도 automatic request, debounce 또는 selection widget을 활성화하지 않습니다. Chat, Quick Edit와 Agent는 이 경계의 영향을 받지 않습니다. 실제 provider/network E2E와 성능은 별도 관찰 대상이므로 동봉 prompt의 예상 결과를 통과 사실로 해석하지 마세요.
