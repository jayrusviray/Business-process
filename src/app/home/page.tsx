import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { homePathFor } from "@/lib/auth/roles";

/** After sign-in: send each user to their own area (staff app, portal, or pending). */
export default async function Home() {
  const session = await getSession();
  redirect(session ? homePathFor(session.roles) : "/login");
}
