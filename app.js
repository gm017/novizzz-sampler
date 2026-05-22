const sampleInput = document.getElementById("sampleInput");
const touchPad = document.getElementById("touchPad");
const audioStatus = document.getElementById("audioStatus");
const bankSummary = document.getElementById("bankSummary");
const sampleList = document.getElementById("sampleList");
const voiceReadout = document.getElementById("voiceReadout");
const toggleUiButton = document.getElementById("toggleUiButton");

const controls = {
  sliceMin: document.getElementById("sliceMin"),
  sliceMax: document.getElementById("sliceMax"),
  edoSteps: document.getElementById("edoSteps"),
  gridRows: document.getElementById("gridRows"),
  gridCols: document.getElementById("gridCols"),
  pitchSpread: document.getElementById("pitchSpread"),
};

const outputs = {
  sliceMin: document.getElementById("sliceMinValue"),
  sliceMax: document.getElementById("sliceMaxValue"),
  edoSteps: document.getElementById("edoStepsValue"),
  gridRows: document.getElementById("gridRowsValue"),
  gridCols: document.getElementById("gridColsValue"),
  pitchSpread: document.getElementById("pitchSpreadValue"),
};

const state = {
  audioContext: null,
  masterGain: null,
  samples: [],
  activeVoices: new Map(),
};

const canvas = touchPad;
const ctx = canvas.getContext("2d");

function setAudioStatus(message) {
  if (audioStatus) {
    audioStatus.textContent = message;
  }
}

function updateOutputLabels() {
  outputs.sliceMin.value = `${Number(controls.sliceMin.value).toFixed(2)}s`;
  outputs.sliceMax.value = `${Number(controls.sliceMax.value).toFixed(2)}s`;
  outputs.edoSteps.value = controls.edoSteps.value;
  outputs.gridRows.value = controls.gridRows.value;
  outputs.gridCols.value = controls.gridCols.value;
  outputs.pitchSpread.value = `${Number(controls.pitchSpread.value).toFixed(2)}x`;
}

function resizeCanvas() {
  const ratio = window.devicePixelRatio || 1;
  const bounds = canvas.getBoundingClientRect();
  canvas.width = Math.round(bounds.width * ratio);
  canvas.height = Math.round(bounds.height * ratio);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  drawPad();
}

function getGridConfig() {
  return {
    rows: Number(controls.gridRows.value),
    cols: Number(controls.gridCols.value),
    edoSteps: Number(controls.edoSteps.value),
    pitchSpread: Number(controls.pitchSpread.value),
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function getPointerPosition(event) {
  const bounds = canvas.getBoundingClientRect();
  return {
    x: clamp(event.clientX - bounds.left, 0, bounds.width),
    y: clamp(event.clientY - bounds.top, 0, bounds.height),
    width: bounds.width,
    height: bounds.height,
  };
}

function getSnakePosition({ x, y, width, height }) {
  const { rows, cols, edoSteps, pitchSpread } = getGridConfig();
  const rowHeight = height / rows;
  const normalizedRow = clamp(y / rowHeight, 0, rows - 1e-6);
  const row = Math.floor(normalizedRow);
  const xNorm = clamp(x / width, 0, 1);
  const isReversed = row % 2 === 1;
  const rowProgress = isReversed ? 1 - xNorm : xNorm;
  const totalCells = rows * cols;
  const continuousCell = row * cols + rowProgress * (cols - 1);
  const centeredSteps = continuousCell - (totalCells - 1) / 2;
  const scaledSteps = centeredSteps * pitchSpread;

  return {
    row,
    continuousCell,
    pitchRatio: Math.pow(2, scaledSteps / edoSteps),
  };
}

function chooseRandomSample() {
  if (!state.samples.length) {
    return null;
  }
  const index = Math.floor(Math.random() * state.samples.length);
  return state.samples[index];
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function initAudio() {
  if (!state.audioContext) {
    const AudioContextRef = window.AudioContext || window.webkitAudioContext;
    state.audioContext = new AudioContextRef();
    state.masterGain = state.audioContext.createGain();
    state.masterGain.gain.value = 0.9;
    state.masterGain.connect(state.audioContext.destination);
  }
}

async function ensureAudio() {
  initAudio();

  if (state.audioContext.state !== "running") {
    await state.audioContext.resume();
  }

  setAudioStatus("Running");
}

async function decodeFile(file) {
  const arrayBuffer = await file.arrayBuffer();
  const buffer = await state.audioContext.decodeAudioData(arrayBuffer.slice(0));
  return {
    name: file.name,
    buffer,
  };
}

function renderSampleBank() {
  bankSummary.textContent = state.samples.length
    ? `${state.samples.length} sample${state.samples.length === 1 ? "" : "s"} ready`
    : "No samples loaded";

  sampleList.innerHTML = "";
  for (const sample of state.samples) {
    const item = document.createElement("li");
    item.textContent = `${sample.name} • ${sample.buffer.duration.toFixed(2)}s`;
    sampleList.appendChild(item);
  }
}

function updateVoiceReadout() {
  if (!state.activeVoices.size) {
    voiceReadout.textContent = "No active voices";
    return;
  }

  const voices = [...state.activeVoices.values()].map((voice) => {
    return `${voice.sample.name} @ ${voice.source.playbackRate.value.toFixed(2)}x`;
  });
  voiceReadout.textContent = voices.join(" | ");
}

function stopVoice(pointerId) {
  const voice = state.activeVoices.get(pointerId);
  if (!voice || !state.audioContext) {
    return;
  }

  const now = state.audioContext.currentTime;
  voice.gain.gain.cancelScheduledValues(now);
  voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
  voice.gain.gain.linearRampToValueAtTime(0.0001, now + 0.08);
  voice.source.stop(now + 0.09);
  state.activeVoices.delete(pointerId);
  updateVoiceReadout();
  drawPad();
}

function createVoice(pointerId, pointerPosition) {
  const sample = chooseRandomSample();
  if (!sample || !state.audioContext || !state.masterGain) {
    return;
  }

  const sliceMin = Number(controls.sliceMin.value);
  const sliceMax = Math.max(sliceMin, Number(controls.sliceMax.value));
  const duration = Math.min(sample.buffer.duration, randomBetween(sliceMin, sliceMax));
  const maxOffset = Math.max(0, sample.buffer.duration - duration);
  const offset = maxOffset > 0 ? Math.random() * maxOffset : 0;
  const snake = getSnakePosition(pointerPosition);

  const source = state.audioContext.createBufferSource();
  source.buffer = sample.buffer;
  source.loop = true;
  source.loopStart = offset;
  source.loopEnd = Math.min(sample.buffer.duration, offset + duration);
  source.playbackRate.setValueAtTime(snake.pitchRatio, state.audioContext.currentTime);

  const gain = state.audioContext.createGain();
  gain.gain.setValueAtTime(0.0001, state.audioContext.currentTime);
  gain.gain.linearRampToValueAtTime(0.9, state.audioContext.currentTime + 0.02);

  source.connect(gain);
  gain.connect(state.masterGain);
  source.start(state.audioContext.currentTime, offset);
  state.activeVoices.set(pointerId, {
    sample,
    source,
    gain,
    pointerPosition,
  });

  updateVoiceReadout();
  drawPad();
}

function updateVoicePitch(pointerId, pointerPosition) {
  const voice = state.activeVoices.get(pointerId);
  if (!voice || !state.audioContext) {
    return;
  }

  const snake = getSnakePosition(pointerPosition);
  voice.pointerPosition = pointerPosition;
  voice.source.playbackRate.cancelScheduledValues(state.audioContext.currentTime);
  voice.source.playbackRate.linearRampToValueAtTime(
    snake.pitchRatio,
    state.audioContext.currentTime + 0.03,
  );
  updateVoiceReadout();
  drawPad();
}

function drawPad() {
  const bounds = canvas.getBoundingClientRect();
  const { rows, cols } = getGridConfig();
  const width = bounds.width;
  const height = bounds.height;
  const rowHeight = height / rows;
  const colWidth = width / cols;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      ctx.strokeStyle = "#000";
      ctx.strokeRect(col * colWidth, row * rowHeight, colWidth, rowHeight);
    }
  }

  ctx.lineWidth = 1;
  ctx.strokeStyle = "#000";
  ctx.beginPath();
  for (let row = 0; row < rows; row += 1) {
    const y = row * rowHeight + rowHeight / 2;
    if (row === 0) {
      ctx.moveTo(0, y);
    } else {
      const previousX = row % 2 === 0 ? 0 : width;
      ctx.lineTo(previousX, y);
    }
    const endX = row % 2 === 0 ? width : 0;
    ctx.lineTo(endX, y);
  }
  ctx.stroke();

  for (const voice of state.activeVoices.values()) {
    const { x, y } = voice.pointerPosition;
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.arc(x, y, 10, 0, Math.PI * 2);
    ctx.fill();
  }
}

async function loadSamples(files) {
  if (!files.length) {
    return;
  }

  initAudio();
  setAudioStatus("Decoding samples...");

  const nextSamples = [];
  for (const file of files) {
    try {
      nextSamples.push(await decodeFile(file));
    } catch (error) {
      console.error(`Failed to decode ${file.name}`, error);
    }
  }

  state.samples = nextSamples;
  renderSampleBank();
  setAudioStatus(state.samples.length ? "Ready" : "No valid samples");
}

sampleInput.addEventListener("change", async (event) => {
  const files = [...event.target.files];
  await loadSamples(files);
});

for (const control of Object.values(controls)) {
  control.addEventListener("input", () => {
    updateOutputLabels();
    drawPad();
  });
}

canvas.addEventListener("pointerdown", async (event) => {
  event.preventDefault();
  await ensureAudio();

  if (!state.samples.length) {
    setAudioStatus("Load samples first");
    drawPad();
    return;
  }

  const position = getPointerPosition(event);
  canvas.setPointerCapture(event.pointerId);
  createVoice(event.pointerId, position);
});

canvas.addEventListener("pointermove", (event) => {
  if (!state.activeVoices.has(event.pointerId)) {
    return;
  }
  event.preventDefault();
  updateVoicePitch(event.pointerId, getPointerPosition(event));
});

canvas.addEventListener("pointerup", (event) => {
  stopVoice(event.pointerId);
});

canvas.addEventListener("pointercancel", (event) => {
  stopVoice(event.pointerId);
});

canvas.addEventListener("pointerleave", (event) => {
  if (event.buttons === 0) {
    stopVoice(event.pointerId);
  }
});

window.addEventListener("resize", resizeCanvas);

toggleUiButton.addEventListener("click", () => {
  const isHidden = document.body.classList.toggle("ui-hidden");
  toggleUiButton.textContent = isHidden ? "Show controls and info" : "Hide controls and info";
});

updateOutputLabels();
renderSampleBank();
resizeCanvas();
