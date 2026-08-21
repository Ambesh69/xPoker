import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    target: "es2022",
    rollupOptions: {
      onwarn(warning, warn) {
        if (["INVALID_ANNOTATION", "MODULE_LEVEL_DIRECTIVE", "SOURCEMAP_ERROR"].includes(warning.code)) return;
        warn(warning);
      },
    },
  },
});
