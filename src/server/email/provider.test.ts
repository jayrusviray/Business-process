import { describe, expect, it } from "vitest";
import { getEmailProvider, noopProvider, resendProvider } from "./provider";

describe("email provider", () => {
  it("is a no-op unless both RESEND_API_KEY and REPORTS_EMAIL_FROM are set", async () => {
    expect(getEmailProvider({})).toBe(noopProvider);
    expect(getEmailProvider({ RESEND_API_KEY: "k" })).toBe(noopProvider);
    expect(await noopProvider.send({ to: ["a@b.c"], subject: "s", text: "t" })).toEqual({ status: "skipped" });
    expect(getEmailProvider({ RESEND_API_KEY: "k", REPORTS_EMAIL_FROM: "TransRev <r@x.ph>" }).name).toBe("resend");
  });

  it("posts to Resend with the key, base64 attachments, and reports failures", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const ok = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: "em_1" }), { status: 200 });
    }) as unknown as typeof fetch;
    const p = resendProvider("key123", "TransRev <r@x.ph>", ok);
    const r = await p.send({ to: ["owner@x.ph"], subject: "Daily", text: "hi", attachments: [{ filename: "a.csv", content: Buffer.from("x,y") }] });
    expect(r).toEqual({ status: "sent", id: "em_1" });
    expect(calls[0].url).toBe("https://api.resend.com/emails");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer key123");
    expect(JSON.parse(String(calls[0].init.body)).attachments).toEqual([{ filename: "a.csv", content: Buffer.from("x,y").toString("base64") }]);

    const bad = (async () => new Response("nope", { status: 422 })) as unknown as typeof fetch;
    expect(await resendProvider("k", "f", bad).send({ to: ["a@b.c"], subject: "s", text: "t" })).toMatchObject({ status: "failed" });
  });
});
