#!/usr/bin/env bash
# Rebuild the OTP graph from otp-data using the project-local JDK.
set -euo pipefail
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA="$PROJECT_DIR/otp-data"
JAVA_HOME="$(ls -d "$HOME/.local/jdks"/jdk-*/ 2>/dev/null | sort -V | tail -1)"
exec "${JAVA_HOME}bin/java" "-Xmx${OTP_HEAP:-8G}" -jar "$DATA/otp-shaded-2.9.0.jar" --build --save "$DATA"
