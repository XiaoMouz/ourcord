import type { LobbyEntry } from "../bridge";
import { cx } from "./ui";

export default function LobbyRail({ lobbies, activeID, onSelect, onCreate, onJoin }: {
  lobbies: LobbyEntry[];
  activeID: string;
  onSelect: (lobbyID: string) => void;
  onCreate: () => void;
  onJoin: () => void;
}) {
  return <nav className="lobby-strip" aria-label="大厅">
    <strong>大厅</strong>
    <ul className="lobby-tabs">
      {lobbies.map(({ lobby }) => <li key={lobby.id}>
        <button type="button" className={cx("btn btn-sm", activeID === lobby.id ? "btn-primary" : "btn-ghost")}
          aria-current={activeID === lobby.id ? "true" : undefined} title={lobby.name}
          aria-label={lobby.name} onClick={() => onSelect(lobby.id)}><span className="truncate">{lobby.name}</span></button>
      </li>)}
    </ul>
    <button className="btn btn-ghost btn-sm" onClick={onCreate}>创建大厅</button>
    <button className="btn btn-outline btn-sm" onClick={onJoin}>加入大厅</button>
  </nav>;
}
