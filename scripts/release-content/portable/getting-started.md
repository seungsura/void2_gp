# Void portable 시작하기

## 1. 받은 파일 확인

배포 묶음을 받았다면 묶음의 `SHA256SUMS.txt`에서 portable ZIP 이름과 SHA-256을 확인하세요. standalone ZIP만 받았다면 신뢰하는 전달 경로에서 별도로 제공된 SHA-256과 비교하세요.

```powershell
Get-FileHash -Algorithm SHA256 .\Void-*-win32-x64-portable.zip
```

값이 다르면 압축을 풀거나 실행하지 말고 새 파일을 받으세요.

## 2. 새 폴더에 압축 해제

기존 설치 폴더나 이전 portable 위에 덮어쓰지 마세요. 버전마다 비어 있는 새 폴더를 사용합니다.

```powershell
Expand-Archive .\Void-*-win32-x64-portable.zip .\Void-portable
.\Void-portable\Void.exe
```

일반 사용자 권한으로 실행하세요. portable 설정, 로그, 확장과 작업 데이터는 압축을 푼 폴더의 `data/` 아래에 만들어집니다. portable 폴더를 교체하기 전에는 필요한 `data/`를 별도로 보관하세요.

## 3. provider와 model 설정

조직 또는 서비스가 제공한 정확한 endpoint와 model 이름을 사용하세요. OpenAI-compatible provider는 기본 model 목록이 비어 있어 model을 직접 추가해야 할 수 있습니다. 화면에 설정한 model 이름과 실제 service route가 같다고 가정하지 말고, 첫 대화와 도구 호출 결과를 확인한 뒤 중요한 파일 작업을 시작하세요.

자동 retry나 다른 chat mode로의 묵시적 전환을 기대하지 마세요. 연결 오류가 나면 표시된 진단 단계와 provider/model 설정을 기록하고, 같은 요청을 반복하기 전에 원인을 확인하세요.

## 4. 파일 도구를 검토하며 사용

1. `read_file`로 작은 범위를 먼저 읽고 line 범위와 continuation 정보를 확인합니다.
2. 수정 전 현재 파일 snapshot과 receipt가 최신인지 확인합니다.
3. `write_file`이 제안한 create 또는 modify 내용을 editor review에서 읽습니다.
4. 승인한 뒤 실제 파일 결과를 다시 읽습니다. 예상과 다르면 Undo로 되돌리고 원인을 확인합니다.
5. 큰 파일과 중요한 파일은 안내서의 탐색적 prompt로 작은 사례부터 검증합니다.

현재 배포본의 실제 provider/UI 전체 E2E와 `read_file` 성능은 아직 검증되지 않았습니다. local test와 package 검증 성공을 사용 환경의 제품 검증으로 확대 해석하지 마세요.
