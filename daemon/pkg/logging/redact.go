package logging

import "regexp"

var (
	deviceTokenRE = regexp.MustCompile(`\bdt_[A-Za-z0-9_-]{16,}\b`)
	jwtRE         = regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b`)
	bearerRE      = regexp.MustCompile(`(?i)(bearer\s+)[A-Za-z0-9._~-]+`)
)

// Redact removes credentials before they reach a local file, terminal, or
// diagnostics archive. It intentionally leaves public WireGuard keys and VPN
// addresses intact because they are needed to correlate a network incident.
func Redact(s string) string {
	s = deviceTokenRE.ReplaceAllString(s, "[REDACTED_DEVICE_TOKEN]")
	s = jwtRE.ReplaceAllString(s, "[REDACTED_JWT]")
	return bearerRE.ReplaceAllString(s, "${1}[REDACTED]")
}
