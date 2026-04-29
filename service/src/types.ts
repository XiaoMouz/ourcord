export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  FILES: R2Bucket;
  ENVIRONMENT: string;
  CONTROL_URL?: string;       // control layer URL for cross-service calls
  JWT_SECRET?: string;
}

export interface Lobby {
  id: string;
  name: string;
  owner_id: string;
  icon?: string;
  created_at: number;
  member_count?: number;
}

export interface Room {
  id: string;
  lobby_id: string;
  name: string;
  type: "text" | "voice" | "video" | "file";
  position: number;
  vpn_namespace?: string; // non-null for voice/video/file rooms
}

export interface LobbyMember {
  lobby_id: string;
  user_id: string;
  role: "owner" | "admin" | "member" | "guest";
  joined_at: number;
  display_name?: string;
}

export interface Message {
  id: string;
  room_id: string;
  user_id: string;
  content: string;
  attachments?: string; // JSON array of file refs
  created_at: number;
  edited_at?: number;
}

export interface FileRecord {
  id: string;
  room_id: string;
  uploader_id: string;
  filename: string;
  size_bytes: number;
  mime_type: string;
  storage_location: "user_server" | "lobby_server" | "r2";
  storage_key: string; // R2 key or external URL
  expires_at?: number;
  created_at: number;
}

export interface FilePolicy {
  lobby_id: string;
  max_size_bytes: number;           // per-file limit
  max_total_files: number;          // permanent count limit (0 = unlimited)
  max_temp_files: number;           // temporary count limit
  retain_days: number;              // 0 = keep forever
  r2_enabled: number;               // 1 = allowed, 0 = blocked
  user_server_enabled: number;
  lobby_server_enabled: number;
}
