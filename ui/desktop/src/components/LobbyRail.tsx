import type { LobbyEntry } from "../bridge";
import Icon from "./Icon";
import { cx } from "./ui";

export default function LobbyRail({ lobbies, activeID, onSelect, onCreate, onJoin }: {
  lobbies: LobbyEntry[];
  activeID: string;
  onSelect: (lobbyID: string) => void;
  onCreate: () => void;
  onJoin: () => void;
}) {
  return <nav className="lobby-strip" aria-label="大厅">
    <ul className="lobby-tabs">
      {lobbies.map(({ lobby }) => <li key={lobby.id}>
        <button type="button" className={cx("server-button", activeID === lobby.id && "current")}
          aria-current={activeID === lobby.id ? "true" : undefined} title={lobby.name}
          aria-label={lobby.name} onClick={() => onSelect(lobby.id)}><span>{Array.from(lobby.name)[0]}</span></button>
      </li>)}
    </ul>
    <button className="server-button" title="创建大厅" aria-label="创建大厅" onClick={onCreate}><Icon name="plus" /></button>
    <button className="server-button" title="加入大厅" aria-label="加入大厅" onClick={onJoin}><Icon name="join" /></button>
  </nav>;
}
