import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const server = process.env.AF_SERVER ?? "http://127.0.0.1:7477";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": server,
      "/ws": { target: server.replace(/^http/, "ws"), ws: true },
    },
  },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 4000 },
});
