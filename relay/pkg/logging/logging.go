// Package logging provides safe JSON Lines logging for relay processes.
package logging

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"strings"
	"sync"
	"time"
)

type Level int

const (
	Debug Level = iota
	Info
	Warn
	Error
)

func ParseLevel(raw string) (Level, error) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "debug":
		return Debug, nil
	case "info", "":
		return Info, nil
	case "warn", "warning":
		return Warn, nil
	case "error":
		return Error, nil
	default:
		return Info, fmt.Errorf("invalid log level %q (want debug, info, warn, or error)", raw)
	}
}

func (l Level) String() string {
	switch l {
	case Debug:
		return "debug"
	case Warn:
		return "warn"
	case Error:
		return "error"
	default:
		return "info"
	}
}

type Writer struct {
	mu        sync.Mutex
	dst       io.Writer
	component string
	format    string
	min       Level
	partial   []byte
}

func NewWriter(dst io.Writer, component, format string, min Level) (*Writer, error) {
	format = strings.ToLower(strings.TrimSpace(format))
	if format == "" {
		format = "json"
	}
	if format != "json" && format != "text" {
		return nil, fmt.Errorf("invalid log format %q (want json or text)", format)
	}
	return &Writer{dst: dst, component: component, format: format, min: min}, nil
}

func (w *Writer) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	n := len(p)
	w.partial = append(w.partial, p...)
	for {
		i := bytes.IndexByte(w.partial, '\n')
		if i < 0 {
			break
		}
		line := strings.TrimSpace(string(w.partial[:i]))
		w.partial = w.partial[i+1:]
		if line == "" {
			continue
		}
		line = Redact(line)
		level := classify(line)
		if level < w.min {
			continue
		}
		if w.format == "text" {
			if _, err := fmt.Fprintln(w.dst, line); err != nil {
				return 0, err
			}
			continue
		}
		body, err := json.Marshal(map[string]any{
			"ts": time.Now().UTC().Format(time.RFC3339Nano), "level": level.String(),
			"component": w.component, "event": eventFor(line), "msg": line,
		})
		if err != nil {
			return 0, err
		}
		if _, err := fmt.Fprintln(w.dst, string(body)); err != nil {
			return 0, err
		}
	}
	return n, nil
}

func classify(msg string) Level {
	lower := strings.ToLower(msg)
	if strings.Contains(lower, "fatal") || strings.Contains(lower, " error") || strings.Contains(lower, "failed") {
		return Error
	}
	if strings.Contains(lower, "warn") || strings.Contains(lower, "timeout") {
		return Warn
	}
	return Info
}

func eventFor(msg string) string {
	lower := strings.ToLower(msg)
	switch {
	case strings.Contains(lower, "registered as relay") || strings.Contains(lower, "resuming as relay"):
		return "relay.registered"
	case strings.Contains(lower, "ban"):
		return "relay.banlist"
	case strings.Contains(lower, "stun"):
		return "relay.stun"
	default:
		return "runtime.log"
	}
}

var (
	deviceTokenRE = regexp.MustCompile(`\bdt_[A-Za-z0-9_-]{16,}\b`)
	jwtRE         = regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b`)
	bearerRE      = regexp.MustCompile(`(?i)(bearer\s+)[A-Za-z0-9._~-]+`)
)

func Redact(s string) string {
	s = deviceTokenRE.ReplaceAllString(s, "[REDACTED_DEVICE_TOKEN]")
	s = jwtRE.ReplaceAllString(s, "[REDACTED_JWT]")
	return bearerRE.ReplaceAllString(s, "${1}[REDACTED]")
}
