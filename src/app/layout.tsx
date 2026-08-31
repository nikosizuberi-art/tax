import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Estimate of liability — personal income tax working paper",
  description:
    "Estimate personal income tax across twelve jurisdictions, with the full worked computation and its legal basis. Runs entirely in your browser.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* Three registers: the form voice, the statute voice, and the figures. */}
        <link
          href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&family=Source+Serif+4:ital,opsz,wght@1,8..60,400;1,8..60,500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
