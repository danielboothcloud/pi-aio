package notifications

import (
	"context"
	"regexp"
	"strings"
)

// Notification is one desktop notification.
type Notification struct {
	Title, Body, Subtitle, Group, Sound string
}

// Run executes a program and returns its stdout.
type Run func(ctx context.Context, bin string, args []string) (string, error)

// Backend sends notifications: terminal-notifier on a local Mac, else an
// OSC 777 (or OSC 99 under kitty) terminal sequence plus a sound.
type Backend struct {
	localMac bool
	bundle   string
	kitty    bool
	tmux     bool
	run      Run
	write    func(string)
	native   *bool
}

var bundles = map[string]string{
	"Apple_Terminal": "com.apple.Terminal", "iTerm.app": "com.googlecode.iterm2",
	"ghostty": "com.mitchellh.ghostty", "WezTerm": "com.github.wez.wezterm",
	"vscode": "com.microsoft.VSCode", "kitty": "net.kovidgoyal.kitty",
}

var bundleRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9.-]+$`)

// NewBackend builds a backend from the platform, env, a program runner, and
// a writer for terminal sequences.
func NewBackend(platform string, env map[string]string, run Run, write func(string)) *Backend {
	b := &Backend{
		localMac: platform == "darwin" && env["SSH_CONNECTION"] == "" && env["SSH_TTY"] == "",
		kitty:    env["KITTY_WINDOW_ID"] != "",
		tmux:     env["TMUX"] != "",
		run:      run,
		write:    write,
	}
	candidate := env["__CFBundleIdentifier"]
	if candidate == "" {
		candidate = bundles[env["TERM_PROGRAM"]]
	}
	if candidate != "" && bundleRe.MatchString(candidate) {
		b.bundle = candidate
	}
	return b
}

func (b *Backend) fallback() string {
	if b.kitty {
		return "OSC 99"
	}
	return "OSC 777"
}

// Name describes the selected delivery path.
func (b *Backend) Name() string {
	switch {
	case b.native == nil && b.localMac:
		return "auto (terminal-notifier → terminal fallback)"
	case b.native != nil && *b.native:
		return "terminal-notifier"
	}
	return b.fallback()
}

// Focused reports whether the terminal app is the frontmost app.
func (b *Backend) Focused(ctx context.Context) bool {
	if !b.localMac || b.bundle == "" || ctx.Err() != nil {
		return false
	}
	out, err := b.run(ctx, "osascript", []string{"-e", `tell application "System Events" to get bundle identifier of first process whose frontmost is true`})
	return err == nil && strings.Trim(out, jsSpace) == b.bundle
}

func setNative(b *Backend, value bool) { b.native = &value }

// Send delivers a notification while valid() holds.
func (b *Backend) Send(ctx context.Context, n Notification, valid func() bool) {
	stop := func() bool { return !valid() || ctx.Err() != nil }
	if stop() {
		return
	}
	if b.localMac && b.native == nil {
		if _, err := b.run(ctx, "terminal-notifier", []string{"-help"}); err == nil {
			setNative(b, true)
		} else {
			if ctx.Err() != nil {
				return
			}
			setNative(b, false)
		}
	}
	if stop() {
		return
	}
	title := CleanText(n.Title, 100)
	body := CleanText(n.Body, 160)
	subtitle := CleanText(n.Subtitle, 100)
	if b.native != nil && *b.native {
		args := []string{"-title", title, "-subtitle", subtitle, "-message", " " + body, "-group", n.Group}
		if n.Sound != "off" {
			args = append(args, "-sound", CleanText(n.Sound, 64))
		}
		if b.bundle != "" {
			args = append(args, "-activate", b.bundle)
		}
		if _, err := b.run(ctx, "terminal-notifier", args); err == nil {
			return
		}
		if stop() {
			return
		}
		setNative(b, false)
	}
	if stop() {
		return
	}
	prefix := ""
	if subtitle != "" {
		prefix = subtitle + " — "
	}
	message := CleanText(prefix+body, 260)
	sequence := "\x1b]777;notify;" + title + ";" + message + "\x07"
	if b.kitty {
		sequence = "\x1b]99;i=aio:d=0;" + title + "\x1b\\\x1b]99;i=aio:p=body;" + message + "\x1b\\"
	}
	if b.tmux {
		sequence = "\x1bPtmux;" + strings.ReplaceAll(sequence, "\x1b", "\x1b\x1b") + "\x1b\\"
	}
	b.write(sequence)
	b.playSound(ctx, n.Sound, valid)
}

var soundNameRe = regexp.MustCompile(`^[\w -]+$`)

func (b *Backend) playSound(ctx context.Context, name string, valid func() bool) {
	sound := CleanText(name, 64)
	if sound == "" || sound == "off" || !valid() || ctx.Err() != nil {
		return
	}
	if b.localMac && soundNameRe.MatchString(sound) {
		file := sound
		if file == "default" {
			file = "Glass"
		}
		if _, err := b.run(ctx, "afplay", []string{"/System/Library/Sounds/" + file + ".aiff"}); err == nil {
			return
		}
		if !valid() || ctx.Err() != nil {
			return
		}
	}
	b.write("\x07")
}
