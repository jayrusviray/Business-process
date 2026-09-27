import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { homePathFor } from "@/lib/auth/roles";

export default async function Root() {
  const session = await getSession();
  redirect(session ? homePathFor(session.roles) : "/login");
}
