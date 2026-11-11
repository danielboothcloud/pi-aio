package yamlhooks

// YAML documents to JavaScript values, as the npm `yaml` package's
// parseDocument(content).toJS() builds them (YAML 1.2 core schema). The
// parser is go.yaml.in/yaml/v3; scalars are resolved here with the core
// schema rules, because yaml.v3 resolves some plain scalars (timestamps,
// leading-zero octals) differently. Parser error texts differ from npm
// `yaml`; the error code (invalid_frontmatter) is the same.

import (
	"errors"
	"fmt"
	"io"
	"math"
	"regexp"
	"strconv"
	"strings"

	"go.yaml.in/yaml/v3"

	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

var (
	coreNull     = regexp.MustCompile(`^(?:~|null|Null|NULL)?$`)
	coreBool     = regexp.MustCompile(`^(?:true|True|TRUE|false|False|FALSE)$`)
	coreInt      = regexp.MustCompile(`^[-+]?[0-9]+$`)
	coreOctal    = regexp.MustCompile(`^0o[0-7]+$`)
	coreHex      = regexp.MustCompile(`^0x[0-9a-fA-F]+$`)
	coreFloat    = regexp.MustCompile(`^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$`)
	coreInfinity = regexp.MustCompile(`^[-+]?\.(?:inf|Inf|INF)$`)
	coreNaN      = regexp.MustCompile(`^\.(?:nan|NaN|NAN)$`)
)

// parseYAMLDocument parses one YAML document. An empty document is nil.
func parseYAMLDocument(content string) (any, error) {
	dec := yaml.NewDecoder(strings.NewReader(content))
	var doc yaml.Node
	if err := dec.Decode(&doc); err != nil {
		if errors.Is(err, io.EOF) {
			return nil, nil
		}
		return nil, err
	}
	var next yaml.Node
	if err := dec.Decode(&next); !errors.Is(err, io.EOF) {
		if err != nil {
			return nil, err
		}
		return nil, errors.New("Source contains multiple documents; please use YAML.parseAllDocuments()")
	}
	if doc.Kind == yaml.DocumentNode {
		if len(doc.Content) == 0 {
			return nil, nil
		}
		return yamlToJS(doc.Content[0], 0)
	}
	return yamlToJS(&doc, 0)
}

const maxYAMLDepth = 1000

func yamlToJS(node *yaml.Node, depth int) (any, error) {
	if depth > maxYAMLDepth {
		return nil, errors.New("YAML nesting is too deep")
	}
	switch node.Kind {
	case yaml.AliasNode:
		if node.Alias == nil {
			return nil, errors.New("Unresolved alias")
		}
		return yamlToJS(node.Alias, depth+1)
	case yaml.SequenceNode:
		out := make([]any, 0, len(node.Content))
		for _, item := range node.Content {
			v, err := yamlToJS(item, depth+1)
			if err != nil {
				return nil, err
			}
			out = append(out, v)
		}
		return out, nil
	case yaml.MappingNode:
		o := &Object{Values: map[string]any{}}
		for i := 0; i+1 < len(node.Content); i += 2 {
			keyNode, valueNode := node.Content[i], node.Content[i+1]
			key, err := yamlKey(keyNode, depth+1)
			if err != nil {
				return nil, err
			}
			if o.Has(key) {
				return nil, fmt.Errorf("Map keys must be unique at line %d, column %d", keyNode.Line, keyNode.Column)
			}
			v, err := yamlToJS(valueNode, depth+1)
			if err != nil {
				return nil, err
			}
			o.Set(key, v)
		}
		return o, nil
	case yaml.ScalarNode:
		return yamlScalar(node), nil
	case yaml.DocumentNode:
		if len(node.Content) == 0 {
			return nil, nil
		}
		return yamlToJS(node.Content[0], depth+1)
	}
	return nil, nil
}

// yamlKey is the JavaScript property name of a mapping key (String(key)).
func yamlKey(node *yaml.Node, depth int) (string, error) {
	v, err := yamlToJS(node, depth)
	if err != nil {
		return "", err
	}
	switch x := v.(type) {
	case nil:
		return "", nil
	case string:
		return x, nil
	case bool:
		if x {
			return "true", nil
		}
		return "false", nil
	case float64:
		return jsNumberString(x), nil
	}
	return Stringify(v), nil
}

// jsNumberString is String(n), including NaN and the infinities.
func jsNumberString(n float64) string {
	switch {
	case math.IsNaN(n):
		return "NaN"
	case math.IsInf(n, 1):
		return "Infinity"
	case math.IsInf(n, -1):
		return "-Infinity"
	}
	return jsstr.NumberJS(n)
}

func yamlScalar(node *yaml.Node) any {
	value := node.Value
	explicit := node.Style&yaml.TaggedStyle != 0
	if explicit {
		switch node.Tag {
		case "!!str":
			return value
		case "!!null":
			return nil
		case "!!bool":
			if v, ok := resolveCore(value); ok {
				if b, isBool := v.(bool); isBool {
					return b
				}
			}
			return value
		case "!!int", "!!float":
			if v, ok := resolveCore(value); ok {
				if f, isNum := v.(float64); isNum {
					return f
				}
			}
			return value
		}
		return value
	}
	if node.Style&(yaml.DoubleQuotedStyle|yaml.SingleQuotedStyle|yaml.LiteralStyle|yaml.FoldedStyle) != 0 {
		return value
	}
	if v, ok := resolveCore(value); ok {
		return v
	}
	return value
}

// resolveCore resolves a plain scalar with the YAML 1.2 core schema.
func resolveCore(value string) (any, bool) {
	switch {
	case coreNull.MatchString(value):
		return nil, true
	case coreBool.MatchString(value):
		return value[0] == 't' || value[0] == 'T', true
	case coreOctal.MatchString(value):
		n, err := strconv.ParseUint(value[2:], 8, 64)
		if err != nil {
			return parseBigFloat(value[2:], 8), true
		}
		return float64(n), true
	case coreHex.MatchString(value):
		n, err := strconv.ParseUint(value[2:], 16, 64)
		if err != nil {
			return parseBigFloat(value[2:], 16), true
		}
		return float64(n), true
	case coreInt.MatchString(value):
		f, _ := strconv.ParseFloat(value, 64)
		return f, true
	case coreFloat.MatchString(value):
		f, _ := strconv.ParseFloat(value, 64)
		return f, true
	case coreInfinity.MatchString(value):
		if value[0] == '-' {
			return math.Inf(-1), true
		}
		return math.Inf(1), true
	case coreNaN.MatchString(value):
		return math.NaN(), true
	}
	return nil, false
}

func parseBigFloat(digits string, base int) float64 {
	f := 0.0
	for _, c := range digits {
		d, _ := strconv.ParseUint(string(c), base, 8)
		f = f*float64(base) + float64(d)
	}
	return f
}
