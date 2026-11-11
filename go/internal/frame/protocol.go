package frame

import "sync"

// The frame protocol (port of frame/protocol.ts). TypeScript features probe
// the frame through a synchronous event-bus call that mutates the payload;
// PiG's event bus carries JSON by value, so the Go features of one extension
// share this package state instead.

// CapabilityEvent is FRAME_CAPABILITY_EVENT.
const CapabilityEvent = "aio:minimal-frame-capability"

// UIStateEvent is AIO_UI_STATE_EVENT.
const UIStateEvent = "aio:ui-state"

// CapabilityVersion is FRAME_CAPABILITY_VERSION.
const CapabilityVersion = 1

// Capability is FrameCapability.
type Capability struct {
	Supported bool `json:"supported"`
	Active    bool `json:"active"`
	Version   int  `json:"version,omitempty"`
}

type contributor struct {
	key string
	fn  func() Contribution
}

var (
	mu           sync.Mutex
	supported    bool
	active       bool
	queuePanel   func() []string
	contributors []contributor
	repaintHook  func()
)

// SetSupported marks the frame registered (`supported` is true from
// registration, so earlier registrars know the frame exists).
func SetSupported(value bool) {
	mu.Lock()
	supported = value
	mu.Unlock()
}

// SetActive marks a TUI session that installed the frame editor.
func SetActive(value bool) {
	mu.Lock()
	active = value
	mu.Unlock()
}

// Probe is probeFrameEditor.
func Probe() Capability {
	mu.Lock()
	defer mu.Unlock()
	if !supported {
		return Capability{}
	}
	return Capability{Supported: true, Active: active, Version: CapabilityVersion}
}

// SetQueuePanelLinesProvider is setQueuePanelLinesProvider.
func SetQueuePanelLinesProvider(provider func() []string) {
	mu.Lock()
	queuePanel = provider
	mu.Unlock()
}

// QueuePanelLines is getQueuePanelLines: a panicking provider gives none.
func QueuePanelLines() (lines []string) {
	mu.Lock()
	provider := queuePanel
	mu.Unlock()
	if provider == nil {
		return nil
	}
	defer func() {
		if recover() != nil {
			lines = nil
		}
	}()
	return provider()
}

// SetMetadataContributor is setFrameMetadataContributor: nil removes the
// key. A key keeps its first insertion position, as a Map does.
func SetMetadataContributor(key string, fn func() Contribution) {
	mu.Lock()
	defer mu.Unlock()
	for i, c := range contributors {
		if c.key == key {
			if fn == nil {
				contributors = append(contributors[:i:i], contributors[i+1:]...)
			} else {
				contributors[i].fn = fn
			}
			return
		}
	}
	if fn != nil {
		contributors = append(contributors, contributor{key, fn})
	}
}

// ContributedMetadata is contributedFrameMetadata: every contribution merged
// in insertion order; a panicking contributor is skipped.
func ContributedMetadata() Contribution {
	mu.Lock()
	list := append([]contributor(nil), contributors...)
	mu.Unlock()
	var merged Contribution
	for _, c := range list {
		func() {
			defer func() { _ = recover() }()
			part := c.fn()
			if part.Mode != nil {
				merged.Mode = part.Mode
			}
			if part.Style != nil {
				merged.Style = part.Style
			}
			if part.Recipe != nil {
				merged.Recipe = part.Recipe
			}
			if part.Btw != nil {
				merged.Btw = part.Btw
			}
			if part.Quota != nil {
				merged.Quota = part.Quota
			}
		}()
	}
	return merged
}

// SetRepaintHook is setFrameRepaintHook.
func SetRepaintHook(hook func()) {
	mu.Lock()
	repaintHook = hook
	mu.Unlock()
}

// RequestRepaint is requestFrameRepaint (best-effort).
func RequestRepaint() {
	mu.Lock()
	hook := repaintHook
	mu.Unlock()
	if hook == nil {
		return
	}
	defer func() { _ = recover() }()
	hook()
}

// ResetForTest clears the package state.
func ResetForTest() {
	mu.Lock()
	supported, active, queuePanel, contributors, repaintHook = false, false, nil, nil, nil
	mu.Unlock()
}
