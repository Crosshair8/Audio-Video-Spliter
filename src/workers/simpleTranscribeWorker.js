import { pipeline } from "@xenova/transformers";

// SIMPLE mode: transcript only, no diarization
const MODEL_ID = "onnx-community/whisper-base_timestamped";
let transcriber = null;

async function load(progress_cb) {
  if (transcriber) return transcriber;

  progress_cb?.(0.05, "Loading SIMPLE transcription model...");
  transcriber = await pipeline("automatic-speech-recognition", MODEL_ID, {
    device: "wasm",
    dtype: "q8",
    progress_callback: (x) => {
      if (x?.status === "progress") {
        progress_cb?.(0.05 + (x.progress ?? 0) * 0.3, x.data ?? "Loading...");
      }
    },
  });

  progress_cb?.(0.35, "Model loaded!");
  return transcriber;
}

self.onmessage = async (e) => {
  const { id, type, data } = e.data;

  const sendProgress = (p, msg) => {
    self.postMessage({ id, status: "progress", progress: p, message: msg });
  };

  try {
    if (type === "run") {
      sendProgress(0.01, "Loading SIMPLE model...");
      const t = await load(sendProgress);

      sendProgress(0.4, "Transcribing...");
      const out = await t(data.audio, {
        return_timestamps: "word",
        chunk_length_s: 30,
      });

      sendProgress(1, "Done");
      self.postMessage({ id, status: "complete", result: { text: out.text, raw: out } });
      return;
    }

    throw new Error("Unknown worker message type");
  } catch (err) {
    self.postMessage({ id, status: "error", error: err?.message || String(err) });
  }
};
