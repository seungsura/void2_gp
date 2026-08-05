# `read_file` 직접 테스트 프롬프트

각 항목은 탐색적 제품 테스트입니다. 실제 chat/provider E2E와 read performance는 이 package 시점에 미검증입니다. `PASS`/`FAIL`/`BLOCKED`/`EXPLORATORY`, provider/model, tool trace, 실제 editor/disk 증거를 기록하세요.

## 1. 작은 line 범위와 continuation

- Setup: `small.txt`에 번호가 붙은 20줄을 저장합니다.
- Exact prompt: “`small.txt`의 3번째 줄부터 7번째 줄까지 읽고, 반환된 start/end/next/eof 상태도 알려 주세요.”
- Expected: 1-based inclusive 3–7줄과 current cursor 상태를 반환합니다.
- Record: startLine/endLine/nextLine/nextByteOffset, 누락·중복, raw result.

## 2. dirty editor current text

- Setup: `dirty.txt`를 저장한 뒤 editor에서 한 줄을 바꾸되 저장하지 않습니다.
- Exact prompt: “현재 열린 `dirty.txt`를 읽고 디스크가 아니라 지금 editor에 보이는 변경된 줄을 그대로 알려 주세요.”
- Expected: live editor text와 current version receipt를 읽습니다.
- Record: editor text, disk text, read result, receipt, `EXPLORATORY` 상태.

## 3. applied edit 뒤 fresh read

- Setup: `applied.txt`에 `before apply`를 저장하고 native write로 `after apply`를 적용합니다.
- Exact prompt: “방금 적용된 `applied.txt`를 새로 읽어 현재 내용과 새 receipt를 알려 주세요.”
- Expected: fresh read가 `after apply`와 새 document version을 반영합니다.
- Direct state check: editor, disk, read result를 비교합니다.
- Pass/fail record: `EXPLORATORY` / 적용 receipt / fresh receipt / 내용 일치 / stale 재사용 여부.

## 4. Undo 뒤 fresh read

- Setup: 3번 적용 직후 사용자가 Undo를 한 번 실행합니다.
- Exact prompt: “Undo가 끝난 현재 `applied.txt`를 다시 읽고 직전 read와 무엇이 달라졌는지 알려 주세요.”
- Expected: Undo된 `before apply`와 또 다른 current version receipt를 반환합니다.
- Direct state check: editor의 Undo 결과와 fresh read를 비교합니다.
- Pass/fail record: `EXPLORATORY` / Undo 단위 / fresh 내용 / receipt 변화 / 과거 내용 재사용 여부.

## 5. stale receipt write rejection

- Setup: `race.txt`를 모델이 읽은 뒤 사용자가 editor에서 내용을 바꿉니다.
- Exact prompt: “다시 읽지 말고 직전 `race.txt` read receipt로 기존 줄을 수정해 주세요.”
- Expected: `stale_read`로 write가 fail-closed하며 사용자 변경을 보존합니다.
- Direct state check: mutation 0, editor current text, tool error를 확인합니다.
- Pass/fail record: `EXPLORATORY` / receipt owner·version trace / 오류 / 전후 text.

## 6. 긴 UTF-8 한 줄 continuation

- Setup: 한글·이모지·ASCII가 반복되는 128KiB 초과 단일 줄 `long-utf8.txt`를 만듭니다.
- Exact prompt: “`long-utf8.txt`의 첫 줄을 끝까지 lossless하게 읽으세요. 매번 반환된 `nextLine`과 `nextByteOffset`을 그대로 사용하고 각 page의 byte 수와 UTF-8 decode 성공 여부를 기록하세요.”
- Expected: cursor가 같은 line에서 전진하고 code point를 쪼개지 않으며 exact reconstruction됩니다.
- Direct state check: 모든 page를 cursor 순서대로 결합한 bytes/hash를 원본과 비교합니다.
- Pass/fail record: 상태 / page 수 / offset 목록 / 최대 bytes / decode 오류 / 최종 hash 일치.

## 7. 10MB multiline·minified/bundle continuation

- Setup: 별도 임시 폴더에 약 10MB multiline log와 약 10MB minified JSON/bundle fixture를 준비합니다. 배포 source의 과거 retained fixture 경로에 의존하지 마세요.
- Exact prompt: “두 10MB 파일을 각각 bounded `read_file` continuation으로 끝까지 읽되 page별 lines/UTF-8 bytes/estimated-token 경계, forward progress와 최종 exact reconstruction을 기록하세요.”
- Expected: 각 page가 설정 ceiling 이내이고 cursor가 전진하며 누락·중복 없이 원본을 복원합니다. minified 한 줄은 byte continuation을 사용합니다.
- Direct state check: 원본과 재조립 결과의 byte 길이·SHA-256을 비교하고 page별 최대 크기를 기록합니다.
- Pass/fail record: 기본 상태는 helper가 아닌 실제 chat/provider라면 `EXPLORATORY` / provider·model / file별 page 수 / p50·p95 가능 시 기록 / hash / 오류. 실제 provider payload·성능 gate는 미검증입니다.

## 8. 같은 chat의 후속 질문

- Setup: 1번 또는 7번에서 여러 page를 같은 chat으로 읽은 직후 새 chat을 열지 않습니다.
- Exact prompt: “방금 읽은 파일의 첫 부분과 마지막 부분에서 각각 한 사실을 골라 답하고, 어느 read page 근거인지 알려 주세요. 파일을 다시 전체 읽지 마세요.”
- Expected: bounded history에 보존된 page를 근거로 답하며 oversized raw result나 임의 artifact fallback을 만들지 않습니다.
- Direct state check: 답의 두 사실을 원본에서 확인하고 실제 추가 tool call, persisted history와 provider request 크기를 가능한 범위에서 관찰합니다.
- Pass/fail record: 반드시 `EXPLORATORY` / provider·model / 추가 read 여부 / 근거 정확성 / history·request 관찰 가능 여부 / overflow·compaction 증상.

## 해석 주의

focused helper/service tests는 실제 provider request, persisted history, browser/UI E2E를 대체하지 않습니다. success를 주장하려면 raw tool result뿐 아니라 current editor/disk/Undo와 가능한 tool trace를 함께 보존하세요.
