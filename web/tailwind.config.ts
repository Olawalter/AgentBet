import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          DEFAULT: "#08090A",
          raised: "#0E1012",
          panel: "#131619",
          line: "#22272B",
        },
        bone: { DEFAULT: "#EDEEF0", dim: "#9BA3AA", faint: "#5C656D" },
        amber: { DEFAULT: "#FF6B1A", soft: "#FF8C4B", deep: "#C4460A" },
        yes: "#3FBF7F",
        no: "#E0503F",
      },
      fontFamily: {
        display: ["var(--font-display)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
      borderRadius: { none: "0", sm: "2px", DEFAULT: "3px" },
    },
  },
  plugins: [],
} satisfies Config;
