import {
  pipeline,
  AutoProcessor,
  AutoModelForAudioFrameClassification,
} from "@xenova/transformers";

// BEST mode: whisper + pyannote segmentation (in-browser)
const PER_DEVICE_CONFIG = {
  webgpu: {
    dtype: { encoder_model: "fp32", decoder_model_merged: "q4" },
    device: "webgpu",
  },
  wasm: {
    dtype: "q8",
    device: "wasm",
  },
};

class PipelineSingleton {
  static asr_model_id = "onnx-community/whisper-base_timestamped";
  static segmentation_model_id = "onnx-community/pyannote-segmentation-3.0";
  static asr_instance = null;
  static segmentation_instance = null;
  static segmentation_processor = null;

  static async getInstance(progress_callback = null, device = "webgpu") {
    this.asr_instance ??= pipeline("automatic-speech-recognition", this.asr_model_id, {
      ...PER_DEVICE_CONFIG[device],
      progress_callback,
    });

    this.segmentation_processor ??= AutoProcessor.from_pretrained(this.segmentation_model_id, {
      progress_callback,
    });

    // segmentation runs on wasm
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

async function segment(processor, model, audio) {
  const inputs = await processor(audio);
  const { logits } = await model(inputs);

  const segments = processor.post_process_speaker_diarization(logits, audio.length)[0];

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
      const device = data?.device || "webgpu";

      sendProgress(0.02, `Loading BEST models (${device})...`);
      const [transcriber] = await PipelineSingleton.getInstance((x) => {
        if (x?.status === "progress") {
          sendProgress(0.02 + (x.progress ?? 0) * 0.25, x.data ?? "Loading...");
        }
      }, device);

      if (device === "webgpu") {
        sendProgress(0.35, "Warming up WebGPU model...");
        await transcriber(new Float32Array(16000), { language: "en" });
      }

      self.postMessage({ id, status: "complete", result: { ok: true } });
      return;
    }

    if (type === "run") {
      const audio = data.audio;
      const language = data.language || "en";

      sendProgress(0.05, "Running Whisper + diarization...");

      const [transcriber, segmentation_processor, segmentation_model] =
        await PipelineSingleton.getInstance();

      const [transcript, segments] = await Promise.all([
        transcriber(audio, {
          language,
          return_timestamps: "word",
          chunk_length_s: 30,
        }),
        segment(segmentation_processor, segmentation_model, audio),
      ]);

      self.postMessage({
        id,
        status: "complete",
        result: { transcript, segments },
      });
      return;
    }

    throw new Error("Unknown worker type");
  } catch (err) {
    self.postMessage({ id, status: "error", error: err?.message || String(err) });
  }
};
