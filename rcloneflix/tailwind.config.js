/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        // RcloneFlix dark cinema palette
        void: "#080A0F",
        surface: "#0E1117",
        panel: "#141820",
        border: "#1E2535",
        muted: "#2A3347",
        subtle: "#8892A4",
        text: "#C8D0DC",
        bright: "#EEF2F8",
        accent: "#E8A020",       // warm amber/gold — like a projector light
        "accent-dim": "#B87D18",
        "accent-glow": "#F0B840",
        teal: "#1EC8A0",         // secondary accent for indicators
        danger: "#E84040",
      },
      fontFamily: {
        display: ["'Bebas Neue'", "cursive"],
        body: ["'DM Sans'", "sans-serif"],
        mono: ["'JetBrains Mono'", "monospace"],
      },
      backgroundImage: {
        "noise": "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.03'/%3E%3C/svg%3E\")",
      },
      boxShadow: {
        "accent-glow": "0 0 30px rgba(232, 160, 32, 0.25)",
        "card-hover": "0 8px 40px rgba(0,0,0,0.6)",
      },
      animation: {
        "fade-up": "fadeUp 0.5s ease forwards",
        "shimmer": "shimmer 2s linear infinite",
      },
      keyframes: {
        fadeUp: {
          "0%": { opacity: "0", transform: "translateY(16px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
      },
    },
  },
  plugins: [],
};
