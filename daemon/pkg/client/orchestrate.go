package client

import "errors"

// VoiceInputPrefs are optional input-gating preferences applied before joining
// voice. nil leaves the daemon's current settings untouched — the daemon only
// reports the active input_mode back (not threshold/hangover), so presenters
// own the persisted values and pass them in.
type VoiceInputPrefs struct {
	Mode          string
	ThresholdDBFS float64
	HangoverMS    uint32
}

// JoinVoiceNetwork orchestrates "switch to this network and join its voice
// session" as one operation: leave any current voice session, leave a
// different current network, bring the VPN up, enter the target network,
// optionally apply input preferences, and join voice. Already being in the
// target network's voice session is a no-op. Presenters must call this instead
// of re-implementing the sequence (docs/ui/client-core.md).
func (c *Client) JoinVoiceNetwork(networkID string, prefs *VoiceInputPrefs) error {
	if networkID == "" {
		return errors.New("join-voice-network: network id required")
	}
	// Decide from fresh daemon state, not a cached snapshot: the
	// leave/connect/enter sequence must not race a stale UI poll.
	status, err := c.Status()
	if err != nil {
		return err
	}
	voice, err := c.VoiceStatus()
	if err != nil {
		return err
	}
	if voice.Joined && status.NetworkID == networkID {
		return nil
	}
	if voice.Joined {
		if err := c.VoiceLeave(); err != nil {
			return err
		}
	}
	if status.NetworkID != "" && status.NetworkID != networkID {
		if err := c.LeaveNetwork(); err != nil {
			return err
		}
	}
	if !status.VPNActive {
		if err := c.Connect(); err != nil {
			return err
		}
	}
	if err := c.EnterNetwork(networkID); err != nil {
		return err
	}
	if prefs != nil {
		if err := c.SetVoiceInputMode(prefs.Mode, prefs.ThresholdDBFS, prefs.HangoverMS); err != nil {
			return err
		}
	}
	return c.VoiceJoin()
}
