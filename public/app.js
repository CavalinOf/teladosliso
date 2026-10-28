'use strict';

(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const grid = $('#streamsGrid');
  const template = $('#streamTemplate');
  const emptyState = $('#emptyState');
  const shareButton = $('#shareButton');
  const shareButtonText = $('#shareButtonText');
  const audioButton = $('#audioButton');
  const qualitySelect = $('#qualitySelect');
  const displayName = $('#displayName');
  const status = $('#connectionStatus');
  const participantCount = $('#participantCount');
  const streamSummary = $('#streamSummary');
  const toast = $('#toast');

  const peerConnections = new Map();
  const remoteStreams = new Map();
  const peerMeta = new Map();
  const cards = new Map();
  let myId = null;
  let ws = null;
  let localStream = null;
  let sharingAudio = true;
  let reconnectTimer = null;
  let toastTimer = null;
  let intentionalClose = false;
  let reconnectDelay = 700;
  let connectionGeneration = 0;

  function notify(message, duration = 3600) {
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), duration);
  }
  function send(message) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }
  function setConnectionState(state, label) {
    status.className = `status-pill ${state}`;
    $('span:last-child', status).textContent = label;
  }
  function safeName(name) {
    return String(name || 'Participante').trim().slice(0, 32) || 'Participante';
  }
  function myName() { return safeName(displayName.value); }
  function updateCounts() {
    const count = peerMeta.size + (myId ? 1 : 0);
    participantCount.textContent = `${count} ${count === 1 ? 'participante' : 'participantes'}`;
    const live = [...peerMeta.values()].filter(p => p.sharing).length + (localStream ? 1 : 0);
    streamSummary.textContent = live
      ? `${live} ${live === 1 ? 'transmissão ativa' : 'transmissões ativas'}`
      : 'Aguardando participantes compartilharem suas telas';
    emptyState.hidden = cards.size > 0;
  }
  function sendHello() { send({ type: 'hello', name: myName() }); }

  async function loadConfig() {
    try {
      const response = await fetch('/config', { cache: 'no-store' });
      if (!response.ok) throw new Error('Não foi possível carregar a configuração de rede.');
      return await response.json();
    } catch (error) {
      return { iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }] };
    }
  }
  let rtcConfigPromise = loadConfig();

  function connect() {
    intentionalClose = false;
    clearTimeout(reconnectTimer);
    const generation = ++connectionGeneration;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    setConnectionState('', 'Conectando…');
    ws = new WebSocket(`${protocol}//${location.host}/signal`);
    ws.addEventListener('open', () => {
      if (generation !== connectionGeneration) return;
      reconnectDelay = 700;
      setConnectionState('connected', 'Conectado');
      sendHello();
      // Signaling reconnection: rebuild peer links to avoid stale ICE/DTLS state.
      for (const id of [...peerConnections.keys()]) closePeer(id);
    });
    ws.addEventListener('message', event => {
      if (generation !== connectionGeneration) return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      handleMessage(message).catch(error => {
        console.error('Falha ao processar sinalização:', error);
        notify('Ocorreu um erro ao conectar uma transmissão.');
      });
    });
    ws.addEventListener('close', () => {
      if (generation !== connectionGeneration || intentionalClose) return;
      setConnectionState('disconnected', 'Reconectando…');
      reconnectTimer = setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(10000, reconnectDelay * 1.7);
    });
    ws.addEventListener('error', () => {
      setConnectionState('disconnected', 'Conexão instável');
      try { ws.close(); } catch {}
    });
  }

  async function handleMessage(message) {
    switch (message.type) {
      case 'welcome':
        myId = message.id;
        peerMeta.clear();
        for (const peer of message.peers || []) {
          peerMeta.set(peer.id, peer);
          renderCard(peer.id, peer.name, peer.sharing);
        }
        sendHello();
        if (localStream) {
          send({ type: 'sharing', value: true });
          for (const peer of message.peers || []) await createPeer(peer.id, true);
        }
        updateCounts();
        break;
      case 'peer-joined': {
        const p = message.peer;
        peerMeta.set(p.id, p);
        renderCard(p.id, p.name, p.sharing);
        updateCounts();
        // A participant already sharing offers its stream to the newcomer.
        if (localStream) await createPeer(p.id, true);
        break;
      }
      case 'peer-updated': {
        const p = message.peer;
        peerMeta.set(p.id, p);
        renderCard(p.id, p.name, p.sharing);
        updateCounts();
        // If someone starts sharing after joining, an existing sharer connects to them.
        if (p.sharing && localStream && !peerConnections.has(p.id)) await createPeer(p.id, true);
        break;
      }
      case 'self-updated':
        break;
      case 'peer-left':
        peerMeta.delete(message.id);
        closePeer(message.id);
        removeCard(message.id);
        updateCounts();
        break;
      case 'signal':
        await handleSignal(message.from, message.data);
        break;
      case 'error':
        notify(message.message || 'Erro no servidor de sinalização.', 5000);
        break;
    }
  }

  function renderCard(id, name, isSharing) {
    let card = cards.get(id);
    if (!card) {
      card = template.content.firstElementChild.cloneNode(true);
      card.dataset.peerId = id;
      const video = $('video', card);
      const placeholder = $('.video-placeholder', card);
      const volumeButton = $('.volume-button', card);
      const fullButton = $('.fullscreen-button', card);
      video.muted = false;
      video.addEventListener('loadedmetadata', () => placeholder.classList.add('hidden'));
      video.addEventListener('playing', () => placeholder.classList.add('hidden'));
      video.addEventListener('waiting', () => {
        if (!video.srcObject) placeholder.classList.remove('hidden');
      });
      volumeButton.addEventListener('click', () => {
        video.muted = !video.muted;
        volumeButton.setAttribute('aria-pressed', String(video.muted));
        volumeButton.title = video.muted ? 'Ativar áudio' : 'Silenciar áudio';
        volumeButton.setAttribute('aria-label', volumeButton.title);
        volumeButton.innerHTML = video.muted
          ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="m16 9 5 6m0-6-5 6"/></svg>'
          : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></svg>';
      });
      fullButton.addEventListener('click', async () => {
        try {
          if (document.fullscreenElement === card) await document.exitFullscreen();
          else if (card.requestFullscreen) await card.requestFullscreen();
          else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
          else notify('Tela cheia não é suportada por este navegador.');
        } catch { notify('Não foi possível ativar a tela cheia neste dispositivo.'); }
      });
      grid.appendChild(card);
      cards.set(id, card);
    }
    $('.stream-name', card).textContent = id === myId ? `${safeName(name)} (você)` : safeName(name);
    $('.avatar', card).textContent = safeName(name).charAt(0).toUpperCase();
    $('.stream-state', card).textContent = isSharing ? 'Compartilhando tela' : 'Conectado · aguardando tela';
    card.classList.toggle('is-sharing', Boolean(isSharing));
    updateCounts();
    return card;
  }

  function removeCard(id) {
    const card = cards.get(id);
    if (card) card.remove();
    cards.delete(id);
    remoteStreams.delete(id);
    updateCounts();
  }

  function closePeer(id) {
    const pc = peerConnections.get(id);
    if (pc) {
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.onconnectionstatechange = null;
      try { pc.close(); } catch {}
    }
    peerConnections.delete(id);
    remoteStreams.delete(id);
    const card = cards.get(id);
    if (card) {
      const video = $('video', card);
      video.srcObject = null;
      $('.video-placeholder', card).classList.remove('hidden');
    }
  }

  async function createPeer(id, initiator) {
    if (!id || id === myId || peerConnections.has(id)) return peerConnections.get(id);
    const config = await rtcConfigPromise;
    const pc = new RTCPeerConnection(config);
    peerConnections.set(id, pc);
    if (localStream) {
      for (const track of localStream.getTracks()) {
        try { pc.addTrack(track, localStream); } catch (error) { console.warn('Não foi possível adicionar faixa:', error); }
      }
    }
    pc.onicecandidate = event => {
      if (event.candidate) send({ type: 'signal', to: id, data: { candidate: event.candidate } });
    };
    pc.ontrack = event => {
      let stream = event.streams && event.streams[0];
      if (!stream) {
        stream = remoteStreams.get(id) || new MediaStream();
        if (!stream.getTracks().some(t => t.id === event.track.id)) stream.addTrack(event.track);
      }
      remoteStreams.set(id, stream);
      const peer = peerMeta.get(id) || { name: 'Participante', sharing: true };
      const card = renderCard(id, peer.name, true);
      const video = $('video', card);
      if (video.srcObject !== stream) video.srcObject = stream;
      $('.video-placeholder', card).classList.add('hidden');
      video.play().catch(() => {
        // Browsers may require a user gesture before remote audio/video playback.
        notify('Se o áudio não tocar, toque no vídeo ou ative o som pelo controle da transmissão.', 5000);
      });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        try { pc.restartIce(); } catch {}
        if (localStream) {
          send({ type: 'signal', to: id, data: { restart: true } });
        }
      }
      if (pc.connectionState === 'connected') {
        const card = cards.get(id);
        if (card) $('.stream-quality', card).textContent = 'WEBRTC · AO VIVO';
      }
    };
    if (initiator) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      send({ type: 'signal', to: id, data: { description: pc.localDescription } });
    }
    return pc;
  }

  async function handleSignal(from, data) {
    let pc = peerConnections.get(from);
    if (!pc) pc = await createPeer(from, false);
    if (data.restart) {
      if (pc.signalingState === 'stable') {
        const offer = await pc.createOffer({ iceRestart: true });
        await pc.setLocalDescription(offer);
        send({ type: 'signal', to: from, data: { description: pc.localDescription } });
      }
      return;
    }
    if (data.description) {
      const description = data.description;
      await pc.setRemoteDescription(description);
      if (description.type === 'offer') {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        send({ type: 'signal', to: from, data: { description: pc.localDescription } });
      }
    } else if (data.candidate) {
      try { await pc.addIceCandidate(data.candidate); }
      catch (error) { console.debug('Candidato ICE ignorado:', error.message); }
    }
  }

  async function applyQuality(stream, quality) {
    const track = stream && stream.getVideoTracks()[0];
    if (!track || quality === 'auto') return;
    const height = Number(quality);
    const width = Math.round(height * 16 / 9);
    try {
      await track.applyConstraints({
        width: { ideal: width }, height: { ideal: height },
        frameRate: { ideal: height >= 1440 ? 30 : 30, max: 60 }
      });
      notify(`Qualidade solicitada: ${quality}p. O navegador pode ajustar ao conteúdo capturado.`);
    } catch (error) {
      console.warn('Qualidade não suportada:', error);
      notify(`Não foi possível aplicar ${quality}p. Mantendo a qualidade compatível do navegador.`);
    }
  }

  async function startSharing() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      notify('Este navegador não permite compartilhar tela. Use uma versão atual do Chrome, Edge ou Firefox em HTTPS ou localhost.', 6000);
      return;
    }
    try {
      const quality = qualitySelect.value;
      const height = quality === 'auto' ? undefined : Number(quality);
      const video = height ? {
        width: { ideal: Math.round(height * 16 / 9) },
        height: { ideal: height },
        frameRate: { ideal: 30, max: 60 }
      } : { frameRate: { ideal: 30, max: 60 } };
      let stream;
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video,
          audio: true,
          preferCurrentTab: false,
          selfBrowserSurface: 'exclude',
          surfaceSwitching: 'include',
          systemAudio: 'include'
        });
      } catch (firstError) {
        // Browser support varies; retry with standard constraints if advanced hints were rejected.
        if (firstError.name === 'NotAllowedError') throw firstError;
        stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      }
      localStream = stream;
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) videoTrack.addEventListener('ended', stopSharing, { once: true });
      const localId = myId || 'local-pending';
      peerMeta.set(localId, { id: localId, name: myName(), sharing: true });
      const card = renderCard(localId, myName(), true);
      const videoElement = $('video', card);
      videoElement.srcObject = stream;
      videoElement.muted = true;
      $('.video-placeholder', card).classList.add('hidden');
      $('.stream-quality', card).textContent = quality === 'auto' ? 'ORIGINAL' : `${quality}P`;
      shareButtonText.textContent = 'Parar compartilhamento';
      shareButton.classList.add('sharing');
      shareButton.dataset.sharing = 'true';
      audioButton.disabled = stream.getAudioTracks().length === 0;
      sharingAudio = true;
      updateAudioButton();
      send({ type: 'sharing', value: true });
      // The newly sharing peer initiates one offer per already-connected participant.
      for (const [id, peer] of peerMeta) {
        if (id !== localId && id !== myId && !peer.sharing) await createPeer(id, true);
      }
      // Welcome peers may not yet have been copied into peerMeta while joining.
      notify(stream.getAudioTracks().length
        ? 'Tela compartilhada. O áudio foi solicitado; a disponibilidade depende do navegador e da origem.'
        : 'Tela compartilhada. Esta origem não forneceu áudio.', 4800);
      updateCounts();
    } catch (error) {
      console.error('Erro ao compartilhar tela:', error);
      if (error.name === 'NotAllowedError') notify('Compartilhamento cancelado ou permissão negada.');
      else if (error.name === 'NotFoundError') notify('Nenhuma tela ou janela disponível para compartilhar.');
      else notify(`Não foi possível compartilhar a tela: ${error.message || 'erro desconhecido'}`, 5000);
    }
  }

  async function stopSharing() {
    if (!localStream) return;
    const oldStream = localStream;
    localStream = null;
    for (const track of oldStream.getTracks()) {
      try { track.stop(); } catch {}
    }
    const localKey = myId || 'local-pending';
    removeCard(localKey);
    peerMeta.delete(localKey);
    // Keep peer connections alive for remote participants, but remove the sender tracks.
    for (const pc of peerConnections.values()) {
      for (const sender of pc.getSenders()) {
        if (sender.track && oldStream.getTracks().some(t => t.id === sender.track.id)) {
          try { await sender.replaceTrack(null); } catch {}
        }
      }
    }
    send({ type: 'sharing', value: false });
    shareButtonText.textContent = 'Compartilhar minha tela';
    shareButton.classList.remove('sharing');
    delete shareButton.dataset.sharing;
    audioButton.disabled = true;
    updateCounts();
    notify('Compartilhamento encerrado.');
  }

  function updateAudioButton() {
    const tracks = localStream ? localStream.getAudioTracks() : [];
    tracks.forEach(track => { track.enabled = sharingAudio; });
    audioButton.setAttribute('aria-pressed', String(sharingAudio));
    $('span', audioButton).textContent = sharingAudio ? 'Áudio ligado' : 'Áudio desligado';
    audioButton.classList.toggle('audio-off', !sharingAudio);
  }

  shareButton.addEventListener('click', () => localStream ? stopSharing() : startSharing());
  $('#emptyShareButton').addEventListener('click', () => localStream ? stopSharing() : startSharing());
  audioButton.addEventListener('click', () => {
    if (!localStream || !localStream.getAudioTracks().length) return;
    sharingAudio = !sharingAudio;
    updateAudioButton();
    notify(sharingAudio ? 'Áudio da transmissão ativado.' : 'Áudio da transmissão desativado.');
  });
  qualitySelect.addEventListener('change', () => {
    if (localStream) applyQuality(localStream, qualitySelect.value);
  });
  displayName.addEventListener('change', () => {
    displayName.value = myName();
    sendHello();
    const localKey = myId || 'local-pending';
    if (cards.has(localKey)) renderCard(localKey, myName(), true);
  });
  $('#copyLink').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      notify('Link copiado. Envie para as pessoas que vão participar.');
    } catch {
      const input = document.createElement('input');
      input.value = location.href;
      input.style.position = 'fixed'; input.style.opacity = '0';
      document.body.appendChild(input); input.select();
      const ok = document.execCommand('copy'); input.remove();
      notify(ok ? 'Link copiado. Envie para os participantes.' : `Copie este link: ${location.href}`);
    }
  });
  window.addEventListener('beforeunload', () => {
    intentionalClose = true;
    if (ws) ws.close();
    if (localStream) localStream.getTracks().forEach(track => track.stop());
    for (const pc of peerConnections.values()) pc.close();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && (!ws || ws.readyState === WebSocket.CLOSED)) connect();
  });

  connect();
})();
