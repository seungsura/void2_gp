# Void 1.99.3 Windows x64 배포 묶음

이 묶음은 portable 제품 ZIP과 `write_file`/`read_file` 안내서, 그리고 실제 제품 관찰용 프롬프트를 함께 전달합니다. 이 README의 값은 assembler가 실제 새 portable을 만든 뒤에만 확정합니다. placeholder를 hash 또는 통과 사실로 해석하지 마세요.

## 포함 파일

- `Void-1.99.3-win32-x64-portable.zip`: portable 제품 ZIP
- `SHA256SUMS.txt`: assembler가 placeholder 치환 뒤 생성하는 manifest
- `guides/write-tool-guide.md`, `guides/read-tool-guide.md`: 도구 계약과 안전 경계
- `prompts/write-tool-test-prompts.md`, `prompts/read-tool-test-prompts.md`: 탐색적 제품 테스트 절차

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

## OpenAI-compatible streaming repair

OpenAI-compatible Agent에서 관찰된 `ERR_STREAM_PREMATURE_CLOSE`의 확정 원인은 이전 `write_file` root schema가 `oneOf`만 가지고 root `type: object`가 없었던 점입니다. 사내 LiteLLM/OpenAI schema validation이 그 형태를 거부했습니다. non-stream 요청은 outer 500/inner 502로 실패했고, stream 요청은 200 SSE headers 뒤 `data:` 또는 `[DONE]` 없이 close됐습니다. OpenAI SDK와 local loopback fixture는 정상 동작했으므로 SDK가 원인은 아닙니다.

현재 repair는 root `type: object`, `create`/`modify` operation enum, optional branch fields를 가진 flat model-facing schema입니다. `oneOf`, `anyOf`, `allOf`, `if`, `then`, `else`, `const`는 사용하지 않습니다. 이것은 model-facing transport compatibility repair일 뿐입니다. create/modify의 required/forbidden 조합, unknown key 거부, receipt/stale 검증, immutable snapshot planner는 runtime이 계속 엄격하게 강제합니다.

진단 오류는 endpoint path(관찰된 설정은 `/chat/completions`), tool mode/schema posture, stream phase를 포함할 수 있지만 API key나 custom headers를 기록하지 않습니다. endpoint로 직접 요청하지 마세요.

## 해결된 과거 패키징 문제와 게시 gate

- shared runtime manifest의 native payload 24/24가 x64 artifact와 ZIP에서 모두 존재하고 nonzero인지 검증합니다.
- 누락됐던 native payload를 복구했으며 창 생성 전 종료의 강한 원인 후보였던 `@vscode/policy-watcher`도 포함합니다.
- MSVC `14.44.35207` Spectre x86+x64 libraries와 Visual Studio component가 정상 설치된 prerequisite에서 native module을 빌드합니다. `node_modules`의 `SpectreMitigation`을 지우는 patch는 사용하지 않습니다.
- portable `data/README.txt`는 deterministic template에서 생성하여 package 누락을 막습니다.
- publish는 임시 ZIP을 먼저 검증하고 final 교체 전에 backup을 보존합니다. sharing/lock 오류에는 제한된 retry를 적용하며 final/backup 동시 잔존 같은 모호한 상태는 fail-closed합니다. 검증 완료 후에만 backup을 정리합니다.

위 항목은 새 portable의 실제 artifact/ZIP 검증이 성공한 뒤 assembler가 확인·게시할 gate입니다. placeholder 상태의 이 staging 문서 자체가 새 portable 성공을 뜻하지 않습니다.

## 확인된 범위와 남은 경계

focused schema/planner/diagnostic tests와 local SDK loopback은 확인됐지만, 실제 provider/UI E2E는 새 portable에서 아직 미검증입니다. 실제 chat/provider request, 승인 UI, create/modify 적용과 Undo는 아래 prompt를 사용해 관찰해야 합니다. `read_file`의 실제 provider/UI E2E와 read performance/closed-file streaming gate도 이 package에서는 아직 미검증입니다.

프롬프트는 탐색적 테스트이지 통과 사실이 아닙니다. 실제 결과, provider/model, tool trace, UI 상태를 기록한 경우에만 해당 환경의 관찰 증거가 됩니다.
