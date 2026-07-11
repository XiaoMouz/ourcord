// Package logging provides safe structured runtime logging for the daemon.
package logging

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"sync"
	"time"
)

// Level controls the minimum emitted severity.
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

// Writer converts standard-library log lines into newline-delimited JSON. It
// is safe for concurrent writers, which matters because daemon callbacks log
// from ICE, relay, IPC, and control goroutines.
type Writer struct {
	mu        sync.Mutex
	dst       io.Writer
	component string
	min       Level
	format    string
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
	return &Writer{dst: dst, component: component, min: min, format: format}, nil
}

func (w *Writer) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	originalLen := len(p)
	w.partial = append(w.partial, p...)
	for {
		i := bytes.IndexByte(w.partial, '\n')
		if i < 0 {
			break
		}
		line := string(w.partial[:i])
		w.partial = w.partial[i+1:]
		if err := w.writeLine(line); err != nil {
			return 0, err
		}
	}
	return originalLen, nil
}

func (w *Writer) writeLine(line string) error {
	line = strings.TrimSpace(line)
	if line == "" {
		return nil
	}
	line = Redact(line)
	level := classify(line)
	if level < w.min {
		return nil
	}
	if w.format == "text" {
		_, err := fmt.Fprintln(w.dst, line)
		return err
	}
	encoded, err := json.Marshal(map[string]any{
		"ts":        time.Now().UTC().Format(time.RFC3339Nano),
		"level":     level.String(),
		"component": w.component,
		"event":     eventFor(line),
		"msg":       line,
	})
	if err != nil {
		return err
	}
	_, err = fmt.Fprintln(w.dst, string(encoded))
	return err
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

func classify(msg string) Level {
	lower := strings.ToLower(msg)
	if strings.Contains(lower, "fatal") || strings.Contains(lower, " error") ||
		strings.Contains(lower, "failed") || strings.Contains(lower, "unreachable") {
		return Error
	}
	if strings.Contains(lower, "warn") || strings.Contains(lower, "timeout") || strings.Contains(lower, "degraded") {
		return Warn
	}
	return Info
}

func eventFor(msg string) string {
	lower := strings.ToLower(msg)
	switch {
	case strings.Contains(lower, "peer upgraded to ice direct"):
		return "network.path.direct"
	case strings.Contains(lower, "fallback state applied"):
		return "network.path.derp_fallback"
	case strings.Contains(lower, "next-hop"):
		return "network.path.next_hop"
	case strings.Contains(lower, "device credential exchanged"):
		return "auth.device_exchanged"
	case strings.Contains(lower, "device token refreshed"):
		return "auth.device_refreshed"
	case strings.Contains(lower, "registered peer"):
		return "network.peer_registered"
	default:
		return "runtime.log"
	}
}
