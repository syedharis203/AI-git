/**
 * ============================================
 *  Avatar Engine — Production-Ready v4
 * ============================================
 *
 * FIXED:
 *   — Safari & Chrome full compatibility
 *   — Video preloading to prevent first-message sync issues
 *   — Single video with native loop (no double-buffer overhead)
 *   — Idle-state FPS throttle (saves CPU/battery on mobile)
 *   — Cache-busting on audio URLs
 *   — Robust error recovery (never gets stuck)
 *   — Proper autoplay policy handling
 */

// ── Tuning Constants ──
const CROSSFADE_MS = 250;
const SILENCE_THRESHOLD = 0.04;
const SPEECH_THRESHOLD = 0.06;
const SILENCE_DELAY_MS = 150;
const SPEECH_ATTACK_MS = 30;
const ENERGY_SMOOTHING = 0.25;
const VIDEO_SPEED_MIN = 0.9;
const VIDEO_SPEED_MAX = 1.1;
const STUCK_SAFETY_TIMEOUT_MS = 120000;
const IDLE_FPS = 10;         // Throttle to 10fps when idle
const SPEAKING_FPS = 60;     // Full 60fps when speaking

class AvatarEngine {
    constructor() {
        this.avatarSection = document.getElementById('avatarSection');
        this.canvas = document.getElementById('avatar-canvas');
        if (this.canvas) {
            this.ctx = this.canvas.getContext('2d', { alpha: false });
        }

        this.audioEl = document.getElementById('avatarAudio');
        if (this.audioEl) {
            this.audioEl.crossOrigin = 'anonymous';
            this.audioEl.preload = 'auto';
            this.audioEl.volume = 0.5; // Lower volume to control aggressiveness
        }

        // State
        this.isSpeaking = false;
        this.isThinking = false;
        this.sessionReady = false;

        // Idle image
        this.idleImage = null;
        this.idleImageLoaded = false;
        this._startPromise = null;

        // Speaking video — single element with native loop
        this.speakVideo = null;
        this._videoReady = false;
        this._videoReadyPromise = null;

        // ── Audio analysis (Web Audio API) ──
        this.audioContext = null;
        this.analyser = null;
        this.audioSource = null;
        this._sourceConnected = false;
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
        this._lastFrameTime = 0;
        this._targetFps = IDLE_FPS;

        // Energy tracking
        this._energyHistory = new Float32Array(8);
        this._energyHistoryIdx = 0;
        this._peakEnergy = 0.1;

        // Safety timeout handle
        this._safetyTimer = null;

        // Track if user has interacted (for autoplay)
        this._userInteracted = false;
        this._pendingVideoPlay = false;

        this._initAssets();
    }

    // ────────────────────────────────────────
    //  Load idle image + speaking video
    // ────────────────────────────────────────
    _initAssets() {
        console.log('[AvatarEngine] Initializing v4 (production-ready)...');

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

        // Speaking video — single element, native loop
        this.speakVideo = this._createVideoElement('demo_test_4.mp4');

        // Pre-decode video for instant first-frame rendering
        this._preDecodeVideo();

        // Wave bar elements
        this.waveBarElements = document.querySelectorAll('.wave-bar');

        console.log('[AvatarEngine] Assets queued for loading');
    }

    /**
     * Create a single video element with native looping.
     * Native loop avoids the double-buffer overhead and is smoother.
     */
    _createVideoElement(src) {
        const video = document.createElement('video');
        video.src = src;
        video.loop = true;          // Native loop — smooth and simple
        video.muted = true;
        video.playsInline = true;
        video.preload = 'auto';
        video.setAttribute('playsinline', '');  // iOS Safari
        video.setAttribute('webkit-playsinline', ''); // Older iOS
        video.style.display = 'none';
        document.body.appendChild(video);
        video.load();
        return video;
    }

    /**
     * Pre-decode the video so first frame is ready instantly.
     * This prevents the "audio plays but video doesn't show" issue.
     */
    _preDecodeVideo() {
        if (!this.speakVideo) return;

        this._videoReadyPromise = new Promise((resolve) => {
            const onReady = () => {
                this._videoReady = true;
                console.log('[AvatarEngine] Video pre-decoded and ready');
                resolve(true);
            };

            // If video is already loaded enough
            if (this.speakVideo.readyState >= 3) {
                onReady();
                return;
            }

            this.speakVideo.addEventListener('canplaythrough', onReady, { once: true });

            // Fallback: readyState >= 2 is good enough
            this.speakVideo.addEventListener('canplay', () => {
                if (!this._videoReady) {
                    this._videoReady = true;
                    console.log('[AvatarEngine] Video ready (canplay)');
                    resolve(true);
                }
            }, { once: true });

            // Safety timeout — don't wait forever
            setTimeout(() => {
                if (!this._videoReady) {
                    this._videoReady = this.speakVideo.readyState >= 2;
                    console.log('[AvatarEngine] Video pre-decode timeout, readyState:', this.speakVideo.readyState);
                    resolve(this._videoReady);
                }
            }, 8000);
        });
    }

    // ────────────────────────────────────────
    //  Web Audio API — Setup Analyser (ONCE)
    // ────────────────────────────────────────
    _setupAudioAnalyser() {
        if (this.analyser) return;

        try {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            if (!AudioContextClass) {
                console.warn('[AvatarEngine] AudioContext not supported');
                return;
            }
            this.audioContext = new AudioContextClass();
            this.analyser = this.audioContext.createAnalyser();
            this.analyser.fftSize = 256;
            this.analyser.smoothingTimeConstant = 0.8;

            this.frequencyData = new Uint8Array(this.analyser.frequencyBinCount);
            this.timeDomainData = new Uint8Array(this.analyser.fftSize);

            console.log('[AvatarEngine] Audio analyser created');
        } catch (e) {
            console.error('[AvatarEngine] Failed to create AudioContext:', e);
        }
    }

    /**
     * Connect the audio element to the analyser.
     * createMediaElementSource() can only be called ONCE per audio element.
     */
    _connectAudioSource() {
        if (!this.audioContext || !this.analyser || !this.audioEl) return;

        // Resume context if suspended (Safari/Chrome autoplay policy)
        if (this.audioContext.state === 'suspended') {
            this.audioContext.resume().catch(() => {});
        }

        if (!this._sourceConnected) {
            try {
                this.audioSource = this.audioContext.createMediaElementSource(this.audioEl);
                this.audioSource.connect(this.analyser);
                this.analyser.connect(this.audioContext.destination);
                this._sourceConnected = true;
                console.log('[AvatarEngine] Audio source connected');
            } catch (e) {
                // Safari sometimes errors on createMediaElementSource
                // Fall back to playing without analysis
                console.warn('[AvatarEngine] Audio source connection failed (will play without lip analysis):', e.message);
                this._sourceConnected = false;
            }
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

        try {
            this.analyser.getByteFrequencyData(this.frequencyData);
            this.analyser.getByteTimeDomainData(this.timeDomainData);
        } catch (e) {
            return;
        }

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
            try {
                this.speakVideo.playbackRate = targetSpeed;
            } catch (e) {
                // Safari can throw on playbackRate changes
            }
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

            console.log('[AvatarEngine] Session ready ✓');
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
        const dpr = Math.min(window.devicePixelRatio || 1, 2); // Cap DPR at 2 for performance
        this.canvas.width = Math.round(containerW * dpr);
        this.canvas.height = Math.round(containerH * dpr);
        this._drawCover(this.idleImage, this.canvas.width, this.canvas.height);
        console.log('[AvatarEngine] First frame drawn (idle PNG)');
    }

    // ────────────────────────────────────────
    //  Render Loop with FPS throttling
    // ────────────────────────────────────────
    startLoop() {
        if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);
        const loop = (timestamp) => {
            // FPS throttle: skip frames when idle to save CPU
            const elapsed = timestamp - this._lastFrameTime;
            const frameInterval = 1000 / this._targetFps;

            if (elapsed >= frameInterval) {
                this._lastFrameTime = timestamp - (elapsed % frameInterval);
                this._analyzeAudio(timestamp);
                this._update(timestamp);
                this._updateWaveBars();
                this._draw(timestamp);
            }

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
            this.lipBlend += lipDiff * 0.35;
        } else {
            this.lipBlend += lipDiff * 0.15;
        }
        this.lipBlend = Math.max(0, Math.min(1, this.lipBlend));

        // Keep video playing during speaking (handle Safari pauses)
        if (this.isSpeaking && this.speakVideo && this.speakVideo.paused) {
            this.speakVideo.play().catch(() => {});
        }

        // If audio source not connected (Safari fallback), simulate energy from audio time
        if (this.isSpeaking && !this._sourceConnected && this.audioEl && !this.audioEl.paused) {
            // Simulate speaking energy so video shows even without Web Audio analysis
            const t = performance.now() / 200;
            this.lipBlendTarget = 0.5 + 0.3 * Math.sin(t) + 0.2 * Math.sin(t * 2.7);
            this.isSpeechActive = true;
            this.currentEnergy = this.lipBlendTarget;
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
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
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
        const primaryReady = isVideoDrawable(this.speakVideo);

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

        // Draw speaking video
        if (effectiveBlend > 0.001 && primaryReady) {
            this.ctx.globalAlpha = effectiveBlend;
            this._drawCover(this.speakVideo, w, h);
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
    //  Play Audio + Speaking Video
    // ────────────────────────────────────────
    async playAudioSync(audioUrl, onStartPlaybackCallback) {
        return new Promise(async (resolve) => {
            if (!this.audioEl) {
                console.warn('[AvatarEngine] No audio element found!');
                return resolve();
            }

            // Add cache-busting to prevent stale audio
            const cacheBuster = `_cb=${Date.now()}`;
            const separator = audioUrl.includes('?') ? '&' : '?';
            const freshUrl = `${audioUrl}${separator}${cacheBuster}`;

            console.log('[AvatarEngine] playAudioSync called with:', freshUrl);

            // Wait for video to be ready before starting (prevents audio-only on first message)
            if (!this._videoReady && this._videoReadyPromise) {
                console.log('[AvatarEngine] Waiting for video pre-decode...');
                await Promise.race([
                    this._videoReadyPromise,
                    new Promise(r => setTimeout(r, 3000)) // Don't wait more than 3s
                ]);
            }

            let settled = false;
            let noCorsRetried = false;
            let speakingStarted = false;

            const finish = () => {
                if (settled) return;
                settled = true;
                if (this._safetyTimer) {
                    clearTimeout(this._safetyTimer);
                    this._safetyTimer = null;
                }
                this.setIdle();
                resolve();
            };

            // Safety timeout
            this._safetyTimer = setTimeout(() => {
                if (!settled) {
                    console.warn('[AvatarEngine] ⚠ Safety timeout! Forcing idle.');
                    finish();
                }
            }, STUCK_SAFETY_TIMEOUT_MS);

            const startSpeaking = () => {
                if (speakingStarted) return;
                speakingStarted = true;
                if (typeof onStartPlaybackCallback === 'function') onStartPlaybackCallback();
                this._connectAudioSource();
                this._goSpeaking();
            };

            const tryPlay = () => {
                const playPromise = this.audioEl.play();
                if (playPromise && playPromise.then) {
                    playPromise.then(() => {
                        startSpeaking();
                    }).catch((e) => {
                        console.warn('[AvatarEngine] Audio play() failed:', e.message);
                        // Safari: might need user gesture — still start speaking visuals
                        if (e.name === 'NotAllowedError') {
                            console.log('[AvatarEngine] Autoplay blocked — will retry on interaction');
                            this._pendingVideoPlay = true;
                        }
                        setTimeout(() => {
                            if (!settled) finish();
                        }, 2000);
                    });
                }
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

            // Try with CORS first, fallback without
            this.audioEl.crossOrigin = 'anonymous';
            this.audioEl.src = freshUrl;

            console.log('[AvatarEngine] Loading audio...');

            this.audioEl.onloadeddata = () => {
                console.log('[AvatarEngine] Audio loaded, duration:', this.audioEl.duration?.toFixed(2) + 's');
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

                // CORS errors: retry without crossOrigin (common on Safari)
                if (this.audioEl.crossOrigin === 'anonymous' && !noCorsRetried) {
                    noCorsRetried = true;
                    console.log('[AvatarEngine] Retrying without crossOrigin...');
                    this.audioEl.crossOrigin = '';
                    this.audioEl.removeAttribute('crossorigin');
                    this.audioEl.src = freshUrl;
                    this.audioEl.load();
                    // When CORS is removed, we can't use Web Audio API
                    // but audio will still play
                    setTimeout(() => {
                        if (!speakingStarted) {
                            this.audioEl.play().then(() => {
                                startSpeaking();
                            }).catch(() => {
                                if (!settled) finish();
                            });
                        }
                    }, 300);
                    return;
                }
                finish();
            };

            this.audioEl.onplaying = () => {
                console.log(`[AvatarEngine] Audio playing: duration=${(this.audioEl.duration * 1000).toFixed(0)}ms`);
                startSpeaking();
            };

            this.audioEl.load();

            // Safety: try to play after a short delay
            setTimeout(() => {
                if (!speakingStarted && !settled) tryPlay();
            }, 200);
        });
    }

    // ────────────────────────────────────────
    //  Speaking mode
    // ────────────────────────────────────────
    _goSpeaking() {
        if (this.isSpeaking) return;
        this.isSpeaking = true;
        this.isThinking = false;

        // Boost FPS for smooth animation
        this._targetFps = SPEAKING_FPS;

        console.log('[AvatarEngine] → Speaking');

        // Reset lip sync state
        this.lipBlend = 0;
        this.lipBlendTarget = 0;
        this.isSpeechActive = false;
        this.lastSpeechTime = 0;
        this._peakEnergy = 0.1;
        this._energyHistory.fill(0);

        // Start video from beginning
        if (this.speakVideo) {
            this.speakVideo.currentTime = 0;
            this.speakVideo.playbackRate = 1.0;
            this.speakVideo.play().catch((e) => {
                console.warn('[AvatarEngine] Video play error:', e.message);
            });
        }

        if (this.audioContext && this.audioContext.state === 'suspended') {
            this.audioContext.resume().catch(() => {});
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

        // Throttle FPS when idle to save CPU/battery
        this._targetFps = IDLE_FPS;

        // Pause video
        if (this.speakVideo) {
            this.speakVideo.pause();
            this.speakVideo.playbackRate = 1.0;
        }

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
        if (this.audioEl && this.audioEl.paused && this.audioEl.src) {
            this.audioEl.play().catch(() => {});
        }
        if (this.isSpeaking && this.speakVideo && this.speakVideo.paused) {
            this.speakVideo.play().catch(() => {});
        }
        // Handle pending autoplay
        if (this._pendingVideoPlay && this.audioEl) {
            this._pendingVideoPlay = false;
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
        if (this.speakVideo) { this.speakVideo.pause(); this.speakVideo.remove(); }
        if (this.audioContext) {
            try { this.audioContext.close(); } catch (e) {}
        }
    }
}

window.AvatarEngine = AvatarEngine;
export default AvatarEngine;
