// Drawing helpers shared by the live monitor and the recording review.
// The paper grid in styles.css uses 8 CSS pixels per small square (1 mm).
export const PX_PER_MM = 8;
export const MM_PER_MV = 10;

export function pixelsPerSecond(paper) {
  return PX_PER_MM * Number(paper.dataset.paperSpeed);
}

/**
 * Draws samples [start s … end sample index) onto a canvas that covers the paper.
 * amplitudeAt(i) returns mV for absolute sample index i, or NaN for "no data" (gap).
 */
export function drawTrace(canvas, context, { startS, endIndex, fs, amplitudeAt, pxPerS }) {
  const { width, height } = canvas.getBoundingClientRect();
  if (!width || !height) return;

  const scale = window.devicePixelRatio || 1;
  const pixelWidth = Math.round(width * scale);
  const pixelHeight = Math.round(height * scale);
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.clearRect(0, 0, width, height);
  if (!fs) return;

  const pxPerMv = PX_PER_MM * MM_PER_MV;
  const first = Math.max(0, Math.floor(startS * fs));
  const last = Math.min(endIndex, Math.ceil((startS + width / pxPerS) * fs) + 1);
  context.beginPath();
  let penDown = false;
  for (let i = first; i < last; i++) {
    const value = amplitudeAt(i);
    if (!Number.isFinite(value)) { penDown = false; continue; }
    const x = (i / fs - startS) * pxPerS;
    const y = height / 2 - value * pxPerMv;
    if (penDown) context.lineTo(x, y);
    else context.moveTo(x, y);
    penDown = true;
  }
  context.strokeStyle = '#174d43';
  context.lineWidth = 1.5;
  context.stroke();
}

/** Wires a .speed-control button group to its panel's .ecg-paper; calls onChange after a switch. */
export function bindSpeedControl(control, onChange) {
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
    paper.querySelector('.paper-scale').textContent = `${button.dataset.speed} mm/s · ${MM_PER_MV} mm/mV`;
    onChange?.(paper);
  });
}

export function formatDuration(seconds) {
  return `${seconds.toFixed(2).replace(/\.?0+$/, '')} s`;
}
