// Package derp will host the OurCord daemon's DERP relay client.
//
// Status: placeholder. Implementation is tracked under plan.md G-B (daemon
// connect pipeline) — once the daemon wires control register → ICE/WG, this
// package will provide the relay-fallback transport that guarantees the
// 128 Kbps voice floor when direct hole-punching fails. Until then the
// daemon has only the ICE path (daemon/pkg/ice).
//
// Do not add unrelated code here; see plan.md before populating.
package derp
