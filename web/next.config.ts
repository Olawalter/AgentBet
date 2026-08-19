import path from "path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // This app is its own workspace root. Without pinning it, Next walks up and
  // adopts an unrelated lockfile higher in the home directory.
  outputFileTracingRoot: path.resolve(process.cwd()),
  experimental: {
    // Windows: Next's parallel page workers raise `kill EPERM` when tearing
    // down child processes on this machine. A single in-process worker builds
    // identically, just slower. Linux CI (and Vercel) are unaffected either way.
    cpus: 1,
    workerThreads: false,
  },
};

export default nextConfig;
