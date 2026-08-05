# `write_file` 직접 테스트 프롬프트

모든 항목은 탐색적 제품 테스트입니다. PASS를 미리 가정하지 말고 `PASS`/`FAIL`/`BLOCKED`/`EXPLORATORY`, provider/model, requested alias/effective route, tool trace, editor·disk·Undo 증거를 기록하세요. endpoint로 직접 요청하지 마세요.

## 0. OpenAI-compatible stream completion 먼저 확인

- Setup: OpenAI-compatible Agent를 선택하고 **새 chat**을 엽니다.
- Exact prompt: `1`
- Expected: 정상 stream completion을 관찰합니다. 이어서 tool trace/schema를 볼 수 있으면 write_file root가 flat `type: object`, operation enum, optional branch fields이고 composition/const가 없다는 current posture를 기록합니다. 이것은 tool test의 전제 관찰일 뿐 provider/UI E2E 전체 통과를 뜻하지 않습니다.
- Record: configured endpoint path(관찰된 설정은 `/chat/completions`), requested alias, observed actual model route, first/last stream UI 상태, tool mode/schema posture. `gpt-4.1` requested alias와 `gpt-5.6-luna-2026-07-09` observed route가 다르면 관찰로만 기록합니다.

## 1. 유일한 whole-line 수정

- Setup: `sample.txt`에 `alpha`, `target = old`, `omega` 세 줄을 만들고 저장합니다.
- Exact prompt: “`sample.txt`를 먼저 읽고, `target = old` 한 줄만 `target = new`로 바꿔 주세요.”
- Expected: 최신 receipt를 사용한 `modify` 한 건이 적용되고 다른 줄은 불변입니다.
- Direct state check: editor와 disk에서 세 줄을 비교하고 Undo 한 번으로 원복되는지 확인합니다.
- Pass/fail record: 상태 / tool name / receipt 여부 / 적용 diff / Undo 결과 / 오류 원문.

## 2. 중복 블록 거부

- Setup: `duplicate.txt`에 `same line`을 두 번 넣습니다.
- Exact prompt: “`duplicate.txt`를 읽고 `same line`을 `changed line`으로 한 번만 바꿔 주세요. 위치는 추가로 지정하지 않겠습니다.”
- Expected: ambiguous match로 mutation 없이 실패합니다. 임의 첫 항목 선택과 replace-all은 금지입니다.
- Direct state check: 두 줄 모두 원문인지 editor와 disk에서 확인합니다.
- Pass/fail record: 상태 / 오류 종류 / 변경된 줄 수(0이어야 함) / UI 메시지.

## 3. 새 파일 생성

- Setup: `sandbox` 폴더는 만들고 `sandbox/new-file.txt`는 만들지 않습니다.
- Exact prompt: “`sandbox/new-file.txt`를 새로 만들고 내용은 정확히 `created by native write_file` 한 줄로 해 주세요.”
- Expected: `create`가 한 번 생성하고 content가 정확합니다. existing target overwrite는 허용되지 않습니다.
- Direct state check: 파일 존재, byte 내용, editor 표시를 확인합니다.
- Pass/fail record: 상태 / create 호출 / 파일 hash 또는 내용 / 추가 파일 생성 여부.

## 4. create no-overwrite

- Setup: `existing.txt`에 `keep me`를 저장합니다.
- Exact prompt: “`existing.txt`를 새 파일로 생성하면서 내용을 `overwrite`로 넣어 주세요.”
- Expected: 대상 존재 오류로 실패하고 기존 파일을 덮어쓰지 않습니다.
- Direct state check: `existing.txt`가 여전히 `keep me`인지 확인합니다.
- Pass/fail record: 상태 / 오류 / 기존 hash 전후 / 변경 여부.

## 5. 부모 폴더 없음

- Setup: `missing-parent` 폴더가 없는지 확인합니다.
- Exact prompt: “`missing-parent/child.txt`를 만들고 내용은 `child`로 해 주세요.”
- Expected: parent-required 오류로 실패하며 폴더도 자동 생성하지 않습니다.
- Direct state check: 폴더와 파일이 모두 없는지 확인합니다.
- Pass/fail record: 상태 / 오류 / 생성된 경로 목록.

## 6. 여러 edit의 atomicity

- Setup: `atomic.txt`에 유일한 `first = old`, 유일한 `second = old`, 중복된 `duplicate` 두 줄을 둡니다.
- Exact prompt: “`atomic.txt`를 읽고 `first = old`와 `second = old`를 각각 `new`로 바꾸고, `duplicate` 한 줄도 `changed`로 바꾸는 하나의 요청으로 처리해 주세요.”
- Expected: 중복 edit가 ambiguous이므로 세 변경 모두 적용되지 않습니다.
- Direct state check: 파일 전체가 setup과 byte-for-byte 같은지 확인합니다.
- Pass/fail record: 상태 / 계획된 edit 수 / 적용된 edit 수(0) / 전후 hash.

## 7. legacy 도구 비노출

- Setup: 새 chat을 열고 가능하면 tool trace를 표시합니다.
- Exact prompt: “현재 사용할 수 있는 파일 변경 도구 이름을 나열하고, `legacy.txt`의 한 줄을 수정해 주세요.”
- Expected: model-facing mutation tool은 `write_file`이며 `edit_file`, `rewrite_file`은 노출·호출되지 않습니다.
- Direct state check: trace의 tool 이름과 request schema를 확인합니다.
- Pass/fail record: 상태 / 노출 도구 / 실제 호출 도구 / legacy 이름 발견 위치.

## 8. read 후 stale receipt 거부

- Setup: `stale.txt`에 `version one`을 저장합니다. 모델에게 읽게 한 뒤 사용자가 editor에서 `version two`로 바꾸고 저장하지 않습니다.
- Exact prompt: “방금 읽은 receipt를 그대로 사용해서 `version one`을 `model change`로 수정해 주세요. 다시 읽지는 마세요.”
- Expected: document version 불일치로 `stale_read`가 발생하고 current text는 유지됩니다.
- Direct state check: editor가 `version two`인지, disk/dirty 상태가 예상과 같은지 확인합니다.
- Pass/fail record: 상태 / read receipt id 또는 trace / version 변화 / mutation 0 여부.

## 9. 적용 내용과 Undo 확인

- Setup: `undo.txt`에 `before`를 저장합니다.
- Exact prompt: “`undo.txt`를 읽고 `before`를 `after`로 바꾼 뒤, 실제 적용된 내용을 다시 읽어 확인해 주세요.”
- Expected: fresh read가 `after`를 반환합니다. 사용자가 Undo하면 editor는 `before`로 돌아갑니다.
- Direct state check: 적용 직후 editor·disk, fresh read, Undo 후 editor를 각각 기록합니다.
- Pass/fail record: 상태 / 적용 내용 / fresh receipt / Undo 단위 / 최종 상태.

## 10. marker payload regression

- Setup: `markers.txt`에 `<<<<<<< SEARCH`, `<SEARCH>literal</SEARCH>`, `<REPLACE>literal</REPLACE>`를 각각 literal 줄로 저장합니다.
- Exact prompt: “`markers.txt`를 먼저 읽고 `<SEARCH>literal</SEARCH>` 줄만 `<SEARCH>kept-as-text</SEARCH>`로 바꿔 주세요. 이 문자열을 편집 프로토콜로 해석하지 마세요.”
- Expected: native structured edit로 literal 한 줄만 바뀌며 marker/XML parser가 개입하지 않습니다.
- Direct state check: 나머지 marker 줄 보존, 호출 tool 이름, 실제 diff를 확인합니다.
- Pass/fail record: `EXPLORATORY` 또는 상태 / provider / tool trace / literal 보존 / 회귀 여부.

## 11. unsupported provider native-tool gate

- Setup: native `write_file` 지원이 없다고 알려진 provider/profile을 선택하고 빈 임시 workspace를 사용합니다.
- Exact prompt: “`provider-gate.txt`를 새로 만들고 `must not use text marker fallback`을 넣어 주세요.”
- Expected: `write_file`이 지원되지 않으면 도구가 노출되지 않거나 mutation 없이 명확히 실패합니다. text/XML marker fallback은 사용하지 않습니다.
- Direct state check: wire/tool trace, 파일 부재, legacy tool 호출 부재를 확인합니다.
- Pass/fail record: 반드시 `EXPLORATORY`로 시작 / provider·model / schema 노출 / 실제 파일 상태 / 실패 메시지. 실제 provider E2E 미검증 항목이므로 관찰만으로 일반화하지 않습니다.

## 12. empty old_text 유일 예외

- Setup A: 내용이 정확히 빈 기존 파일 `empty.txt`를 만듭니다.
- Exact prompt A: “`empty.txt`를 먼저 읽고, 한 번의 수정으로 `created`를 넣어 주세요.”
- Expected A: empty snapshot에서 exactly one edit의 `old_text: ""`만 허용될 수 있습니다.
- Setup B: `not-empty.txt`에 `present`를 넣고, multiple-edit 요청도 준비합니다.
- Exact prompt B: “`not-empty.txt`를 다시 읽지 말고 빈 old text를 사용해 수정하고, 같은 요청에 다른 수정도 하나 더 넣어 주세요.”
- Expected B: non-empty snapshot 또는 multiple edits의 empty old_text는 plan/mutation 없이 거부됩니다.
- Pass/fail record: `EXPLORATORY` / setup A/B / exact raw tool args가 보이면 기록 / mutation count / final bytes / error.

## 13. premature-close 실패 기록

- Setup: tool을 제공하는 Agent chat에서 실제 close/failure가 재현될 때만 시행합니다.
- Exact prompt: “`failure-observation.txt`를 새로 만들고 `observe only`를 넣어 주세요.”
- Expected: raw `ERR_STREAM_PREMATURE_CLOSE`만 남기지 않고 diagnostic error가 endpoint path, tool mode/schema posture, stream phase를 포함합니다. API key/custom headers는 보이거나 기록되면 안 됩니다.
- Record: `EXPLORATORY` / endpoint path / stream phase / schema posture / tool mode / HTTP-visible status가 있으면 그것만 / API key·custom headers 미기록 / retry 여부. 이 기록은 endpoint 직접 요청을 허용하지 않습니다.

## 해석 주의

flat schema는 root object와 operation enum을 사용하고 composition/const를 피하지만, create/modify required/forbidden fields, unknown keys, receipt/stale validation, planner는 runtime이 엄격히 강제합니다. 성공 메시지만으로 통과 처리하지 마세요. 실제 provider/UI E2E는 이 package 시점에 미검증입니다.
