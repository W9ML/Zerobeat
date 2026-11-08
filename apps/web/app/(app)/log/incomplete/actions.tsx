"use client";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui";
import { api } from "@/lib/client/api";

export function Actions({ id }: { id: string }) {
  const router = useRouter();
  const go = async (action: "promote" | "dismiss") => {
    await api(`/api/incomplete/${id}`, { body: { action } });
    router.refresh();
  };
  return (
    <div className="flex gap-2">
      <Button size="sm" variant="ghost" onClick={() => go("dismiss")}>
        Dismiss
      </Button>
      <Button size="sm" variant="primary" onClick={() => go("promote")}>
        Add to log
      </Button>
    </div>
  );
}
