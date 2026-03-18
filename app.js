/**
 * ============================================
 *  Speaking Coach — Main Application v3
 * ============================================
 *
 * Handles:
 *   1. Microphone recording (MediaRecorder API)
 *   2. Sending audio to n8n webhook (STT + LLM)
 *   3. Receiving { aiText, userText, audioUrl } response
 *   4. Driving AvatarEngine: audio-reactive lip sync
 *   5. Chat transcript with timestamps
 *
 * v3: Redesigned for Speaking Coach layout
 */

import AvatarEngine from './avatar-engine.js?v=20260318-6';

// ============================================
//  CONFIGURATION
// ============================================
const CONFIG = {
    N8N_WEBHOOK_URL: 'https://n8n.auge10x.com/webhook/chat',

    AUDIO_MIME_TYPE: 'audio/webm;codecs=opus',
    AUDIO_FALLBACK_MIME: 'audio/webm',
    MAX_RECORDING_SECONDS: 15,
    MIN_RECORDING_MS: 400,

    REQUEST_TIMEOUT_MS: 60000,
};

// ============================================
//  APP STATE
// ============================================
const state = {
    isRecording: false,
    isProcessing: false,
    isSpeaking: false,
    mediaRecorder: null,
    audioChunks: [],
    recordingStartTime: 0,
    stream: null,
    heygenReady: false,
};

// ============================================
//  DOM REFERENCES (updated for new layout)
// ============================================
const dom = {
    micBtn: document.getElementById('micBtn'),
    micLabel: document.getElementById('micLabel'),
    micRipple: document.getElementById('micRipple'),
    headerStatus: document.getElementById('headerStatus'),
    headerStatusLabel: document.getElementById('headerStatusLabel'),
    modeBadge: document.getElementById('modeBadge'),
    modeLabel: document.getElementById('modeLabel'),
    transcriptBody: document.getElementById('transcriptBody'),
    transcriptEmpty: document.getElementById('transcriptEmpty'),
    processingBar: document.getElementById('processingBar'),
    processingText: document.getElementById('processingText'),
    avatarSection: document.getElementById('avatarSection'),
    avatarConnecting: document.getElementById('avatarConnecting'),
};

// ============================================
//  AVATAR ENGINE INSTANCE
// ============================================
let avatar = null;
let avatarSessionPromise = null;

async function initAvatarSession({ showUi = false } = {}) {
    if (state.heygenReady) return true;
    if (!avatar) return false;

    if (showUi) {
        setStatus('online', 'Initializing...');
        showProcessing('Preparing avatar...');
    }

    if (!avatarSessionPromise) {
        avatarSessionPromise = (async () => {
            try {
                const ok = await avatar.startSession();
                if (ok) {
                    state.heygenReady = true;
                    if (dom.avatarConnecting) dom.avatarConnecting.style.display = 'none';
                }
                return !!ok;
            } catch (err) {
                console.error('[App] Avatar session init failed:', err);
                return false;
            } finally {
                avatarSessionPromise = null;
            }
        })();
    }

    const ok = await avatarSessionPromise;
    if (showUi) hideProcessing();
    if (ok) setStatus('online', 'Ready');
    return ok;
}

document.addEventListener('DOMContentLoaded', async () => {
    avatar = new AvatarEngine();
    setStatus('online', 'Ready');
    setMode('Idle');

    preWarmWebhook();

    initAvatarSession({ showUi: false }).then((ok) => {
        if (ok) console.log('[App] Avatar session auto-started');
        else console.log('[App] Auto-start deferred');
    });

    const resumeOnInteraction = () => {
        if (avatar && typeof avatar.resumePlayback === 'function') {
            avatar.resumePlayback();
        }
        document.removeEventListener('click', resumeOnInteraction);
        document.removeEventListener('touchstart', resumeOnInteraction);
        document.removeEventListener('keydown', resumeOnInteraction);
    };
    document.addEventListener('click', resumeOnInteraction, { once: false });
    document.addEventListener('touchstart', resumeOnInteraction, { once: false });
    document.addEventListener('keydown', resumeOnInteraction, { once: false });
});

// ============================================
//  PRE-WARM WEBHOOK
// ============================================
function preWarmWebhook() {
    fetch(CONFIG.N8N_WEBHOOK_URL, {
        method: 'HEAD',
        mode: 'no-cors',
    }).then(() => {
        console.log('[App] Webhook pre-warmed');
    }).catch(() => {});
}

// ============================================
//  SESSION INIT
// ============================================
async function ensureHeyGenSession() {
    const ok = await initAvatarSession({ showUi: true });
    if (ok) {
        console.log('[App] Avatar engine connected');
        return true;
    } else {
        setStatus('online', 'Init failed');
        dom.micLabel.textContent = 'Init failed — try again';
        setTimeout(() => { dom.micLabel.textContent = 'Tap to speak'; }, 3000);
        return false;
    }
}

// ============================================
//  STATUS MANAGEMENT (updated for new badge)
// ============================================
function setStatus(statusClass, label) {
    dom.headerStatus.className = 'status-badge ' + statusClass;
    dom.headerStatusLabel.textContent = label;
}

function setMode(label) {
    if (dom.modeLabel) dom.modeLabel.textContent = label;
}

function showProcessing(text = 'Processing...') {
    dom.processingBar.classList.add('visible');
    dom.processingText.textContent = text;
}

function hideProcessing() {
    dom.processingBar.classList.remove('visible');
}

// ============================================
//  FORCE RESET STATE
// ============================================
function resetToReady() {
    state.isProcessing = false;
    state.isSpeaking = false;
    state.isRecording = false;
    dom.micBtn.classList.remove('disabled', 'recording');
    dom.micLabel.classList.remove('active');
    dom.micLabel.textContent = 'Tap to speak';
    setStatus('online', 'Ready');
    setMode('Idle');
    hideProcessing();
    if (avatar) avatar.setIdle();
}

// ============================================
//  TRANSCRIPT MANAGEMENT (with timestamps)
// ============================================
function getTimeStr() {
    const now = new Date();
    return now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function addMessage(type, text) {
    if (dom.transcriptEmpty) dom.transcriptEmpty.style.display = 'none';

    const msgEl = document.createElement('div');
    msgEl.className = `message ${type}`;

    const avatarDiv = document.createElement('div');
    avatarDiv.className = 'message-avatar';
    avatarDiv.textContent = type === 'user' ? '🎤' : '👩‍🏫';
    
    const contentDiv = document.createElement('div');
    contentDiv.className = 'message-content';
    
    const roleSpan = document.createElement('span');
    roleSpan.className = 'message-role';
    roleSpan.textContent = type === 'user' ? 'You' : 'Tutor';
    
    const textP = document.createElement('p');
    textP.textContent = text;

    const timeSpan = document.createElement('span');
    timeSpan.className = 'msg-time';
    timeSpan.style.display = 'block';
    timeSpan.style.fontSize = '10px';
    timeSpan.style.marginTop = '6px';
    timeSpan.style.opacity = '0.4';
    timeSpan.textContent = getTimeStr();
    textP.appendChild(timeSpan);
    
    contentDiv.appendChild(roleSpan);
    contentDiv.appendChild(textP);
    
    msgEl.appendChild(avatarDiv);
    msgEl.appendChild(contentDiv);

    msgEl.style.opacity = '0';
    msgEl.style.transform = 'translateY(10px)';
    msgEl.style.transition = 'opacity 0.3s, transform 0.3s';
    
    dom.transcriptBody.appendChild(msgEl);
    
    requestAnimationFrame(() => {
        msgEl.style.opacity = '1';
        msgEl.style.transform = 'translateY(0)';
    });
    
    dom.transcriptBody.scrollTop = dom.transcriptBody.scrollHeight;
}

// ============================================
//  MICROPHONE RECORDING
// ============================================
async function startRecording() {
    const ready = await ensureHeyGenSession();
    if (!ready) return;

    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                sampleRate: 16000,
            }
        });

        state.stream = stream;
        state.audioChunks = [];

        let mimeType = CONFIG.AUDIO_MIME_TYPE;
        if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = CONFIG.AUDIO_FALLBACK_MIME;
        if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = '';

        const recorderOptions = mimeType ? { mimeType } : {};
        if (mimeType.includes('opus')) {
            recorderOptions.audioBitsPerSecond = 24000;
        }

        const recorder = new MediaRecorder(stream, recorderOptions);

        recorder.ondataavailable = (e) => {
            if (e.data.size > 0) state.audioChunks.push(e.data);
        };

        recorder.onstop = () => {
            const elapsed = Date.now() - state.recordingStartTime;
            if (elapsed < CONFIG.MIN_RECORDING_MS) {
                dom.micLabel.textContent = 'Too short, try again';
                setTimeout(() => { dom.micLabel.textContent = 'Tap to speak'; }, 2000);
                stopStream();
                return;
            }
            const audioBlob = new Blob(state.audioChunks, { type: recorder.mimeType || 'audio/webm' });
            console.log(`[App] Recording: ${(audioBlob.size / 1024).toFixed(1)}KB, ${(elapsed / 1000).toFixed(1)}s`);
            sendToN8N(audioBlob);
            stopStream();
        };

        state.mediaRecorder = recorder;
        recorder.start();
        state.isRecording = true;
        state.recordingStartTime = Date.now();

        dom.micBtn.classList.add('recording');
        dom.micLabel.textContent = 'Recording... tap to stop';
        dom.micLabel.classList.add('active');
        setStatus('recording', 'Listening...');
        setMode('Recording');

        setTimeout(() => { if (state.isRecording) stopRecording(); }, CONFIG.MAX_RECORDING_SECONDS * 1000);

    } catch (err) {
        console.error('[App] Microphone error:', err);
        dom.micLabel.textContent = 'Microphone access denied';
        setTimeout(() => { dom.micLabel.textContent = 'Tap to speak'; }, 3000);
    }
}

function stopRecording() {
    if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
        state.mediaRecorder.stop();
    }
    state.isRecording = false;
    dom.micBtn.classList.remove('recording');
    dom.micLabel.classList.remove('active');
}

function stopStream() {
    if (state.stream) {
        state.stream.getTracks().forEach(t => t.stop());
        state.stream = null;
    }
}

// ============================================
//  SEND AUDIO TO N8N
// ============================================
async function sendToN8N(audioBlob) {
    state.isProcessing = true;
    dom.micBtn.classList.add('disabled');
    setStatus('online', 'Thinking...');
    setMode('Processing');
    showProcessing('Uploading audio...');

    if (avatar) avatar.setThinking();

    const abortController = new AbortController();
    const timeoutId = setTimeout(() => {
        abortController.abort();
        console.warn('[App] Request timed out after', CONFIG.REQUEST_TIMEOUT_MS, 'ms');
    }, CONFIG.REQUEST_TIMEOUT_MS);

    try {
        const requestStart = performance.now();
        const formData = new FormData();
        formData.append('audio', audioBlob, 'recording.webm');

        console.log(`[App] Sending ${(audioBlob.size / 1024).toFixed(1)}KB audio...`);

        const response = await fetch(CONFIG.N8N_WEBHOOK_URL, {
            method: 'POST',
            body: formData,
            signal: abortController.signal,
        });

        clearTimeout(timeoutId);

        const responseTimeMs = Math.round(performance.now() - requestStart);
        console.log(`[App] Response in ${responseTimeMs}ms | status: ${response.status}`);

        showProcessing(`Generating response... (${(responseTimeMs / 1000).toFixed(1)}s)`);

        if (!response.ok) throw new Error(`Server error: ${response.status}`);

        const rawText = await response.text();
        console.log('[App] Raw response:', rawText.substring(0, 300));

        let data;
        try {
            data = JSON.parse(rawText);
            if (typeof data === 'string') data = JSON.parse(data);
        } catch (parseErr) {
            console.error('[App] JSON parse error:', parseErr);
            throw new Error('Invalid JSON in response');
        }

        showProcessing('Preparing voice...');

        let responseData = data;
        if (Array.isArray(data)) responseData = data[0] || {};
        if (responseData.output && typeof responseData.output === 'object') responseData = responseData.output;

        let audioUrl = responseData.audioUrl || responseData.audio_url || responseData.audioURL;
        if (!audioUrl) {
            const deepSearch = (obj, depth = 0) => {
                if (depth > 5 || !obj || typeof obj !== 'object') return null;
                for (const key of Object.keys(obj)) {
                    const lk = key.toLowerCase();
                    if (lk === 'audiourl' || lk === 'audio_url' || lk === 'audio') {
                        if (typeof obj[key] === 'string' && obj[key].startsWith('http')) return obj[key];
                    }
                    const found = deepSearch(obj[key], depth + 1);
                    if (found) return found;
                }
                return null;
            };
            audioUrl = deepSearch(data);
            if (audioUrl) console.log('[App] Found audioUrl via deep search');
        }

        const userText = responseData.userText || responseData.user_text || responseData.transcription || '';
        const aiText = responseData.aiText || responseData.ai_text || responseData.text || responseData.response || '';

        console.log('[App] audioUrl:', audioUrl ? 'found' : 'missing');

        if (userText) addMessage('user', userText);
        if (aiText) addMessage('ai', aiText);

        if (avatar && audioUrl) {
            showProcessing('Speaking...');
            setStatus('speaking', 'Speaking...');
            setMode('Speaking');
            state.isSpeaking = true;

            try {
                await avatar.playAudioSync(audioUrl);
            } catch (playErr) {
                console.error('[App] Audio playback error:', playErr);
            }

            state.isSpeaking = false;
            resetToReady();
        } else if (audioUrl) {
            await playAudioFallback(audioUrl);
            resetToReady();
        } else {
            console.warn('[App] No audioUrl in response');
            resetToReady();
        }

    } catch (err) {
        clearTimeout(timeoutId);

        if (err.name === 'AbortError') {
            console.error('[App] Request timed out!');
            dom.micLabel.textContent = 'Timed out — try again';
        } else {
            console.error('[App] Error:', err);
            dom.micLabel.textContent = 'Connection error, try again';
        }

        resetToReady();
        setTimeout(() => { dom.micLabel.textContent = 'Tap to speak'; }, 3000);
    }
}

// ============================================
//  AUDIO FALLBACK
// ============================================
function playAudioFallback(audioUrl) {
    return new Promise((resolve) => {
        const audio = new Audio(audioUrl);
        audio.addEventListener('canplay', () => {
            setStatus('speaking', 'Speaking...');
            setMode('Speaking');
            if (avatar) avatar.setSpeaking(true);
            audio.play().catch(() => resolve());
        }, { once: true });
        audio.addEventListener('ended', () => {
            if (avatar) avatar.setIdle();
            resolve();
        }, { once: true });
        audio.addEventListener('error', () => {
            if (avatar) avatar.setIdle();
            resolve();
        }, { once: true });
        setTimeout(() => resolve(), 60000);
        audio.load();
    });
}

// ============================================
//  MIC BUTTON + KEYBOARD
// ============================================
dom.micBtn.addEventListener('click', () => {
    if (state.isProcessing || state.isSpeaking) return;
    if (state.isRecording) stopRecording();
    else startRecording();
});

document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !e.repeat && document.activeElement === document.body) {
        e.preventDefault();
        dom.micBtn.click();
    }
});

// ============================================
//  CLEANUP
// ============================================
window.addEventListener('beforeunload', () => {
    if (avatar) avatar.destroy();
});

// ============================================
//  DEMO
// ============================================
window.runDemo = async function () {
    const ready = await ensureHeyGenSession();
    if (!ready) return;

    addMessage('user', 'Hello, can you help me practice English?');
    addMessage('ai', 'Hello! I\'m your Speaking Coach. I\'m connected and ready to help you practice English!');

    setStatus('speaking', 'Speaking...');
    setMode('Speaking');
    await avatar.speak('Hello! I am your Speaking Coach.');
    resetToReady();
};

console.log('%c🎤 Speaking Coach — AI English Tutor', 'color: #5b4cff; font-size: 14px; font-weight: bold;');
console.log('%cAudio-reactive lip sync | Side-by-side layout', 'color: #a78bfa; font-size: 11px;');
