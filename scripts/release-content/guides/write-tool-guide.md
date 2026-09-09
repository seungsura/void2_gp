# `write_file` 사용자 안내

## model-facing schema와 runtime 계약

`write_file`은 native structured 파일 변경 도구입니다. current model-facing schema는 root `type: object`, closed root (`additionalProperties: false`), `uri`와 `operation`만 root required로 둡니다. `operation` enum은 `create`와 `modify`입니다. `content`, `read_receipt_id`, `edits`는 branch-specific optional fields이며 schema에는 `oneOf`, `anyOf`, `allOf`, `if`, `then`, `else`, `const`가 없습니다.

평탄화는 OpenAI-compatible transport repair이며 runtime contract를 완화하지 않습니다.

| operation | runtime 필수 | runtime 금지 | 의미 |
|---|---|---|---|
| `create` | `uri`, `operation`, `content` (빈 문자열 가능) | `read_receipt_id`, `edits`, 기타 unknown key | 존재하지 않는 경로에 새 파일 생성 |
| `modify` | `uri`, `operation`, current `read_receipt_id`, 비어 있지 않은 `edits` | `content`, 기타 unknown key | 현재 read snapshot의 exact edit |

`create`는 파일을 한 번만 생성한 뒤 전체 내용을 empty baseline에 대한 editor review diff로 등록합니다. 기존 **Auto-accept LLM changes** 설정이 켜져 있으면 즉시 수락하고, 꺼져 있으면 상단 변경 목록에서 Accept/Reject할 수 있습니다. Reject 또는 Undo는 새 파일 자체를 삭제하지 않고 내용을 빈 문자열로 되돌립니다. 빈 content도 유효한 create이며 빈 review row를 유지할 수 있습니다.

각 edit object는 `old_text`, `new_text`를 모두 요구하고 unknown key를 거부합니다. `old_text`는 현재 snapshot에서 정확히 한 번 일치하는 whole-line 범위여야 하며 fuzzy match/replace-all은 없습니다. `new_text: ""`는 삭제에 사용할 수 있습니다.

유일한 empty 예외는 **empty snapshot + exactly one edit + `old_text: ""`** 입니다. 일반 empty `old_text`, non-empty snapshot의 empty `old_text`, multiple-edit 안의 empty `old_text`는 모두 거부되고 plan/mutation은 만들어지지 않습니다.

`modify`에는 같은 파일의 최신 `read_file` receipt가 필요합니다. receipt는 URI, owner thread, live model identity/version, snapshot과 묶이며 승인 대기 또는 hook 전후에도 stale 여부를 다시 확인합니다. 문서가 바뀌면 `stale_read`로 mutation 없이 실패합니다.

## OpenAI-compatible stream과 privacy

현재 flat schema는 OpenAI-compatible transport에서 conditional composition에 의존하지 않으면서 runtime 검증으로 파일 안전 경계를 유지합니다. Stream이 completion 전에 닫히면 tool success로 처리하지 않고 configured route, tool/schema posture와 stream phase를 구분하는 진단을 표시할 수 있습니다. 민감한 설정값이나 요청 내용은 진단 기록에 복사하지 말고 Void의 실제 chat과 tool trace만 관찰하세요.

## 사용자가 직접 확인할 것

1. 새 OpenAI-compatible Agent chat에서 먼저 간단한 `1`을 보내 stream completion을 확인합니다.
2. 새 파일 `create`, 최신 read receipt를 사용한 existing-file `modify`, stale receipt rejection을 별도 임시 workspace에서 관찰합니다.
3. tool success 문구만 믿지 말고 editor, 상단 변경 목록, disk, Accept/Reject와 Undo를 함께 확인합니다. Create를 Reject하거나 Undo한 뒤에는 파일이 존재하고 내용만 비어 있어야 합니다.
4. 불완전한 stream이 성공으로 표시되지 않고 route/tool/schema/phase를 구분하는 diagnostic error로 끝나는지 기록합니다.

requested alias와 observed actual route는 provider routing에 따라 다를 수 있습니다. 차이가 보이면 configured/effective route 불일치라는 관찰로만 기록하고 일반적인 model alias 동작으로 단정하지 마세요.

## 미검증 경계

planner/schema/diagnostic local tests는 통과했지만, 실제 production provider의 tool serialization, Agent UI 승인·적용·Undo, provider-side response body는 새 portable에서 아직 확인되지 않았습니다. marker/XML legacy mutation을 되살리거나 text fallback으로 우회하지 않습니다.
