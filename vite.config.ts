import { defineConfig } from "vite";
import { wgslVitePlugin } from "@vgpu/wgsl/loader-vite";

// The map lives at uglyonrobinhood.com/thehoods, proxied to this project, so
// every asset and data path carries the /thehoods/ prefix on both hosts and
// the build lands in dist/thehoods so the Vercel domain serves the same paths.
export default defineConfig({
  base: "/thehoods/",
  build: { outDir: "dist/thehoods", emptyOutDir: true },
  plugins: [wgslVitePlugin()],
});
