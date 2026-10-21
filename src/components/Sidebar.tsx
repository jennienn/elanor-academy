// src/components/Sidebar.tsx
"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

const NAV_ITEMS = [
  {
    href: "/",
    label: "홈",
    ready: true,
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 11l9-8 9 8" />
        <path d="M5 10v10a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V10" />
      </svg>
    )
  },
  {
    href: "/daily",
    label: "수업 일정",
    ready: true,
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="9" />
        <path d="M8 12l3 3 5-6" />
      </svg>
    )
  },
  {
    href: "/attendance",
    label: "단체 출석",
    ready: true,
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="5" width="18" height="16" rx="2" />
        <path d="M3 10h18" />
        <path d="M8 3v4M16 3v4" />
        <path d="M9 15l2 2 4-4" />
      </svg>
    )
  },
  {
    href: "/products",
    label: "수강권 관리",
    ready: true,
    icon: (
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 5h16a1 1 0 0 1 1 1v3a3 3 0 0 0 0 6v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-3a3 3 0 0 0 0-6V6a1 1 0 0 1 1-1Z" />
        <path d="M15 5v3m0 3v2m0 3v3" />
      </svg>
    )
  },
  {
    href: "/members",
    label: "회원",
    ready: true,
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="9" cy="8" r="3" />
        <path d="M2 20c0-3.3 3-6 7-6s7 2.7 7 6" />
        <circle cx="17" cy="9" r="2.3" />
        <path d="M16 14.2c2.5.4 4 2.1 4 5.8" />
      </svg>
    )
  },
  {
    href: "/members/withdrawn",
    label: "탈퇴 회원",
    ready: true,
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="9" cy="8" r="3" />
        <path d="M2 20c0-3.3 3-6 7-6s7 2.7 7 6" />
        <path d="M15 5l6 6M21 5l-6 6" />
      </svg>
    )
  }
];

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const supabase = createSupabaseBrowserClient();

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <aside className="sidebar">
      {NAV_ITEMS.map((item) => {
        const active = pathname === item.href;
        if (!item.ready) {
          // 아직 화면이 없는 메뉴는 클릭 불가 처리 (다음 단계에서 하나씩 채울 예정)
          return (
            <span key={item.href} className="nav-item disabled" title="준비 중">
              {item.icon}
              <span>{item.label}</span>
            </span>
          );
        }
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-label={item.label}
            className={`nav-item${active ? " active" : ""}`}
          >
            {item.icon}
            <span>{item.label}</span>
          </Link>
        );
      })}
      <button className="logout-btn" onClick={handleLogout}>
        로그아웃
      </button>
    </aside>
  );
}
