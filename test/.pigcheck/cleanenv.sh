#!/bin/sh
# Run a command without the enclosing pig/subagent environment, so a pig
# started for a check does not inherit the parent's sockets or AIO state.
exec env -u AI_AGENT $(env | sed -n 's/^\(AIO_[A-Z_]*\)=.*/-u \1/p; s/^\(PIG_[A-Z0-9_]*\)=.*/-u \1/p; s/^\(PI_[A-Z_]*\)=.*/-u \1/p') "$@"
