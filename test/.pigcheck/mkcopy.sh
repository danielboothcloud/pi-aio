#!/bin/sh
# Scratch copy of go/ for type checks and pig runs against the installed SDK.
# Files that other writers moved to newer SDK APIs get scratch-only stubs.
set -e
cd "$(dirname "$0")/../.."
C=test/.pigcheck/gocopy
rm -rf $C; mkdir -p $C
cp -R go/aio go/internal go/go.mod go/go.sum $C/
git show 92dd02d:go/aio/tuicr.go > $C/aio/tuicr.go
if ! grep -q 'func (c Context) SetSharedEnv' $HOME/.config/pi/state/pigsdk/sdk-51955af53b263ab7/context.go; then
  sed -i '' 's/err = ctx.SetSharedEnv(pm.CursorBridgeBuiltinsEnv, "1")/err = nil/; s/err = ctx.UnsetSharedEnv(pm.CursorBridgeBuiltinsEnv)/err = nil/' $C/aio/permissionmodes.go
fi
if ! grep -q 'func (r ModelRegistry) CompleteContext' $HOME/.config/pi/state/pigsdk/sdk-51955af53b263ab7/context.go; then
  sed -i '' 's/registry.CompleteContext(abort, model,/registry.Complete(model,/' $C/aio/goals.go
  sed -i '' 's/ModelRegistry().StreamSimpleContext(callCtx, model,/ModelRegistry().StreamSimple(model,/' $C/aio/sessionnaming.go
fi
M=$PWD/test/.go-modfile; mkdir -p $M; cp go/go.mod go/go.sum $M/
(cd go && go mod edit -modfile=../test/.go-modfile/go.mod -replace github.com/MichaelKinsy/PiG/extensions/sdk=$HOME/.config/pi/state/pigsdk/sdk-51955af53b263ab7)
cd $C && go vet -modfile=$M/go.mod ./... && go build -modfile=$M/go.mod ./... && echo build-ok
