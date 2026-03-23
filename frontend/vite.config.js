import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Same-origin /api → backend (no CORS, no hardcoded host in the client).
    proxy: {
      "/api": {
        target: "http://localhost:5106",
        changeOrigin: true
      }
    }
  }
});

