# Void project rules

이 파일은 Git root `C:\Users\seungsura\void2\void-main\void-main` 전체에 적용되는 OpenAI Codex 프로젝트 지침입니다. 프로젝트 문서는 `C:\Users\seungsura\void2\spec`에서 관리합니다.

## 0순위 절대 규칙: 사용자 정렬과 학습 속도

- 기능 구현 속도보다 사용자의 이해, 판단, 학습 속도를 우선합니다.
- 사용자가 아직 검토·승인하지 않은 다음 단계 기능을 먼저 구현하지 않습니다. 읽기 전용 조사와 설명 준비는 가능하지만 실질 구현은 정렬 후 시작합니다.
- 한 번에 하나의 기능 또는 동작 단위만 다룹니다. 현재 스펙, 실제 문제, 참조 구현, 최소 변경안, 변경하지 않을 범위, 평가 기준을 먼저 설명합니다.
- 추천할 때는 선택지, 추천안, 근거, trade-off와 실패 가능성을 함께 제시합니다. 사용자의 답을 추정으로 대신하지 않습니다.
- 각 단계가 끝나면 사용자가 핵심 구조를 자신의 말로 설명할 수 있는지, 추가 설명이나 직접 실습이 필요한지 확인한 뒤 다음 단계로 진행합니다.
- Codex/OpenCode는 비교·학습 자료입니다. 최신이라는 이유만으로 대량 이식하지 않고 Void에 필요한 동작만 외과 수술적으로 적용합니다.
- 프로젝트 목적과 단계별 gate는 `C:\Users\seungsura\void2\spec\project-charter.md`, 인터뷰 결과와 미결정 사항은 `C:\Users\seungsura\void2\spec\project-alignment-interview.md`를 기준으로 합니다.

## OpenAI 규격 우선

- AGENTS.md와 SKILL.md를 구성할 때 현재 공개된 OpenAI Codex 규격을 normative source로 사용합니다.
- repository skill은 `.agents\skills\<skill-name>\SKILL.md`에 둡니다. `.codex\skills`를 repository skill 위치로 사용하지 않습니다.
- AGENTS 지침의 root-to-current-directory 병합, `AGENTS.override.md` 우선순위, 크기 제한을 고려합니다.
- 로컬 Codex 소스는 규격의 구현을 공부하는 자료이며, OpenCode는 비교 자료입니다. 두 구현이 OpenAI 공개 규격과 다르면 OpenAI 규격을 우선합니다.
- 확인한 규격과 프로젝트 적용 상태는 `C:\Users\seungsura\void2\spec\openai-agent-conformance.md`에 기록합니다.

## 문서 저장 규칙

- 새 프로젝트 문서, 작업 계획, 설계·결정 기록, 빌드/테스트 보고서와 오류 방지 기록은 모두 `C:\Users\seungsura\void2\spec` 아래에 Markdown(`.md`)으로 저장합니다.
- 문서 파일명은 기본적으로 소문자 kebab-case를 사용합니다. 기존 문서를 수정할 때는 기존 이름을 유지합니다.
- 작업이 끝나면 관련 문서를 갱신하고 `C:\Users\seungsura\void2\spec\index.md`도 갱신합니다.
- 사실, 추론, 임시 우회책, 영구 해결책과 미검증 항목을 구분합니다.
- 이 `AGENTS.md`, `.agents\` skill 파일, `.codex\` 설정과 같은 기계 판독 운영 파일은 위치 예외입니다. 그 외 프로젝트 문서는 `spec` 밖에 만들지 않습니다.

## 작업 전후 절차

1. 작업 전에 이 파일, `spec\index.md`, `spec\project-charter.md`를 읽고 작업 유형에 맞는 문서를 확인합니다.
2. 기능 변경 전 현재 동작과 사용자가 선택한 문제를 문서화합니다.
3. 패키징 오류는 별도 오류 파일이 아니라 `spec\packaging-guide.md`의 해당 절차에 원인과 재발 방지를 추가합니다.
4. 작업 종료 시 변경 파일, 검증 명령, 성공·실패·미검증 항목과 학습 내용을 기록합니다.

## 빌드 환경 규칙

- `.nvmrc`의 Node `20.18.2`와 `C:\Users\seungsura\void2\.toolchain`의 프로젝트 로컬 도구를 사용합니다.
- 빌드 전 `scripts\activate-build-env.ps1`를 실행합니다.
- native 의존성 설치는 `npm ci --ignore-scripts` 후 필요한 postinstall을 수행합니다. 루트에서 무조건 `npm rebuild`를 실행하지 않습니다.
- React 산출물이 필요한 빌드는 `npm run buildreact` 후 `npm run gulp vscode-win32-x64`를 실행합니다.
- `vscode-win32-x64-min`은 mangler `OVERLAPPING edit`가 해결되기 전까지 기본 경로로 사용하지 않습니다.
- `node_modules`의 Spectre 설정 제거는 임시 우회책입니다. clean install 재현성을 보장하지 않습니다.
- 사용자 승인 없이 `npm audit fix`를 실행하지 않습니다.

## portable 패키징 규칙

- 산출물 폴더는 `C:\Users\seungsura\void2\void-main\VSCode-win32-x64`입니다.
- `scripts\package-portable.ps1`만 표준 패키징 경로로 사용합니다.
- 패키지 디렉터리에는 최신 `Void-*-win32-x64-portable.zip` 하나만 유지합니다.
- 테스트 실행으로 생성된 `data\argv.json`과 `data\user-data`는 ZIP에 포함하지 않습니다.
- `Void.exe`, 제품 메타데이터, portable data, ZIP entry와 SHA-256을 검증합니다.

## local-only Git 규칙

- 이 저장소는 local `.git`으로만 관리하고 remote를 등록하지 않습니다.
- `.void\git-hooks\pre-push`, `remote.pushDefault=local-only-disabled`, `push.default=nothing`을 유지합니다.
- local commit/branch/tag/diff/log만 허용합니다. 정책 변경 확인 없이 remote add/push/fetch/pull을 실행하지 않습니다.
- 세부 규칙은 `C:\Users\seungsura\void2\spec\local-git-policy.md`를 따릅니다.

## 완료 기준

- 사용자가 선택한 동작의 수용 기준을 통과합니다.
- 회귀, 성능과 실패 경로를 적절한 테스트 또는 측정으로 확인합니다.
- 사용자가 핵심 구조와 trade-off를 자신의 말로 설명할 수 있는지 확인합니다.
- 성공·실패·미검증 항목과 다음 결정 gate를 문서화합니다.
