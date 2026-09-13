import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

const config: NextConfig = {
  poweredByHeader: false,
  outputFileTracingRoot: repositoryRoot,
  turbopack: { root: repositoryRoot },
  serverExternalPackages: ["ffmpeg-static", "ffprobe-static", "sharp"],
  webpack(config) {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default config;
