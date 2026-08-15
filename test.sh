#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
export JAVA_HOME="${JAVA_HOME:-$HOME/jdks/jdk-21.0.12+8/Contents/Home}"
exec ./gradlew :server:test
