#!/bin/sh
# Scratch pig check for group 11 (frame, status-line, queue, session-nav):
# resets ui-work/ (a git repo), starts the scripted server with
# ${SCRIPT:-ui-script.json}, runs the command in ui-work/, stops the
# server. No real model calls.
cd "$(dirname "$0")"
rm -rf ui-work && mkdir -p ui-work
(cd ui-work && git init -q && git -c user.name=t -c user.email=t@e commit -q --allow-empty -m init && echo x > dirty.txt)
export YH_SCRIPT="$(cat ${SCRIPT:-ui-script.json})" FIXTURE_LOG=$PWD/ui-fixture.log
rm -f ui-fixture.log
python3 ui-server.py ${UI_PORT:-} > ui-port 2>ui-server.err &
SERVER=$!
sleep 1
export FIXTURE_PORT=$(cat ui-port) PIG_CODING_AGENT_DIR=$PWD/agent-ui
cd ui-work
"$@"
STATUS=$?
kill $SERVER
exit $STATUS
