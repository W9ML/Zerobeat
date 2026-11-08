"use client";
import { useState } from "react";

import { Button, Card, Field, Input, Notice } from "@/components/ui";
import { api } from "@/lib/client/api";
import { LogoMark } from "@/components/logo";
import { MIN_PASSWORD_LENGTH } from "@zerobeat/core/auth/policy";

export function SetupForm() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    if (f.password !== f.confirm) return setError("The passwords do not match.");
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/setup", { body: f });
      window.location.href = "/settings";
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-dvh place-items-center p-4">
      <div className="w-full max-w-md">
        <div className="mb-6">
          <div className="flex items-center gap-2.5">
            <LogoMark size={40} />
            <span className="text-lg font-semibold tracking-tight">Set up Zerobeat</span>
          </div>
          <p className="mt-2 text-sm text-muted">Create the administrator account and your station. Everything else is on the Settings page afterwards.</p>
        </div>
        <Card>
          <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
            <Field label="Your name" className="sm:col-span-2">
              <Input name="name" required autoFocus />
            </Field>
            <Field label="Email" className="sm:col-span-2">
              <Input name="email" type="email" autoComplete="username" required />
            </Field>
            <Field label="Station callsign">
              <Input name="callsign" required className="uppercase" />
            </Field>
            <Field label="Grid locator" help="e.g. EN61jk">
              <Input name="grid" required />
            </Field>
            <Field label="Password" help={`${MIN_PASSWORD_LENGTH} characters or more`}>
              <Input name="password" type="password" autoComplete="new-password" minLength={MIN_PASSWORD_LENGTH} required />
            </Field>
            <Field label="Confirm password">
              <Input name="confirm" type="password" autoComplete="new-password" required />
            </Field>
            {error && (
              <div className="sm:col-span-2">
                <Notice tone="bad">{error}</Notice>
              </div>
            )}
            <Button type="submit" variant="primary" className="sm:col-span-2" disabled={busy}>
              {busy ? "Creating…" : "Create account and station"}
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
