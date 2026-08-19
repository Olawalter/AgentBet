const path = require("path");

/** @type {import('tailwindcss').Config} */
module.exports = {
  // Absolute globs: content is otherwise resolved against the process cwd, and
  // a dev server started from anywhere but this directory silently produces a
  // stylesheet with preflight and zero utilities — i.e. an unstyled app.
  content: [path.join(__dirname, "src/**/*.{js,ts,jsx,tsx}")],
  theme: {
    extend: {
      colors: {
        ink: {
          DEFAULT: "#08090A",
          raised: "#101316",
          panel: "#161A1E",
          line: "#2A3137",
        },
        // Raised from the first pass: body copy at #9BA3AA and secondary at
        // #5C656D measured as washed-out grey on this background.
        bone: { DEFAULT: "#F2F3F5", dim: "#BAC2CA", faint: "#828C95" },
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
};
