#!/bin/sh
# Scratch pig check for browser-search: starts the scripted model server
# (yh_server.py with SCRIPT, default bs-script.json) and bs-mock.py (local
# SearXNG, Exa, Camofox, and HTML page), writes agent-bs/settings.json for
# PROVIDER (searxng or exa), runs pig with the given args in bs-work/, then
# stops both servers. No real model calls; no external network.
cd "$(dirname "$0")"
rm -rf bs-work && mkdir -p bs-work
export YH_SCRIPT="$(cat ${SCRIPT:-bs-script.json})" FIXTURE_LOG=$PWD/bs-fixture.log BS_MOCK_LOG=$PWD/bs-mock.log
rm -f bs-fixture.log bs-mock.log
python3 yh_server.py > bs-port 2>bs-server.err &
SERVER=$!
python3 bs-mock.py > bs-mock-port 2>bs-mock.err &
MOCK=$!
sleep 1
P=$(cat bs-mock-port)
if [ "${PROVIDER:-searxng}" = none ]; then
  printf '{}\n' > agent-bs/settings.json
elif [ "${PROVIDER:-searxng}" = exa ]; then
  printf '{"aio":{"browserSearch":{"provider":"exa","exa":{"baseUrl":"http://127.0.0.1:%s/exa","apiKeyEnv":"BS_LOCAL_EXA_KEY"}}}}\n' $P > agent-bs/settings.json
else
  printf '{"aio":{"browserSearch":{"provider":"searxng","searxng":{"baseUrl":"http://127.0.0.1:%s/sx/"}}}}\n' $P > agent-bs/settings.json
fi
printf '#!/bin/sh\nexec node "%s"\n' "$(cd .. && pwd)/../browser-search/test-fixture-cloak-worker.mjs" > bs-node-wrapper.sh
chmod +x bs-node-wrapper.sh
export FIXTURE_PORT=$(cat bs-port) PIG_CODING_AGENT_DIR=$PWD/agent-bs \
  BROWSER_SEARCH_CAMOFOX_BASE=http://127.0.0.1:$P/cf BROWSER_SEARCH_NODE_BINARY=$PWD/bs-node-wrapper.sh \
  BS_LOCAL_EXA_KEY=local-test-key CAMOFOX_API_KEY=local-cf-key
cd bs-work
"$@"
STATUS=$?
kill $SERVER $MOCK
exit $STATUS
