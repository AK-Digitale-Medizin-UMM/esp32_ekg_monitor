// Recording review page: lists recordings stored on the server and draws one as a scrollable strip.
// review.html?id=<recording id> opens a specific recording.
import { EcgServer } from './live-client.js';
import { bindSpeedControl, drawTrace, formatDuration, pixelsPerSecond } from './trace.js';

const server = new EcgServer();
const $ = (selector) => document.querySelector(selector);
const paper = $('.recording-strip');
const trace = paper.querySelector('canvas');
const context = trace.getContext('2d');
const viewport = paper.closest('.strip-viewport');
const select = $('#recording-select');
const badge = $('#review-badge');
const sourceLabel = $('#review-source');
const summary = $('#review-summary');
const download = $('#download-link');

let current = null;   // { meta, values }

function draw() {
  if (!current) return;
  const offset = viewport.scrollLeft;
  const pxPerS = pixelsPerSecond(paper);
  paper.style.setProperty('--review-offset', `${offset}px`);
  drawTrace(trace, context, {
    startS: offset / pxPerS, endIndex: current.values.length, fs: current.meta.fs,
    amplitudeAt: (i) => current.values[i], pxPerS,
  });
}

function resize() {
  if (!current) return;
  const width = viewport.clientWidth;
  const stripWidth = (current.values.length / current.meta.fs) * pixelsPerSecond(paper);
  paper.style.width = `${Math.max(width, Math.ceil(stripWidth))}px`;
  paper.style.setProperty('--review-width', `${width}px`);
  draw();
}

function show(recording, message = 'No recording') {
  current = recording;
  trace.hidden = !recording;
  paper.style.width = '';
  viewport.scrollLeft = 0;
  const meta = recording?.meta;
  badge.textContent = meta ? (meta.active ? 'RECORDING…' : 'SAVED') : 'NO RECORDING';
  sourceLabel.textContent = meta
    ? `${meta.device_id}${meta.label ? ` · ${meta.label}` : ''} · ${meta.fs} Hz · ${new Date(meta.started_at * 1000).toLocaleString()}`
      + (meta.lost_packets ? ` · ${meta.lost_packets} lost packets` : '')
    : message;
  summary.textContent = meta
    ? `Duration ${formatDuration(meta.duration_s)} / Samples ${meta.sample_count.toLocaleString()}`
    : 'Duration — / Samples —';
  download.hidden = !meta;
  if (meta) download.href = server.recordingCsvUrl(meta.id);
  paper.setAttribute('aria-label', meta ? `ECG recording ${meta.id} for Lead I` : 'Empty ECG recording strip for Lead I');
  resize();
}

async function open(id) {
  const params = new URLSearchParams(location.search);
  if (id) params.set('id', id); else params.delete('id');
  history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}`);
  if (!id) { show(null); return; }
  sourceLabel.textContent = 'Loading…';
  try {
    show(await server.loadRecording(id));
  } catch (error) {
    show(null, error.message);
  }
}

async function init() {
  const wanted = new URLSearchParams(location.search).get('id') || '';
  let list = [];
  try {
    list = await server.recordings();
  } catch (error) {
    select.replaceChildren(new Option('Server not reachable', ''));
    show(null, error.message);
    return;
  }
  select.replaceChildren(
    new Option(list.length ? 'Select a recording' : 'No recordings yet', ''),
    ...list.map((m) => new Option(
      `${new Date(m.started_at * 1000).toLocaleString()} · ${m.device_id} · ${formatDuration(m.duration_s ?? 0)}`,
      m.id, false, m.id === wanted)),
  );
  select.value = list.some((m) => m.id === wanted) ? wanted : '';
  await open(wanted || '');
}

select.addEventListener('change', () => open(select.value));
viewport.addEventListener('scroll', draw);
window.addEventListener('resize', resize);
document.querySelectorAll('.speed-control').forEach((control) => bindSpeedControl(control, resize));
init();
