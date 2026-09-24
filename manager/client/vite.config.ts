import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5174,
    proxy: {
      "/ws": {
        target: "ws://localhost:4358",
        ws: true,
      },
      "/play": {
        target: "http://localhost:4358",
      },
      "/assets": {
        target: "http://localhost:4358",
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
