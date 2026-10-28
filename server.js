'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const WebSocket = require('ws');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/signal' });
const PORT = Number(process.env.PORT) || 3000;

app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0
}));

app.get('/health', (_req, res) => res.json({ ok: true, service: 'tela-dos-liso' }));

app.get('/config', (_req, res) => {
  const iceServers = [{ urls: ['stun:stun.l.google.com:19302'] }];
  const turnUrls = (process.env.TURN_URL || '').split(',').map(s => s.trim()).filter(Boolean);
  if (turnUrls.length) {
    const turn = { urls: turnUrls };
    if (process.env.TURN_USERNAME) turn.username = process.env.TURN_USERNAME;
    if (process.env.TURN_CREDENTIAL) turn.credential = process.env.TURN_CREDENTIAL;
    iceServers.push(turn);
  }
  res.set('Cache-Control', 'no-store');
  res.json({ iceServers });
});

const peers = new Map();
const MAX_PEERS = Number(process.env.MAX_PEERS) || 12;

function send(ws, message) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}
function broadcast(message, exceptId = null) {
  for (const [id, peer] of peers) if (id !== exceptId) send(peer.ws, message);
}
function publicPeer(peer) {
  return { id: peer.id, name: peer.name, sharing: peer.sharing };
}
function cleanName(value) {
  const name = String(value || '').trim().replace(/\s+/g, ' ').slice(0, 32);
  return name || 'Participante';
}

wss.on('connection', (ws) => {
  if (peers.size >= MAX_PEERS) {
    send(ws, { type: 'error', message: `Esta sessão atingiu o limite de ${MAX_PEERS} participantes.` });
    ws.close(1013, 'room full');
    return;
  }

  const id = require('crypto').randomUUID();
  const peer = { id, ws, name: 'Participante', sharing: false, joinedAt: Date.now() };
  peers.set(id, peer);
  send(ws, { type: 'welcome', id, peers: [...peers.values()].filter(p => p.id !== id).map(publicPeer) });
  broadcast({ type: 'peer-joined', peer: publicPeer(peer) }, id);

  ws.on('message', (raw) => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    if (!message || typeof message.type !== 'string') return;

    if (message.type === 'hello') {
      peer.name = cleanName(message.name);
      broadcast({ type: 'peer-updated', peer: publicPeer(peer) });
      send(ws, { type: 'self-updated', peer: publicPeer(peer) });
      return;
    }
    if (message.type === 'sharing') {
      peer.sharing = Boolean(message.value);
      broadcast({ type: 'peer-updated', peer: publicPeer(peer) });
      return;
    }
    if (message.type === 'signal' && typeof message.to === 'string') {
      const target = peers.get(message.to);
      if (target && message.data && typeof message.data === 'object') {
        send(target.ws, { type: 'signal', from: id, data: message.data });
      }
      return;
    }
    if (message.type === 'ping') send(ws, { type: 'pong', at: Date.now() });
  });

  ws.on('close', () => {
    if (!peers.has(id)) return;
    peers.delete(id);
    broadcast({ type: 'peer-left', id });
  });
  ws.on('error', () => {});
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`TELA DOS LISO disponível em http://localhost:${PORT}`);
  console.log(`Limite de participantes por sessão: ${MAX_PEERS}`);
});
