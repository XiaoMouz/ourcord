package main

import (
	"errors"
	"fmt"
	"slices"
	"testing"

	"golang.org/x/sys/windows"
)

func TestConfigureServiceSetsInstalledImage(t *testing.T) {
	const installed = `C:\New OurCord 安装\binaries\ourcord-service.exe`
	for _, tc := range []struct {
		name     string
		existing bool
		want     []string
	}{
		{"fresh", false, []string{"create", "failure", "start"}},
		{"upgrade", true, []string{"create", "config", "failure", "start"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls []string
			image := `"C:\Old OurCord\binaries\ourcord-service.exe"`
			err := configureService(installed, func(args ...string) error {
				calls = append(calls, args[0])
				argv, err := windows.DecomposeCommandLine(windows.ComposeCommandLine(append([]string{"sc.exe"}, args...)))
				if err != nil || !slices.Equal(argv[1:], args) {
					t.Fatalf("Windows command-line round trip: %q (%v)", argv, err)
				}
				if args[0] == "create" && tc.existing {
					return fmt.Errorf("create: %w", windows.ERROR_SERVICE_EXISTS)
				}
				switch args[0] {
				case "create", "config":
					wantSettings := []string{serviceName, "binPath=", `"` + installed + `"`, "start=", "delayed-auto", "DisplayName=", "OurCord Network Service"}
					if !slices.Equal(argv[2:], wantSettings) {
						t.Fatalf("service settings %q", argv[2:])
					}
					image = argv[4]
				case "failure":
					if !slices.Equal(args[1:], []string{serviceName, "reset=", "86400", "actions=", "restart/5000/restart/15000/restart/60000"}) {
						t.Fatalf("unexpected recovery settings: %q", args)
					}
				case "start":
					if image != `"`+installed+`"` {
						t.Fatalf("would start old service image %s", image)
					}
				}
				return nil
			})
			if err != nil || !slices.Equal(calls, tc.want) {
				t.Fatalf("calls %v, error %v", calls, err)
			}
		})
	}
}

func TestConfigureServiceStopsOnError(t *testing.T) {
	for _, operation := range []string{"create", "config", "failure", "start"} {
		t.Run(operation, func(t *testing.T) {
			failure := errors.New("command failed")
			var calls []string
			err := configureService(`C:\OurCord\binaries\ourcord-service.exe`, func(args ...string) error {
				calls = append(calls, args[0])
				if args[0] == operation {
					return failure
				}
				if args[0] == "create" {
					return windows.ERROR_SERVICE_EXISTS
				}
				return nil
			})
			if !errors.Is(err, failure) || len(calls) == 0 || calls[len(calls)-1] != operation {
				t.Fatalf("failed %s: calls %v, error %v", operation, calls, err)
			}
		})
	}
}
