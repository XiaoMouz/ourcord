// Check that the daemon's ICE implementation can gather a reflexive candidate
// before same-subnet host candidates can make the network smoke pass.
package main

import (
	"fmt"
	"os"
	"time"

	"github.com/ourcord/ourcord/daemon/pkg/ice"
	pion "github.com/pion/ice/v4"
)

func checkServer(url string) error {
	result := make(chan []string, 1)
	agent, err := ice.NewAgent(ice.Config{
		STUNServers: []string{url},
		OnCandidates: func(candidates []string) {
			result <- candidates
		},
	})
	if err != nil {
		return err
	}
	defer agent.Close()
	if err := agent.GatherCandidates(); err != nil {
		return err
	}
	select {
	case candidates := <-result:
		for _, raw := range candidates {
			candidate, err := pion.UnmarshalCandidate(raw)
			if err != nil {
				return err
			}
			if candidate.Type() == pion.CandidateTypeServerReflexive {
				return nil
			}
		}
		return fmt.Errorf("no server-reflexive candidate from %s", url)
	case <-time.After(12 * time.Second):
		return fmt.Errorf("candidate gathering timed out for %s", url)
	}
}

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: check-stun stun:host:port")
		os.Exit(2)
	}
	if err := checkServer(os.Args[1]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Println("Local STUN server produced a server-reflexive ICE candidate")
}
