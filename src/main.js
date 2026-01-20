import JSZip from "jszip";
import { Document, Packer, Paragraph, TextRun } from "docx";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile } from "@ffmpeg/util";

// =============================
// CONFIG (AI PRO)
// =============================
// Put your Cloudflare worker URL here:
const PROXY_URL = "https://YOUR-WORKER.workers.dev/transcribe";

// =============================
// DOM
// =============================
const fileInput = document.getElementById("file");
const detectedType = document.getElementById("detectedType");

const splitSize = document.getElementById("splitSize");
const customLabel = document.getElementById("customLabel");
const customSeconds = document.getElementById("customSeconds");

const modeSelect = document.getElementById("transcribeMode");
const proBox = document.getElementById("proBox");

const apiKeyInput = document.getElementById("apiKey");
const rememberKey = document.getElementById("rememberKey");
const clearKeyBtn = document.getElementById("clearKey");

const startBtn = document.getElementById("start");
const zipBtn = document.getElementById("zipBtn");

const progress = document.getElementById("progress");
const statusEl = document.getElementById("status");
const linksEl = document.getElementById("links");
const logEl = document.getElementById("log");

// =============================
// Helpers UI
// =============================
function log(msg) {
  console.log(msg);
  logEl.textContent += msg + "\n";
  logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(msg) {
  statusEl.textContent = msg;
}

function setProgress(v) {
  progress.value = Math.max(0, Math.min(1, v));
}

function clearOutputs() {
  linksEl.innerHTML = "";
  zipBtn.style.display = "none";
}

function addDownloadLink(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.textContent = `⬇ ${filename}`;
  linksEl.appendChild(a);
  return { url, filename };
}

function secondsToHMS(s) {
  s = Math.max(0, s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

// =============================
// Split size UI
// =============================
splitSize.addEventListener("change", () => {
  if (splitSize.value === "custom") {
    customLabel.style.display = "";
    customSeconds.style.display = "";
  } else {
    customLabel.style.display = "none";
    customSeconds.style.display = "none";
  }
});

// =============================
// Mode UI
// =============================
modeSelect.addEventListener("change", () => {
  proBox.style.display = modeSelect.value === "pro" ? "" : "none";
});

// =============================
// Remember OpenAI Key
// =============================
(function loadSavedKey() {
  try {
    const saved = localStorage.getItem("avs_api_key");
    const remember = localStorage.getItem("avs_remember_key");
    if (remember === "1") {
      rememberKey.checked = true;
      if (saved) apiKeyInput.value = saved;
    } else {
      rememberKey.checked = false;
    }
  } catch {}
})();

rememberKey.addEventListener("change", () => {
  try {
    localStorage.setItem("avs_remember_key", rememberKey.checked ? "1" : "0");
    if (!rememberKey.checked) {
      localStorage.removeItem("avs_api_key");
    }
  } catch {}
});

apiKeyInput.addEventListener("input", () => {
  try {
    if (rememberKey.checked) localStorage.setItem("avs_api_key", apiKeyInput.value.trim());
  } catch {}
});

clearKeyBtn.addEventListener("click", () => {
  apiKeyInput.value = "";
  try {
    localStorage.removeItem("avs_api_key");
  } catch {}
  log("Cleared saved API key.");
});

// =============================
// Detect file type
// =============================
fileInput.addEventListener("change", () => {
  const f = fileInput.files?.[0];
  if (!f) return;
  const isAudio = f.type.startsWith("audio/");
  const isVideo = f.type.startsWith("video/");
  detectedType.textContent = isAudio ? "Detected: AUDIO ✅" : isVideo ? "Detected: VIDEO ✅" : "Unknown file type";
});

// =============================
// FFmpeg (singleton)
// =============================
let ffmpeg;
async function getFFmpeg() {
  if (ffmpeg) return ffmpeg;
  ffmpeg = new FFmpeg();
  log("Loading FFmpeg core...");
  await ffmpeg.load();
  log("FFmpeg loaded!");
  return ffmpeg;
}

// =============================
// Web Workers for transcription
// =============================
let simpleWorker = null;
let bestWorker = null;

function getSimpleWorker() {
  if (!simpleWorker) {
    simpleWorker = new Worker(new URL("./workers/simpleTranscribeWorker.js", import.meta.url), {
      type: "module",
    });
  }
  return simpleWorker;
}

function getBestWorker() {
  if (!bestWorker) {
    bestWorker = new Worker(new URL("./workers/bestDiarizationWorker.js", import.meta.url), {
      type: "module",
    });
  }
  return bestWorker;
}

function workerRequest(worker, type, data) {
  return new Promise((resolve, reject) => {
    const id = Math.random().toString(36).slice(2);

    const onMessage = (e) => {
      if (e.data?.id !== id) return;
      const msg = e.data;

      if (msg.status === "error") {
        cleanup();
        reject(new Error(msg.error || "Worker error"));
        return;
      }

      if (msg.status === "complete") {
        cleanup();
        resolve(msg.result);
        return;
      }

      if (msg.status === "progress") {
        if (msg.message) setStatus(msg.message);
        if (typeof msg.progress === "number") setProgress(msg.progress);
      }
    };

    const cleanup = () => worker.removeEventListener("message", onMessage);

    worker.addEventListener("message", onMessage);
    worker.postMessage({ id, type, data });
  });
}

// =============================
// Convert any media -> Float32Array @ 16k mono
// =============================
async function extract16kFloat32(fileBlob) {
  const ff = await getFFmpeg();
  ff.writeFile("input_media", await fetchFile(fileBlob));

  await ff.exec([
    "-i", "input_media",
    "-vn",
    "-ac", "1",
    "-ar", "16000",
    "-f", "f32le",
    "audio16k.f32"
  ]);

  const data = await ff.readFile("audio16k.f32");
  const float32 = new Float32Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));

  try { ff.deleteFile("input_media"); } catch {}
  try { ff.deleteFile("audio16k.f32"); } catch {}

  return float32;
}

// =============================
// DOCX builder
// =============================
async function buildDocxFromPlainText(text) {
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({
          children: [new TextRun({ text: text || "", font: "Calibri" })]
        })
      ],
    }],
  });

  return await Packer.toBlob(doc);
}

async function buildDocxFromSpeakerSegments(lines) {
  const children = [];
  for (const line of lines) {
    children.push(new Paragraph({
      children: [new TextRun({ text: line, font: "Calibri" })]
    }));
  }

  const doc = new Document({ sections: [{ children }] });
  return await Packer.toBlob(doc);
}

// =============================
// Split media into chunks with FFmpeg
// =============================
async function splitMedia(file, splitSec) {
  const ff = await getFFmpeg();
  const inputName = "input_media";
  ff.writeFile(inputName, await fetchFile(file));

  const isAudio = file.type.startsWith("audio/");
  const isVideo = file.type.startsWith("video/");

  log(`File: ${file.name}`);
  log(`Size: ${(file.size / 1024 / 1024).toFixed(1)} MB`);
  log(`Split every: ${splitSec} sec (${(splitSec / 60).toFixed(2)} min)`);

  const pattern = isAudio ? "chunk_%03d.mp3" : "chunk_%03d.mp4";

  let cmd;
  if (isAudio) {
    log("\n--- AUDIO MODE ---");
    cmd = [
      "-i", inputName,
      "-vn",
      "-c:a", "libmp3lame",
      "-b:a", "192k",
      "-f", "segment",
      "-segment_time", String(splitSec),
      "-reset_timestamps", "1",
      pattern
    ];
  } else if (isVideo) {
    log("\n--- VIDEO MODE ---");
    cmd = [
      "-i", inputName,
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "23",
      "-c:a", "aac",
      "-b:a", "128k",
      "-f", "segment",
      "-segment_time", String(splitSec),
      "-reset_timestamps", "1",
      pattern
    ];
  } else {
    throw new Error("Unsupported file type. Please upload audio or video.");
  }

  await ff.exec(cmd);

  const files = await ff.listDir(".");
  const chunks = files
    .map(x => x.name)
    .filter(name => name.startsWith("chunk_") && (name.endsWith(".mp3") || name.endsWith(".mp4")))
    .sort();

  if (chunks.length === 0) throw new Error("No chunks created. FFmpeg output failed.");

  const out = [];
  for (let i = 0; i < chunks.length; i++) {
    const name = chunks[i];
    const data = await ff.readFile(name);
    const blob = new Blob([data.buffer], { type: name.endsWith(".mp3") ? "audio/mpeg" : "video/mp4" });
    out.push({ name, blob });

    try { ff.deleteFile(name); } catch {}
  }

  try { ff.deleteFile(inputName); } catch {}

  return out;
}

// =============================
// SIMPLE: local transcript only (NO speakers)
// =============================
async function transcribeSimpleLocal(mediaBlob) {
  setStatus("SIMPLE: extracting audio...");
  setProgress(0.03);

  const audio16k = await extract16kFloat32(mediaBlob);

  setStatus("SIMPLE: transcribing...");
  setProgress(0.08);

  const worker = getSimpleWorker();
  const result = await workerRequest(worker, "run", { audio: audio16k });

  return result; // { text, raw }
}

// =============================
// BEST: local diarization in browser (speakers + timestamps)
// =============================
async function transcribeBestDiarization(mediaBlob) {
  setStatus("BEST: extracting audio...");
  setProgress(0.03);

  const audio16k = await extract16kFloat32(mediaBlob);

  const worker = getBestWorker();
  setStatus("BEST: loading models (first time is slow)...");
  setProgress(0.06);
  await workerRequest(worker, "load", { device: "webgpu" });

  setStatus("BEST: transcribing + diarizing...");
  setProgress(0.1);

  const result = await workerRequest(worker, "run", { audio: audio16k, language: "en" });

  return result; // { transcript, segments }
}

// =============================
// PRO: OpenAI (best quality) via proxy
// =============================
async function transcribePro(mediaBlob, apiKey) {
  if (!PROXY_URL || PROXY_URL.includes("YOUR-WORKER")) {
    throw new Error("AI PRO not configured: set PROXY_URL inside src/main.js.");
  }
  if (!apiKey || !apiKey.startsWith("sk-")) {
    throw new Error("Missing OpenAI API key (sk-...).");
  }

  setStatus("AI PRO: uploading...");
  setProgress(0.12);

  const form = new FormData();
  form.append("file", mediaBlob, "media.wav");
  form.append("apiKey", apiKey);

  const res = await fetch(PROXY_URL, { method: "POST", body: form });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error("AI PRO proxy error: " + (t || res.status));
  }

  return await res.json();
}

// =============================
// MAIN BUTTON
// =============================
startBtn.addEventListener("click", async () => {
  clearOutputs();
  logEl.textContent = "";
  setProgress(0);
  setStatus("");

  const file = fileInput.files?.[0];
  if (!file) {
    alert("Pick a file first.");
    return;
  }

  let splitSec = splitSize.value === "custom"
    ? Number(customSeconds.value)
    : Number(splitSize.value);

  if (!Number.isFinite(splitSec) || splitSec <= 0) {
    alert("Invalid split time.");
    return;
  }

  const mode = modeSelect.value;

  try {
    startBtn.disabled = true;
    setStatus("Starting...");
    setProgress(0.02);

    // A) Split into chunks
    setStatus("Splitting into chunks...");
    const chunks = await splitMedia(file, splitSec);

    setStatus(`Created ${chunks.length} chunks. Building downloads...`);
    setProgress(0.35);

    for (const c of chunks) addDownloadLink(c.blob, c.name);

    // B) Optional transcription
    let transcriptDocxBlob = null;
    let transcriptJsonBlob = null;

    if (mode !== "none") {
      log(`\n--- TRANSCRIPTION MODE: ${mode.toUpperCase()} ---`);

      if (mode === "simple") {
        const res = await transcribeSimpleLocal(file);
        transcriptDocxBlob = await buildDocxFromPlainText(res?.text || "");
        transcriptJsonBlob = new Blob([JSON.stringify(res, null, 2)], { type: "application/json" });

        addDownloadLink(transcriptDocxBlob, "transcript_simple.docx");
        addDownloadLink(transcriptJsonBlob, "transcript_simple.json");
      }

      if (mode === "best") {
        const bestRes = await transcribeBestDiarization(file);

        const segments = bestRes?.segments || [];
        const words = bestRes?.transcript?.chunks || [];

        let prev = 0;
        const lines = [];

        for (const seg of segments) {
          if (seg.label === "NO_SPEAKER") continue;

          const segmentWords = [];
          for (let i = prev; i < words.length; i++) {
            const w = words[i];
            if (w.timestamp?.[1] <= seg.end) {
              segmentWords.push(w.text);
            } else {
              prev = i;
              break;
            }
          }

          const joined = segmentWords.join("").trim();
          if (!joined) continue;

          lines.push(`${seg.label} (${secondsToHMS(seg.start)} → ${secondsToHMS(seg.end)}): ${joined}`);
        }

        transcriptDocxBlob = await buildDocxFromSpeakerSegments(lines);
        transcriptJsonBlob = new Blob([JSON.stringify(bestRes, null, 2)], { type: "application/json" });

        addDownloadLink(transcriptDocxBlob, "transcript_best.docx");
        addDownloadLink(transcriptJsonBlob, "transcript_best.json");
      }

      if (mode === "pro") {
        const key = apiKeyInput.value.trim();
        const proRes = await transcribePro(file, key);

        transcriptDocxBlob = await buildDocxFromPlainText(proRes?.text || "");
        transcriptJsonBlob = new Blob([JSON.stringify(proRes, null, 2)], { type: "application/json" });

        addDownloadLink(transcriptDocxBlob, "transcript_pro.docx");
        addDownloadLink(transcriptJsonBlob, "transcript_pro.json");
      }
    }

    // C) ZIP everything
    setStatus("Building ZIP...");
    setProgress(0.7);

    const zip = new JSZip();
    const folder = zip.folder("chunks");
    for (const c of chunks) folder.file(c.name, c.blob);

    if (transcriptDocxBlob) zip.file("transcript.docx", transcriptDocxBlob);
    if (transcriptJsonBlob) zip.file("transcript.json", transcriptJsonBlob);

    const zipBlob = await zip.generateAsync({ type: "blob" }, (meta) => {
      setProgress(0.7 + (meta.percent / 100) * 0.3);
      setStatus(`Building ZIP... ${meta.percent.toFixed(0)}%`);
    });

    const zipLink = addDownloadLink(zipBlob, "output.zip");

    zipBtn.style.display = "";
    zipBtn.onclick = () => {
      const a = document.createElement("a");
      a.href = zipLink.url;
      a.download = "output.zip";
      a.click();
    };

    setProgress(1);
    setStatus("✅ Done!");
    log("\n✅ Done!");
  } catch (err) {
    console.error(err);
    alert(err?.message || String(err));
    setStatus("❌ Error: " + (err?.message || String(err)));
    log("❌ " + (err?.message || String(err)));
  } finally {
    startBtn.disabled = false;
  }
});
