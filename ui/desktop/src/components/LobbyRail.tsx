import type { LobbyEntry } from "../bridge";
import { InitialAvatar, Tooltip, cx } from "./ui";

export default function LobbyRail({ lobbies, activeID, onSelect, onCreate, onJoin }: {
  lobbies: LobbyEntry[];
  activeID: string;
  onSelect: (lobbyID: string) => void;
  onCreate: () => void;
  onJoin: () => void;
}) {
  return <nav className="flex flex-col items-center border-r border-base-300 bg-base-200 py-4">
    <InitialAvatar name="OurCord" size="md" online />
    <div className="divider my-2 w-10" />
    <ul className="menu menu-sm w-full flex-1 items-center gap-2 overflow-y-auto px-3">
      {lobbies.map(({ lobby }) => <li key={lobby.id}>
        <Tooltip label={lobby.name} side="right">
          <button className={cx("btn btn-square", activeID === lobby.id ? "btn-primary" : "btn-ghost")}
            aria-label={lobby.name} onClick={() => onSelect(lobby.id)}>
            {lobby.name.slice(0, 2).toUpperCase()}
          </button>
        </Tooltip>
      </li>)}
    </ul>
    <div className="flex flex-col gap-2 px-3">
      <Tooltip label="创建大厅" side="right"><button className="btn btn-square btn-ghost" aria-label="创建大厅" onClick={onCreate}>＋</button></Tooltip>
      <Tooltip label="加入大厅" side="right"><button className="btn btn-square btn-ghost" aria-label="加入大厅" onClick={onJoin}>↗</button></Tooltip>
    </div>
  </nav>;
}
