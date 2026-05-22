const sampleInput = document.getElementById("sampleInput");
const touchPad = document.getElementById("touchPad");
const audioStatus = document.getElementById("audioStatus");
const bankSummary = document.getElementById("bankSummary");
const sampleList = document.getElementById("sampleList");
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
  masterGain: null,
  padBackgroundCanvas: null,
  samples: [],
  transientVoices: new Map(),
  holdVoices: new Map(),
  holdDragByPointer: new Map(),
  holdGestureByPointer: new Map(),
  soloVoice: null,
  soloPointers: new Map(),
  soloLeadPointerId: null,
  lastHoldTap: null,
  nextHoldId: 1,
  mode: "free",
};

const canvas = touchPad;
const ctx = canvas.getContext("2d");
const CONTROL_LANE_HEIGHT = 72;

function getNextHoldId() {
  const holdId = state.nextHoldId;
  state.nextHoldId += 1;
  return holdId;
}

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
  state.padBackgroundCanvas = null;
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

function getPlayableHeight(height) {
  return Math.max(1, height - CONTROL_LANE_HEIGHT);
}

function getControlRegions(width, height) {
  const laneTop = getPlayableHeight(height);
  const laneHeight = height - laneTop;
  const gap = 12;
  const inset = 14;
  const usableWidth = Math.max(0, width - inset * 2 - gap);
  const buttonWidth = usableWidth / 2;

  return [
    {
      action: "mode",
      label: `Mode: ${state.mode.charAt(0).toUpperCase()}${state.mode.slice(1)}`,
      x: inset,
      y: laneTop + 10,
      width: buttonWidth,
      height: Math.max(28, laneHeight - 20),
    },
    {
      action: "hold-current",
      label: "Hold Current",
      x: inset + buttonWidth + gap,
      y: laneTop + 10,
      width: buttonWidth,
      height: Math.max(28, laneHeight - 20),
    },
  ];
}

function getControlActionAtPosition(pointerPosition) {
  const controlsInPad = getControlRegions(pointerPosition.width, pointerPosition.height);
  return controlsInPad.find((control) => (
    pointerPosition.x >= control.x
    && pointerPosition.x <= control.x + control.width
    && pointerPosition.y >= control.y
    && pointerPosition.y <= control.y + control.height
  )) ?? null;
}

function getGridPosition({ x, y, width, height }) {
  const { rows, cols, edoSteps, pitchSpread } = getGridConfig();
  const playableHeight = getPlayableHeight(height);
  const rowHeight = playableHeight / rows;
  const normalizedRow = clamp(y / rowHeight, 0, rows - 1e-6);
  const row = Math.floor(normalizedRow);
  const xNorm = clamp(x / width, 0, 1);
  const totalCells = rows * cols;
  const continuousCell = row * cols + xNorm * (cols - 1);
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
  if (!state.masterGain) {
    state.masterGain = new Tone.Gain(0.9).toDestination();
  }
}

async function ensureAudio() {
  initAudio();
  await Tone.start();

  setAudioStatus("Running");
}

async function decodeFile(file) {
  const arrayBuffer = await file.arrayBuffer();
  const audioBuffer = await Tone.getContext().rawContext.decodeAudioData(arrayBuffer.slice(0));
  return {
    name: file.name,
    buffer: new Tone.ToneAudioBuffer(audioBuffer),
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

function stopVoiceCollection(collection, key) {
  const voice = collection.get(key);
  if (!voice) {
    return;
  }

  const now = Tone.now();
  voice.gain.gain.cancelAndHoldAtTime(now);
  voice.gain.gain.linearRampTo(0.0001, 0.05, now);
  voice.source.stop(now + 0.06);
  collection.delete(key);
  drawPad();
}

function stopTransientVoice(pointerId) {
  stopVoiceCollection(state.transientVoices, pointerId);
}

function stopHoldVoice(holdId) {
  stopVoiceCollection(state.holdVoices, holdId);
}

function stopSoloVoice() {
  if (!state.soloVoice) {
    return;
  }

  const now = Tone.now();
  state.soloVoice.gain.gain.cancelAndHoldAtTime(now);
  state.soloVoice.gain.gain.linearRampTo(0.0001, 0.05, now);
  state.soloVoice.source.stop(now + 0.06);
  state.soloVoice = null;
  drawPad();
}

function createVoice(pointerPosition, options = {}) {
  const sample = chooseRandomSample();
  if (!sample || !state.masterGain) {
    return null;
  }

  const sliceMin = Number(controls.sliceMin.value);
  const sliceMax = Math.max(sliceMin, Number(controls.sliceMax.value));
  const duration = Math.min(sample.buffer.duration, randomBetween(sliceMin, sliceMax));
  const maxOffset = Math.max(0, sample.buffer.duration - duration);
  const offset = maxOffset > 0 ? Math.random() * maxOffset : 0;
  const grid = getGridPosition(pointerPosition);

  const source = new Tone.ToneBufferSource({
    url: sample.buffer,
    loop: true,
    loopStart: offset,
    loopEnd: Math.min(sample.buffer.duration, offset + duration),
    playbackRate: grid.pitchRatio,
  });
  const gain = new Tone.Gain(0.0001).connect(state.masterGain);
  source.connect(gain);
  source.onended = () => {
    source.dispose();
    gain.dispose();
  };

  gain.gain.linearRampTo(0.9, 0.01);
  source.start(Tone.now(), offset);

  return {
    id: options.id ?? null,
    isHeld: Boolean(options.isHeld),
    sample,
    source,
    gain,
    pointerPosition,
  };
}

function storeTransientVoice(pointerId, pointerPosition) {
  const voice = createVoice(pointerPosition, { isHeld: false });
  if (!voice) {
    return;
  }
  state.transientVoices.set(pointerId, voice);
  drawPad();
}

function startSoloVoice(pointerPosition) {
  const voice = createVoice(pointerPosition, { isHeld: false });
  if (!voice) {
    return;
  }
  state.soloVoice = voice;
  drawPad();
}

function createHoldVoice(pointerPosition) {
  const holdId = getNextHoldId();
  const voice = createVoice(pointerPosition, { id: holdId, isHeld: true });
  if (!voice) {
    return null;
  }
  state.holdVoices.set(holdId, voice);
  drawPad();
  return holdId;
}

function updateVoicePitch(voice, pointerPosition) {
  if (!voice) {
    return;
  }

  if (pointerPosition.y > getPlayableHeight(pointerPosition.height)) {
    return;
  }

  const grid = getGridPosition(pointerPosition);
  voice.pointerPosition = pointerPosition;
  voice.source.playbackRate.cancelAndHoldAtTime(Tone.now());
  voice.source.playbackRate.linearRampTo(grid.pitchRatio, 0.015);
  drawPad();
}

function promoteVoiceToHold(voice) {
  if (!voice) {
    return null;
  }

  const holdId = getNextHoldId();
  voice.id = holdId;
  voice.isHeld = true;
  state.holdVoices.set(holdId, voice);
  return holdId;
}

function holdCurrentVoices() {
  let didHoldVoice = false;

  for (const [pointerId, voice] of state.transientVoices.entries()) {
    state.transientVoices.delete(pointerId);
    promoteVoiceToHold(voice);
    didHoldVoice = true;
  }

  if (state.soloVoice) {
    promoteVoiceToHold(state.soloVoice);
    state.soloVoice = null;
    state.soloPointers.clear();
    state.soloLeadPointerId = null;
    didHoldVoice = true;
  }

  if (didHoldVoice) {
    drawPad();
  }
}

function renderStaticPadBackground() {
  const bounds = canvas.getBoundingClientRect();
  const { rows, cols } = getGridConfig();
  const width = Math.max(1, Math.round(bounds.width));
  const height = Math.max(1, Math.round(bounds.height));
  const playableHeight = getPlayableHeight(height);
  const rowHeight = playableHeight / rows;
  const colWidth = width / cols;

  const backgroundCanvas = document.createElement("canvas");
  backgroundCanvas.width = width;
  backgroundCanvas.height = height;
  const backgroundCtx = backgroundCanvas.getContext("2d");

  backgroundCtx.fillStyle = "#fff";
  backgroundCtx.fillRect(0, 0, width, height);

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      backgroundCtx.strokeStyle = "#000";
      backgroundCtx.strokeRect(col * colWidth, row * rowHeight, colWidth, rowHeight);
    }
  }

  backgroundCtx.lineWidth = 1;
  backgroundCtx.strokeStyle = "#000";
  backgroundCtx.beginPath();
  for (let row = 0; row < rows; row += 1) {
    const y = row * rowHeight + rowHeight / 2;
    if (row === 0) {
      backgroundCtx.moveTo(0, y);
    } else {
      backgroundCtx.lineTo(0, y);
    }
    backgroundCtx.lineTo(width, y);
  }
  backgroundCtx.stroke();

  backgroundCtx.fillStyle = "#f1f1f1";
  backgroundCtx.fillRect(0, playableHeight, width, height - playableHeight);
  backgroundCtx.strokeStyle = "#000";
  backgroundCtx.strokeRect(0, playableHeight, width, height - playableHeight);

  const controlRegions = getControlRegions(width, height);
  backgroundCtx.font = '16px "Times New Roman", Times, serif';
  backgroundCtx.textAlign = "center";
  backgroundCtx.textBaseline = "middle";
  for (const control of controlRegions) {
    backgroundCtx.fillStyle = "#fff";
    backgroundCtx.strokeStyle = "#000";
    backgroundCtx.lineWidth = 1;
    backgroundCtx.fillRect(control.x, control.y, control.width, control.height);
    backgroundCtx.strokeRect(control.x, control.y, control.width, control.height);
    backgroundCtx.fillStyle = "#000";
    backgroundCtx.fillText(
      control.label,
      control.x + control.width / 2,
      control.y + control.height / 2,
    );
  }

  state.padBackgroundCanvas = backgroundCanvas;
}

function findHoldVoiceAtPosition(pointerPosition) {
  for (const [holdId, voice] of state.holdVoices.entries()) {
    const dx = voice.pointerPosition.x - pointerPosition.x;
    const dy = voice.pointerPosition.y - pointerPosition.y;
    if (Math.hypot(dx, dy) <= 20) {
      return holdId;
    }
  }
  return null;
}

function getPointerDistance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function getLastSoloPointerId(excludePointerId = null) {
  let nextPointerId = null;
  let lastTime = -1;

  for (const [pointerId, pointerState] of state.soloPointers.entries()) {
    if (pointerId === excludePointerId) {
      continue;
    }
    if (pointerState.startedAt > lastTime) {
      lastTime = pointerState.startedAt;
      nextPointerId = pointerId;
    }
  }

  return nextPointerId;
}

function drawPad() {
  const bounds = canvas.getBoundingClientRect();
  const width = bounds.width;
  const height = bounds.height;

  if (!state.padBackgroundCanvas
    || state.padBackgroundCanvas.width !== Math.round(width)
    || state.padBackgroundCanvas.height !== Math.round(height)) {
    renderStaticPadBackground();
  }

  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(state.padBackgroundCanvas, 0, 0, width, height);

  for (const voice of state.holdVoices.values()) {
    const { x, y } = voice.pointerPosition;
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x, y, 12, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - 6, y);
    ctx.lineTo(x + 6, y);
    ctx.moveTo(x, y - 6);
    ctx.lineTo(x, y + 6);
    ctx.stroke();
  }

  for (const voice of state.transientVoices.values()) {
    const { x, y } = voice.pointerPosition;
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.arc(x, y, 10, 0, Math.PI * 2);
    ctx.fill();
  }

  if (state.soloVoice) {
    const { x, y } = state.soloVoice.pointerPosition;
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.arc(x, y, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
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
  const position = getPointerPosition(event);
  const controlAction = getControlActionAtPosition(position);

  if (controlAction) {
    if (controlAction.action === "mode") {
      cycleMode();
    } else if (controlAction.action === "hold-current") {
      holdCurrentVoices();
    }
    return;
  }

  await ensureAudio();

  if (!state.samples.length) {
    setAudioStatus("Load samples first");
    drawPad();
    return;
  }

  canvas.setPointerCapture(event.pointerId);

  if (state.mode === "solo") {
    state.soloPointers.set(event.pointerId, {
      position,
      startedAt: performance.now(),
    });
    state.soloLeadPointerId = event.pointerId;

    if (!state.soloVoice) {
      startSoloVoice(position);
      return;
    }

    updateVoicePitch(state.soloVoice, position);
    return;
  }

  if (state.mode === "hold") {
    const existingHoldId = findHoldVoiceAtPosition(position);
    if (existingHoldId !== null) {
      state.holdDragByPointer.set(event.pointerId, existingHoldId);
      state.holdGestureByPointer.set(event.pointerId, {
        holdId: existingHoldId,
        startPosition: position,
        lastPosition: position,
        moved: false,
      });
      const voice = state.holdVoices.get(existingHoldId);
      if (voice) {
        updateVoicePitch(voice, position);
      }
      return;
    }

    state.lastHoldTap = null;
    state.holdGestureByPointer.delete(event.pointerId);
    const holdId = createHoldVoice(position);
    if (holdId !== null) {
      state.holdDragByPointer.set(event.pointerId, holdId);
      const voice = state.holdVoices.get(holdId);
      if (voice) {
        updateVoicePitch(voice, position);
      }
    }
    return;
  }

  storeTransientVoice(event.pointerId, position);
});

canvas.addEventListener("pointermove", (event) => {
  event.preventDefault();
  const position = getPointerPosition(event);

  if (state.mode === "solo") {
    const pointerState = state.soloPointers.get(event.pointerId);
    if (!pointerState) {
      return;
    }
    pointerState.position = position;
    if (state.soloLeadPointerId === event.pointerId && state.soloVoice) {
      updateVoicePitch(state.soloVoice, position);
    }
    return;
  }

  if (state.mode === "hold") {
    const gesture = state.holdGestureByPointer.get(event.pointerId);
    if (gesture) {
      gesture.lastPosition = position;
      if (!gesture.moved && getPointerDistance(gesture.startPosition, position) > 12) {
        gesture.moved = true;
      }
    }
    const holdId = state.holdDragByPointer.get(event.pointerId);
    if (holdId === undefined) {
      return;
    }
    const voice = state.holdVoices.get(holdId);
    if (voice) {
      updateVoicePitch(voice, position);
    }
    return;
  }

  const voice = state.transientVoices.get(event.pointerId);
  if (!voice) {
    return;
  }
  updateVoicePitch(voice, position);
});

canvas.addEventListener("pointerup", (event) => {
  if (state.mode === "solo") {
    state.soloPointers.delete(event.pointerId);

    if (!state.soloPointers.size) {
      state.soloLeadPointerId = null;
      stopSoloVoice();
      return;
    }

    if (state.soloLeadPointerId === event.pointerId) {
      state.soloLeadPointerId = getLastSoloPointerId(event.pointerId);
      const pointerState = state.soloPointers.get(state.soloLeadPointerId);
      if (pointerState && state.soloVoice) {
        updateVoicePitch(state.soloVoice, pointerState.position);
      }
    }
    return;
  }

  if (state.mode === "hold") {
    const gesture = state.holdGestureByPointer.get(event.pointerId);
    state.holdDragByPointer.delete(event.pointerId);
    state.holdGestureByPointer.delete(event.pointerId);

    if (!gesture || gesture.moved) {
      return;
    }

    const now = performance.now();
    const isDoubleTap = state.lastHoldTap
      && state.lastHoldTap.holdId === gesture.holdId
      && now - state.lastHoldTap.time < 300;

    if (isDoubleTap) {
      stopHoldVoice(gesture.holdId);
      state.lastHoldTap = null;
      return;
    }

    state.lastHoldTap = {
      holdId: gesture.holdId,
      time: now,
      position: gesture.lastPosition,
    };
    return;
  }
  stopTransientVoice(event.pointerId);
});

canvas.addEventListener("pointercancel", (event) => {
  if (state.mode === "solo") {
    state.soloPointers.delete(event.pointerId);

    if (!state.soloPointers.size) {
      state.soloLeadPointerId = null;
      stopSoloVoice();
      return;
    }

    if (state.soloLeadPointerId === event.pointerId) {
      state.soloLeadPointerId = getLastSoloPointerId(event.pointerId);
      const pointerState = state.soloPointers.get(state.soloLeadPointerId);
      if (pointerState && state.soloVoice) {
        updateVoicePitch(state.soloVoice, pointerState.position);
      }
    }
    return;
  }

  if (state.mode === "hold") {
    state.holdDragByPointer.delete(event.pointerId);
    state.holdGestureByPointer.delete(event.pointerId);
    return;
  }
  stopTransientVoice(event.pointerId);
});

canvas.addEventListener("pointerleave", (event) => {
  if (state.mode === "solo") {
    if (event.buttons === 0) {
      state.soloPointers.delete(event.pointerId);

      if (!state.soloPointers.size) {
        state.soloLeadPointerId = null;
        stopSoloVoice();
        return;
      }

      if (state.soloLeadPointerId === event.pointerId) {
        state.soloLeadPointerId = getLastSoloPointerId(event.pointerId);
        const pointerState = state.soloPointers.get(state.soloLeadPointerId);
        if (pointerState && state.soloVoice) {
          updateVoicePitch(state.soloVoice, pointerState.position);
        }
      }
    }
    return;
  }

  if (state.mode === "hold") {
    if (event.buttons === 0) {
      state.holdDragByPointer.delete(event.pointerId);
      state.holdGestureByPointer.delete(event.pointerId);
    }
    return;
  }
  if (event.buttons === 0) {
    stopTransientVoice(event.pointerId);
  }
});

window.addEventListener("resize", resizeCanvas);

toggleUiButton.addEventListener("click", () => {
  const isHidden = document.body.classList.toggle("ui-hidden");
  toggleUiButton.textContent = isHidden ? "Show controls and info" : "Hide controls and info";
});

function cycleMode() {
  if (state.mode === "free") {
    state.mode = "hold";
  } else if (state.mode === "hold") {
    state.mode = "solo";
  } else {
    state.mode = "free";
  }

  state.holdDragByPointer.clear();
  state.holdGestureByPointer.clear();
  state.soloPointers.clear();
  state.soloLeadPointerId = null;
  stopSoloVoice();
  drawPad();
}

updateOutputLabels();
renderSampleBank();
resizeCanvas();
