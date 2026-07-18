import type { Metadata } from "next";
import { FleetConsole } from "./FleetConsole";

export const metadata: Metadata = {
  title: "OurCord 运营面板",
  robots: { index: false, follow: false },
};

// Operator-only fleet dashboard. The static shell is server-rendered (so the
// route is testable and paints instantly); the interactive fleet view is a
// client island that authenticates against control and polls /api/control/fleet.
export default function AdminPage() {
  return (
    <main className="adminShell">
      <header className="adminHead">
        <h1>OurCord 运营面板</h1>
        <p>中继车队与文件后端健康总览。仅限 ADMIN_USER_IDS 白名单内的运营者。</p>
      </header>
      <FleetConsole />
    </main>
  );
}
