package browsersearch

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// policyHosts are checked by Go's ValidateURL and, through the fixture, by
// the worker's Policy.check_host.
var policyHosts = []string{
	"8.8.8.8", "93.184.216.34", "127.0.0.1", "127.255.0.9", "10.1.2.3", "172.16.0.1", "172.31.255.255", "172.32.0.1",
	"192.168.1.1", "169.254.169.254", "100.64.0.1", "100.128.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255",
	"192.0.0.8", "192.0.2.5", "198.51.100.1", "203.0.113.9", "[::1]", "[::]", "[fe80::1]", "[fd12::1]", "[fc00::1]",
	"[ff02::1]", "[2606:4700::1111]", "[::ffff:7f00:1]", "[::ffff:808:808]", "[::ffff:a00:1]", "localhost", "localhost.",
	"metadata.google.internal", "instance-data.pai.googleapis.com", "printer.local", "nas.lan", "db.internal",
	"example.com", "internal.example.com",
}

type policyFixture struct {
	Policy    BrowserPolicy `json:"policy"`
	HostCases []hostCase    `json:"hostCases"`
}

type hostCase struct {
	Host   string `json:"host"`
	Valid  bool   `json:"valid"`
	Reason string `json:"reason,omitempty"`
}

func buildPolicyFixture() policyFixture {
	f := policyFixture{Policy: DefaultBrowserPolicy()}
	for _, h := range policyHosts {
		v := ValidateURL("http://" + h + "/")
		f.HostCases = append(f.HostCases, hostCase{Host: h, Valid: v.Valid, Reason: v.Reason})
	}
	return f
}

// TestBrowserPolicyFixture keeps testdata/browser-policy.json equal to the
// Go rule tables. Set BROWSERSEARCH_UPDATE_FIXTURES=1 to rewrite it.
func TestBrowserPolicyFixture(t *testing.T) {
	want, err := json.MarshalIndent(buildPolicyFixture(), "", " ")
	if err != nil {
		t.Fatal(err)
	}
	want = append(want, '\n')
	path := filepath.Join("testdata", "browser-policy.json")
	if os.Getenv("BROWSERSEARCH_UPDATE_FIXTURES") == "1" {
		if err := os.WriteFile(path, want, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	got, err := os.ReadFile(path)
	if err != nil || string(got) != string(want) {
		t.Fatalf("%s is stale: run BROWSERSEARCH_UPDATE_FIXTURES=1 go test ./internal/browsersearch -run TestBrowserPolicyFixture", path)
	}
}

func TestDefaultBrowserPolicy(t *testing.T) {
	p := DefaultBrowserPolicy()
	if len(p.BlockedIPv4) != len(blockedRanges) || p.BlockedIPv4[0] != "127.0.0.0/8" || p.BlockedIPv4[len(p.BlockedIPv4)-1] != "240.0.0.0/4" {
		t.Fatalf("ranges %v", p.BlockedIPv4)
	}
	if strings.Join(p.BlockedSuffixes, ",") != ".internal,.local,.lan" || strings.Join(p.LocalhostNames, ",") != "localhost,localhost." {
		t.Fatalf("suffixes %v names %v", p.BlockedSuffixes, p.LocalhostNames)
	}
	loop := p.WithoutIPv4Range("127.0.0.0/8")
	if len(loop.BlockedIPv4) != len(p.BlockedIPv4)-1 || len(p.BlockedIPv4) != len(blockedRanges) {
		t.Fatalf("WithoutIPv4Range changed the source or kept the range")
	}
}

// pythonForTests returns a python3 of at least 3.10, or skips.
func pythonForTests(t *testing.T) string {
	t.Helper()
	py, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 is not installed")
	}
	out, err := exec.Command(py, "-c", "import sys; print(sys.version_info[0] * 100 + sys.version_info[1])").Output()
	if err != nil {
		t.Skipf("python3 failed: %v", err)
	}
	if v, _ := strconv.Atoi(strings.TrimSpace(string(out))); v < 310 {
		t.Skip("python3 is older than 3.10")
	}
	return py
}

// TestPythonWorkerUnit runs worker/test_camoufox_worker.py (no browser, no
// network).
func TestPythonWorkerUnit(t *testing.T) {
	py := pythonForTests(t)
	cmd := exec.Command(py, "-m", "unittest", "discover", "-s", "worker", "-p", "test_*.py")
	cmd.Env = append(os.Environ(), "PYTHONDONTWRITEBYTECODE=1")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("python unit tests failed: %v\n%s", err, out)
	}
	t.Logf("%s", strings.TrimSpace(string(out)))
}
