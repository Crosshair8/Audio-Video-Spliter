import {
  pipeline,
  AutoProcessor,
  AutoModelForAudioFrameClassification,
} from "@huggingface/transformers";

// ✅ BEST WEBSITE = diarization + timestamps
// ✅ WASM ONLY (no WebGPU requirement)
class PipelineSingleton {
  static asr_model_id = "Xenova/whisper-tiny.en";
  static segmentation_model_id = "onnx-community/pyannote-segmentation-3.0";

  static asr_instance = null;
  static segmentation_instance = null;
  static segmentation_processor = null;

  static async getInstance(progress_callback = null) {
    // ASR (WASM)
    this.asr_instance ??= pipeline("automatic-speech-recognition", this.asr_model_id, {
      device: "wasm",
      dtype: "q8",
      progress_callback,
    });

    // Diarization (WASM)
    this.segmentation_processor ??= AutoProcessor.from_pretrained(this.segmentation_model_id, {
      progress_callback,
    });

    this.segmentation_instance ??= AutoModelForAudioFrameClassification.from_pretrained(
      this.segmentation_model_id,
      {
        device: "wasm",
        dtype: "fp32",
        progress_callback,
      }
    );

    return Promise.all([
      this.asr_instance,
      this.segmentation_processor,
      this.segmentation_instance,
    ]);
  }
}

function normalizeToF32(input) {
  if (!input) return new Float32Array();
  if (input instanceof Float32Array) return input;
  if (input instanceof ArrayBuffer) return new Float32Array(input);
  if (ArrayBuffer.isView(input)) return new Float32Array(input.buffer);
  if (Array.isArray(input)) return Float32Array.from(input);
  return new Float32Array();
}

async function segment(processor, model, audioF32) {
  const inputs = await processor(audioF32);
  const { logits } = await model(inputs);

  const segments = processor.post_process_speaker_diarization(logits, audioF32.length)[0];

  for (const seg of segments) {
    seg.label = model.config.id2label[seg.id];
  }
  return segments;
}

self.onmessage = async (e) => {
  const { id, type, data } = e.data;

  const sendProgress = (p, msg) => {
    self.postMessage({ id, status: "progress", progress: p, message: msg });
  };

  try {
    if (type === "load") {
      sendProgress(0.02, "BEST: loading models (WASM safe mode)...");
      await PipelineSingleton.getInstance((x) => {
        if (x?.status === "progress") {
          sendProgress(0.02 + (x.progress ?? 0) * 0.25, x.data ?? "Loading...");
        }
      });

      self.postMessage({ id, status: "complete", result: { ok: true, device: "wasm" } });
      return;
    }

    if (type === "run") {
      const audioF32 = normalizeToF32(data?.audio);

      // ✅ prevent crashes on silent/empty chunks
      if (!audioF32 || audioF32.length < 1000) {
        sendProgress(1, "BEST: skipped (no audio detected)");
        self.postMessage({
          id,
          status: "complete",
          result: { transcript: { text: "", chunks: [] }, segments: [] },
        });
        return;
      }

      sendProgress(0.05, "BEST: transcribing + diarizing (WASM)...");

      const [transcriber, segmentation_processor, segmentation_model] =
        await PipelineSingleton.getInstance();

      // ✅ PASS Float32Array DIRECTLY (fixes subarray error)
      const [transcript, segments] = await Promise.all([
        transcriber(audioF32, {
          return_timestamps: "word",
          chunk_length_s: 20,
          stride_length_s: 5,
          condition_on_previous_text: false,
          repetition_penalty: 1.05,
        }),
        segment(segmentation_processor, segmentation_model, audioF32),
      ]);

      self.postMessage({ id, status: "complete", result: { transcript, segments } });
      return;
    }

    throw new Error("Unknown worker type");
  } catch (err) {
    self.postMessage({ id, status: "error", error: err?.message || String(err) });
  }
};
