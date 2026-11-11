package rtk

// Port of rtk/tool-routing.ts: the helpers the pretty-tools read, ls, find,
// and grep tools use after they run `rtk <subcommand>`. The run itself is
// the caller's (pi.exec in TypeScript, Context.ExecWithOptions in Go).

import (
	"fmt"
	"slices"
	"strings"

	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

// ExecResult is pi's ExecResult: the output and exit of one rtk run.
type ExecResult struct {
	Stdout string
	Stderr string
	Code   int
	Killed bool
}

func normalizeNewlines(text string) string {
	return strings.ReplaceAll(strings.ReplaceAll(text, "\r\n", "\n"), "\r", "\n")
}

// TruncateOutput ports truncateRtkOutput: it keeps at most maxLines lines
// and maxBytes UTF-8 bytes (each line counted with its newline), and notes
// a cut. Pass 0 for the defaults (2000 lines, 50 KiB).
func TruncateOutput(text string, maxLines, maxBytes int) string {
	if maxLines == 0 {
		maxLines = 2000
	}
	if maxBytes == 0 {
		maxBytes = 50 * 1024
	}
	normalized := jsstr.TrimEnd(normalizeNewlines(text))
	lines := strings.Split(normalized, "\n")
	kept := []string{}
	bytes := 0
	for _, line := range lines {
		if len(kept) >= maxLines {
			break
		}
		lineBytes := len(line) + 1
		if bytes+lineBytes > maxBytes {
			break
		}
		kept = append(kept, line)
		bytes += lineBytes
	}
	if len(kept) == len(lines) {
		return normalized
	}
	return fmt.Sprintf("%s\n\n[RTK output truncated: %d of %d lines]", strings.Join(kept, "\n"), len(kept), len(lines))
}

// RequireSuccess ports requireRtkSuccess: an error unless the run was not
// killed and exited with an accepted code (nil accepts only 0).
func RequireSuccess(subcommand string, result ExecResult, accepted []int) error {
	if accepted == nil {
		accepted = []int{0}
	}
	if !result.Killed && slices.Contains(accepted, result.Code) {
		return nil
	}
	detail := result.Stderr
	if detail == "" {
		detail = result.Stdout
	}
	detail = jsstr.Trim(detail)
	if detail != "" {
		return fmt.Errorf("%s", detail)
	}
	if result.Killed {
		return fmt.Errorf("rtk %s was cancelled", subcommand)
	}
	return fmt.Errorf("rtk %s exited with code %d", subcommand, result.Code)
}

// LimitLines ports limitRtkLines: the first limit lines of the trimmed text.
func LimitLines(text string, limit int) string {
	lines := strings.Split(jsstr.TrimEnd(normalizeNewlines(text)), "\n")
	return strings.Join(lines[:min(len(lines), max(0, limit))], "\n")
}
