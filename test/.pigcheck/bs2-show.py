"""Print the tool events of a pig JSON run (bs2 check)."""
import json, sys
for l in open(sys.argv[1]):
    try: e=json.loads(l)
    except Exception: print("RAW", l[:200]); continue
    t=e.get("type")
    if t in ("tool_execution_start","tool_execution_end","tool_execution_update"):
        r=e.get("result") or e.get("partialResult") or {}
        c=r.get("content")
        if isinstance(c,list): c=" ".join(x.get("text","") for x in c)
        print(t, e.get("toolName"), json.dumps(e.get("args")) if t=="tool_execution_start" else "", (c or "")[:int(sys.argv[2]) if len(sys.argv)>2 else 500].replace("\n","\\n"), json.dumps(r.get("details")) if t=="tool_execution_end" else "")
    elif t=="message_end" and e.get("message",{}).get("role")=="assistant":
        print("assistant", json.dumps(e["message"].get("content"))[:200], e["message"].get("stopReason"))
