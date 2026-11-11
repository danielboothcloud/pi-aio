module github.com/danielboothcloud/pi-aio/go

go 1.26.0

require (
	// PiG resolves this requirement to the version-matched staged SDK at build time.
	github.com/MichaelKinsy/PiG/extensions/sdk v0.0.0
	github.com/dlclark/regexp2 v1.12.0
	github.com/yuin/goldmark v1.8.7
	go.yaml.in/yaml/v3 v3.0.6
	golang.org/x/net v0.62.0
)

require golang.org/x/text v0.43.0 // indirect
