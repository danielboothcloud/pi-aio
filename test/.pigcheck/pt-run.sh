#!/bin/sh
# Scratch pig check for pretty-tools and copy-widget: resets pt-work/, starts the
# scripted server with SCRIPT (default pt-script.tmpl), runs pig with the
# given args in pt-work/, stops the server.
cd "$(dirname "$0")"
rm -rf pt-work && mkdir -p pt-work/src
printf 'const a = 1;\nconst foo = 2;\n// note\nexport { a, foo };\n' > pt-work/a.ts
printf 'def f():\n    return 1\n' > pt-work/src/b.py
printf 'foo bar\nbaz\n' > pt-work/notes.txt
D=$PWD/pt-work
export YH_SCRIPT="$(sed "s#@@D@@#$D#g" ${SCRIPT:-pt-script.tmpl})" FIXTURE_LOG=$PWD/pt-fixture.log
rm -f pt-fixture.log
python3 yh_server.py > pt-port 2>pt-server.err &
SERVER=$!
sleep 1
export FIXTURE_PORT=$(cat pt-port) PIG_CODING_AGENT_DIR=/Users/danielbooth/projects/work/danielboothcloud/pi-aio/test/.pigcheck/agent-pt
cd pt-work
"$@"
STATUS=$?
kill $SERVER
exit $STATUS
