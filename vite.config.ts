import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig(async () => ({
  plugins: [
    react(),
    nodePolyfills({
      include: ["crypto", "stream", "buffer", "events", "util", "path", "os"],
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
    }),
  ],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    // Ensure pdf worker is included in the bundle
    rollupOptions: {
      output: {
        manualChunks: {
          pdfjs: ['pdfjs-dist'],
        },
      },
    },
  },
  // Optimize dependencies that might cause issues in production
  optimizeDeps: {
    include: ['epubjs', 'pdfjs-dist'],
  },
  test: {
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/flatpak/**",
      "**/.flatpak-builder/**",
      "**/src-tauri/**",
    ],
  },
}));
