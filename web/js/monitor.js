// Live monitor page: source selection, live trace, server-side recording.
import { EcgServer, LiveStream, serverQuery } from './live-client.js';
import { bindSpeedControl, drawTrace, formatDuration, pixelsPerSecond } from './trace.js';

const SYNTHETIC_ID = 'synthetic-01';
const BUFFER_SECONDS = 30;      // history kept for drawing (more than one screen at 25 mm/s)
const PLAYOUT_DELAY_S = 0.25;   // packets arrive in ~100 ms bursts; draw slightly behind for smooth motion
const SIGNAL_TIMEOUT_MS = 2000;

const server = new EcgServer();
const stream = new LiveStream(server);
const $ = (selector) => document.querySelector(selector);

const ui = {
  connectionDot: $('#connection-dot'),
  connectionStatus: $('#connection-status'),
  qualityValue: $('#quality-value'),
  qualityDetail: $('#quality-detail'),
  liveBadge: $('#live-badge'),
  liveStatus: $('#live-status'),
  livePaper: $('#live-paper'),
  trace: $('#live-paper .ecg-trace'),
  emptyState: $('#live-paper .empty-state'),
  sourceSelect: $('#source-select'),
  rhythmSelect: $('#rhythm-select'),
  syntheticToggle: $('#synthetic-toggle'),
  duration: $('#duration'),
  presets: document.querySelectorAll('[data-duration]'),
  recordButton: $('#record-button'),
  recordLabel: $('#record-button .record-label'),
  recordingProgress: $('.recording-progress progress'),
  recordingStatus: $('.recording-progress div span:last-child'),
  captureNote: $('#capture-note'),
  reviewBadge: $('#review-badge'),
  reviewSummary: $('#review-summary'),
  reviewLink: $('#review-link'),
  downloadLink: $('#download-link'),
  clearRecording: $('#clear-recording'),
};
const traceContext = ui.trace.getContext('2d');

// ------------------------------------------------------------------ state
const state = {
  socket: 'connecting',     // WebSocket state
  devices: new Map(),       // device_id → stats from /api/v1/devices
  selected: '',             // device_id being displayed
  autoSelect: true,         // pick the first source that shows up until the user chooses
  recording: null,          // { id, deviceId, durationS, fs } while the server records
};

// Ring buffer of mV values addressed by absolute sample index.
const live = { fs: 0, buffer: new Float32Array(0), written: 0, shown: 0, lastSeq: null, lastPacketAt: 0, leadOff: false };

function resetLive(fs = 0) {
  live.fs = fs;
  live.buffer = new Float32Array(Math.max(1, Math.round(fs * BUFFER_SECONDS))).fill(NaN);
  live.written = 0;
  live.shown = 0;
  live.lastSeq = null;
  live.lastPacketAt = 0;
  live.leadOff = false;
}

function push(values) {
  const { buffer } = live;
  for (const v of values) buffer[live.written++ % buffer.length] = v;
}

function amplitudeAt(i) {
  if (i < 0 || i >= live.written || i < live.written - live.buffer.length) return NaN;
  return live.buffer[i % live.buffer.length];
}

// ------------------------------------------------------------------ live data
stream.addEventListener('status', ({ detail }) => {
  state.socket = detail.state;
  renderStatus();
});

stream.addEventListener('packet', ({ detail: p }) => {
  if (state.autoSelect && !state.selected) selectSource(p.deviceId, { auto: true });
  if (p.deviceId !== state.selected) return;

  if (p.fs !== live.fs) resetLive(p.fs);
  if (live.lastSeq !== null && p.seq > live.lastSeq + 1) {
    // Lost packets: leave a visible gap of the right length instead of joining the line.
    const missing = Math.min((p.seq - live.lastSeq - 1) * p.values.length, live.buffer.length);
    push(new Float32Array(missing).fill(NaN));
  } else if (live.lastSeq !== null && p.seq <= live.lastSeq) {
    resetLive(p.fs);        // device restarted, seq began again
  }
  live.lastSeq = p.seq;
  live.lastPacketAt = performance.now();
  live.leadOff = p.leadOff;
  push(p.values);
});

function receiving() {
  return state.selected && performance.now() - live.lastPacketAt < SIGNAL_TIMEOUT_MS;
}

// ------------------------------------------------------------------ drawing
let lastFrame = null;
function frame(now) {
  const dt = lastFrame === null ? 0 : (now - lastFrame) / 1000;
  lastFrame = now;
  if (live.fs && live.written) {
    // Advance the display cursor in real time and nudge it toward "latest minus delay".
    const target = live.written - PLAYOUT_DELAY_S * live.fs;
    live.shown += dt * live.fs;
    if (Math.abs(target - live.shown) > 0.5 * live.fs) live.shown = target;
    else live.shown += (target - live.shown) * 0.05;
    live.shown = Math.min(live.shown, live.written);

    const pxPerS = pixelsPerSecond(ui.livePaper);
    const width = ui.trace.getBoundingClientRect().width;
    const endIndex = Math.floor(live.shown);
    drawTrace(ui.trace, traceContext, {
      startS: endIndex / live.fs - width / pxPerS, endIndex, fs: live.fs, amplitudeAt, pxPerS,
    });
  }
  renderStatus();
  requestAnimationFrame(frame);
}

document.querySelectorAll('.speed-control').forEach((control) => bindSpeedControl(control));

// ------------------------------------------------------------------ status display
let lastStatusKey = '';
function renderStatus() {
  const device = state.devices.get(state.selected);
  const flowing = receiving();
  const key = [state.socket, state.selected, flowing, live.leadOff, device?.lost_packets, live.fs,
    state.devices.size, state.recording?.id].join('|');
  if (key === lastStatusKey) return;
  lastStatusKey = key;

  const setDot = (cls) => { ui.connectionDot.className = `status-dot ${cls}`; };
  if (state.socket !== 'open') {
    setDot('offline');
    ui.connectionStatus.textContent = state.socket === 'connecting' ? 'Connecting to server…' : 'Server offline · retrying';
  } else if (!state.selected) {
    setDot('warning');
    ui.connectionStatus.textContent = state.devices.size ? 'Server connected · no source selected' : 'Server connected · no source active';
  } else if (!flowing) {
    setDot('warning');
    ui.connectionStatus.textContent = `${state.selected} · waiting for data`;
  } else {
    setDot('online');
    ui.connectionStatus.textContent = `${state.selected} · live`;
  }

  ui.emptyState.hidden = Boolean(flowing || live.written);
  ui.liveBadge.textContent = !state.selected ? 'STANDBY'
    : !flowing ? 'NO DATA' : (device?.source === 'synthetic' ? 'SYNTHETIC' : 'LIVE');
  ui.liveStatus.textContent = !state.selected ? 'No source selected'
    : flowing ? `${state.selected} · ${live.fs} Hz` : `${state.selected} · waiting for data…`;
  ui.livePaper.setAttribute('aria-label', flowing
    ? `Live ECG waveform for Lead I from ${state.selected}.` : 'Empty ECG grid for Lead I.');

  if (!flowing) {
    ui.qualityValue.textContent = 'No signal';
    ui.qualityDetail.textContent = state.selected ? 'No packets in the last 2 s' : 'Select a source to begin';
  } else if (live.leadOff) {
    ui.qualityValue.textContent = 'Lead off';
    ui.qualityDetail.textContent = 'Check electrode contact';
  } else {
    const lost = device?.lost_packets ?? 0;
    const total = (device?.packets ?? 0) + lost;
    ui.qualityValue.textContent = lost ? 'Gaps' : 'Good';
    ui.qualityDetail.textContent = lost
      ? `${lost} lost packets (${(100 * lost / total).toFixed(1)} %)` : `${live.fs} Hz · no packet loss`;
  }
  updateRecordButton();
}

// ------------------------------------------------------------------ sources
function selectSource(deviceId, { auto = false } = {}) {
  state.autoSelect = auto;
  if (deviceId === state.selected) return;
  state.selected = deviceId;
  resetLive();
  renderSourceOptions();
  renderStatus();
}

function renderSourceOptions() {
  const ids = new Set(state.devices.keys());
  if (state.selected) ids.add(state.selected);
  const options = [new Option('No source', '')];
  for (const id of [...ids].sort()) {
    const d = state.devices.get(id);
    const label = d ? `${id} · ${d.source}${d.online ? '' : ' (offline)'}` : `${id} (waiting)`;
    options.push(new Option(label, id, false, id === state.selected));
  }
  ui.sourceSelect.replaceChildren(...options);
  ui.sourceSelect.value = state.selected;

  const syntheticRunning = state.devices.get(SYNTHETIC_ID)?.online;
  ui.syntheticToggle.textContent = syntheticRunning ? 'Stop synthetic' : 'Start synthetic';
}

ui.sourceSelect.addEventListener('change', () => {
  selectSource(ui.sourceSelect.value);
  state.autoSelect = !ui.sourceSelect.value;
});

async function refreshDevices() {
  try {
    const list = await server.devices();
    state.devices = new Map(list.map((d) => [d.device_id, d]));
  } catch {
    state.devices = new Map();
  }
  if (document.activeElement !== ui.sourceSelect) renderSourceOptions();
  renderStatus();
}

async function startSynthetic() {
  await server.startSynthetic({ device_id: SYNTHETIC_ID, rhythm: ui.rhythmSelect.value });
  selectSource(SYNTHETIC_ID);
}

ui.syntheticToggle.addEventListener('click', async () => {
  ui.syntheticToggle.disabled = true;
  try {
    if (state.devices.get(SYNTHETIC_ID)?.online) await server.stopSynthetic(SYNTHETIC_ID);
    else await startSynthetic();
  } catch (error) {
    // 409 = already running (e.g. started from another browser): just show it.
    if (String(error.message).startsWith('HTTP 409')) selectSource(SYNTHETIC_ID);
    else ui.liveStatus.textContent = `Synthetic source: ${error.message}`;
  } finally {
    ui.syntheticToggle.disabled = false;
    await refreshDevices();
  }
});

ui.rhythmSelect.addEventListener('change', async () => {
  if (!state.devices.get(SYNTHETIC_ID)?.online) return;
  try {
    await server.stopSynthetic(SYNTHETIC_ID);
    await startSynthetic();
  } catch (error) {
    ui.liveStatus.textContent = `Synthetic source: ${error.message}`;
  }
  await refreshDevices();
});

// ------------------------------------------------------------------ recording (stored on the server)
function updateDurationPresets() {
  ui.presets.forEach((button) => {
    const selected = ui.duration.value === button.dataset.duration;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
}

ui.presets.forEach((button) => button.addEventListener('click', () => {
  ui.duration.value = button.dataset.duration;
  updateDurationPresets();
  updateRecordButton();
}));
ui.duration.addEventListener('input', () => { updateDurationPresets(); updateRecordButton(); });

function updateRecordButton() {
  const recording = Boolean(state.recording);
  ui.recordButton.classList.toggle('recording', recording);
  ui.recordLabel.textContent = recording ? 'Stop recording' : 'Start recording';
  ui.recordButton.disabled = !recording && (!receiving() || !ui.duration.validity.valid || !ui.duration.value);
  if (!recording) {
    ui.captureNote.textContent = receiving()
      ? `Records ${state.selected} on the server.` : 'Select a live source to record. Recordings are saved on the server.';
  }
}

ui.recordButton.addEventListener('click', async () => {
  ui.recordButton.disabled = true;
  try {
    if (state.recording) {
      await server.stopRecording(state.recording.deviceId);
    } else {
      const durationS = Number(ui.duration.value);
      const { id } = await server.startRecording(state.selected, { durationS, label: 'ecg-studio' });
      state.recording = { id, deviceId: state.selected, durationS, fs: live.fs };
      ui.recordingProgress.value = 0;
      ui.recordingStatus.textContent = 'Recording…';
      ui.captureNote.textContent = `Recording ${state.selected} on the server · ${id}`;
      pollRecording();
    }
  } catch (error) {
    ui.recordingStatus.textContent = 'Failed';
    ui.captureNote.textContent = error.message;
  }
  updateRecordButton();
});

async function pollRecording() {
  const rec = state.recording;
  if (!rec) return;
  let meta;
  try {
    meta = await server.recording(rec.id);
  } catch (error) {
    ui.captureNote.textContent = error.message;
    setTimeout(pollRecording, 1000);
    return;
  }
  const expected = rec.durationS * (meta.fs || rec.fs || 1);
  ui.recordingProgress.value = Math.min(100, 100 * meta.sample_count / expected);
  if (meta.active) {
    setTimeout(pollRecording, 250);
    return;
  }
  state.recording = null;
  const complete = meta.sample_count >= Math.round(expected);
  ui.recordingProgress.value = complete ? 100 : ui.recordingProgress.value;
  ui.recordingStatus.textContent = !meta.sample_count ? 'No samples captured' : complete ? 'Complete' : 'Stopped early';
  showRecording(meta);
  updateRecordButton();
}

function showRecording(meta) {
  const query = serverQuery();
  const source = meta && state.devices.get(meta.device_id)?.source;
  ui.reviewBadge.textContent = meta ? (source === 'synthetic' ? 'SYNTHETIC' : 'SAVED') : 'NO SAMPLE';
  ui.reviewSummary.innerHTML = meta
    ? `Duration <strong>${formatDuration(meta.duration_s)}</strong><span class="footer-divider">/</span> Samples <strong>${meta.sample_count.toLocaleString()}</strong>`
    : 'Duration <strong>—</strong><span class="footer-divider">/</span> Samples <strong>—</strong>';
  ui.reviewLink.href = meta ? `review.html?id=${encodeURIComponent(meta.id)}${query ? `&${query}` : ''}`
    : `review.html${query ? `?${query}` : ''}`;
  ui.downloadLink.hidden = !meta;
  if (meta) ui.downloadLink.href = server.recordingCsvUrl(meta.id);
  ui.clearRecording.disabled = !meta;
}

ui.clearRecording.addEventListener('click', () => {
  showRecording(null);
  ui.recordingProgress.value = 0;
  ui.recordingStatus.textContent = 'Not started';
});

// ------------------------------------------------------------------ start
showRecording(null);
resetLive();
renderSourceOptions();
stream.connect();
refreshDevices();
setInterval(refreshDevices, 2000);
requestAnimationFrame(frame);
