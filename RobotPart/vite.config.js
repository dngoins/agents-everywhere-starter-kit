import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const localApiOrigin = "http://127.0.0.1:8787";
const proxyToLocalApi = (ws = false) => ({
  target: localApiOrigin,
  changeOrigin: true,
  ws,
  // The API is deliberately bound to loopback and only accepts local origins.
  // When Vite is exposed through a dev tunnel, rewrite the forwarded Origin so
  // the tunnel remains a secure frontend transport without opening the API to
  // arbitrary remote origins.
  configure(proxy) {
    const setLocalOrigin = (proxyRequest) => proxyRequest.setHeader("origin", localApiOrigin);
    proxy.on("proxyReq", setLocalOrigin);
    proxy.on("proxyReqWs", setLocalOrigin);
  },
});

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    proxy: Object.fromEntries(["/api", "/newCustomerFace", "/Movies", "/ws"].map((path) => [
      path, proxyToLocalApi(path === "/ws"),
    ])),
  },
});
