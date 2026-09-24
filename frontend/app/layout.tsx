import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/lib/AuthProvider";
import { ToastProvider } from "@/components/Toast";
import { ServiceStatusProvider, StatusBanner } from "@/components/ServiceStatus";

// Self-hosted at build time (no render-blocking external request, no FOUC).
// Inter is a variable font, so every weight from 300 to 800 comes from one file.
// Exposed as a CSS variable so every component references one source of truth.
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Asistente de soporte · TotalDealer",
  description: "Asistente de soporte TotalDealer",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className={inter.variable} suppressHydrationWarning>
      <head>
        {/* Restore theme before first paint to avoid FOUC */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{const t=localStorage.getItem('theme');if(t==='dark'||(!t&&window.matchMedia('(prefers-color-scheme: dark)').matches)){document.documentElement.classList.add('dark');}}catch(e){}`,
          }}
        />
      </head>
      <body className="h-full">
        <AuthProvider>
          <ToastProvider>
            <ServiceStatusProvider>
              {/* The service-status strip sits in the layout flow above every
                  page (login included) and pages scroll below it — a floating
                  banner would cover the chat input. */}
              <div className="flex flex-col h-full">
                <StatusBanner />
                <div className="flex-1 min-h-0 overflow-y-auto flex flex-col">{children}</div>
              </div>
            </ServiceStatusProvider>
          </ToastProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
