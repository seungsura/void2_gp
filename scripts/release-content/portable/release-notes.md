# Void {{PRODUCT_VERSION}} 현재 릴리스 노트

이 문서는 이 portable의 현재 동작만 설명합니다. 누적 변경 이력, 내부 장애 기록 또는 향후 계획을 담지 않습니다.

## 이전 Void와 현재 배포본

### `write_file`

- 이전: marker/XML 형식의 별도 edit/rewrite 도구와 모호한 적용 흐름이 있었습니다.
- 현재: native structured `write_file` 하나가 create와 snapshot 기반 modify를 처리합니다. exact/unique edit, stale receipt와 atomic 적용을 runtime에서 검사하고, 수정은 editor review와 Undo 가능한 transaction을 거칩니다.

### `read_file`

- 이전: 큰 UTF-8 파일, 매우 긴 한 줄과 continuation 경계에서 진행이 멈추거나 separator가 빠질 수 있었습니다.
- 현재: 1-based inclusive line 범위, UTF-8 byte continuation, 동적 출력 한도, live editor snapshot receipt와 stale rejection을 사용합니다. 진행할 수 없는 page는 성공처럼 반환하지 않고 명시적으로 거부합니다.

### OpenAI-compatible schema와 진단

- 이전: `write_file`의 composed root schema를 일부 OpenAI-compatible validator가 거부했고, streaming 연결이 완료 marker 없이 닫히면 원인이 가려질 수 있었습니다.
- 현재: model-facing schema는 flat root object를 사용하고 branch 안전성은 runtime validator가 강제합니다. 오류는 요청 내용이나 인증 정보를 노출하지 않으면서 endpoint 단계, tool/schema posture와 stream phase를 구분하도록 보강됐습니다.

### portable 패키징

- 이전: native runtime 누락, portable data README 누락과 게시 중간 상태가 실행 실패 또는 모호한 산출물로 이어질 수 있었습니다.
- 현재: x64 native payload, 필수 파일, 생성 사용자 데이터 제외, ZIP hash/entry와 transactional rollback을 검증합니다. standalone portable 안에도 이 `docs/` 트리가 포함되며 outer 묶음은 같은 안내서와 정확히 같은 portable ZIP을 담습니다.

## 이 릴리스에 포함된 사용자 기능

- repaired `write_file`와 editor review/Undo 흐름
- bounded `read_file` continuation과 receipt 기반 안전 경계
- OpenAI-compatible flat tool schema와 단계별 streaming 진단
- 검증된 Windows x64 portable 패키징과 내장 사용자 문서

## 아직 검증되거나 배포되지 않은 범위

- 실제 provider에서의 전체 chat/tool/UI E2E는 아직 검증되지 않았습니다.
- `read_file`의 실제 사용 환경 성능은 아직 검증되지 않았습니다.
- AGENTS, Skills, subagents는 이 릴리스에 아직 배포되지 않았습니다. 관련 manual도 shipped 기능으로 제공하지 않습니다.
