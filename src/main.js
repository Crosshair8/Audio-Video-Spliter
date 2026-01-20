import JSZip from "jszip";
import { Document, Packer, Paragraph, TextRun } from "docx";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";

// =============================
// AI PRO CONFIG (Cloudflare Worker base URL)
// =============================
const PROXY_URL = "https://lucjo.lucjosephgabrielsilva.workers.dev";
const OPENAI_KEY_BUY_LINK = "https://platform.openai.com/api-keys";

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

// ✅ ONE quality dropdown
const qualityLabel = document.getElementById("qualityLabel");
const qualitySelect = document.getElementById("qualitySelect");
const qualityHint = document.getElementById("qualityHint");

// =============================
// Progress (MONOTONIC)
// =============================
let progressValue = 0;
function resetProgress() {
  progressValue = 0;
  progress.value = 0;
}
function bumpProgress(v) {
  if (!Number.isFinite(v)) return;
  if (v < progressValue) return;
  progressValue = Math.min(1, v);
  progress.value = progressValue;
}

// =============================
// UI helpers
// =============================
function log(msg) {
  logEl.textContent += msg + "\n";
  logEl.scrollTop = logEl.scrollHeight;
}
function setStatus(msg) {
  statusEl.textContent = msg;
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
function addInfoLink(url, label) {
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = label;
  a.style.display = "block";
  a.style.marginTop = "8px";
  linksEl.appendChild(a);
}
function safeBaseName(name) {
  const base = name.replace(/\.[^/.]+$/, "");
  return base.replace(/[^a-zA-Z0-9-_]+/g, "_").slice(0, 60) || "file";
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
// Quality options (ONE dropdown)
// =============================

// MP3 presets for SIMPLE + BEST
const MP3_QUALITY_OPTIONS = [
  { value: "96", label: "Low (96 kbps)" },
  { value: "128", label: "Normal (128 kbps)" },
  { value: "192", label: "High (192 kbps)" },
  { value: "256", label: "Very High (256 kbps)" },
  { value: "320", label: "Best (320 kbps)" },
];

// WAV presets for PRO
const WAV_QUALITY_OPTIONS = [
  { value: "fast", label: "Fast (16kHz mono WAV)" },
  { value: "good", label: "Good (24kHz mono WAV)" },
  { value: "best", label: "Best (48kHz mono WAV)" },
  { value: "orig", label: "Original-ish (48kHz stereo WAV)" },
];

function setQualityDropdown(options, defaultValue, labelText) {
  // Save current selection if it exists and is valid in new options
  const current = qualitySelect.value;

  qualitySelect.innerHTML = "";
  for (const opt of options) {
    const o = document.createElement("option");
    o.value = opt.value;
    o.textContent = opt.label;
    qualitySelect.appendChild(o);
  }

  qualityLabel.textContent = labelText;

  const validCurrent = options.some((x) => x.value === current);
  qualitySelect.value = validCurrent ? current : defaultValue;
}

// ✅ This updates the ONE dropdown based on mode
function autoAdjustQualityUI() {
  const mode = modeSelect.value;

  if (mode === "pro") {
    // WAV dropdown
    setQualityDropdown(
      WAV_QUALITY_OPTIONS,
      "best",
      "WAV Quality (AI PRO)"
    );
  } else {
    // MP3 dropdown (simple + best)
    const def = mode === "best" ? "256" : "192";
    setQualityDropdown(
      MP3_QUALITY_OPTIONS,
      def,
      "MP3 Quality (SIMPLE + BEST)"
    );
  }
}

// =============================
// Mode UI
// =============================
modeSelect.addEventListener("change", () => {
  proBox.style.display = modeSelect.value === "pro" ? "" : "none";
  autoAdjustQualityUI();
});

// =============================
// Remember OpenAI Key
// =============================
(function loadSavedKey() {
  try {
    const saved = localStorage.getItem("avs_api_key") || "";
    const remember = localStorage.getItem("avs_remember_key");
    rememberKey.checked = remember === "1";
    if (rememberKey.checked) apiKeyInput.value = saved;
  } catch {}
})();
rememberKey.addEventListener("change", () => {
  try {
    localStorage.setItem("avs_remember_key", rememberKey.checked ? "1" : "0");
    if (!rememberKey.checked) localStorage.removeItem("avs_api_key");
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

  detectedType.textContent = isAudio
    ? `Detected: AUDIO ✅ (${f.type || "unknown"})`
    : isVideo
      ? `Detected: VIDEO ✅ (${f.type || "unknown"})`
      : `Unknown (${f.type || "unknown"})`;
});

// =============================
// FFmpeg load (GitHub Pages safe)
// =============================
let ffmpeg = null;
async function getFFmpeg() {
  if (ffmpeg) return ffmpeg;

  ffmpeg = new FFmpeg();

  log("Loading FFmpeg core...");
  setStatus("Loading FFmpeg...");
  bumpProgress(0.02);

  const coreBaseURL = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm";
  const ffmpegBaseURL = "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/esm";

  await ffmpeg.load({
    coreURL: await toBlobURL(`${coreBaseURL}/ffmpeg-core.js`, "text/javascript"),
    wasmURL: await toBlobURL(`${coreBaseURL}/ffmpeg-core.wasm`, "application/wasm"),
    workerURL: await toBlobURL(`${ffmpegBaseURL}/worker.js`, "text/javascript"),
  });

  log("FFmpeg loaded ✅");
  return ffmpeg;
}

// =============================
// Workers
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

// Worker request with progress mapped into a RANGE
function workerRequest(worker, type, data, rangeStart = 0, rangeEnd = 1) {
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
        bumpProgress(rangeEnd);
        resolve(msg.result);
        return;
      }

      if (msg.status === "progress") {
        if (msg.message) setStatus(msg.message);

        if (typeof msg.progress === "number") {
          const p = Math.max(0, Math.min(1, msg.progress));
          const mapped = rangeStart + p * (rangeEnd - rangeStart);
          bumpProgress(mapped);
        }
      }
    };

    const cleanup = () => worker.removeEventListener("message", onMessage);

    worker.addEventListener("message", onMessage);
    worker.postMessage({ id, type, data });
  });
}

// ✅ BEST MODE: ALWAYS USE WASM
async function bestLoadWasm(worker) {
  setStatus("BEST: loading models (WASM, safe)...");
  await workerRequest(worker, "load", { device: "wasm" }, 0.30, 0.36);
  log("BEST: using WASM ✅");
}

// =============================
// Extract 16k mono Float32 from a blob
// =============================
async function extract16kFloat32FromBlob(blob, hintName = "input") {
  const ff = await getFFmpeg();

  const inputName = `in_${hintName}`;
  const outName = `out_${hintName}.f32`;

  try { await ff.deleteFile(inputName); } catch {}
  try { await ff.deleteFile(outName); } catch {}

  await ff.writeFile(inputName, await fetchFile(blob));

  await ff.exec([
    "-i", inputName,
    "-vn",
    "-ac", "1",
    "-ar", "16000",
    "-f", "f32le",
    outName
  ]);

  const data = await ff.readFile(outName);
  const float32 = new Float32Array(
    data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
  );

  try { await ff.deleteFile(inputName); } catch {}
  try { await ff.deleteFile(outName); } catch {}

  return float32;
}

// =============================
// DOCX helper
// =============================
async function docxFromLines(lines) {
  const children = lines.map(
    (t) => new Paragraph({ children: [new TextRun({ text: t, font: "Calibri" })] })
  );
  const doc = new Document({ sections: [{ children }] });
  return await Packer.toBlob(doc);
}

// =============================
// WAV preset decode
// =============================
function getWavPreset(preset) {
  switch (preset) {
    case "fast": return { ar: 16000, ac: 1 };
    case "good": return { ar: 24000, ac: 1 };
    case "best": return { ar: 48000, ac: 1 };
    case "orig": return { ar: 48000, ac: 2 };
    default: return { ar: 48000, ac: 1 };
  }
}

// =============================
// Split media into chunks
// SIMPLE/BEST audio => MP3 kbps from ONE dropdown
// PRO => WAV from ONE dropdown
// =============================
async function splitMedia(file, splitSec, forceProWav = false) {
  const ff = await getFFmpeg();

  const base = safeBaseName(file.name);
  const isAudio = file.type.startsWith("audio/");
  const isVideo = file.type.startsWith("video/");
  const inputName = "input_media";

  try { await ff.deleteFile(inputName); } catch {}
  await ff.writeFile(inputName, await fetchFile(file));

  const outputWav = forceProWav === true;

  const pattern = outputWav
    ? "chunk_%03d.wav"
    : (isAudio ? "chunk_%03d.mp3" : "chunk_%03d.mp4");

  log(`File: ${file.name}`);
  log(`Split every: ${splitSec}s (${(splitSec / 60).toFixed(1)} min)`);

  bumpProgress(0.05);

  if (outputWav) {
    const preset = getWavPreset(qualitySelect.value || "best");
    setStatus("Splitting PRO audio as WAV (quality selectable)...");
    await ff.exec([
      "-i", inputName,
      "-vn",
      "-ac", String(preset.ac),
      "-ar", String(preset.ar),
      "-c:a", "pcm_s16le",
      "-f", "segment",
      "-segment_time", String(splitSec),
      "-reset_timestamps", "1",
      pattern
    ]);
  } else if (isAudio) {
    const kbps = Number(qualitySelect.value || 192);
    setStatus("Splitting audio (MP3 quality selectable)...");
    await ff.exec([
      "-i", inputName,
      "-vn",
      "-ac", "2",
      "-ar", "44100",
      "-c:a", "libmp3lame",
      "-b:a", `${kbps}k`,
      "-f", "segment",
      "-segment_time", String(splitSec),
      "-reset_timestamps", "1",
      pattern
    ]);
  } else if (isVideo) {
    setStatus("Splitting video (fast copy)...");
    try {
      await ff.exec([
        "-i", inputName,
        "-map", "0",
        "-c", "copy",
        "-f", "segment",
        "-segment_time", String(splitSec),
        "-reset_timestamps", "1",
        pattern
      ]);
    } catch {
      log("Copy split failed -> fallback re-encode...");
      setStatus("Splitting video (fallback re-encode)...");
      await ff.exec([
        "-i", inputName,
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "23",
        "-c:a", "aac",
        "-b:a", "192k",
        "-f", "segment",
        "-segment_time", String(splitSec),
        "-reset_timestamps", "1",
        pattern
      ]);
    }
  } else {
    throw new Error("Unsupported file type. Upload audio or video.");
  }

  bumpProgress(0.25);
  setStatus("Collecting chunks...");

  const dir = await ff.listDir(".");
  const names = dir
    .map((x) => x.name)
    .filter((n) =>
      n.startsWith("chunk_") &&
      (n.endsWith(".mp3") || n.endsWith(".mp4") || n.endsWith(".wav"))
    )
    .sort();

  if (!names.length) throw new Error("No chunks created (FFmpeg failed).");

  const chunks = [];
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const data = await ff.readFile(name);

    let mime = "application/octet-stream";
    if (name.endsWith(".mp3")) mime = "audio/mpeg";
    if (name.endsWith(".wav")) mime = "audio/wav";
    if (name.endsWith(".mp4")) mime = "video/mp4";

    const blob = new Blob(
      [data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)],
      { type: mime }
    );

    const ext = name.endsWith(".wav")
      ? ".wav"
      : (name.endsWith(".mp3") ? ".mp3" : ".mp4");

    const niceName = `${base}_${String(i + 1).padStart(3, "0")}${ext}`;
    chunks.push({ name: niceName, blob });

    try { await ff.deleteFile(name); } catch {}
  }

  try { await ff.deleteFile(inputName); } catch {}

  bumpProgress(0.30);
  return chunks;
}

// =============================
// SIMPLE transcription
// =============================
async function transcribeSimpleChunks(chunks) {
  const worker = getSimpleWorker();
  const allLines = [];

  const transcribeStart = 0.30;
  const transcribeEnd = 0.88;
  const perChunk = (transcribeEnd - transcribeStart) / chunks.length;

  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const chunkStart = transcribeStart + i * perChunk;
    const chunkEnd = chunkStart + perChunk;

    setStatus(`SIMPLE: transcribing chunk ${i + 1}/${chunks.length}...`);
    bumpProgress(chunkStart);
    await new Promise((r) => setTimeout(r, 0));

    const audio16k = await extract16kFloat32FromBlob(c.blob, `simple_${i}`);
    const res = await workerRequest(worker, "run", { audio: audio16k }, chunkStart, chunkEnd);

    allLines.push(`Part ${String(i + 1).padStart(3, "0")}: ${c.name}`);
    allLines.push((res?.text || "").trim() || "(no text)");
    allLines.push("");
  }

  bumpProgress(transcribeEnd);
  return allLines;
}

// =============================
// BEST transcription
// =============================
async function transcribeBestChunks(chunks) {
  const worker = getBestWorker();
  await bestLoadWasm(worker);

  const allLines = [];

  const transcribeStart = 0.36;
  const transcribeEnd = 0.88;
  const perChunk = (transcribeEnd - transcribeStart) / chunks.length;

  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const chunkStart = transcribeStart + i * perChunk;
    const chunkEnd = chunkStart + perChunk;

    setStatus(`BEST: diarizing chunk ${i + 1}/${chunks.length}...`);
    bumpProgress(chunkStart);
    await new Promise((r) => setTimeout(r, 0));

    const audio16k = await extract16kFloat32FromBlob(c.blob, `best_${i}`);
    const bestRes = await workerRequest(worker, "run", { audio: audio16k }, chunkStart, chunkEnd);

    const segments = bestRes?.segments || [];
    const words = bestRes?.transcript?.chunks || [];

    allLines.push(`Part ${String(i + 1).padStart(3, "0")}: ${c.name}`);
    allLines.push("");

    let prev = 0;
    for (const seg of segments) {
      if (!seg || seg.label === "NO_SPEAKER") continue;

      const segmentWords = [];
      for (let w = prev; w < words.length; w++) {
        const word = words[w];
        if (!word?.timestamp) continue;

        const end = word.timestamp[1];
        if (end <= seg.end) segmentWords.push(word.text);
        else { prev = w; break; }
      }

      const joined = segmentWords.join("").trim();
      if (!joined) continue;

      allLines.push(`${seg.label} (${secondsToHMS(seg.start)} → ${secondsToHMS(seg.end)}): ${joined}`);
    }

    allLines.push("");
  }

  bumpProgress(transcribeEnd);
  return allLines;
}

// =============================
// AI PRO transcription
// =============================
async function transcribeProChunks(chunks, apiKey) {
  if (!PROXY_URL || PROXY_URL.includes("YOUR-WORKER")) {
    throw new Error("AI PRO not configured: set PROXY_URL in src/main.js.");
  }
  if (!apiKey || !apiKey.startsWith("sk-")) {
    throw new Error("Missing OpenAI API key (sk-...).");
  }

  const allLines = [];

  const transcribeStart = 0.30;
  const transcribeEnd = 0.88;
  const perChunk = (transcribeEnd - transcribeStart) / chunks.length;

  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const chunkStart = transcribeStart + i * perChunk;
    const chunkEnd = chunkStart + perChunk;

    setStatus(`AI PRO: transcribing chunk ${i + 1}/${chunks.length}...`);
    bumpProgress(chunkStart);
    await new Promise((r) => setTimeout(r, 0));

    const form = new FormData();

    const lower = c.name.toLowerCase();
    const mime =
      lower.endsWith(".wav") ? "audio/wav" :
      lower.endsWith(".mp3") ? "audio/mpeg" :
      (c.blob.type || "application/octet-stream");

    const fileToSend = new File([c.blob], c.name, { type: mime });
    form.append("file", fileToSend, c.name);

    const res = await fetch(`${PROXY_URL}/transcribe`, {
      method: "POST",
      headers: { "X-OpenAI-Key": apiKey },
      body: form,
    });

    const text = await res.text();
    if (!res.ok) throw new Error(`AI PRO failed (${res.status}): ${text}`);

    let json = null;
    try { json = JSON.parse(text); } catch { json = { text }; }

    allLines.push(`Part ${String(i + 1).padStart(3, "0")}: ${c.name}`);
    allLines.push("");

    const segs = json?.segments || json?.diarization?.segments || json?.results?.segments || [];
    if (Array.isArray(segs) && segs.length) {
      for (const s of segs) {
        const who = s.speaker || s.label || "Speaker ?";
        const t = (s.text || s.transcript || "").trim();
        if (t) allLines.push(`${who}: ${t}`);
      }
    } else {
      allLines.push((json?.text || "").trim());
    }

    allLines.push("");
    bumpProgress(chunkEnd);
  }

  bumpProgress(transcribeEnd);
  return allLines;
}

// =============================
// MAIN
// =============================
startBtn.addEventListener("click", async () => {
  clearOutputs();
  logEl.textContent = "";
  resetProgress();
  setStatus("");

  const file = fileInput.files?.[0];
  if (!file) return alert("Pick a file first.");

  const splitSec =
    splitSize.value === "custom" ? Number(customSeconds.value) : Number(splitSize.value);

  if (!Number.isFinite(splitSec) || splitSec <= 0) return alert("Invalid split time.");

  const mode = modeSelect.value;
  const base = safeBaseName(file.name);

  try {
    startBtn.disabled = true;

    setStatus("Starting...");
    bumpProgress(0.01);

    const chunks = await splitMedia(file, splitSec, mode === "pro");
    setStatus(`Created ${chunks.length} chunks ✅`);
    bumpProgress(0.30);

    for (const c of chunks) addDownloadLink(c.blob, c.name);

    if (mode === "pro") {
      addInfoLink(OPENAI_KEY_BUY_LINK, "🔑 Get / manage OpenAI API key");
    }

    let transcriptLines = null;

    if (mode === "simple") {
      log("\n--- SIMPLE TRANSCRIPTION ---");
      transcriptLines = await transcribeSimpleChunks(chunks);
    } else if (mode === "best") {
      log("\n--- BEST WEBSITE (DIARIZATION) ---");
      transcriptLines = await transcribeBestChunks(chunks);
    } else if (mode === "pro") {
      log("\n--- AI PRO (GPT) ---");
      const key = apiKeyInput.value.trim();
      transcriptLines = await transcribeProChunks(chunks, key);
    }

    let transcriptDocx = null;
    if (transcriptLines) {
      setStatus("Building transcript.docx...");
      bumpProgress(0.90);
      transcriptDocx = await docxFromLines(transcriptLines);
      addDownloadLink(transcriptDocx, `${base}_transcript.docx`);
    }

    setStatus("Building ZIP...");
    bumpProgress(0.95);

    const zip = new JSZip();
    const folder = zip.folder("chunks");

    for (const c of chunks) folder.file(c.name, c.blob);
    if (transcriptDocx) zip.file("transcript.docx", transcriptDocx);

    const zipBlob = await zip.generateAsync({ type: "blob" });

    const zipLink = addDownloadLink(zipBlob, `${base}_output.zip`);
    zipBtn.style.display = "";
    zipBtn.onclick = () => {
      const a = document.createElement("a");
      a.href = zipLink.url;
      a.download = `${base}_output.zip`;
      a.click();
    };

    bumpProgress(1);
    setStatus("✅ Done!");
    log("\n✅ Done!");
  } catch (err) {
    console.error(err);
    setStatus("❌ " + (err?.message || String(err)));
    log("❌ " + (err?.message || String(err)));
    alert(err?.message || String(err));
  } finally {
    startBtn.disabled = false;
  }
});

// ✅ Init once
autoAdjustQualityUI();
