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
export type Member = { lobby_id: string; user_id: string; role: "owner" | "admin" | "member" | "guest"; joined_at: number };
export type Message = { id: string; room_id: string; user_id: string; content: string; attachments?: string; created_at: number };
export type FileRecord = { id: string; room_id: string; uploader_id: string; filename: string; size_bytes: number; mime_type: string; created_at: number; upload_status?: string };
export type Profile = { id: string; display_name: string };
export type AudioDevice = { id: string; name: string; is_default: boolean };
export type Peer = {
  public_key: string; user_id?: string; display_name?: string; name: string;
  ip4?: string; ip6?: string; direct?: boolean; path: string; endpoint?: string;
  candidate_endpoint?: string; relay_url?: string; next_hop?: string;
  latency_ms: number; last_seen_secs?: number; last_error?: string;
  path_transitions?: number; path_dwell_secs?: number; flapping?: boolean;
};
export type TransportStats = {
  mtu?: number;
  ice_sent_packets?: number; ice_recv_packets?: number; ice_recv_drops?: number;
  ice_send_errors?: number; ice_recv_errors?: number; ice_probe_timeouts?: number;
  derp_sent_packets?: number; derp_recv_packets?: number; derp_recv_drops?: number;
  derp_send_errors?: number; derp_recv_errors?: number;
};
export type Voice = { joined: boolean; muted: boolean; deafened: boolean; input_mode?: string; local_speaking: boolean; transmitting: boolean; participants?: Array<{ public_key: string; speaking: boolean; secure: boolean; loss_percent: number; jitter_ms: number }> };
export type Snapshot = {
  daemon_available: boolean;
  status?: { vpn_active: boolean; network_id?: string; ip4?: string; ip6?: string; relay_url?: string; path_summary: string; relay_used: boolean; path_flaps_total: number; transport?: TransportStats };
  peers?: Peer[];
  voice?: Voice;
};
export type LocalProfile = { public_key: string; enrolled: boolean; device_id?: string; device_name?: string; user_id?: string };
export type Device = { id: string; public_key: string; name: string; created_at: number; last_used?: number | null; revoked_at?: number | null };
export type AuthState = { loading: boolean; authenticated: boolean; profile?: { user?: { id: string; display_name: string; email: string } } };
