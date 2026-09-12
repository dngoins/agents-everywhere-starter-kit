import type { NextConfig } from "next";

const config: NextConfig = {
  poweredByHeader: false,
  outputFileTracingRoot: process.cwd(),
  turbopack: { root: process.cwd() },
  serverExternalPackages: ["ffmpeg-static", "ffprobe-static", "sharp"],
};

export default config;
