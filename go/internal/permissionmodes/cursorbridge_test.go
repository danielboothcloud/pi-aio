package permissionmodes

import (
	"strings"
	"testing"
)

// The steps follow syncCursorPermissionBridge and the session_shutdown handler
// in permission-modes/index.ts, and the two index.test.ts cases that read
// process.env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS ("ask mode is passive..." and
// "Cursor default mode exposes bridge built-ins...").
func TestCursorBridgeFollowsSyncCursorPermissionBridge(t *testing.T) {
	type step struct {
		provider string
		mode     Mode
		shutdown bool
		want     BridgeChange
		value    string
		set      bool
	}
	cases := []struct {
		name         string
		inherited    string
		inheritedSet bool
		steps        []step
	}{
		{name: "cursor default enables, other modes and providers disable", steps: []step{
			{provider: "cursor", mode: ModeAsk, want: BridgeKeep},
			{provider: "cursor", mode: ModeDefault, want: BridgeEnable, value: "1", set: true},
			{provider: "cursor", mode: ModeDefault, want: BridgeKeep, value: "1", set: true},
			{provider: "cursor", mode: ModePlan, want: BridgeDisable},
			{provider: "cursor", mode: ModeDefault, want: BridgeEnable, value: "1", set: true},
			{provider: "anthropic", mode: ModeDefault, want: BridgeDisable},
			{provider: "cursor", mode: ModeAuto, want: BridgeKeep},
		}},
		{name: "shutdown deletes only the value it set", steps: []step{
			{shutdown: true, want: BridgeKeep},
			{provider: "cursor", mode: ModeDefault, want: BridgeEnable, value: "1", set: true},
			{shutdown: true, want: BridgeDisable},
			{shutdown: true, want: BridgeKeep},
		}},
		{name: "an inherited value is never overridden or deleted", inherited: "0", inheritedSet: true, steps: []step{
			{provider: "cursor", mode: ModeDefault, want: BridgeKeep, value: "0", set: true},
			{provider: "cursor", mode: ModeAsk, want: BridgeKeep, value: "0", set: true},
			{shutdown: true, want: BridgeKeep, value: "0", set: true},
		}},
		{name: "an inherited empty value counts as set", inherited: "", inheritedSet: true, steps: []step{
			{provider: "cursor", mode: ModeDefault, want: BridgeKeep, value: "", set: true},
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			b := NewCursorBridge(tc.inherited, tc.inheritedSet)
			for i, s := range tc.steps {
				var got BridgeChange
				if s.shutdown {
					got = b.Shutdown()
				} else {
					got = b.Sync(s.provider, s.mode)
				}
				if got != s.want {
					t.Fatalf("step %d: change = %d, want %d", i, got, s.want)
				}
				b.Commit(got)
				if value, set := b.Value(); value != s.value || set != s.set {
					t.Fatalf("step %d: value = %q, %v, want %q, %v", i, value, set, s.value, s.set)
				}
			}
		})
	}
}

// A change the host refused is not committed, so the mode context reports the
// bridge tools as unavailable and the next sync tries again.
func TestCursorBridgeUncommittedEnableStaysUnavailable(t *testing.T) {
	b := NewCursorBridge("", false)
	if got := b.Sync("cursor", ModeDefault); got != BridgeEnable {
		t.Fatalf("change = %d, want BridgeEnable", got)
	}
	value, set := b.Value()
	if !strings.Contains(ModeContext(ModeDefault, "cursor", value, set), "currently unavailable") {
		t.Fatal("mode context does not report the bridge tools as unavailable")
	}
	if got := b.Sync("cursor", ModeDefault); got != BridgeEnable {
		t.Fatalf("retry change = %d, want BridgeEnable", got)
	}
}
