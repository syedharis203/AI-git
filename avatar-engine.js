/**
 * ============================================
 *  Avatar Engine — Audio-Reactive Lip Sync v2
 * ============================================
 *
 * APPROACH:
 *   1. IDLE:     Show monica_idle.png as a static image on the canvas.
 *   2. SPEAKING: Use Web Audio API to analyze audio frequency in real-time.
 *                Only show lip-sync video when audio amplitude is above threshold.
 *                During pauses in speech, blend back to idle pose.
 *   3. When audio ends, crossfade back to idle PNG.
 *
 * FIX v2: createMediaElementSource is only called ONCE. Reused on subsequent plays.
 *         Added safety timeout to prevent stuck "speaking" state.
 */

// ── Tuning Constants ──
const CROSSFADE_MS = 300;
const SILENCE_THRESHOLD = 0.04;
const SPEECH_THRESHOLD = 0.06;
const SILENCE_DELAY_MS = 150;
const SPEECH_ATTACK_MS = 30;
const ENERGY_SMOOTHING = 0.25;
const VIDEO_SPEED_MIN = 0.85;
const VIDEO_SPEED_MAX = 1.15;
const STUCK_SAFETY_TIMEOUT_MS = 120000; // 2 min max speaking time
const LOOP_CROSSFADE_MS = 400;          // Crossfade duration between video loops
const LOOP_PRE_TRIGGER_S = 0.6;         // Start crossfade this many seconds before video end

class AvatarEngine {
    constructor() {
        this.avatarSection = document.getElementById('avatarSection');
        this.canvas = document.getElementById('avatar-canvas');
        if (this.canvas) {
            this.ctx = this.canvas.getContext('2d');
        }

        this.audioEl = document.getElementById('avatarAudio');
        if (this.audioEl) {
            this.audioEl.crossOrigin = 'anonymous';
        }

        // State
        this.isSpeaking = false;
        this.isThinking = false;
        this.sessionReady = false;

        // Idle image
        this.idleImage = null;
        this.idleImageLoaded = false;
        this._startPromise = null;

        // Speaking videos (double-buffer for seamless looping)
        this.speakVideoA = null;
        this.speakVideoB = null;
        this.speakVideo = null;       // currently active reference
        this._activeVideoSlot = 'A';  // 'A' or 'B'
        this._loopCrossfading = false;
        this._loopCrossfadeStart = 0;
        this._loopCrossfadeBlend = 0; // 0 = fully old, 1 = fully new
        this._loopOldVideo = null;
        this._loopNewVideo = null;

        // ── Audio analysis (Web Audio API) ──
        this.audioContext = null;
        this.analyser = null;
        this.audioSource = null;       // Created ONCE, reused
        this._sourceConnected = false; // Track if source was already created
        this.frequencyData = null;
        this.timeDomainData = null;
        this.currentEnergy = 0;
        this.rawEnergy = 0;
        this.isSpeechActive = false;
        this.lastSpeechTime = 0;
        this.lastSilenceStart = 0;
        this.speechOnsetTime = 0;

        // Lip sync blend
        this.lipBlend = 0.0;
        this.lipBlendTarget = 0.0;

        // Idle ↔ speak crossfade
        this.idleSpeakBlend = 0.0;
        this.idleSpeakTarget = 0.0;
        this.idleSpeakTransStart = 0;
        this.idleSpeakTransFrom = 0;

        // Wave bars
        this.waveBarElements = null;

        // Micro-motion
        this._engineStartTime = performance.now();

        // Animation
        this.animationFrameId = null;

        // Energy tracking
        this._energyHistory = new Float32Array(8);
        this._energyHistoryIdx = 0;
        this._peakEnergy = 0.1;

        // Safety timeout handle
        this._safetyTimer = null;

        this._initAssets();
    }

    // ────────────────────────────────────────
    //  Load idle image + speaking video
    // ────────────────────────────────────────
    _initAssets() {
        console.log('[AvatarEngine] Initializing (audio-reactive lip sync v3 — seamless loop)...');

        // Idle image
        this.idleImage = new Image();
        this.idleImage.onload = () => {
            this.idleImageLoaded = true;
            console.log('[AvatarEngine] Idle image loaded:', this.idleImage.width, '×', this.idleImage.height);
            if (this.sessionReady) this._drawFirstFrame();
        };
        this.idleImage.onerror = (e) => {
            console.error('[AvatarEngine] Failed to load idle image:', e);
        };
        this.idleImage.src = 'avatar_idle.png';

        // Speaking videos — double-buffer for seamless looping
        this.speakVideoA = this._createVideoElement('demo_test_4.mp4');
        this.speakVideoB = this._createVideoElement('demo_test_4.mp4');
        this.speakVideo = this.speakVideoA; // Start with A as active
        this._activeVideoSlot = 'A';

        // Wave bar elements
        this.waveBarElements = document.querySelectorAll('.wave-bar');

        console.log('[AvatarEngine] Assets queued for loading (double-buffered video)');
    }

    /**
     * Create a video element configured for seamless looping.
     * We do NOT use native loop — we manage looping ourselves.
     */
    _createVideoElement(src) {
        const video = document.createElement('video');
        video.src = src;
        video.loop = false;           // We manage looping manually
        video.muted = true;
        video.playsInline = true;
        video.preload = 'auto';
        video.style.display = 'none'; // Hidden — we draw to canvas
        document.body.appendChild(video); // Needs to be in DOM for decode
        video.load();
        return video;
    }

    // ────────────────────────────────────────
    //  Web Audio API — Setup Analyser (ONCE)
    // ────────────────────────────────────────
    _setupAudioAnalyser() {
        if (this.analyser) return; // Already set up

        try {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            this.analyser = this.audioContext.createAnalyser();
            this.analyser.fftSize = 256;
            this.analyser.smoothingTimeConstant = 0.8;

            this.frequencyData = new Uint8Array(this.analyser.frequencyBinCount);
            this.timeDomainData = new Uint8Array(this.analyser.fftSize);

            console.log('[AvatarEngine] Audio analyser created (fftSize=256)');
        } catch (e) {
            console.error('[AvatarEngine] Failed to create AudioContext:', e);
        }
    }

    /**
     * Connect the audio element to the analyser.
     * createMediaElementSource() can only be called ONCE per audio element.
     * We store the reference and reuse it on subsequent calls.
     */
    _connectAudioSource() {
        if (!this.audioContext || !this.analyser || !this.audioEl) return;

        // Resume context if suspended (browser autoplay policy)
        if (this.audioContext.state === 'suspended') {
            this.audioContext.resume().then(() => {
                console.log('[AvatarEngine] AudioContext resumed');
            });
        }

        // Only create the source ONCE
        if (!this._sourceConnected) {
            try {
                this.audioSource = this.audioContext.createMediaElementSource(this.audioEl);
                this.audioSource.connect(this.analyser);
                this.analyser.connect(this.audioContext.destination);
                this._sourceConnected = true;
                console.log('[AvatarEngine] Audio source connected to analyser (first time)');
            } catch (e) {
                console.error('[AvatarEngine] Failed to connect audio source:', e);
            }
        } else {
            console.log('[AvatarEngine] Audio source already connected (reusing)');
        }
    }

    // ────────────────────────────────────────
    //  Analyze current audio frame
    // ────────────────────────────────────────
    _analyzeAudio(now) {
        if (!this.analyser || !this.isSpeaking) {
            this.currentEnergy = 0;
            this.rawEnergy = 0;
            return;
        }

        this.analyser.getByteFrequencyData(this.frequencyData);
        this.analyser.getByteTimeDomainData(this.timeDomainData);

        // RMS energy from time domain
        let sumSquares = 0;
        for (let i = 0; i < this.timeDomainData.length; i++) {
            const normalized = (this.timeDomainData[i] - 128) / 128;
            sumSquares += normalized * normalized;
        }
        const rmsEnergy = Math.sqrt(sumSquares / this.timeDomainData.length);

        // Spectral energy weighted toward speech frequencies
        let speechBandEnergy = 0;
        const speechStart = 2;
        const speechEnd = Math.min(18, this.frequencyData.length);
        for (let i = speechStart; i < speechEnd; i++) {
            speechBandEnergy += this.frequencyData[i] / 255;
        }
        speechBandEnergy /= (speechEnd - speechStart);

        this.rawEnergy = Math.max(rmsEnergy, speechBandEnergy * 0.8);

        // Peak tracking
        if (this.rawEnergy > this._peakEnergy) this._peakEnergy = this.rawEnergy;
        this._peakEnergy *= 0.9995;
        this._peakEnergy = Math.max(this._peakEnergy, 0.1);

        const normalizedEnergy = Math.min(1.0, this.rawEnergy / this._peakEnergy);
        this.currentEnergy += (normalizedEnergy - this.currentEnergy) * ENERGY_SMOOTHING;

        // Speech detection with hysteresis
        if (this.rawEnergy > SPEECH_THRESHOLD) {
            this.lastSpeechTime = now;
            if (!this.isSpeechActive) {
                this.isSpeechActive = true;
                this.speechOnsetTime = now;
            }
        } else if (this.rawEnergy < SILENCE_THRESHOLD) {
            if (this.isSpeechActive && now - this.lastSpeechTime > SILENCE_DELAY_MS) {
                this.isSpeechActive = false;
            }
        }

        // Lip blend target
        if (this.isSpeechActive) {
            const timeSinceOnset = now - this.speechOnsetTime;
            const attackProgress = Math.min(1.0, timeSinceOnset / SPEECH_ATTACK_MS);
            this.lipBlendTarget = attackProgress * Math.min(1.0, this.currentEnergy * 2.5);
        } else {
            this.lipBlendTarget = 0.0;
        }

        // Video playback speed
        if (this.speakVideo && this.isSpeechActive) {
            const speedRange = VIDEO_SPEED_MAX - VIDEO_SPEED_MIN;
            const targetSpeed = VIDEO_SPEED_MIN + speedRange * Math.min(1.0, this.currentEnergy * 2.0);
            this.speakVideo.playbackRate = targetSpeed;
        }
    }

    // ────────────────────────────────────────
    //  Wave bar visualization
    // ────────────────────────────────────────
    _updateWaveBars() {
        if (!this.waveBarElements || this.waveBarElements.length === 0) return;
        if (!this.isSpeaking || !this.frequencyData) {
            for (let i = 0; i < this.waveBarElements.length; i++) {
                this.waveBarElements[i].style.transform = 'scaleY(0.15)';
                this.waveBarElements[i].style.opacity = '0.3';
            }
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
            const scale = this.isSpeechActive ? (0.15 + avg * 0.85) : (0.15 + avg * 0.1);
            const opacity = this.isSpeechActive ? (0.5 + avg * 0.5) : 0.3;
            this.waveBarElements[i].style.transform = `scaleY(${scale.toFixed(3)})`;
            this.waveBarElements[i].style.opacity = opacity.toFixed(2);
            this.waveBarElements[i].style.transition = 'transform 60ms ease-out, opacity 60ms ease-out';
        }
    }

    // ────────────────────────────────────────
    //  Start Session
    // ────────────────────────────────────────
    async startSession() {
        if (this.sessionReady) return true;
        if (this._startPromise) return this._startPromise;

        this._startPromise = (async () => {
            console.log('[AvatarEngine] Starting session...');
            this.sessionReady = true;

            if (!this.idleImageLoaded) {
                await new Promise((resolve) => {
                    const check = () => {
                        if (this.idleImageLoaded) return resolve();
                        setTimeout(check, 50);
                    };
                    check();
                    setTimeout(resolve, 5000);
                });
            }

            this._setupAudioAnalyser();
            this._drawFirstFrame();
            this._engineStartTime = performance.now();
            this.startLoop();

            console.log('[AvatarEngine] Session ready ✓ (audio-reactive lip sync v2)');
            return true;
        })();

        try {
            return await this._startPromise;
        } finally {
            this._startPromise = null;
        }
    }

    _drawFirstFrame() {
        if (!this.ctx || !this.idleImageLoaded) return;
        const container = this.canvas.parentElement;
        const containerW = container ? container.clientWidth : 420;
        const containerH = container ? container.clientHeight : 420;
        const dpr = window.devicePixelRatio || 1;
        this.canvas.width = Math.round(containerW * dpr);
        this.canvas.height = Math.round(containerH * dpr);
        this._drawCover(this.idleImage, this.canvas.width, this.canvas.height);
        console.log('[AvatarEngine] First frame drawn (idle PNG)');
    }

    // ────────────────────────────────────────
    //  Render Loop
    // ────────────────────────────────────────
    startLoop() {
        if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);
        const loop = (timestamp) => {
            this._analyzeAudio(timestamp);
            this._update(timestamp);
            this._updateWaveBars();
            this._draw(timestamp);
            this.animationFrameId = requestAnimationFrame(loop);
        };
        this.animationFrameId = requestAnimationFrame(loop);
    }

    _easeInOutCubic(t) {
        return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    }

    // ────────────────────────────────────────
    //  UPDATE
    // ────────────────────────────────────────
    _update(now) {
        // Main crossfade (idle ↔ speaking)
        if (this.idleSpeakBlend !== this.idleSpeakTarget) {
            const elapsed = now - this.idleSpeakTransStart;
            const progress = Math.min(1.0, elapsed / CROSSFADE_MS);
            const eased = this._easeInOutCubic(progress);
            this.idleSpeakBlend = this.idleSpeakTransFrom +
                (this.idleSpeakTarget - this.idleSpeakTransFrom) * eased;
            if (progress >= 1.0) this.idleSpeakBlend = this.idleSpeakTarget;
        }

        // Lip blend: spring-like smoothing
        const lipDiff = this.lipBlendTarget - this.lipBlend;
        if (this.isSpeechActive) {
            this.lipBlend += lipDiff * 0.35; // Fast attack
        } else {
            this.lipBlend += lipDiff * 0.15; // Slower release
        }
        this.lipBlend = Math.max(0, Math.min(1, this.lipBlend));

        // Keep video always playing during speaking (no pause/resume stuttering)
        if (this.isSpeaking && this.speakVideo && this.speakVideo.paused) {
            this.speakVideo.play().catch(() => {});
        }

        // ── Seamless loop: double-buffer crossfade ──
        if (this.isSpeaking && this.speakVideo) {
            this._updateLoopCrossfade(now);
        }
    }

    /**
     * Monitor the active video's time and start a crossfade to
     * the standby video near the end, for a seamless loop.
     */
    _updateLoopCrossfade(now) {
        const active = this.speakVideo;
        if (!active || !active.duration || active.duration === Infinity) return;

        const timeLeft = active.duration - active.currentTime;

        // When we get close to the end, kick off the crossfade
        if (!this._loopCrossfading && timeLeft <= LOOP_PRE_TRIGGER_S && timeLeft > 0) {
            // Prepare the standby video
            const standby = (this._activeVideoSlot === 'A') ? this.speakVideoB : this.speakVideoA;
            standby.currentTime = 0;
            standby.playbackRate = active.playbackRate;
            standby.play().catch(() => {});

            this._loopCrossfading = true;
            this._loopCrossfadeStart = now;
            this._loopCrossfadeBlend = 0;
            this._loopOldVideo = active;
            this._loopNewVideo = standby;

            console.log('[AvatarEngine] Loop crossfade started (switching slot)');
        }

        // Advance the crossfade blend
        if (this._loopCrossfading) {
            const elapsed = now - this._loopCrossfadeStart;
            this._loopCrossfadeBlend = Math.min(1.0, elapsed / LOOP_CROSSFADE_MS);

            if (this._loopCrossfadeBlend >= 1.0) {
                // Crossfade complete — swap active video
                this._loopCrossfading = false;
                this._loopOldVideo.pause();
                this._loopOldVideo.currentTime = 0;

                // Swap slots
                this._activeVideoSlot = (this._activeVideoSlot === 'A') ? 'B' : 'A';
                this.speakVideo = this._loopNewVideo;
                this._loopOldVideo = null;
                this._loopNewVideo = null;

                console.log('[AvatarEngine] Loop crossfade complete — now on slot', this._activeVideoSlot);
            }
        }
    }

    // ────────────────────────────────────────
    //  DRAW
    // ────────────────────────────────────────
    _draw(now) {
        if (!this.ctx) return;

        const container = this.canvas.parentElement;
        const containerW = container ? container.clientWidth : 420;
        const containerH = container ? container.clientHeight : 420;
        const dpr = window.devicePixelRatio || 1;
        const targetW = Math.round(containerW * dpr);
        const targetH = Math.round(containerH * dpr);

        if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
            this.canvas.width = targetW;
            this.canvas.height = targetH;
        }

        const w = this.canvas.width;
        const h = this.canvas.height;

        const t = now - this._engineStartTime;
        const breathePhase = (t / 3500) * Math.PI * 2;
        const baseScale = 1.0 + Math.sin(breathePhase) * 0.0015;
        const yOff = Math.sin(breathePhase + 0.3) * 0.4;
        const swayPhase = (t / 5200) * Math.PI * 2;
        const xOff = Math.sin(swayPhase) * 0.25;

        const isVideoDrawable = (v) => !!(v && v.videoWidth > 0 && v.readyState >= 2);
        const idleReady = this.idleImageLoaded;

        // Determine which video(s) to draw
        let primaryVideo = this.speakVideo;
        let primaryReady = isVideoDrawable(primaryVideo);

        if (!idleReady && !primaryReady) return;

        this.ctx.fillStyle = '#0a0a14';
        this.ctx.fillRect(0, 0, w, h);

        this.ctx.save();
        const cx = w / 2;
        const cy = h / 2;
        this.ctx.translate(cx + xOff, cy + yOff);
        this.ctx.scale(baseScale, baseScale);
        this.ctx.translate(-cx, -cy);

        let effectiveBlend;
        if (this.isSpeaking && primaryReady) {
            effectiveBlend = this.idleSpeakBlend * (0.15 + 0.85 * this.lipBlend);
        } else {
            effectiveBlend = primaryReady ? this.idleSpeakBlend : 0;
        }

        // Draw idle image
        if (effectiveBlend < 0.999 && idleReady) {
            this.ctx.globalAlpha = 1.0 - effectiveBlend;
            this._drawCover(this.idleImage, w, h);
        }

        // Draw speaking video(s) — handle loop crossfade
        if (effectiveBlend > 0.001) {
            if (this._loopCrossfading && this._loopOldVideo && this._loopNewVideo) {
                // During loop crossfade: blend old and new video
                const loopBlend = this._easeInOutCubic(this._loopCrossfadeBlend);
                const oldReady = isVideoDrawable(this._loopOldVideo);
                const newReady = isVideoDrawable(this._loopNewVideo);

                if (oldReady && loopBlend < 0.999) {
                    this.ctx.globalAlpha = effectiveBlend * (1.0 - loopBlend);
                    this._drawCover(this._loopOldVideo, w, h);
                }
                if (newReady && loopBlend > 0.001) {
                    this.ctx.globalAlpha = effectiveBlend * loopBlend;
                    this._drawCover(this._loopNewVideo, w, h);
                }
            } else if (primaryReady) {
                // Normal single-video draw
                this.ctx.globalAlpha = effectiveBlend;
                this._drawCover(primaryVideo, w, h);
            }
        }

        this.ctx.globalAlpha = 1.0;
        this.ctx.restore();
    }

    // ────────────────────────────────────────
    //  Cover-fit draw
    // ────────────────────────────────────────
    _drawCover(source, canvasW, canvasH) {
        const vw = source.videoWidth || source.naturalWidth || source.width;
        const vh = source.videoHeight || source.naturalHeight || source.height;
        if (!vw || !vh) return;

        const videoAspect = vw / vh;
        const canvasAspect = canvasW / canvasH;
        let srcX, srcY, srcW, srcH;

        if (videoAspect > canvasAspect) {
            srcH = vh; srcW = vh * canvasAspect;
            srcX = (vw - srcW) / 2; srcY = 0;
        } else {
            srcW = vw; srcH = vw / canvasAspect;
            srcX = 0; srcY = (vh - srcH) * 0.15;
        }

        const zoom = 1.02;
        const zx = canvasW * (zoom - 1) / 2;
        const zy = canvasH * (zoom - 1) / 2;
        this.ctx.drawImage(source, srcX, srcY, srcW, srcH, -zx, -zy, canvasW * zoom, canvasH * zoom);
    }

    // ────────────────────────────────────────
    //  Play Audio + Speaking Video (with safety timeout)
    // ────────────────────────────────────────
    async playAudioSync(audioUrl) {
        return new Promise((resolve) => {
            if (!this.audioEl) {
                console.warn('[AvatarEngine] No audio element found!');
                return resolve();
            }

            console.log('[AvatarEngine] playAudioSync called with:', audioUrl);

            let settled = false;
            let noCorsRetried = false;
            let speakingStarted = false;

            const finish = () => {
                if (settled) return;
                settled = true;
                // Clear safety timer
                if (this._safetyTimer) {
                    clearTimeout(this._safetyTimer);
                    this._safetyTimer = null;
                }
                this.setIdle();
                resolve();
            };

            // ── SAFETY: prevent stuck state ──
            // If audio hasn't ended after STUCK_SAFETY_TIMEOUT_MS, force idle
            this._safetyTimer = setTimeout(() => {
                if (!settled) {
                    console.warn('[AvatarEngine] ⚠ Safety timeout! Forcing idle after', STUCK_SAFETY_TIMEOUT_MS, 'ms');
                    finish();
                }
            }, STUCK_SAFETY_TIMEOUT_MS);

            const startSpeaking = () => {
                if (speakingStarted) return;
                speakingStarted = true;
                this._connectAudioSource();
                this._goSpeaking();
            };

            const tryPlay = () => {
                this.audioEl.play().then(() => {
                    startSpeaking();
                }).catch((e) => {
                    console.warn('[AvatarEngine] Audio play() failed:', e);
                    // If play fails, don't get stuck — resolve after short delay
                    setTimeout(() => {
                        if (!settled) finish();
                    }, 2000);
                });
            };

            // Clear previous handlers
            this.audioEl.oncanplaythrough = null;
            this.audioEl.oncanplay = null;
            this.audioEl.onended = null;
            this.audioEl.onerror = null;
            this.audioEl.onplaying = null;
            this.audioEl.onloadeddata = null;

            this.audioEl.pause();
            this.audioEl.currentTime = 0;

            this.audioEl.crossOrigin = 'anonymous';
            this.audioEl.src = audioUrl;

            console.log('[AvatarEngine] Loading audio from:', audioUrl);

            this.audioEl.onloadeddata = () => {
                console.log('[AvatarEngine] Audio loaded, duration:', this.audioEl.duration);
            };

            this.audioEl.oncanplay = () => {
                if (!speakingStarted) tryPlay();
            };

            this.audioEl.onended = () => {
                console.log('[AvatarEngine] Audio ended → idle');
                finish();
            };

            this.audioEl.onerror = (e) => {
                const err = this.audioEl.error;
                console.error('[AvatarEngine] Audio error:', err ? `code=${err.code} message=${err.message}` : e);
                if (this.audioEl.crossOrigin === 'anonymous' && !noCorsRetried) {
                    noCorsRetried = true;
                    console.log('[AvatarEngine] Retrying without crossOrigin...');
                    this.audioEl.crossOrigin = '';
                    this.audioEl.src = audioUrl;
                    this.audioEl.load();
                    tryPlay();
                    return;
                }
                finish();
            };

            this.audioEl.onplaying = () => {
                console.log(`[AvatarEngine] Audio playing: duration=${(this.audioEl.duration * 1000).toFixed(0)}ms`);
                startSpeaking();
            };

            this.audioEl.load();

            // Small delay to let the audio element initialize
            setTimeout(() => {
                if (!speakingStarted) tryPlay();
            }, 100);
        });
    }

    // ────────────────────────────────────────
    //  Speaking mode
    // ────────────────────────────────────────
    _goSpeaking() {
        if (this.isSpeaking) return;
        this.isSpeaking = true;
        this.isThinking = false;

        console.log('[AvatarEngine] → Speaking (audio-reactive, seamless loop)');

        // Reset lip sync state
        this.lipBlend = 0;
        this.lipBlendTarget = 0;
        this.isSpeechActive = false;
        this.lastSpeechTime = 0;
        this._peakEnergy = 0.1;
        this._energyHistory.fill(0);

        // Reset loop crossfade state
        this._loopCrossfading = false;
        this._loopCrossfadeBlend = 0;
        this._loopOldVideo = null;
        this._loopNewVideo = null;

        // Start active video from beginning
        this.speakVideo = this.speakVideoA;
        this._activeVideoSlot = 'A';
        this.speakVideo.currentTime = 0;
        this.speakVideo.playbackRate = 1.0;
        this.speakVideo.play().catch(() => {});

        // Pre-load standby video to be ready
        this.speakVideoB.currentTime = 0;
        this.speakVideoB.load();

        if (this.audioContext && this.audioContext.state === 'suspended') {
            this.audioContext.resume();
        }

        this.idleSpeakTransFrom = this.idleSpeakBlend;
        this.idleSpeakTarget = 1.0;
        this.idleSpeakTransStart = performance.now();

        if (this.avatarSection) {
            this.avatarSection.classList.add('speaking');
            this.avatarSection.classList.remove('idle');
        }
    }

    // ────────────────────────────────────────
    //  Idle mode
    // ────────────────────────────────────────
    _goIdle() {
        this.isSpeaking = false;
        this.isThinking = false;
        this.isSpeechActive = false;
        this.lipBlend = 0;
        this.lipBlendTarget = 0;
        this.currentEnergy = 0;
        this.rawEnergy = 0;

        // Stop both video buffers
        if (this.speakVideoA) {
            this.speakVideoA.pause();
            this.speakVideoA.playbackRate = 1.0;
        }
        if (this.speakVideoB) {
            this.speakVideoB.pause();
            this.speakVideoB.playbackRate = 1.0;
        }

        // Reset loop crossfade
        this._loopCrossfading = false;
        this._loopCrossfadeBlend = 0;
        this._loopOldVideo = null;
        this._loopNewVideo = null;

        this._updateWaveBars();

        this.idleSpeakTransFrom = this.idleSpeakBlend;
        this.idleSpeakTarget = 0.0;
        this.idleSpeakTransStart = performance.now();

        if (this.avatarSection) {
            this.avatarSection.classList.remove('speaking');
            this.avatarSection.classList.add('idle');
        }

        console.log('[AvatarEngine] → Idle');
    }

    // ────────────────────────────────────────
    //  Public API
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
        if (this.isSpeaking && this.audioEl) {
            this.audioEl.play().catch(() => {});
        }
    }
    smile() {}

    async speak(text) {
        console.warn('[AvatarEngine] speak(text) needs audioUrl. Use playAudioSync().');
    }

    interrupt() {
        if (this.audioEl) {
            this.audioEl.pause();
            this.audioEl.currentTime = 0;
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
        if (this.speakVideoA) { this.speakVideoA.pause(); this.speakVideoA.remove(); }
        if (this.speakVideoB) { this.speakVideoB.pause(); this.speakVideoB.remove(); }
        if (this.audioContext) {
            try { this.audioContext.close(); } catch (e) {}
        }
    }
}

window.AvatarEngine = AvatarEngine;
export default AvatarEngine;
