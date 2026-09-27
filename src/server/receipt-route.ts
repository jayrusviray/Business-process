import "server-only";
import { NextResponse } from "next/server";
import { withUserTx, type JwtClaims } from "@/db/client";
import { renderApplicationReceiptPdf, renderReceiptPdf } from "@/server/pdf/receipt";

/** Shared handler for the receipt PDF (staff and portal). RLS decides visibility. */
export async function receiptResponse(claims: JwtClaims, paymentId: string, kind: "driver" | "application" = "driver"): Promise<NextResponse> {
  if (!/^[0-9a-f-]{36}$/i.test(paymentId)) return new NextResponse("Not found", { status: 404 });
  const res = await withUserTx(claims, (tx) => (kind === "driver" ? renderReceiptPdf(tx, paymentId) : renderApplicationReceiptPdf(tx, paymentId)));
  if (!res) return new NextResponse("Not found", { status: 404 });
  return new NextResponse(new Uint8Array(res.pdf), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="${res.receiptNo}.pdf"`,
      "cache-control": "private, no-store",
    },
  });
}
