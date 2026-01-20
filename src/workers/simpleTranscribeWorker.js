import { pipeline } from "@huggingface/transformers";

// ✅ SIMPLE MODE (FAST + SAFE)
// ✅ WASM ONLY (so no one ever needs unsafe WebGPU flags)
const MODEL_ID = "Xenova/whisper-tiny.en";

let transcriber = null;

async function load(progress_cb) {
  if (transcriber) return transcriber;

  progress_cb?.(0.05, "SIMPLE: loading model (first time downloads files)...");

  // ✅ FORCE WASM ALWAYS
  const device = "wasm";

  transcriber = await pipeline("automatic-speech-recognition", MODEL_ID, {
    device,
    dtype: "q8",
    progress_callback: (x) => {
      if (x?.status === "progress") {
        progress_cb?.(0.05 + (x.progress ?? 0) * 0.25, x.data ?? "Loading...");
      }
    },
  });

  progress_cb?.(0.35, "SIMPLE: model loaded ✅");
  return transcriber;
}

function normalizeToF32(input) {
  if (!input) return new Float32Array();
  if (input instanceof Float32Array) return input;
  if (input instanceof ArrayBuffer) return new Float32Array(input);
  if (ArrayBuffer.isView(input)) return new Float32Array(input.buffer);
  if (Array.isArray(input)) return Float32Array.from(input);
  return new Float32Array();
}

self.onmessage = async (e) => {
  const { id, type, data } = e.data;

  const sendProgress = (p, msg) => {
    self.postMessage({ id, status: "progress", progress: p, message: msg });
  };

  try {
    if (type !== "run") throw new Error("Unknown worker request");

    sendProgress(0.02, "SIMPLE: preparing...");
    const t = await load(sendProgress);

    const audioF32 = normalizeToF32(data?.audio);

    // ✅ prevent crashes on silent/empty chunks
    if (!audioF32 || audioF32.length < 1000) {
      sendProgress(1, "SIMPLE: skipped (no audio detected)");
      self.postMessage({ id, status: "complete", result: { text: "" } });
      return;
    }

    sendProgress(0.50, "SIMPLE: transcribing...");

    // ✅ PASS Float32Array DIRECTLY
    const out = await t(audioF32, {
      chunk_length_s: 20,
      stride_length_s: 5,
      condition_on_previous_text: false,
      repetition_penalty: 1.05,
    });

    sendProgress(1, "SIMPLE: done ✅");
    self.postMessage({ id, status: "complete", result: { text: out?.text || "" } });
  } catch (err) {
    self.postMessage({ id, status: "error", error: err?.message || String(err) });
  }
};
