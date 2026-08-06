# `write_file` 사용자 안내

## model-facing schema와 runtime 계약

`write_file`은 native structured 파일 변경 도구입니다. current model-facing schema는 root `type: object`, closed root (`additionalProperties: false`), `uri`와 `operation`만 root required로 둡니다. `operation` enum은 `create`와 `modify`입니다. `content`, `read_receipt_id`, `edits`는 branch-specific optional fields이며 schema에는 `oneOf`, `anyOf`, `allOf`, `if`, `then`, `else`, `const`가 없습니다.

평탄화는 OpenAI-compatible transport repair이며 runtime contract를 완화하지 않습니다.

| operation | runtime 필수 | runtime 금지 | 의미 |
|---|---|---|---|
| `create` | `uri`, `operation`, `content` (빈 문자열 가능) | `read_receipt_id`, `edits`, 기타 unknown key | 존재하지 않는 경로에 새 파일 생성 |
| `modify` | `uri`, `operation`, current `read_receipt_id`, 비어 있지 않은 `edits` | `content`, 기타 unknown key | 현재 read snapshot의 exact edit |

각 edit object는 `old_text`, `new_text`를 모두 요구하고 unknown key를 거부합니다. `old_text`는 현재 snapshot에서 정확히 한 번 일치하는 whole-line 범위여야 하며 fuzzy match/replace-all은 없습니다. `new_text: ""`는 삭제에 사용할 수 있습니다.

유일한 empty 예외는 **empty snapshot + exactly one edit + `old_text: ""`** 입니다. 일반 empty `old_text`, non-empty snapshot의 empty `old_text`, multiple-edit 안의 empty `old_text`는 모두 거부되고 plan/mutation은 만들어지지 않습니다.

`modify`에는 같은 파일의 최신 `read_file` receipt가 필요합니다. receipt는 URI, owner thread, live model identity/version, snapshot과 묶이며 승인 대기 또는 hook 전후에도 stale 여부를 다시 확인합니다. 문서가 바뀌면 `stale_read`로 mutation 없이 실패합니다.

## OpenAI-compatible streaming repair와 privacy

이전 root `oneOf`-only schema는 일부 OpenAI-compatible validator에서 거부됐고, stream이 완료 event 없이 닫히면 `ERR_STREAM_PREMATURE_CLOSE`로 보일 수 있었습니다. 현재 flat schema는 이 호환 문제를 피하고 runtime 검증으로 파일 안전 경계를 유지합니다.

현재 flat schema가 이를 피하지만 실제 provider/UI E2E는 새 package에서 미검증입니다. diagnostic error는 configured endpoint path(관찰된 path: `/chat/completions`), tool mode/schema posture, stream phase를 표시할 수 있습니다. 민감한 설정값이나 요청 내용은 진단 기록에 복사하지 말고 Void의 실제 chat과 tool trace만 관찰하세요.

## 사용자가 직접 확인할 것

1. 새 OpenAI-compatible Agent chat에서 먼저 간단한 `1`을 보내 stream completion을 확인합니다.
2. 새 파일 `create`, 최신 read receipt를 사용한 existing-file `modify`, stale receipt rejection을 별도 임시 workspace에서 관찰합니다.
3. tool success 문구만 믿지 말고 editor, disk, Undo, tool trace를 함께 확인합니다.
4. 실패 시 raw premature-close 문자열이 아니라 endpoint path/tool mode/schema posture/stream phase가 포함된 diagnostic error인지 기록합니다.

requested alias가 `gpt-4.1`인데 observed actual route가 `gpt-5.6-luna-2026-07-09`였던 사례가 있습니다. 이는 해당 관찰의 configured/effective route 불일치일 뿐 일반적인 model alias 동작의 단정이 아닙니다.

## 미검증 경계

planner/schema/diagnostic local tests는 통과했지만, 실제 production provider의 tool serialization, Agent UI 승인·적용·Undo, provider-side response body는 새 portable에서 아직 확인되지 않았습니다. marker/XML legacy mutation을 되살리거나 text fallback으로 우회하지 않습니다.
