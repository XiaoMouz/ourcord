import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { LobbyEntry, Member, Snapshot } from "../bridge";
import RoomPanel from "./RoomPanel";

describe("RoomPanel", () => {
  it("uses a restrained room hover state and lists account names in voice rooms", () => {
    const lobby = {
      lobby: { id: "L1", name: "Friends", owner_id: "u1" },
      member: { role: "owner", joined_at: 1 },
      rooms: [
        { id: "T1", lobby_id: "L1", name: "general", type: "text", position: 0 },
        { id: "V1", lobby_id: "L1", name: "voice", type: "voice", position: 1, vpn_namespace: "net-voice" },
      ],
    } as LobbyEntry;
    const members = [{ lobby_id: "L1", user_id: "u2", role: "member", joined_at: 2, online: true, voice_room_id: "V1" }] as Member[];
    const snapshot = {
      daemon_available: true,
      status: { vpn_active: true, network_id: "net-voice", path_summary: "direct", relay_used: false, path_flaps_total: 0 },
      peers: [{ public_key: "peer-key", user_id: "u2", display_name: "Alice", name: "Alice's MacBook", path: "direct", latency_ms: 20 }],
      voice: { joined: true, muted: false, deafened: false, local_speaking: false, transmitting: false, participants: [] },
    } as Snapshot;

    const html = renderToStaticMarkup(<RoomPanel
      lobby={lobby} selectedRoomID="V1" connectingRoomID="" snapshot={snapshot}
      members={members} getName={() => "Alice"} busy={false} canManage accountName="Me"
      onSelectRoom={vi.fn()} onCreateRoom={vi.fn()} onInvite={vi.fn()} onRenameRoom={vi.fn()}
      onDeleteRoom={vi.fn()} onReorderRoom={vi.fn()} onOpenSettings={vi.fn()} onLeaveVoice={vi.fn()}
      refreshSnapshot={async () => undefined} onError={vi.fn()} onCopy={vi.fn()}
    />);

    expect(html).toContain("hover:bg-base-200/70");
    expect(html).toContain("Alice");
    expect(html).toContain("avatar-online");
    expect(html).not.toContain("Alice&#x27;s MacBook");
  });
});

