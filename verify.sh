#!/usr/bin/env bash
# Everything that can tell us the netcode is broken, in one command.
#
#   1. unit and integration tests
#   2. drift check: Java and JavaScript physics agree bit for bit
#   3. predict check: a real client's prediction matches the real server
#
# The third one starts a server on its own port and shuts it down after, so it
# never fights with one you already have running.
set -euo pipefail
cd "$(dirname "$0")"
export JAVA_HOME="${JAVA_HOME:-$HOME/jdks/jdk-21.0.12+8/Contents/Home}"

echo "--- tests"
./gradlew -q :server:test

echo
echo "--- drift check (java vs javascript physics)"
./tools/drift-check.sh

echo
echo "--- predict check (client prediction vs live server)"
port=$(( 20000 + RANDOM % 20000 ))
ORRERY_PORT="$port" ./gradlew -q :server:run > /tmp/orrery-verify.log 2>&1 &
gradle_pid=$!
cleanup() {
  kill "$gradle_pid" 2>/dev/null || true
  pkill -f "dev.cangiano.orrery.Main" 2>/dev/null || true
}
trap cleanup EXIT

for _ in $(seq 1 60); do
  if curl -s -o /dev/null "http://localhost:$port/"; then break; fi
  sleep 1
done

node tools/predict-check.mjs "ws://localhost:$port/ws"
echo
echo "all checks passed"
