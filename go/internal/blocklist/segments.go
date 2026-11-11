// Shell command segmenter for "match": "command" blocklist rules.
//
// Port of blocklist/segments.ts. A pure approximation of how a POSIX-like
// shell splits a command line into the simple commands it would run. A rule
// such as `^vault\b` blocks `vault login` and `echo $(vault read x)`, but not
// `rg -n 'vault' src` or a heredoc body that only mentions the word.
//
// Fail closed: when the segmentation cannot be trusted (unbalanced quotes,
// unterminated heredocs or `$(`, scripts read from a pipe, `source` of a
// file, ...), Segment returns ok=false with a reason. The blocklist then
// blocks the command for any active command-mode rule.
//
// This is not a full shell: no expansion is evaluated, aliases and functions
// are not resolved, and other interpreters (python -c, node -e, find -exec)
// are opaque arguments. All syntax characters are ASCII, so byte indexing on
// UTF-8 input matches the TypeScript UTF-16 indexing.
package blocklist

import (
	"regexp"
	"strings"
)

// CommandSegment is one simple command the shell would run.
type CommandSegment struct {
	// Full is the dequoted words from the segment start, including VAR=value assignments.
	Full string
	// Program is the dequoted words from the program name on, after assignments and wrappers.
	Program string
}

// ShellPrograms are programs whose stdin or -c script is itself shell code.
var ShellPrograms = map[string]bool{"bash": true, "sh": true, "zsh": true, "dash": true, "fish": true, "ksh": true}

// SourcePrograms run a file's contents in the current shell; always opaque.
var SourcePrograms = map[string]bool{"source": true, ".": true}

// ReservedWords are unquoted words stripped from the front of a segment.
var ReservedWords = map[string]bool{
	"!": true, "if": true, "then": true, "elif": true, "else": true, "fi": true, "do": true,
	"done": true, "while": true, "until": true, "esac": true, "{": true, "}": true,
}

// WrapperSpec describes a command that runs another command.
type WrapperSpec struct {
	// ValueFlags consume the following word (-u root). Attached forms (-n5, --user=x) are handled too.
	ValueFlags []string
	// DynamicFlags make the wrapped command unknowable; segmentation fails closed.
	DynamicFlags []string
	// InertFlags make the wrapper inspect rather than run its operand (command -v).
	InertFlags []string
	// Assignments accepts VAR=value words between the options and the wrapped command.
	Assignments bool
	// Positionals are operands consumed before the wrapped command (timeout DURATION).
	Positionals int
	// Kind is "npx" (npx stays, -y/--yes go) or "perl-exec" (perl -e '...exec @ARGV...' cmd).
	Kind string
}

// CommandWrappers are stripped from the front of Program, matched by basename.
var CommandWrappers = map[string]WrapperSpec{
	"env": {
		ValueFlags:   []string{"-u", "--unset", "-C", "--chdir"},
		DynamicFlags: []string{"-S", "--split-string"},
		Assignments:  true,
	},
	"sudo": {
		ValueFlags: []string{
			"-u", "--user", "-g", "--group", "-C", "--close-from", "-h", "--host", "-p", "--prompt",
			"-r", "--role", "-t", "--type", "-U", "--other-user", "-D", "--chdir", "-T", "--command-timeout",
		},
		Assignments: true,
	},
	"command": {InertFlags: []string{"-v", "-V"}},
	"exec":    {ValueFlags: []string{"-a"}},
	"time":    {ValueFlags: []string{"-f", "--format", "-o", "--output"}},
	"nice":    {ValueFlags: []string{"-n", "--adjustment"}},
	"nohup":   {},
	"timeout": {ValueFlags: []string{"-s", "--signal", "-k", "--kill-after"}, Positionals: 1},
	"xargs": {
		ValueFlags: []string{
			"-I", "-L", "-n", "-P", "-s", "-d", "-E", "-a", "--max-args", "--max-procs", "--max-lines",
			"--max-chars", "--delimiter", "--arg-file", "--eof", "--process-slot-var",
		},
	},
	"npx":  {Kind: "npx"},
	"perl": {Kind: "perl-exec"},
}

const (
	maxNesting = 8
	maxUnwrap  = 16
)

var (
	assignmentRe   = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=`)
	perlExecArgvRe = regexp.MustCompile(`\bexec\s*\(?\s*@ARGV\b`)
	perlCodeFlagRe = regexp.MustCompile(`^-[A-Za-z]*[eE]$`)
	shellFlagsRe   = regexp.MustCompile(`^[-+][A-Za-z]+$`)
	fdPrefixRe     = regexp.MustCompile(`^\d+[<>]`)
)

type word struct {
	value        string // dequoted text; substitutions keep their raw $(...) source
	quoted       bool   // any part was quoted or escaped
	leadingQuote bool   // the first character was a quote or escape
}

type builder struct {
	words       []word
	hereStrings []string
	heredocs    int
	shellStdin  bool
}

type pendingHeredoc struct {
	delimiter string
	stripTabs bool
	owner     *builder
}

type segmentError struct{ reason string }

func fail(reason string) { panic(segmentError{reason}) }

func basename(value string) string {
	if i := strings.LastIndex(value, "/"); i >= 0 {
		return value[i+1:]
	}
	return value
}

func isMeta(c byte) bool {
	switch c {
	case ' ', '\t', '\n', ';', '&', '|', '(', ')', '<', '>':
		return true
	}
	return false
}

func isAssignment(w word) bool { return !w.leadingQuote && assignmentRe.MatchString(w.value) }

func joinWords(words []word) string {
	parts := make([]string, len(words))
	for i, w := range words {
		parts[i] = w.value
	}
	return strings.Join(parts, " ")
}

func contains(list []string, value string) bool {
	for _, item := range list {
		if item == value {
			return true
		}
	}
	return false
}

// skipOptions skips a wrapper's options from i. It returns inert=true when the
// wrapper only inspects its operand. Dynamic flags fail closed.
func skipOptions(words []word, i int, spec WrapperSpec) (next int, inert bool) {
	for i < len(words) {
		value := words[i].value
		if value == "--" {
			return i + 1, false
		}
		if !strings.HasPrefix(value, "-") {
			break
		}
		if strings.HasPrefix(value, "--") {
			name := value
			if eq := strings.Index(value, "="); eq >= 0 {
				name = value[:eq]
			}
			if contains(spec.DynamicFlags, name) {
				fail("`" + value + "` builds the wrapped command dynamically")
			}
			if contains(spec.InertFlags, name) {
				return 0, true
			}
			if !strings.Contains(value, "=") && contains(spec.ValueFlags, name) {
				i += 2
			} else {
				i++
			}
			continue
		}
		// Short option cluster (-iu, -n5, -E); a lone "-" is env's -i.
		consumesNext := false
		for k := 1; k < len(value); k++ {
			flag := "-" + value[k:k+1]
			if contains(spec.DynamicFlags, flag) {
				fail("`" + value + "` builds the wrapped command dynamically")
			}
			if contains(spec.InertFlags, flag) {
				return 0, true
			}
			if contains(spec.ValueFlags, flag) {
				consumesNext = k == len(value)-1
				break
			}
		}
		if consumesNext {
			i += 2
		} else {
			i++
		}
	}
	return i, false
}

// unwrapPerlExec returns the index of cmd in `perl [-flags] -e '...exec @ARGV...' [--] cmd...`, or -1.
func unwrapPerlExec(words []word, i int) int {
	var code []string
	j := i + 1
	for j < len(words) {
		value := words[j].value
		if value == "--" {
			j++
			break
		}
		if !strings.HasPrefix(value, "-") || value == "-" {
			break
		}
		if perlCodeFlagRe.MatchString(value) {
			if j+1 >= len(words) {
				return -1
			}
			code = append(code, words[j+1].value)
			j += 2
			continue
		}
		if len(value) > 2 && (value[1] == 'e' || value[1] == 'E') {
			code = append(code, value[2:])
		}
		j++
	}
	if j >= len(words) {
		return -1
	}
	for _, snippet := range code {
		if perlExecArgvRe.MatchString(snippet) {
			return j
		}
	}
	return -1
}

// unwrap returns the index of the real program after stripping CommandWrappers from i.
func unwrap(words []word, i int) int {
	for round := 0; round < maxUnwrap && i < len(words); round++ {
		spec, ok := CommandWrappers[basename(words[i].value)]
		if !ok || spec.Kind == "npx" {
			return i
		}
		if spec.Kind == "perl-exec" {
			next := unwrapPerlExec(words, i)
			if next < 0 {
				return i
			}
			i = next
			continue
		}
		j, inert := skipOptions(words, i+1, spec)
		if inert {
			return i
		}
		if spec.Assignments {
			for j < len(words) && isAssignment(words[j]) {
				j++
			}
		}
		j += spec.Positionals
		// A bare wrapper (env, time) is itself the program.
		if j >= len(words) {
			return i
		}
		i = j
	}
	return i
}

// stripNpxYes turns `npx -y vitest` into `npx vitest`.
func stripNpxYes(words []word) []word {
	if len(words) == 0 || basename(words[0].value) != "npx" {
		return words
	}
	j := 1
	for j < len(words) && (words[j].value == "-y" || words[j].value == "--yes") {
		j++
	}
	return append([]word{words[0]}, words[j:]...)
}

// shellInvocation classifies a shell's arguments: "script" (with the script), "file", or "stdin".
func shellInvocation(args []word) (kind, script string) {
	readsCommand, readsStdin := false, false
	j := 0
	for j < len(args) {
		value := args[j].value
		if value == "--" || value == "-" {
			j++
			break
		}
		if strings.HasPrefix(value, "--command=") {
			return "script", strings.TrimPrefix(value, "--command=")
		}
		if value == "--command" {
			if j+1 >= len(args) {
				fail("`--command` has no script")
			}
			return "script", args[j+1].value
		}
		if strings.HasPrefix(value, "--") {
			if value == "--rcfile" || value == "--init-file" {
				j += 2
			} else {
				j++
			}
			continue
		}
		if shellFlagsRe.MatchString(value) {
			if strings.HasPrefix(value, "-") && strings.Contains(value, "c") {
				readsCommand = true
			}
			if strings.Contains(value, "s") {
				readsStdin = true
			}
			// -o opt and -O shopt take an argument.
			if strings.ContainsAny(value, "oO") {
				j += 2
			} else {
				j++
			}
			continue
		}
		break
	}
	if readsCommand {
		if j >= len(args) {
			fail("shell `-c` has no script")
		}
		return "script", args[j].value
	}
	if readsStdin || j >= len(args) {
		return "stdin", ""
	}
	return "file", ""
}

type parser struct {
	src      string
	pos      int
	depth    int
	segments []CommandSegment
	argvs    [][]string
	pending  []pendingHeredoc
}

// at returns the byte at i, or -1 past the end.
func (p *parser) at(i int) int {
	if i < 0 || i >= len(p.src) {
		return -1
	}
	return int(p.src[i])
}

func (p *parser) run() {
	p.parseList(0)
}

func (p *parser) recurse(script string) {
	if p.depth >= maxNesting {
		fail("shell code is nested too deeply")
	}
	child := &parser{src: script, depth: p.depth + 1}
	child.run()
	p.segments = append(p.segments, child.segments...)
	p.argvs = append(p.argvs, child.argvs...)
}

func (p *parser) skipBlanks() {
	for p.pos < len(p.src) {
		c := p.src[p.pos]
		if c == ' ' || c == '\t' || c == '\r' {
			p.pos++
		} else if c == '\\' && p.at(p.pos+1) == '\n' {
			p.pos += 2
		} else {
			break
		}
	}
}

// parseList parses commands until EOF or the closing term (')' or '`'; 0 for none).
func (p *parser) parseList(term byte) {
	b := &builder{}
	parenDepth := 0
	finish := func() {
		p.finalize(b)
		b = &builder{}
	}
	for {
		p.skipBlanks()
		if p.pos >= len(p.src) {
			finish()
			if term == ')' {
				fail("unterminated `$(` or `(`")
			}
			if term == '`' {
				fail("unterminated backtick")
			}
			if len(p.pending) > 0 {
				fail("heredoc `" + p.pending[0].delimiter + "` is never terminated")
			}
			return
		}
		c := p.src[p.pos]
		next := p.at(p.pos + 1)
		switch {
		case c == '#':
			if nl := strings.IndexByte(p.src[p.pos:], '\n'); nl >= 0 {
				p.pos += nl
			} else {
				p.pos = len(p.src)
			}
			continue
		case c == '\n':
			p.pos++
			finish()
			p.readHeredocBodies()
			continue
		case c == ';':
			p.pos++
			for p.at(p.pos) == ';' || p.at(p.pos) == '&' {
				p.pos++
			}
			finish()
			continue
		case c == '&' && next != '>':
			if next == '&' {
				p.pos += 2
			} else {
				p.pos++
			}
			finish()
			continue
		case c == '|':
			if next == '|' || next == '&' {
				p.pos += 2
			} else {
				p.pos++
			}
			finish()
			continue
		case c == '(':
			p.pos++
			parenDepth++
			finish()
			continue
		case c == ')':
			p.pos++
			finish()
			if parenDepth > 0 {
				parenDepth--
				continue
			}
			if term == ')' {
				return
			}
			continue // a stray ')' (a case pattern) is only a separator
		case c == '`' && term == '`':
			p.pos++
			finish()
			return
		case c == '<' || c == '>' || c == '&':
			p.readRedirect(b)
			continue
		}
		end := p.pos + 12
		if end > len(p.src) {
			end = len(p.src)
		}
		if loc := fdPrefixRe.FindStringIndex(p.src[p.pos:end]); loc != nil {
			p.pos += loc[1] - 1 // keep the < or > for readRedirect
			continue
		}
		b.words = append(b.words, p.readWord(term))
	}
}

func (p *parser) startsWith(token string) bool { return strings.HasPrefix(p.src[p.pos:], token) }

func (p *parser) readRedirect(b *builder) {
	switch {
	case p.startsWith("<<<"):
		p.pos += 3
		b.hereStrings = append(b.hereStrings, p.readTarget().value)
		return
	case p.startsWith("<<"):
		p.pos += 2
		stripTabs := p.at(p.pos) == '-'
		if stripTabs {
			p.pos++
		}
		delimiter := p.readTarget().value
		b.heredocs++
		p.pending = append(p.pending, pendingHeredoc{delimiter: delimiter, stripTabs: stripTabs, owner: b})
		return
	case p.startsWith("<(") || p.startsWith(">("):
		start := p.pos
		p.pos += 2
		p.parseList(')')
		b.words = append(b.words, word{value: p.src[start:p.pos]})
		return
	case p.startsWith("&>>"):
		p.pos += 3
	case p.startsWith("&>") || p.startsWith(">>") || p.startsWith(">&") || p.startsWith(">|") ||
		p.startsWith("<&") || p.startsWith("<>"):
		p.pos += 2
	default:
		p.pos++
	}
	p.readTarget()
}

// readTarget reads the word after a redirection operator; it is never part of the command.
func (p *parser) readTarget() word {
	p.skipBlanks()
	c := p.at(p.pos)
	if c < 0 || isMeta(byte(c)) {
		fail("redirection has no target")
	}
	return p.readWord(0)
}

func (p *parser) readWord(term byte) word {
	var w word
	var value strings.Builder
	start := p.pos
	markQuoted := func() {
		if p.pos == start {
			w.leadingQuote = true
		}
		w.quoted = true
	}
	for p.pos < len(p.src) {
		c := p.src[p.pos]
		if isMeta(c) {
			break
		}
		if c == '`' && term == '`' {
			break
		}
		switch c {
		case '\\':
			markQuoted()
			next := p.at(p.pos + 1)
			if next < 0 {
				value.WriteByte('\\')
				p.pos++
			} else {
				if next != '\n' {
					value.WriteByte(byte(next))
				}
				p.pos += 2
			}
			continue
		case '\'':
			markQuoted()
			end := strings.IndexByte(p.src[p.pos+1:], '\'')
			if end < 0 {
				fail("unbalanced single quote")
			}
			value.WriteString(p.src[p.pos+1 : p.pos+1+end])
			p.pos += end + 2
			continue
		case '"':
			markQuoted()
			value.WriteString(p.readDoubleQuoted())
			continue
		case '$':
			next := p.at(p.pos + 1)
			if next == '\'' {
				markQuoted()
				p.pos += 2
				value.WriteString(p.readAnsiC())
				continue
			}
			if next == '"' {
				markQuoted()
				p.pos++
				value.WriteString(p.readDoubleQuoted())
				continue
			}
			if next == '(' || next == '{' {
				value.WriteString(p.readDollar())
				continue
			}
			value.WriteByte(c)
			p.pos++
			continue
		case '`':
			value.WriteString(p.readBacktick())
			continue
		}
		value.WriteByte(c)
		p.pos++
	}
	w.value = value.String()
	return w
}

// readDoubleQuoted reads "..." from the opening quote; it recurses into $(...) and backticks.
func (p *parser) readDoubleQuoted() string {
	var value strings.Builder
	p.pos++
	for {
		if p.pos >= len(p.src) {
			fail("unbalanced double quote")
		}
		c := p.src[p.pos]
		if c == '"' {
			p.pos++
			return value.String()
		}
		if c == '\\' {
			next := p.at(p.pos + 1)
			switch next {
			case '\n':
				p.pos += 2
			case '$', '`', '"', '\\':
				value.WriteByte(byte(next))
				p.pos += 2
			default:
				value.WriteByte(c)
				p.pos++
			}
			continue
		}
		if c == '$' && (p.at(p.pos+1) == '(' || p.at(p.pos+1) == '{') {
			value.WriteString(p.readDollar())
			continue
		}
		if c == '`' {
			value.WriteString(p.readBacktick())
			continue
		}
		value.WriteByte(c)
		p.pos++
	}
}

// readAnsiC reads a $'...' body after the opening $'.
func (p *parser) readAnsiC() string {
	var value strings.Builder
	for {
		if p.pos >= len(p.src) {
			fail("unbalanced `$'` quote")
		}
		c := p.src[p.pos]
		if c == '\'' {
			p.pos++
			return value.String()
		}
		if c == '\\' && p.pos+1 < len(p.src) {
			value.WriteByte(p.src[p.pos+1])
			p.pos += 2
			continue
		}
		value.WriteByte(c)
		p.pos++
	}
}

// readDollar reads $(...) (segmented recursively) or ${...} (scanned for nested substitutions).
func (p *parser) readDollar() string {
	start := p.pos
	if p.at(p.pos+1) == '(' {
		p.pos += 2
		p.parseList(')')
		return p.src[start:p.pos]
	}
	p.pos += 2
	depth := 1
	for depth > 0 {
		if p.pos >= len(p.src) {
			fail("unterminated `${`")
		}
		c := p.src[p.pos]
		switch {
		case c == '\\':
			p.pos += 2
		case c == '\'':
			end := strings.IndexByte(p.src[p.pos+1:], '\'')
			if end < 0 {
				fail("unbalanced single quote")
			}
			p.pos += end + 2
		case c == '"':
			p.readDoubleQuoted()
		case c == '$' && (p.at(p.pos+1) == '(' || p.at(p.pos+1) == '{'):
			p.readDollar()
		case c == '`':
			p.readBacktick()
		default:
			if c == '{' {
				depth++
			} else if c == '}' {
				depth--
			}
			p.pos++
		}
	}
	if p.pos > len(p.src) {
		p.pos = len(p.src)
	}
	return p.src[start:p.pos]
}

func (p *parser) readBacktick() string {
	start := p.pos
	p.pos++
	p.parseList('`')
	return p.src[start:p.pos]
}

func (p *parser) readHeredocBodies() {
	pending := p.pending
	p.pending = nil
	for _, heredoc := range pending {
		var lines []string
		terminated := false
		for p.pos < len(p.src) {
			var raw string
			if nl := strings.IndexByte(p.src[p.pos:], '\n'); nl >= 0 {
				raw = p.src[p.pos : p.pos+nl]
				p.pos += nl + 1
			} else {
				raw = p.src[p.pos:]
				p.pos = len(p.src)
			}
			line := raw
			if heredoc.stripTabs {
				line = strings.TrimLeft(raw, "\t")
			}
			if line == heredoc.delimiter {
				terminated = true
				break
			}
			lines = append(lines, line)
		}
		if !terminated {
			fail("heredoc `" + heredoc.delimiter + "` is never terminated")
		}
		if heredoc.owner.shellStdin {
			p.recurse(strings.Join(lines, "\n"))
		}
	}
}

func (p *parser) finalize(b *builder) {
	words := b.words
	start := 0
	for start < len(words) && !words[start].quoted && ReservedWords[words[start].value] {
		start++
	}
	if start >= len(words) {
		return
	}
	i := start
	for i < len(words) && isAssignment(words[i]) {
		i++
	}
	programWords := stripNpxYes(words[unwrap(words, i):])
	p.segments = append(p.segments, CommandSegment{Full: joinWords(words[start:]), Program: joinWords(programWords)})
	argv := make([]string, len(programWords))
	for k, w := range programWords {
		argv[k] = w.value
	}
	p.argvs = append(p.argvs, argv)
	if len(programWords) == 0 {
		return
	}
	first := programWords[0]
	args := programWords[1:]
	if !first.quoted && SourcePrograms[first.value] {
		fail("`" + first.value + "` runs a file whose commands cannot be checked")
	}
	name := basename(first.value)
	if name == "eval" {
		p.recurse(joinWords(args))
		return
	}
	if !ShellPrograms[name] {
		return
	}
	kind, script := shellInvocation(args)
	switch kind {
	case "script":
		p.recurse(script)
		return
	case "file":
		return
	}
	if b.heredocs == 0 && len(b.hereStrings) == 0 {
		fail("`" + name + "` reads its script from a pipe or redirect")
	}
	b.shellStdin = true
	for _, s := range b.hereStrings {
		p.recurse(s)
	}
}

// parse runs the parser and converts a segmentation failure into a reason.
func parse(command string) (p *parser, reason string, ok bool) {
	p = &parser{src: command}
	defer func() {
		if r := recover(); r != nil {
			if e, isSegment := r.(segmentError); isSegment {
				reason = e.reason
			} else {
				reason = "segmentation failed unexpectedly"
			}
			ok = false
		}
	}()
	p.run()
	return p, "", true
}

// Segment splits a command into the simple commands the shell would run.
// It returns ok=false and a reason when that cannot be trusted.
func Segment(command string) (segments []CommandSegment, reason string, ok bool) {
	p, reason, ok := parse(command)
	if !ok {
		return nil, reason, false
	}
	return p.segments, "", true
}

// Argvs returns the dequoted program words of each command, or ok=false when
// the command cannot be segmented. A quoted argument stays one word.
func Argvs(command string) ([][]string, bool) {
	p, _, ok := parse(command)
	if !ok {
		return nil, false
	}
	return p.argvs, true
}
