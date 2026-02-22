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

const VISUAL_SYNC_SMOOTHING = 0.2;
const SPECTROGRAM_BAR_COUNT = 56;
let playerState = {
    playlistSearchQuery: '',
    trackSearchQuery: '',
    selectedPlaylistPath: null,
    activePlaylistIds: [],
    allPlaylists: [],
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
    const gap = 2;
    const totalGapWidth = (bars - 1) * gap;
    const barWidth = Math.max((spectrogramWidth - totalGapWidth) / bars, 2);
    const baseFloor = spectrogramHeight * 0.14;
    const dynamicRange = spectrogramHeight * (0.3 + (level * 0.55));
    const spectrogramRgb = getComputedStyle(ctx.elements.root)
        .getPropertyValue('--audio-spectrogram-rgb')
        .trim() || '59, 130, 246';

    let x = 0;
    for (let index = 0; index < bars; index += 1) {
        const normalized = frequencyData[index] / 255;
        const barHeight = baseFloor + (normalized * dynamicRange);
        const alpha = 0.08 + (normalized * 0.28) + (level * 0.08);
        const y = spectrogramHeight - barHeight;
        drawContext.fillStyle = `rgba(${spectrogramRgb}, ${Math.min(alpha, 0.46).toFixed(3)})`;
        drawContext.fillRect(x, y, barWidth, barHeight);
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
    logDebug('Setting volume', { level });
    audio.volume = level;
    const { volumeIconUp, volumeIconMute } = ctx.elements;
    audio.muted = level === 0;
    volumeIconUp.classList.toggle('hidden', audio.muted);
    volumeIconMute.classList.toggle('hidden', !audio.muted);
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

function updateTracksHeader() {
    const { playerTracksHeader } = ctx.elements;
    if (!playerTracksHeader) return;

    if (playerState.activePlaylistIds.length === 0) {
        playerTracksHeader.textContent = 'Select a playlist';
        return;
    }

    if (playerState.activePlaylistIds.length === 1) {
        playerTracksHeader.textContent = getPlaylistNameByPath(playerState.activePlaylistIds[0]);
        return;
    }

    playerTracksHeader.textContent = 'Mix';
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
    const oldPath = playlist.path;
    const newPath = result.newPath;

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

    const filteredTracks = currentTracklist
        .map((track, index) => ({ track, index }))
        .filter(({ track }) => track.displayName.toLowerCase().includes(playerState.trackSearchQuery));

    filteredTracks.forEach(({ track, index }) => {
        const item = document.createElement('div');
        item.className = 'player-track-item';
        item.dataset.trackIndex = String(index);
        // Use the current index + 1 for the display number so it always goes 1, 2, 3...
        const renderedQueueNumber = index + 1;
        item.innerHTML = `<span class="track-number">${String(renderedQueueNumber).padStart(2, '0')}</span><span class="player-track-name" title="${track.displayName}">${track.displayName}</span>`;
        item.addEventListener('click', () => playTrack(index));

        item.addEventListener('contextmenu', (event) => {
            event.preventDefault();
            const menuItems = [
                {
                    label: 'Play',
                    action: () => playTrack(index),
                },
            ];

            menuItems.push(
                { type: 'separator' },
                {
                    label: 'Delete',
                    action: async () => {
                        await deleteTrackFromContext(track);
                    },
                },
                { type: 'separator' },
                {
                    label: 'Show in Folder',
                    action: () => window.electronAPI.showInExplorer(track.path),
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
        allPlaylistResults.forEach(({ tracks }, resultIndex) => {
            mergedTracklist.push(...buildTracklistForPlaylist(tracks, activeIds[resultIndex]));
        });

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
        playerTracksContainer.innerHTML = `<div class="empty-playlist-message">Error loading tracks.</div>`;
    }
}

async function setActivePlaylists(nextIds, options = {}) {
    const normalizedIds = [...new Set(nextIds)];
    playerState.activePlaylistIds = normalizedIds;
    playerState.selectedPlaylistPath = normalizedIds[0] || null;
    syncSharedActiveState();
    updateTracksHeader();
    updatePlaylistItemVisuals();
    await renderActiveTracks(options);
}

function highlightCurrentTrack() {
    const { playerTracksContainer } = ctx.elements;
    playerTracksContainer.querySelectorAll('.player-track-item').forEach((item) => {
        const trackIndex = Number.parseInt(item.dataset.trackIndex, 10);
        item.classList.toggle('playing', trackIndex === currentTrackIndex);
    });
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
            item.innerHTML = `<span class="playlist-name" title="${p.name}">${p.name}</span><button class="playlist-add-btn" type="button" title="Add to Mix" aria-label="Add to Mix">+</button>`;

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
                const menuItems = [
                    {
                        label: isInMix ? 'Remove from Mix' : 'Add to Mix',
                        action: async () => {
                            await togglePlaylistMix(p.path);
                        },
                    },
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
                ];

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
        shuffleBtn, repeatBtn, playerPlaylistSearchInput, playerTrackSearchInput
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

    // --- Event Listeners for Audio Element ---
    audio.addEventListener('play', () => {
        logDebug('Audio play event');
        updatePlayPauseButton(true);
        if (ctx.state?.visualThemeSync) {
            startVisualThemeSyncLoop();
        }
    });
    audio.addEventListener('pause', () => {
        logDebug('Audio pause event');
        updatePlayPauseButton(false);
        stopVisualThemeSyncLoop();
        resetVisualSyncState();
    });
    audio.addEventListener('timeupdate', updateUI);
    audio.addEventListener('loadedmetadata', updateUI);
    audio.addEventListener('ended', () => {
        logDebug('Audio ended event');
        stopVisualThemeSyncLoop();
        resetVisualSyncState();
        playNext();
    });
    audio.addEventListener('volumechange', () => {
        logDebug('Audio volume changed', { muted: audio.muted, volume: audio.volume });
        if (volumeSlider) volumeSlider.value = audio.muted ? 0 : audio.volume;
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
    setVolume(volumeSlider.value);
    updatePlayPauseButton(false);
    updateNowPlaying();

    ctx.state.isPlayerInitialized = true;
    log('Player initialized successfully');
}