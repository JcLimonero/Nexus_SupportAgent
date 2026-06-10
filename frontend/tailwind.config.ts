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
        sans: ["Barlow", "sans-serif"],
        condensed: ['"Barlow Condensed"', "sans-serif"],
      },
      colors: {
        gv: {
          black:        "#222222",
          gray:         "#98989A",
          "gray-light": "#f0f0f0",
          "gray-mid":   "#d8d8d8",
          white:        "#ffffff",
          border:       "#e0e0e0",
          "page-bg":    "#ebebeb",
        },
      },
      letterSpacing: {
        "gv-label": "3px",
        "gv-btn":   "2.5px",
        "gv-small": "2px",
      },
    },
  },
  plugins: [],
};
export default config;
