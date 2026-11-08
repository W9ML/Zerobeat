"use client";
import { useRouter } from "next/navigation";

import { confirmDialog } from "@/components/overlays";
import { Button } from "@/components/ui";
import { api } from "@/lib/client/api";

export function DeleteButton({ id }: { id: string }) {
  const router = useRouter();
  return (
    <Button
      size="sm"
      variant="ghost"
      className="text-bad"
      onClick={async () => {
        if (
          !(await confirmDialog({
            title: "Delete this contact?",
            body: "It is removed from the log. Services it was already uploaded to keep their copy.",
            confirmLabel: "Delete",
            tone: "danger",
          }))
        )
          return;
        await api(`/api/qsos/${id}`, { method: "DELETE" });
        router.push("/log");
        router.refresh();
      }}
    >
      Delete
    </Button>
  );
}
