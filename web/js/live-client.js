// The only module that knows how to talk to the ECG server.
// UI code uses EcgServer (REST) and LiveStream (WebSocket) and never builds URLs itself.
//
// Server address: same origin as the page by default. Override with ?server=host:port
// (e.g. index.html?server=192.168.0.10:8000) to use a UI served from somewhere else;
// the server then needs EKG_CORS_ORIGINS set for the REST calls.

/** ADC convention shared with firmware and synthetic source: mid-scale = 0 mV, 600 counts = 1 mV. */
export const ADC_COUNTS_PER_MV = 600;

export function toMillivolts(values, unit, adcBits = 12) {
  if (unit !== 'adc_raw') return Float32Array.from(values);
  const offset = 2 ** (adcBits - 1);
  return Float32Array.from(values, (v) => (v - offset) / ADC_COUNTS_PER_MV);
}

export function resolveServer(search = location.search) {
  const override = new URLSearchParams(search).get('server');
  if (!override) return new URL(location.origin);
  return new URL(/^https?:\/\//.test(override) ? override : `${location.protocol}//${override}`);
}

/** Query string that keeps the ?server= override when linking to another page of this UI. */
export function serverQuery(search = location.search) {
  const override = new URLSearchParams(search).get('server');
  return override ? `server=${encodeURIComponent(override)}` : '';
}

export class EcgServer {
  constructor(base = resolveServer()) {
    this.base = base;
  }

  url(path) {
    return new URL(path, this.base).href;
  }

  wsUrl(path) {
    const url = new URL(path, this.base);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.href;
  }

  async request(path, { method = 'GET', body } = {}) {
    let response;
    try {
      response = await fetch(this.url(path), {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
      });
    } catch {
      throw new Error(`Server not reachable (${this.base.host})`);
    }
    const text = await response.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* plain-text error body */ }
    if (!response.ok) {
      const detail = typeof data === 'object' && data ? data.detail : data;
      throw new Error(`HTTP ${response.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
    }
    return data;
  }

  devices() { return this.request('/api/v1/devices'); }

  startSynthetic(options = {}) {
    return this.request('/api/v1/sources/synthetic/start', { method: 'POST', body: options });
  }

  stopSynthetic(deviceId = 'synthetic-01') {
    return this.request(`/api/v1/sources/synthetic/${encodeURIComponent(deviceId)}/stop`, { method: 'POST' });
  }

  startRecording(deviceId, { durationS, label = '', subject = '' } = {}) {
    return this.request('/api/v1/recordings/start', {
      method: 'POST', body: { device_id: deviceId, duration_s: durationS, label, subject },
    });
  }

  stopRecording(deviceId) {
    return this.request(`/api/v1/recordings/${encodeURIComponent(deviceId)}/stop`, { method: 'POST' });
  }

  recordings() { return this.request('/api/v1/recordings'); }

  recording(id) { return this.request(`/api/v1/recordings/${encodeURIComponent(id)}`); }

  recordingCsvUrl(id) { return this.url(`/api/v1/recordings/${encodeURIComponent(id)}/csv`); }

  /** Loads a recording as { meta, values: Float32Array (mV), leadOff: Uint8Array }. */
  async loadRecording(id) {
    const meta = await this.recording(id);
    const response = await fetch(this.recordingCsvUrl(id), { cache: 'no-store' });
    if (!response.ok) throw new Error(`Could not load recording CSV (HTTP ${response.status})`);
    const rows = (await response.text()).trim().split(/\r?\n/).slice(1);
    const raw = new Float64Array(rows.length);
    const leadOff = new Uint8Array(rows.length);
    rows.forEach((row, i) => {
      const fields = row.split(',');
      raw[i] = Number(fields[2]);
      leadOff[i] = fields[3] === '1' ? 1 : 0;
    });
    return { meta, values: toMillivolts(raw, meta.unit, meta.adc_bits ?? 12), leadOff };
  }
}

/**
 * Live packets from /ws/live, optionally filtered to one device, with automatic reconnect.
 * Events:
 *   'packet' → detail { deviceId, source, fs, seq, leadOff, values: Float32Array (mV) }
 *   'status' → detail { state: 'connecting' | 'open' | 'closed' }
 */
export class LiveStream extends EventTarget {
  constructor(server) {
    super();
    this.server = server;
    this.deviceId = null;
    this.socket = null;
    this.retryMs = 500;
    this.retryTimer = null;
    this.stopped = true;
  }

  connect(deviceId = null) {
    this.deviceId = deviceId;
    this.stopped = false;
    this.#open();
  }

  close() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.socket?.close();
    this.socket = null;
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  #open() {
    clearTimeout(this.retryTimer);
    if (this.socket) {
      this.socket.onclose = null;
      this.socket.close();
    }
    const query = this.deviceId ? `?device_id=${encodeURIComponent(this.deviceId)}` : '';
    const socket = new WebSocket(this.server.wsUrl(`/ws/live${query}`));
    this.socket = socket;
    this.#emit('status', { state: 'connecting' });

    socket.onopen = () => {
      this.retryMs = 500;
      this.#emit('status', { state: 'open' });
    };
    socket.onmessage = (event) => {
      const p = JSON.parse(event.data);
      this.#emit('packet', {
        deviceId: p.device_id, source: p.source, fs: p.fs, seq: p.seq, leadOff: p.lead_off,
        values: toMillivolts(p.samples, p.unit, p.adc_bits),
      });
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.#emit('status', { state: 'closed' });
      if (this.stopped) return;
      this.retryTimer = setTimeout(() => this.#open(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 5000);
    };
  }
}
