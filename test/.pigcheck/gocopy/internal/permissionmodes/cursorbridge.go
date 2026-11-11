package permissionmodes

// BridgeChange is the change CursorBridge.Sync asks the caller to make to the
// shared environment that Node providers read.
type BridgeChange int

const (
	// BridgeKeep changes nothing.
	BridgeKeep BridgeChange = iota
	// BridgeEnable sets CursorBridgeBuiltinsEnv to "1".
	BridgeEnable
	// BridgeDisable deletes CursorBridgeBuiltinsEnv.
	BridgeDisable
)

// CursorBridge is the Cursor bridge switch of syncCursorPermissionBridge in
// permission-modes/index.ts. In default mode with the cursor provider, it sets
// CursorBridgeBuiltinsEnv so pi-cursor-sdk exposes pi__edit, pi__write,
// pi__apply_patch and pi__bash. It never overrides a value the user set
// before pig started, and it deletes only a value it set itself.
//
// TypeScript reads and writes the one process.env that Pi shares with the
// provider. A Go extension writes PiG's shared environment instead (PiG
// divergence D234), which this process does not see, so CursorBridge keeps the
// value the provider reads: the inherited value, or "1" while it is enabled.
type CursorBridge struct {
	inherited    string
	inheritedSet bool
	enabled      bool
}

// NewCursorBridge starts from the value pig inherited, as os.LookupEnv
// reports it.
func NewCursorBridge(value string, set bool) CursorBridge {
	return CursorBridge{inherited: value, inheritedSet: set}
}

// Value is process.env[CursorBridgeBuiltinsEnv] as the provider reads it, and
// whether it is set.
func (b *CursorBridge) Value() (string, bool) {
	if b.enabled {
		return "1", true
	}
	return b.inherited, b.inheritedSet
}

// Sync returns the change syncCursorPermissionBridge makes for provider and
// mode. Call Commit after the change is applied.
func (b *CursorBridge) Sync(provider string, mode Mode) BridgeChange {
	shouldEnable := provider == "cursor" && mode == ModeDefault
	_, set := b.Value()
	switch {
	case shouldEnable && !set:
		return BridgeEnable
	case !shouldEnable && b.enabled:
		return BridgeDisable
	}
	return BridgeKeep
}

// Shutdown returns the change of the session_shutdown handler: the switch
// goes only if CursorBridge enabled it.
func (b *CursorBridge) Shutdown() BridgeChange {
	if b.enabled {
		return BridgeDisable
	}
	return BridgeKeep
}

// Commit records that change was applied.
func (b *CursorBridge) Commit(change BridgeChange) {
	switch change {
	case BridgeEnable:
		b.enabled = true
	case BridgeDisable:
		b.enabled = false
	}
}
