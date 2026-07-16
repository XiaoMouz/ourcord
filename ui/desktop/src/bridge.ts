import { invoke } from "@tauri-apps/api/core";

export async function bridge<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  return invoke<T>("bridge_call", { method, params });
}

export type Room = { id: string; lobby_id: string; name: string; type: string; position: number; vpn_namespace?: string };
export type LobbyEntry = {
  lobby: { id: string; name: string; owner_id: string; icon?: string };
  member: { role: "owner" | "admin" | "member" | "guest"; joined_at: number };
  rooms: Room[];
};
export type Peer = { public_key: string; user_id?: string; display_name?: string; name: string; path: string; latency_ms: number; flapping?: boolean };
export type Voice = { joined: boolean; muted: boolean; deafened: boolean; input_mode?: string; local_speaking: boolean; transmitting: boolean; participants?: Array<{ public_key: string; speaking: boolean; secure: boolean; loss_percent: number; jitter_ms: number }> };
export type Snapshot = { daemon_available: boolean; status?: { vpn_active: boolean; network_id?: string; path_summary: string; relay_used: boolean; path_flaps_total: number }; peers?: Peer[]; voice?: Voice };
