package browsersearch

// BrowserPolicy is the SSRF rule list the local Camoufox worker enforces on
// every browser request. Go builds it from the same tables that ValidateURL
// uses (urlvalidation.go) and sends it in the worker's "init" message, so
// there is one rule list. The worker's Policy class applies it as
// ValidateURLWithDNS does: scheme, metadata hostnames, localhost, IPv4
// ranges, IPv6 patterns, private suffixes, and every DNS answer.

import (
	"fmt"
	"sort"
)

// BrowserPolicy is the JSON shape of the worker policy.
type BrowserPolicy struct {
	Schemes             []string `json:"schemes"`
	BlockedIPv4         []string `json:"blockedIPv4"`
	BlockedIPv6Patterns []string `json:"blockedIPv6Patterns"`
	BlockedHostnames    []string `json:"blockedHostnames"`
	LocalhostNames      []string `json:"localhostNames"`
	BlockedSuffixes     []string `json:"blockedSuffixes"`
}

func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// DefaultBrowserPolicy is the production policy (the ValidateURL tables).
func DefaultBrowserPolicy() BrowserPolicy {
	p := BrowserPolicy{
		Schemes:          []string{"http", "https"},
		BlockedHostnames: sortedKeys(blockedHostnames),
		LocalhostNames:   sortedKeys(localhostNames),
		BlockedSuffixes:  append([]string{}, blockedSuffixes...),
	}
	for _, r := range blockedRanges {
		n := r.network
		p.BlockedIPv4 = append(p.BlockedIPv4, fmt.Sprintf("%d.%d.%d.%d/%d", n>>24, (n>>16)&0xff, (n>>8)&0xff, n&0xff, r.prefix))
	}
	for _, re := range blockedIPv6 {
		p.BlockedIPv6Patterns = append(p.BlockedIPv6Patterns, re.String())
	}
	return p
}

// WithoutIPv4Range returns a copy of p without the given range. Tests use
// it to allow loopback pages (127.0.0.0/8) for one worker only.
func (p BrowserPolicy) WithoutIPv4Range(cidr string) BrowserPolicy {
	out := p
	out.BlockedIPv4 = nil
	for _, r := range p.BlockedIPv4 {
		if r != cidr {
			out.BlockedIPv4 = append(out.BlockedIPv4, r)
		}
	}
	return out
}
