/**
 * ============================================
 *  Avatar Engine — Simli WebRTC Integration v5
 * ============================================
 *
 * Replaces pre-recorded video + idle PNG with
 * Simli's real-time avatar via WebRTC.
 *
 * Audio from n8n (ElevenLabs) is fetched, decoded
 * to PCM16 16kHz, and streamed to Simli which
 * returns lip-synced video of the avatar.
 *
 * Flow:
 *   1. On page load → connect to Simli WebRTC
 *   2. Simli streams idle avatar video to <video>
 *   3. When n8n returns audioUrl → fetch audio →
 *      decode to PCM16 16kHz → send chunks to Simli
 *   4. Simli renders lip-synced video in real time
 */

// ── Simli Config ──
const SIMLI_API_KEY = 'hiieoy2b3l6sv4scn5jwoo';
const SIMLI_FACE_ID = 'e4fefd70-62b1-499d-bf6c-51c1a1d0501c';
const SIMLI_API_URL = 'https://api.simli.ai';
const SIMLI_WS_URL = 'wss://api.simli.ai';

// Audio chunk settings — optimized for smooth Simli playback
const AUDIO_CHUNK_SIZE = 3200;       // 3200 bytes = 100ms of 16kHz PCM16 mono — sweet spot
const AUDIO_SAMPLE_RATE = 16000;     // Simli requires 16kHz PCM16
const SEND_INTERVAL_MS = 25;         // send every 25ms — fast burst feeding
const WS_BUFFER_THRESHOLD = 16000;   // pause sending if WebSocket buffer exceeds this

class AvatarEngine {
    constructor() {
        this.avatarSection = document.getElementById('avatarSection');

        // Simli uses <video> and <audio> elements directly (WebRTC streams)
        this.videoEl = document.getElementById('simli-video');
        this.audioOutEl = document.getElementById('simli-audio');
        if (this.audioOutEl) {
            this.audioOutEl.volume = 0.6; // Control aggressive volume
        }

        // State
        this.isSpeaking = false;
        this.isThinking = false;
        this.sessionReady = false;

        // Simli WebRTC connection
        this.pc = null;                 // RTCPeerConnection
        this.wsConnection = null;       // WebSocket for signaling + audio data
        this.sessionToken = null;
        this._startPromise = null;

        // Audio sending state
        this._sendingAudio = false;
        this._interrupted = false;

        // Wave bars (keep for visualizer)
        this.waveBarElements = document.querySelectorAll('.wave-bar');

        // For audio analysis (visualizer)
        this.audioContext = null;
        this.analyser = null;
        this.audioSource = null;
        this._sourceConnected = false;
        this.frequencyData = null;
        this.currentEnergy = 0;
        this.isSpeechActive = false;

        // Animation for wave bars
        this.animationFrameId = null;

        // Safety timeout
        this._safetyTimer = null;

        console.log('[AvatarEngine] Simli integration v5 initialized');
    }

    // ────────────────────────────────────────
    //  Start Session — Connect to Simli
    // ────────────────────────────────────────
    async startSession() {
        if (this.sessionReady) return true;
        if (this._startPromise) return this._startPromise;

        this._startPromise = (async () => {
            try {
                console.log('[AvatarEngine] Starting Simli session...');

                // Step 1: Get session token from Simli
                const tokenRes = await fetch(`${SIMLI_API_URL}/compose/token`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-simli-api-key': SIMLI_API_KEY,
                    },
                    body: JSON.stringify({
                        faceId: SIMLI_FACE_ID,
                        handleSilence: true,
                        maxSessionLength: 3600,
                        maxIdleTime: 60, // Reduced from 300 to 60 for cost saving
                    }),
                });

                if (!tokenRes.ok) {
                    const errText = await tokenRes.text();
                    throw new Error(`Token request failed: ${tokenRes.status} - ${errText}`);
                }

                const tokenData = await tokenRes.json();
                this.sessionToken = tokenData.session_token;
                console.log('[AvatarEngine] Got session token:', this.sessionToken.substring(0, 20) + '...');

                // Step 2: Get ICE servers
                let iceServers = [{ urls: ['stun:stun.l.google.com:19302'] }];
                try {
                    const iceRes = await fetch(`${SIMLI_API_URL}/compose/ice`, {
                        method: 'GET',
                        headers: {
                            'x-simli-api-key': SIMLI_API_KEY,
                        },
                    });
                    if (iceRes.ok) {
                        iceServers = await iceRes.json();
                        console.log('[AvatarEngine] Got ICE servers from Simli');
                    }
                } catch (e) {
                    console.warn('[AvatarEngine] ICE server fetch failed, using STUN fallback');
                }

                // Step 3: Create WebRTC peer connection
                const config = {
                    sdpSemantics: 'unified-plan',
                    iceServers: iceServers,
                };

                this.pc = new RTCPeerConnection(config);

                // Listen for remote tracks (video + audio from Simli)
                this.pc.addEventListener('track', (evt) => {
                    console.log('[AvatarEngine] Received track:', evt.track.kind);
                    if (evt.track.kind === 'video') {
                        if (this.videoEl) {
                            this.videoEl.srcObject = evt.streams[0];
                            this.videoEl.play().catch(() => { });
                            console.log('[AvatarEngine] Video stream attached');
                        }
                    } else if (evt.track.kind === 'audio') {
                        if (this.audioOutEl) {
                            this.audioOutEl.srcObject = evt.streams[0];
                            this.audioOutEl.play().catch(() => { });
                            console.log('[AvatarEngine] Audio stream attached');

                            // Setup analyser for wave visualization
                            this._setupAudioAnalyser(evt.streams[0]);
                        }
                    }
                });

                // ICE connection state
                this.pc.addEventListener('iceconnectionstatechange', () => {
                    console.log('[AvatarEngine] ICE state:', this.pc.iceConnectionState);
                    if (this.pc.iceConnectionState === 'failed' || this.pc.iceConnectionState === 'disconnected') {
                        console.warn('[AvatarEngine] ICE connection issue');
                    }
                });

                // Add recv-only transceivers
                this.pc.addTransceiver('audio', { direction: 'recvonly' });
                this.pc.addTransceiver('video', { direction: 'recvonly' });

                // Step 4: Create offer
                const offer = await this.pc.createOffer();
                await this.pc.setLocalDescription(offer);

                // Wait for ICE gathering
                await this._waitForIceGathering();

                const localDesc = this.pc.localDescription;
                console.log('[AvatarEngine] ICE gathering complete, connecting WebSocket...');

                // Step 5: Connect via WebSocket
                const wsURL = new URL(`${SIMLI_WS_URL}/compose/webrtc/p2p`);
                wsURL.searchParams.set('session_token', this.sessionToken);

                await this._connectWebSocket(wsURL.toString(), localDesc);

                this.sessionReady = true;
                this._startAnimationLoop();
                console.log('[AvatarEngine] Simli session ready ✓');
                return true;

            } catch (err) {
                console.error('[AvatarEngine] Session start failed:', err);
                return false;
            }
        })();

        try {
            return await this._startPromise;
        } finally {
            this._startPromise = null;
        }
    }

    // ────────────────────────────────────────
    //  Wait for ICE gathering to complete
    // ────────────────────────────────────────
    _waitForIceGathering() {
        return new Promise((resolve) => {
            if (this.pc.iceGatheringState === 'complete') {
                resolve();
                return;
            }

            let candidateCount = 0;
            let lastCount = -1;

            const checkStable = () => {
                if (this.pc.iceGatheringState === 'complete' || candidateCount === lastCount) {
                    resolve();
                } else {
                    lastCount = candidateCount;
                    setTimeout(checkStable, 250);
                }
            };

            this.pc.addEventListener('icecandidate', (event) => {
                if (event.candidate) {
                    candidateCount++;
                } else {
                    // null candidate = gathering complete
                    resolve();
                }
            });

            setTimeout(checkStable, 500);

            // Safety: don't wait forever
            setTimeout(resolve, 10000);
        });
    }

    // ────────────────────────────────────────
    //  Connect WebSocket for signaling + data
    // ────────────────────────────────────────
    _connectWebSocket(wsUrl, localDesc) {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(wsUrl);
            this.wsConnection = ws;

            let answerReceived = false;

            ws.addEventListener('open', () => {
                console.log('[AvatarEngine] WebSocket connected, sending SDP offer');
                ws.send(JSON.stringify({
                    sdp: localDesc.sdp,
                    type: localDesc.type,
                }));
            });

            ws.addEventListener('message', async (evt) => {
                const data = evt.data;

                if (data === 'START') {
                    console.log('[AvatarEngine] Simli sent START signal');
                    // Send minimal warmup silence (200ms worth, not 2 seconds)
                    setTimeout(() => {
                        if (this.wsConnection && this.wsConnection.readyState === WebSocket.OPEN) {
                            this.wsConnection.send(new Uint8Array(6400)); // 200ms at 16kHz 16-bit
                            console.log('[AvatarEngine] Sent warmup silence (200ms)');
                        }
                    }, 50);
                    return;
                }

                if (data === 'STOP') {
                    console.log('[AvatarEngine] Simli sent STOP signal');
                    this.destroy();
                    return;
                }

                // Try to parse as SDP answer
                try {
                    const message = JSON.parse(data);
                    if (message.type === 'answer' && !answerReceived) {
                        answerReceived = true;
                        console.log('[AvatarEngine] Received SDP answer');
                        await this.pc.setRemoteDescription(message);
                        resolve();
                    }
                } catch (e) {
                    // Not JSON, ignore
                }
            });

            ws.addEventListener('error', (err) => {
                console.error('[AvatarEngine] WebSocket error:', err);
                reject(err);
            });

            ws.addEventListener('close', () => {
                console.log('[AvatarEngine] WebSocket closed');
            });

            // Timeout
            setTimeout(() => {
                if (!answerReceived) {
                    reject(new Error('WebSocket SDP answer timeout'));
                }
            }, 15000);
        });
    }

    // ────────────────────────────────────────
    //  Audio Analyser for wave visualization
    // ────────────────────────────────────────
    _setupAudioAnalyser(mediaStream) {
        try {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            if (!AudioContextClass) return;

            this.audioContext = new AudioContextClass();
            this.analyser = this.audioContext.createAnalyser();
            this.analyser.fftSize = 256;
            this.analyser.smoothingTimeConstant = 0.8;
            this.frequencyData = new Uint8Array(this.analyser.frequencyBinCount);

            const source = this.audioContext.createMediaStreamSource(mediaStream);
            source.connect(this.analyser);
            // Don't connect to destination — the <audio> element handles playback
            this._sourceConnected = true;
            console.log('[AvatarEngine] Audio analyser connected');
        } catch (e) {
            console.warn('[AvatarEngine] Audio analyser setup failed:', e);
        }
    }

    // ────────────────────────────────────────
    //  Animation loop (for wave bars)
    // ────────────────────────────────────────
    _startAnimationLoop() {
        if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);

        const loop = () => {
            this._updateWaveBars();
            this.animationFrameId = requestAnimationFrame(loop);
        };
        this.animationFrameId = requestAnimationFrame(loop);
    }

    _updateWaveBars() {
        if (!this.waveBarElements || this.waveBarElements.length === 0) return;

        if (!this.isSpeaking || !this.analyser || !this.frequencyData) {
            for (let i = 0; i < this.waveBarElements.length; i++) {
                this.waveBarElements[i].style.transform = 'scaleY(0.15)';
                this.waveBarElements[i].style.opacity = '0.3';
            }
            return;
        }

        try {
            this.analyser.getByteFrequencyData(this.frequencyData);
        } catch (e) {
            return;
        }

        const binsPerBar = Math.floor(this.frequencyData.length / this.waveBarElements.length);
        for (let i = 0; i < this.waveBarElements.length; i++) {
            let sum = 0;
            const start = i * binsPerBar;
            for (let j = start; j < start + binsPerBar && j < this.frequencyData.length; j++) {
                sum += this.frequencyData[j];
            }
            const avg = sum / binsPerBar / 255;
            const scale = 0.15 + avg * 0.85;
            const opacity = 0.5 + avg * 0.5;
            this.waveBarElements[i].style.transform = `scaleY(${scale.toFixed(3)})`;
            this.waveBarElements[i].style.opacity = opacity.toFixed(2);
        }
    }

    // ────────────────────────────────────────
    //  Play Audio — Fetch, decode to PCM16, send to Simli
    // ────────────────────────────────────────
    async playAudioSync(audioUrl, onStart = null) {
        if (!this.wsConnection || this.wsConnection.readyState !== WebSocket.OPEN) {
            console.warn('[AvatarEngine] WebSocket not connected, cannot send audio');
            return;
        }

        console.log('[AvatarEngine] playAudioSync called:', audioUrl);

        // Add cache-busting
        const separator = audioUrl.includes('?') ? '&' : '?';
        const freshUrl = `${audioUrl}${separator}_cb=${Date.now()}`;

        this._interrupted = false;
        this._goSpeaking();

        try {
            // Fetch the audio file
            const t0 = performance.now();
            console.log('[AvatarEngine] Fetching audio...');
            const response = await fetch(freshUrl);
            if (!response.ok) throw new Error(`Audio fetch failed: ${response.status}`);

            const arrayBuffer = await response.arrayBuffer();
            console.log(`[AvatarEngine] Audio fetched: ${(arrayBuffer.byteLength / 1024).toFixed(1)}KB in ${(performance.now() - t0).toFixed(0)}ms`);

            // Decode to raw audio
            const audioCtx = this.audioContext || new (window.AudioContext || window.webkitAudioContext)();
            const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
            const audioDurationMs = audioBuffer.duration * 1000;

            console.log(`[AvatarEngine] Audio decoded: ${audioBuffer.duration.toFixed(2)}s, ${audioBuffer.sampleRate}Hz`);

            // Convert to PCM16 at 16kHz mono
            const pcm16Data = this._audioBufToPCM16(audioBuffer);
            console.log(`[AvatarEngine] PCM16 data: ${(pcm16Data.byteLength / 1024).toFixed(1)}KB`);

            // ── EXACT REAL-TIME STREAMING — 1x Speed ──
            // Simli lip-sync expects audio streamed at real-time (like a microphone) to generate smooth WebRTC video frames.
            const uint8 = new Uint8Array(pcm16Data);
            const CHUNK_SIZE = 3200; // 100ms of PCM16 16kHz Mono
            const CHUNK_DURATION_MS = 100;
            const totalChunks = Math.ceil(uint8.length / CHUNK_SIZE);
            let offset = 0;
            let chunksSent = 0;
            const sendStart = performance.now();

            console.log(`[AvatarEngine] Streaming ${totalChunks} chunks (${CHUNK_SIZE}B each, ${CHUNK_DURATION_MS}ms) at 1x real-time to Simli...`);

            while (offset < uint8.length) {
                if (this._interrupted || !this.wsConnection || this.wsConnection.readyState !== WebSocket.OPEN) {
                    console.warn('[AvatarEngine] Send aborted (interrupted or WS closed)');
                    break;
                }

                if (chunksSent === 0 && onStart) {
                    onStart();
                }

                const end = Math.min(offset + CHUNK_SIZE, uint8.length);
                const chunk = uint8.subarray(offset, end);
                this.wsConnection.send(chunk);
                offset = end;
                chunksSent++;

                // Wait exactly until the NEXT chunk is due (1x real-time pacing)
                const targetTime = sendStart + (chunksSent * CHUNK_DURATION_MS);
                const delay = targetTime - performance.now();
                if (delay > 0) {
                    await new Promise(r => setTimeout(r, delay));
                }
            }

            const sendElapsed = performance.now() - sendStart;
            console.log(`[AvatarEngine] All ${chunksSent} chunks streamed in ${sendElapsed.toFixed(0)}ms`);

            // Audio is already mostly played during the streaming loop.
            // Just wait a tiny bit for the final WebRTC frames to arrive.
            const remainingWait = 500;
            console.log(`[AvatarEngine] Waiting ${(remainingWait / 1000).toFixed(1)}s for tail playback...`);

            await new Promise((resolve) => {
                this._safetyTimer = setTimeout(() => {
                    this._safetyTimer = null;
                    resolve();
                }, remainingWait);
            });

        } catch (err) {
            console.error('[AvatarEngine] Audio processing error:', err);
        } finally {
            this._goIdle();
        }
    }

    // ────────────────────────────────────────
    //  Convert AudioBuffer to PCM16 Int16 at 16kHz mono
    // ────────────────────────────────────────
    _audioBufToPCM16(audioBuffer) {
        const sourceSampleRate = audioBuffer.sampleRate;
        const targetSampleRate = AUDIO_SAMPLE_RATE;

        // Get mono channel data
        let channelData;
        if (audioBuffer.numberOfChannels === 1) {
            channelData = audioBuffer.getChannelData(0);
        } else {
            // Mix to mono
            const ch0 = audioBuffer.getChannelData(0);
            const ch1 = audioBuffer.getChannelData(1);
            channelData = new Float32Array(ch0.length);
            for (let i = 0; i < ch0.length; i++) {
                channelData[i] = (ch0[i] + ch1[i]) / 2;
            }
        }

        // Resample to 16kHz
        const ratio = sourceSampleRate / targetSampleRate;
        const targetLength = Math.floor(channelData.length / ratio);
        const result = new Int16Array(targetLength);

        for (let i = 0; i < targetLength; i++) {
            const srcIndex = i * ratio;
            const srcFloor = Math.floor(srcIndex);
            const srcCeil = Math.min(srcFloor + 1, channelData.length - 1);
            const frac = srcIndex - srcFloor;

            // Linear interpolation
            const sample = channelData[srcFloor] * (1 - frac) + channelData[srcCeil] * frac;

            // Clamp and convert to Int16
            const clamped = Math.max(-1, Math.min(1, sample));
            result[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;
        }

        return result.buffer;
    }

    // ────────────────────────────────────────
    //  Speaking/Idle state management
    // ────────────────────────────────────────
    _goSpeaking() {
        if (this.isSpeaking) return;
        this.isSpeaking = true;
        this.isThinking = false;

        console.log('[AvatarEngine] → Speaking');

        if (this.avatarSection) {
            this.avatarSection.classList.add('speaking');
            this.avatarSection.classList.remove('idle');
        }
    }

    _goIdle() {
        this.isSpeaking = false;
        this.isThinking = false;
        this.isSpeechActive = false;
        this.currentEnergy = 0;

        this._updateWaveBars();

        if (this.avatarSection) {
            this.avatarSection.classList.remove('speaking');
            this.avatarSection.classList.add('idle');
        }

        console.log('[AvatarEngine] → Idle');
    }

    // ────────────────────────────────────────
    //  Public API (same interface as before)
    // ────────────────────────────────────────
    setSpeaking(val) { val ? this._goSpeaking() : this._goIdle(); }

    setThinking() {
        this.isThinking = true;
        if (this.avatarSection) {
            this.avatarSection.classList.remove('idle');
            this.avatarSection.classList.add('speaking');
        }
    }

    setIdle() { this._goIdle(); }
    startLipSync() { this._goSpeaking(); }
    stopLipSync() { this._goIdle(); }

    resumePlayback() {
        if (this.videoEl && this.videoEl.paused) {
            this.videoEl.play().catch(() => { });
        }
        if (this.audioOutEl && this.audioOutEl.paused) {
            this.audioOutEl.play().catch(() => { });
        }
        if (this.audioContext && this.audioContext.state === 'suspended') {
            this.audioContext.resume().catch(() => { });
        }
    }

    smile() { }

    async speak(text) {
        console.warn('[AvatarEngine] speak(text) needs audioUrl. Use playAudioSync().');
    }

    interrupt() {
        this._interrupted = true;

        // Clear audio buffer on Simli
        if (this.wsConnection && this.wsConnection.readyState === WebSocket.OPEN) {
            this.wsConnection.send('SKIP');
        }

        if (this._safetyTimer) {
            clearTimeout(this._safetyTimer);
            this._safetyTimer = null;
        }

        this._goIdle();
    }

    async destroy() {
        this.interrupt();
        if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);

        // Close WebSocket
        if (this.wsConnection) {
            try {
                this.wsConnection.send('DONE');
            } catch (e) { }
            this.wsConnection.close();
            this.wsConnection = null;
        }

        // Close peer connection
        if (this.pc) {
            try {
                if (this.pc.getTransceivers) {
                    this.pc.getTransceivers().forEach((t) => {
                        if (t.stop) t.stop();
                    });
                }
                this.pc.getSenders().forEach((sender) => {
                    if (sender.track) sender.track.stop();
                });
                this.pc.close();
            } catch (e) { }
            this.pc = null;
        }

        if (this.audioContext) {
            try { this.audioContext.close(); } catch (e) { }
            this.audioContext = null;
        }

        this.sessionReady = false;
        this._startPromise = null; // Allows re-initializing later
        console.log('[AvatarEngine] Destroyed');
    }
}

window.AvatarEngine = AvatarEngine;
export default AvatarEngine;
