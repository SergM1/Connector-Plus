#!/usr/bin/env bash
# Serve the prebuilt OTP graph on :8080 using the project-local JDK.
set -euo pipefail
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA="$PROJECT_DIR/otp-data"
JAVA_HOME="$(ls -d "$HOME/.local/jdks"/jdk-*/ 2>/dev/null | sort -V | tail -1)"
exec "${JAVA_HOME}bin/java" "-Xmx${OTP_HEAP:-6G}" -jar "$DATA/otp-shaded-2.9.0.jar" --load "$DATA"
