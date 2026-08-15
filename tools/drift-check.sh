#!/usr/bin/env bash
# Generate the fixture from the Java simulation, replay it through the
# JavaScript one, and fail if they disagree by a single bit.
set -euo pipefail
cd "$(dirname "$0")/.."
export JAVA_HOME="${JAVA_HOME:-$HOME/jdks/jdk-21.0.12+8/Contents/Home}"

fixture="$(mktemp -t orrery-drift).json"
trap 'rm -f "$fixture"' EXIT

./gradlew -q :server:driftFixture > "$fixture"
node tools/drift-check.mjs "$fixture"
