#!/bin/sh
# Scratch hypa binary for the MCP proxy bridge pig check: logs its argv and
# answers `hypa mcp ...` with fixed JSON. No network, no real hypa.
printf '%s\n' "$*" >> "${RC_HYPA_LOG:-/dev/null}"
case "$1 $2" in
"mcp list") echo '[{"name":"docs","transport":"http","endpoint":"https://d","auth":"oauth"},{"name":"fresh","transport":"stdio","endpoint":null}]' ;;
"mcp invoke") echo '{"serverName":"fresh","toolName":"q","compressedResponse":"mock invoke ok"}' ;;
"mcp schema") echo '{"servers":[{"serverName":"fresh","tools":[{"name":"q","description":"Query","inputSchema":{"type":"object","properties":{"b":{},"a":{}}}}]}]}' ;;
"rewrite --json") printf '{"input":%s,"outcome":"Passthrough","command":%s}\n' "\"$3\"" "\"$3\"" ;;
*) echo "unexpected: $*" >&2; exit 2 ;;
esac
