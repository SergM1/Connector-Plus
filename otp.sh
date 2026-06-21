#!/usr/bin/env bash
# Run OpenTripPlanner 2 with the project-local Temurin JDK 21 (no Docker, no sudo).
#
#   ./otp.sh build   -> build + save the graph from otp-data/
#   ./otp.sh serve   -> load the saved graph and serve API + debug UI on :8080
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# OTP 2.9 is compiled for Java 25; prefer the highest JDK version available.
JAVA_HOME="$(ls -d "$HOME/.local/jdks"/jdk-*/Contents/Home 2>/dev/null | sort -V | tail -1)"
JAVA="$JAVA_HOME/bin/java"
JAR="$PROJECT_DIR/otp-data/otp-shaded-2.9.0.jar"
DATA="$PROJECT_DIR/otp-data"
HEAP="${OTP_HEAP:-6G}"

if [ ! -x "$JAVA" ]; then
  echo "JDK not found under ~/.local/jdks" >&2
  exit 1
fi

case "${1:-}" in
  build)
    exec "$JAVA" "-Xmx${HEAP}" -jar "$JAR" --build --save "$DATA"
    ;;
  serve)
    exec "$JAVA" "-Xmx${HEAP}" -jar "$JAR" --load "$DATA"
    ;;
  *)
    echo "usage: $0 {build|serve}" >&2
    exit 2
    ;;
esac
