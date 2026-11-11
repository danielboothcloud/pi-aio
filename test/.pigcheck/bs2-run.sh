#!/bin/sh
# Scratch pig check for the Go browser-search fetch chain (bs2): starts the
# scripted model server (yh_server.py with SCRIPT, default bs2-script.json)
# and bs2-mock.py (a local proxy that serves the pages), runs the given
# command in bs2-work/, then stops both servers. No real model calls; no
# external network. The Camoufox worker files go to bs2-worker/.
cd "$(dirname "$0")"
rm -rf bs2-work && mkdir -p bs2-work agent-bs2
export YH_SCRIPT="$(cat ${SCRIPT:-bs2-script.json})" FIXTURE_LOG=$PWD/bs2-fixture.log BS2_MOCK_LOG=$PWD/bs2-mock.log
rm -f bs2-fixture.log bs2-mock.log
python3 yh_server.py > bs2-port 2>bs2-server.err &
SERVER=$!
python3 bs2-mock.py > bs2-mock-port 2>bs2-mock.err &
MOCK=$!
sleep 1
P=$(cat bs2-mock-port)
printf '{}\n' > agent-bs2/settings.json
export FIXTURE_PORT=$(cat bs2-port) PIG_CODING_AGENT_DIR=$PWD/agent-bs2 \
  BROWSER_SEARCH_CAMOUFOX_PROXY=http://127.0.0.1:$P HTTP_PROXY=http://127.0.0.1:$P NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost \
  BROWSER_SEARCH_CAMOUFOX_WORKER_DIR=$PWD/bs2-worker
cd bs2-work
"$@"
STATUS=$?
kill $SERVER $MOCK
exit $STATUS
