// Presentation controls only. Acquisition, waveform rendering, and recording
// intentionally remain unimplemented until a signal source is introduced.
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
  });
});

if (duration) duration.addEventListener('input', updateDurationPresets);

const reviewLink = document.querySelector('.review-link');
if (reviewLink) {
  reviewLink.addEventListener('click', (event) => {
    // Keep the ordinary link as a fallback if the browser blocks the popup.
    const review = window.open(reviewLink.href, 'ecg-recording-review', 'popup,width=1400,height=800,scrollbars=yes,resizable=yes');
    if (review) {
      event.preventDefault();
      review.focus();
    }
  });
}
