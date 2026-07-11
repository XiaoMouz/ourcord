package logging

import "regexp"

var (
	deviceTokenRE = regexp.MustCompile(`\bdt_[A-Za-z0-9_-]{16,}\b`)
	// ourcord JWTs are two-part (b64url(payload).b64url(sig)), not the standard
	// three-part header.payload.signature, so the trailing segment is optional.
	jwtRE    = regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?\b`)
	bearerRE = regexp.MustCompile(`(?i)(bearer\s+)[A-Za-z0-9._~-]+`)
	// Catch tokens carried in URLs/query strings (e.g. the SignalDO `?token=`),
	// which are not preceded by "Bearer " and may not be JWT-shaped.
	tokenParamRE = regexp.MustCompile(`(?i)(token=)[A-Za-z0-9._~-]+`)
)

// Redact removes credentials before they reach a local file, terminal, or
// diagnostics archive. It intentionally leaves public WireGuard keys and VPN
// addresses intact because they are needed to correlate a network incident.
func Redact(s string) string {
	s = deviceTokenRE.ReplaceAllString(s, "[REDACTED_DEVICE_TOKEN]")
	s = jwtRE.ReplaceAllString(s, "[REDACTED_JWT]")
	s = bearerRE.ReplaceAllString(s, "${1}[REDACTED]")
	return tokenParamRE.ReplaceAllString(s, "${1}[REDACTED]")
}
