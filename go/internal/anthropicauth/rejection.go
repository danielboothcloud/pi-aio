package anthropicauth

import (
	"encoding/json"
	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
	"maps"
	"regexp"
	"slices"
)

var requiredVersionPattern = regexp.MustCompile(`version ([0-9]+\.[0-9]+\.[0-9]+) or newer is required`)

type VersionRejection struct {
	RequiredVersion string
	body, err       jsstr.Object
	message         string
}

func ReadVersionRejection(text []byte) *VersionRejection {
	var body map[string]any
	if json.Unmarshal(text, &body) != nil || body == nil {
		return nil
	}
	errorBody := record(body["error"])
	details := record(errorBody["details"])
	if details["error_code"] != "claude_code_version_too_old" {
		return nil
	}
	message, _ := errorBody["message"].(string)
	required := ""
	if match := requiredVersionPattern.FindStringSubmatch(message); match != nil {
		required = match[1]
	}
	rawBody, _ := jsstr.DecodeObject(text)
	rawError, _ := jsstr.DecodeObject(rawBody.Values["error"])
	return &VersionRejection{required, rawBody, rawError, message}
}
func (r *VersionRejection) WithHint(hint string) []byte {
	body := jsstr.Object{Keys: slices.Clone(r.body.Keys), Values: maps.Clone(r.body.Values)}
	errBody := jsstr.Object{Keys: slices.Clone(r.err.Keys), Values: maps.Clone(r.err.Values)}
	message := hint
	if r.message != "" {
		message = r.message + " " + hint
	}
	if _, present := errBody.Values["message"]; !present {
		errBody.Keys = append(errBody.Keys, "message")
	}
	errBody.Values["message"] = json.RawMessage(jsstr.QuoteJS(message))
	body.Values["error"] = json.RawMessage(errBody.Stringify(nil))
	return []byte(body.Stringify(nil))
}

type RecoveryHintReason struct{ Kind, OverrideVersion, RequiredVersion, SentVersion string }

func DescribeRecoveryHint(reason RecoveryHintReason) string {
	const prefix = "[pi-anthropic-auth] "
	const current = "the current Claude Code release (npm view @anthropic-ai/claude-code dist-tags)"
	switch reason.Kind {
	case "override":
		required := current
		if reason.RequiredVersion != "" {
			required = reason.RequiredVersion + " or newer"
		}
		return prefix + ClaudeCodeVersionEnv + "=" + reason.OverrideVersion + " is sent verbatim; raise it to " + required + ", or unset it to let pi-anthropic-auth recover automatically."
	case "upgrade-pi":
		return prefix + "The billing header already reported " + reason.SentVersion + "; this rejection likely comes from Pi's own claude-cli version. Upgrade Pi."
	default:
		assignment := ClaudeCodeVersionEnv + " to " + current
		if reason.RequiredVersion != "" {
			assignment = ClaudeCodeVersionEnv + "=" + reason.RequiredVersion
		}
		return prefix + "Automatic recovery did not succeed; set " + assignment + " and retry."
	}
}
