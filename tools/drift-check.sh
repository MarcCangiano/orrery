#!/usr/bin/env bash
# Generate the fixture from the Java simulation, replay it through the
# JavaScript one, and fail if they disagree by a single bit.
set -euo pipefail
cd "$(dirname "$0")/.."
export JAVA_HOME="${JAVA_HOME:-$HOME/jdks/jdk-21.0.12+8/Contents/Home}"

# BSD mktemp treats -t as a bare prefix; GNU mktemp demands XXXXXX in the
# template and exits 1 without it. This ran clean on macOS for the life of the
# project and failed on the very first CI run, because CI is Linux and this was
# the first push. An explicit template is portable to both.
fixture="$(mktemp "${TMPDIR:-/tmp}/orrery-drift.XXXXXX").json"
trap 'rm -f "$fixture"' EXIT

./gradlew -q :server:driftFixture > "$fixture"
node tools/drift-check.mjs "$fixture"
