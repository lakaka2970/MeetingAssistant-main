// electron.vite.config.ts
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { existsSync, readdirSync, rmdirSync, unlinkSync } from "fs";
import { join, resolve } from "path";
var __electron_vite_injected_dirname = "E:\\Work\\MeetingAssistant-main";
function removeDirDeep(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) removeDirDeep(full);
    else unlinkSync(full);
  }
  rmdirSync(dir);
}
var cleanRendererOut = {
  name: "mc:clean-renderer-out",
  apply: "build",
  buildStart() {
    removeDirDeep(resolve(__electron_vite_injected_dirname, "out/renderer"));
  }
};
var electron_vite_config_default = defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { "@shared": resolve(__electron_vite_injected_dirname, "shared") } },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__electron_vite_injected_dirname, "electron/main.ts"),
          asrWorker: resolve(__electron_vite_injected_dirname, "electron/asr/worker.ts"),
          embedWorker: resolve(__electron_vite_injected_dirname, "electron/rag/embedWorker.ts")
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // `setup` is the minimal bridge for the onboarding window; the main
        // overlay keeps the full McApi in `index`.
        //
        // Preloads run sandboxed (Electron's default with contextIsolation),
        // where `require` is a polyfill that cannot resolve sibling files. Any
        // module imported by BOTH entries would be split into
        // out/preload/chunks/*.js and neither preload would load at all
        // (window.mc silently undefined). electron/setupPreload.ts therefore
        // shares no runtime module with electron/preload.ts — see the comment
        // on its channel table.
        input: {
          index: resolve(__electron_vite_injected_dirname, "electron/preload.ts"),
          setup: resolve(__electron_vite_injected_dirname, "electron/setupPreload.ts"),
          // the exam window's bridge shares no runtime module with the others
          exam: resolve(__electron_vite_injected_dirname, "electron/examPreload.ts")
        }
      }
    }
  },
  renderer: {
    root: "src",
    publicDir: resolve(__electron_vite_injected_dirname, "src/public"),
    plugins: [react(), cleanRendererOut],
    resolve: { alias: { "@shared": resolve(__electron_vite_injected_dirname, "shared") } },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__electron_vite_injected_dirname, "src/index.html"),
          setup: resolve(__electron_vite_injected_dirname, "src/setup.html"),
          exam: resolve(__electron_vite_injected_dirname, "src/exam.html")
        }
      }
    }
  }
});
export {
  electron_vite_config_default as default
};
