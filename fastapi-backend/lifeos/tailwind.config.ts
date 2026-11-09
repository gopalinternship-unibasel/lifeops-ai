import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        cream: "#FAFAF7",
        "cream-2": "#F2F1EA",
        ink: "#1F1D1A",
        moss: {
          DEFAULT: "#2D4A3E",
          50: "#EFF3F0",
          100: "#D8E2DB",
          400: "#5C7E70",
          600: "#22382F",
        },
        amber: {
          DEFAULT: "#E8A87C",
          soft: "#F4D2BB",
        },
        line: "#E5E2DA",
      },
      fontFamily: {
        sans: [
          "Inter",
          "PingFang SC",
          "Hiragino Sans GB",
          "Microsoft YaHei",
          "system-ui",
          "sans-serif",
        ],
        serif: [
          "Noto Serif SC",
          "Source Han Serif SC",
          "Songti SC",
          "SimSun",
          "serif",
        ],
      },
      boxShadow: {
        card: "0 1px 2px rgba(20, 20, 20, 0.04), 0 4px 12px rgba(20, 20, 20, 0.04)",
        "card-hover":
          "0 2px 4px rgba(20, 20, 20, 0.05), 0 12px 24px rgba(20, 20, 20, 0.06)",
      },
      borderRadius: {
        card: "16px",
      },
      keyframes: {
        "fade-in": {
          from: { opacity: "0", transform: "translateY(4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "soft-pulse": {
          "0%, 100%": { opacity: "0.6" },
          "50%": { opacity: "1" },
        },
      },
      animation: {
        "fade-in": "fade-in 0.4s ease-out both",
        "soft-pulse": "soft-pulse 1.6s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
