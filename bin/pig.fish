# pig — run PiG with AIO recipes applied, like `pi --recipe`.
#
# Install: copy or link this file to ~/.config/fish/functions/pig.fish.
#
# The AIO launcher (bin/aio-pig.mjs) plans the launch and prints the
# arguments for `env`. `env` then replaces itself with pig, so no launcher
# process stays alive while pig runs. Without node or the launcher, or when
# the launcher prints nothing, this runs plain pig.
#
# AIO_PIG_LAUNCHER_PATH overrides the launcher location (for example, a
# development checkout). `command pig` always runs the plain binary.
function pig --wraps pig --description 'pig with AIO recipes'
    set -l launcher ~/.config/pi/git/github.com/danielboothcloud/pi-aio/bin/aio-pig.mjs
    set -q AIO_PIG_LAUNCHER_PATH; and set launcher $AIO_PIG_LAUNCHER_PATH
    if not test -f $launcher; or not command -q node
        command pig $argv
        return
    end
    # The launcher's stdout is captured here, so pass the real stdout state.
    set -l stdout pipe
    isatty stdout; and set stdout tty
    set -l plan (command node $launcher --aio-print-exec=$stdout $argv | string split0)
    if test (count $plan) -eq 0
        command pig $argv
        return
    end
    command env $plan
end
