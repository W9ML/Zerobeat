"use client";
/**
 * The SSTV contact being made, shared by the log card (where the call, report and name are
 * typed) and the send card (whose text fills them in: {call}, {rst}, {name}).
 */
import { useSyncExternalStore } from "react";

export interface SstvContact {
  call: string;
  rst: string;
  name: string;
}

let current: SstvContact = { call: "", rst: "595", name: "" };
const listeners = new Set<() => void>();

export function setSstvContact(c: Partial<SstvContact>): void {
  current = { ...current, ...c };
  for (const l of listeners) l();
}

export function useSstvContact(): SstvContact {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => current,
  );
}
