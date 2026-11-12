#!/bin/sh
# Scratch pig check for the recipes, hypa MCP bridge, and notification
# events port. RC_CWD (under rc-work/) is the session folder; recipes and
# trust go to scratch files; the scripted server (ui-server.py, RC_SCRIPT)
# answers model requests. No real model calls.
cd "$(dirname "$0")"
HERE=$PWD
export YH_SCRIPT="$(cat ${RC_SCRIPT:-rc-script.json})" FIXTURE_LOG=$HERE/rc-fixture.log
python3 ui-server.py > rc-port 2>rc-server.err &
SERVER=$!
sleep 1
export FIXTURE_PORT=$(cat rc-port) PIG_CODING_AGENT_DIR=$HERE/agent-rc
export AIO_RECIPES_FILE=${RC_RECIPES:-$HERE/rc-home-recipes.json} AIO_RECIPE_TRUST_FILE=$HERE/rc-trust.json RC_EVENTS_LOG=$HERE/rc-events.log
mkdir -p "$RC_CWD"
cd "$RC_CWD"
"$@"
STATUS=$?
kill $SERVER
exit $STATUS
