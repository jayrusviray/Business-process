"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { phToE164 } from "@/lib/phone";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const LoginInput = z.object({
  /** Staff use email; drivers use their mobile number. */
  email: z.string().trim().min(3, "Enter your email or mobile number"),
  password: z.string().min(1, "Enter your password"),
  next: z.string().optional(),
});

export type LoginState = { error?: string };

/** Only allow same-site relative redirects after login. */
function safeNext(next: string | undefined): string {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

export async function signIn(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = LoginInput.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const supabase = await createSupabaseServerClient();
  const id = parsed.data.email;
  let credentials: { email: string; password: string } | { phone: string; password: string };
  if (id.includes("@")) {
    credentials = { email: id, password: parsed.data.password };
  } else {
    try {
      credentials = { phone: phToE164(id), password: parsed.data.password };
    } catch {
      return { error: "Enter a valid email or PH mobile number (e.g. 0917 123 4567)." };
    }
  }
  const { error } = await supabase.auth.signInWithPassword(credentials);
  if (error) return { error: "Incorrect login or password." };
  redirect(safeNext(parsed.data.next));
}
