export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  FILES: R2Bucket;
  ENVIRONMENT: string;
  CONTROL_URL?: string;       // control layer URL for cross-service calls
  JWT_SECRET?: string;
  ADMIN_TOKEN?: string;       // shared secret for admin endpoints in production
  // Shared secret accepted on /api/internal/* requests from control layer.
  SERVICE_INTERNAL_TOKEN?: string;
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
  storage_key: string; // R2 key or path under the backend's base_url
  backend_id?: string | null; // registered file backend (NULL for R2)
  expires_at?: number;
  created_at: number;
  upload_status?: "pending" | "uploaded" | "failed";
  upload_token_hash?: string | null;
  upload_expires_at?: number | null;
  uploaded_at?: number | null;
  actual_size_bytes?: number | null;
  last_upload_error?: string | null;
}

// A user-run HTTP file server in the autonomous storage chain (AGENTS 3.5).
export interface FileBackend {
  id: string;
  owner_id: string;
  lobby_id: string | null; // NULL = personal (自建/分享), non-NULL = 大厅
  name: string;
  base_url: string;
  active: number; // 1 = live, 0 = deactivated
  created_at: number;
  health_status?: "unknown" | "healthy" | "unhealthy";
  last_health_at?: number | null;
  last_health_error?: string | null;
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
