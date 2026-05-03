// Package derp will host the OurCord daemon's DERP relay client.
//
// Status: placeholder. This package is part of the remaining Phase-1 closure
// work: once the daemon can drive peer-level connection state, this package
// will provide the relay-fallback transport that guarantees the 128 Kbps
// voice floor when direct hole-punching fails.
//
// Do not add unrelated code here; DERP client work must stay tied to daemon
// peer path selection.
package derp
