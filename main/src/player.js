// This file contains all logic for the music player view.

let ctx = {}; // To hold context (elements, state, helpers)
const audio = new Audio();
const log = (...args) => console.log('[SoundLink][Player]', ...args);
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
        audio.src = track.path;
        play();
        updateNowPlaying();
        highlightCurrentTrack();
    }
}

function play() {
    if (audio.src) {
        audio.play().catch(e => console.error("Error playing audio:", e));
    }
}

function pause() {
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
    let nextIndex = currentTrackIndex + 1;
    if (nextIndex >= currentTracklist.length) {
        nextIndex = 0; // Loop to the beginning
    }
    playTrack(nextIndex);
}

function playPrev() {
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
    audio.currentTime = audio.duration * percentage;
}

function setVolume(level) {
    audio.volume = level;
    const { volumeIconUp, volumeIconMute } = ctx.elements;
    audio.muted = level === 0;
    volumeIconUp.classList.toggle('hidden', audio.muted);
    volumeIconMute.classList.toggle('hidden', !audio.muted);
}

function toggleMute() {
    audio.muted = !audio.muted;
    const { volumeSlider, volumeIconUp, volumeIconMute } = ctx.elements;
    volumeSlider.value = audio.muted ? 0 : audio.volume;
    volumeIconUp.classList.toggle('hidden', audio.muted);
    volumeIconMute.classList.toggle('hidden', !audio.muted);
}

// --- Playlist & Track Rendering ---

function highlightCurrentTrack() {
    const { playerTracksContainer } = ctx.elements;
    playerTracksContainer.querySelectorAll('.player-track-item').forEach((item) => {
        const trackIndex = Number.parseInt(item.dataset.trackIndex, 10);
        item.classList.toggle('playing', trackIndex === currentTrackIndex);
    });
}

async function renderTracks(playlistPath) {
    const { playerTracksContainer, playerTracksHeader } = ctx.elements;
    if (!playlistPath) {
        playerTracksContainer.innerHTML = `<div class="empty-playlist-message">Select a playlist to see its tracks.</div>`;
        currentTracklist = [];
        return;
    }

    try {
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

        filteredTracks.forEach(({ track, index }) => {
            const item = document.createElement('div');
            item.className = 'player-track-item';
            item.dataset.trackIndex = String(index);
            const renderedQueueNumber = track.queueNumber ?? (index + 1);
            item.innerHTML = `<span class="track-number">${String(renderedQueueNumber).padStart(2, '0')}</span><span class="player-track-name" title="${track.displayName}">${track.displayName}</span>`;
            item.addEventListener('click', () => playTrack(index));
            playerTracksContainer.appendChild(item);
        });
        highlightCurrentTrack();

    } catch (error) {
        console.error("Failed to render player tracks:", error);
        playerTracksContainer.innerHTML = `<div class="empty-playlist-message">Error loading tracks.</div>`;
    }
}

async function renderPlaylists() {
    const { playerPlaylistsContainer } = ctx.elements;
    try {
        const playlists = await window.electronAPI.getPlaylists();
        playerPlaylistsContainer.innerHTML = '';

        if (!playlists || playlists.length === 0) {
            playerPlaylistsContainer.innerHTML = `<div class="empty-playlist-message">No playlists found. Set the playlist folder in Settings.</div>`;
            return;
        }

        const filteredPlaylists = playlists.filter(p => p.name.toLowerCase().includes(playerState.playlistSearchQuery));

        filteredPlaylists.forEach(p => {
            const item = document.createElement('div');
            item.className = 'playlist-list-item';
            item.dataset.path = p.path;
            item.innerHTML = `<span class="playlist-name" title="${p.name}">${p.name}</span>`;
            item.addEventListener('click', () => {
                playerState.selectedPlaylistPath = p.path;
                document.querySelectorAll('#player-playlists-container .playlist-list-item').forEach(el => el.classList.remove('active'));
                item.classList.add('active');
                ctx.elements.playerTracksHeader.textContent = p.name;
                renderTracks(p.path);
            });
            playerPlaylistsContainer.appendChild(item);
        });

    } catch (error) {
        console.error("Failed to render player playlists:", error);
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
        return; // Already initialized
    }

    // --- Event Listeners for Audio Element ---
    audio.addEventListener('play', () => updatePlayPauseButton(true));
    audio.addEventListener('pause', () => updatePlayPauseButton(false));
    audio.addEventListener('timeupdate', updateUI);
    audio.addEventListener('loadedmetadata', updateUI);
    audio.addEventListener('ended', playNext);
    audio.addEventListener('volumechange', () => {
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
        renderPlaylists();
    });

    playerTrackSearchInput.addEventListener('input', (e) => {
        playerState.trackSearchQuery = e.target.value.trim().toLowerCase();
        renderTracks(playerState.selectedPlaylistPath);
    });

    // --- Initial State ---
    renderPlaylists();
    renderTracks(null);
    setVolume(volumeSlider.value);
    updatePlayPauseButton(false);
    updateNowPlaying();

    ctx.state.isPlayerInitialized = true;
}