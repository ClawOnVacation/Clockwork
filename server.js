const express = require('express');
const http    = require('http');
const { WebSocketServer } = require('ws');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });
const PORT   = 3030;

app.use(express.static(path.join(__dirname, 'public')));
app.get('/operator', (req, res) => res.sendFile('operator.html', { root: path.join(__dirname, 'public') }));
app.get('/viewer',   (req, res) => res.sendFile('viewer.html',   { root: path.join(__dirname, 'public') }));

// Plain text endpoint for Apps Script polling
app.get('/api/elapsed', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const ms       = elapsed();
  const totalSec = Math.floor(ms / 1000);
  const totalMin = Math.floor(totalSec / 60);
  const totalHrs = Math.floor(totalMin / 60);
  const days     = String(Math.min(Math.floor(totalHrs / 24), 99)).padStart(2, '0');
  const hours    = String(totalHrs % 24).padStart(2, '0');
  const minutes  = String(totalMin % 60).padStart(2, '0');
  res.type('text/plain').send(`${days}.${hours}.${minutes}`);
});

// ── Push to Google Sheets webhook ────────────────────────────
const SHEETS_URL = process.env.SHEETS_WEBHOOK_URL || '';

function pushToSheets(state, ms) {
  if (!SHEETS_URL) return;
  const totalSec = Math.floor(ms / 1000);
  const totalMin = Math.floor(totalSec / 60);
  const totalHrs = Math.floor(totalMin / 60);
  const time = [
    String(Math.min(Math.floor(totalHrs/24),99)).padStart(2,'0'),
    String(totalHrs%24).padStart(2,'0'),
    String(totalMin%60).padStart(2,'0'),
  ].join('.');
  const payload = JSON.stringify({ time, state });
  const url = new URL(SHEETS_URL);
  const opts = {
    hostname: url.hostname, path: url.pathname + url.search,
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
  };
  const lib = url.protocol === 'https:' ? require('https') : require('http');
  const req = lib.request(opts);
  req.on('error', () => {});
  req.write(payload);
  req.end();
}

// Push every 5 seconds while running
setInterval(() => {
  if (timerState.state === 'running') pushToSheets('running', elapsed());
}, 5000);

// ── Timer state (authoritative, server-side) ──────────────────
let timerState = {
  state:     'stopped',  // 'running' | 'paused' | 'stopped'
  startTime: null,       // epoch ms, adjusted for resume
  pausedMs:  0,          // ms elapsed at pause
};

function elapsed() {
  if (timerState.state === 'running')  return Date.now() - timerState.startTime;
  if (timerState.state === 'paused')   return timerState.pausedMs;
  return 0;
}

function broadcast(msg) {
  const str = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(str);
  }
}

// ── WebSocket ─────────────────────────────────────────────────
wss.on('connection', (ws) => {
  // Send current state immediately on connect
  ws.send(JSON.stringify({
    type:      'sync',
    state:     timerState.state,
    startTime: timerState.startTime,
    pausedMs:  timerState.pausedMs,
    serverNow: Date.now(),
  }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch(e) { return; }

    if (msg.type === 'start') {
      if (timerState.state === 'running') return;
      if (timerState.state === 'paused') {
        timerState.startTime = Date.now() - timerState.pausedMs;
      } else {
        timerState.startTime = Date.now();
        timerState.pausedMs  = 0;
      }
      timerState.state = 'running';
    }

    else if (msg.type === 'pause') {
      if (timerState.state !== 'running') return;
      timerState.pausedMs = elapsed();
      timerState.state    = 'paused';
    }

    else if (msg.type === 'reset') {
      timerState.state     = 'stopped';
      timerState.startTime = null;
      timerState.pausedMs  = 0;
    }

    const syncMsg = {
      type:      'sync',
      state:     timerState.state,
      startTime: timerState.startTime,
      pausedMs:  timerState.pausedMs,
      serverNow: Date.now(),
    };
    broadcast(syncMsg);
    pushToSheets(timerState.state, elapsed());
  });
});

server.listen(PORT, () => {
  console.log(`Clockwork running at http://localhost:${PORT}`);
  console.log(`  Operator: http://localhost:${PORT}/operator`);
  console.log(`  Viewer:   http://localhost:${PORT}/viewer`);
});
