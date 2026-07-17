import type { LobbyEntry } from "../bridge";

export default function LobbyRail({ lobbies, activeID, onSelect, onCreate, onJoin }: {
  lobbies: LobbyEntry[];
  activeID: string;
  onSelect: (lobbyID: string) => void;
  onCreate: () => void;
  onJoin: () => void;
}) {
  return <nav className="lobby-rail">
    <div className="brand-mark small">O</div>
    {lobbies.map(({ lobby }) => (
      <button key={lobby.id} className={activeID === lobby.id ? "lobby active" : "lobby"} onClick={() => onSelect(lobby.id)} title={lobby.name}>
        {lobby.name.slice(0, 2).toUpperCase()}
      </button>
    ))}
    <button className="lobby add" title="创建大厅" onClick={onCreate}>+</button>
    <button className="lobby add" title="加入大厅" onClick={onJoin}>↗</button>
  </nav>;
}
