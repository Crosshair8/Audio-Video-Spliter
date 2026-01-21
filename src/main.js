import JSZip from "jszip";
import { Document, Packer, Paragraph, TextRun } from "docx";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";

// =============================
// AI PRO CONFIG
// =============================
const PROXY_URL = "https://lucjo.lucjosephgabrielsilva.workers.dev";

// ✅ OpenAI links (SHOW NEXT TO KEY INPUT)
const OPENAI_KEY_LINK = "https://platform.openai.com/api-keys";
const OPENAI_BILLING_LINK = "https://platform.openai.com/account/billing/overview";

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

// ✅ pro links container (must exist in index.html)
const proLinksEl = document.getElementById("proLinks");

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

function isVideoFile(file) {
  return !!file && (file.type?.startsWith("video/") || /\.(mp4|mov|mkv|webm)$/i.test(file.name));
}
function isAudioFile(file) {
  return !!file && (file.type?.startsWith("audio/") || /\.(mp3|m4a|wav|aac|ogg|flac)$/i.test(file.name));
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
// Dropdown options
// =============================
const MP3_QUALITY_OPTIONS = [
  { value: "128", label: "Low Quality" },
  { value: "192", label: "Medium Quality" },
  { value: "320", label: "High Quality" },
];

const WAV_QUALITY_OPTIONS = [
  { value: "fast", label: "Low Quality" },
  { value: "best", label: "Medium Quality" },
  { value: "orig", label: "High Quality" },
];

const MP4_SPEED_OPTIONS = [
  { value: "copy", label: "Fast" },
  { value: "reencode_23", label: "Normal" },
  { value: "reencode_18", label: "Slow" },
];

function setQualityDropdown(options, defaultValue, labelText, hintText) {
  const current = qualitySelect.value;

  qualitySelect.innerHTML = "";
  for (const opt of options) {
    const o = document.createElement("option");
    o.value = opt.value;
    o.textContent = opt.label;
    qualitySelect.appendChild(o);
  }

  qualityLabel.textContent = labelText;
  qualityHint.textContent = hintText;

  const validCurrent = options.some((x) => x.value === current);
  qualitySelect.value = validCurrent ? current : defaultValue;
}

// =============================
// ✅ Links ALWAYS show when AI PRO selected
// (no file required)
// =============================
function renderProLinks() {
  if (!proLinksEl) return;

  if (modeSelect.value === "pro") {
    proLinksEl.innerHTML = `
      <a href="${OPENAI_KEY_LINK}" target="_blank" rel="noopener noreferrer">
        🔑 Create / manage API key
      </a>
      <a href="${OPENAI_BILLING_LINK}" target="_blank" rel="noopener noreferrer">
        💳 Add billing (fix quota / 429 errors)
      </a>
    `;
  } else {
    proLinksEl.innerHTML = "";
  }
}

// =============================
// Auto UI mode handling
// =============================
function updateUIForFileAndMode() {
  const file = fileInput.files?.[0];
  const isVid = isVideoFile(file);
  const mode = modeSelect.value;

  // ✅ Video => force OFF and lock
  if (isVid) {
    modeSelect.value = "off";
    modeSelect.disabled = true;
    proBox.style.display = "none";

    setQualityDropdown(
      MP4_SPEED_OPTIONS,
      "copy",
      "MP4 Speed",
      "Fast = quickest. Normal/Slow = re-encode (more compatible, takes longer)."
    );

    renderProLinks();
    return;
  }

  modeSelect.disabled = false;

  // ✅ show pro box only for PRO
  proBox.style.display = mode === "pro" ? "" : "none";

  if (mode === "pro") {
    setQualityDropdown(
      WAV_QUALITY_OPTIONS,
      "best",
      "WAV Quality",
      "Higher WAV quality = larger files (best for AI PRO)."
    );
  } else {
    setQualityDropdown(
      MP3_QUALITY_OPTIONS,
      "192",
      "MP3 Quality",
      "Medium recommended. High = bigger files."
    );
  }

  renderProLinks();
}

modeSelect.addEventListener("change", () => {
  updateUIForFileAndMode();
});

fileInput.addEventListener("change", () => {
  const f = fileInput.files?.[0];
  if (!f) return;

  const isAudio = isAudioFile(f);
  const isVideo = isVideoFile(f);

  detectedType.textContent = isAudio
    ? `Detected: AUDIO ✅ (${f.type || "unknown"})`
    : isVideo
      ? `Detected: VIDEO ✅ (${f.type || "unknown"})`
      : `Unknown (${f.type || "unknown"})`;

  updateUIForFileAndMode();
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
// FFmpeg load
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
let speakersWorker = null;

function getSimpleWorker() {
  if (!simpleWorker) {
    simpleWorker = new Worker(new URL("./workers/simpleTranscribeWorker.js", import.meta.url), {
      type: "module",
    });
  }
  return simpleWorker;
}
function getSpeakersWorker() {
  if (!speakersWorker) {
    speakersWorker = new Worker(new URL("./workers/bestDiarizationWorker.js", import.meta.url), {
      type: "module",
    });
  }
  return speakersWorker;
}

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

async function speakersLoadWasm(worker) {
  setStatus("SIMPLE + SPEAKERS: loading models (WASM, safe)...");
  await workerRequest(worker, "load", { device: "wasm" }, 0.30, 0.36);
  log("SIMPLE + SPEAKERS: using WASM ✅");
}

// =============================
// Extract 16k mono Float32
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

function getWavPreset(preset) {
  switch (preset) {
    case "fast": return { ar: 16000, ac: 1 };
    case "best": return { ar: 48000, ac: 1 };
    case "orig": return { ar: 48000, ac: 2 };
    default: return { ar: 48000, ac: 1 };
  }
}

// =============================
// Split media
// =============================
async function splitMedia(file, splitSec, mode) {
  const ff = await getFFmpeg();
  const base = safeBaseName(file.name);

  const inputName = "input_media";
  try { await ff.deleteFile(inputName); } catch {}
  await ff.writeFile(inputName, await fetchFile(file));

  const isVideo = isVideoFile(file);
  const isAudio = isAudioFile(file);

  const qualityValue = qualitySelect.value;

  let pattern = "chunk_%03d.mp3";
  if (isVideo) pattern = "chunk_%03d.mp4";
  else if (mode === "pro") pattern = "chunk_%03d.wav";

  bumpProgress(0.05);

  if (isVideo) {
    if (qualityValue === "copy") {
      setStatus("Splitting video (FAST)...");
      await ff.exec(["-i", inputName, "-map", "0", "-c", "copy", "-f", "segment", "-segment_time", String(splitSec), "-reset_timestamps", "1", pattern]);
    } else {
      const crf = qualityValue === "reencode_18" ? "18" : "23";
      setStatus(`Splitting video (${qualityValue === "reencode_18" ? "SLOW" : "NORMAL"})...`);
      await ff.exec(["-i", inputName, "-c:v", "libx264", "-preset", "veryfast", "-crf", crf, "-c:a", "aac", "-b:a", "192k", "-f", "segment", "-segment_time", String(splitSec), "-reset_timestamps", "1", pattern]);
    }
  } else if (isAudio && mode === "pro") {
    const preset = getWavPreset(qualityValue || "best");
    setStatus("AI PRO: splitting audio as WAV...");
    await ff.exec(["-i", inputName, "-vn", "-ac", String(preset.ac), "-ar", String(preset.ar), "-c:a", "pcm_s16le", "-f", "segment", "-segment_time", String(splitSec), "-reset_timestamps", "1", pattern]);
  } else if (isAudio) {
    const kbps = Number(qualityValue || 192);
    setStatus("Splitting audio as MP3...");
    await ff.exec(["-i", inputName, "-vn", "-ac", "2", "-ar", "44100", "-c:a", "libmp3lame", "-b:a", `${kbps}k`, "-f", "segment", "-segment_time", String(splitSec), "-reset_timestamps", "1", pattern]);
  } else {
    throw new Error("Unsupported file type.");
  }

  bumpProgress(0.25);
  setStatus("Collecting chunks...");

  const dir = await ff.listDir(".");
  const names = dir.map((x) => x.name).filter((n) => n.startsWith("chunk_") && (n.endsWith(".mp3") || n.endsWith(".mp4") || n.endsWith(".wav"))).sort();
  if (!names.length) throw new Error("No chunks created (FFmpeg failed).");

  const chunks = [];
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const data = await ff.readFile(name);

    let mime = "application/octet-stream";
    if (name.endsWith(".mp3")) mime = "audio/mpeg";
    if (name.endsWith(".wav")) mime = "audio/wav";
    if (name.endsWith(".mp4")) mime = "video/mp4";

    const blob = new Blob([data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)], { type: mime });
    const ext = name.endsWith(".wav") ? ".wav" : (name.endsWith(".mp3") ? ".mp3" : ".mp4");
    const niceName = `${base}_${String(i + 1).padStart(3, "0")}${ext}`;

    chunks.push({ name: niceName, blob });
    try { await ff.deleteFile(name); } catch {}
  }

  try { await ff.deleteFile(inputName); } catch {}
  bumpProgress(0.30);

  return chunks;
}

// =============================
// Transcription methods (same as before)
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

async function transcribeSpeakersChunks(chunks) {
  const worker = getSpeakersWorker();
  await speakersLoadWasm(worker);

  const allLines = [];
  const transcribeStart = 0.36;
  const transcribeEnd = 0.88;
  const perChunk = (transcribeEnd - transcribeStart) / chunks.length;

  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const chunkStart = transcribeStart + i * perChunk;
    const chunkEnd = chunkStart + perChunk;

    setStatus(`SIMPLE + SPEAKERS: diarizing chunk ${i + 1}/${chunks.length}...`);
    bumpProgress(chunkStart);
    await new Promise((r) => setTimeout(r, 0));

    const audio16k = await extract16kFloat32FromBlob(c.blob, `spk_${i}`);
    const res = await workerRequest(worker, "run", { audio: audio16k }, chunkStart, chunkEnd);

    const segments = res?.segments || [];
    const words = res?.transcript?.chunks || [];

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
    const mime = lower.endsWith(".wav") ? "audio/wav" : (c.blob.type || "application/octet-stream");

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

  const splitSec = splitSize.value === "custom" ? Number(customSeconds.value) : Number(splitSize.value);
  if (!Number.isFinite(splitSec) || splitSec <= 0) return alert("Invalid split time.");

  if (isVideoFile(file)) {
    modeSelect.value = "off";
    modeSelect.disabled = true;
  }

  const mode = modeSelect.value;
  const base = safeBaseName(file.name);

  try {
    startBtn.disabled = true;

    setStatus("Starting...");
    bumpProgress(0.01);

    const chunks = await splitMedia(file, splitSec, mode);
    setStatus(`Created ${chunks.length} chunks ✅`);
    bumpProgress(0.30);

    for (const c of chunks) addDownloadLink(c.blob, c.name);

    // Split-only path
    if (isVideoFile(file) || mode === "off") {
      setStatus("✅ Done! (Split only)");
      bumpProgress(0.92);

      setStatus("Building ZIP...");
      bumpProgress(0.95);

      const zip = new JSZip();
      const folder = zip.folder("chunks");
      for (const c of chunks) folder.file(c.name, c.blob);

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
      return;
    }

    // Transcribe
    let transcriptLines = null;

    if (mode === "simple") {
      log("\n--- SIMPLE TRANSCRIPTION ---");
      transcriptLines = await transcribeSimpleChunks(chunks);
    } else if (mode === "best") {
      log("\n--- SIMPLE + SPEAKERS (BETA) ---");
      transcriptLines = await transcribeSpeakersChunks(chunks);
    } else if (mode === "pro") {
      log("\n--- AI PRO (OPENAI) ---");
      const key = apiKeyInput.value.trim();
      transcriptLines = await transcribeProChunks(chunks, key);
    }

    // DOCX
    let transcriptDocx = null;
    if (transcriptLines) {
      setStatus("Building transcript.docx...");
      bumpProgress(0.90);
      transcriptDocx = await docxFromLines(transcriptLines);
      addDownloadLink(transcriptDocx, `${base}_transcript.docx`);
    }

    // ZIP
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

// ✅ INIT (links show immediately when you pick PRO)
updateUIForFileAndMode();
renderProLinks();
