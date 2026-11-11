package browsersearch

// Anti-bot challenge detection (port of browser-search/challenges.ts
// detectChallenge and index.ts isLikelyChallengeContent). waitForChallenge
// runs in the CloakBrowser worker (Node), so it is not ported.

import (
	"sort"
	"strings"

	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

// Cookie is a page cookie (only the name is read).
type Cookie struct {
	Name string `json:"name"`
}

// ChallengeState is the page state a detector scores.
type ChallengeState struct {
	URL     string            `json:"url"`
	Cookies []Cookie          `json:"cookies,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
	HTML    string            `json:"html,omitempty"`
}

// DetectedChallenge is the highest-scoring detector.
type DetectedChallenge struct {
	Name  string `json:"name"`
	Score int    `json:"score"`
}

func anyCookie(cs []Cookie, f func(string) bool) bool {
	for _, c := range cs {
		if f(c.Name) {
			return true
		}
	}
	return false
}

func prefix(p string) func(string) bool {
	return func(n string) bool { return strings.HasPrefix(n, p) }
}

func equal(p string) func(string) bool { return func(n string) bool { return n == p } }

func add(score *int, cond bool, n int) {
	if cond {
		*score += n
	}
}

type detector struct {
	name string
	test func(ChallengeState) int
}

var detectors = []detector{
	{"cloudflare", func(s ChallengeState) int {
		score := 0
		add(&score, anyCookie(s.Cookies, prefix("__cf")), 2)
		add(&score, strings.Contains(strings.ToLower(s.Headers["server"]), "cloudflare"), 2)
		add(&score, strings.Contains(s.URL, "__cf_chl_f_tk"), 2)
		add(&score, strings.Contains(s.HTML, "/cdn-cgi/"), 3)
		add(&score, strings.Contains(s.HTML, "Checking your browser") && strings.Contains(s.HTML, "Cloudflare"), 2)
		add(&score, strings.Contains(s.HTML, "Just a moment"), 1)
		add(&score, strings.Contains(s.HTML, "Attention Required! Cloudflare"), 3)
		return score
	}},
	{"akamai", func(s ChallengeState) int {
		score := 0
		add(&score, anyCookie(s.Cookies, equal("ak_bmsc")), 3)
		add(&score, anyCookie(s.Cookies, prefix("_abck")), 2)
		add(&score, s.Headers["x-akamai-transformed"] != "" || s.Headers["x-akamai-request-id"] != "", 2)
		add(&score, strings.Contains(s.HTML, "Akamai"), 1)
		add(&score, strings.Contains(s.HTML, "/akamai/"), 2)
		return score
	}},
	{"datadome", func(s ChallengeState) int {
		score := 0
		add(&score, anyCookie(s.Cookies, prefix("datadome")), 3)
		add(&score, strings.Contains(s.HTML, "Datadome"), 1)
		add(&score, strings.Contains(s.HTML, "/datadome/"), 2)
		add(&score, strings.Contains(s.URL, "x-craft-preview") || strings.Contains(s.URL, "ddl_"), 1)
		return score
	}},
	{"imperva", func(s ChallengeState) int {
		score := 0
		add(&score, anyCookie(s.Cookies, prefix("incap_ses_")), 3)
		add(&score, anyCookie(s.Cookies, prefix("visid_incap_")), 2)
		add(&score, s.Headers["x-iinfo"] != "", 1)
		add(&score, strings.Contains(s.HTML, "Imperva"), 1)
		add(&score, strings.Contains(s.HTML, "/_Incapsula_Resource"), 2)
		return score
	}},
	{"perimeterx", func(s ChallengeState) int {
		score := 0
		add(&score, anyCookie(s.Cookies, prefix("_px")), 3)
		add(&score, strings.Contains(s.HTML, "PerimeterX"), 1)
		add(&score, strings.Contains(s.HTML, "/px.js"), 2)
		return score
	}},
	{"ddos-guard", func(s ChallengeState) int {
		score := 0
		add(&score, anyCookie(s.Cookies, prefix("__ddg")), 3)
		add(&score, strings.Contains(strings.ToLower(s.Headers["server"]), "ddos-guard"), 2)
		add(&score, strings.Contains(s.HTML, "DDoS-Guard"), 1)
		return score
	}},
}

// DetectChallenge is detectChallenge: the highest-scoring detector with a
// score of at least 2, or nil. Ties keep detector order (a stable sort).
func DetectChallenge(state ChallengeState) *DetectedChallenge {
	var results []DetectedChallenge
	for _, d := range detectors {
		if score := d.test(state); score >= 2 {
			results = append(results, DetectedChallenge{d.name, score})
		}
	}
	if len(results) == 0 {
		return nil
	}
	sort.SliceStable(results, func(i, j int) bool { return results[i].Score > results[j].Score })
	return &results[0]
}

var challengePhrases = []string{
	"checking your browser",
	"just a moment",
	"attention required",
	"verify you are human",
	"enable javascript and cookies",
	"security check required",
}

// IsLikelyChallengeContent is index.ts isLikelyChallengeContent.
func IsLikelyChallengeContent(url string, title *string, content string) bool {
	t := ""
	if title != nil {
		t = *title
	}
	combined := t + "\n" + content
	if DetectChallenge(ChallengeState{URL: url, HTML: combined}) != nil {
		return true
	}
	if jsstr.Len16(combined) > 10_000 {
		return false
	}
	normalized := jsLower(combined)
	for _, phrase := range challengePhrases {
		if strings.Contains(normalized, phrase) {
			return true
		}
	}
	return false
}

// jsLower is String.prototype.toLowerCase for the cases that differ from
// strings.ToLower in ways that matter here (İ becomes i + U+0307).
func jsLower(s string) string {
	return strings.ToLower(strings.ReplaceAll(s, "İ", "i\u0307"))
}
