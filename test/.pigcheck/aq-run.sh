#!/bin/sh
# Scratch pig check for ask-user-question: resets aq-work/, starts the
# scripted server with aq-script.json, runs pig with the given args in
# aq-work/, stops the server. No real model calls.
cd "$(dirname "$0")"
rm -rf aq-work && mkdir -p aq-work
export YH_SCRIPT="$(cat ${SCRIPT:-aq-script.json})" FIXTURE_LOG=$PWD/aq-fixture.log
rm -f aq-fixture.log
python3 yh_server.py > aq-port 2>aq-server.err &
SERVER=$!
sleep 1
export FIXTURE_PORT=$(cat aq-port) PIG_CODING_AGENT_DIR=$PWD/agent-aq
cd aq-work
"$@"
STATUS=$?
kill $SERVER
exit $STATUS
