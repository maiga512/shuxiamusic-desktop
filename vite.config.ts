import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import AutoImport from "unplugin-auto-import/vite";
import Components from "unplugin-vue-components/vite";
import { NaiveUiResolver, TDesignResolver } from "unplugin-vue-components/resolvers";
import { resolve } from "path";

// https://vitejs.dev/config/
export default defineConfig({
  resolve: {
    alias: {
      "@renderer": resolve(__dirname, "src"),
      "@assets": resolve(__dirname, "src/assets"),
      "@components": resolve(__dirname, "src/components"),
      "@services": resolve(__dirname, "src/services"),
      "@store": resolve(__dirname, "src/store"),
      "@common": resolve(__dirname, "src/common"),
      "@types": resolve(__dirname, "src/types"),
      "@ceru/shared-contract": resolve(__dirname, "packages/shared-contract/src"),
      buffer: resolve(__dirname, "src/stubs/buffer-polyfill.ts"),
      "@tauri-apps/plugin-updater": resolve(__dirname, "src/stubs/tauri-plugin-updater.ts"),
    },
  },
  plugins: [
    vue(),
    AutoImport({
      imports: [
        "vue",
        "vue-router",
        "pinia",
        {
          "naive-ui": ["useDialog", "useMessage", "useNotification", "useLoadingBar"],
        },
      ],
      resolvers: [
        TDesignResolver({
          library: "vue-next",
        }),
      ],
      dts: "src/auto-imports.d.ts",
    }),
    Components({
      resolvers: [
        TDesignResolver({
          library: "vue-next",
        }),
        NaiveUiResolver(),
      ],
      dts: "src/components.d.ts",
    }),
  ],
  // prevent vite from obscuring rust errors
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1421,
    strictPort: false,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        desktopLyric: resolve(__dirname, "desktop-lyric.html"),
      },
    },
  },
});
