import { getCurrentWindow } from "@tauri-apps/api/window";
import type { UpdaterState } from "../updater";
import { updateProgressPercent } from "../updater";
import { IconButton, Tooltip } from "./ui";

export default function TitleBar({ update, onInstall, onRetry }: {
  update: UpdaterState;
  onInstall: () => void;
  onRetry: () => void;
}) {
  const progress = updateProgressPercent(update);

  return <header className="navbar min-h-10 h-10 shrink-0 select-none border-b border-base-300 bg-base-100 px-2 py-0">
    <div className="navbar-start min-w-0 flex-1" data-tauri-drag-region>
      <span className="px-2 text-xs font-semibold tracking-[0.16em] text-base-content/70" data-tauri-drag-region>OURCORD</span>
    </div>
    <div className="navbar-end w-auto gap-1">
      {update.status === "downloading" && <Tooltip label={`OurCord ${update.version} 正在后台下载`} side="bottom">
        <span className="badge badge-info badge-soft badge-sm gap-2" role="status">
          <span className="loading loading-spinner loading-xs" />
          {progress === null ? "下载更新" : `下载更新 ${progress}%`}
        </span>
      </Tooltip>}
      {update.status === "ready" && <Tooltip label="已下载并验证，点击立即安装" side="bottom">
        <button type="button" className="btn btn-ghost btn-sm h-8 min-h-8 gap-2 px-2" onClick={onInstall}>
          <span className="status status-success status-sm" />
          更新 {update.version}
        </button>
      </Tooltip>}
      {update.status === "installing" && <span className="badge badge-success badge-soft badge-sm gap-2" role="status">
        <span className="loading loading-spinner loading-xs" />正在安装
      </span>}
      {update.status === "error" && <Tooltip label="自动更新失败，点击重试" side="bottom">
        <button type="button" className="btn btn-ghost btn-sm h-8 min-h-8 gap-2 px-2 text-error" onClick={onRetry}>
          <span className="status status-error status-sm" />更新失败
        </button>
      </Tooltip>}
      <div className="ml-1 flex items-center border-l border-base-300 pl-1">
        <IconButton label="最小化" className="h-8 min-h-8 w-9" onClick={() => void getCurrentWindow().minimize()}>—</IconButton>
        <IconButton label="最大化或还原" className="h-8 min-h-8 w-9" onClick={() => void getCurrentWindow().toggleMaximize()}>□</IconButton>
        <IconButton label="关闭" className="h-8 min-h-8 w-9 hover:bg-error hover:text-error-content" onClick={() => void getCurrentWindow().close()}>×</IconButton>
      </div>
    </div>
  </header>;
}
