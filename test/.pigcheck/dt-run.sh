#!/bin/sh
# Scratch pig check for diff-tools: resets dt/, starts the scripted server,
# runs pig with the given mode args, stops the server.
cd "$(dirname "$0")"
rm -rf dt && mkdir -p dt
printf 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n' > dt/e.ts
printf 'old\n' > dt/w.txt
printf 'one\ntwo\n' > dt/p.ts
D=$PWD/dt
export YH_SCRIPT="$(sed "s#@@D@@#$D#g" ${SCRIPT:-dt-script.tmpl})" FIXTURE_LOG=$PWD/dt.log
rm -f dt.log
python3 yh_server.py > dt.port 2>dt-server.err &
SERVER=$!
sleep 1
export FIXTURE_PORT=$(cat dt.port) PIG_CODING_AGENT_DIR=$PWD/agent-dt
"$@"
STATUS=$?
kill $SERVER
exit $STATUS
