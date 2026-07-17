import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sutra — Counterparty intelligence",
  description: "Map the relationships hidden inside credit rating reports.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
