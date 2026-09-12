import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Movie Magic | Your story. Your drive.",
  description: "A personalized, reference-led cinematic car commercial.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
