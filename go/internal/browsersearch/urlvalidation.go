package browsersearch

// Anti-SSRF URL validation (port of browser-search/url-validation.ts).
// The TypeScript code reads the hostname from WHATWG `new URL()`, so this
// file ports the parts of the WHATWG URL parser that decide the hostname:
// scheme, authority, port, IPv4 and IPv6 host parsing and serialization,
// and UTS #46 domain mapping (golang.org/x/net/idna).

import (
	"context"
	"errors"
	"fmt"
	"net"
	"regexp"
	"strconv"
	"strings"

	"golang.org/x/net/idna"
)

// Validation is UrlValidation: Valid, or a Reason.
type Validation struct {
	Valid  bool   `json:"valid"`
	Reason string `json:"reason,omitempty"`
}

func blocked(reason string) Validation { return Validation{Reason: reason} }

type cidr struct {
	network uint32
	prefix  uint
}

func ipv4(a, b, c, d uint32) uint32 { return a<<24 | b<<16 | c<<8 | d }

var blockedRanges = []cidr{
	{ipv4(127, 0, 0, 0), 8},
	{ipv4(169, 254, 0, 0), 16},
	{ipv4(10, 0, 0, 0), 8},
	{ipv4(172, 16, 0, 0), 12},
	{ipv4(192, 168, 0, 0), 16},
	{ipv4(0, 0, 0, 0), 8},
	{ipv4(100, 64, 0, 0), 10},
	{ipv4(192, 0, 0, 0), 24},
	{ipv4(192, 0, 2, 0), 24},
	{ipv4(198, 51, 100, 0), 24},
	{ipv4(203, 0, 113, 0), 24},
	{ipv4(224, 0, 0, 0), 4},
	{ipv4(240, 0, 0, 0), 4},
}

var blockedHostnames = map[string]bool{
	"metadata.google.internal":          true,
	"metadata.google.internal.":         true,
	"instance-data.pai.googleapis.com":  true,
	"instance-data.pai.googleapis.com.": true,
}

var localhostNames = map[string]bool{"localhost": true, "localhost.": true}

// blockedSuffixes are the private top-level domains validateUrl refuses.
var blockedSuffixes = []string{".internal", ".local", ".lan"}

var blockedIPv6 = []*regexp.Regexp{
	regexp.MustCompile(`^::$`),
	regexp.MustCompile(`^::1$`),
	regexp.MustCompile(`(?i)^fe80:`),
	regexp.MustCompile(`(?i)^fc`),
	regexp.MustCompile(`(?i)^fd`),
	regexp.MustCompile(`(?i)^ff`),
}

var ipv4RE = regexp.MustCompile(`^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$`)
var mappedRE = regexp.MustCompile(`(?i)^::ffff:(.+)$`)

// ipToNumber is url-validation.ts ipToNumber (Number() of each part, then
// 32-bit shifts).
func ipToNumber(ip string) uint32 {
	parts := strings.Split(ip, ".")
	var n [4]int32
	for i := 0; i < 4 && i < len(parts); i++ {
		v, _ := strconv.Atoi(parts[i])
		n[i] = int32(v)
	}
	return uint32(n[0]<<24 | n[1]<<16 | n[2]<<8 | n[3])
}

// isInBlockedRange is url-validation.ts isInBlockedRange.
func isInBlockedRange(ip string) bool {
	n := ipToNumber(ip)
	for _, r := range blockedRanges {
		mask := ^uint32(0) << (32 - r.prefix)
		if n&mask == r.network&mask {
			return true
		}
	}
	return false
}

// isBlockedIPv6 is url-validation.ts isBlockedIPv6.
func isBlockedIPv6(ip string) bool {
	for _, re := range blockedIPv6 {
		if re.MatchString(ip) {
			return true
		}
	}
	m := mappedRE.FindStringSubmatch(ip)
	if m == nil {
		return false
	}
	mapped := m[1]
	if regexp.MustCompile(`^\d{1,3}(?:\.\d{1,3}){3}$`).MatchString(mapped) {
		return isInBlockedRange(mapped)
	}
	parts := strings.Split(mapped, ":")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return false
	}
	high, ok1 := parseIntPrefix(parts[0])
	low, ok2 := parseIntPrefix(parts[1])
	if !ok1 || !ok2 {
		return false
	}
	return isInBlockedRange(fmt.Sprintf("%d.%d.%d.%d", (high>>8)&0xff, high&0xff, (low>>8)&0xff, low&0xff))
}

// parseIntPrefix is Number.parseInt(text, 16): the longest hex prefix.
func parseIntPrefix(text string) (int64, bool) {
	t := strings.TrimLeft(text, " \t\n\r\v\f")
	end := 0
	for end < len(t) && strings.IndexByte("0123456789abcdefABCDEF", t[end]) >= 0 {
		end++
	}
	if end == 0 {
		return 0, false
	}
	v, err := strconv.ParseInt(t[:end], 16, 64)
	return v, err == nil
}

// ValidateURL is validateUrl: structural validation without DNS.
func ValidateURL(raw string) Validation {
	u, ok := parseURL(raw)
	if !ok {
		return blocked("Invalid URL format")
	}
	if u.scheme != "http" && u.scheme != "https" {
		return blocked("Blocked scheme: " + u.scheme + ":")
	}
	hostname := strings.ToLower(u.hostname)
	if hostname == "" {
		return blocked("Missing hostname")
	}
	if blockedHostnames[hostname] {
		return blocked("Blocked hostname: cloud metadata endpoint")
	}
	if localhostNames[hostname] {
		return blocked("Blocked hostname: localhost")
	}
	if ipv4RE.MatchString(hostname) {
		if isInBlockedRange(hostname) {
			return blocked("Blocked IP: " + hostname)
		}
		return Validation{Valid: true}
	}
	if (strings.HasPrefix(hostname, "[") && strings.HasSuffix(hostname, "]")) || strings.Contains(hostname, ":") {
		v6 := strings.TrimSuffix(strings.TrimPrefix(hostname, "["), "]")
		if isBlockedIPv6(v6) {
			return blocked("Blocked IPv6: " + v6)
		}
		return Validation{Valid: true}
	}
	for _, suffix := range blockedSuffixes {
		if strings.HasSuffix(hostname, suffix) {
			return blocked("Blocked TLD: " + hostname)
		}
	}
	return Validation{Valid: true}
}

// Address is one dns.lookup result.
type Address struct {
	Address string `json:"address"`
	Family  int    `json:"family"`
}

// Resolver is dns.lookup(hostname, { all: true }).
type Resolver interface {
	Lookup(ctx context.Context, hostname string) ([]Address, error)
}

// NetResolver resolves with net.DefaultResolver. A missing host gives
// getaddrinfo's ENOTFOUND text, as Node does.
type NetResolver struct{}

// Lookup implements Resolver.
func (NetResolver) Lookup(ctx context.Context, hostname string) ([]Address, error) {
	ips, err := net.DefaultResolver.LookupIPAddr(ctx, hostname)
	if err != nil {
		var dnsErr *net.DNSError
		if errors.As(err, &dnsErr) && dnsErr.IsNotFound {
			return nil, fmt.Errorf("getaddrinfo ENOTFOUND %s", hostname)
		}
		return nil, err
	}
	out := make([]Address, 0, len(ips))
	for _, ip := range ips {
		if v4 := ip.IP.To4(); v4 != nil {
			out = append(out, Address{v4.String(), 4})
		} else {
			out = append(out, Address{ip.IP.String(), 6})
		}
	}
	return out, nil
}

// ValidateURLWithDNS is validateUrlWithDns: ValidateURL, then every DNS
// address must be outside the blocked ranges (DNS-rebinding defense).
func ValidateURLWithDNS(ctx context.Context, resolver Resolver, raw string) Validation {
	v := ValidateURL(raw)
	if !v.Valid {
		return v
	}
	u, ok := parseURL(raw)
	if !ok {
		return blocked("Invalid URL format")
	}
	hostname := strings.ToLower(u.hostname)
	if ipv4RE.MatchString(hostname) {
		return v
	}
	if resolver == nil {
		resolver = NetResolver{}
	}
	addrs, err := resolver.Lookup(ctx, hostname)
	if err != nil {
		return blocked("DNS lookup failed: " + err.Error())
	}
	if len(addrs) == 0 {
		return blocked("DNS lookup returned no addresses")
	}
	for _, a := range addrs {
		if a.Family == 6 {
			if isBlockedIPv6(a.Address) {
				return blocked("DNS resolved to blocked IPv6: " + a.Address)
			}
		} else if isInBlockedRange(a.Address) {
			return blocked("DNS resolved to blocked IP: " + a.Address)
		}
	}
	return Validation{Valid: true}
}

// ---------------------------------------------------------------------------
// WHATWG URL parsing (the parts that decide scheme and hostname)
// ---------------------------------------------------------------------------

type parsedURL struct {
	scheme   string
	hostname string
}

var specialSchemes = map[string]bool{"http": true, "https": true, "ws": true, "wss": true, "ftp": true, "file": true}

func isASCIIAlpha(c byte) bool { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') }

// parseURL runs the WHATWG basic URL parser without a base. It reports
// failure where new URL() throws and returns the serialized hostname.
func parseURL(input string) (parsedURL, bool) {
	input = strings.TrimFunc(input, func(r rune) bool { return r <= 0x20 })
	input = strings.Map(func(r rune) rune {
		if r == '\t' || r == '\n' || r == '\r' {
			return -1
		}
		return r
	}, input)
	if input == "" || !isASCIIAlpha(input[0]) {
		return parsedURL{}, false
	}
	i := 1
	for i < len(input) && (isASCIIAlpha(input[i]) || (input[i] >= '0' && input[i] <= '9') || input[i] == '+' || input[i] == '-' || input[i] == '.') {
		i++
	}
	if i >= len(input) || input[i] != ':' {
		return parsedURL{}, false
	}
	scheme := strings.ToLower(input[:i])
	rest := input[i+1:]
	special := specialSchemes[scheme]
	u := parsedURL{scheme: scheme}
	if scheme == "file" {
		return u, true
	}
	var authority string
	if special {
		rest = strings.TrimLeft(rest, `/\`)
		end := strings.IndexAny(rest, `/\?#`)
		if end < 0 {
			end = len(rest)
		}
		authority = rest[:end]
	} else {
		if !strings.HasPrefix(rest, "//") {
			return u, true // opaque path
		}
		rest = rest[2:]
		end := strings.IndexAny(rest, "/?#")
		if end < 0 {
			end = len(rest)
		}
		authority = rest[:end]
	}
	hasUserinfo := false
	if at := strings.LastIndex(authority, "@"); at >= 0 {
		hasUserinfo = true
		authority = authority[at+1:]
	}
	hostPart, port := authority, ""
	inside := false
	for j := 0; j < len(authority); j++ {
		switch authority[j] {
		case '[':
			inside = true
		case ']':
			inside = false
		case ':':
			if !inside {
				hostPart, port = authority[:j], authority[j+1:]
				j = len(authority)
			}
		}
	}
	if hostPart == "" {
		if special || hasUserinfo || port != "" {
			return parsedURL{}, false
		}
		return u, true
	}
	for _, c := range []byte(port) {
		if c < '0' || c > '9' {
			return parsedURL{}, false
		}
	}
	if port != "" {
		if n, err := strconv.Atoi(strings.TrimLeft(port, "0") + "0"); err != nil || n/10 > 65535 {
			return parsedURL{}, false
		}
	}
	host, ok := parseHost(hostPart, special)
	if !ok {
		return parsedURL{}, false
	}
	u.hostname = host
	return u, true
}

const forbiddenHost = "\x00\t\n\r #/:<>?@[\\]^|"

func parseHost(input string, special bool) (string, bool) {
	if strings.HasPrefix(input, "[") {
		if !strings.HasSuffix(input, "]") || len(input) < 2 {
			return "", false
		}
		pieces, ok := parseIPv6(input[1 : len(input)-1])
		if !ok {
			return "", false
		}
		return "[" + serializeIPv6(pieces) + "]", true
	}
	if !special {
		if strings.ContainsAny(input, forbiddenHost) {
			return "", false
		}
		return input, true
	}
	decoded := percentDecode(input)
	ascii, ok := domainToASCII(validUTF8(decoded))
	if !ok || ascii == "" {
		return "", false
	}
	for _, r := range ascii {
		if r <= 0x1f || r == '%' || r == 0x7f || strings.ContainsRune(forbiddenHost, r) {
			return "", false
		}
	}
	if endsInNumber(ascii) {
		n, ok := parseIPv4(ascii)
		if !ok {
			return "", false
		}
		return fmt.Sprintf("%d.%d.%d.%d", n>>24, (n>>16)&0xff, (n>>8)&0xff, n&0xff), true
	}
	return ascii, true
}

func percentDecode(s string) []byte {
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		if s[i] == '%' && i+2 < len(s) && isHexByte(s[i+1]) && isHexByte(s[i+2]) {
			v, _ := strconv.ParseUint(s[i+1:i+3], 16, 8)
			out = append(out, byte(v))
			i += 2
			continue
		}
		out = append(out, s[i])
	}
	return out
}

func isHexByte(c byte) bool {
	return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
}

var uts46 = idna.New(idna.MapForLookup(), idna.Transitional(false), idna.StrictDomainName(false),
	idna.CheckHyphens(false), idna.VerifyDNSLength(false), idna.BidiRule(), idna.CheckJoiners(true),
	idna.RemoveLeadingDots(false))

// domainToASCII is the WHATWG "domain to ASCII" with beStrict false: ASCII
// input without an xn-- label is only lowercased.
func domainToASCII(domain string) (string, bool) {
	ascii := true
	for i := 0; i < len(domain); i++ {
		if domain[i] >= 0x80 {
			ascii = false
			break
		}
	}
	if ascii {
		lower := strings.ToLower(domain)
		punycode := false
		for _, label := range strings.Split(lower, ".") {
			if strings.HasPrefix(label, "xn--") {
				punycode = true
			}
		}
		if !punycode {
			return lower, true
		}
	}
	out, err := uts46.ToASCII(domain)
	if err != nil && out == "" {
		return "", false
	}
	return out, true
}

func endsInNumber(input string) bool {
	parts := strings.Split(input, ".")
	if parts[len(parts)-1] == "" {
		if len(parts) == 1 {
			return false
		}
		parts = parts[:len(parts)-1]
	}
	last := parts[len(parts)-1]
	if last != "" && strings.Trim(last, "0123456789") == "" {
		return true
	}
	_, ok := parseIPv4Number(last)
	return ok
}

// parseIPv4Number returns the value (saturated above 2^40) or failure.
func parseIPv4Number(input string) (uint64, bool) {
	if input == "" {
		return 0, false
	}
	radix := uint64(10)
	if len(input) >= 2 && (input[:2] == "0x" || input[:2] == "0X") {
		radix, input = 16, input[2:]
	} else if len(input) >= 2 && input[0] == '0' {
		radix, input = 8, input[1:]
	}
	if input == "" {
		return 0, true
	}
	var n uint64
	for i := 0; i < len(input); i++ {
		c := input[i]
		var d uint64
		switch {
		case c >= '0' && c <= '9':
			d = uint64(c - '0')
		case c >= 'a' && c <= 'f':
			d = uint64(c-'a') + 10
		case c >= 'A' && c <= 'F':
			d = uint64(c-'A') + 10
		default:
			return 0, false
		}
		if d >= radix {
			return 0, false
		}
		if n < 1<<40 {
			n = n*radix + d
		}
	}
	return n, true
}

func parseIPv4(input string) (uint32, bool) {
	parts := strings.Split(input, ".")
	if parts[len(parts)-1] == "" && len(parts) > 1 {
		parts = parts[:len(parts)-1]
	}
	if len(parts) > 4 {
		return 0, false
	}
	nums := make([]uint64, len(parts))
	for i, p := range parts {
		n, ok := parseIPv4Number(p)
		if !ok {
			return 0, false
		}
		nums[i] = n
	}
	for i := 0; i < len(nums)-1; i++ {
		if nums[i] > 255 {
			return 0, false
		}
	}
	last := nums[len(nums)-1]
	limit := uint64(1) << (8 * uint(5-len(nums)))
	if last >= limit {
		return 0, false
	}
	v := last
	for i := 0; i < len(nums)-1; i++ {
		v += nums[i] << (8 * uint(3-i))
	}
	return uint32(v), true
}

// parseIPv6 is the WHATWG IPv6 parser.
func parseIPv6(input string) ([8]uint16, bool) {
	var a [8]uint16
	in := []byte(input)
	piece, compress := 0, -1
	p := 0
	at := func(i int) int {
		if i < len(in) {
			return int(in[i])
		}
		return -1
	}
	if at(p) == ':' {
		if at(p+1) != ':' {
			return a, false
		}
		p += 2
		piece++
		compress = piece
	}
	for at(p) != -1 {
		if piece == 8 {
			return a, false
		}
		if at(p) == ':' {
			if compress != -1 {
				return a, false
			}
			p++
			piece++
			compress = piece
			continue
		}
		value, length := 0, 0
		for length < 4 && at(p) != -1 && isHexByte(byte(at(p))) {
			d, _ := strconv.ParseUint(string(rune(at(p))), 16, 8)
			value = value*16 + int(d)
			p++
			length++
		}
		if at(p) == '.' {
			if length == 0 {
				return a, false
			}
			p -= length
			if piece > 6 {
				return a, false
			}
			seen := 0
			for at(p) != -1 {
				v4 := -1
				if seen > 0 {
					if at(p) == '.' && seen < 4 {
						p++
					} else {
						return a, false
					}
				}
				if at(p) < '0' || at(p) > '9' {
					return a, false
				}
				for at(p) >= '0' && at(p) <= '9' {
					n := at(p) - '0'
					if v4 == -1 {
						v4 = n
					} else if v4 == 0 {
						return a, false
					} else {
						v4 = v4*10 + n
					}
					if v4 > 255 {
						return a, false
					}
					p++
				}
				a[piece] = a[piece]*0x100 + uint16(v4)
				seen++
				if seen == 2 || seen == 4 {
					piece++
				}
			}
			if seen != 4 {
				return a, false
			}
			break
		} else if at(p) == ':' {
			p++
			if at(p) == -1 {
				return a, false
			}
		} else if at(p) != -1 {
			return a, false
		}
		a[piece] = uint16(value)
		piece++
	}
	if compress != -1 {
		swaps := piece - compress
		piece = 7
		for piece != 0 && swaps > 0 {
			a[piece], a[compress+swaps-1] = a[compress+swaps-1], a[piece]
			piece--
			swaps--
		}
	} else if piece != 8 {
		return a, false
	}
	return a, true
}

func serializeIPv6(a [8]uint16) string {
	best, bestLen := -1, 1
	for i := 0; i < 8; {
		if a[i] != 0 {
			i++
			continue
		}
		j := i
		for j < 8 && a[j] == 0 {
			j++
		}
		if j-i > bestLen {
			best, bestLen = i, j-i
		}
		i = j
	}
	var b strings.Builder
	ignore0 := false
	for i := 0; i < 8; i++ {
		if ignore0 && a[i] == 0 {
			continue
		}
		ignore0 = false
		if best == i {
			if i == 0 {
				b.WriteString("::")
			} else {
				b.WriteString(":")
			}
			ignore0 = true
			continue
		}
		b.WriteString(strconv.FormatUint(uint64(a[i]), 16))
		if i != 7 {
			b.WriteString(":")
		}
	}
	return b.String()
}
