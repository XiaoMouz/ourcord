package main

import (
	"net/http"
	"strconv"
	"strings"
	"time"
)

type deviceRefreshCooldown struct {
	baseURL    string
	credential [32]byte
	until      time.Time
	err        error
}

func (b *bridge) now() time.Time {
	if b.clock != nil {
		return b.clock()
	}
	return time.Now()
}

// Retry-After allows either non-negative decimal seconds or an HTTP date.
// Invalid, overflowing or already elapsed values do not prevent recovery.
func parseRetryAfter(value string, now time.Time) time.Time {
	value = strings.TrimSpace(value)
	if value == "" {
		return time.Time{}
	}
	digits := true
	for _, c := range value {
		if c < '0' || c > '9' {
			digits = false
			break
		}
	}
	if digits {
		seconds, err := strconv.ParseUint(value, 10, 64)
		if err != nil || seconds == 0 || seconds > uint64((1<<63-1)/int64(time.Second)) {
			return time.Time{}
		}
		return now.Add(time.Duration(seconds) * time.Second)
	}
	if until, err := http.ParseTime(value); err == nil && until.After(now) {
		return until
	}
	return time.Time{}
}
