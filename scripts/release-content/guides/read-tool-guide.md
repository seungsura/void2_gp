# `read_file` 사용자 안내

## 범위와 continuation

`read_file`의 `start_line`과 `end_line`은 1-based inclusive입니다. 생략하면 처음부터 EOF까지 요청하지만 안전 cap에서 멈출 수 있습니다. 기본 cap은 2,000 lines, 64 KiB UTF-8 bytes, estimated 12,000 tokens 중 먼저 도달하는 값입니다. local override ceiling은 4,000 lines, 128 KiB, estimated 24,000 tokens입니다. 실제 per-read token cap은 setting cap과 `contextWindow - reserved output - current history estimate - 1,024 guard` 중 작은 값입니다. budget 계산 오류나 remaining budget 0은 기본값으로 되살리지 않고 fail-closed합니다.

응답의 `nextLine`과 `nextByteOffset`을 다음 호출에 그대로 사용합니다. `line_byte_offset`은 cap보다 긴 한 줄을 이어 읽는 0-based UTF-8 byte cursor입니다. cursor가 UTF-8 code-point boundary가 아니거나 해당 line과 맞지 않으면 실패합니다. 긴 줄을 preview로 잘라 버리지 않고 lossless continuation으로 읽습니다.

## live editor와 receipt

가능한 경우 read 대상은 현재 Monaco model입니다. dirty editor, agent edit 적용 뒤, Undo 뒤 모두 현재 editor text를 읽어야 합니다. 성공한 read는 URI, document version, source/range metadata가 연결된 opaque receipt를 만듭니다. 같은 owner thread와 최신 model/version receipt만 기존 파일 `modify`에 사용할 수 있고, read 뒤 문서가 바뀌면 과거 receipt는 history 증거로 남아도 write 권한으로 재사용할 수 없습니다.

raw result와 formatted result 모두 bounded history gate를 통과해야 합니다. oversized 성공을 artifact로 우회하지 않으며, 기록할 수 없으면 deterministic `tool_error`와 더 작은 continuation read가 필요합니다.

## 권장 순서

1. 필요한 최소 line 범위를 읽습니다.
2. `truncated`, `eof`, `longLineContinuation`, `nextLine`, `nextByteOffset`을 확인합니다.
3. continuation cursor를 수정하지 않고 다음 read에 사용합니다.
4. 파일 변경 전 최신 read receipt를 다시 확보합니다.
5. 적용·직접 편집·Undo 뒤 새 read로 current text/version을 확인합니다.

## 알려진 미검증 경계

focused read tests와 10MB compiled-helper continuation은 확인됐지만, 실제 Void chat/provider의 dirty editor → read → edit → fresh read → Undo E2E는 새 portable에서 아직 미검증입니다. 실제 provider payload/tokenizer/persisted history, closed-file disk streaming, UI/provider p50/p95와 peak allocation을 포함한 read performance gate도 미검증입니다. 아래 prompt는 탐색 절차이며 통과 사실이 아닙니다.
