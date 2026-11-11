package yamlhooks

// YAML envelope parsing (port of yaml-hooks/yaml-envelope.ts) and file
// composition (port of yaml-hooks/composition.ts and unsupported.ts).

import (
	"fmt"
	"os"
	"strings"
)

// MaxHooksYAMLBytes is the hard cap on a hooks file before parsing (1 MiB).
const MaxHooksYAMLBytes = 1024 * 1024

// Envelope is ParsedHooksFileEnvelope.
type Envelope struct {
	Imports []string
	Body    *Object
	Errors  []ValidationError
}

// ParseEnvelope is parseHooksFileEnvelope.
func ParseEnvelope(filePath, content string) Envelope {
	if n := byteLength(content); n > MaxHooksYAMLBytes {
		return Envelope{Errors: []ValidationError{{
			Code:     "invalid_frontmatter",
			FilePath: filePath,
			Message:  fmt.Sprintf("[aio yaml hooks] hooks.yaml exceeds the %d-byte size cap (got %d bytes); refusing to parse.", MaxHooksYAMLBytes, n),
		}}}
	}
	parsed, err := parseYAMLDocument(content)
	if err != nil {
		message := err.Error()
		if message == "" {
			message = "Failed to parse hooks.yaml."
		}
		return Envelope{Errors: []ValidationError{{Code: "invalid_frontmatter", FilePath: filePath, Message: message}}}
	}
	body, ok := parsed.(*Object)
	if !ok || body == nil {
		return Envelope{Errors: []ValidationError{{Code: "invalid_frontmatter", FilePath: filePath, Message: "hooks.yaml must parse to an object."}}}
	}
	imports, importErr := parseImportsField(filePath, body.Get("imports"), body.Has("imports"))
	if importErr != nil {
		return Envelope{Errors: []ValidationError{*importErr}}
	}
	return Envelope{Imports: imports, Body: body}
}

func parseImportsField(filePath string, imports any, present bool) ([]string, *ValidationError) {
	if !present {
		return []string{}, nil
	}
	list, ok := imports.([]any)
	if !ok {
		e := createError(filePath, "invalid_imports", "imports must be an array of non-empty strings.", "imports")
		return nil, &e
	}
	out := make([]string, len(list))
	for i, entry := range list {
		if !isNonEmptyString(entry) {
			e := createError(filePath, "invalid_imports", fmt.Sprintf("imports[%d] must be a non-empty string.", i), fmt.Sprintf("imports[%d]", i))
			return nil, &e
		}
		out[i] = entry.(string)
	}
	return out, nil
}

// readFileUTF8 is readFileSync(path, "utf8") with Node's error texts.
func readFileUTF8(path string) (string, error) {
	info, err := os.Stat(path)
	if err == nil && info.IsDir() {
		return "", nodeError("EISDIR", "read", "")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", nodeFsError(err, "open", path)
	}
	return strings.ToValidUTF8(string(data), "\uFFFD"), nil
}

// formatHookReadError is yaml-envelope.ts formatHookReadError.
func formatHookReadError(err error) string { return "Failed to read hooks.yaml: " + err.Error() }

// ParsedFile is ParsedHooksFile plus its files list. Advisories is nil when
// TypeScript leaves the field out.
type ParsedFile struct {
	Hooks      *HookMap
	Overrides  []*Override
	Errors     []ValidationError
	Advisories []string
	Files      []string
}

// ParseHooksFile is composition.ts parseHooksFile with the Pi policy (the
// policy registerYamlHooks installs).
func ParseHooksFile(filePath, content string) ParsedFile {
	env := ParseEnvelope(filePath, content)
	if len(env.Errors) > 0 || env.Body == nil {
		return ParsedFile{Hooks: NewHookMap(), Errors: env.Errors, Files: []string{filePath}}
	}
	return ParseHooksObject(filePath, env.Body)
}

// LoadHooksFile is composition.ts loadHooksFile; read is nil for the disk.
func LoadHooksFile(filePath string, read func(string) (string, error)) ParsedFile {
	if read == nil {
		read = readFileUTF8
	}
	content, err := read(filePath)
	if err != nil {
		return ParsedFile{Hooks: NewHookMap(), Errors: []ValidationError{{Code: "invalid_frontmatter", FilePath: filePath, Message: formatHookReadError(err)}}, Files: []string{filePath}}
	}
	return ParseHooksFile(filePath, content)
}

// ParseHooksObject is composition.ts parseHooksObject with the Pi policy.
func ParseHooksObject(filePath string, parsed *Object) ParsedFile {
	if !parsed.Has("hooks") {
		return ParsedFile{Hooks: NewHookMap(), Errors: []ValidationError{{Code: "missing_hooks", FilePath: filePath, Message: "hooks.yaml must define a hooks list.", Path: "hooks"}}, Files: []string{filePath}}
	}
	list, ok := parsed.Get("hooks").([]any)
	if !ok {
		return ParsedFile{Hooks: NewHookMap(), Errors: []ValidationError{{Code: "invalid_hooks", FilePath: filePath, Message: "hooks must be an array.", Path: "hooks"}}, Files: []string{filePath}}
	}
	hooks := NewHookMap()
	var overrides []*Override
	var errs []ValidationError
	seen := map[string]bool{}
	for index, def := range list {
		p := parseHookDefinition(filePath, def, index, seen)
		errs = append(errs, p.errors...)
		if p.hook == nil {
			if p.override != nil {
				overrides = append(overrides, p.override)
			}
			continue
		}
		hooks.Set(p.hook.Event, append(append([]*HookConfig{}, hooks.Get(p.hook.Event)...), p.hook))
	}
	errs = append(errs, validateAsyncQueueConfigs(hooks)...)

	// Pi policy (unsupported.ts): command: actions cannot run on Pi.
	invalid := map[*HookConfig]bool{}
	for _, event := range hooks.Events() {
		for _, hook := range hooks.Get(event) {
			for _, a := range hook.Actions {
				if a.Kind == "command" {
					errs = append(errs, ValidationError{Code: "unsupported_on_pi", FilePath: filePath, Message: fmt.Sprintf("hook %s uses command: actions, which are unsupported on Pi — remove this action or use bash instead", describeHook(hook))})
					invalid[hook] = true
					break
				}
			}
		}
	}
	if len(invalid) > 0 {
		for _, event := range append([]string{}, hooks.Events()...) {
			bucket := hooks.Get(event)
			var filtered []*HookConfig
			for _, h := range bucket {
				if !invalid[h] {
					filtered = append(filtered, h)
				}
			}
			if len(filtered) == 0 {
				hooks.Delete(event)
			} else if len(filtered) != len(bucket) {
				hooks.Set(event, filtered)
			}
		}
	}
	return ParsedFile{Hooks: hooks, Overrides: overrides, Errors: dedupeValidationErrors(errs), Files: []string{filePath}}
}

// describeHook is unsupported.ts describeHook.
func describeHook(h *HookConfig) string {
	if h.ID != nil {
		return *h.ID
	}
	return fmt.Sprintf("%s#hooks[%d]", h.Source.FilePath, h.Source.Index)
}

// mergeHookMapsInto is composition.ts mergeHookMapsInto.
func mergeHookMapsInto(target, source *HookMap) {
	for _, event := range source.Events() {
		target.Set(event, append(append([]*HookConfig{}, target.Get(event)...), source.Get(event)...))
	}
}

// flattenHookMap is composition.ts flattenHookMap.
func flattenHookMap(m *HookMap) []*HookConfig {
	var out []*HookConfig
	for _, event := range m.Events() {
		out = append(out, m.Get(event)...)
	}
	return out
}

func toHookMap(hooks []*HookConfig) *HookMap {
	m := NewHookMap()
	for _, h := range hooks {
		m.Set(h.Event, append(append([]*HookConfig{}, m.Get(h.Event)...), h))
	}
	return m
}

// ResolveOverrides is composition.ts resolveOverrides.
func ResolveOverrides(hooks *HookMap, overrides []*Override) (*HookMap, []ValidationError) {
	ordered := flattenHookMap(hooks)
	var errs []ValidationError
	idIndex := map[string]int{}
	var idOrder []string
	idSources := map[string][]*HookConfig{}
	for index, hook := range ordered {
		if hook.ID == nil || *hook.ID == "" {
			continue
		}
		id := *hook.ID
		if _, ok := idSources[id]; !ok {
			idOrder = append(idOrder, id)
		}
		idSources[id] = append(idSources[id], hook)
		idIndex[id] = index
	}
	for _, id := range idOrder {
		list := idSources[id]
		if len(list) <= 1 {
			continue
		}
		first := list[0]
		for _, dup := range list[1:] {
			errs = append(errs, createError(dup.Source.FilePath, "duplicate_hook_id",
				fmt.Sprintf("hooks[%d].id duplicates hook id \"%s\" already defined at %s#hooks[%d].", dup.Source.Index, id, first.Source.FilePath, first.Source.Index),
				fmt.Sprintf("hooks[%d].id", dup.Source.Index)))
		}
	}
	for _, o := range overrides {
		target, ok := idIndex[o.TargetID]
		if !ok {
			errs = append(errs, createError(o.Source.FilePath, "override_target_not_found",
				fmt.Sprintf("hooks[%d].override targets unknown hook id \"%s\".", o.Source.Index, o.TargetID),
				fmt.Sprintf("hooks[%d].override", o.Source.Index)))
			continue
		}
		if o.Disable {
			ordered = append(ordered[:target:target], ordered[target+1:]...)
			delete(idIndex, o.TargetID)
			for id, idx := range idIndex {
				if idx > target {
					idIndex[id] = idx - 1
				}
			}
			continue
		}
		if o.Replacement != nil {
			ordered[target] = o.Replacement
			delete(idIndex, o.TargetID)
			if o.Replacement.ID != nil && *o.Replacement.ID != "" {
				idIndex[*o.Replacement.ID] = target
			}
		}
	}
	return toHookMap(ordered), errs
}

// dedupeValidationErrors is composition.ts dedupeValidationErrors.
func dedupeValidationErrors(errs []ValidationError) []ValidationError {
	seen := map[string]bool{}
	out := []ValidationError{}
	for _, e := range errs {
		key := e.Code + "\x00" + e.FilePath + "\x00" + e.Path + "\x00" + e.Message
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, e)
	}
	return out
}

// validateAsyncQueueConfigs is composition.ts validateAsyncQueueConfigs.
func validateAsyncQueueConfigs(hooks *HookMap) []ValidationError {
	var errs []ValidationError
	byGroup := map[string]int{}
	for _, hook := range flattenHookMap(hooks) {
		if hook.Async == nil || hook.Async.True {
			continue
		}
		base := fmt.Sprintf("hooks[%d].async", hook.Source.Index)
		if hook.Async.Concurrency != nil && hook.Async.Group == nil {
			errs = append(errs, createError(hook.Source.FilePath, "invalid_async",
				base+".concurrency requires async.group so legacy per-event async queues stay serialized by default.", base+".concurrency"))
		}
		if hook.Async.Group == nil || *hook.Async.Group == "" {
			continue
		}
		group := *hook.Async.Group
		actual := 1
		if hook.Async.Concurrency != nil {
			actual = *hook.Async.Concurrency
		}
		if expected, ok := byGroup[group]; ok && expected != actual {
			errs = append(errs, createError(hook.Source.FilePath, "invalid_async",
				fmt.Sprintf("%s.concurrency for group %s must match earlier hooks in that group (%d).", base, Stringify(group), expected), base+".concurrency"))
			continue
		}
		byGroup[group] = actual
	}
	return errs
}

// countHooks is discovery.ts countHooks.
func countHooks(m *HookMap) int { return len(flattenHookMap(m)) }
