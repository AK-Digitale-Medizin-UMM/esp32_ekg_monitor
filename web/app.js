// Synthetic playback and capture are independent of device acquisition.
const sampleRate = 256;
let latestCapture = null;
let reviewWindow = null;
document.querySelectorAll('.speed-control').forEach((control) => {
  control.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-speed]');
    if (!button) return;

    control.querySelectorAll('button').forEach((option) => {
      const selected = option === button;
      option.classList.toggle('selected', selected);
      option.setAttribute('aria-pressed', String(selected));
    });

    const paper = control.closest('.panel').querySelector('.ecg-paper');
    paper.dataset.paperSpeed = button.dataset.speed;
    paper.querySelector('.paper-scale').textContent = `${button.dataset.speed} mm/s · 10 mm/mV`;
    if (paper === livePaper) drawSyntheticTrace();
    if (paper === reviewPaper) resizeReview();
  });
});

const duration = document.querySelector('#duration');
const presets = document.querySelectorAll('[data-duration]');

function updateDurationPresets() {
  presets.forEach((button) => {
    const selected = duration.value === button.dataset.duration;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
}

presets.forEach((button) => {
  button.addEventListener('click', () => {
    duration.value = button.dataset.duration;
    updateDurationPresets();
    updateRecordButton();
  });
});

if (duration) duration.addEventListener('input', () => {
  updateDurationPresets();
  updateRecordButton();
});

const reviewLink = document.querySelector('.review-link');
if (reviewLink) {
  reviewLink.addEventListener('click', (event) => {
    // Keep the ordinary link as a fallback if the browser blocks the popup.
    const review = window.open(reviewLink.href, 'ecg-recording-review', 'popup,width=1400,height=800,scrollbars=yes,resizable=yes');
    if (review) {
      event.preventDefault();
      reviewWindow = review;
      review.focus();
    }
  });
}

const livePaper = document.querySelector('#live-paper');
const playSynthetic = document.querySelector('#play-synthetic');
const syntheticStatus = document.querySelector('#synthetic-status');
const trace = livePaper?.querySelector('.ecg-trace');
const traceContext = trace?.getContext('2d');
const loopSynthetic = document.querySelector('#loop-synthetic');
const recordButton = document.querySelector('.record-button');
const recordingProgress = document.querySelector('.recording-progress progress');
const recordingStatus = document.querySelector('.recording-progress div span:last-child');
const captureNote = document.querySelector('.capture-note');
const reviewSummary = document.querySelector('.review-panel .panel-footer > span');
const clearRecording = document.querySelector('.review-panel .text-button');
let samples = [];
let elapsedSamples = 0;
let startedAt = null;
let playing = false;
let playbackLimit = Infinity;
let capture = null;

function parseSyntheticRecording(text) {
  const rows = text.trim().split(/\r?\n/);
  if (rows.length < 2) throw new Error('The recording must contain at least two samples.');

  let firstTime;
  return rows.map((row, index) => {
    const fields = row.trim().split(/\s+/);
    const [time, amplitude] = fields.map(Number);
    firstTime ??= time;
    if (fields.length !== 3 || !Number.isFinite(time) || !Number.isFinite(amplitude)
      || time < 0 || Math.abs(time - firstTime - index / sampleRate) > 0.000001) {
      throw new Error(`Invalid ECG sample on line ${index + 1}.`);
    }
    return amplitude;
  });
}

function drawSyntheticTrace() {
  if (!traceContext || !samples.length || !elapsedSamples) return;
  const pixelsPerSecond = 8 * Number(livePaper.dataset.paperSpeed);
  const start = Math.max(0, elapsedSamples / sampleRate - trace.clientWidth / pixelsPerSecond);
  drawTrace(trace, traceContext, start, elapsedSamples, (i) => samples[i % samples.length], pixelsPerSecond);
}

function drawTrace(canvas, context, start, end, amplitudeAt, pixelsPerSecond) {
  const { width, height } = canvas.getBoundingClientRect();
  if (!width || !height) return;

  const scale = window.devicePixelRatio || 1;
  const pixelWidth = Math.round(width * scale);
  const pixelHeight = Math.round(height * scale);
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.clearRect(0, 0, width, height);

  // The existing paper grid uses 8 CSS pixels per small square (1 mm).
  const pixelsPerMillivolt = 8 * 10;
  const first = Math.floor(start * sampleRate);
  const last = Math.min(end, Math.ceil((start + width / pixelsPerSecond) * sampleRate) + 1);
  context.beginPath();
  for (let i = first; i < last; i++) {
    const x = (i / sampleRate - start) * pixelsPerSecond;
    const y = height / 2 - amplitudeAt(i) * pixelsPerMillivolt;
    if (i === first) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
  context.strokeStyle = '#174d43';
  context.lineWidth = 1.5;
  context.stroke();
}

function sourcePosition(now) {
  return startedAt === null ? 0 : Math.min(playbackLimit, Math.floor((now - startedAt) * sampleRate / 1000));
}

function updateRecordButton() {
  if (recordButton) recordButton.disabled = !playing || !!capture || !duration.validity.valid || !duration.value;
}

function sendCapture() {
  if (reviewWindow && !reviewWindow.closed) {
    reviewWindow.postMessage({ type: 'ecg-capture', capture: latestCapture }, location.origin);
  }
}

function updateCapture(ended) {
  if (!capture) return;
  const count = Math.max(0, Math.min(capture.count, elapsedSamples - capture.start));
  recordingProgress.value = 100 * count / capture.count;
  if (count < capture.count && !ended) return;
  const partial = count < capture.count;
  if (count) {
    latestCapture = {
      values: Float32Array.from({ length: count }, (_, i) => samples[(capture.start + i) % samples.length]),
      partial,
    };
    reviewSummary.textContent = `Duration ${formatDuration(count)} / Samples ${count.toLocaleString()}`;
    reviewSummary.closest('.panel').querySelector('.badge').textContent = 'SYNTHETIC';
    clearRecording.disabled = false;
    sendCapture();
  }
  recordingStatus.textContent = !count ? 'No samples captured' : partial ? 'Partial recording · Source ended' : 'Complete';
  capture = null;
  updateRecordButton();
}

function formatDuration(count) {
  return `${(count / sampleRate).toFixed(3).replace(/\.?0+$/, '')} s`;
}

window.addEventListener('message', (event) => {
  if (event.origin !== location.origin) return;
  if (reviewWindow && event.source === reviewWindow && event.data?.type === 'ecg-review-ready') sendCapture();
  if (reviewPaper && event.source === window.opener && event.data?.type === 'ecg-capture') {
    showReview(event.data.capture);
  }
});

if (playSynthetic) {
  window.addEventListener('resize', drawSyntheticTrace);
  loopSynthetic.addEventListener('change', () => {
    if (!playing) return;
    const position = sourcePosition(performance.now());
    playbackLimit = loopSynthetic.checked ? Infinity
      : (Math.floor(position / samples.length) + 1) * samples.length;
  });
  recordButton.addEventListener('click', () => {
    if (recordButton.disabled) return;
    capture = { start: sourcePosition(performance.now()), count: Number(duration.value) * sampleRate };
    recordingProgress.value = 0;
    recordingStatus.textContent = 'Recording synthetic ECG…';
    updateRecordButton();
  });
  clearRecording.addEventListener('click', () => {
    latestCapture = null;
    clearRecording.disabled = true;
    reviewSummary.textContent = 'Duration — / Samples —';
    reviewSummary.closest('.panel').querySelector('.badge').textContent = 'NO SAMPLE';
    if (!capture) {
      recordingProgress.value = 0;
      recordingStatus.textContent = 'Not started';
    }
    sendCapture();
  });
  playSynthetic.addEventListener('click', async () => {
    playSynthetic.disabled = true;
    syntheticStatus.textContent = 'Loading synthetic ECG…';
    try {
      if (!traceContext) throw new Error('This browser does not support the ECG canvas.');
      const response = await fetch('./data/ecgsyn.dat', { cache: 'no-store' });
      if (!response.ok) throw new Error(`Could not load data/ecgsyn.dat (HTTP ${response.status}).`);
      samples = parseSyntheticRecording(await response.text());
    } catch (error) {
      syntheticStatus.textContent = `Synthetic ECG unavailable: ${error.message}`;
      playSynthetic.disabled = false;
      return;
    }

    livePaper.querySelector('.empty-state').hidden = true;
    livePaper.closest('.panel').querySelector('.panel-title .badge').textContent = 'SYNTHETIC';
    livePaper.setAttribute('aria-label', 'Synthetic ECG waveform for Lead I.');
    syntheticStatus.textContent = 'Synthetic ECG · Playing';
    elapsedSamples = 0;
    startedAt = null;
    playing = true;
    playbackLimit = loopSynthetic.checked ? Infinity : samples.length;
    captureNote.textContent = 'Synthetic source · Captures are kept until this page closes.';
    updateRecordButton();
    function frame(now) {
      startedAt ??= now;
      elapsedSamples = sourcePosition(now);
      drawSyntheticTrace();
      playing = elapsedSamples < playbackLimit;
      updateCapture(!playing);
      if (playing) {
        window.requestAnimationFrame(frame);
      } else {
        syntheticStatus.textContent = 'Synthetic ECG · Playback complete';
        playSynthetic.textContent = 'Replay synthetic ECG';
        playSynthetic.disabled = false;
        captureNote.textContent = 'Play the synthetic ECG to record again.';
        updateRecordButton();
      }
    }
    window.requestAnimationFrame(frame);
  });
}

const reviewPaper = document.querySelector('.recording-strip');
const reviewTrace = reviewPaper?.querySelector('canvas');
const reviewContext = reviewTrace?.getContext('2d');
const reviewViewport = reviewPaper?.closest('.strip-viewport');
let reviewedCapture = null;

function drawReview() {
  if (!reviewedCapture || !reviewContext) return;
  const offset = reviewViewport.scrollLeft;
  const pixelsPerSecond = 8 * Number(reviewPaper.dataset.paperSpeed);
  reviewPaper.style.setProperty('--review-offset', `${offset}px`);
  drawTrace(reviewTrace, reviewContext, offset / pixelsPerSecond, reviewedCapture.values.length,
    (i) => reviewedCapture.values[i], pixelsPerSecond);
}

function resizeReview() {
  if (!reviewedCapture) return;
  const width = reviewViewport.clientWidth;
  const stripWidth = reviewedCapture.values.length / sampleRate * 8 * Number(reviewPaper.dataset.paperSpeed);
  reviewPaper.style.width = `${Math.max(width, Math.ceil(stripWidth))}px`;
  reviewPaper.style.setProperty('--review-width', `${width}px`);
  drawReview();
}

function showReview(recording) {
  reviewedCapture = recording;
  reviewTrace.hidden = !recording;
  reviewPaper.style.width = '';
  reviewViewport.scrollLeft = 0;
  const panel = reviewPaper.closest('.panel');
  panel.querySelector('.badge').textContent = recording ? 'SYNTHETIC' : 'NO RECORDING';
  panel.querySelector('.panel-footer span').textContent = recording
    ? `Synthetic ECG${recording.partial ? ' · Partial recording' : ''}` : 'No recording';
  panel.querySelector('.panel-footer span:last-child').textContent = recording
    ? `Duration ${formatDuration(recording.values.length)} / Samples ${recording.values.length.toLocaleString()}`
    : 'Duration — / Samples —';
  reviewPaper.setAttribute('aria-label', recording ? 'Synthetic ECG recording for Lead I' : 'Empty ECG recording strip for Lead I');
  resizeReview();
}

if (reviewPaper) {
  reviewViewport.addEventListener('scroll', drawReview);
  window.addEventListener('resize', resizeReview);
  window.opener?.postMessage({ type: 'ecg-review-ready' }, location.origin);
}
