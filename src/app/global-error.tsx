"use client";

import { useEffect } from "react";

/**
 * Last-resort error page (the root layout itself failed). It replaces the whole
 * document, so it carries its own minimal inline styles instead of the app CSS.
 */
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0, padding: "4rem 1rem", textAlign: "center", color: "#1f2330" }}>
        <title>Something went wrong · TransRev</title>
        <h1 style={{ fontSize: "1.5rem" }}>Something went wrong</h1>
        <p style={{ color: "#5b6070", maxWidth: "28rem", margin: "1rem auto" }}>
          Sorry, the app could not load. Please try again in a moment.
          {error.digest ? ` If it keeps happening, tell the office the code ${error.digest}.` : ""}
        </p>
        <button onClick={() => retry()} style={{ padding: "0.6rem 1.2rem", fontSize: "1rem", borderRadius: 8, border: "1px solid #ccc", cursor: "pointer" }}>
          Try again
        </button>
      </body>
    </html>
  );
}
