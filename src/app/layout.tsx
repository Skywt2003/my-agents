import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import { RemoveButtonTooltips } from "@/components/remove-button-tooltips";
import { ThemeProvider } from "@/components/theme-provider";

import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const fontPreferenceScript = `try{var font=localStorage.getItem("myagents-font");if(font==="serif"||font==="sans")document.documentElement.dataset.font=font}catch(error){}`;

export const metadata: Metadata = {
  title: "MyAgents",
  description: "A minimal desktop-ready ACP client for local coding agents.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script
          dangerouslySetInnerHTML={{ __html: fontPreferenceScript }}
        />
      </head>
      <body className="min-h-full flex select-none flex-col overflow-hidden">
        <ThemeProvider
          attribute="class"
          defaultTheme="light"
          enableSystem
          disableTransitionOnChange
        >
          <RemoveButtonTooltips />
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
