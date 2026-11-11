module github.com/danielboothcloud/pi-aio/go

go 1.26

require (
	// PiG resolves this requirement to the version-matched staged SDK at build time.
	github.com/MichaelKinsy/PiG/extensions/sdk v0.0.0
	github.com/dlclark/regexp2 v1.12.0
	go.yaml.in/yaml/v3 v3.0.6
)

replace github.com/MichaelKinsy/PiG/extensions/sdk => /Users/danielbooth/.config/pi/state/pigsdk/sdk-51955af53b263ab7
