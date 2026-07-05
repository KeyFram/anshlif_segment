import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite serves the UI (port 5555); Express (port 3001) serves the project API,
// image/tile bytes and (later) mask processing. Everything under /api is proxied.
export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5555,
    proxy: {
      "/api": "http://localhost:3001",
    },
  },
});
