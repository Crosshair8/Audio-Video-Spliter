import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";
import JSZip from "jszip";

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
const zipBtn = document.getElementById("zipBtn");

const ffmpeg = new FFmpeg();

// This will store chunk files so we can ZIP them
let zipFiles = []; // { name: string, data: Uint8Array, mime: string }

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

  // Works without special cross-origin isolation headers
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
  if (!f) {
    detectedTypeEl.textContent = "";
    return;
  }

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

// ZIP BUTTON BEHAVIOR
zipBtn?.addEventListener("click", async () => {
  try {
    if (!zipFiles.length) {
      alert("No files to zip yet. Split something first.");
      return;
    }

    zipBtn.disabled = true;
    zipBtn.textContent = "Creating ZIP...";

    const zip = new JSZip();

    for (const f of zipFiles) {
      // f.data is Uint8Array from ffmpeg.readFile()
      zip.file(f.name, f.data);
    }

    const zipBlob = await zip.generateAsync({ type: "blob" });

    const url = URL.createObjectURL(zipBlob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "split_files.zip";
    a.click();

    URL.revokeObjectURL(url);

    zipBtn.textContent = "Download all as ZIP";
    zipBtn.disabled = false;
  } catch (err) {
    console.error(err);
    alert("ZIP failed: " + (err?.message || err));
    zipBtn.textContent = "Download all as ZIP";
    zipBtn.disabled = false;
  }
});

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
    if (!isAudioFile(file) && !isVideoFile(file)) {
      alert("That file doesn't look like audio or video. Try another file.");
      return;
    }

    // Reset UI + ZIP state
    clearOldLinks();
    progressEl.value = 0;
    logEl.textContent = "";
    zipFiles = [];
    if (zipBtn) zipBtn.style.display = "none";

    await loadFFmpeg();
    await deleteOldOutputs();

    const baseName = safeBaseName(file.name);

    log(`File: ${file.name}`);
    log(`Size: ${(file.size / 1024 / 1024).toFixed(1)} MB`);
    log(`Split every: ${seconds} sec (${(seconds / 60).toFixed(2)} min)`);

    statusEl.textContent = "Loading file...";
    const inputName = isVideoFile(file) ? "input.mp4" : "input_audio";
    await ffmpeg.writeFile(inputName, await fetchFile(file));

    // ===========================
    // VIDEO MODE (fast split)
    // ===========================
    if (isVideoFile(file)) {
      log("\n--- VIDEO MODE ---");
      log("Fast split enabled (-c copy).");
      statusEl.textContent = "Splitting video...";

      const outputPattern = "clip_%03d.mp4";

      await ffmpeg.exec([
        "-i",
        inputName,
        "-map",
        "0",
        "-c",
        "copy",
        "-f",
        "segment",
        "-segment_time",
        String(seconds),
        "-reset_timestamps",
        "1",
        outputPattern,
      ]);

      statusEl.textContent = "Collecting video clips...";
      const files = await ffmpeg.listDir(".");
      const clips = files
        .map((f) => f.name)
        .filter((n) => n.startsWith("clip_") && n.endsWith(".mp4"))
        .sort();

      if (!clips.length) {
        statusEl.textContent = "Done, but no clips were created";
        log("No clips created. Try another file or segment size.");
        return;
      }

      for (let i = 0; i < clips.length; i++) {
        const data = await ffmpeg.readFile(clips[i]);
        const niceName = `${baseName}_${String(i + 1).padStart(3, "0")}.mp4`;

        makeDownloadLink(niceName, data, "video/mp4");
        zipFiles.push({ name: niceName, data, mime: "video/mp4" });
      }

      statusEl.textContent = `Done ✅ (${clips.length} clips)`;

      // show ZIP button
      if (zipBtn) zipBtn.style.display = "inline-block";
      return;
    }

    // ===========================
    // AUDIO MODE (re-encode to mp3)
    // ===========================
    if (isAudioFile(file)) {
      log("\n--- AUDIO MODE ---");
      log("Exports to MP3 for compatibility.");
      statusEl.textContent = "Splitting audio...";

      const outputPattern = "chunk_%03d.mp3";

      await ffmpeg.exec([
        "-i",
        inputName,
        "-c:a",
        "libmp3lame",
        "-b:a",
        "192k",
        "-f",
        "segment",
        "-segment_time",
        String(seconds),
        "-reset_timestamps",
        "1",
        outputPattern,
      ]);

      statusEl.textContent = "Collecting audio chunks...";
      const files = await ffmpeg.listDir(".");
      const chunks = files
        .map((f) => f.name)
        .filter((n) => n.startsWith("chunk_") && n.endsWith(".mp3"))
        .sort();

      if (!chunks.length) {
        statusEl.textContent = "Done, but no chunks were created";
        log("No chunks created. Try another file or segment size.");
        return;
      }

      for (let i = 0; i < chunks.length; i++) {
        const data = await ffmpeg.readFile(chunks[i]);
        const niceName = `${baseName}_${String(i + 1).padStart(3, "0")}.mp3`;

        makeDownloadLink(niceName, data, "audio/mpeg");
        zipFiles.push({ name: niceName, data, mime: "audio/mpeg" });
      }

      statusEl.textContent = `Done ✅ (${chunks.length} chunks)`;

      // show ZIP button
      if (zipBtn) zipBtn.style.display = "inline-block";
      return;
    }
  } catch (err) {
    console.error(err);
    statusEl.textContent = "Error ❌";
    log(`ERROR: ${err?.message || err}`);
    log("\nIf it fails:");
    log("- Try 10 or 20 minute segments.");
    log("- Huge files may crash due to browser memory limits.");
  }
});
