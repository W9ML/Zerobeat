import { redirect } from "next/navigation";

import { userCount } from "@zerobeat/core/auth/sessions";

import { db } from "@/lib/server/ctx";

import { SetupForm } from "./form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Set up" };

export default function SetupPage() {
  if (userCount(db()) > 0) redirect("/login");
  return <SetupForm />;
}
