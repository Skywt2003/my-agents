import type { Metadata } from "next";

import { RemoveButtonTooltips } from "@/components/remove-button-tooltips";
import { ThemeProvider } from "@/components/theme-provider";

import "./globals.css";

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
      className="h-full antialiased"
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
