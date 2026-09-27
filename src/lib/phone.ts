/** "09171234567" → "+639171234567" (E.164, as Supabase Auth stores phones). */
export function phToE164(local09: string): string {
  const d = local09.replace(/[^\d]/g, "");
  if (/^09\d{9}$/.test(d)) return `+63${d.slice(1)}`;
  if (/^639\d{9}$/.test(d)) return `+${d}`;
  throw new Error(`Not a PH mobile number: ${local09}`);
}

/** Readable temporary password (no look-alike characters), e.g. "kf7m-3xrq-9p". */
export function temporaryPassword(bytes: Uint8Array = crypto.getRandomValues(new Uint8Array(10))): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}-${chars.slice(8, 10).join("")}`;
}
