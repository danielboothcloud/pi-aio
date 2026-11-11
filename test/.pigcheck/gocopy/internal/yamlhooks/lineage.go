package yamlhooks

// Session lineage (port of yaml-hooks/session-lineage.ts): the root session
// id reachable from the current session by reading parentSession headers.

import (
	"encoding/json"
	"io"
	"os"
	"strings"
	"sync"
	"syscall"
)

const (
	maxLineageDepth     = 64
	maxHeaderBytes      = 64 * 1024
	sessionRootCacheMax = 64
)

// SessionHeader is the part of a session header that lineage reads.
type SessionHeader struct {
	ID            string
	ParentSession string // "" when absent
}

type lineageEntry struct{ session, root string }

var (
	lineageMu    sync.Mutex
	lineageCache []lineageEntry
)

func lineageGet(session string) (string, bool) {
	lineageMu.Lock()
	defer lineageMu.Unlock()
	for _, e := range lineageCache {
		if e.session == session {
			return e.root, true
		}
	}
	return "", false
}

func rememberSessionRoot(session, root string) {
	lineageMu.Lock()
	defer lineageMu.Unlock()
	for i, e := range lineageCache {
		if e.session == session {
			lineageCache = append(lineageCache[:i:i], lineageCache[i+1:]...)
			break
		}
	}
	lineageCache = append(lineageCache, lineageEntry{session, root})
	for len(lineageCache) > sessionRootCacheMax {
		lineageCache = lineageCache[1:]
	}
}

// GetRootSessionID is session-lineage.ts getRootSessionId. header is the
// session manager's current header (nil when unavailable).
func GetRootSessionID(current string, header *SessionHeader) string {
	if current == "" || header == nil {
		return current
	}
	if header.ID != current {
		if cached, ok := lineageGet(current); ok && cached != "" {
			return cached
		}
		return current
	}
	if cached, ok := lineageGet(current); ok && cached != "" {
		return cached
	}
	visited := map[string]bool{header.ID: true}
	cursor := header
	depth := 0
	for cursor.ParentSession != "" {
		depth++
		if depth > maxLineageDepth {
			break
		}
		parent := readSessionHeaderFromFile(cursor.ParentSession)
		if parent == nil || visited[parent.ID] {
			break
		}
		visited[parent.ID] = true
		cursor = parent
	}
	root := cursor.ID
	if root == "" {
		root = current
	}
	rememberSessionRoot(current, root)
	return root
}

func readSessionHeaderFromFile(path string) *SessionHeader {
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return nil
	}
	buf := make([]byte, maxHeaderBytes)
	n, err := io.ReadFull(f, buf)
	if err != nil && n == 0 {
		return nil
	}
	text := strings.ToValidUTF8(string(buf[:n]), "\uFFFD")
	first, _, _ := strings.Cut(text, "\n")
	if strings.TrimSpace(first) == "" {
		return nil
	}
	var parsed struct {
		Type          any `json:"type"`
		ID            any `json:"id"`
		ParentSession any `json:"parentSession"`
	}
	if json.Unmarshal([]byte(first), &parsed) != nil {
		return nil
	}
	typ, _ := parsed.Type.(string)
	id, ok := parsed.ID.(string)
	if typ != "session" || !ok {
		return nil
	}
	parent, _ := parsed.ParentSession.(string)
	return &SessionHeader{ID: id, ParentSession: parent}
}
