// This file contains all logic for the music player view.

let ctx = {}; // To hold context (elements, state, helpers)
const audio = new Audio();
const emitLog = (level, message, data) => {
    const payload = { level, scope: 'Player', message, data };
    try {
        window.electronAPI?.log?.(payload);
    } catch (_) {
        // noop
    }

    if (level === 'error') {
        if (data !== undefined) console.error(`[SoundLink][Player] ${message}`, data);
        else console.error(`[SoundLink][Player] ${message}`);
    } else if (level === 'warn') {
        if (data !== undefined) console.warn(`[SoundLink][Player] ${message}`, data);
        else console.warn(`[SoundLink][Player] ${message}`);
    } else {
        if (data !== undefined) console.log(`[SoundLink][Player] ${message}`, data);
        else console.log(`[SoundLink][Player] ${message}`);
    }
};

const logDebug = (message, data) => emitLog('debug', message, data);
const log = (message, data) => emitLog('info', message, data);
const logWarn = (message, data) => emitLog('warn', message, data);
const logError = (message, data) => emitLog('error', message, data);
let currentTracklist = [];
let currentTrackIndex = -1;
let repeatMode = 0; // 0: off, 1: repeat all, 2: repeat one
let isShuffle = false;
let originalTracklist = [];
let isSeekDragging = false;
let activeSeekPointerId = null;
let audioContext = null;
let audioSourceNode = null;
let audioAnalyserNode = null;
let audioFrequencyData = null;
let visualSyncFrameId = null;
let visualSyncLevel = 0;
let spectrogramContext = null;
let spectrogramWidth = 0;
let spectrogramHeight = 0;

let sleepTimerInterval = null;
let sleepTimerEndTime = null;
let persistVolumeTimeout = null;

const VISUAL_SYNC_SMOOTHING = 0.2;
const SPECTROGRAM_BAR_COUNT = 40;
let playerState = {
    playlistSearchQuery: '',
    trackSearchQuery: '',
    selectedPlaylistPath: null,
    activePlaylistIds: [],
    allPlaylists: [],
    activePlaylistSummaries: [],
};

// --- Helper Functions ---
function formatTime(seconds) {
    const minutes = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${minutes}:${secs < 10 ? '0' : ''}${secs}`;
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function escapeHtml(value) {
    if (typeof value !== 'string') return '';
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function getParentDirectory(filePath) {
    if (typeof filePath !== 'string' || filePath.length === 0) return null;
    const normalized = filePath.replace(/[\\/]+$/, '');
    const separatorIndex = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
    if (separatorIndex <= 0) return null;
    return normalized.slice(0, separatorIndex);
}

function parseQueuePrefix(name) {
    const match = name.match(/^\s*(\d{3})\s*-\s*(.+)$/);
    if (!match) return { queueNumber: null, displayName: name };
    return {
        queueNumber: Number.parseInt(match[1], 10),
        displayName: match[2].trim() || name,
    };
}

function normalizeQueueNumbers(tracklist) {
    const prefixed = tracklist.filter(track => track.queueNumber !== null);
    const rawNumbers = prefixed.map(track => track.queueNumber);
    const startsAt = rawNumbers.length > 0 ? rawNumbers[0] : null;
    let hasGap = false;

    for (let index = 1; index < rawNumbers.length; index += 1) {
        if (rawNumbers[index] - rawNumbers[index - 1] !== 1) {
            hasGap = true;
            break;
        }
    }

    const normalized = tracklist.map((track, index) => ({
        ...track,
        normalizedQueueNumber: index + 1,
    }));

    log('Queue numbering normalized', {
        totalTracks: tracklist.length,
        prefixedTracks: prefixed.length,
        startsAt,
        hasGap,
        rawNumbers,
    });

    return normalized;
}

// --- UI Update Functions ---
function updatePlayPauseButton(isPlaying) {
    const { playPauseBtn } = ctx.elements;
    const playIcon = playPauseBtn.querySelector('.play-icon');
    const pauseIcon = playPauseBtn.querySelector('.pause-icon');
    playIcon.classList.toggle('hidden', isPlaying);
    pauseIcon.classList.toggle('hidden', !isPlaying);
}

function updateUI() {
    const { progressBar, currentTime, totalDuration } = ctx.elements;
    const progress = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
    progressBar.style.width = `${progress || 0}%`;
    currentTime.textContent = formatTime(audio.currentTime);
    totalDuration.textContent = formatTime(audio.duration || 0);
}

function updateNowPlaying() {
    const { nowPlaying } = ctx.elements;
    if (currentTrackIndex > -1 && currentTracklist[currentTrackIndex]) {
        nowPlaying.textContent = currentTracklist[currentTrackIndex].displayName;
    } else {
        nowPlaying.textContent = 'Select a song to play';
    }

    emitPlayerStateUpdate();
}

function emitPlayerStateUpdate() {
    const currentTrack = currentTracklist[currentTrackIndex] || null;
    const playlistName = currentTrack ? getPlaylistNameByPath(currentTrack.playlistPath) : '—';

    window.electronAPI?.updatePlayerState?.({
        isPlaying: !audio.paused && Boolean(audio.src),
        trackName: currentTrack?.displayName || 'Nothing playing',
        playlistName,
        currentTimeSeconds: Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
        durationSeconds: Number.isFinite(audio.duration) ? audio.duration : 0,
        sleepTimerActive: Boolean(sleepTimerEndTime),
        sleepTimerRemainingSeconds: sleepTimerEndTime
            ? Math.max(0, Math.ceil((sleepTimerEndTime - Date.now()) / 1000))
            : 0,
    });
}

// --- Player Actions ---
function playTrack(index) {
    if (index >= 0 && index < currentTracklist.length) {
        currentTrackIndex = index;
        const track = currentTracklist[index];
        log('Playing track', {
            index,
            displayQueueNumber: index + 1,
            normalizedQueueNumber: track.normalizedQueueNumber,
            rawQueueNumber: track.queueNumber,
            name: track.displayName,
            path: track.path,
        });
        audio.src = track.path;
        window.electronAPI.recordTrackPlay(track.path).catch(() => {
            // noop
        });
        play();
        updateNowPlaying();
        highlightCurrentTrack();
    }
}

function play() {
    if (audio.src) {
        log('Audio play requested');
        audio.play().catch(e => logError('Error playing audio', { error: e.message }));
    }
}

function pause() {
    log('Audio pause requested');
    audio.pause();
}

function stopPlayback() {
    pause();
    audio.currentTime = 0;
    updateUI();
    emitPlayerStateUpdate();
}

function togglePlayPause() {
    if (!audio.src && currentTracklist.length > 0) {
        playTrack(0); // Start with the first track if nothing is loaded
    } else if (audio.paused) {
        play();
    } else {
        pause();
    }
}

async function playNext() {
    log('Play next requested', { currentTrackIndex, trackCount: currentTracklist.length });
    
    if (repeatMode === 2) {
        // Repeat one
        playTrack(currentTrackIndex);
        return;
    }

    let nextIndex = currentTrackIndex + 1;
    if (nextIndex >= currentTracklist.length) {
        if (repeatMode === 1) {
            nextIndex = 0; // Loop to the beginning
        } else {
            // Queue finished with repeat off: unload active playlists completely
            await setActivePlaylists([], { autoplayFirstTrack: false, preserveCurrentTrack: false });
            return;
        }
    }
    playTrack(nextIndex);
}

function playPrev() {
    log('Play previous requested', { currentTrackIndex, currentTime: audio.currentTime });
    // If song is more than 3 seconds in, restart it. Otherwise, go to previous.
    if (audio.currentTime > 3) {
        audio.currentTime = 0;
    } else {
        if (repeatMode === 2) {
            // Repeat one - just restart the current track
            audio.currentTime = 0;
            play();
            return;
        }
        let prevIndex = currentTrackIndex - 1;
        if (prevIndex < 0) {
            if (repeatMode === 1) {
                prevIndex = currentTracklist.length - 1; // Loop to the end
            } else {
                prevIndex = 0; // Restart first track
            }
        }
        playTrack(prevIndex);
    }
}


function seekByClientX(clientX) {
    const { progressBarContainer } = ctx.elements;
    if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;

    const bounds = progressBarContainer.getBoundingClientRect();
    if (bounds.width <= 0) return;

    const percentage = clamp((clientX - bounds.left) / bounds.width, 0, 1);
    logDebug('Seek requested', { percentage });
    audio.currentTime = audio.duration * percentage;
    updateUI();
}

function seek(event) {
    seekByClientX(event.clientX);
}

function handleSeekPointerDown(event) {
    if (event.button !== undefined && event.button !== 0) return;

    isSeekDragging = true;
    activeSeekPointerId = event.pointerId;
    ctx.elements.progressBarContainer.classList.add('seeking');
    if (typeof ctx.elements.progressBarContainer.setPointerCapture === 'function') {
        ctx.elements.progressBarContainer.setPointerCapture(event.pointerId);
    }
    seekByClientX(event.clientX);
}

function handleSeekPointerMove(event) {
    if (!isSeekDragging) return;
    if (activeSeekPointerId !== null && event.pointerId !== activeSeekPointerId) return;
    seekByClientX(event.clientX);
}

function clearSeekDragState() {
    isSeekDragging = false;
    activeSeekPointerId = null;
    ctx.elements.progressBarContainer.classList.remove('seeking');
}

function handleSeekPointerUp(event) {
    if (!isSeekDragging) return;
    if (activeSeekPointerId !== null && event.pointerId !== activeSeekPointerId) return;

    seekByClientX(event.clientX);
    if (typeof ctx.elements.progressBarContainer.releasePointerCapture === 'function') {
        try {
            ctx.elements.progressBarContainer.releasePointerCapture(event.pointerId);
        } catch (_) {
            // noop
        }
    }
    clearSeekDragState();
}

function resetVisualSyncState() {
    visualSyncLevel = 0;
    ctx.elements.root?.style.setProperty('--audio-visual-level', '0');
    ctx.elements.body?.classList.remove('audio-visual-sync-active');
    clearSpectrogram();
}

function getSpectrogramContext() {
    const spectrogramCanvas = ctx.elements.spectrogramCanvas;
    if (!spectrogramCanvas) return null;

    if (!spectrogramContext) {
        spectrogramContext = spectrogramCanvas.getContext('2d', { alpha: true });
    }

    return spectrogramContext;
}

function resizeSpectrogramCanvasIfNeeded() {
    const spectrogramCanvas = ctx.elements.spectrogramCanvas;
    const drawContext = getSpectrogramContext();
    if (!spectrogramCanvas || !drawContext) return;

    const dpr = window.devicePixelRatio || 1;
    const targetWidth = Math.max(1, Math.floor(spectrogramCanvas.clientWidth * dpr));
    const targetHeight = Math.max(1, Math.floor(spectrogramCanvas.clientHeight * dpr));

    if (spectrogramCanvas.width !== targetWidth || spectrogramCanvas.height !== targetHeight) {
        spectrogramCanvas.width = targetWidth;
        spectrogramCanvas.height = targetHeight;
    }

    spectrogramWidth = spectrogramCanvas.clientWidth;
    spectrogramHeight = spectrogramCanvas.clientHeight;
    drawContext.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function clearSpectrogram() {
    const drawContext = getSpectrogramContext();
    if (!drawContext) return;

    resizeSpectrogramCanvasIfNeeded();
    drawContext.clearRect(0, 0, spectrogramWidth, spectrogramHeight);
}

function drawSpectrogram(frequencyData, level) {
    const drawContext = getSpectrogramContext();
    if (!drawContext || !frequencyData || frequencyData.length === 0) return;

    resizeSpectrogramCanvasIfNeeded();
    drawContext.clearRect(0, 0, spectrogramWidth, spectrogramHeight);

    const bars = Math.min(SPECTROGRAM_BAR_COUNT, frequencyData.length);
    const gap = 6;
    const totalGapWidth = (bars - 1) * gap;
    const barWidth = Math.max((spectrogramWidth - totalGapWidth) / bars, 4);
    const baseFloor = spectrogramHeight * 0.1;
    const dynamicRange = spectrogramHeight * (0.6 + (level * 0.3));
    const spectrogramRgb = getComputedStyle(ctx.elements.root)
        .getPropertyValue('--audio-spectrogram-rgb')
        .trim() || '59, 130, 246';

    let x = gap / 2; // Start with a small offset
    for (let index = 0; index < bars; index += 1) {
        const normalized = frequencyData[index] / 255;
        const barHeight = baseFloor + (normalized * dynamicRange);
        const alpha = 0.4 + (normalized * 0.4) + (level * 0.2);
        const y = spectrogramHeight - barHeight;
        
        // Draw rounded pillars
        drawContext.fillStyle = `rgba(${spectrogramRgb}, ${Math.min(alpha, 1.0).toFixed(3)})`;
        drawContext.beginPath();
        drawContext.roundRect(x, y, barWidth, barHeight, [barWidth / 2, barWidth / 2, 0, 0]);
        drawContext.fill();
        
        x += barWidth + gap;
    }
}

function ensureAudioAnalyser() {
    if (audioAnalyserNode) return true;

    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) return false;

    try {
        audioContext = audioContext || new AudioContextCtor();
        audioSourceNode = audioSourceNode || audioContext.createMediaElementSource(audio);
        audioAnalyserNode = audioAnalyserNode || audioContext.createAnalyser();
        audioAnalyserNode.fftSize = 256;
        audioAnalyserNode.smoothingTimeConstant = 0.78;
        audioSourceNode.connect(audioAnalyserNode);
        audioAnalyserNode.connect(audioContext.destination);
        audioFrequencyData = new Uint8Array(audioAnalyserNode.frequencyBinCount);
        return true;
    } catch (error) {
        logWarn('Unable to initialize audio analyser for visual theme sync', { error: error?.message });
        audioAnalyserNode = null;
        audioSourceNode = null;
        return false;
    }
}

function stopVisualThemeSyncLoop() {
    if (visualSyncFrameId !== null) {
        cancelAnimationFrame(visualSyncFrameId);
        visualSyncFrameId = null;
    }
}

function startVisualThemeSyncLoop() {
    if (visualSyncFrameId !== null) return;

    const tick = () => {
        visualSyncFrameId = requestAnimationFrame(tick);

        if (!ctx.state?.visualThemeSync || audio.paused || audio.ended || !audio.src) {
            resetVisualSyncState();
            return;
        }

        if (!ensureAudioAnalyser()) return;

        if (audioContext?.state === 'suspended') {
            audioContext.resume().catch(() => {
                // noop
            });
        }

        audioAnalyserNode.getByteFrequencyData(audioFrequencyData);
        let total = 0;
        for (let index = 0; index < audioFrequencyData.length; index += 1) {
            total += audioFrequencyData[index];
        }

        const instantaneousLevel = audioFrequencyData.length > 0
            ? (total / audioFrequencyData.length) / 255
            : 0;
        visualSyncLevel += (instantaneousLevel - visualSyncLevel) * VISUAL_SYNC_SMOOTHING;
        ctx.elements.root?.style.setProperty('--audio-visual-level', visualSyncLevel.toFixed(4));
        ctx.elements.body?.classList.add('audio-visual-sync-active');
        drawSpectrogram(audioFrequencyData, visualSyncLevel);
    };

    tick();
}

function setVolume(level) {
    const normalizedLevel = clamp(Number.parseFloat(level), 0, 1);
    const safeLevel = Number.isFinite(normalizedLevel) ? normalizedLevel : 1;
    logDebug('Setting volume', { level: safeLevel });
    audio.volume = safeLevel;
    const { volumeIconUp, volumeIconMute } = ctx.elements;
    audio.muted = safeLevel === 0;
    volumeIconUp.classList.toggle('hidden', audio.muted);
    volumeIconMute.classList.toggle('hidden', !audio.muted);
}

function persistVolumeSetting() {
    if (!window.electronAPI?.saveSettings) return;
    if (persistVolumeTimeout) {
        clearTimeout(persistVolumeTimeout);
    }

    persistVolumeTimeout = setTimeout(() => {
        const playerVolume = audio.muted ? 0 : audio.volume;
        window.electronAPI.saveSettings({ playerVolume }).catch(error => {
            logWarn('Failed to persist player volume', { error: error?.message });
        });
        persistVolumeTimeout = null;
    }, 150);
}

function toggleMute() {
    logDebug('Toggle mute requested', { currentlyMuted: audio.muted });
    audio.muted = !audio.muted;
    const { volumeSlider, volumeIconUp, volumeIconMute } = ctx.elements;
    volumeSlider.value = audio.muted ? 0 : audio.volume;
    volumeIconUp.classList.toggle('hidden', audio.muted);
    volumeIconMute.classList.toggle('hidden', !audio.muted);
}

function resetPlaybackState() {
    log('Resetting playback state');
    audio.pause();
    audio.currentTime = 0;
    audio.src = '';
    currentTrackIndex = -1;
    updatePlayPauseButton(false);
    updateNowPlaying();
    emitPlayerStateUpdate();
}

function setSleepTimer(minutes) {
    if (sleepTimerInterval) {
        clearInterval(sleepTimerInterval);
        sleepTimerInterval = null;
    }
    
    const { sleepTimerDisplay, sleepTimerBtn } = ctx.elements;
    
    if (minutes === 0) {
        sleepTimerEndTime = null;
        sleepTimerDisplay.classList.add('hidden');
        sleepTimerBtn.classList.remove('active');
        log('Sleep timer cancelled');
        emitPlayerStateUpdate();
        return;
    }
    
    sleepTimerEndTime = Date.now() + minutes * 60 * 1000;
    sleepTimerBtn.classList.add('active');
    sleepTimerDisplay.classList.remove('hidden');
    
    updateSleepTimerDisplay();
    sleepTimerInterval = setInterval(() => {
        updateSleepTimerDisplay();
        if (Date.now() >= sleepTimerEndTime) {
            clearInterval(sleepTimerInterval);
            sleepTimerInterval = null;
            sleepTimerEndTime = null;
            sleepTimerDisplay.classList.add('hidden');
            sleepTimerBtn.classList.remove('active');
            pause();
            log('Sleep timer finished, playback paused');
            emitPlayerStateUpdate();
        }
    }, 1000);
    
    log('Sleep timer set', { minutes });
}

function updateSleepTimerDisplay() {
    if (!sleepTimerEndTime) return;
    const remaining = Math.max(0, Math.ceil((sleepTimerEndTime - Date.now()) / 1000));
    const { sleepTimerDisplay } = ctx.elements;
    sleepTimerDisplay.textContent = formatTime(remaining);
    emitPlayerStateUpdate();
}

function showSleepTimerMenu(event) {
    event.stopPropagation();
    const menuItems = [
        { label: '15 minutes', action: () => setSleepTimer(15) },
        { label: '30 minutes', action: () => setSleepTimer(30) },
        { label: '45 minutes', action: () => setSleepTimer(45) },
        { label: '60 minutes', action: () => setSleepTimer(60) },
        { label: 'Custom...', action: () => { void promptCustomSleepTimer(); } },
        { type: 'separator' },
        { label: 'Cancel Timer', action: () => setSleepTimer(0) }
    ];
    
    const rect = event.currentTarget.getBoundingClientRect();
    ctx.helpers.showContextMenu(rect.left, rect.bottom + 5, menuItems);
}

async function promptCustomSleepTimer() {
    const rawMinutes = await ctx.helpers.showPromptDialog(
        'Custom Sleep Timer',
        'Enter timer duration in minutes (1-1440).',
        '90',
        { confirmText: 'Set Timer', cancelText: 'Cancel', placeholder: 'Minutes' }
    );

    if (rawMinutes === null) return;

    const minutes = Number.parseInt(rawMinutes, 10);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) {
        window.alert('Please enter a whole number between 1 and 1440 minutes.');
        return;
    }

    setSleepTimer(minutes);
}

// --- Playlist & Track Rendering ---

function syncSharedActiveState() {
    if (!ctx.state) return;
    ctx.state.activePlaylistPath = playerState.activePlaylistIds[0] || null;
    ctx.state.activeQueuePaths = new Set(playerState.activePlaylistIds);
}

function getPlaylistNameByPath(playlistPath) {
    return playerState.allPlaylists.find(p => p.path === playlistPath)?.name || 'Select a playlist';
}

function getPlaylistByPath(playlistPath) {
    return playerState.allPlaylists.find(p => p.path === playlistPath) || null;
}

function getPlaylistTags(playlistPath) {
    const playlist = getPlaylistByPath(playlistPath);
    return Array.isArray(playlist?.tags) ? playlist.tags : [];
}

function getSingleActivePlaylistTag() {
    if (playerState.activePlaylistIds.length !== 1) return null;
    const tags = getPlaylistTags(playerState.activePlaylistIds[0]);
    return tags.length > 0 ? tags[0] : null;
}

function getCombinedActivePlaylistTags() {
    const combined = [];
    const seen = new Set();

    playerState.activePlaylistIds.forEach((playlistPath) => {
        const tags = getPlaylistTags(playlistPath);
        tags.forEach((tag) => {
            const key = tag.toLowerCase();
            if (seen.has(key)) return;
            seen.add(key);
            combined.push(tag);
        });
    });

    return combined;
}

function getPlaylistSummaryByPath(playlistPath) {
    return playerState.activePlaylistSummaries.find(summary => summary.path === playlistPath) || null;
}

function getActiveQueueSummaryText() {
    const totalTracks = playerState.activePlaylistSummaries
        .reduce((sum, summary) => sum + (Number.isFinite(summary.trackCount) ? summary.trackCount : 0), 0);
    const totalDurationSeconds = playerState.activePlaylistSummaries
        .reduce((sum, summary) => sum + (Number.isFinite(summary.durationSeconds) ? summary.durationSeconds : 0), 0);
    return `${totalTracks} track${totalTracks !== 1 ? 's' : ''} • ${formatDurationForSummary(totalDurationSeconds)}`;
}

function renderTracksStats() {
    const { playerTracksStats } = ctx.elements;
    if (!playerTracksStats) return;

    const activeCount = playerState.activePlaylistIds.length;
    if (activeCount === 0) {
        playerTracksStats.textContent = '';
        playerTracksStats.classList.remove('interactive-stat');
        playerTracksStats.removeAttribute('title');
        return;
    }

    if (activeCount === 1) {
        const singleTag = getSingleActivePlaylistTag();
        if (singleTag) {
            playerTracksStats.textContent = singleTag;
            playerTracksStats.title = singleTag;
            playerTracksStats.classList.remove('interactive-stat');
            return;
        }
        playerTracksStats.textContent = getActiveQueueSummaryText();
        playerTracksStats.classList.remove('interactive-stat');
        playerTracksStats.removeAttribute('title');
        return;
    }

    const combinedTags = getCombinedActivePlaylistTags();
    playerTracksStats.textContent = `${combinedTags.length} Tag${combinedTags.length !== 1 ? 's' : ''}`;
    playerTracksStats.classList.add('interactive-stat');
    playerTracksStats.title = 'Show tags and mix details';
}

function updateTracksHeader() {
    const { playerTracksHeader } = ctx.elements;
    if (!playerTracksHeader) return;

    if (playerState.activePlaylistIds.length === 0) {
        playerTracksHeader.textContent = 'Select a playlist';
        playerTracksHeader.classList.remove('interactive-header');
        playerTracksHeader.removeAttribute('title');
        return;
    }

    if (playerState.activePlaylistIds.length === 1) {
        const label = getPlaylistNameByPath(playerState.activePlaylistIds[0]);
        const tagText = getSingleActivePlaylistTag();
        playerTracksHeader.textContent = tagText
            ? `${label} • ${getActiveQueueSummaryText()}`
            : label;
        playerTracksHeader.classList.remove('interactive-header');
        playerTracksHeader.removeAttribute('title');
        return;
    }

    playerTracksHeader.textContent = `Mix • ${getActiveQueueSummaryText()}`;
    playerTracksHeader.classList.add('interactive-header');
    playerTracksHeader.title = 'Show mixed playlist details';
}

function closeMixDetailsModal() {
    const { mixDetailsModal } = ctx.elements;
    if (!mixDetailsModal) return;
    mixDetailsModal.classList.add('hidden');
}

async function openMixDetailsModal() {
    if (playerState.activePlaylistIds.length < 2) return;

    const {
        mixDetailsModal,
        mixDetailsTitle,
        mixDetailsSummary,
        mixDetailsContent,
    } = ctx.elements;
    if (!mixDetailsModal || !mixDetailsTitle || !mixDetailsSummary || !mixDetailsContent) return;

    const combinedTags = getCombinedActivePlaylistTags();
    mixDetailsTitle.textContent = 'Mix Details';
    mixDetailsSummary.textContent = combinedTags.length > 0
        ? combinedTags.join(' • ')
        : 'No tags in current mix.';

    mixDetailsContent.innerHTML = '';

    playerState.activePlaylistIds.forEach((playlistPath) => {
        const playlist = getPlaylistByPath(playlistPath);
        const summary = getPlaylistSummaryByPath(playlistPath);
        if (!playlist || !summary) return;

        const card = document.createElement('div');
        card.className = 'mix-playlist-card';

        const tags = Array.isArray(playlist.tags) && playlist.tags.length > 0
            ? playlist.tags.join(', ')
            : 'No tags';

        card.innerHTML = `
            <div class="mix-playlist-card-header">
                <span class="mix-playlist-card-title" title="${escapeHtml(playlist.name)}">${escapeHtml(playlist.name)}</span>
                <span class="mix-playlist-card-badge">In Mix</span>
            </div>
            <div class="mix-playlist-card-meta">${summary.trackCount} track${summary.trackCount !== 1 ? 's' : ''} • ${formatDurationForSummary(summary.durationSeconds)}</div>
            <div class="mix-playlist-card-tags" title="${escapeHtml(tags)}">${escapeHtml(tags)}</div>
            <div class="mix-playlist-card-actions"></div>
        `;

        const actions = card.querySelector('.mix-playlist-card-actions');
        const addActionButton = (label, variant, handler) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = `mix-card-action-btn${variant ? ` ${variant}` : ''}`;
            button.textContent = label;
            button.addEventListener('click', async (event) => {
                event.stopPropagation();
                await handler();
            });
            actions.appendChild(button);
        };

        addActionButton('Remove from Mix', 'secondary-btn', async () => {
            await togglePlaylistMix(playlist.path);
            if (playerState.activePlaylistIds.length < 2) closeMixDetailsModal();
            else await openMixDetailsModal();
        });

        if (!playlist.isSmart) {
            addActionButton('Rename', 'secondary-btn', async () => {
                await renamePlaylistFromContext(playlist);
                await openMixDetailsModal();
            });
            addActionButton('Delete', 'danger-btn', async () => {
                await deletePlaylistFromContext(playlist);
                if (playerState.activePlaylistIds.length < 2) closeMixDetailsModal();
                else await openMixDetailsModal();
            });
            addActionButton('Show in Folder', 'secondary-btn', async () => {
                window.electronAPI.showInExplorer(playlist.path);
            });
        }

        card.addEventListener('contextmenu', (event) => {
            event.preventDefault();
            const menuItems = [
                {
                    label: 'Remove from Mix',
                    action: async () => {
                        await togglePlaylistMix(playlist.path);
                        if (playerState.activePlaylistIds.length < 2) closeMixDetailsModal();
                        else await openMixDetailsModal();
                    },
                },
                {
                    label: 'More info',
                    action: async () => {
                        await showPlaylistInfoFromContext(playlist);
                    },
                },
            ];

            if (!playlist.isSmart) {
                menuItems.push(
                    { type: 'separator' },
                    {
                        label: 'Rename',
                        action: async () => {
                            await renamePlaylistFromContext(playlist);
                            await openMixDetailsModal();
                        },
                    },
                    {
                        label: 'Delete',
                        action: async () => {
                            await deletePlaylistFromContext(playlist);
                            if (playerState.activePlaylistIds.length < 2) closeMixDetailsModal();
                            else await openMixDetailsModal();
                        },
                    },
                    { type: 'separator' },
                    {
                        label: 'Show in Folder',
                        action: () => window.electronAPI.showInExplorer(playlist.path),
                    }
                );
            }

            ctx.helpers.showContextMenu(event.clientX, event.clientY, menuItems);
        });

        mixDetailsContent.appendChild(card);
    });

    mixDetailsModal.classList.remove('hidden');
}

async function togglePlaylistMix(playlistPath) {
    const isActive = playerState.activePlaylistIds.includes(playlistPath);
    const isFirstMixAction = !isActive && playerState.activePlaylistIds.length === 0;
    const nextActiveIds = isActive
        ? playerState.activePlaylistIds.filter(id => id !== playlistPath)
        : [...playerState.activePlaylistIds, playlistPath];

    if (isFirstMixAction) {
        resetPlaybackState();
        await setActivePlaylists([playlistPath], { autoplayFirstTrack: true, preserveCurrentTrack: false });
        return;
    }

    await setActivePlaylists(nextActiveIds, { autoplayFirstTrack: false, preserveCurrentTrack: true });
}

async function renamePlaylistFromContext(playlist) {
    const newName = await ctx.helpers.showPromptDialog(
        'Rename Playlist',
        'Enter a new playlist name:',
        playlist.name,
        { confirmText: 'Rename', cancelText: 'Cancel' }
    );
    const trimmedName = newName?.trim();
    if (!trimmedName || trimmedName === playlist.name) return;

    const result = await window.electronAPI.renamePlaylist({ oldPath: playlist.path, newName: trimmedName });
    if (!result.success) {
        ctx.helpers.showNotification('error', 'Rename Failed', result.error || 'Could not rename playlist.');
        return;
    }

    const oldPath = playlist.path;
    const newPath = result.newPath;

    ctx.helpers.showNotification(
        'success',
        'Renamed',
        `Playlist renamed to "${trimmedName}".`,
        {
            undoAction: {
                type: 'rename-playlist',
                payload: {
                    currentPath: newPath,
                    previousName: playlist.name,
                },
            },
        }
    );

    playerState.activePlaylistIds = playerState.activePlaylistIds.map(id => (id === oldPath ? newPath : id));
    if (playerState.selectedPlaylistPath === oldPath) playerState.selectedPlaylistPath = newPath;

    if (Array.isArray(ctx.state.favoritePlaylists)) {
        const favoriteIndex = ctx.state.favoritePlaylists.indexOf(oldPath);
        if (favoriteIndex > -1) {
            ctx.state.favoritePlaylists[favoriteIndex] = newPath;
            await ctx.helpers.saveSettings();
        }
    }

    syncSharedActiveState();
    await renderPlaylists();
    await renderActiveTracks({ autoplayFirstTrack: false, preserveCurrentTrack: true });
}

async function deletePlaylistFromContext(playlist) {
    const confirmed = await ctx.helpers.showConfirmDialog(
        'Delete Playlist',
        `Are you sure you want to permanently delete the playlist "${playlist.name}"?`,
        { confirmText: 'Delete', cancelText: 'Cancel', danger: true }
    );
    if (!confirmed) return;

    await ctx.playerAPI?.unloadPlaylistByPath?.(playlist.path);

    const result = await window.electronAPI.deletePlaylist(playlist.path);
    if (!result.success) {
        ctx.helpers.showNotification('error', 'Delete Failed', result.error || 'Could not delete playlist.');
        return;
    }

    ctx.helpers.showNotification(
        'success',
        'Playlist Deleted',
        `"${playlist.name}" has been deleted.`,
        { undoAction: result.undoAction || null }
    );
    playerState.activePlaylistIds = playerState.activePlaylistIds.filter(id => id !== playlist.path);
    if (playerState.selectedPlaylistPath === playlist.path) {
        playerState.selectedPlaylistPath = playerState.activePlaylistIds[0] || null;
    }

    if (Array.isArray(ctx.state.favoritePlaylists)) {
        ctx.state.favoritePlaylists = ctx.state.favoritePlaylists.filter(id => id !== playlist.path);
        await ctx.helpers.saveSettings();
    }

    syncSharedActiveState();
    await renderPlaylists();
    await renderActiveTracks({ autoplayFirstTrack: false, preserveCurrentTrack: true });
}

async function renameTrackFromContext(track) {
    const newName = await ctx.helpers.showPromptDialog(
        'Rename Track',
        'Enter new track name (without extension):',
        track.displayName,
        { confirmText: 'Rename', cancelText: 'Cancel' }
    );
    const trimmedName = newName?.trim();
    if (!trimmedName || trimmedName === track.displayName) return;

    const result = await window.electronAPI.renameTrack({ oldPath: track.path, newName: trimmedName });
    if (!result.success) {
        ctx.helpers.showNotification('error', 'Rename Failed', result.error || 'Could not rename track.');
        return;
    }

    ctx.helpers.showNotification(
        'success',
        'Renamed',
        'Track renamed successfully.',
        {
            undoAction: {
                type: 'rename-track',
                payload: {
                    currentPath: result.newPath,
                    previousName: track.displayName,
                },
            },
        }
    );
    await renderActiveTracks({ autoplayFirstTrack: false, preserveCurrentTrack: false });
}

async function deleteTrackFromContext(track) {
    const confirmed = await ctx.helpers.showConfirmDialog(
        'Delete Track',
        `Are you sure you want to permanently delete "${track.displayName}"?`,
        { confirmText: 'Delete', cancelText: 'Cancel', danger: true }
    );
    if (!confirmed) return;

    await ctx.playerAPI?.unloadTrackByPath?.(track.path);

    const result = await window.electronAPI.deleteTrack(track.path);
    if (!result.success) {
        ctx.helpers.showNotification('error', 'Delete Failed', result.error || 'Could not delete track.');
        return;
    }

    if (currentTracklist[currentTrackIndex]?.path === track.path) {
        resetPlaybackState();
    }

    ctx.helpers.showNotification(
        'success',
        'Track Deleted',
        `"${track.displayName}" has been deleted.`,
        { undoAction: result.undoAction || null }
    );
    await renderActiveTracks({ autoplayFirstTrack: false, preserveCurrentTrack: true });
}

function formatTrackDetailsDate(value) {
    if (!value) return 'Unknown';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return 'Unknown';
    return parsed.toLocaleString();
}

function formatTrackDetailsDuration(durationSeconds) {
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 'Unknown';
    const rounded = Math.round(durationSeconds);
    const hours = Math.floor(rounded / 3600);
    const minutes = Math.floor((rounded % 3600) / 60);
    const seconds = rounded % 60;
    if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatTrackListDuration(durationSeconds) {
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return '--:--';
    const rounded = Math.round(durationSeconds);
    const hours = Math.floor(rounded / 3600);
    const minutes = Math.floor((rounded % 3600) / 60);
    const seconds = rounded % 60;
    if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatPlaylistDetailsDate(value) {
    if (!value) return 'Unknown';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return 'Unknown';
    return parsed.toLocaleString();
}

function buildPlaylistDetailsMessage(details) {
    const tagText = Array.isArray(details.tags) && details.tags.length > 0 ? details.tags.join(', ') : 'None';
    return [
        `Playlist: ${details.name || 'Unknown'}`,
        `Tracks: ${Number.isFinite(details.trackCount) ? details.trackCount : 0}`,
        `Total duration: ${formatTrackDetailsDuration(details.totalDurationSeconds)}`,
        `Tags: ${tagText}`,
        `Size: ${details.totalSizeFormatted || 'Unknown'}`,
        `Created: ${formatPlaylistDetailsDate(details.createdAt)}`,
        `Modified: ${formatPlaylistDetailsDate(details.modifiedAt)}`,
        '',
        `Folder path: ${details.path || 'Unknown'}`,
    ].join('\n');
}

async function showPlaylistInfoFromContext(playlist) {
    const result = await window.electronAPI.getPlaylistDetails(playlist.path);
    if (!result?.success || !result.details) {
        ctx.helpers.showNotification('error', 'More Info Failed', result?.error || 'Could not load playlist details.');
        return;
    }

    await ctx.helpers.showInfoDialog('Playlist Details', buildPlaylistDetailsMessage(result.details), { confirmText: 'Close' });
}

async function addTagToPlaylistFromContext(playlist) {
    if (playlist?.isSmart) return;

    const tagInput = await ctx.helpers.showPromptDialog(
        'Add Playlist Tag',
        `Add a tag for "${playlist.name}"`,
        '',
        { confirmText: 'Add Tag', cancelText: 'Cancel', placeholder: 'e.g. focus, classics, roadtrip' }
    );

    const trimmedTag = tagInput?.trim();
    if (!trimmedTag) return;

    const result = await window.electronAPI.addPlaylistTag({ playlistPath: playlist.path, tag: trimmedTag });
    if (!result?.success) {
        ctx.helpers.showNotification('error', 'Add Playlist Tag Failed', result?.error || 'Could not add playlist tag.');
        return;
    }

    ctx.helpers.showNotification('success', 'Tag Added', `"${trimmedTag}" added to "${playlist.name}".`);
    await renderPlaylists();
    await renderActiveTracks({ autoplayFirstTrack: false, preserveCurrentTrack: true });
}

async function editTagOnPlaylistFromContext(playlist) {
    if (playlist?.isSmart) return;

    const existingTags = Array.isArray(playlist?.tags) ? playlist.tags : [];
    if (existingTags.length === 0) return;

    const currentTag = existingTags[0];
    const tagInput = await ctx.helpers.showPromptDialog(
        'Edit Playlist Tag',
        'Edit the playlist tag, or leave empty to remove it.',
        currentTag,
        { confirmText: 'Save Tag', cancelText: 'Cancel', placeholder: 'Tag text' }
    );

    if (tagInput === null) return;

    const result = await window.electronAPI.updatePlaylistTag({
        playlistPath: playlist.path,
        oldTag: currentTag,
        newTag: tagInput,
    });

    if (!result?.success) {
        ctx.helpers.showNotification('error', 'Edit Playlist Tag Failed', result?.error || 'Could not update playlist tag.');
        return;
    }

    const wasRemoved = !(typeof tagInput === 'string' && tagInput.trim());
    ctx.helpers.showNotification('success', wasRemoved ? 'Tag Removed' : 'Tag Updated', wasRemoved ? `Removed "${currentTag}".` : `Updated to "${tagInput.trim()}".`);
    await renderPlaylists();
    await renderActiveTracks({ autoplayFirstTrack: false, preserveCurrentTrack: true });
}

function buildTrackDetailsMessage(details) {
    const tagText = Array.isArray(details.tags) && details.tags.length > 0 ? details.tags.join(', ') : 'None';
    return [
        `Title: ${details.title || details.fileName || 'Unknown'}`,
        `Artist: ${details.artist || 'Unknown'}`,
        `Album: ${details.album || 'Unknown'}`,
        `Genre: ${details.genre || 'Unknown'}`,
        `Source: ${details.source || 'Unknown'}`,
        `Date downloaded: ${formatTrackDetailsDate(details.dateDownloaded)}`,
        `Duration: ${formatTrackDetailsDuration(details.durationSeconds)}`,
        `Bitrate: ${Number.isFinite(details.bitrateKbps) ? `${details.bitrateKbps} kbps` : 'Unknown'}`,
        `Sample rate: ${Number.isFinite(details.sampleRate) ? `${details.sampleRate} Hz` : 'Unknown'}`,
        `Channels: ${Number.isFinite(details.channels) ? details.channels : 'Unknown'}`,
        `Size: ${details.sizeFormatted || 'Unknown'}`,
        `Tags: ${tagText}`,
        '',
        `File path: ${details.path || 'Unknown'}`,
    ].join('\n');
}

async function showTrackInfoFromContext(track) {
    const result = await window.electronAPI.getTrackDetails(track.path);
    if (!result?.success || !result.details) {
        ctx.helpers.showNotification('error', 'More Info Failed', result?.error || 'Could not load track details.');
        return;
    }

    const detailsText = buildTrackDetailsMessage(result.details);
    await ctx.helpers.showInfoDialog('Track Details', detailsText, { confirmText: 'Close' });
}

async function addTagToTrackFromContext(track) {
    const tagInput = await ctx.helpers.showPromptDialog(
        'Add Tag',
        `Add a tag for "${track.displayName}"`,
        '',
        { confirmText: 'Add Tag', cancelText: 'Cancel', placeholder: 'e.g. workout, chill, favorite' }
    );

    const trimmedTag = tagInput?.trim();
    if (!trimmedTag) return;

    const result = await window.electronAPI.addTrackTag({ filePath: track.path, tag: trimmedTag });
    if (!result?.success) {
        ctx.helpers.showNotification('error', 'Add Tag Failed', result?.error || 'Could not add tag.');
        return;
    }

    ctx.helpers.showNotification('success', 'Tag Added', `"${trimmedTag}" added to "${track.displayName}".`);
    await renderActiveTracks({ autoplayFirstTrack: false, preserveCurrentTrack: true });
}

async function editTagOnTrackFromContext(track) {
    const existingTags = Array.isArray(track.tags) ? track.tags : [];
    if (existingTags.length === 0) return;

    const currentTag = existingTags[0];
    const tagInput = await ctx.helpers.showPromptDialog(
        'Edit Tag',
        'Edit the tag text, or leave empty to remove it.',
        currentTag,
        { confirmText: 'Save Tag', cancelText: 'Cancel', placeholder: 'Tag text' }
    );

    if (tagInput === null) return;

    const result = await window.electronAPI.updateTrackTag({
        filePath: track.path,
        oldTag: currentTag,
        newTag: tagInput,
    });

    if (!result?.success) {
        ctx.helpers.showNotification('error', 'Edit Tag Failed', result?.error || 'Could not update tag.');
        return;
    }

    const wasRemoved = !(typeof tagInput === 'string' && tagInput.trim());
    ctx.helpers.showNotification('success', wasRemoved ? 'Tag Removed' : 'Tag Updated', wasRemoved ? `Removed "${currentTag}".` : `Updated to "${tagInput.trim()}".`);
    await renderActiveTracks({ autoplayFirstTrack: false, preserveCurrentTrack: true });
}

async function goToTrackFileFromContext(track) {
    const result = await window.electronAPI.openTrackFile(track.path);
    if (!result?.success) {
        ctx.helpers.showNotification('error', 'Go to File Failed', result?.error || 'Could not open track file.');
    }
}

function updatePlaylistItemVisuals() {
    const { playerPlaylistsContainer } = ctx.elements;
    if (!playerPlaylistsContainer) return;

    const activeSet = new Set(playerState.activePlaylistIds);
    playerPlaylistsContainer.querySelectorAll('.playlist-list-item').forEach((item) => {
        const isActive = activeSet.has(item.dataset.path);
        item.classList.toggle('active', isActive);

        const toggleBtn = item.querySelector('.playlist-add-btn');
        if (!toggleBtn) return;

        toggleBtn.classList.toggle('mixed-in', isActive);
        toggleBtn.textContent = isActive ? '−' : '+';
        toggleBtn.title = isActive ? 'Remove from Mix' : 'Add to Mix';
        toggleBtn.setAttribute('aria-label', isActive ? 'Remove from Mix' : 'Add to Mix');
    });
}

function buildTracklistForPlaylist(tracks, playlistPath) {
    return tracks
        .filter(t => /\.(m4a|mp3|wav|flac|ogg|webm)$/i.test(t.path))
        .map(track => {
            const parsed = parseQueuePrefix(track.name);
            return {
                ...track,
                playlistPath,
                queueNumber: parsed.queueNumber,
                displayName: parsed.displayName,
            };
        })
        .sort((a, b) => {
            if (a.queueNumber !== null && b.queueNumber !== null) return a.queueNumber - b.queueNumber;
            if (a.queueNumber !== null) return -1;
            if (b.queueNumber !== null) return 1;
            return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
        });
}

function shuffleArray(array) {
    const newArray = [...array];
    for (let i = newArray.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
    }
    return newArray;
}

function toggleShuffle() {
    isShuffle = !isShuffle;
    const { shuffleBtn } = ctx.elements;
    
    if (isShuffle) {
        shuffleBtn.classList.add('active');
        if (currentTracklist.length > 0) {
            const currentTrack = currentTracklist[currentTrackIndex];
            currentTracklist = shuffleArray(originalTracklist);
            if (currentTrack) {
                currentTrackIndex = currentTracklist.findIndex(t => t.path === currentTrack.path);
            }
            renderTracklistUI();
        }
    } else {
        shuffleBtn.classList.remove('active');
        if (originalTracklist.length > 0) {
            const currentTrack = currentTracklist[currentTrackIndex];
            currentTracklist = [...originalTracklist];
            if (currentTrack) {
                currentTrackIndex = currentTracklist.findIndex(t => t.path === currentTrack.path);
            }
            renderTracklistUI();
        }
    }
    log('Shuffle toggled', { isShuffle });
}

function cycleRepeat() {
    repeatMode = (repeatMode + 1) % 3;
    const { repeatBtn, repeatStatusText } = ctx.elements;
    
    if (repeatMode === 0) {
        repeatBtn.classList.remove('active');
        if (repeatStatusText) repeatStatusText.textContent = '';
    } else if (repeatMode === 1) {
        repeatBtn.classList.add('active');
        if (repeatStatusText) repeatStatusText.textContent = 'Queue';
    } else if (repeatMode === 2) {
        repeatBtn.classList.add('active');
        if (repeatStatusText) repeatStatusText.textContent = 'Track';
    }
    log('Repeat mode changed', { repeatMode });
}

function renderTracklistUI() {
    const { playerTracksContainer } = ctx.elements;
    playerTracksContainer.innerHTML = '';

    if (currentTracklist.length === 0) {
        playerTracksContainer.innerHTML = `<div class="empty-playlist-message">No supported audio files found in the active playlists.</div>`;
        return;
    }

    const query = playerState.trackSearchQuery.trim().toLowerCase();
    const shouldCompactMeta = Boolean(getSingleActivePlaylistTag());
    const filteredTracks = currentTracklist
        .map((track, index) => ({ track, index }))
        .filter(({ track }) => {
            if (!query) return true;
            const tagList = Array.isArray(track.tags) ? track.tags : [];
            const tagsMatch = tagList.some(tag => tag.toLowerCase().includes(query));
            if (query.startsWith('tag:')) {
                const tagQuery = query.slice(4).trim();
                if (!tagQuery) return tagList.length > 0;
                return tagList.some(tag => tag.toLowerCase().includes(tagQuery));
            }
            return track.displayName.toLowerCase().includes(query) || tagsMatch;
        });

    filteredTracks.forEach(({ track, index }) => {
        const item = document.createElement('div');
        item.className = 'player-track-item';
        item.classList.toggle('has-playlist-tag', shouldCompactMeta);
        item.dataset.trackIndex = String(index);
        // Use the current index + 1 for the display number so it always goes 1, 2, 3...
        const renderedQueueNumber = index + 1;
        const primaryTag = Array.isArray(track.tags) && track.tags.length > 0 ? track.tags[0] : '';
        const hasMoreTags = Array.isArray(track.tags) && track.tags.length > 1;
        const tagSuffix = hasMoreTags ? ` +${track.tags.length - 1}` : '';
        const tagMarkup = primaryTag
            ? `<span class="track-tag-shell"><span class="track-tag-badge" title="${primaryTag}">${primaryTag}${tagSuffix}</span></span>`
            : `<span class="track-tag-shell empty"></span>`;

        item.innerHTML = `<span class="track-number">${String(renderedQueueNumber).padStart(2, '0')}</span><span class="player-track-name" title="${track.displayName}">${track.displayName}</span><span class="player-track-meta"><span class="track-duration" title="Track duration">${formatTrackListDuration(track.duration)}</span>${tagMarkup}</span>`;
        item.addEventListener('click', () => playTrack(index));

        item.addEventListener('contextmenu', (event) => {
            event.preventDefault();
            const menuItems = [
                {
                    label: 'Play',
                    action: () => playTrack(index),
                },
                { type: 'separator' },
                {
                    label: 'More info',
                    action: async () => {
                        await showTrackInfoFromContext(track);
                    },
                },
                {
                    label: 'Add tag',
                    action: async () => {
                        await addTagToTrackFromContext(track);
                    },
                },
                {
                    label: 'Go to file',
                    action: async () => {
                        await goToTrackFileFromContext(track);
                    },
                },
                {
                    label: 'Show in folder',
                    action: () => window.electronAPI.showInExplorer(track.path),
                },
            ];

            if (Array.isArray(track.tags) && track.tags.length > 0) {
                menuItems.splice(4, 0, {
                    label: 'Edit tag',
                    action: async () => {
                        await editTagOnTrackFromContext(track);
                    },
                });
            }

            menuItems.push(
                { type: 'separator' },
                {
                    label: 'Remove from library',
                    action: async () => {
                        await deleteTrackFromContext(track);
                    },
                }
            );

            ctx.helpers.showContextMenu(event.clientX, event.clientY, menuItems);
        });
        playerTracksContainer.appendChild(item);
    });
    
    highlightCurrentTrack();
}

async function renderActiveTracks(options = {}) {
    const { autoplayFirstTrack = false, preserveCurrentTrack = true } = options;
    const { playerTracksContainer } = ctx.elements;
    const activeIds = [...playerState.activePlaylistIds];

    if (activeIds.length === 0) {
        log('Render tracks called with no active playlists');
        playerTracksContainer.innerHTML = `<div class="empty-playlist-message">Select a playlist to see its tracks.</div>`;
        playerState.activePlaylistSummaries = [];
        renderTracksStats();
        updateTracksHeader();
        currentTracklist = [];
        currentTrackIndex = -1;
        resetPlaybackState();
        return;
    }

    const previousTrackPath = currentTracklist[currentTrackIndex]?.path || null;
    const wasPlaying = !audio.paused;

    try {
        log('Loading tracks for active playlists', { activeIds, autoplayFirstTrack, preserveCurrentTrack });
        const allPlaylistResults = await Promise.all(activeIds.map(playlistPath => window.electronAPI.getPlaylistTracks(playlistPath)));

        const mergedTracklist = [];
        playerState.activePlaylistSummaries = allPlaylistResults.map(({ tracks }, resultIndex) => {
            const trackCount = Array.isArray(tracks) ? tracks.length : 0;
            const durationSeconds = (Array.isArray(tracks) ? tracks : []).reduce((sum, track) => {
                const duration = Number.isFinite(track.duration) ? track.duration : 0;
                return sum + duration;
            }, 0);

            const playlistPath = activeIds[resultIndex];
            const playlist = getPlaylistByPath(playlistPath);
            return {
                path: playlistPath,
                name: playlist?.name || getPlaylistNameByPath(playlistPath),
                trackCount,
                durationSeconds,
            };
        });

        allPlaylistResults.forEach(({ tracks }, resultIndex) => {
            mergedTracklist.push(...buildTracklistForPlaylist(tracks, activeIds[resultIndex]));
        });

        updateTracksHeader();
        renderTracksStats();

        const normalizedTracklist = normalizeQueueNumbers(mergedTracklist);
        originalTracklist = [...normalizedTracklist];
        
        if (isShuffle) {
            currentTracklist = shuffleArray(normalizedTracklist);
        } else {
            currentTracklist = normalizedTracklist;
        }

        if (currentTracklist.length === 0) {
            playerTracksContainer.innerHTML = `<div class="empty-playlist-message">No supported audio files found in the active playlists.</div>`;
            resetPlaybackState();
            return;
        }

        renderTracklistUI();

        if (preserveCurrentTrack && previousTrackPath) {
            const preservedIndex = currentTracklist.findIndex(track => track.path === previousTrackPath);
            if (preservedIndex > -1) {
                currentTrackIndex = preservedIndex;
                updateNowPlaying();
                highlightCurrentTrack();
                if (wasPlaying) {
                    if (audio.src !== currentTracklist[preservedIndex].path) {
                        audio.src = currentTracklist[preservedIndex].path;
                    }
                    play();
                }
                return;
            }
        }

        if (autoplayFirstTrack && currentTracklist.length > 0) {
            playTrack(0);
            return;
        }

        currentTrackIndex = -1;
        updateNowPlaying();
        highlightCurrentTrack();
    } catch (error) {
        logError('Failed to render tracks', { activeIds, error: error?.message });
        playerState.activePlaylistSummaries = [];
        renderTracksStats();
        updateTracksHeader();
        playerTracksContainer.innerHTML = `<div class="empty-playlist-message">Error loading tracks.</div>`;
    }
}

async function setActivePlaylists(nextIds, options = {}) {
    const normalizedIds = [...new Set(nextIds)];
    if (normalizedIds.length < 2) {
        closeMixDetailsModal();
    }
    playerState.activePlaylistIds = normalizedIds;
    playerState.selectedPlaylistPath = normalizedIds[0] || null;
    syncSharedActiveState();
    updateTracksHeader();
    updatePlaylistItemVisuals();
    await renderActiveTracks(options);
}

function highlightCurrentTrack() {
    const { playerTracksContainer } = ctx.elements;
    let activeTrackElement = null;
    playerTracksContainer.querySelectorAll('.player-track-item').forEach((item) => {
        const trackIndex = Number.parseInt(item.dataset.trackIndex, 10);
        const isPlayingTrack = trackIndex === currentTrackIndex;
        item.classList.toggle('playing', isPlayingTrack);
        if (isPlayingTrack) {
            activeTrackElement = item;
        }
    });

    if (activeTrackElement) {
        activeTrackElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
}

async function renderPlaylists() {
    const { playerPlaylistsContainer } = ctx.elements;
    try {
        log('Loading playlists for player view');

        if (ctx.state.activeQueuePaths instanceof Set) {
            playerState.activePlaylistIds = [...ctx.state.activeQueuePaths];
            playerState.selectedPlaylistPath = playerState.activePlaylistIds[0] || null;
        }

        const playlists = await window.electronAPI.getPlaylists();
        playerState.allPlaylists = playlists || [];

        const { playerPlaylistsStats } = ctx.elements;
        if (playerPlaylistsStats) {
            playerPlaylistsStats.textContent = `${playlists.length} playlist${playlists.length !== 1 ? 's' : ''} • ... tracks`;
            Promise.all(playlists.map(p => window.electronAPI.getPlaylistTracks(p.path)))
                .then(results => {
                    const totalTracks = results.reduce((sum, res) => sum + res.tracks.length, 0);
                    playerPlaylistsStats.textContent = `${playlists.length} playlist${playlists.length !== 1 ? 's' : ''} • ${totalTracks} track${totalTracks !== 1 ? 's' : ''}`;
                })
                .catch(err => logError('Failed to get track counts for stats', { error: err.message }));
        }

        const availablePlaylistIds = new Set(playerState.allPlaylists.map(p => p.path));
        const prunedActiveIds = playerState.activePlaylistIds.filter(id => availablePlaylistIds.has(id));
        const activeIdsChanged = prunedActiveIds.length !== playerState.activePlaylistIds.length;
        if (activeIdsChanged) {
            playerState.activePlaylistIds = prunedActiveIds;
            playerState.selectedPlaylistPath = prunedActiveIds[0] || null;
            syncSharedActiveState();
        }

        playerPlaylistsContainer.innerHTML = '';

        if (!playlists || playlists.length === 0) {
            playerPlaylistsContainer.innerHTML = `<div class="empty-playlist-message">No playlists found. Set the playlist folder in Settings.</div>`;
            const { playerPlaylistsStats } = ctx.elements;
            if (playerPlaylistsStats) playerPlaylistsStats.textContent = '';
            await setActivePlaylists([], { autoplayFirstTrack: false, preserveCurrentTrack: false });
            return;
        }

        const filteredPlaylists = playlists.filter(p => p.name.toLowerCase().includes(playerState.playlistSearchQuery));
        log('Filtered playlists for player view', {
            totalPlaylists: playlists.length,
            query: playerState.playlistSearchQuery,
            filteredCount: filteredPlaylists.length,
        });

        filteredPlaylists.forEach(p => {
            const item = document.createElement('div');
            item.className = 'playlist-list-item';
            item.dataset.path = p.path;
            const tags = Array.isArray(p.tags) ? p.tags : [];
            const primaryTag = tags[0] || '';
            const hasMoreTags = tags.length > 1;
            const tagSuffix = hasMoreTags ? ` +${tags.length - 1}` : '';
            const tagMarkup = primaryTag
                ? `<span class="playlist-tag-badge" title="${escapeHtml(primaryTag)}">${escapeHtml(primaryTag)}${tagSuffix}</span>`
                : '';
            item.innerHTML = `<span class="playlist-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span>${tagMarkup}<button class="playlist-add-btn" type="button" title="Add to Mix" aria-label="Add to Mix">+</button>`;

            const addBtn = item.querySelector('.playlist-add-btn');
            addBtn.addEventListener('click', async (event) => {
                event.stopPropagation();
                log('Player playlist mix toggled', { playlistName: p.name, playlistPath: p.path });
                await togglePlaylistMix(p.path);
            });

            item.addEventListener('click', async (event) => {
                if (event.target.closest('.playlist-add-btn')) return;

                log('Player playlist selected (single mode)', { playlistName: p.name, playlistPath: p.path });
                resetPlaybackState();
                await setActivePlaylists([p.path], { autoplayFirstTrack: true, preserveCurrentTrack: false });
            });

            item.addEventListener('contextmenu', (event) => {
                event.preventDefault();
                const isInMix = playerState.activePlaylistIds.includes(p.path);
                const isSmartPlaylist = Boolean(p.isSmart);
                const menuItems = [
                    {
                        label: isInMix ? 'Remove from Mix' : 'Add to Mix',
                        action: async () => {
                            await togglePlaylistMix(p.path);
                        },
                    },
                    {
                        label: 'More info',
                        action: async () => {
                            await showPlaylistInfoFromContext(p);
                        },
                    },
                ];

                if (!isSmartPlaylist) {
                    menuItems.push({
                        label: 'Add tag',
                        action: async () => {
                            await addTagToPlaylistFromContext(p);
                        },
                    });
                }

                if (!isSmartPlaylist && Array.isArray(p.tags) && p.tags.length > 0) {
                    menuItems.push({
                        label: 'Edit tag',
                        action: async () => {
                            await editTagOnPlaylistFromContext(p);
                        },
                    });
                }

                if (!isSmartPlaylist) {
                    menuItems.push(
                        { type: 'separator' },
                        {
                            label: 'Rename',
                            action: async () => {
                                await renamePlaylistFromContext(p);
                            },
                        },
                        {
                            label: 'Delete',
                            action: async () => {
                                await deletePlaylistFromContext(p);
                            },
                        },
                        { type: 'separator' },
                        {
                            label: 'Show in Folder',
                            action: () => window.electronAPI.showInExplorer(p.path),
                        },
                    );
                }

                ctx.helpers.showContextMenu(event.clientX, event.clientY, menuItems);
            });

            playerPlaylistsContainer.appendChild(item);
        });

        updateTracksHeader();
        updatePlaylistItemVisuals();

        if (activeIdsChanged) {
            await renderActiveTracks({ autoplayFirstTrack: false, preserveCurrentTrack: true });
        }

    } catch (error) {
        logError('Failed to render playlists', { error: error?.message });
        playerPlaylistsContainer.innerHTML = `<div class="empty-playlist-message">Error loading playlists.</div>`;
    }
}


// --- Initialization ---
export function initializePlayer(context) {
    ctx = context;
    const { 
        playPauseBtn, prevBtn, nextBtn,
        progressBarContainer, volumeSlider, volumeIconContainer,
        shuffleBtn, repeatBtn, playerPlaylistSearchInput, playerTrackSearchInput,
        sleepTimerBtn,
        playerTracksHeader,
        playerTracksStats,
        mixDetailsModal,
        mixDetailsCloseBtn
    } = ctx.elements;

    if (ctx.state.activeQueuePaths instanceof Set) {
        playerState.activePlaylistIds = [...ctx.state.activeQueuePaths];
        playerState.selectedPlaylistPath = playerState.activePlaylistIds[0] || null;
    }

    ctx.playerAPI.loadAndRenderPlaylists = async () => {
        await renderPlaylists();
    };

    ctx.playerAPI.unloadTrackByPath = async (trackPath) => {
        if (!trackPath) return false;
        const currentTrack = currentTracklist[currentTrackIndex];
        if (!currentTrack || currentTrack.path !== trackPath) return false;

        log('Unloading currently selected track before delete', { trackPath });
        resetPlaybackState();
        return true;
    };

    ctx.playerAPI.unloadPlaylistByPath = async (playlistPath) => {
        if (!playlistPath) return false;

        const isActivePlaylist = playerState.activePlaylistIds.includes(playlistPath);
        const currentTrack = currentTracklist[currentTrackIndex];
        const isCurrentTrackFromPlaylist =
            !!currentTrack &&
            (currentTrack.playlistPath === playlistPath || getParentDirectory(currentTrack.path) === playlistPath);

        if (!isActivePlaylist && !isCurrentTrackFromPlaylist) {
            return false;
        }

        log('Unloading playlist before delete', {
            playlistPath,
            isActivePlaylist,
            isCurrentTrackFromPlaylist,
        });

        if (isCurrentTrackFromPlaylist) {
            resetPlaybackState();
        }

        if (isActivePlaylist) {
            const nextActiveIds = playerState.activePlaylistIds.filter(id => id !== playlistPath);
            await setActivePlaylists(nextActiveIds, { autoplayFirstTrack: false, preserveCurrentTrack: false });
        }

        return true;
    };

    ctx.playerAPI.applyVisualThemeSyncSetting = (enabled) => {
        ctx.state.visualThemeSync = Boolean(enabled);

        if (!ctx.state.visualThemeSync) {
            stopVisualThemeSyncLoop();
            resetVisualSyncState();
            return;
        }

        if (!audio.paused && audio.src) {
            startVisualThemeSyncLoop();
        }
    };

    if (ctx.state.isPlayerInitialized) {
        log('Player already initialized; skipping re-init');
        renderPlaylists();
        return; // Already initialized
    }

    log('Initializing player module');

    if (playerTracksHeader) {
        playerTracksHeader.addEventListener('click', async () => {
            if (playerState.activePlaylistIds.length < 2) return;
            await openMixDetailsModal();
        });
    }

    if (playerTracksStats) {
        playerTracksStats.addEventListener('click', async () => {
            if (!playerTracksStats.classList.contains('interactive-stat')) return;
            await openMixDetailsModal();
        });
    }

    if (mixDetailsCloseBtn) {
        mixDetailsCloseBtn.addEventListener('click', () => {
            closeMixDetailsModal();
        });
    }

    if (mixDetailsModal) {
        mixDetailsModal.addEventListener('click', (event) => {
            if (event.target === mixDetailsModal) {
                closeMixDetailsModal();
            }
        });
    }

    // --- Event Listeners for Audio Element ---
    audio.addEventListener('play', () => {
        logDebug('Audio play event');
        updatePlayPauseButton(true);
        if (ctx.state?.visualThemeSync) {
            startVisualThemeSyncLoop();
        }
        emitPlayerStateUpdate();
    });
    audio.addEventListener('pause', () => {
        logDebug('Audio pause event');
        updatePlayPauseButton(false);
        stopVisualThemeSyncLoop();
        resetVisualSyncState();
        emitPlayerStateUpdate();
    });
    audio.addEventListener('timeupdate', () => {
        updateUI();
        emitPlayerStateUpdate();
    });
    audio.addEventListener('loadedmetadata', () => {
        updateUI();
        emitPlayerStateUpdate();
    });
    audio.addEventListener('ended', () => {
        logDebug('Audio ended event');
        stopVisualThemeSyncLoop();
        resetVisualSyncState();
        playNext();
    });
    audio.addEventListener('volumechange', () => {
        logDebug('Audio volume changed', { muted: audio.muted, volume: audio.volume });
        if (volumeSlider) volumeSlider.value = audio.muted ? 0 : audio.volume;
        persistVolumeSetting();
    });

    // --- Event Listeners for UI Controls ---
    playPauseBtn.addEventListener('click', togglePlayPause);
    progressBarContainer.addEventListener('click', seek);
    progressBarContainer.addEventListener('pointerdown', handleSeekPointerDown);
    progressBarContainer.addEventListener('pointermove', handleSeekPointerMove);
    progressBarContainer.addEventListener('pointerup', handleSeekPointerUp);
    progressBarContainer.addEventListener('pointercancel', clearSeekDragState);
    progressBarContainer.addEventListener('lostpointercapture', clearSeekDragState);
    volumeSlider.addEventListener('input', (e) => setVolume(e.target.value));
    volumeIconContainer.addEventListener('click', toggleMute);

    prevBtn.addEventListener('click', playPrev);
    nextBtn.addEventListener('click', playNext);
    shuffleBtn.addEventListener('click', toggleShuffle);
    repeatBtn.addEventListener('click', cycleRepeat);
    sleepTimerBtn.addEventListener('click', showSleepTimerMenu);

    window.electronAPI.onTrayPlaybackCommand(({ command }) => {
        if (command === 'play') {
            togglePlayPause();
        } else if (command === 'stop') {
            stopPlayback();
        }
    });

    window.electronAPI.onTraySleepTimerCommand(({ minutes }) => {
        const requestedMinutes = Number.parseInt(minutes, 10);
        if (!Number.isFinite(requestedMinutes) || requestedMinutes < 0) return;
        setSleepTimer(requestedMinutes);
    });

    playerPlaylistSearchInput.addEventListener('input', (e) => {
        playerState.playlistSearchQuery = e.target.value.trim().toLowerCase();
        log('Playlist search input changed', { query: playerState.playlistSearchQuery });
        renderPlaylists();
    });

    playerTrackSearchInput.addEventListener('input', (e) => {
        playerState.trackSearchQuery = e.target.value.trim().toLowerCase();
        log('Track search input changed', { query: playerState.trackSearchQuery });
        renderActiveTracks();
    });

    // --- Initial State ---
    renderPlaylists();
    updateTracksHeader();
    renderActiveTracks();
    window.electronAPI.getSettings()
        .then((settings = {}) => {
            const configuredVolume = clamp(Number.parseFloat(settings.playerVolume), 0, 1);
            const startupVolume = Number.isFinite(configuredVolume) ? configuredVolume : clamp(Number.parseFloat(volumeSlider.value), 0, 1);
            const safeStartupVolume = Number.isFinite(startupVolume) ? startupVolume : 1;
            volumeSlider.value = safeStartupVolume;
            setVolume(safeStartupVolume);
        })
        .catch((error) => {
            logWarn('Failed to load saved player volume; using current slider value', { error: error?.message });
            setVolume(volumeSlider.value);
        });
    updatePlayPauseButton(false);
    updateNowPlaying();
    emitPlayerStateUpdate();

    ctx.state.isPlayerInitialized = true;
    log('Player initialized successfully');
}

function formatDurationForSummary(totalDurationSeconds) {
    if (!Number.isFinite(totalDurationSeconds) || totalDurationSeconds <= 0) return '0:00';
    const rounded = Math.round(totalDurationSeconds);
    const hours = Math.floor(rounded / 3600);
    const minutes = Math.floor((rounded % 3600) / 60);
    return `${hours}:${String(minutes).padStart(2, '0')}`;
}