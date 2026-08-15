#!/usr/bin/env bash
# Start the server. The JDK is the isolated one under ~/jdks, never a brew
# install, because a brew install is what breaks ffmpeg on this machine.
set -euo pipefail
cd "$(dirname "$0")"
export JAVA_HOME="${JAVA_HOME:-$HOME/jdks/jdk-21.0.12+8/Contents/Home}"
echo "open http://localhost:${ORRERY_PORT:-7070} once it says listening"
exec ./gradlew :server:run -q
