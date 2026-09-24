import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        // Backed by the next/font CSS variable defined in app/layout.tsx.
        sans: ["var(--font-body)"],
      },
      colors: {
        // TotalDealer palette (mirrors the CSS variables in globals.css).
        td: {
          orange: "#F04A1A",
          "orange-dark": "#D93D12",
          navy: "#08243A",
        },
      },
    },
  },
  plugins: [],
};
export default config;
