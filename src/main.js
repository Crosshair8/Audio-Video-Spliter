import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";

const fileInput = document.getElementById("file");
const detectedTypeEl = document.getElementById("detectedType");
const splitSizeSelect = document.getElementById("splitSize");
const customSecondsInput = document.getElementById("customSeconds");
const customLabel = document.getElementById("customLabel");

const startBtn = document.getElementById("start");
const progressEl = document.getElementById("progress");
const statusEl = document.getElementById("status");
const logEl = document.getElementById("log");
const linksEl = document.getElementById("links");

const ffmpeg = new FFmpeg();

function log(msg) {
  logEl.textContent += msg + "\n";
  logEl.scrollTop = logEl.scrollHeight;
}

function clearOldLinks() {
  linksEl.innerHTML = "";
}

function makeDownloadLink(filename, data, mimeType) {
  const blob = new Blob([data.buffer], { type: mimeType });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.textContent = `Download ${filename}`;
  linksEl.appendChild(a);
}

function safeBaseName(filename) {
  const base = filename.replace(/\.[^/.]+$/, "");
  return base.replace(/[^a-zA-Z0-9-_]+/g, "_").slice(0, 40) || "file";
}

function isAudioFile(file) {
  return file?.type?.startsWith("audio/");
}
function isVideoFile(file) {
  return file?.type?.startsWith("video/");
}

async function loadFFmpeg() {
  if (ffmpeg.loaded) return;

  statusEl.textContent = "Loading FFmpeg (first time is slower)...";
  log("Loading FFmpeg core...");

  const coreBaseURL = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm";
  const ffmpegBaseURL = "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/esm";

  await ffmpeg.load({
    coreURL: await toBlobURL(`${coreBaseURL}/ffmpeg-core.js`, "text/javascript"),
    wasmURL: await toBlobURL(`${coreBaseURL}/ffmpeg-core.wasm`, "application/wasm"),
    workerURL: await toBlobURL(`${ffmpegBaseURL}/worker.js`, "text/javascript"),
  });

  ffmpeg.on("log", ({ message }) => log(message));
  ffmpeg.on("progress", ({ progress }) => {
    progressEl.value = progress;
    statusEl.textContent = `Working... ${(progress * 100).toFixed(1)}%`;
  });

  statusEl.textContent = "FFmpeg loaded ✅";
  log("FFmpeg loaded!");
}

function getSplitSeconds() {
  const val = splitSizeSelect.value;
  if (val === "custom") return Number(customSecondsInput.value);
  return Number(val);
}

splitSizeSelect.addEventListener("change", () => {
  const isCustom = splitSizeSelect.value === "custom";
  customSecondsInput.style.display = isCustom ? "inline-block" : "none";
  customLabel.style.display = isCustom ? "inline-block" : "none";
});

fileInput.addEventListener("change", () => {
  const f = fileInput.files?.[0];
  if (!f) return;

  if (isVideoFile(f)) detectedTypeEl.textContent = `Detected: VIDEO (${f.type || "unknown"})`;
  else if (isAudioFile(f)) detectedTypeEl.textContent = `Detected: AUDIO (${f.type || "unknown"})`;
  else detectedTypeEl.textContent = `Detected: Unknown (${f.type || "unknown"})`;
});

async function deleteOldOutputs() {
  const files = await ffmpeg.listDir(".");
  for (const f of files) {
    if (
      (f.name.startsWith("clip_") && f.name.endsWith(".mp4")) ||
      (f.name.startsWith("chunk_") && f.name.endsWith(".mp3"))
    ) {
      await ffmpeg.deleteFile(f.name);
    }
  }
}

startBtn.addEventListener("click", async () => {
  try {
    const file = fileInput.files?.[0];
    const seconds = getSplitSeconds();

    if (!file) {
      alert("Pick a video or audio file first.");
      return;
    }
    if (!seconds || seconds < 1) {
      alert("Split time must be 1 second or more.");
      return;
    }

    clearOldLinks();
    progressEl.value = 0;
    logEl.textContent = "";

    await loadFFmpeg();
    await deleteOldOutputs();

    const baseName = safeBaseName(file.name);

    log(`File: ${file.name}`);
    log(`Size: ${(file.size / 1024 / 1024).toFixed(1)} MB`);
    log(`Split every: ${seconds} sec (${(seconds / 60).toFixed(2)} min)`);

    statusEl.textContent = "Loading file...";
    const inputName = isVideoFile(file) ? "input.mp4" : "input_audio";
    await ffmpeg.writeFile(inputName, await fetchFile(file));

    // VIDEO MODE (fast split)
    if (isVideoFile(file)) {
      log("\n--- VIDEO MODE ---");
      statusEl.textContent = "Splitting video...";

      const outputPattern = "clip_%03d.mp4";

      await ffmpeg.exec([
        "-i", inputName,
        "-map", "0",
        "-c", "copy",
        "-f", "segment",
        "-segment_time", String(seconds),
        "-reset_timestamps", "1",
        outputPattern,
      ]);

      statusEl.textContent = "Collecting clips...";
      const files = await ffmpeg.listDir(".");
      const clips = files
        .map((f) => f.name)
        .filter((n) => n.startsWith("clip_") && n.endsWith(".mp4"))
        .sort();

      for (let i = 0; i < clips.length; i++) {
        const data = await ffmpeg.readFile(clips[i]);
        makeDownloadLink(`${baseName}_${String(i + 1).padStart(3, "0")}.mp4`, data, "video/mp4");
      }

      statusEl.textContent = `Done ✅ (${clips.length} clips)`;
      return;
    }

    // AUDIO MODE (re-encode to mp3)
    if (isAudioFile(file)) {
      log("\n--- AUDIO MODE ---");
      statusEl.textContent = "Splitting audio...";

      const outputPattern = "chunk_%03d.mp3";

      await ffmpeg.exec([
        "-i", inputName,
        "-c:a", "libmp3lame",
        "-b:a", "192k",
        "-f", "segment",
        "-segment_time", String(seconds),
        "-reset_timestamps", "1",
        outputPattern,
      ]);

      statusEl.textContent = "Collecting chunks...";
      const files = await ffmpeg.listDir(".");
      const chunks = files
        .map((f) => f.name)
        .filter((n) => n.startsWith("chunk_") && n.endsWith(".mp3"))
        .sort();

      for (let i = 0; i < chunks.length; i++) {
        const data = await ffmpeg.readFile(chunks[i]);
        makeDownloadLink(`${baseName}_${String(i + 1).padStart(3, "0")}.mp3`, data, "audio/mpeg");
      }

      statusEl.textContent = `Done ✅ (${chunks.length} chunks)`;
      return;
    }

    alert("That file isn't audio or video.");
  } catch (err) {
    console.error(err);
    statusEl.textContent = "Error ❌";
    log(`ERROR: ${err?.message || err}`);
    log("\nIf it fails:");
    log("- Try 10 or 20 minute segments.");
    log("- Very large files may crash due to browser memory limits.");
  }
});
