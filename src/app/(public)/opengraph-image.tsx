import { ImageResponse } from "next/og";

export const alt = "TransRev — TNVS franchise, activation and vehicle programs";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/** Share image for Facebook/Messenger links (placeholder brand colours, see brand.css). */
export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: 80,
          background: "#15234a",
          color: "#f3f5fb",
        }}
      >
        <div style={{ fontSize: 44, fontWeight: 700, color: "#f2c14e" }}>TransRev</div>
        <div style={{ marginTop: 24, fontSize: 64, fontWeight: 700, lineHeight: 1.1 }}>TNVS franchise, activation &amp; vehicle programs</div>
        <div style={{ marginTop: 28, fontSize: 30, opacity: 0.85 }}>LTFRB PA/CPC · Platform onboarding · Boundary &amp; rent-to-own</div>
      </div>
    ),
    size,
  );
}
