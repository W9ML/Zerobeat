"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/components/ui";

export function SettingsNav({ items }: { items: { href: string; label: string }[] }) {
  const path = usePathname();
  return (
    <nav className="flex gap-1 overflow-x-auto md:flex-col">
      {items.map((i, n) => (
        <Link
          key={i.href}
          href={i.href}
          className={cn(
            "whitespace-nowrap rounded-md px-3 py-1.5 text-sm",
            path === i.href || (path === "/settings" && n === 0) ? "bg-panel-3 text-fg" : "text-muted hover:bg-panel-2 hover:text-fg",
            i.href === "/settings/stations" && "md:mt-3",
          )}
        >
          {i.label}
        </Link>
      ))}
    </nav>
  );
}
