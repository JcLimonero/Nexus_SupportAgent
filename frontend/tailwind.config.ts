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
        // Backed by the next/font CSS variables defined in app/layout.tsx.
        sans: ["var(--font-body)"],
        condensed: ["var(--font-condensed)"],
      },
      colors: {
        // Nexus Q Tech brand palette (mirrors the CSS variables in globals.css).
        nqt: {
          blue: "#0ea5e9",
          "blue-dark": "#0284c7",
          navy: "#0a2540",
          "navy-mid": "#1e3a5f",
          cyan: "#06b6d4",
        },
      },
      letterSpacing: {
        label: "2px",
        btn: "2px",
      },
    },
  },
  plugins: [],
};
export default config;
