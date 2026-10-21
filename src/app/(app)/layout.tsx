// src/app/(app)/layout.tsx
import { Sidebar } from "@/components/Sidebar";
import { BookingActivityBell } from "@/components/BookingActivityBell";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-shell">
      <Sidebar />
      <main className="main">
        <div className="app-toolbar"><BookingActivityBell /></div>
        {children}
      </main>
    </div>
  );
}
