# Void2

이 README는 Void2 fork의 개발 목적과 운영 범위에 맞춰 2026-09-07 다시 작성했습니다.

[소스 저장소](https://github.com/seungsura/void2_gp) · [이슈](https://github.com/seungsura/void2_gp/issues)

Void2는 [Void](https://github.com/voideditor/void)와 Microsoft의 [Code - OSS](https://github.com/microsoft/vscode)를 기반으로, 개인 개발 및 허용된 업무 환경에서 사용할 AI 코딩 에디터를 개선하는 독립 fork입니다. Upstream Void나 Microsoft의 공식 배포·지원 채널이 아닙니다. 앱 내부 이름은 아직 Void를 사용합니다.

실제 코딩 작업의 문제를 재현하고 작은 변경과 회귀 테스트로 신뢰성을 높이는 것이 목표입니다. 현재 개발·검증의 주 대상은 Windows x64입니다.

## 주요 개발 영역

- **Agent 중심 Chat**: 프로젝트 지침, Skills, custom Agent 역할을 연결한 코드 탐색과 편집.
- **Child Agent 위임**: parent가 권한과 작업을 관리하는 spawn/wait/interrupt, 실행 상태와 제한된 활동 이력. 활동 카드는 전체 child 대화록이 아닙니다.
- **다중 도구 실행**: native tool-call batch의 선언 순서를 보존합니다. 허용된 연속 read-only 호출만 최대 두 개씩 병렬 실행하고, 변경·terminal·MCP 호출은 배타적 경계로 처리합니다.
- **Queue / Steer**: 실행 중 후속 입력과 복구 가능한 pending inbox. 보내지 않은 composer 초안과 저장된 대기 입력은 서로 다른 상태입니다.
- **편집·복구 신뢰성**: 읽기 결과 유효성, 변경 diff, editor Undo/Redo, 취소와 늦은 결과의 중복 반영 방지. Chat 전체 filesystem checkpoint 복구를 뜻하지 않습니다.
- **재현 가능한 검증**: TypeScript/React 컴파일, focused 서비스·UI 테스트와 Windows release gate를 구분합니다.

이 목록은 개발 소스의 주요 영역입니다. `main`의 변경이 기존 배포 ZIP에 모두 포함됐다는 뜻은 아닙니다. Source/focused 테스트와 실제 앱·provider·패키지 검증을 구분하며, 임의 provider나 extension의 호환성을 보장하지 않습니다.

## 소스 구조

| 경로 | 역할 |
|---|---|
| `src/vs/workbench/contrib/void/` | Agent, Chat, 도구, 편집 등 Void 기능 |
| `src/vs/workbench/contrib/void/browser/react/` | React 기반 Chat·Settings UI |
| `src/vs/workbench/contrib/void/test/` | 기능별 회귀 테스트 |
| `scripts/` | Windows 환경 설정·검증·release 도구 |
| `scripts/release-content/` | manifest로 관리하는 배포용 사용자 문서 |
| `build/` | Code - OSS 기반 build pipeline |

Upstream의 [코드 구조 안내](VOID_CODEBASE_GUIDE.md)는 출발점으로 참고할 수 있습니다. 원본의 지원 채널·환경·동작 설명이 이 fork의 현재 계약과 일치한다고 가정하지 마세요.

## Windows 개발

Node.js **20.18.2**(`.nvmrc`), Python 3.10, Rust, Visual Studio Build Tools/MSBuild 및 프로젝트 native 의존성이 필요합니다. 환경 스크립트는 상위 폴더의 `.toolchain`을 찾습니다. Git clone만으로 toolchain이나 운영 AI 환경이 자동 구성되지는 않습니다.

준비된 개발 환경에서 source root를 기준으로 실행합니다.

```powershell
. .\scripts\activate-build-env.ps1
npm run compile
npm run buildreact
```

의존성 설치·native 빌드 순서는 [postinstall 코드](build/npm/postinstall.js)와 프로젝트 환경에 맞춰 확인하세요. 다른 Node 버전으로 생성된 native 결과를 그대로 사용하지 마세요.

Focused 검증 예시:

```powershell
npm run test-browser-no-install -- --browser chromium --sequential --run src/vs/workbench/contrib/void/test/browser/agentSubagentService.test.ts
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-release-focused-pass-counts.ps1
```

테스트는 최신 컴파일 결과를 사용합니다. React 기반 테스트는 먼저 `buildreact`가 필요합니다. Windows 비압축 build는 React 생성 후 `npm run gulp -- vscode-win32-x64`로 실행합니다.

## 배포와 자동화

정식 Windows portable release의 단일 진입점은 [release-win32-x64-portable.ps1](scripts/release-win32-x64-portable.ps1)입니다. Clean install, 테스트, build, candidate 검증과 게시 절차를 포함하며 일반 개발 build와 다릅니다. 일부 검증은 실제 AI 요청을 수행할 수 있으므로 실행 환경·비용·배포 범위를 확인한 뒤 운영자가 실행해야 합니다.

Upstream 이슈를 AI로 분류하고 wiki에 자동 push하던 예약 workflow와 연결 스크립트는 이 fork에서 제거했습니다. 현재 checked-in GitHub Actions workflow는 없습니다. 필요한 CI는 별도 범위로 설계합니다. Source에는 과거 local-only 정책의 push 차단 hook을 두지 않지만, 이것이 자동 push나 branch 보호 해제를 의미하지는 않습니다.

## 라이선스와 출처

- Void 추가·수정분: [Apache License 2.0](LICENSE.txt). 해당 파일의 copyright notice는 Glass Devtools, Inc.를 명시합니다.
- 기반 Code - OSS: [MIT License 및 Microsoft 저작권 고지](LICENSE-VS-Code.txt).
- 제3자 구성요소: [ThirdPartyNotices.txt](ThirdPartyNotices.txt) 및 각 구성요소의 라이선스.

이는 모든 파일을 MIT/Apache 중 임의 선택해 사용할 수 있다는 뜻이 아닙니다. 원 저작권·license·관련 NOTICE를 유지하고 수정·재배포 조건을 각 적용 범위에 따라 확인해야 합니다.

2026-09-07 source 검토에서 단일 MIT metadata와 Apache license 링크의 불일치, build에서 별도 Code - OSS MIT 고지가 빠질 위험을 발견했습니다. 전체 dependency·실제 배포물 적합성은 아직 검증하지 않았습니다. 또한 현재 source에 Microsoft Marketplace 설정이 남아 있으며, [Microsoft 공식 FAQ](https://code.visualstudio.com/docs/supporting/faq)는 Code - OSS fork의 Marketplace 접근을 허용하지 않습니다. 해당 서비스와 제한된 extension의 사용 권한을 소스 라이선스로 대신할 수 없습니다. 이 항목들은 해결 완료로 표시하지 않습니다.

## 문제 보고

이 fork의 문제는 [이 저장소의 Issues](https://github.com/seungsura/void2_gp/issues)에 재현 절차, source commit/앱 버전, OS, 기대 결과·실제 결과를 함께 남겨 주세요. 인증 정보, 내부 서버 정보, 개인 코드와 원문 대화는 제거해 주세요.
