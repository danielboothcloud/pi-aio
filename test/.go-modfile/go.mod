module github.com/danielboothcloud/pi-aio/go

go 1.26.0

require (
	codeberg.org/readeck/go-readability/v2 v2.1.3
	github.com/JohannesKaufmann/html-to-markdown/v2 v2.5.2
	// PiG resolves this requirement to the version-matched staged SDK at build time.
	github.com/MichaelKinsy/PiG/extensions/sdk v0.0.0
	github.com/dlclark/regexp2 v1.12.0
	github.com/yuin/goldmark v1.8.7
	go.yaml.in/yaml/v3 v3.0.6
	golang.org/x/net v0.62.0
)

require (
	github.com/JohannesKaufmann/dom v0.3.1 // indirect
	github.com/andybalholm/cascadia v1.3.4 // indirect
	github.com/go-shiori/dom v0.0.0-20230515143342-73569d674e1c // indirect
	github.com/gogs/chardet v0.0.0-20211120154057-b7413eaefb8f // indirect
	github.com/itlightning/dateparse v0.2.1 // indirect
	golang.org/x/text v0.43.0 // indirect
)

replace github.com/MichaelKinsy/PiG/extensions/sdk => /Users/danielbooth/.config/pi/state/pigsdk/sdk-51955af53b263ab7
