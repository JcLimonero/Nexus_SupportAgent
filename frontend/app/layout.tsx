import type { Metadata } from "next";
import { Barlow, Barlow_Condensed } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/lib/AuthProvider";
import { ToastProvider } from "@/components/Toast";
import { ServiceStatusProvider, StatusBanner } from "@/components/ServiceStatus";

// Self-hosted at build time (no render-blocking external request, no FOUC).
// Exposed as CSS variables so every component references one source of truth.
const barlow = Barlow({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
  variable: "--font-barlow",
  display: "swap",
});
const barlowCondensed = Barlow_Condensed({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-barlow-condensed",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Nexus Support Agent",
  description: "Asistente de soporte TotalDealer",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className={`${barlow.variable} ${barlowCondensed.variable}`} suppressHydrationWarning>
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
