/**
 * Gemini Flash Live - Simple & Focused Client
 * Real-time bidirectional voice, video, screen share, and text streaming.
 * Supports:
 *  - User queries displayed in text (via Gemini live transcription + instant speech recognition)
 *  - Model responses in BOTH audio playback AND streaming text
 */

(function () {
  'use strict';

  // State
  let ws = null;
  let isConnected = false;
  let isMicActive = false;
  let isCamActive = false;
  let isScreenActive = false;

  // Media Streams & Audio Contexts
  let micMediaStream = null;
  let videoMediaStream = null;
  let screenMediaStream = null;
  let videoInterval = null;
  let speechRecognizer = null;

  let inputAudioCtx = null;
  let inputSourceNode = null;
  let inputProcessorNode = null;
  let inputAnalyser = null;

  let outputAudioCtx = null;
  let outputAnalyser = null;
  let nextPlayTime = 0;
  let activeAudioSources = [];

  // Turns & Current Message Tracking
  let currentUserTurnElement = null;
  let currentUserTextSpan = null;
  let currentModelTurnElement = null;
  let currentModelTextSpan = null;
  let currentModelAudioChunks = [];

  // Latency & Response Time Tracking
  let userQueryStartTime = null;
  let currentModelTurnStartTime = null;
  let currentModelResponseTimeSpan = null;

  // DOM Elements
  const statusPill = document.getElementById('connection-status-pill');
  const statusText = document.getElementById('status-text');
  const liveAudioIndicator = document.getElementById('live-audio-indicator');
  const headerModelBadge = document.getElementById('header-model-badge');
  const turnsList = document.getElementById('turns-list');
  const emptyState = document.getElementById('empty-state');
  const chatInput = document.getElementById('chat-input');
  const btnSendMessage = document.getElementById('btn-send-message');
  const btnToggleMic = document.getElementById('btn-toggle-mic');
  const btnToggleCamera = document.getElementById('btn-toggle-camera');
  const btnToggleScreen = document.getElementById('btn-toggle-screen');
  const btnClearChat = document.getElementById('btn-clear-chat');

  // Video PiP
  const pipContainer = document.getElementById('pip-video-container');
  const pipVideo = document.getElementById('pip-video-element');
  const pipModeLabel = document.getElementById('pip-mode-label');
  const pipCloseBtn = document.getElementById('pip-close-btn');

  // Drawer & Settings
  const toggleSettingsBtn = document.getElementById('toggle-settings-btn');
  const settingsDrawer = document.getElementById('settings-drawer');
  const closeDrawerBtn = document.getElementById('close-drawer-btn');
  const drawerBackdrop = document.getElementById('drawer-backdrop');
  const selectModel = document.getElementById('select-model');
  const selectVoice = document.getElementById('select-voice');
  const selectResolution = document.getElementById('select-resolution');
  const selectThinking = document.getElementById('select-thinking');
  const systemInstructionsInput = document.getElementById('system-instructions-input');
  const waveformCanvas = document.getElementById('waveform-canvas');
  const audioActiveBadge = document.getElementById('audio-active-badge');
  const modalApiKeyInput = document.getElementById('modal-api-key-input');
  const modalSaveBtn = document.getElementById('modal-save-btn');

  const canvasCtx = waveformCanvas ? waveformCanvas.getContext('2d') : null;

  init();

  async function init() {
    setupEventListeners();
    await loadInitialConfig();
    startCanvasVisualizer();
    connectWebSocket();
  }

  function setupEventListeners() {
    // Text input
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendTextMessage();
      }
    });

    chatInput.addEventListener('input', () => {
      chatInput.style.height = 'auto';
      chatInput.style.height = Math.min(chatInput.scrollHeight, 100) + 'px';
    });

    btnSendMessage.addEventListener('click', sendTextMessage);
    btnClearChat.addEventListener('click', resetChat);

    // Media streaming toggles
    btnToggleMic.addEventListener('click', toggleMicrophone);
    if (btnToggleCamera) btnToggleCamera.addEventListener('click', toggleCamera);
    if (btnToggleScreen) btnToggleScreen.addEventListener('click', toggleScreenShare);

    // Video PiP close
    pipCloseBtn.addEventListener('click', () => {
      if (isCamActive) stopCamera();
      if (isScreenActive) stopScreenShare();
      pipContainer.classList.add('hidden');
    });

    // Settings Drawer
    toggleSettingsBtn.addEventListener('click', openDrawer);
    closeDrawerBtn.addEventListener('click', closeDrawer);
    drawerBackdrop.addEventListener('click', closeDrawer);

    // Setting changes
    selectModel.addEventListener('change', () => {
      if (selectModel.value.includes('3.1')) {
        headerModelBadge.textContent = '3.1 Flash';
      } else if (selectModel.value.includes('3.8')) {
        headerModelBadge.textContent = '3.8 Live';
      } else {
        headerModelBadge.textContent = '2.5 Audio';
      }
      reconnectSession();
    });

    selectVoice.addEventListener('change', reconnectSession);
    selectResolution.addEventListener('change', reconnectSession);
    selectThinking.addEventListener('change', reconnectSession);

    // Quick prompts
    document.querySelectorAll('.suggestion-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const text = chip.getAttribute('data-prompt');
        chatInput.value = text;
        sendTextMessage();
      });
    });

    // Save key
    modalSaveBtn.addEventListener('click', saveApiKey);
  }

  function openDrawer() {
    settingsDrawer.classList.remove('hidden');
    drawerBackdrop.classList.remove('hidden');
  }

  function closeDrawer() {
    settingsDrawer.classList.add('hidden');
    drawerBackdrop.classList.add('hidden');
  }

  async function loadInitialConfig() {
    try {
      const res = await fetch('/api/config');
      const data = await res.json();
      if (data.masked_key) {
        modalApiKeyInput.placeholder = `Current Key: ${data.masked_key}`;
      }
      if (data.voices && Array.isArray(data.voices)) {
        selectVoice.innerHTML = '';
        data.voices.forEach((v) => {
          const opt = document.createElement('option');
          opt.value = v;
          opt.textContent = v;
          if (data.default_voice && v === data.default_voice) {
            opt.selected = true;
          }
          selectVoice.appendChild(opt);
        });
        if (data.default_voice) {
          selectVoice.value = data.default_voice;
        }
      }
    } catch (e) {
      console.warn('Could not load config:', e);
    }
  }

  async function saveApiKey() {
    const key = modalApiKeyInput.value.trim();
    if (!key) return;
    try {
      const res = await fetch('/api/key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: key }),
      });
      const data = await res.json();
      if (data.success) {
        modalApiKeyInput.value = '';
        modalApiKeyInput.placeholder = `Current Key: ${data.masked_key}`;
        closeDrawer();
        reconnectSession();
      }
    } catch (e) {
      alert('Error saving API Key: ' + e.message);
    }
  }

  // ==========================================================================
  // WEBSOCKET CONNECTION
  // ==========================================================================

  function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/live`;

    updateStatus(false, 'Connecting...');

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      const initPayload = {
        model: selectModel.value,
        voice: selectVoice.value,
        system_instruction: systemInstructionsInput.value,
        thinking_level: selectThinking.value,
        media_resolution: selectResolution.value,
      };
      ws.send(JSON.stringify(initPayload));
    };

    ws.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleServerMessage(msg);
      } catch (e) {
        console.error('Error parsing message from server:', e);
      }
    };

    ws.onclose = () => {
      updateStatus(false, 'Disconnected');
      setTimeout(() => {
        if (!isConnected) connectWebSocket();
      }, 3000);
    };

    ws.onerror = (err) => {
      console.error('WebSocket Error:', err);
      updateStatus(false, 'Error');
    };
  }

  function reconnectSession() {
    if (ws) {
      try { ws.close(); } catch (e) {}
    }
    connectWebSocket();
  }

  function updateStatus(connected, text) {
    isConnected = connected;
    statusText.textContent = text;
    if (connected) {
      statusPill.className = 'status-pill status-connected';
    } else {
      statusPill.className = 'status-pill status-disconnected';
    }
  }

  // ==========================================================================
  // MESSAGE HANDLER: USER TRANSCRIPTION & MODEL AUDIO/TEXT
  // ==========================================================================

  function handleServerMessage(msg) {
    switch (msg.type) {
      case 'connected':
        updateStatus(true, 'Live');
        break;

      // User's speech transcribed to text
      case 'user_transcription':
        userQueryStartTime = performance.now();
        ensureUserTurnCard();
        currentUserTextSpan.textContent = msg.text;
        scrollToBottom();
        if (msg.finished) {
          currentUserTurnElement = null;
          currentUserTextSpan = null;
        }
        break;

      // Model's response in text
      case 'text':
        ensureModelTurnCard();
        currentModelTextSpan.textContent += msg.text;
        scrollToBottom();
        break;

      // Model's response in audio
      case 'audio':
        ensureModelTurnCard();
        playPcmChunk(msg.data);
        currentModelAudioChunks.push(msg.data);
        setAudioActive(true, 'SPEAKING');
        break;

      case 'turn_complete':
        finalizeModelTurn();
        currentUserTurnElement = null;
        currentUserTextSpan = null;
        setAudioActive(false, 'IDLE');
        break;

      case 'interrupted':
        haltAudioPlayback();
        finalizeModelTurn();
        setAudioActive(false, 'IDLE');
        break;

      case 'error':
        console.error('Server error:', msg.message);
        appendNotice(`Error: ${msg.message}`);
        updateStatus(false, 'Error');
        break;
    }
  }

  // ==========================================================================
  // TURN CARDS & TRANSCRIPT
  // ==========================================================================

  function resetChat() {
    turnsList.innerHTML = '';
    emptyState.classList.remove('hidden');
    haltAudioPlayback();
    userQueryStartTime = null;
    currentModelTurnStartTime = null;
    currentModelResponseTimeSpan = null;
    reconnectSession();
  }

  function ensureUserTurnCard() {
    emptyState.classList.add('hidden');
    if (!currentUserTurnElement) {
      const card = document.createElement('div');
      card.className = 'turn-card user-turn';

      const content = document.createElement('div');
      content.className = 'turn-content';
      const textSpan = document.createElement('span');
      content.appendChild(textSpan);

      card.appendChild(content);
      turnsList.appendChild(card);

      currentUserTurnElement = card;
      currentUserTextSpan = textSpan;
      scrollToBottom();
    }
  }

  function formatLatency(ms) {
    if (ms < 1000) {
      return `${ms} ms`;
    }
    return `${(ms / 1000).toFixed(2)} s`;
  }

  function ensureModelTurnCard() {
    emptyState.classList.add('hidden');
    if (!currentModelTurnElement) {
      const now = performance.now();
      currentModelTurnStartTime = now;
      const baseTime = userQueryStartTime || now;
      const latencyMs = Math.max(10, Math.round(now - baseTime));

      const card = document.createElement('div');
      card.className = 'turn-card model-turn';

      const header = document.createElement('div');
      header.className = 'turn-header';
      header.innerHTML = `<span>Gemini</span> <div class="model-equalizer-live"><span class="eq-bar"></span><span class="eq-bar"></span><span class="eq-bar"></span><span class="eq-bar"></span></div>`;

      // Audio Player
      const player = createAudioPlayerWidget();

      // Content
      const content = document.createElement('div');
      content.className = 'turn-content';
      const textSpan = document.createElement('span');
      content.appendChild(textSpan);

      // Response Time Metadata Pill
      const meta = document.createElement('div');
      meta.className = 'turn-meta';
      meta.innerHTML = `
        <span class="meta-time" title="Latency from prompt to first response chunk">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"></circle>
            <polyline points="12 6 12 12 16 14"></polyline>
          </svg>
          Response time: <strong class="time-val">${formatLatency(latencyMs)}</strong>
        </span>
      `;

      card.appendChild(header);
      card.appendChild(player);
      card.appendChild(content);
      card.appendChild(meta);

      turnsList.appendChild(card);
      currentModelTurnElement = card;
      currentModelTextSpan = textSpan;
      currentModelResponseTimeSpan = meta.querySelector('.time-val');
      currentModelAudioChunks = [];
    }
  }

  function finalizeModelTurn() {
    if (currentModelTurnElement) {
      const eq = currentModelTurnElement.querySelector('.model-equalizer-live');
      if (eq) eq.remove();

      if (currentModelAudioChunks.length > 0) {
        attachAudioBlobToPlayer(currentModelTurnElement, currentModelAudioChunks, 24000);
      }

      if (currentModelTurnStartTime && currentModelResponseTimeSpan) {
        const totalDurationMs = Math.round(performance.now() - (userQueryStartTime || currentModelTurnStartTime));
        const metaSpan = currentModelTurnElement.querySelector('.meta-time');
        if (metaSpan) {
          const latencyText = currentModelResponseTimeSpan.textContent;
          metaSpan.title = `Latency: ${latencyText} • Total generation: ${formatLatency(totalDurationMs)}`;
        }
      }

      currentModelTurnElement = null;
      currentModelTextSpan = null;
      currentModelResponseTimeSpan = null;
      currentModelAudioChunks = [];
      currentModelTurnStartTime = null;
      userQueryStartTime = null;
    }
  }

  function appendUserTurn(text) {
    emptyState.classList.add('hidden');
    ensureUserTurnCard();
    currentUserTextSpan.textContent = text;
    currentUserTurnElement = null;
    currentUserTextSpan = null;
    scrollToBottom();
  }

  function appendNotice(notice) {
    emptyState.classList.add('hidden');
    const note = document.createElement('div');
    note.style.color = 'var(--accent-red)';
    note.style.fontSize = '12.5px';
    note.style.padding = '8px 14px';
    note.style.backgroundColor = 'rgba(234, 67, 53, 0.1)';
    note.style.borderRadius = 'var(--radius-sm)';
    note.style.alignSelf = 'center';
    note.textContent = notice;
    turnsList.appendChild(note);
    scrollToBottom();
  }

  function createAudioPlayerWidget() {
    const player = document.createElement('div');
    player.className = 'turn-audio-player';
    player.innerHTML = `
      <button class="player-btn-play" title="Play">▶</button>
      <span class="player-time">0:00 / 0:00</span>
      <input type="range" class="player-slider" min="0" max="100" value="0">
      <span class="player-icon" title="Volume">🔊</span>
    `;
    return player;
  }

  function attachAudioBlobToPlayer(cardElement, base64PcmChunks, sampleRate) {
    const playBtn = cardElement.querySelector('.player-btn-play');
    const timeSpan = cardElement.querySelector('.player-time');
    const slider = cardElement.querySelector('.player-slider');

    if (!playBtn) return;

    const wavBlob = pcmChunksToWavBlob(base64PcmChunks, sampleRate);
    const audioUrl = URL.createObjectURL(wavBlob);
    const audio = new Audio(audioUrl);

    audio.onloadedmetadata = () => {
      const dur = formatSeconds(audio.duration);
      timeSpan.textContent = `0:00 / ${dur}`;
    };

    audio.ontimeupdate = () => {
      if (audio.duration) {
        const cur = formatSeconds(audio.currentTime);
        const dur = formatSeconds(audio.duration);
        timeSpan.textContent = `${cur} / ${dur}`;
        slider.value = (audio.currentTime / audio.duration) * 100;
      }
    };

    audio.onended = () => {
      playBtn.textContent = '▶';
      slider.value = 0;
    };

    playBtn.onclick = () => {
      if (audio.paused) {
        audio.play();
        playBtn.textContent = '⏸';
      } else {
        audio.pause();
        playBtn.textContent = '▶';
      }
    };

    slider.oninput = () => {
      if (audio.duration) {
        audio.currentTime = (slider.value / 100) * audio.duration;
      }
    };
  }

  function scrollToBottom() {
    const area = document.getElementById('turns-container');
    area.scrollTop = area.scrollHeight;
  }

  function formatSeconds(secs) {
    if (isNaN(secs) || secs < 0) return '0:00';
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  }

  // ==========================================================================
  // SEND TEXT
  // ==========================================================================

  function sendTextMessage() {
    const text = chatInput.value.trim();
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;

    userQueryStartTime = performance.now();
    currentModelTurnStartTime = null;
    currentModelResponseTimeSpan = null;

    appendUserTurn(text);
    ws.send(JSON.stringify({ type: 'text', text: text }));

    chatInput.value = '';
    chatInput.style.height = 'auto';
  }

  // ==========================================================================
  // MICROPHONE STREAMING (PCM 16kHz + INSTANT SPEECH RECOGNITION)
  // ==========================================================================

  async function toggleMicrophone() {
    if (isMicActive) {
      stopMicrophone();
    } else {
      await startMicrophone();
    }
  }

  async function startMicrophone() {
    try {
      micMediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      inputAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const actualSampleRate = inputAudioCtx.sampleRate;
      inputSourceNode = inputAudioCtx.createMediaStreamSource(micMediaStream);

      inputAnalyser = inputAudioCtx.createAnalyser();
      inputAnalyser.fftSize = 256;
      inputSourceNode.connect(inputAnalyser);

      const bufferSize = 4096;
      inputProcessorNode = inputAudioCtx.createScriptProcessor(bufferSize, 1, 1);

      inputProcessorNode.onaudioprocess = (e) => {
        if (!isMicActive || !ws || ws.readyState !== WebSocket.OPEN) return;

        const inputData = e.inputBuffer.getChannelData(0);
        const pcm16Data = resampleAndConvertToPcm16(inputData, actualSampleRate, 16000);
        const base64Chunk = arrayBufferToBase64(pcm16Data.buffer);

        ws.send(JSON.stringify({ type: 'audio', data: base64Chunk }));
      };

      inputSourceNode.connect(inputProcessorNode);
      inputProcessorNode.connect(inputAudioCtx.destination);

      // Start local SpeechRecognition for instant UI text preview
      if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
        try {
          const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
          speechRecognizer = new SpeechRec();
          speechRecognizer.continuous = true;
          speechRecognizer.interimResults = true;
          speechRecognizer.lang = 'en-US';
          speechRecognizer.onresult = (event) => {
            let interim = '';
            let final = '';
            for (let i = event.resultIndex; i < event.results.length; ++i) {
              if (event.results[i].isFinal) {
                final += event.results[i][0].transcript;
              } else {
                interim += event.results[i][0].transcript;
              }
            }
            const transcript = (final || interim).trim();
            if (transcript) {
              userQueryStartTime = performance.now();
              ensureUserTurnCard();
              currentUserTextSpan.textContent = transcript;
              scrollToBottom();
            }
            if (final) {
              currentUserTurnElement = null;
              currentUserTextSpan = null;
            }
          };
          speechRecognizer.onerror = (e) => console.warn('SpeechRec error:', e);
          speechRecognizer.start();
        } catch (e) {
          console.warn('Speech recognition start failed:', e);
        }
      }

      isMicActive = true;
      btnToggleMic.classList.add('active-mic');
      setAudioActive(true, 'LISTENING');
    } catch (err) {
      console.error('Error starting microphone:', err);
      alert('Microphone access denied: ' + err.message);
    }
  }

  function stopMicrophone() {
    isMicActive = false;
    btnToggleMic.classList.remove('active-mic');
    setAudioActive(false, 'IDLE');

    if (speechRecognizer) {
      try { speechRecognizer.stop(); } catch (e) {}
      speechRecognizer = null;
    }
    currentUserTurnElement = null;
    currentUserTextSpan = null;

    if (inputProcessorNode) {
      try { inputProcessorNode.disconnect(); } catch (e) {}
      inputProcessorNode = null;
    }
    if (inputSourceNode) {
      try { inputSourceNode.disconnect(); } catch (e) {}
      inputSourceNode = null;
    }
    if (inputAudioCtx) {
      try { inputAudioCtx.close(); } catch (e) {}
      inputAudioCtx = null;
    }
    if (micMediaStream) {
      micMediaStream.getTracks().forEach((track) => track.stop());
      micMediaStream = null;
    }
  }

  function resampleAndConvertToPcm16(inputBuffer, fromRate, toRate) {
    const ratio = fromRate / toRate;
    const newLength = Math.round(inputBuffer.length / ratio);
    const result = new Int16Array(newLength);

    for (let i = 0; i < newLength; i++) {
      const origIndex = Math.min(Math.round(i * ratio), inputBuffer.length - 1);
      const s = Math.max(-1, Math.min(1, inputBuffer[origIndex]));
      result[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return result;
  }

  // ==========================================================================
  // GEMINI AUDIO PLAYBACK (PCM 24kHz)
  // ==========================================================================

  function ensureOutputAudioContext() {
    if (!outputAudioCtx || outputAudioCtx.state === 'closed') {
      outputAudioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
      outputAnalyser = outputAudioCtx.createAnalyser();
      outputAnalyser.fftSize = 256;
      outputAnalyser.connect(outputAudioCtx.destination);
      nextPlayTime = outputAudioCtx.currentTime;
    }
    if (outputAudioCtx.state === 'suspended') {
      outputAudioCtx.resume();
    }
  }

  function playPcmChunk(base64Data) {
    ensureOutputAudioContext();

    const binaryString = atob(base64Data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    const int16Array = new Int16Array(bytes.buffer);
    const float32Array = new Float32Array(int16Array.length);
    for (let i = 0; i < int16Array.length; i++) {
      float32Array[i] = int16Array[i] / 32768.0;
    }

    const audioBuffer = outputAudioCtx.createBuffer(1, float32Array.length, 24000);
    audioBuffer.copyToChannel(float32Array, 0);

    const source = outputAudioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(outputAnalyser);

    const startTime = Math.max(outputAudioCtx.currentTime, nextPlayTime);
    source.start(startTime);
    nextPlayTime = startTime + audioBuffer.duration;

    activeAudioSources.push(source);
    source.onended = () => {
      const idx = activeAudioSources.indexOf(source);
      if (idx !== -1) activeAudioSources.splice(idx, 1);
    };
  }

  function haltAudioPlayback() {
    for (const src of activeAudioSources) {
      try { src.stop(); } catch (e) {}
    }
    activeAudioSources = [];
    if (outputAudioCtx) {
      nextPlayTime = outputAudioCtx.currentTime;
    }
  }

  function setAudioActive(active, label) {
    if (active) {
      liveAudioIndicator.classList.remove('hidden');
      audioActiveBadge.className = 'badge-speaking';
      audioActiveBadge.textContent = label;
    } else {
      liveAudioIndicator.classList.add('hidden');
      audioActiveBadge.className = 'badge-idle';
      audioActiveBadge.textContent = 'IDLE';
    }
  }

  // ==========================================================================
  // WEBCAM & SCREEN SHARING
  // ==========================================================================

  async function toggleCamera() {
    if (isCamActive) {
      stopCamera();
    } else {
      if (isScreenActive) stopScreenShare();
      await startCamera();
    }
  }

  async function startCamera() {
    try {
      videoMediaStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1024 }, height: { ideal: 768 } },
      });

      pipVideo.srcObject = videoMediaStream;
      pipContainer.classList.remove('hidden');
      pipModeLabel.textContent = '● LIVE CAMERA';
      if (btnToggleCamera) btnToggleCamera.classList.add('active-cam');
      isCamActive = true;

      startFrameCaptureLoop();
    } catch (e) {
      console.error('Camera error:', e);
      alert('Could not access camera: ' + e.message);
    }
  }

  function stopCamera() {
    isCamActive = false;
    if (btnToggleCamera) btnToggleCamera.classList.remove('active-cam');
    stopFrameCaptureLoop();
    if (videoMediaStream) {
      videoMediaStream.getTracks().forEach((t) => t.stop());
      videoMediaStream = null;
    }
    if (!isScreenActive) {
      pipContainer.classList.add('hidden');
    }
  }

  async function toggleScreenShare() {
    if (isScreenActive) {
      stopScreenShare();
    } else {
      if (isCamActive) stopCamera();
      await startScreenShare();
    }
  }

  async function startScreenShare() {
    try {
      screenMediaStream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: 'always' },
      });

      pipVideo.srcObject = screenMediaStream;
      pipContainer.classList.remove('hidden');
      pipModeLabel.textContent = '● LIVE SCREEN';
      if (btnToggleScreen) btnToggleScreen.classList.add('active-screen');
      isScreenActive = true;

      screenMediaStream.getVideoTracks()[0].onended = () => {
        stopScreenShare();
      };

      startFrameCaptureLoop();
    } catch (e) {
      console.error('Screen share error:', e);
    }
  }

  function stopScreenShare() {
    isScreenActive = false;
    if (btnToggleScreen) btnToggleScreen.classList.remove('active-screen');
    stopFrameCaptureLoop();
    if (screenMediaStream) {
      screenMediaStream.getTracks().forEach((t) => t.stop());
      screenMediaStream = null;
    }
    if (!isCamActive) {
      pipContainer.classList.add('hidden');
    }
  }

  function startFrameCaptureLoop() {
    stopFrameCaptureLoop();
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    videoInterval = setInterval(() => {
      if ((!isCamActive && !isScreenActive) || !ws || ws.readyState !== WebSocket.OPEN) return;
      if (!pipVideo.videoWidth || !pipVideo.videoHeight) return;

      const maxDim = 1024;
      let w = pipVideo.videoWidth;
      let h = pipVideo.videoHeight;
      if (w > maxDim || h > maxDim) {
        if (w > h) {
          h = Math.round((h * maxDim) / w);
          w = maxDim;
        } else {
          w = Math.round((w * maxDim) / h);
          h = maxDim;
        }
      }

      canvas.width = w;
      canvas.height = h;
      ctx.drawImage(pipVideo, 0, 0, w, h);

      const jpegDataUrl = canvas.toDataURL('image/jpeg', 0.65);
      const b64Data = jpegDataUrl.split(',')[1];

      ws.send(JSON.stringify({
        type: 'image',
        mime_type: 'image/jpeg',
        data: b64Data,
      }));
    }, 1000);
  }

  function stopFrameCaptureLoop() {
    if (videoInterval) {
      clearInterval(videoInterval);
      videoInterval = null;
    }
  }

  // ==========================================================================
  // OSCILLOSCOPE CANVAS
  // ==========================================================================

  function startCanvasVisualizer() {
    if (!canvasCtx) return;

    const dataArray = new Uint8Array(128);

    function draw() {
      requestAnimationFrame(draw);

      const w = waveformCanvas.width;
      const h = waveformCanvas.height;
      canvasCtx.fillStyle = '#0b0b0d';
      canvasCtx.fillRect(0, 0, w, h);

      let analyser = null;
      let strokeColor = '#3c4043';

      if (outputAnalyser && activeAudioSources.length > 0) {
        analyser = outputAnalyser;
        strokeColor = '#8ab4f8';
      } else if (inputAnalyser && isMicActive) {
        analyser = inputAnalyser;
        strokeColor = '#ea4335';
      }

      if (analyser) {
        analyser.getByteTimeDomainData(dataArray);
      } else {
        for (let i = 0; i < dataArray.length; i++) dataArray[i] = 128;
      }

      canvasCtx.lineWidth = 2;
      canvasCtx.strokeStyle = strokeColor;
      canvasCtx.beginPath();

      const sliceWidth = w / dataArray.length;
      let x = 0;

      for (let i = 0; i < dataArray.length; i++) {
        const v = dataArray[i] / 128.0;
        const y = (v * h) / 2;
        if (i === 0) canvasCtx.moveTo(x, y);
        else canvasCtx.lineTo(x, y);
        x += sliceWidth;
      }

      canvasCtx.lineTo(w, h / 2);
      canvasCtx.stroke();
    }

    draw();
  }

  // ==========================================================================
  // PCM TO WAV CONVERTER
  // ==========================================================================

  function pcmChunksToWavBlob(base64Chunks, sampleRate) {
    let totalLength = 0;
    const byteArrays = base64Chunks.map((b64) => {
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      totalLength += bytes.length;
      return bytes;
    });

    const combinedPcm = new Uint8Array(totalLength);
    let offset = 0;
    for (const b of byteArrays) {
      combinedPcm.set(b, offset);
      offset += b.length;
    }

    const wavHeader = createWavHeader(combinedPcm.length, sampleRate, 1, 16);
    return new Blob([wavHeader, combinedPcm], { type: 'audio/wav' });
  }

  function createWavHeader(dataLength, sampleRate, numChannels, bitsPerSample) {
    const header = new ArrayBuffer(44);
    const view = new DataView(header);

    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataLength, true);
    writeString(view, 8, 'WAVE');

    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numChannels * (bitsPerSample / 8), true);
    view.setUint16(32, numChannels * (bitsPerSample / 8), true);
    view.setUint16(34, bitsPerSample, true);

    writeString(view, 36, 'data');
    view.setUint32(40, dataLength, true);

    return header;
  }

  function writeString(view, offset, string) {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }

  function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

})();
