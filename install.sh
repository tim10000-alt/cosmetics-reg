#!/usr/bin/env bash
# cosmetics-reg one-click installer (macOS / Linux)
# 다른 PC 에서 이 파일 하나만 빈 폴더에 두고 실행하면:
#   1) git 있으면 clone(자동갱신), 없으면 zip 다운로드
#   2) start.sh 실행 -> npm install + build + 서버 + 브라우저
# 두 번째부터는 cosmetics-reg/start.sh 만 실행하면 됩니다.
set -e
cd "$(dirname "$0")"
TARGET="$(pwd)/cosmetics-reg"
REPO="https://github.com/tim10000-alt/cosmetics-reg.git"
ZIP="https://github.com/tim10000-alt/cosmetics-reg/archive/refs/heads/main.zip"

echo "=================================================="
echo " cosmetics-reg installer"
echo "=================================================="

if [ -f "$TARGET/start.sh" ]; then
  echo "기존 설치 발견 -> 실행 (재설치하려면 $TARGET 삭제 후 다시 실행)"
  cd "$TARGET"; exec bash start.sh
fi

if command -v git >/dev/null 2>&1; then
  echo "git 감지 - clone (매일 자동갱신 가능)..."
  git clone --depth 1 "$REPO" "$TARGET" || true
fi

if [ ! -f "$TARGET/start.sh" ]; then
  echo "zip 다운로드 (~60 MB)..."
  tmp="$(mktemp -d)"
  curl -fsSL "$ZIP" -o "$tmp/creg.zip"
  unzip -q "$tmp/creg.zip" -d "$tmp"
  rm -rf "$TARGET"
  mv "$tmp/cosmetics-reg-main" "$TARGET"
  rm -rf "$tmp"
fi

if [ ! -f "$TARGET/start.sh" ]; then
  echo "[X] 설치 실패 - 인터넷/방화벽 확인. 수동: $ZIP 다운로드 후 압축 풀고 start.sh 실행"
  exit 1
fi

echo "설치 완료 -> $TARGET"
cd "$TARGET"; exec bash start.sh
