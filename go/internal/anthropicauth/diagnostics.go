package anthropicauth

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/danielboothcloud/pi-aio/go/internal/jsstr"
)

const ProfileURL = "https://api.anthropic.com/api/oauth/profile"
const OAuthBeta = "oauth-2025-04-20"
const ProfileTimeout = 5 * time.Second

type AccountProfile struct {
	OrganizationType     *string `json:"organizationType"`
	RateLimitTier        *string `json:"rateLimitTier"`
	SeatTier             *string `json:"seatTier"`
	SubscriptionStatus   *string `json:"subscriptionStatus"`
	HasExtraUsageEnabled *bool   `json:"hasExtraUsageEnabled"`
	Email                *string `json:"email"`
	OrganizationName     *string `json:"organizationName"`
}
type AccountLookup struct {
	Kind    string          `json:"kind"`
	Reason  string          `json:"reason,omitempty"`
	Profile *AccountProfile `json:"profile,omitempty"`
}

func stringAt(m map[string]any, key string) *string {
	if v, ok := m[key].(string); ok {
		return &v
	}
	return nil
}
func ParseProfile(body map[string]any) *AccountProfile {
	account, organization := record(body["account"]), record(body["organization"])
	p := &AccountProfile{OrganizationType: stringAt(organization, "organization_type"), RateLimitTier: stringAt(organization, "rate_limit_tier"), SeatTier: stringAt(organization, "seat_tier"), SubscriptionStatus: stringAt(organization, "subscription_status"), Email: stringAt(account, "email"), OrganizationName: stringAt(organization, "name")}
	if v, ok := organization["has_extra_usage_enabled"].(bool); ok {
		p.HasExtraUsageEnabled = &v
	}
	return p
}
func LookupProviderAccount(ctx context.Context, provider string, credentials func(string) (string, error), fetch FetchFunc) (AccountLookup, error) {
	// Upstream resolves credentials outside its network try/catch.
	token, err := credentials(provider)
	if err != nil {
		return AccountLookup{}, err
	}
	if !IsAnthropicOAuthToken(token) {
		return AccountLookup{Kind: "not-oauth"}, nil
	}
	ctx, cancel := context.WithTimeout(ctx, ProfileTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, ProfileURL, nil)
	if err != nil {
		return AccountLookup{}, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("anthropic-beta", OAuthBeta)
	if fetch == nil {
		fetch = http.DefaultClient.Do
	}
	response, err := fetch(req)
	unavailable := func(reason string) (AccountLookup, error) {
		return AccountLookup{Kind: "unavailable", Reason: reason}, nil
	}
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return unavailable("timeout")
		}
		return unavailable(err.Error())
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return unavailable(fmt.Sprintf("HTTP %d", response.StatusCode))
	}
	data, readErr := io.ReadAll(response.Body)
	var body map[string]any
	if readErr != nil || json.Unmarshal(data, &body) != nil || body == nil {
		return unavailable("unexpected response")
	}
	return AccountLookup{Kind: "profile", Profile: ParseProfile(body)}, nil
}

type Diagnostics struct {
	Version, ModulePath string
	TransportResolved   bool
	ShapedProviders     []ShapedProvider
	ConfigWarnings      []string
}
type ProviderAccount struct {
	Provider string        `json:"provider"`
	Lookup   AccountLookup `json:"lookup"`
}
type AccountsReport struct {
	Accounts        []ProviderAccount `json:"accounts"`
	IncludeIdentity bool              `json:"includeIdentity"`
}
type ArgumentCompletion struct {
	Value       string `json:"value"`
	Label       string `json:"label"`
	Description string `json:"description"`
}

func StatusArgumentCompletions(prefix string) []ArgumentCompletion {
	if !strings.HasPrefix("--account", jsstr.Trim(prefix)) {
		return nil
	}
	return []ArgumentCompletion{{"--account", "--account", "Also show each account's email and organization name"}}
}
func describeProfile(p *AccountProfile, identity bool) string {
	parts := []string{}
	add := func(value *string, prefix string) {
		if value != nil && *value != "" {
			parts = append(parts, prefix+*value)
		}
	}
	if identity {
		ids := []string{}
		if p.Email != nil && *p.Email != "" {
			ids = append(ids, *p.Email)
		}
		if p.OrganizationName != nil && *p.OrganizationName != "" {
			ids = append(ids, "("+*p.OrganizationName+")")
		}
		if len(ids) > 0 {
			parts = append(parts, strings.Join(ids, " "))
		}
	}
	add(p.OrganizationType, "")
	add(p.SeatTier, "seat ")
	add(p.RateLimitTier, "rate limit ")
	add(p.SubscriptionStatus, "subscription ")
	if p.HasExtraUsageEnabled != nil {
		value := "off"
		if *p.HasExtraUsageEnabled {
			value = "on"
		}
		parts = append(parts, "extra usage "+value)
	}
	if len(parts) == 0 {
		return "no plan details"
	}
	return strings.Join(parts, ", ")
}
func FormatDiagnosticsReport(d Diagnostics, accounts *AccountsReport) string {
	transport := "not resolved"
	if d.TransportResolved {
		transport = "resolved"
	}
	providers := []string{"anthropic"}
	for _, p := range d.ShapedProviders {
		providers = append(providers, p.Name+" ("+p.Layer+")")
	}
	lines := []string{"pi-anthropic-auth diagnostics", "  version: " + d.Version, "  module:  " + d.ModulePath, "  built-in Anthropic transport: " + transport, "  shaped providers: " + strings.Join(providers, ", ")}
	if accounts != nil {
		lines = append(lines, "  accounts:")
		for _, a := range accounts.Accounts {
			description := "no OAuth login"
			switch a.Lookup.Kind {
			case "unavailable":
				description = "unavailable (" + a.Lookup.Reason + ")"
			case "profile":
				description = describeProfile(a.Lookup.Profile, accounts.IncludeIdentity)
			}
			lines = append(lines, "    "+a.Provider+": "+description)
		}
	}
	if len(d.ConfigWarnings) > 0 {
		lines = append(lines, "  config warnings:")
		for _, warning := range d.ConfigWarnings {
			lines = append(lines, "    "+warning)
		}
	}
	return strings.Join(lines, "\n")
}

// CollectAccounts joins parallel lookups in provider order. Identity opt-in is
// independent of lookup: the ordinary report still fetches plan details.
func CollectAccounts(ctx context.Context, d Diagnostics, args string, lookup func(context.Context, string) (AccountLookup, error)) (*AccountsReport, error) {
	providers := []string{"anthropic"}
	for _, p := range d.ShapedProviders {
		providers = append(providers, p.Name)
	}
	report := &AccountsReport{Accounts: make([]ProviderAccount, len(providers))}
	for _, arg := range strings.FieldsFunc(jsstr.Trim(args), jsstr.IsJSSpace) {
		if arg == "--account" {
			report.IncludeIdentity = true
		}
	}
	errs := make([]error, len(providers))
	var wg sync.WaitGroup
	for i, p := range providers {
		wg.Go(func() { value, err := lookup(ctx, p); report.Accounts[i] = ProviderAccount{p, value}; errs[i] = err })
	}
	wg.Wait()
	for _, err := range errs {
		if err != nil {
			return nil, err
		}
	}
	return report, nil
}
