"use client";
/** Tiny helper for admin forms that POST to /api/admin and refresh. */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { api } from "@/lib/client/api";

export function useAdmin() {
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async <T,>(body: Record<string, unknown>): Promise<T | null> => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<T>("/api/admin", { body });
      router.refresh();
      return r;
    } catch (e) {
      setErr((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  };
  return { err, busy, run };
}
