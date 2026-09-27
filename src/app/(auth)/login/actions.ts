"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const LoginInput = z.object({
  email: z.email("Enter a valid email"),
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
  const { error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });
  if (error) return { error: "Incorrect email or password." };
  redirect(safeNext(parsed.data.next));
}
