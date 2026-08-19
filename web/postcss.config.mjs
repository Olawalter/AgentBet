import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));

export default {
  plugins: {
    // Pointed at explicitly. Left to auto-discovery, Tailwind silently falls
    // back to its default (empty-content) config when the search misses, which
    // emits preflight and no utilities and looks exactly like a broken design.
    tailwindcss: { config: path.join(here, "tailwind.config.js") },
    autoprefixer: {},
  },
};
