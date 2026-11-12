package piglaunch

// Read-only session lookup (port of pi-shim.ts SessionManager and
// SettingsManager), which mirrors Pi's SessionManager over the session file
// format PiG shares: the leaf is the last non-header entry, and --continue
// picks the newest `.jsonl` by mtime.

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// entry is one parsed session line. JSON.parse keeps objects and arrays;
// an array has none of these fields.
type entry struct {
	fields   map[string]any
	isObject bool
}

func (e entry) str(key string) (string, bool) {
	s, ok := e.fields[key].(string)
	return s, ok
}

// parseLine is pi-shim.ts parseLine: a blank or invalid line, or JSON that
// is not an object or array, is no entry.
func parseLine(line string) (entry, bool) {
	if jsTrim(line) == "" {
		return entry{}, false
	}
	var value any
	if err := json.Unmarshal([]byte(line), &value); err != nil {
		return entry{}, false
	}
	switch v := value.(type) {
	case map[string]any:
		return entry{fields: v, isObject: true}, true
	case []any:
		return entry{fields: map[string]any{}}, true
	}
	return entry{}, false
}

const headerScanBytes = 1024 * 1024

// readHeader returns the session header (the first parsed line) when the
// file is a session.
func readHeader(path string) (entry, bool) {
	file, err := os.Open(path)
	if err != nil {
		return entry{}, false
	}
	defer file.Close()
	buffer := make([]byte, headerScanBytes)
	n, err := io.ReadFull(file, buffer)
	if err != nil && err != io.ErrUnexpectedEOF && err != io.EOF {
		return entry{}, false
	}
	for _, line := range strings.Split(string(bytes.ToValidUTF8(buffer[:n], []byte("\uFFFD"))), "\n") {
		if jsTrim(line) == "" {
			continue
		}
		parsed, ok := parseLine(line)
		if !ok {
			continue
		}
		kind, _ := parsed.str("type")
		_, hasID := parsed.str("id")
		if kind == "session" && hasID {
			return parsed, true
		}
		return entry{}, false
	}
	return entry{}, false
}

type sessionInfo struct {
	path  string
	id    string
	cwd   string
	hasCwd bool
	mtime int64
}

var sessionDirUnsafe = regexp.MustCompile(`[/\\:]`)

func (e Env) defaultSessionDir(cwd string) string {
	resolved := e.resolvePath(cwd)
	trimmed := resolved
	if strings.HasPrefix(trimmed, "/") || strings.HasPrefix(trimmed, `\`) {
		trimmed = trimmed[1:]
	}
	safe := "--" + sessionDirUnsafe.ReplaceAllString(trimmed, "-") + "--"
	return filepath.Join(e.resolvePath(e.AgentDir()), "sessions", safe)
}

// scan lists the session files of dir, newest first.
func scan(dir string) []sessionInfo {
	names, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var infos []sessionInfo
	for _, name := range names {
		if !strings.HasSuffix(name.Name(), ".jsonl") {
			continue
		}
		path := filepath.Join(dir, name.Name())
		header, ok := readHeader(path)
		if !ok {
			continue
		}
		stat, err := os.Stat(path)
		if err != nil {
			continue
		}
		id, _ := header.str("id")
		cwd, hasCwd := header.str("cwd")
		infos = append(infos, sessionInfo{path: path, id: id, cwd: cwd, hasCwd: hasCwd, mtime: stat.ModTime().UnixNano()})
	}
	// Array.prototype.sort is stable; ReadDir order is by name, as readdirSync's on the platforms PiG supports.
	sort.SliceStable(infos, func(i, j int) bool { return infos[i].mtime > infos[j].mtime })
	return infos
}

// lookup is Pi's rule: a custom session dir that is not cwd's default dir is filtered by header cwd.
func (e Env) lookup(cwd, sessionDir string) (string, func(sessionInfo) bool) {
	dir := e.defaultSessionDir(cwd)
	if sessionDir != "" {
		dir = e.resolvePath(sessionDir)
	}
	filter := sessionDir != "" && dir != e.defaultSessionDir(cwd)
	resolvedCwd := e.resolvePath(cwd)
	return dir, func(info sessionInfo) bool {
		return !filter || (info.hasCwd && info.cwd != "" && e.resolvePath(info.cwd) == resolvedCwd)
	}
}

// continueRecent is SessionManager.continueRecent: the newest session of cwd, "" when none.
func (e Env) continueRecent(cwd, sessionDir string) string {
	dir, keep := e.lookup(cwd, sessionDir)
	for _, info := range scan(dir) {
		if keep(info) {
			return info.path
		}
	}
	return ""
}

// findByID is SessionManager.findById.
func (e Env) findByID(cwd, id, sessionDir string) string {
	dir, keep := e.lookup(cwd, sessionDir)
	for _, info := range scan(dir) {
		if info.id == id && keep(info) {
			return info.path
		}
	}
	return ""
}

// findByPrefix is the first SessionManager.list entry whose id starts with prefix.
func (e Env) findByPrefix(cwd, prefix, sessionDir string) string {
	dir, keep := e.lookup(cwd, sessionDir)
	for _, info := range scan(dir) {
		if keep(info) && strings.HasPrefix(info.id, prefix) {
			return info.path
		}
	}
	return ""
}

// sessionCwd is SessionManager.open(path).getCwd(): the header cwd, else fallback.
func sessionCwd(path, fallback string) string {
	if header, ok := readHeader(path); ok {
		if cwd, isString := header.str("cwd"); isString {
			return cwd
		}
	}
	return fallback
}

// branch is SessionManager.getBranch: root to leaf, where the leaf is the
// last non-header entry. Arrays count as entries without fields.
func branch(path string) []map[string]any {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var entries []entry
	for _, line := range strings.Split(string(data), "\n") {
		if parsed, ok := parseLine(line); ok {
			entries = append(entries, parsed)
		}
	}
	if len(entries) == 0 {
		return nil
	}
	if kind, _ := entries[0].str("type"); kind != "session" {
		return nil
	}
	if _, ok := entries[0].str("id"); !ok {
		return nil
	}
	var body []entry
	for _, e := range entries {
		if kind, _ := e.str("type"); kind != "session" {
			body = append(body, e)
		}
	}
	byID := map[string]entry{}
	for _, e := range body {
		if id, ok := e.str("id"); ok {
			byID[id] = e
		}
	}
	var path_ []map[string]any
	seen := map[string]bool{}
	if len(body) == 0 {
		return nil
	}
	current, ok := body[len(body)-1], true
	for ok {
		path_ = append(path_, current.fields)
		if id, isString := current.str("id"); isString {
			seen[id] = true
		}
		parentID, _ := current.fields["parentId"].(string)
		var parent entry
		found := false
		if parentID != "" {
			parent, found = byID[parentID]
		}
		if !found {
			break
		}
		if id, isString := parent.str("id"); isString && seen[id] {
			break
		}
		current = parent
	}
	for i, j := 0, len(path_)-1; i < j; i, j = i+1, j-1 {
		path_[i], path_[j] = path_[j], path_[i]
	}
	return path_
}

// settingsSessionDir is SettingsManager.create().getSessionDir(): the global settings' sessionDir.
func (e Env) settingsSessionDir() string {
	data, err := os.ReadFile(filepath.Join(e.AgentDir(), "settings.json"))
	if err != nil {
		return ""
	}
	var settings map[string]any
	if json.Unmarshal(data, &settings) != nil {
		return ""
	}
	dir, _ := settings["sessionDir"].(string)
	if dir = nonEmpty(dir); dir == "" {
		return ""
	}
	return e.resolvePath(dir)
}
