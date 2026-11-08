"use client";
import { useState } from "react";

import { toast } from "@/components/overlays";
import { Button, Card, Field, Input } from "@/components/ui";
import { api, ApiError } from "@/lib/client/api";
import { MIN_PASSWORD_LENGTH } from "@zerobeat/core/auth/policy";

export function PasswordCard() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (next !== again) {
      setIssues({ again: "does not match" });
      return;
    }
    setBusy(true);
    setIssues({});
    try {
      await api("/api/auth/password", { body: { current, next } });
      setCurrent("");
      setNext("");
      setAgain("");
      toast({ title: "Password changed", body: "Your other sessions were signed out.", tone: "ok" });
    } catch (e) {
      if (e instanceof ApiError && e.issues) setIssues(e.issues);
      else toast({ title: "Password not changed", body: (e as Error).message, tone: "bad" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Password">
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-3">
        <Field label="Current" error={issues.current}>
          <Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        </Field>
        <Field label="New" help={`${MIN_PASSWORD_LENGTH} characters or more`} error={issues.next}>
          <Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} minLength={MIN_PASSWORD_LENGTH} required />
        </Field>
        <Field label="New again" error={issues.again}>
          <Input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} required />
        </Field>
        <div className="sm:col-span-3">
          <Button type="submit" variant="primary" disabled={busy}>
            Change password
          </Button>
        </div>
      </form>
    </Card>
  );
}
