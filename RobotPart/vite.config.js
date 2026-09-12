import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: Object.fromEntries(["/api", "/newCustomerFace", "/Movies", "/ws"].map((path) => [
      path, { target: "http://127.0.0.1:8787", ws: path === "/ws" },
    ])),
  },
});