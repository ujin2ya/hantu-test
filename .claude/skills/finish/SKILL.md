---
name: finish
description: Commit all current changes and push to the remote. Use when the user says "finish", "마무리", "커밋하고 푸시", or invokes /finish — this skill stages pending work, creates a single commit with a message inferred from the diff, and pushes to the tracking branch.
---

# finish

현재 작업 중인 변경사항을 커밋하고 원격으로 푸시한다.

## 수행 절차

아래 단계를 순서대로 수행한다. 1~3번은 병렬로 실행해도 좋다.

1. `git status` 로 변경/untracked 파일을 파악한다 (`-uall` 금지).
2. `git diff` (+ 이미 staged 된 항목은 `git diff --staged`) 로 실제 변경 내용을 확인한다.
3. `git log -n 5 --oneline` 로 이 저장소의 커밋 메시지 스타일을 참고한다.
4. 현재 브랜치가 원격을 추적하는지 확인한다: `git rev-parse --abbrev-ref --symbolic-full-name @{u}` — 실패하면 첫 푸시에서 `-u origin <branch>` 가 필요하다.

## 스테이징 & 커밋

- 변경사항이 하나도 없으면 (`git status --porcelain` 빈 문자열) 빈 커밋을 만들지 말고 사용자에게 "커밋할 변경사항이 없다"고 알리고 종료한다.
- `.env`, `*.pem`, `credentials*`, `*.key` 등 민감 파일이 변경/추가 목록에 있으면 **자동으로 스테이징하지 말고** 사용자에게 경고하고 확인을 받는다.
- 그 외에는 변경된 파일을 이름으로 명시해 추가한다 (`git add <file1> <file2> ...`). `git add -A` / `git add .` 은 피한다.
- diff 내용을 바탕으로 1~2 문장의 간결한 커밋 메시지를 직접 작성한다. 무엇을 했는지(what)보다 왜 했는지(why)에 무게를 둔다. 저장소의 기존 커밋 스타일(한국어/영어, prefix 유무 등)에 맞춘다.
- HEREDOC으로 커밋 메시지를 전달한다:

```bash
git commit -m "$(cat <<'EOF'
<커밋 메시지 본문>

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- pre-commit 훅이 실패하면 원인을 고치고 **새 커밋**을 만든다. `--amend` 는 쓰지 않는다.
- `--no-verify` / `--no-gpg-sign` 등 훅/서명 우회 플래그는 사용자가 명시적으로 요청하지 않는 한 절대 쓰지 않는다.

## 푸시

- 사용자는 메인 브랜치 직접 푸시를 상시 허용했다. `main` / `master` 여도 **확인 없이 바로 푸시**한다.
- 업스트림이 없으면 `git push -u origin <현재 브랜치>`.
- 있으면 `git push`.
- **절대** `--force` / `-f` / `--force-with-lease` 를 사용자가 요청하지 않았는데 쓰지 않는다.

## 완료 보고

한두 문장으로:
- 생성된 커밋 해시 + 제목
- 푸시된 원격/브랜치
- 다음에 권할 만한 것(PR 생성 등)이 있다면 한 줄 제안 (명령은 실행하지 않음)

## 하지 말 것

- 확인 없이 민감 파일을 커밋
- `git add -A`, `git add .`, `git commit -am` 로 무차별 스테이징
- `--amend` 로 기존 커밋 수정
- 메인/마스터 브랜치에 `--force` 계열로 푸시
- 사용자 요청 없이 브랜치를 새로 만들거나, 리베이스, 스태시 처리
