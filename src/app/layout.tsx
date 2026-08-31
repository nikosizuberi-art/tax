import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Multi-country income tax estimator",
  description:
    "Estimate personal income tax in Spain and Canada, with a full step-by-step calculation trace. Runs entirely in your browser.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
