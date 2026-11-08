import { redirect } from "next/navigation";

import { safeNextPath } from "@/lib/safe-next";

import { userCount } from "@zerobeat/core/auth/sessions";

import { currentUser } from "@/lib/server/auth";
import { db } from "@/lib/server/ctx";

import { LogoMark, Name } from "@/components/logo";

import { LoginForm } from "./form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  if (userCount(db()) === 0) redirect("/setup");
  if (await currentUser()) redirect("/");
  const { next } = await searchParams;
  const safeNext = safeNextPath(next);
  return (
    <div className="grid min-h-dvh place-items-center p-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <LogoMark size={72} />
          <div>
            <Name className="text-2xl tracking-tight" />
            <div className="mt-1 text-xs text-subtle">Your rig · every digital mode · any browser</div>
          </div>
        </div>
        <LoginForm next={safeNext} />
      </div>
    </div>
  );
}
