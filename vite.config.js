import { defineConfig } from "vite";

export default defineConfig({
  base: "/Audio-Video-Spliter/",
  optimizeDeps: {
    exclude: ["@ffmpeg/ffmpeg", "@ffmpeg/util"],
  },
});
