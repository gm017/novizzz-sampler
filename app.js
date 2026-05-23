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
  masterInput: null,
  masterGain: null,
  globalPitchShift: null,
  globalDelay: null,
  globalDistortion: null,
  padBackgroundCanvas: null,
  drawScheduled: false,
  controlDragByPointer: new Map(),
  samples: [],
  transientVoices: new Map(),
  holdVoices: new Map(),
  holdDragByPointer: new Map(),
  holdGestureByPointer: new Map(),
  soloVoice: null,
  soloPointers: new Map(),
  soloLeadPointerId: null,
  lastHoldTap: null,
  lastInteractedHoldId: null,
  interactionMode: "play",
  selectedHoldId: null,
  topEffectView: "main",
  liveMetalAmount: 0,
  liveDelayTimeAmount: 0.18,
  liveDelayFeedbackAmount: 0.18,
  liveDelayMixAmount: 0.0,
  liveDistortionAmount: 0.12,
  globalPitchAmount: 0.5,
  globalDelayTimeAmount: 0.22,
  globalDelayFeedbackAmount: 0.18,
  globalDelayMixAmount: 0.0,
  globalDistortionAmount: 0.0,
  liveSequencer: null,
  nextHoldId: 1,
  mode: "free",
};

const canvas = touchPad;
const ctx = canvas.getContext("2d");
const TOP_CONTROL_LANE_HEIGHT = 112;
const BOTTOM_CONTROL_LANE_HEIGHT = 72;
const BASE_SEQUENCE_INTERVAL = "16n";
const SEQUENCE_RATE_OPTIONS = [1, 2, 3, 4];
const SEQUENCE_PATTERN_COUNT = 4;
const SEQUENCE_MAX_STEPS = 16;

function createSequencePattern({ unlocked = false, length = SEQUENCE_MAX_STEPS } = {}) {
  return {
    unlocked,
    length,
    steps: Array(SEQUENCE_MAX_STEPS).fill(true),
  };
}

function createDefaultSequencerState() {
  return {
    activePatternIndex: 0,
    rateMultiplier: 1,
    patterns: Array.from({ length: SEQUENCE_PATTERN_COUNT }, (_, index) => (
      createSequencePattern({ unlocked: index === 0 })
    )),
  };
}

state.liveSequencer = createDefaultSequencerState();

function getNextHoldId() {
  const holdId = state.nextHoldId;
  state.nextHoldId += 1;
  return holdId;
}

function setLastInteractedHoldId(holdId) {
  if (holdId !== null && !state.holdVoices.has(holdId)) {
    return;
  }
  state.lastInteractedHoldId = holdId;
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

function schedulePadDraw() {
  if (state.drawScheduled) {
    return;
  }
  state.drawScheduled = true;
  window.requestAnimationFrame(() => {
    state.drawScheduled = false;
    drawPad();
  });
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
  return Math.max(1, height - TOP_CONTROL_LANE_HEIGHT - BOTTOM_CONTROL_LANE_HEIGHT);
}

function getPlayableTop() {
  return TOP_CONTROL_LANE_HEIGHT;
}

function cloneSequencerState(sequencer = createDefaultSequencerState()) {
  return {
    activePatternIndex: clamp(sequencer.activePatternIndex ?? 0, 0, SEQUENCE_PATTERN_COUNT - 1),
    rateMultiplier: SEQUENCE_RATE_OPTIONS.includes(sequencer.rateMultiplier)
      ? sequencer.rateMultiplier
      : 1,
    patterns: Array.from({ length: SEQUENCE_PATTERN_COUNT }, (_, index) => {
      const pattern = sequencer.patterns?.[index];
      return {
        unlocked: pattern?.unlocked ?? index === 0,
        length: clamp(pattern?.length ?? SEQUENCE_MAX_STEPS, 1, SEQUENCE_MAX_STEPS),
        steps: Array.from({ length: SEQUENCE_MAX_STEPS }, (_, stepIndex) => (
          pattern?.steps?.[stepIndex] !== false
        )),
      };
    }),
  };
}

function getSequencerStateForVoice(voice) {
  return voice?.sequencer ?? null;
}

function getDisplayedSequencerState() {
  if (state.interactionMode === "edit") {
    const voice = getEditableHoldVoice();
    const sequencer = getSequencerStateForVoice(voice);
    if (sequencer) {
      return sequencer;
    }
  }
  return state.liveSequencer;
}

function getActiveSequencePattern(sequencer) {
  return sequencer?.patterns?.[sequencer.activePatternIndex] ?? null;
}

function isPointerInPlayableArea({ y, height }) {
  const playableTop = getPlayableTop();
  const playableBottom = playableTop + getPlayableHeight(height);
  return y >= playableTop && y <= playableBottom;
}

function getTopControlRegions(width) {
  const laneTop = 0;
  const laneHeight = TOP_CONTROL_LANE_HEIGHT;
  const inset = 14;
  const gap = 10;
  const controlY = laneTop + 10;
  const controlHeight = Math.max(28, laneHeight - 20);

  if (state.topEffectView === "sequencer") {
    const headerHeight = 20;
    const stepGap = 4;
    const patternGap = 6;
    const rateGap = 6;
    const patternY = controlY + headerHeight + 4;
    const patternHeight = 18;
    const rateY = patternY + patternHeight + 4;
    const rateHeight = 18;
    const stepsTop = rateY + rateHeight + 4;
    const stepAreaHeight = Math.max(24, controlHeight - headerHeight - patternHeight - rateHeight - 12);
    const rowGap = 6;
    const stepHeight = (stepAreaHeight - rowGap) / 2;
    const stepWidth = (Math.max(0, width - inset * 2 - stepGap * 7) / 8);
    const backWidth = 52;
    const lenButtonWidth = 22;
    const lenLabelWidth = 42;
    const patternButtonWidth = Math.max(
      24,
      (Math.max(0, width - inset * 2 - backWidth - gap - (lenButtonWidth * 2) - lenLabelWidth - (patternGap * 6)) / 4),
    );
    const rateButtonWidth = Math.max(24, (Math.max(0, width - inset * 2 - rateGap * 3) / 4));
    const controls = [
      {
        action: "sequencer-back",
        label: "Back",
        x: inset,
        y: controlY,
        width: backWidth,
        height: headerHeight,
      },
    ];

    for (let index = 0; index < SEQUENCE_PATTERN_COUNT; index += 1) {
      controls.push({
        action: "sequencer-pattern",
        patternIndex: index,
        label: `P${index + 1}`,
        x: inset + backWidth + gap + index * (patternButtonWidth + patternGap),
        y: patternY,
        width: patternButtonWidth,
        height: patternHeight,
      });
    }

    const lengthControlX = inset + backWidth + gap + SEQUENCE_PATTERN_COUNT * (patternButtonWidth + patternGap);
    controls.push(
      {
        action: "sequencer-length-dec",
        label: "-",
        x: lengthControlX,
        y: patternY,
        width: lenButtonWidth,
        height: patternHeight,
      },
      {
        action: "sequencer-length-display",
        label: `Len ${getDisplayedSequenceLength()}`,
        x: lengthControlX + lenButtonWidth + patternGap,
        y: patternY,
        width: lenLabelWidth,
        height: patternHeight,
      },
      {
        action: "sequencer-length-inc",
        label: "+",
        x: lengthControlX + lenButtonWidth + patternGap + lenLabelWidth + patternGap,
        y: patternY,
        width: lenButtonWidth,
        height: patternHeight,
      },
    );

    for (const [index, multiplier] of SEQUENCE_RATE_OPTIONS.entries()) {
      controls.push({
        action: "sequencer-rate",
        multiplier,
        label: `${multiplier}x`,
        x: inset + index * (rateButtonWidth + rateGap),
        y: rateY,
        width: rateButtonWidth,
        height: rateHeight,
      });
    }

    for (let index = 0; index < SEQUENCE_MAX_STEPS; index += 1) {
      const row = Math.floor(index / 8);
      const col = index % 8;
      controls.push({
        action: "sequencer-step",
        stepIndex: index,
        label: `${index + 1}`,
        x: inset + col * (stepWidth + stepGap),
        y: stepsTop + row * (stepHeight + rowGap),
        width: stepWidth,
        height: stepHeight,
      });
    }

    return controls;
  }

  if (state.topEffectView === "delay") {
    const usableWidth = Math.max(0, width - inset * 2 - gap * 3);
    const controlWidth = usableWidth / 4;
    return [
      {
        action: "delay-back",
        label: "Back",
        x: inset,
        y: controlY,
        width: controlWidth,
        height: controlHeight,
      },
      {
        action: "delay-time",
        label: `Time ${getDisplayedDelayTimeAmount().toFixed(2)}`,
        x: inset + (controlWidth + gap),
        y: controlY,
        width: controlWidth,
        height: controlHeight,
      },
      {
        action: "delay-feedback",
        label: `Fdbk ${getDisplayedDelayFeedbackAmount().toFixed(2)}`,
        x: inset + (controlWidth + gap) * 2,
        y: controlY,
        width: controlWidth,
        height: controlHeight,
      },
      {
        action: "delay-mix",
        label: `Mix ${getDisplayedDelayMixAmount().toFixed(2)}`,
        x: inset + (controlWidth + gap) * 3,
        y: controlY,
        width: controlWidth,
        height: controlHeight,
      },
    ];
  }

  if (state.topEffectView === "global") {
    const usableWidth = Math.max(0, width - inset * 2 - gap * 3);
    const controlWidth = usableWidth / 4;
    return [
      {
        action: "global-back",
        label: "Back",
        x: inset,
        y: controlY,
        width: controlWidth,
        height: controlHeight,
      },
      {
        action: "global-pitch",
        label: `Pitch ${getDisplayedGlobalPitchSemitones()}`,
        x: inset + (controlWidth + gap),
        y: controlY,
        width: controlWidth,
        height: controlHeight,
      },
      {
        action: "global-delay",
        label: `Delay ${getDisplayedGlobalDelayMixAmount().toFixed(2)}`,
        x: inset + (controlWidth + gap) * 2,
        y: controlY,
        width: controlWidth,
        height: controlHeight,
      },
      {
        action: "global-distortion",
        label: `Dist ${getDisplayedGlobalDistortionAmount().toFixed(2)}`,
        x: inset + (controlWidth + gap) * 3,
        y: controlY,
        width: controlWidth,
        height: controlHeight,
      },
    ];
  }

  if (state.topEffectView === "global-delay") {
    const usableWidth = Math.max(0, width - inset * 2 - gap * 3);
    const controlWidth = usableWidth / 4;
    return [
      {
        action: "global-delay-back",
        label: "Back",
        x: inset,
        y: controlY,
        width: controlWidth,
        height: controlHeight,
      },
      {
        action: "global-delay-time",
        label: `Time ${getDisplayedGlobalDelayTimeAmount().toFixed(2)}`,
        x: inset + (controlWidth + gap),
        y: controlY,
        width: controlWidth,
        height: controlHeight,
      },
      {
        action: "global-delay-feedback",
        label: `Fdbk ${getDisplayedGlobalDelayFeedbackAmount().toFixed(2)}`,
        x: inset + (controlWidth + gap) * 2,
        y: controlY,
        width: controlWidth,
        height: controlHeight,
      },
      {
        action: "global-delay-mix",
        label: `Mix ${getDisplayedGlobalDelayMixAmount().toFixed(2)}`,
        x: inset + (controlWidth + gap) * 3,
        y: controlY,
        width: controlWidth,
        height: controlHeight,
      },
    ];
  }

  const usableWidth = Math.max(0, width - inset * 2 - gap * 3);
  const controlWidth = usableWidth / 4;

  return [
    {
      action: "metal",
      label: `Metal ${getDisplayedMetalAmount().toFixed(2)}`,
      x: inset,
      y: controlY,
      width: controlWidth,
      height: controlHeight,
    },
    {
      action: "delay",
      label: `Delay ${getDisplayedDelayAmount().toFixed(2)}`,
      x: inset + controlWidth + gap,
      y: controlY,
      width: controlWidth,
      height: controlHeight,
    },
    {
      action: "distortion",
      label: `Dist ${getDisplayedDistortionAmount().toFixed(2)}`,
      x: inset + (controlWidth + gap) * 2,
      y: controlY,
      width: controlWidth,
      height: controlHeight,
    },
    {
      action: "sequencer",
      label: `Seq P${getDisplayedSequencePatternIndex() + 1} ${getDisplayedSequenceOnCount()}/${getDisplayedSequenceLength()}`,
      x: inset + (controlWidth + gap) * 3,
      y: controlY,
      width: controlWidth,
      height: controlHeight,
    },
  ];
}

function getBottomControlRegions(width, height) {
  const laneTop = height - BOTTOM_CONTROL_LANE_HEIGHT;
  const laneHeight = BOTTOM_CONTROL_LANE_HEIGHT;
  const gap = 10;
  const inset = 14;
  const usableWidth = Math.max(0, width - inset * 2 - gap * 3);
  const buttonWidth = usableWidth / 4;
  const controlY = laneTop + 10;
  const controlHeight = Math.max(28, laneHeight - 20);

  return [
    {
      action: "mode",
      label: `Mode: ${state.mode.charAt(0).toUpperCase()}${state.mode.slice(1)}`,
      x: inset,
      y: controlY,
      width: buttonWidth,
      height: controlHeight,
    },
    {
      action: "hold",
      label: "Hold",
      x: inset + buttonWidth + gap,
      y: controlY,
      width: buttonWidth,
      height: controlHeight,
    },
    {
      action: "edit-held",
      label: state.interactionMode === "edit" ? "Edit: On" : "Edit: Off",
      x: inset + (buttonWidth + gap) * 2,
      y: controlY,
      width: buttonWidth,
      height: controlHeight,
    },
    {
      action: "global",
      label: "Global",
      x: inset + (buttonWidth + gap) * 3,
      y: controlY,
      width: buttonWidth,
      height: controlHeight,
    },
  ];
}

function getControlActionAtPosition(pointerPosition) {
  const controlsInPad = [
    ...getTopControlRegions(pointerPosition.width),
    ...getBottomControlRegions(pointerPosition.width, pointerPosition.height),
  ];
  return controlsInPad.find((control) => (
    pointerPosition.x >= control.x
    && pointerPosition.x <= control.x + control.width
    && pointerPosition.y >= control.y
    && pointerPosition.y <= control.y + control.height
  )) ?? null;
}

function getDisplayedMetalAmount() {
  if (state.interactionMode === "edit") {
    const voice = getEditableHoldVoice();
    if (voice) {
      return voice.metalAmount;
    }
  }
  return state.liveMetalAmount;
}

function getDisplayedDelayAmount() {
  return getDisplayedDelayMixAmount();
}

function getDisplayedGlobalPitchAmount() {
  return state.globalPitchAmount;
}

function getDisplayedGlobalPitchSemitones() {
  const semitones = Math.round((getDisplayedGlobalPitchAmount() - 0.5) * 24);
  return semitones > 0 ? `+${semitones}` : `${semitones}`;
}

function getDisplayedGlobalDelayAmount() {
  return getDisplayedGlobalDelayMixAmount();
}

function getDisplayedGlobalDelayTimeAmount() {
  return state.globalDelayTimeAmount;
}

function getDisplayedGlobalDelayFeedbackAmount() {
  return state.globalDelayFeedbackAmount;
}

function getDisplayedGlobalDelayMixAmount() {
  return state.globalDelayMixAmount;
}

function getDisplayedGlobalDistortionAmount() {
  return state.globalDistortionAmount;
}

function getDisplayedDistortionAmount() {
  if (state.interactionMode === "edit") {
    const voice = getEditableHoldVoice();
    if (voice) {
      return voice.distortionAmount;
    }
  }
  return state.liveDistortionAmount;
}

function getDisplayedSequencePattern() {
  return getActiveSequencePattern(getDisplayedSequencerState())?.steps ?? Array(SEQUENCE_MAX_STEPS).fill(true);
}

function getDisplayedSequenceLength() {
  return getActiveSequencePattern(getDisplayedSequencerState())?.length ?? SEQUENCE_MAX_STEPS;
}

function getDisplayedSequencePatternIndex() {
  return getDisplayedSequencerState()?.activePatternIndex ?? 0;
}

function isDisplayedSequencePatternUnlocked(patternIndex) {
  return getDisplayedSequencerState()?.patterns?.[patternIndex]?.unlocked ?? false;
}

function getDisplayedSequenceOnCount() {
  const pattern = getActiveSequencePattern(getDisplayedSequencerState());
  if (!pattern) {
    return 0;
  }
  return pattern.steps.slice(0, pattern.length).filter(Boolean).length;
}

function getDisplayedSequenceRateMultiplier() {
  return getDisplayedSequencerState()?.rateMultiplier ?? 1;
}

function getDisplayedDelayTimeAmount() {
  if (state.interactionMode === "edit") {
    const voice = getEditableHoldVoice();
    if (voice) {
      return voice.delayTimeAmount;
    }
  }
  return state.liveDelayTimeAmount;
}

function getDisplayedDelayFeedbackAmount() {
  if (state.interactionMode === "edit") {
    const voice = getEditableHoldVoice();
    if (voice) {
      return voice.delayFeedbackAmount;
    }
  }
  return state.liveDelayFeedbackAmount;
}

function getDisplayedDelayMixAmount() {
  if (state.interactionMode === "edit") {
    const voice = getEditableHoldVoice();
    if (voice) {
      return voice.delayMixAmount;
    }
  }
  return state.liveDelayMixAmount;
}

function getGridPosition({ x, y, width, height }) {
  const { rows, cols, edoSteps, pitchSpread } = getGridConfig();
  const playableHeight = getPlayableHeight(height);
  const playableTop = getPlayableTop();
  const rowHeight = playableHeight / rows;
  const normalizedRow = clamp((y - playableTop) / rowHeight, 0, rows - 1e-6);
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
  if (!state.masterInput) {
    state.masterInput = new Tone.Gain(1);
    state.globalPitchShift = new Tone.PitchShift({
      pitch: 0,
      windowSize: 0.08,
      delayTime: 0,
      feedback: 0,
    });
    state.globalDelay = new Tone.FeedbackDelay({
      delayTime: 0.18,
      feedback: 0.12,
      wet: 0,
    });
    state.globalDistortion = new Tone.Distortion(0);
    state.masterGain = new Tone.Gain(0.9).toDestination();
    state.masterInput.connect(state.globalPitchShift);
    state.globalPitchShift.connect(state.globalDelay);
    state.globalDelay.connect(state.globalDistortion);
    state.globalDistortion.connect(state.masterGain);
    applyGlobalPitchShift();
    applyGlobalDelay();
    applyGlobalDistortion();
  }
}

async function ensureAudio() {
  initAudio();
  await Tone.start();
  if (Tone.Transport.state !== "started") {
    Tone.Transport.bpm.value = 120;
    Tone.Transport.start();
  }

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

function getVoiceMetalFrequency(basePlaybackRate, amount) {
  return 60 + (amount * 640) + (basePlaybackRate * 20);
}

function getVoiceMetalDepth(basePlaybackRate, amount) {
  return basePlaybackRate * amount * 1.8;
}

function applyVoiceMetal(voice) {
  if (!voice || !voice.modOsc || !voice.modGain) {
    return;
  }

  const now = Tone.now();
  voice.modOsc.frequency.setValueAtTime(
    getVoiceMetalFrequency(voice.basePlaybackRate, voice.metalAmount),
    now,
  );
  voice.modGain.gain.setValueAtTime(
    getVoiceMetalDepth(voice.basePlaybackRate, voice.metalAmount),
    now,
  );
}

function applyVoiceDelay(voice) {
  if (!voice?.delayNode) {
    return;
  }
  const now = Tone.now();
  voice.delayNode.delayTime.setValueAtTime(0.04 + (voice.delayTimeAmount * 0.36), now);
  voice.delayNode.feedback.setValueAtTime(0.08 + (voice.delayFeedbackAmount * 0.72), now);
  voice.delayNode.wet.setValueAtTime(voice.delayMixAmount * 0.85, now);
}

function applyVoiceDistortion(voice) {
  if (!voice?.distortionNode) {
    return;
  }
  const now = Tone.now();
  voice.distortionNode.distortion = voice.distortionAmount * 0.95;
  voice.distortionNode.wet.setValueAtTime(voice.distortionAmount * 0.9, now);
}

function applyGlobalPitchShift() {
  if (!state.globalPitchShift) {
    return;
  }
  state.globalPitchShift.pitch = Math.round((state.globalPitchAmount - 0.5) * 24);
}

function applyGlobalDelay() {
  if (!state.globalDelay) {
    return;
  }
  const now = Tone.now();
  state.globalDelay.delayTime.setValueAtTime(0.06 + (state.globalDelayTimeAmount * 0.54), now);
  state.globalDelay.feedback.setValueAtTime(0.08 + (state.globalDelayFeedbackAmount * 0.72), now);
  state.globalDelay.wet.setValueAtTime(state.globalDelayMixAmount * 0.85, now);
}

function applyGlobalDistortion() {
  if (!state.globalDistortion) {
    return;
  }
  const now = Tone.now();
  state.globalDistortion.distortion = state.globalDistortionAmount * 0.95;
  state.globalDistortion.wet.setValueAtTime(state.globalDistortionAmount * 0.9, now);
}

function applyVoiceSequencerStep(voice, time = Tone.now()) {
  const sequencer = getSequencerStateForVoice(voice);
  const pattern = getActiveSequencePattern(sequencer);
  if (!voice?.sequenceGateGain?.gain || !pattern?.steps?.length) {
    return;
  }
  const stepTicks = Tone.Time(BASE_SEQUENCE_INTERVAL).toTicks() / (sequencer.rateMultiplier ?? 1);
  const stepIndex = Math.floor(Tone.Transport.getTicksAtTime(time) / stepTicks) % pattern.length;
  const isOn = pattern.steps[stepIndex] !== false;
  voice.sequenceGateGain.gain.setValueAtTime(isOn ? 1 : 0, time);
}

function updateVoiceSequenceLoopRate(voice) {
  const sequencer = getSequencerStateForVoice(voice);
  if (!voice?.sequenceLoop || !sequencer) {
    return;
  }
  const stepTicks = Tone.Time(BASE_SEQUENCE_INTERVAL).toTicks() / (sequencer.rateMultiplier ?? 1);
  voice.sequenceLoop.interval = `${stepTicks}i`;
}

function getEditableHoldVoice() {
  if (state.selectedHoldId === null) {
    if (state.holdVoices.size > 0) {
      return [...state.holdVoices.values()][state.holdVoices.size - 1];
    }
    return null;
  }
  return state.holdVoices.get(state.selectedHoldId) ?? null;
}

function getEffectTargetVoices() {
  if (state.interactionMode === "edit") {
    const selectedVoice = getEditableHoldVoice();
    return selectedVoice ? [selectedVoice] : [];
  }

  const targets = [...state.transientVoices.values()];
  if (state.soloVoice) {
    targets.push(state.soloVoice);
  }
  return targets;
}

function setMetalAmountForTargets(amount) {
  const nextAmount = clamp(amount, 0, 1);
  const targets = getEffectTargetVoices();

  if (state.interactionMode === "edit") {
    const selectedVoice = getEditableHoldVoice();
    if (!selectedVoice) {
      return;
    }
    selectedVoice.metalAmount = nextAmount;
    applyVoiceMetal(selectedVoice);
    schedulePadDraw();
    return;
  }

  state.liveMetalAmount = nextAmount;
  for (const voice of targets) {
    voice.metalAmount = nextAmount;
    applyVoiceMetal(voice);
  }
  schedulePadDraw();
}

function setDelayAmountForTargets(amount) {
  const nextAmount = clamp(amount, 0, 1);
  const targets = getEffectTargetVoices();

  if (state.interactionMode === "edit") {
    const selectedVoice = getEditableHoldVoice();
    if (!selectedVoice) {
      return;
    }
    selectedVoice.delayMixAmount = nextAmount;
    applyVoiceDelay(selectedVoice);
    schedulePadDraw();
    return;
  }

  state.liveDelayMixAmount = nextAmount;
  for (const voice of targets) {
    voice.delayMixAmount = nextAmount;
    applyVoiceDelay(voice);
  }
  schedulePadDraw();
}

function setDelayTimeAmountForTargets(amount) {
  const nextAmount = clamp(amount, 0, 1);
  const targets = getEffectTargetVoices();

  if (state.interactionMode === "edit") {
    const selectedVoice = getEditableHoldVoice();
    if (!selectedVoice) {
      return;
    }
    selectedVoice.delayTimeAmount = nextAmount;
    applyVoiceDelay(selectedVoice);
    schedulePadDraw();
    return;
  }

  state.liveDelayTimeAmount = nextAmount;
  for (const voice of targets) {
    voice.delayTimeAmount = nextAmount;
    applyVoiceDelay(voice);
  }
  schedulePadDraw();
}

function setDelayFeedbackAmountForTargets(amount) {
  const nextAmount = clamp(amount, 0, 1);
  const targets = getEffectTargetVoices();

  if (state.interactionMode === "edit") {
    const selectedVoice = getEditableHoldVoice();
    if (!selectedVoice) {
      return;
    }
    selectedVoice.delayFeedbackAmount = nextAmount;
    applyVoiceDelay(selectedVoice);
    schedulePadDraw();
    return;
  }

  state.liveDelayFeedbackAmount = nextAmount;
  for (const voice of targets) {
    voice.delayFeedbackAmount = nextAmount;
    applyVoiceDelay(voice);
  }
  schedulePadDraw();
}

function setDelayMixAmountForTargets(amount) {
  const nextAmount = clamp(amount, 0, 1);
  const targets = getEffectTargetVoices();

  if (state.interactionMode === "edit") {
    const selectedVoice = getEditableHoldVoice();
    if (!selectedVoice) {
      return;
    }
    selectedVoice.delayMixAmount = nextAmount;
    applyVoiceDelay(selectedVoice);
    schedulePadDraw();
    return;
  }

  state.liveDelayMixAmount = nextAmount;
  for (const voice of targets) {
    voice.delayMixAmount = nextAmount;
    applyVoiceDelay(voice);
  }
  schedulePadDraw();
}

function setDistortionAmountForTargets(amount) {
  const nextAmount = clamp(amount, 0, 1);
  const targets = getEffectTargetVoices();

  if (state.interactionMode === "edit") {
    const selectedVoice = getEditableHoldVoice();
    if (!selectedVoice) {
      return;
    }
    selectedVoice.distortionAmount = nextAmount;
    applyVoiceDistortion(selectedVoice);
    schedulePadDraw();
    return;
  }

  state.liveDistortionAmount = nextAmount;
  for (const voice of targets) {
    voice.distortionAmount = nextAmount;
    applyVoiceDistortion(voice);
  }
  schedulePadDraw();
}

function setGlobalPitchAmount(amount) {
  state.globalPitchAmount = clamp(amount, 0, 1);
  applyGlobalPitchShift();
  schedulePadDraw();
}

function setGlobalDelayAmount(amount) {
  state.globalDelayMixAmount = clamp(amount, 0, 1);
  applyGlobalDelay();
  schedulePadDraw();
}

function setGlobalDelayTimeAmount(amount) {
  state.globalDelayTimeAmount = clamp(amount, 0, 1);
  applyGlobalDelay();
  schedulePadDraw();
}

function setGlobalDelayFeedbackAmount(amount) {
  state.globalDelayFeedbackAmount = clamp(amount, 0, 1);
  applyGlobalDelay();
  schedulePadDraw();
}

function setGlobalDelayMixAmount(amount) {
  state.globalDelayMixAmount = clamp(amount, 0, 1);
  applyGlobalDelay();
  schedulePadDraw();
}

function setGlobalDistortionAmount(amount) {
  state.globalDistortionAmount = clamp(amount, 0, 1);
  applyGlobalDistortion();
  schedulePadDraw();
}

function setSequenceStepEnabled(stepIndex, isEnabled) {
  const targets = getEffectTargetVoices();

  if (state.interactionMode === "edit") {
    const selectedVoice = getEditableHoldVoice();
    const selectedPattern = getActiveSequencePattern(getSequencerStateForVoice(selectedVoice));
    if (!selectedPattern) {
      return;
    }
    selectedPattern.steps[stepIndex] = isEnabled;
    applyVoiceSequencerStep(selectedVoice);
    schedulePadDraw();
    return;
  }

  const livePattern = getActiveSequencePattern(state.liveSequencer);
  if (!livePattern) {
    return;
  }
  livePattern.steps[stepIndex] = isEnabled;
  for (const voice of targets) {
    const pattern = getActiveSequencePattern(getSequencerStateForVoice(voice));
    if (!pattern) {
      continue;
    }
    pattern.steps[stepIndex] = isEnabled;
    applyVoiceSequencerStep(voice);
  }
  schedulePadDraw();
}

function setSequenceRateMultiplierForTargets(multiplier) {
  const nextMultiplier = SEQUENCE_RATE_OPTIONS.includes(multiplier) ? multiplier : 1;
  const targets = getEffectTargetVoices();

  if (state.interactionMode === "edit") {
    const selectedVoice = getEditableHoldVoice();
    const sequencer = getSequencerStateForVoice(selectedVoice);
    if (!sequencer) {
      return;
    }
    sequencer.rateMultiplier = nextMultiplier;
    updateVoiceSequenceLoopRate(selectedVoice);
    applyVoiceSequencerStep(selectedVoice);
    schedulePadDraw();
    return;
  }

  state.liveSequencer.rateMultiplier = nextMultiplier;
  for (const voice of targets) {
    const sequencer = getSequencerStateForVoice(voice);
    if (!sequencer) {
      continue;
    }
    sequencer.rateMultiplier = nextMultiplier;
    updateVoiceSequenceLoopRate(voice);
    applyVoiceSequencerStep(voice);
  }
  schedulePadDraw();
}

function setSequencePatternForTargets(patternIndex) {
  const nextPatternIndex = clamp(patternIndex, 0, SEQUENCE_PATTERN_COUNT - 1);
  const targets = getEffectTargetVoices();

  if (state.interactionMode === "edit") {
    const selectedVoice = getEditableHoldVoice();
    const sequencer = getSequencerStateForVoice(selectedVoice);
    if (!sequencer) {
      return;
    }
    sequencer.activePatternIndex = nextPatternIndex;
    sequencer.patterns[nextPatternIndex].unlocked = true;
    applyVoiceSequencerStep(selectedVoice);
    schedulePadDraw();
    return;
  }

  state.liveSequencer.activePatternIndex = nextPatternIndex;
  state.liveSequencer.patterns[nextPatternIndex].unlocked = true;
  for (const voice of targets) {
    const sequencer = getSequencerStateForVoice(voice);
    if (!sequencer) {
      continue;
    }
    sequencer.activePatternIndex = nextPatternIndex;
    sequencer.patterns[nextPatternIndex].unlocked = true;
    applyVoiceSequencerStep(voice);
  }
  schedulePadDraw();
}

function adjustSequenceLengthForTargets(delta) {
  const targets = getEffectTargetVoices();

  if (state.interactionMode === "edit") {
    const selectedVoice = getEditableHoldVoice();
    const pattern = getActiveSequencePattern(getSequencerStateForVoice(selectedVoice));
    if (!pattern) {
      return;
    }
    pattern.length = clamp(pattern.length + delta, 1, SEQUENCE_MAX_STEPS);
    applyVoiceSequencerStep(selectedVoice);
    schedulePadDraw();
    return;
  }

  const livePattern = getActiveSequencePattern(state.liveSequencer);
  if (!livePattern) {
    return;
  }
  livePattern.length = clamp(livePattern.length + delta, 1, SEQUENCE_MAX_STEPS);
  for (const voice of targets) {
    if (!getActiveSequencePattern(getSequencerStateForVoice(voice))) {
      continue;
    }
    applyVoiceSequencerStep(voice);
  }
  schedulePadDraw();
}

function stopVoiceCollection(collection, key) {
  const voice = collection.get(key);
  if (!voice) {
    return;
  }

  const now = Tone.now();
  if (voice.modGain) {
    voice.modGain.gain.setValueAtTime(0, now);
  }
  if (voice.delayNode) {
    voice.delayNode.feedback.setValueAtTime(0, now);
    voice.delayNode.wet.setValueAtTime(0, now);
  }
  if (voice.distortionNode?.wet) {
    voice.distortionNode.wet.setValueAtTime(0, now);
  }
  if (voice.sequenceGateGain?.gain) {
    voice.sequenceGateGain.gain.setValueAtTime(0, now);
  }
  if (voice.sequenceLoop) {
    voice.sequenceLoop.stop(now);
  }
  voice.gain.gain.cancelAndHoldAtTime(now);
  voice.gain.gain.linearRampTo(0.0001, 0.05, now);
  voice.source.loop = false;
  voice.source.stop(now + 0.06);
  collection.delete(key);
  if (collection === state.holdVoices && state.selectedHoldId === key) {
    state.selectedHoldId = null;
  }
  if (collection === state.holdVoices && state.lastInteractedHoldId === key) {
    setLastInteractedHoldId(null);
  }
  schedulePadDraw();
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
  if (state.soloVoice.modGain) {
    state.soloVoice.modGain.gain.setValueAtTime(0, now);
  }
  if (state.soloVoice.delayNode) {
    state.soloVoice.delayNode.feedback.setValueAtTime(0, now);
    state.soloVoice.delayNode.wet.setValueAtTime(0, now);
  }
  if (state.soloVoice.distortionNode?.wet) {
    state.soloVoice.distortionNode.wet.setValueAtTime(0, now);
  }
  if (state.soloVoice.sequenceGateGain?.gain) {
    state.soloVoice.sequenceGateGain.gain.setValueAtTime(0, now);
  }
  if (state.soloVoice.sequenceLoop) {
    state.soloVoice.sequenceLoop.stop(now);
  }
  state.soloVoice.gain.gain.cancelAndHoldAtTime(now);
  state.soloVoice.gain.gain.linearRampTo(0.0001, 0.05, now);
  state.soloVoice.source.loop = false;
  state.soloVoice.source.stop(now + 0.06);
  state.soloVoice = null;
  schedulePadDraw();
}

function createVoice(pointerPosition, options = {}) {
  if (!isPointerInPlayableArea(pointerPosition)) {
    return null;
  }

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
  const modGain = new Tone.Gain(0);
  const modOsc = new Tone.Oscillator({
    type: "sine",
    frequency: getVoiceMetalFrequency(grid.pitchRatio, state.liveMetalAmount),
  });
  const distortionNode = new Tone.Distortion(0);
  const delayNode = new Tone.FeedbackDelay({
    delayTime: 0.08,
    feedback: 0.12,
    wet: 0,
  });
  const sequenceGateGain = new Tone.Gain(1);
  const gain = new Tone.Gain(0.0001);
  modOsc.connect(modGain);
  modGain.connect(source.playbackRate);
  source.connect(distortionNode);
  distortionNode.connect(delayNode);
  delayNode.connect(sequenceGateGain);
  sequenceGateGain.connect(gain);
  gain.connect(state.masterInput);
  const sequencer = cloneSequencerState(state.liveSequencer);
  const sequenceLoop = new Tone.Loop((time) => {
    if (source.state === "stopped") {
      return;
    }
    applyVoiceSequencerStep(voice, time);
  }, BASE_SEQUENCE_INTERVAL);
  source.onended = () => {
    modOsc.dispose();
    modGain.dispose();
    distortionNode.dispose();
    delayNode.dispose();
    sequenceGateGain.dispose();
    sequenceLoop.dispose();
    source.dispose();
    gain.dispose();
  };

  modOsc.start();
  gain.gain.linearRampTo(0.9, 0.01);
  source.start(Tone.now(), offset);

  const voice = {
    id: options.id ?? null,
    isHeld: Boolean(options.isHeld),
    sample,
    source,
    gain,
    distortionNode,
    delayNode,
    sequenceGateGain,
    sequenceLoop,
    modOsc,
    modGain,
    pointerPosition,
    basePlaybackRate: grid.pitchRatio,
    metalAmount: state.liveMetalAmount,
    delayTimeAmount: state.liveDelayTimeAmount,
    delayFeedbackAmount: state.liveDelayFeedbackAmount,
    delayMixAmount: state.liveDelayMixAmount,
    distortionAmount: state.liveDistortionAmount,
    sequencer,
  };
  applyVoiceMetal(voice);
  applyVoiceDelay(voice);
  applyVoiceDistortion(voice);
  updateVoiceSequenceLoopRate(voice);
  applyVoiceSequencerStep(voice);
  sequenceLoop.start(0);

  return voice;
}

function storeTransientVoice(pointerId, pointerPosition) {
  const voice = createVoice(pointerPosition, { isHeld: false });
  if (!voice) {
    return;
  }
  state.transientVoices.set(pointerId, voice);
  schedulePadDraw();
}

function startSoloVoice(pointerPosition) {
  const voice = createVoice(pointerPosition, { isHeld: false });
  if (!voice) {
    return;
  }
  state.soloVoice = voice;
  schedulePadDraw();
}

function createHoldVoice(pointerPosition) {
  const holdId = getNextHoldId();
  const voice = createVoice(pointerPosition, { id: holdId, isHeld: true });
  if (!voice) {
    return null;
  }
  state.holdVoices.set(holdId, voice);
  setLastInteractedHoldId(holdId);
  schedulePadDraw();
  return holdId;
}

function updateVoicePitch(voice, pointerPosition) {
  if (!voice) {
    return;
  }

  if (pointerPosition.y > getPlayableTop() + getPlayableHeight(pointerPosition.height)) {
    return;
  }
  if (pointerPosition.y < getPlayableTop()) {
    return;
  }

  const grid = getGridPosition(pointerPosition);
  voice.pointerPosition = pointerPosition;
  voice.basePlaybackRate = grid.pitchRatio;
  voice.source.playbackRate.cancelAndHoldAtTime(Tone.now());
  voice.source.playbackRate.setValueAtTime(grid.pitchRatio, Tone.now());
  applyVoiceMetal(voice);
  schedulePadDraw();
}

function promoteVoiceToHold(voice) {
  if (!voice) {
    return null;
  }

  const holdId = getNextHoldId();
  voice.id = holdId;
  voice.isHeld = true;
  state.holdVoices.set(holdId, voice);
  setLastInteractedHoldId(holdId);
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
    schedulePadDraw();
  }
}

function toggleEditHeldMode() {
  if (state.interactionMode === "play") {
    state.interactionMode = "edit";
    if (state.lastInteractedHoldId !== null && state.holdVoices.has(state.lastInteractedHoldId)) {
      state.selectedHoldId = state.lastInteractedHoldId;
    } else {
      state.selectedHoldId = null;
    }
  } else {
    state.interactionMode = "play";
    state.selectedHoldId = null;
  }
  schedulePadDraw();
}

function selectHeldVoice(holdId) {
  state.selectedHoldId = holdId;
  setLastInteractedHoldId(holdId);
  schedulePadDraw();
}

function renderStaticPadBackground() {
  const bounds = canvas.getBoundingClientRect();
  const { rows, cols } = getGridConfig();
  const width = Math.max(1, Math.round(bounds.width));
  const height = Math.max(1, Math.round(bounds.height));
  const playableHeight = getPlayableHeight(height);
  const playableTop = getPlayableTop();
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
      backgroundCtx.strokeRect(col * colWidth, playableTop + row * rowHeight, colWidth, rowHeight);
    }
  }

  backgroundCtx.lineWidth = 1;
  backgroundCtx.strokeStyle = "#000";
  backgroundCtx.beginPath();
  for (let row = 0; row < rows; row += 1) {
    const y = playableTop + row * rowHeight + rowHeight / 2;
    if (row === 0) {
      backgroundCtx.moveTo(0, y);
    } else {
      backgroundCtx.lineTo(0, y);
    }
    backgroundCtx.lineTo(width, y);
  }
  backgroundCtx.stroke();

  backgroundCtx.fillStyle = "#f1f1f1";
  backgroundCtx.fillRect(0, 0, width, playableTop);
  backgroundCtx.fillRect(0, playableTop + playableHeight, width, height - playableTop - playableHeight);
  backgroundCtx.strokeStyle = "#000";
  backgroundCtx.strokeRect(0, 0, width, playableTop);
  backgroundCtx.strokeRect(0, playableTop + playableHeight, width, height - playableTop - playableHeight);

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

async function handlePadDown(pointerId, position, options = {}) {
  const { capturePointer = false } = options;
  const controlAction = getControlActionAtPosition(position);

  if (controlAction) {
    if (controlAction.action === "mode") {
      cycleMode();
    } else if (controlAction.action === "hold") {
      holdCurrentVoices();
    } else if (controlAction.action === "edit-held") {
      toggleEditHeldMode();
    } else if (controlAction.action === "global") {
      state.topEffectView = "global";
      schedulePadDraw();
    } else if (controlAction.action === "metal") {
      state.controlDragByPointer.set(pointerId, "metal");
      const amount = clamp(
        (position.x - controlAction.x) / Math.max(1, controlAction.width),
        0,
        1,
      );
      setMetalAmountForTargets(amount);
    } else if (controlAction.action === "delay") {
      state.topEffectView = "delay";
      schedulePadDraw();
    } else if (controlAction.action === "delay-back") {
      state.topEffectView = "main";
      schedulePadDraw();
    } else if (controlAction.action === "global-back") {
      state.topEffectView = "main";
      schedulePadDraw();
    } else if (controlAction.action === "global-pitch") {
      state.controlDragByPointer.set(pointerId, "global-pitch");
      const amount = clamp(
        (position.x - controlAction.x) / Math.max(1, controlAction.width),
        0,
        1,
      );
      setGlobalPitchAmount(amount);
    } else if (controlAction.action === "global-delay") {
      state.topEffectView = "global-delay";
      schedulePadDraw();
    } else if (controlAction.action === "global-distortion") {
      state.controlDragByPointer.set(pointerId, "global-distortion");
      const amount = clamp(
        (position.x - controlAction.x) / Math.max(1, controlAction.width),
        0,
        1,
      );
      setGlobalDistortionAmount(amount);
    } else if (controlAction.action === "global-delay-back") {
      state.topEffectView = "global";
      schedulePadDraw();
    } else if (controlAction.action === "global-delay-time") {
      state.controlDragByPointer.set(pointerId, "global-delay-time");
      const amount = clamp(
        (position.x - controlAction.x) / Math.max(1, controlAction.width),
        0,
        1,
      );
      setGlobalDelayTimeAmount(amount);
    } else if (controlAction.action === "global-delay-feedback") {
      state.controlDragByPointer.set(pointerId, "global-delay-feedback");
      const amount = clamp(
        (position.x - controlAction.x) / Math.max(1, controlAction.width),
        0,
        1,
      );
      setGlobalDelayFeedbackAmount(amount);
    } else if (controlAction.action === "global-delay-mix") {
      state.controlDragByPointer.set(pointerId, "global-delay-mix");
      const amount = clamp(
        (position.x - controlAction.x) / Math.max(1, controlAction.width),
        0,
        1,
      );
      setGlobalDelayMixAmount(amount);
    } else if (controlAction.action === "delay-time") {
      state.controlDragByPointer.set(pointerId, "delay-time");
      const amount = clamp(
        (position.x - controlAction.x) / Math.max(1, controlAction.width),
        0,
        1,
      );
      setDelayTimeAmountForTargets(amount);
    } else if (controlAction.action === "delay-feedback") {
      state.controlDragByPointer.set(pointerId, "delay-feedback");
      const amount = clamp(
        (position.x - controlAction.x) / Math.max(1, controlAction.width),
        0,
        1,
      );
      setDelayFeedbackAmountForTargets(amount);
    } else if (controlAction.action === "delay-mix") {
      state.controlDragByPointer.set(pointerId, "delay-mix");
      const amount = clamp(
        (position.x - controlAction.x) / Math.max(1, controlAction.width),
        0,
        1,
      );
      setDelayMixAmountForTargets(amount);
    } else if (controlAction.action === "distortion") {
      state.controlDragByPointer.set(pointerId, "distortion");
      const amount = clamp(
        (position.x - controlAction.x) / Math.max(1, controlAction.width),
        0,
        1,
      );
      setDistortionAmountForTargets(amount);
    } else if (controlAction.action === "sequencer") {
      state.topEffectView = "sequencer";
      schedulePadDraw();
    } else if (controlAction.action === "sequencer-back") {
      state.topEffectView = "main";
      schedulePadDraw();
    } else if (controlAction.action === "sequencer-pattern") {
      setSequencePatternForTargets(controlAction.patternIndex);
    } else if (controlAction.action === "sequencer-length-dec") {
      adjustSequenceLengthForTargets(-1);
    } else if (controlAction.action === "sequencer-length-inc") {
      adjustSequenceLengthForTargets(1);
    } else if (controlAction.action === "sequencer-rate") {
      setSequenceRateMultiplierForTargets(controlAction.multiplier);
    } else if (controlAction.action === "sequencer-step") {
      const currentPattern = getDisplayedSequencePattern();
      setSequenceStepEnabled(controlAction.stepIndex, !currentPattern[controlAction.stepIndex]);
    }
    return;
  }

  if (!isPointerInPlayableArea(position)) {
    return;
  }

  if (state.interactionMode === "edit") {
    const holdId = findHoldVoiceAtPosition(position);
    if (holdId !== null) {
      selectHeldVoice(holdId);
    }
    return;
  }

  await ensureAudio();

  if (!state.samples.length) {
    setAudioStatus("Load samples first");
    schedulePadDraw();
    return;
  }

  if (capturePointer) {
    canvas.setPointerCapture(pointerId);
  }

  if (state.mode === "solo") {
    state.soloPointers.set(pointerId, {
      position,
      startedAt: performance.now(),
    });
    state.soloLeadPointerId = pointerId;

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
      setLastInteractedHoldId(existingHoldId);
      state.holdDragByPointer.set(pointerId, existingHoldId);
      state.holdGestureByPointer.set(pointerId, {
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
    state.holdGestureByPointer.delete(pointerId);
    const holdId = createHoldVoice(position);
    if (holdId !== null) {
      state.holdDragByPointer.set(pointerId, holdId);
      const voice = state.holdVoices.get(holdId);
      if (voice) {
        updateVoicePitch(voice, position);
      }
    }
    return;
  }

  storeTransientVoice(pointerId, position);
}

function handlePadMove(pointerId, position) {
  const draggedControl = state.controlDragByPointer.get(pointerId);
  if (draggedControl) {
    const topControl = getTopControlRegions(position.width)
      .find((control) => control.action === draggedControl);
    if (topControl) {
      const amount = clamp(
        (position.x - topControl.x) / Math.max(1, topControl.width),
        0,
        1,
      );
      if (draggedControl === "metal") {
        setMetalAmountForTargets(amount);
      } else if (draggedControl === "global-pitch") {
        setGlobalPitchAmount(amount);
      } else if (draggedControl === "global-distortion") {
        setGlobalDistortionAmount(amount);
      } else if (draggedControl === "global-delay-time") {
        setGlobalDelayTimeAmount(amount);
      } else if (draggedControl === "global-delay-feedback") {
        setGlobalDelayFeedbackAmount(amount);
      } else if (draggedControl === "global-delay-mix") {
        setGlobalDelayMixAmount(amount);
      } else if (draggedControl === "delay-time") {
        setDelayTimeAmountForTargets(amount);
      } else if (draggedControl === "delay-feedback") {
        setDelayFeedbackAmountForTargets(amount);
      } else if (draggedControl === "delay-mix") {
        setDelayMixAmountForTargets(amount);
      } else if (draggedControl === "distortion") {
        setDistortionAmountForTargets(amount);
      }
    }
    return;
  }

  if (state.mode === "solo") {
    const pointerState = state.soloPointers.get(pointerId);
    if (!pointerState) {
      return;
    }
    pointerState.position = position;
    if (state.soloLeadPointerId === pointerId && state.soloVoice) {
      updateVoicePitch(state.soloVoice, position);
    }
    return;
  }

  if (state.mode === "hold") {
    const gesture = state.holdGestureByPointer.get(pointerId);
    if (gesture) {
      gesture.lastPosition = position;
      if (!gesture.moved && getPointerDistance(gesture.startPosition, position) > 12) {
        gesture.moved = true;
      }
    }
    const holdId = state.holdDragByPointer.get(pointerId);
    if (holdId === undefined) {
      return;
    }
    const voice = state.holdVoices.get(holdId);
    if (voice) {
      updateVoicePitch(voice, position);
    }
    return;
  }

  const voice = state.transientVoices.get(pointerId);
  if (!voice) {
    return;
  }
  updateVoicePitch(voice, position);
}

function handlePadUp(pointerId, buttons = 0) {
  state.controlDragByPointer?.delete(pointerId);

  if (state.mode === "solo") {
    state.soloPointers.delete(pointerId);

    if (!state.soloPointers.size) {
      state.soloLeadPointerId = null;
      stopSoloVoice();
      return;
    }

    if (state.soloLeadPointerId === pointerId) {
      state.soloLeadPointerId = getLastSoloPointerId(pointerId);
      const pointerState = state.soloPointers.get(state.soloLeadPointerId);
      if (pointerState && state.soloVoice) {
        updateVoicePitch(state.soloVoice, pointerState.position);
      }
    }
    return;
  }

  if (state.mode === "hold") {
    const gesture = state.holdGestureByPointer.get(pointerId);
    state.holdDragByPointer.delete(pointerId);
    state.holdGestureByPointer.delete(pointerId);

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

  if (buttons === 0) {
    stopTransientVoice(pointerId);
  }
}

function handlePadCancel(pointerId) {
  state.controlDragByPointer?.delete(pointerId);

  if (state.mode === "solo") {
    state.soloPointers.delete(pointerId);

    if (!state.soloPointers.size) {
      state.soloLeadPointerId = null;
      stopSoloVoice();
      return;
    }

    if (state.soloLeadPointerId === pointerId) {
      state.soloLeadPointerId = getLastSoloPointerId(pointerId);
      const pointerState = state.soloPointers.get(state.soloLeadPointerId);
      if (pointerState && state.soloVoice) {
        updateVoicePitch(state.soloVoice, pointerState.position);
      }
    }
    return;
  }

  if (state.mode === "hold") {
    state.holdDragByPointer.delete(pointerId);
    state.holdGestureByPointer.delete(pointerId);
    return;
  }

  stopTransientVoice(pointerId);
}

function handlePadLeave(pointerId, buttons = 0) {
  if (state.controlDragByPointer?.has(pointerId)) {
    if (buttons === 0) {
      state.controlDragByPointer.delete(pointerId);
    }
    return;
  }

  if (state.mode === "solo") {
    if (buttons === 0) {
      handlePadCancel(pointerId);
    }
    return;
  }

  if (state.mode === "hold") {
    if (buttons === 0) {
      state.holdDragByPointer.delete(pointerId);
      state.holdGestureByPointer.delete(pointerId);
    }
    return;
  }

  if (buttons === 0) {
    stopTransientVoice(pointerId);
  }
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

  const topControlRegions = getTopControlRegions(width);
  const bottomControlRegions = getBottomControlRegions(width, height);
  ctx.font = '16px "Times New Roman", Times, serif';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const control of [...topControlRegions, ...bottomControlRegions]) {
    const isActiveEdit = control.action === "edit-held" && state.interactionMode === "edit";
    const isSequenceStep = control.action === "sequencer-step";
    const isSequenceRate = control.action === "sequencer-rate";
    const isSequencePattern = control.action === "sequencer-pattern";
    const isSequenceLengthDisplay = control.action === "sequencer-length-display";
    const sequencePattern = isSequenceStep ? getDisplayedSequencePattern() : null;
    const sequenceLength = isSequenceStep ? getDisplayedSequenceLength() : 0;
    const isStepOn = isSequenceStep ? sequencePattern[control.stepIndex] !== false : false;
    const isStepInRange = isSequenceStep ? control.stepIndex < sequenceLength : false;
    const isActiveSequenceRate = isSequenceRate
      && control.multiplier === getDisplayedSequenceRateMultiplier();
    const isActiveSequencePattern = isSequencePattern
      && control.patternIndex === getDisplayedSequencePatternIndex();
    const isUnlockedSequencePattern = isSequencePattern
      && isDisplayedSequencePatternUnlocked(control.patternIndex);
    ctx.fillStyle = isSequenceStep
      ? (isStepInRange ? (isStepOn ? "#000" : "#fff") : "#dcdcdc")
      : (
        isSequencePattern
          ? (isActiveSequencePattern ? "#ddd" : (isUnlockedSequencePattern ? "#fff" : "#f1f1f1"))
          : ((isActiveEdit || isActiveSequenceRate || isSequenceLengthDisplay) ? "#ddd" : "#fff")
      );
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 1;
    ctx.fillRect(control.x, control.y, control.width, control.height);
    ctx.strokeRect(control.x, control.y, control.width, control.height);

    if (
      control.action === "metal"
      || control.action === "global-pitch"
      || control.action === "global-distortion"
      || control.action === "global-delay-time"
      || control.action === "global-delay-feedback"
      || control.action === "global-delay-mix"
      || control.action === "distortion"
      || control.action === "delay-time"
      || control.action === "delay-feedback"
      || control.action === "delay-mix"
    ) {
      let amount = 0;
      if (control.action === "metal") {
        amount = getDisplayedMetalAmount();
      } else if (control.action === "global-pitch") {
        amount = getDisplayedGlobalPitchAmount();
      } else if (control.action === "global-distortion") {
        amount = getDisplayedGlobalDistortionAmount();
      } else if (control.action === "global-delay-time") {
        amount = getDisplayedGlobalDelayTimeAmount();
      } else if (control.action === "global-delay-feedback") {
        amount = getDisplayedGlobalDelayFeedbackAmount();
      } else if (control.action === "global-delay-mix") {
        amount = getDisplayedGlobalDelayMixAmount();
      } else if (control.action === "delay-time") {
        amount = getDisplayedDelayTimeAmount();
      } else if (control.action === "delay-feedback") {
        amount = getDisplayedDelayFeedbackAmount();
      } else if (control.action === "delay-mix") {
        amount = getDisplayedDelayMixAmount();
      } else if (control.action === "distortion") {
        amount = getDisplayedDistortionAmount();
      }
      ctx.fillStyle = "#000";
      ctx.fillRect(control.x + 4, control.y + control.height - 10, (control.width - 8) * amount, 6);
      ctx.fillStyle = "#fff";
      ctx.fillRect(
        control.x + 4 + (control.width - 8) * amount,
        control.y + control.height - 10,
        Math.max(0, control.width - 8 - (control.width - 8) * amount),
        6,
      );
      ctx.strokeStyle = "#000";
      ctx.strokeRect(control.x + 4, control.y + control.height - 10, control.width - 8, 6);
    }

    if (control.action === "delay") {
      const miniBarY = control.y + control.height - 10;
      const miniBarHeight = 4;
      const miniGap = 6;
      const miniWidth = (control.width - 8 - miniGap * 2) / 3;
      const miniX = control.x + 4;
      const delayValues = [
        getDisplayedDelayTimeAmount(),
        getDisplayedDelayFeedbackAmount(),
        getDisplayedDelayMixAmount(),
      ];

      delayValues.forEach((value, index) => {
        const x = miniX + index * (miniWidth + miniGap);
        ctx.fillStyle = "#000";
        ctx.fillRect(x, miniBarY, miniWidth * value, miniBarHeight);
        ctx.fillStyle = "#fff";
        ctx.fillRect(
          x + miniWidth * value,
          miniBarY,
          Math.max(0, miniWidth - miniWidth * value),
          miniBarHeight,
        );
        ctx.strokeStyle = "#000";
        ctx.strokeRect(x, miniBarY, miniWidth, miniBarHeight);
      });
    }

    if (control.action === "global-delay") {
      const miniBarY = control.y + control.height - 10;
      const miniBarHeight = 4;
      const miniGap = 6;
      const miniWidth = (control.width - 8 - miniGap * 2) / 3;
      const miniX = control.x + 4;
      const delayValues = [
        getDisplayedGlobalDelayTimeAmount(),
        getDisplayedGlobalDelayFeedbackAmount(),
        getDisplayedGlobalDelayMixAmount(),
      ];

      delayValues.forEach((value, index) => {
        const x = miniX + index * (miniWidth + miniGap);
        ctx.fillStyle = "#000";
        ctx.fillRect(x, miniBarY, miniWidth * value, miniBarHeight);
        ctx.fillStyle = "#fff";
        ctx.fillRect(
          x + miniWidth * value,
          miniBarY,
          Math.max(0, miniWidth - miniWidth * value),
          miniBarHeight,
        );
        ctx.strokeStyle = "#000";
        ctx.strokeRect(x, miniBarY, miniWidth, miniBarHeight);
      });
    }

    ctx.fillStyle = isSequenceStep && isStepInRange && isStepOn ? "#fff" : "#000";
    const label = isSequencePattern && !isUnlockedSequencePattern ? `${control.label}+` : control.label;
    ctx.fillText(label, control.x + control.width / 2, control.y + control.height / 2);
  }

  for (const voice of state.holdVoices.values()) {
    const { x, y } = voice.pointerPosition;
    const isSelected = voice.id === state.selectedHoldId;
    ctx.strokeStyle = isSelected ? "#c00" : "#000";
    ctx.lineWidth = isSelected ? 3 : 1;
    ctx.beginPath();
    ctx.arc(x, y, isSelected ? 14 : 12, 0, Math.PI * 2);
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
  if (event.pointerType === "touch") {
    return;
  }
  event.preventDefault();
  await handlePadDown(event.pointerId, getPointerPosition(event), { capturePointer: true });
});

canvas.addEventListener("pointermove", (event) => {
  if (event.pointerType === "touch") {
    return;
  }
  event.preventDefault();
  handlePadMove(event.pointerId, getPointerPosition(event));
});

canvas.addEventListener("pointerup", (event) => {
  if (event.pointerType === "touch") {
    return;
  }
  handlePadUp(event.pointerId);
});

canvas.addEventListener("pointercancel", (event) => {
  if (event.pointerType === "touch") {
    return;
  }
  handlePadCancel(event.pointerId);
});

canvas.addEventListener("pointerleave", (event) => {
  if (event.pointerType === "touch") {
    return;
  }
  handlePadLeave(event.pointerId, event.buttons);
});

canvas.addEventListener("touchstart", (event) => {
  event.preventDefault();
  for (const touch of event.changedTouches) {
    void handlePadDown(`touch-${touch.identifier}`, getPointerPosition(touch));
  }
}, { passive: false });

canvas.addEventListener("touchmove", (event) => {
  event.preventDefault();
  for (const touch of event.changedTouches) {
    handlePadMove(`touch-${touch.identifier}`, getPointerPosition(touch));
  }
}, { passive: false });

canvas.addEventListener("touchend", (event) => {
  event.preventDefault();
  for (const touch of event.changedTouches) {
    handlePadUp(`touch-${touch.identifier}`, 0);
  }
}, { passive: false });

canvas.addEventListener("touchcancel", (event) => {
  event.preventDefault();
  for (const touch of event.changedTouches) {
    handlePadCancel(`touch-${touch.identifier}`);
  }
}, { passive: false });

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
  state.interactionMode = "play";
  state.selectedHoldId = null;
  state.topEffectView = "main";
  stopSoloVoice();
  state.padBackgroundCanvas = null;
  updateOutputLabels();
  schedulePadDraw();
}

updateOutputLabels();
renderSampleBank();
resizeCanvas();
