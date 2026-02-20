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
let playerState = {
    playlistSearchQuery: '',
    trackSearchQuery: '',
    selectedPlaylistPath: null,
};

// --- Helper Functions ---
function formatTime(seconds) {
    const minutes = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${minutes}:${secs < 10 ? '0' : ''}${secs}`;
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
    const progress = (audio.currentTime / audio.duration) * 100;
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

function playNext() {
    log('Play next requested', { currentTrackIndex, trackCount: currentTracklist.length });
    let nextIndex = currentTrackIndex + 1;
    if (nextIndex >= currentTracklist.length) {
        nextIndex = 0; // Loop to the beginning
    }
    playTrack(nextIndex);
}

function playPrev() {
    log('Play previous requested', { currentTrackIndex, currentTime: audio.currentTime });
    // If song is more than 3 seconds in, restart it. Otherwise, go to previous.
    if (audio.currentTime > 3) {
        audio.currentTime = 0;
    } else {
        let prevIndex = currentTrackIndex - 1;
        if (prevIndex < 0) {
            prevIndex = currentTracklist.length - 1; // Loop to the end
        }
        playTrack(prevIndex);
    }
}


function seek(event) {
    const { progressBarContainer } = ctx.elements;
    const bounds = progressBarContainer.getBoundingClientRect();
    const percentage = (event.clientX - bounds.left) / bounds.width;
    logDebug('Seek requested', { percentage });
    audio.currentTime = audio.duration * percentage;
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

function highlightCurrentTrack() {
    const { playerTracksContainer } = ctx.elements;
    playerTracksContainer.querySelectorAll('.player-track-item').forEach((item) => {
        const trackIndex = Number.parseInt(item.dataset.trackIndex, 10);
        item.classList.toggle('playing', trackIndex === currentTrackIndex);
    });
}

async function renderTracks(playlistPath, options = {}) {
    const { autoplayFirstTrack = false } = options;
    const { playerTracksContainer, playerTracksHeader } = ctx.elements;
    if (!playlistPath) {
        log('Render tracks called with no playlist selected');
        playerTracksContainer.innerHTML = `<div class="empty-playlist-message">Select a playlist to see its tracks.</div>`;
        currentTracklist = [];
        currentTrackIndex = -1;
        updateNowPlaying();
        return;
    }

    try {
        log('Loading tracks for playlist', { playlistPath, autoplayFirstTrack });
        const { tracks } = await window.electronAPI.getPlaylistTracks(playlistPath);
        // FIX: The previous filter was incorrect. This correctly filters for supported audio file extensions.
        currentTracklist = tracks
            .filter(t => /\.(m4a|mp3|wav|flac|ogg|webm)$/i.test(t.path))
            .map(track => {
                const parsed = parseQueuePrefix(track.name);
                return {
                    ...track,
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

        currentTracklist = normalizeQueueNumbers(currentTracklist);

        log('Track queue built', {
            playlistPath,
            totalTracks: currentTracklist.length,
            prefixedTracks: currentTracklist.filter(t => t.queueNumber !== null).length,
        });

        playerTracksContainer.innerHTML = '';

        if (currentTracklist.length === 0) {
            playerTracksContainer.innerHTML = `<div class="empty-playlist-message">No supported audio files found in this playlist.</div>`;
            return;
        }

        const filteredTracks = currentTracklist
            .map((track, index) => ({ track, index }))
            .filter(({ track }) => track.displayName.toLowerCase().includes(playerState.trackSearchQuery));

        log('Filtered tracks for render', {
            playlistPath,
            query: playerState.trackSearchQuery,
            filteredCount: filteredTracks.length,
        });

        filteredTracks.forEach(({ track, index }) => {
            const item = document.createElement('div');
            item.className = 'player-track-item';
            item.dataset.trackIndex = String(index);
            const renderedQueueNumber = track.normalizedQueueNumber;
            item.innerHTML = `<span class="track-number">${String(renderedQueueNumber).padStart(2, '0')}</span><span class="player-track-name" title="${track.displayName}">${track.displayName}</span>`;
            item.addEventListener('click', () => playTrack(index));
            playerTracksContainer.appendChild(item);
        });

        if (autoplayFirstTrack && currentTracklist.length > 0) {
            playTrack(0);
        } else {
            highlightCurrentTrack();
        }

    } catch (error) {
        logError('Failed to render tracks', { playlistPath, error: error?.message });
        playerTracksContainer.innerHTML = `<div class="empty-playlist-message">Error loading tracks.</div>`;
    }
}

async function renderPlaylists() {
    const { playerPlaylistsContainer } = ctx.elements;
    try {
        log('Loading playlists for player view');
        const playlists = await window.electronAPI.getPlaylists();
        playerPlaylistsContainer.innerHTML = '';

        if (!playlists || playlists.length === 0) {
            playerPlaylistsContainer.innerHTML = `<div class="empty-playlist-message">No playlists found. Set the playlist folder in Settings.</div>`;
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
            item.innerHTML = `<span class="playlist-name" title="${p.name}">${p.name}</span>`;
            item.addEventListener('click', async () => {
                playerState.selectedPlaylistPath = p.path;
                document.querySelectorAll('#player-playlists-container .playlist-list-item').forEach(el => el.classList.remove('active'));
                item.classList.add('active');
                ctx.elements.playerTracksHeader.textContent = p.name;
                log('Player playlist selected', { playlistName: p.name, playlistPath: p.path });
                resetPlaybackState();
                await renderTracks(p.path, { autoplayFirstTrack: true });
            });
            playerPlaylistsContainer.appendChild(item);
        });

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

    if (ctx.state.isPlayerInitialized) {
        log('Player already initialized; skipping re-init');
        return; // Already initialized
    }

    log('Initializing player module');

    // --- Event Listeners for Audio Element ---
    audio.addEventListener('play', () => {
        logDebug('Audio play event');
        updatePlayPauseButton(true);
    });
    audio.addEventListener('pause', () => {
        logDebug('Audio pause event');
        updatePlayPauseButton(false);
    });
    audio.addEventListener('timeupdate', updateUI);
    audio.addEventListener('loadedmetadata', updateUI);
    audio.addEventListener('ended', () => {
        logDebug('Audio ended event');
        playNext();
    });
    audio.addEventListener('volumechange', () => {
        logDebug('Audio volume changed', { muted: audio.muted, volume: audio.volume });
        if (volumeSlider) volumeSlider.value = audio.muted ? 0 : audio.volume;
    });

    // --- Event Listeners for UI Controls ---
    playPauseBtn.addEventListener('click', togglePlayPause);
    progressBarContainer.addEventListener('click', seek);
    volumeSlider.addEventListener('input', (e) => setVolume(e.target.value));
    volumeIconContainer.addEventListener('click', toggleMute);

    prevBtn.addEventListener('click', playPrev);
    nextBtn.addEventListener('click', playNext);
    // shuffleBtn.addEventListener('click', toggleShuffle); // TODO
    // repeatBtn.addEventListener('click', cycleRepeat); // TODO

    playerPlaylistSearchInput.addEventListener('input', (e) => {
        playerState.playlistSearchQuery = e.target.value.trim().toLowerCase();
        log('Playlist search input changed', { query: playerState.playlistSearchQuery });
        renderPlaylists();
    });

    playerTrackSearchInput.addEventListener('input', (e) => {
        playerState.trackSearchQuery = e.target.value.trim().toLowerCase();
        log('Track search input changed', { query: playerState.trackSearchQuery });
        renderTracks(playerState.selectedPlaylistPath);
    });

    // --- Initial State ---
    renderPlaylists();
    renderTracks(null);
    setVolume(volumeSlider.value);
    updatePlayPauseButton(false);
    updateNowPlaying();

    ctx.state.isPlayerInitialized = true;
    log('Player initialized successfully');
}