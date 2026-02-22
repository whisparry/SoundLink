import { themeNames, themeColors } from './themes.js';
import { initializePlayer } from './player.js';

window.addEventListener('DOMContentLoaded', () => {
    // --- Element References ---
    const root = document.documentElement;
    const body = document.body;
    const closeBtn = document.getElementById('close-btn');
    const homeBtn = document.getElementById('home-btn');
    const settingsBtn = document.getElementById('settings-btn');
    const advancedSettingsBtn = document.getElementById('advanced-settings-btn');
    const openAdvancedSettingsBtn = document.getElementById('open-advanced-settings-btn');
    const backToSettingsBtn = document.getElementById('back-to-settings-btn');
    const playerBtn = document.getElementById('player-btn');
    const playlistManagementBtn = document.getElementById('playlist-management-btn');
    const consoleBtn = document.getElementById('console-btn');
    const statsBtn = document.getElementById('stats-btn');
    const notificationHistoryBtn = document.getElementById('notification-history-btn');
    const helpBtn = document.getElementById('help-btn');
    const homeView = document.getElementById('home-view');
    const settingsView = document.getElementById('settings-view');
    const advancedSettingsView = document.getElementById('advanced-settings-view');
    const playerView = document.getElementById('player-view');
    const playlistManagementView = document.getElementById('playlist-management-view');
    const consoleView = document.getElementById('console-view');
    const statsView = document.getElementById('stats-view');
    const notificationHistoryView = document.getElementById('notification-history-view');
    const helpView = document.getElementById('help-view');
    const downloadBtn = document.getElementById('download-btn');
    const linksInput = document.getElementById('links-input');
    const consoleOutput = document.getElementById('console-output');
    const cancelBtn = document.getElementById('cancel-btn');
    const bigCancelBtn = document.getElementById('big-cancel-btn');
    const loadingOverlay = document.getElementById('loading-overlay');
    const dropZone = document.getElementById('drop-zone');
    const createPlaylistBtn = document.getElementById('create-playlist-btn');
    const updateNotification = document.getElementById('update-notification');
    const updateMessage = document.getElementById('update-message');
    const restartBtn = document.getElementById('restart-btn');
    const toastNotification = document.getElementById('toast-notification');
    const toastIcon = document.getElementById('toast-icon');
    const toastTitle = document.getElementById('toast-title');
    const toastMessage = document.getElementById('toast-message');
    const toastCloseBtn = document.getElementById('toast-close-btn');
    const notificationHistoryContainer = document.getElementById('notification-history-container');
    const clearHistoryBtn = document.getElementById('clear-history-btn');
    const themeGridContainer = document.getElementById('theme-grid');
    const favoriteThemeGrid = document.getElementById('favorite-theme-grid');
    const favoritesContainer = document.getElementById('favorites-container');
    const fileExtensionInput = document.getElementById('fileExtension');
    const downloadThreadsInput = document.getElementById('downloadThreads');
    const clientIdInput = document.getElementById('clientId');
    const clientSecretInput = document.getElementById('clientSecret');
    const toggleSecretBtn = document.getElementById('toggle-secret-btn');
    const downloadsPathInput = document.getElementById('downloadsPath');
    const changePathBtn = document.getElementById('change-path-btn');
    const playlistsPathInput = document.getElementById('playlistsPath');
    const changePlaylistsPathBtn = document.getElementById('change-playlists-path-btn');
    const pmPlaylistsContainer = document.getElementById('pm-playlists-container');
    const pmFavoritePlaylistsContainer = document.getElementById('pm-favorite-playlists-container');
    const pmFavoritePlaylistsGrid = document.getElementById('pm-favorite-playlists-grid');
    const pmAllPlaylistsGrid = document.getElementById('pm-all-playlists-grid');
    const pmTracksContainer = document.getElementById('pm-tracks-container');
    const pmTracksHeader = document.getElementById('pm-tracks-header');
    const pmPlaylistSearchInput = document.getElementById('pm-playlist-search-input');
    const pmTrackSearchInput = document.getElementById('pm-track-search-input');
    const createNewPlaylistBtnPm = document.getElementById('create-new-playlist-btn-pm');
    const moveTrackModal = document.getElementById('move-track-modal');
    const moveTrackNameEl = document.getElementById('move-track-name');
    const moveTrackDestinationSelect = document.getElementById('move-track-destination-select');
    const moveTrackConfirmBtn = document.getElementById('move-track-confirm-btn');
    const moveTrackCancelBtn = document.getElementById('move-track-cancel-btn');
    const modalCloseBtn = document.querySelector('.modal-close-btn');
    const totalSongsStat = document.getElementById('total-songs-stat');
    const playlistsCreatedStat = document.getElementById('playlists-created-stat');
    const downloadsInitiatedStat = document.getElementById('downloads-initiated-stat');
    const songsFailedStat = document.getElementById('songs-failed-stat');
    const linksProcessedStat = document.getElementById('links-processed-stat');
    const spotifyLinksStat = document.getElementById('spotify-links-stat');
    const youtubeLinksStat = document.getElementById('youtube-links-stat');
    const successRateStat = document.getElementById('success-rate-stat');
    const notificationsReceivedStat = document.getElementById('notifications-received-stat');
    const resetStatsBtn = document.getElementById('reset-stats-btn');
    const configCategoryHeader = document.getElementById('config-category-header');
    const themesCategoryHeader = document.getElementById('themes-category-header');
    const animationsCategoryHeader = document.getElementById('animations-category-header');
    const tabSpeedSlider = document.getElementById('tab-speed-slider');
    const tabSpeedValue = document.getElementById('tab-speed-value');
    const dropdownSpeedSlider = document.getElementById('dropdown-speed-slider');
    const dropdownSpeedValue = document.getElementById('dropdown-speed-value');
    const themeFadeSlider = document.getElementById('theme-fade-slider');
    const themeFadeValue = document.getElementById('theme-fade-value');
    const autoCreatePlaylistInput = document.getElementById('autoCreatePlaylist');
    const hideRefreshButtonsInput = document.getElementById('hideRefreshButtons');
    const hidePlaylistCountsInput = document.getElementById('hidePlaylistCounts');
    const hideTrackNumbersInput = document.getElementById('hideTrackNumbers');
    const normalizeVolumeInput = document.getElementById('normalizeVolume');
    const hideSearchBarsInput = document.getElementById('hideSearchBars');
    const hideMixButtonsInput = document.getElementById('hideMixButtons');
    const skipManualLinkPromptInput = document.getElementById('skipManualLinkPrompt');
    const durationToleranceSecondsInput = document.getElementById('durationToleranceSeconds');
    const silenceTrimThresholdDbInput = document.getElementById('silenceTrimThresholdDb');
    const updateYtdlpBtn = document.getElementById('update-ytdlp-btn');
    const checkForUpdatesBtn = document.getElementById('check-for-updates-btn');
    const clearCacheBtn = document.getElementById('clear-cache-btn');
    const trimLibrarySilenceBtn = document.getElementById('trim-library-silence-btn');
    const spotifyLink = document.getElementById('spotify-link');
    const spotifySearchInput = document.getElementById('spotify-search-input');
    const spotifyResultsDropdown = document.getElementById('spotify-results-dropdown');
    const spotifyFilterBtn = document.getElementById('spotify-filter-btn');
    const spotifyFilterDropdown = document.getElementById('spotify-filter-dropdown');
    const spotifySearchLimitInput = document.getElementById('spotify-search-limit');
    const downloadProgressContainer = document.getElementById('download-progress-container');
    const downloadProgressBar = document.getElementById('download-progress-bar');
    const downloadEta = document.getElementById('download-eta');
    const contextMenu = document.getElementById('context-menu');

    const nowPlaying = document.getElementById('now-playing');
    const playPauseBtn = document.getElementById('play-pause-btn');
    const prevBtn = document.getElementById('prev-btn');
    const nextBtn = document.getElementById('next-btn');
    const shuffleBtn = document.getElementById('shuffle-btn');
    const repeatBtn = document.getElementById('repeat-btn');
    const repeatStatusText = document.getElementById('repeat-status-text');
    const progressBar = document.getElementById('progress-bar');
    const progressBarContainer = document.getElementById('progress-bar-container');
    const currentTime = document.getElementById('current-time');
    const totalDuration = document.getElementById('total-duration');
    const volumeSlider = document.getElementById('volume-slider');
    const volumeIconContainer = document.getElementById('volume-icon-container');
    const volumeIconUp = document.getElementById('volume-icon-up');
    const volumeIconMute = document.getElementById('volume-icon-mute');

    const playerPlaylistsContainer = document.getElementById('player-playlists-container');
    const playerTracksContainer = document.getElementById('player-tracks-container');
    const playerTracksHeader = document.getElementById('player-tracks-header');
    const playerPlaylistSearchInput = document.getElementById('player-playlist-search-input');
    const playerTrackSearchInput = document.getElementById('player-track-search-input');

    const spotifyPreviewModal = document.getElementById('spotify-preview-modal');
    const previewModalTitle = document.getElementById('preview-modal-title');
    const previewModalContent = document.getElementById('preview-modal-content');
    const previewModalCloseBtn = document.getElementById('preview-modal-close-btn');
    const previewAddAllBtn = document.getElementById('preview-add-all-btn');
    const appDialogModal = document.getElementById('app-dialog-modal');
    const appDialogTitle = document.getElementById('app-dialog-title');
    const appDialogMessage = document.getElementById('app-dialog-message');
    const appDialogInput = document.getElementById('app-dialog-input');
    const appDialogConfirmBtn = document.getElementById('app-dialog-confirm-btn');
    const appDialogCancelBtn = document.getElementById('app-dialog-cancel-btn');

    const statsDetailModal = document.getElementById('stats-detail-modal');
    const statsDetailTitle = document.getElementById('stats-detail-title');
    const statsDetailContent = document.getElementById('stats-detail-content');
    const statsDetailCloseBtn = statsDetailModal?.querySelector('.modal-close-btn');

    // --- STATE & CONTEXT (Centralized) ---
    const state = {
        currentThemeName: 'dark',
        favoriteThemes: [],
        favoritePlaylists: [],
        playlists: [],
        isPmInitialized: false,
        isPlayerInitialized: false,
        pmSelectedPlaylistPath: null,
        activePlaylistPath: null,
        activeQueuePaths: new Set(),
        trackToMove: null,
        draggedTrackIndex: null,
        toastTimer: null,
        activeToastNotificationId: null,
        notificationHistory: [],
        playlistSearchQuery: '',
        spotifySearchDebounce: null,
        spotifySearchType: 'playlist',
        spotifyPreviewTracks: [],
        activeSilenceTrimJobId: null,
        lastSilenceTrimProgressTick: 0,
    };

    // --- Helper Functions ---
    const emitLog = (level, scope, message, data) => {
        const payload = { level, scope, message, data };
        try {
            window.electronAPI?.log?.(payload);
        } catch (_) {
            // noop
        }

        if (level === 'error') {
            if (data !== undefined) console.error(`[SoundLink][${scope}] ${message}`, data);
            else console.error(`[SoundLink][${scope}] ${message}`);
        } else if (level === 'warn') {
            if (data !== undefined) console.warn(`[SoundLink][${scope}] ${message}`, data);
            else console.warn(`[SoundLink][${scope}] ${message}`);
        } else {
            if (data !== undefined) console.log(`[SoundLink][${scope}] ${message}`, data);
            else console.log(`[SoundLink][${scope}] ${message}`);
        }
    };

    const log = (message, data) => emitLog('info', 'Renderer', message, data);
    const logDebug = (message, data) => emitLog('debug', 'Renderer', message, data);
    const logWarn = (message, data) => emitLog('warn', 'Renderer', message, data);
    const logTab = (tab, action, data = undefined) => {
        if (data !== undefined) emitLog('info', `Tab:${tab}`, action, data);
        else emitLog('info', `Tab:${tab}`, action);
    };
    const logError = (scope, error, data = undefined) => {
        const message = typeof error === 'string' ? error : (error?.message || 'Unknown error');
        if (data !== undefined) emitLog('error', scope, message, data);
        else emitLog('error', scope, message);
    };

    const showLoader = () => loadingOverlay.classList.remove('hidden');
    const hideLoader = () => loadingOverlay.classList.add('hidden');

    logDebug('Renderer DOM content loaded');

    const allViews = [homeView, settingsView, advancedSettingsView, playerView, playlistManagementView, statsView, notificationHistoryView, consoleView, helpView].filter(Boolean);
    const allNavBtns = [homeBtn, settingsBtn, playerBtn, playlistManagementBtn, statsBtn, notificationHistoryBtn, consoleBtn, helpBtn].filter(Boolean);
    async function showView(viewToShow, btnToActivate) {
        log('Switching view', { viewId: viewToShow?.id, navId: btnToActivate?.id });
        // FIX: Restore full showView functionality to handle nav button states and saving settings.
        if (settingsView.classList.contains('active-view') || advancedSettingsView.classList.contains('active-view')) {
            await saveSettings();
            showNotification('success', 'Settings Saved', 'Your changes have been applied.');
        }
        allViews.forEach(view => view.classList.remove('active-view'));
        viewToShow.classList.add('active-view');
        allNavBtns.forEach(btn => btn.classList.remove('active'));
        btnToActivate.classList.add('active');
        const viewToTabMap = {
            'home-view': 'Home',
            'settings-view': 'Settings',
            'advanced-settings-view': 'AdvancedSettings',
            'player-view': 'Player',
            'playlist-management-view': 'PlaylistManagement',
            'console-view': 'Console',
            'stats-view': 'Stats',
            'notification-history-view': 'NotificationHistory',
            'help-view': 'Help',
        };
        const tabName = viewToTabMap[viewToShow?.id] || viewToShow?.id || 'Unknown';
        logTab(tabName, 'loaded');
    }

    const hideContextMenu = () => {
        if (contextMenu) contextMenu.classList.add('hidden');
    };

    const showContextMenu = (x, y, items) => {
        if (!contextMenu) return;
        contextMenu.innerHTML = '';
        const menuList = document.createElement('ul');
        menuList.className = 'context-menu-list';

        items.forEach(item => {
            if (item.type === 'separator') {
                const separator = document.createElement('li');
                separator.className = 'context-menu-separator';
                menuList.appendChild(separator);
            } else {
                const listItem = document.createElement('li');
                listItem.className = 'context-menu-item';
                listItem.textContent = item.label;
                listItem.addEventListener('click', () => {
                    item.action();
                    hideContextMenu();
                });
                menuList.appendChild(listItem);
            }
        });

        contextMenu.appendChild(menuList);
        contextMenu.classList.remove('hidden');

        const menuWidth = contextMenu.offsetWidth;
        const menuHeight = contextMenu.offsetHeight;
        const { innerWidth, innerHeight } = window;

        contextMenu.style.left = `${x + menuWidth > innerWidth ? innerWidth - menuWidth - 5 : x}px`;
        contextMenu.style.top = `${y + menuHeight > innerHeight ? innerHeight - menuHeight - 5 : y}px`;
    };

    const showCustomDialog = ({
        title,
        message,
        confirmText = 'Confirm',
        cancelText = 'Cancel',
        danger = false,
        prompt = false,
        initialValue = '',
        placeholder = '',
    }) => {
        return new Promise(resolve => {
            if (!appDialogModal || !appDialogTitle || !appDialogMessage || !appDialogConfirmBtn || !appDialogCancelBtn || !appDialogInput) {
                resolve(prompt ? null : false);
                return;
            }

            log('Opening custom dialog', { title, prompt, danger });
            appDialogTitle.textContent = title;
            appDialogMessage.textContent = message;
            appDialogConfirmBtn.textContent = confirmText;
            appDialogCancelBtn.textContent = cancelText;
            appDialogConfirmBtn.classList.toggle('danger', danger);

            if (prompt) {
                appDialogInput.classList.remove('hidden');
                appDialogInput.value = initialValue;
                appDialogInput.placeholder = placeholder;
            } else {
                appDialogInput.classList.add('hidden');
                appDialogInput.value = '';
                appDialogInput.placeholder = '';
            }

            appDialogModal.classList.remove('hidden');

            const cleanup = () => {
                appDialogModal.classList.add('hidden');
                appDialogConfirmBtn.classList.remove('danger');
                appDialogConfirmBtn.removeEventListener('click', onConfirm);
                appDialogCancelBtn.removeEventListener('click', onCancel);
                appDialogModal.removeEventListener('click', onOverlayClick);
                appDialogInput.removeEventListener('keydown', onInputKeydown);
            };

            const onConfirm = () => {
                const value = prompt ? appDialogInput.value : true;
                cleanup();
                resolve(value);
            };

            const onCancel = () => {
                cleanup();
                resolve(prompt ? null : false);
            };

            const onOverlayClick = (event) => {
                if (event.target === appDialogModal) onCancel();
            };

            const onInputKeydown = (event) => {
                if (event.key === 'Enter') onConfirm();
                if (event.key === 'Escape') onCancel();
            };

            appDialogConfirmBtn.addEventListener('click', onConfirm);
            appDialogCancelBtn.addEventListener('click', onCancel);
            appDialogModal.addEventListener('click', onOverlayClick);
            appDialogInput.addEventListener('keydown', onInputKeydown);

            if (prompt) {
                setTimeout(() => {
                    appDialogInput.focus();
                    appDialogInput.select();
                }, 0);
            }
        });
    };

    const showConfirmDialog = (title, message, options = {}) => showCustomDialog({ title, message, ...options, prompt: false });
    const showPromptDialog = (title, message, initialValue = '', options = {}) => showCustomDialog({ title, message, initialValue, ...options, prompt: true });

    const saveSettings = async () => {
        const newSettings = {
            theme: state.currentThemeName,
            favoriteThemes: state.favoriteThemes,
            favoritePlaylists: state.favoritePlaylists,
            fileExtension: fileExtensionInput.value,
            downloadThreads: parseInt(downloadThreadsInput.value, 10),
            spotifySearchLimit: parseInt(spotifySearchLimitInput.value, 10),
            spotify: { clientId: clientIdInput.value, clientSecret: clientSecretInput.value },
            downloadsPath: downloadsPathInput.value,
            playlistsFolderPath: playlistsPathInput.value,
            autoCreatePlaylist: autoCreatePlaylistInput.checked,
            hideRefreshButtons: hideRefreshButtonsInput.checked,
            hidePlaylistCounts: hidePlaylistCountsInput.checked,
            hideTrackNumbers: hideTrackNumbersInput.checked,
            normalizeVolume: normalizeVolumeInput.checked,
            hideSearchBars: hideSearchBarsInput.checked,
            hideMixButtons: hideMixButtonsInput.checked,
            skipManualLinkPrompt: skipManualLinkPromptInput.checked,
            durationToleranceSeconds: parseInt(durationToleranceSecondsInput.value, 10),
            silenceTrimThresholdDb: parseInt(silenceTrimThresholdDbInput.value, 10),
        };
        await window.electronAPI.saveSettings(newSettings);
    };

    // --- Context Object for Modules ---
    const context = {
        elements: {
            root,
            body,
            closeBtn,
            homeBtn,
            settingsBtn,
            advancedSettingsBtn,
            openAdvancedSettingsBtn,
            backToSettingsBtn,
            playerBtn,
            playlistManagementBtn,
            consoleBtn,
            statsBtn,
            notificationHistoryBtn,
            helpBtn,
            homeView,
            settingsView,
            advancedSettingsView,
            playerView,
            playlistManagementView,
            consoleView,
            statsView,
            notificationHistoryView,
            helpView,
            downloadBtn,
            linksInput,
            consoleOutput,
            cancelBtn,
            bigCancelBtn,
            loadingOverlay,
            dropZone,
            createPlaylistBtn,
            updateNotification,
            updateMessage,
            restartBtn,
            toastNotification,
            toastIcon,
            toastTitle,
            toastMessage,
            toastCloseBtn,
            notificationHistoryContainer,
            clearHistoryBtn,
            themeGridContainer,
            favoriteThemeGrid,
            favoritesContainer,
            fileExtensionInput,
            downloadThreadsInput,
            clientIdInput,
            clientSecretInput,
            toggleSecretBtn,
            downloadsPathInput,
            changePathBtn,
            playlistsPathInput,
            changePlaylistsPathBtn,
            pmPlaylistsContainer,
            pmFavoritePlaylistsContainer,
            pmFavoritePlaylistsGrid,
            pmAllPlaylistsGrid,
            pmTracksContainer,
            pmTracksHeader,
            pmPlaylistSearchInput,
            pmTrackSearchInput,
            createNewPlaylistBtnPm,
            moveTrackModal,
            moveTrackNameEl,
            moveTrackDestinationSelect,
            moveTrackConfirmBtn,
            moveTrackCancelBtn,
            modalCloseBtn,
            totalSongsStat,
            playlistsCreatedStat,
            downloadsInitiatedStat,
            songsFailedStat,
            linksProcessedStat,
            spotifyLinksStat,
            youtubeLinksStat,
            successRateStat,
            notificationsReceivedStat,
            resetStatsBtn,
            configCategoryHeader,
            themesCategoryHeader,
            animationsCategoryHeader,
            tabSpeedSlider,
            tabSpeedValue,
            dropdownSpeedSlider,
            dropdownSpeedValue,
            themeFadeSlider,
            themeFadeValue,
            autoCreatePlaylistInput,
            hideRefreshButtonsInput,
            hidePlaylistCountsInput,
            hideTrackNumbersInput,
            normalizeVolumeInput,
            hideSearchBarsInput,
            hideMixButtonsInput,
            updateYtdlpBtn,
            clearCacheBtn,
            spotifyLink,
            spotifySearchInput,
            spotifyResultsDropdown,
            spotifyFilterBtn,
            spotifyFilterDropdown,
            spotifySearchLimitInput,
            checkForUpdatesBtn,
            downloadProgressContainer,
            downloadProgressBar,
            downloadEta,
            shuffleBtn,
            repeatBtn,
            repeatStatusText,
            nowPlaying,
            playPauseBtn,
            prevBtn,
            nextBtn,
            progressBar,
            progressBarContainer,
            currentTime,
            totalDuration,
            volumeSlider,
            volumeIconContainer,
            volumeIconUp,
            volumeIconMute,
            playerPlaylistsContainer,
            playerTracksContainer,
            playerTracksHeader,
            playerPlaylistSearchInput,
            playerTrackSearchInput,
        },
        state: state,
        helpers: { showLoader, hideLoader, saveSettings, showView, showContextMenu, hideContextMenu },
        playerAPI: {},
        pmAPI: {},
    };
    context.helpers.showConfirmDialog = showConfirmDialog;
    context.helpers.showPromptDialog = showPromptDialog;

    // --- Spotify Playlist Search ---
    spotifyFilterBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        logTab('Home', 'spotify filter toggled');
        spotifyFilterDropdown.classList.toggle('hidden');
    });

    spotifyFilterDropdown.addEventListener('click', (e) => {
        if (e.target.classList.contains('spotify-filter-item')) {
            document.querySelectorAll('.spotify-filter-item').forEach(el => el.classList.remove('active'));
            e.target.classList.add('active');
            state.spotifySearchType = e.target.dataset.type;
            const typeName = e.target.textContent;
            logTab('Home', 'spotify search type changed', { type: state.spotifySearchType });
            spotifySearchInput.placeholder = `Search Spotify ${typeName}...`;
            spotifyFilterDropdown.classList.add('hidden');
            if (spotifySearchInput.value.trim().length >= 3) {
                spotifySearchInput.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }
    });

    spotifySearchInput.addEventListener('input', () => {
        clearTimeout(state.spotifySearchDebounce);
        const query = spotifySearchInput.value.trim();
        logTab('Home', 'spotify search input', { queryLength: query.length });

        if (query.length < 3) {
            spotifyResultsDropdown.classList.add('hidden');
            return;
        }

        state.spotifySearchDebounce = setTimeout(async () => {
            const limit = parseInt(spotifySearchLimitInput.value, 10) || 10;
            logTab('Home', 'spotify search request', { query, limit, type: state.spotifySearchType });
            const results = await window.electronAPI.searchSpotifyPlaylists({ query, type: state.spotifySearchType, limit });
            spotifyResultsDropdown.innerHTML = '';

            if (results.error) {
                const errorItem = document.createElement('div');
                errorItem.className = 'spotify-result-item';
                errorItem.innerHTML = `<p class="spotify-result-name" style="color: var(--danger-primary);">Error</p><p class="spotify-result-owner">${results.error}</p>`;
                spotifyResultsDropdown.appendChild(errorItem);
                spotifyResultsDropdown.classList.remove('hidden');
                return;
            }

            if (!results || results.length === 0) {
                const noResultsItem = document.createElement('div');
                noResultsItem.className = 'spotify-result-item';
                noResultsItem.innerHTML = `<p class="spotify-result-owner">No playlists found for "${query}"</p>`;
                spotifyResultsDropdown.appendChild(noResultsItem);
                spotifyResultsDropdown.classList.remove('hidden');
                return;
            }

            results.forEach(item => {
                const resultEl = document.createElement('div');
                resultEl.className = 'spotify-result-item';
                const spotifyId = item.url.split('/').pop();
                resultEl.dataset.id = spotifyId;
                resultEl.dataset.type = item.type.toLowerCase();

                let ownerText = '';
                if (item.type === 'Playlist') ownerText = `by ${item.owner}`;
                else if (item.type === 'Track' || item.type === 'Album') ownerText = `by ${item.artist}`;

                let typeLabel = '';
                if (state.spotifySearchType === 'all' && item.type) {
                    typeLabel = `<span class="spotify-result-type">${item.type}</span>`;
                }

                resultEl.innerHTML = `
                    <div class="spotify-result-main">
                        <p class="spotify-result-name" title="${item.name}">${item.name}</p>
                        ${typeLabel}
                    </div>
                    <p class="spotify-result-owner">${ownerText}</p>`;
                
                resultEl.addEventListener('click', () => {
                    logTab('Home', 'spotify result selected', { itemType: item.type, itemName: item.name });
                    linksInput.value += (linksInput.value ? '\n' : '') + item.url;
                    spotifySearchInput.value = '';
                    spotifyResultsDropdown.classList.add('hidden');
                    linksInput.dispatchEvent(new Event('input', { bubbles: true })); // Trigger clear button check
                });

                resultEl.addEventListener('contextmenu', async (e) => {
                    e.preventDefault();
                    logTab('Home', 'spotify result context preview opened', { itemType: item.type, itemName: item.name });
                    if (!spotifyPreviewModal || !previewModalTitle || !previewModalContent) {
                        showNotification('info', 'Preview Unavailable', 'Spotify track preview UI is not available in this build.');
                        return;
                    }
                    previewModalTitle.textContent = 'Loading...';
                    previewModalContent.innerHTML = '<div class="spinner"></div>';
                    spotifyPreviewModal.classList.remove('hidden');

                    const details = await window.electronAPI.getSpotifyItemDetails({ type: resultEl.dataset.type, id: resultEl.dataset.id });

                    if (details && !details.error) {
                        previewModalTitle.textContent = `${item.type}: ${details.name}`;
                        previewModalContent.innerHTML = '';
                        state.spotifyPreviewTracks = details.tracks;
                        details.tracks.forEach((track, index) => {
                            const trackEl = document.createElement('div');
                            trackEl.className = 'preview-track-item';
                            trackEl.innerHTML = `
                                <span class="preview-track-number">${index + 1}.</span>
                                <div class="preview-track-details">
                                    <span class="preview-track-name" title="${track.name}">${track.name}</span>
                                    <span class="preview-track-artist" title="${track.artist}">${track.artist}</span>
                                </div>
                            `;
                            previewModalContent.appendChild(trackEl);
                        });
                    } else {
                        previewModalTitle.textContent = 'Error';
                        previewModalContent.innerHTML = `<p>${details.error || 'Could not load details.'}</p>`;
                        state.spotifyPreviewTracks = [];
                    }
                });

                spotifyResultsDropdown.appendChild(resultEl);
            });
            spotifyResultsDropdown.classList.remove('hidden');
        }, 300);
    });

    document.addEventListener('click', (e) => {
        if (!spotifySearchInput.contains(e.target) && !spotifyResultsDropdown.contains(e.target)) {
            spotifyResultsDropdown.classList.add('hidden');
        }
        if (!spotifyFilterBtn.contains(e.target) && !spotifyFilterDropdown.contains(e.target)) {
            spotifyFilterDropdown.classList.add('hidden');
        }
        if (contextMenu && !contextMenu.contains(e.target)) {
            hideContextMenu();
        }
    });

    if (previewModalCloseBtn && spotifyPreviewModal) {
        previewModalCloseBtn.addEventListener('click', () => spotifyPreviewModal.classList.add('hidden'));
    }

    if (previewAddAllBtn && spotifyPreviewModal) {
        previewAddAllBtn.addEventListener('click', () => {
            if (state.spotifyPreviewTracks.length > 0) {
                const links = state.spotifyPreviewTracks.map(t => t.url).join('\n');
                linksInput.value += (linksInput.value ? '\n' : '') + links;
                linksInput.dispatchEvent(new Event('input', { bubbles: true }));
                showNotification('success', 'Added to Queue', `${state.spotifyPreviewTracks.length} tracks added to the download input.`);
            }
            spotifyPreviewModal.classList.add('hidden');
        });
    }

    // --- Clear Input Button Logic ---
    function initializeClearButtons() {
        document.querySelectorAll('.input-container').forEach(container => {
            const input = container.querySelector('input, textarea');
            const clearBtn = container.querySelector('.clear-btn');
            if (input && clearBtn) {
                const toggleClearButton = () => clearBtn.classList.toggle('hidden', input.value.length === 0);
                input.addEventListener('input', toggleClearButton);
                clearBtn.addEventListener('click', () => {
                    log('Input clear button clicked', { inputId: input.id || 'unknown' });
                    input.value = '';
                    input.focus();
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                });
                toggleClearButton();
            }
        });
    }

    // --- Notification History Logic ---
    function saveNotificationHistory() {
        try {
            localStorage.setItem('notificationHistory', JSON.stringify(state.notificationHistory));
        } catch (e) {
            logError('NotificationHistory', 'Failed to save notification history', e);
        }
    }

    function loadNotificationHistory() {
        try {
            const storedHistory = localStorage.getItem('notificationHistory');
            if (storedHistory) {
                const parsed = JSON.parse(storedHistory);
                state.notificationHistory = Array.isArray(parsed) ? parsed.map((entry) => ({
                    id: entry.id || `${entry.timestamp || Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                    type: entry.type,
                    title: entry.title,
                    message: entry.message,
                    timestamp: entry.timestamp || new Date().toISOString(),
                    undoAction: entry.undoAction || null,
                    undone: Boolean(entry.undone),
                })) : [];
            }
        } catch (e) {
            logError('NotificationHistory', 'Failed to load notification history', e);
            state.notificationHistory = [];
        }
    }

    const findNotificationById = (notificationId) => {
        return state.notificationHistory.find((entry) => entry.id === notificationId) || null;
    };

    async function refreshAfterUndo() {
        if (state.isPlayerInitialized) {
            await context.playerAPI?.loadAndRenderPlaylists?.();
        }
        await context.pmAPI?.refresh?.();
    }

    async function maybeUndoNotification(notificationId) {
        const notification = findNotificationById(notificationId);
        if (!notification || !notification.undoAction || notification.undone) return;

        const confirmed = await showConfirmDialog(
            'Undo action?',
            'Undo action?',
            { confirmText: 'Yes', cancelText: 'No' }
        );
        if (!confirmed) return;

        const result = await window.electronAPI.undoAction(notification.undoAction);
        if (!result?.success) {
            showNotification('error', 'Undo Failed', result?.error || 'Unable to undo this action.');
            return;
        }

        notification.undone = true;
        saveNotificationHistory();
        renderNotificationHistory();
        await refreshAfterUndo();
        showNotification('success', 'Undo Complete', 'Action has been undone.');
    }

    function renderNotificationHistory() {
        if (!notificationHistoryContainer) return;
        notificationHistoryContainer.innerHTML = '';
        if (state.notificationHistory.length === 0) {
            notificationHistoryContainer.innerHTML = `<div class="empty-playlist-message">No notifications yet.</div>`;
            return;
        }
        state.notificationHistory.forEach(notif => {
            const item = document.createElement('div');
            item.className = `history-item ${notif.type}`;
            const iconMap = { success: '✓', error: '✗', info: 'ℹ️' };
            const canUndo = Boolean(notif.undoAction) && !notif.undone;
            item.innerHTML = `
                <div class="history-icon">${iconMap[notif.type] || 'ℹ️'}</div>
                <div class="history-content">
                    <p class="history-title">${notif.title}</p>
                    <p class="history-message">${notif.message}${notif.undone ? ' (undone)' : ''}</p>
                </div>
                <div class="history-timestamp">${new Date(notif.timestamp).toLocaleTimeString()}</div>
            `;
            if (canUndo) {
                item.style.cursor = 'pointer';
                item.title = 'Click to undo';
                item.addEventListener('click', async (event) => {
                    if (event.button !== 0) return;
                    await maybeUndoNotification(notif.id);
                });
            }
            notificationHistoryContainer.appendChild(item);
        });
    }

    clearHistoryBtn.addEventListener('click', async () => {
        logTab('NotificationHistory', 'clear history requested');
        const confirmed = await showConfirmDialog(
            'Clear Notification History',
            'Are you sure you want to clear all notification history?',
            { confirmText: 'Clear', cancelText: 'Cancel', danger: true }
        );
        if (confirmed) {
            state.notificationHistory = [];
            saveNotificationHistory();
            renderNotificationHistory();
            showNotification('info', 'History Cleared', 'Your notification history has been cleared.');
        }
    });

    // --- Toast Notification Logic ---
    function showNotification(type, title, message, options = {}) {
        const shouldRecordHistory = options.recordHistory !== false;

        if (shouldRecordHistory) {
            window.electronAPI.incrementNotificationStat();
            const timestamp = new Date().toISOString();
            const notification = {
                id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
                type,
                title,
                message,
                timestamp,
                undoAction: options.undoAction || null,
                undone: false,
            };
            state.notificationHistory.unshift(notification);
            if (state.notificationHistory.length > 100) state.notificationHistory.pop();
            saveNotificationHistory();
            if (notificationHistoryView.classList.contains('active-view')) renderNotificationHistory();
            state.activeToastNotificationId = notification.id;
        } else {
            state.activeToastNotificationId = null;
        }

        if (state.toastTimer) clearTimeout(state.toastTimer);
        toastTitle.textContent = title;
        toastMessage.textContent = message;
        toastNotification.className = `toast-notification ${type}`;
        const iconMap = { success: '✓', error: '✗', info: 'ℹ️' };
        toastIcon.innerHTML = iconMap[type] || 'ℹ️';
        toastNotification.classList.remove('hidden');
        state.toastTimer = setTimeout(() => toastNotification.classList.add('hidden'), 5000);
    }
    context.helpers.showNotification = showNotification; // Add to context

    toastCloseBtn.addEventListener('click', () => {
        if (state.toastTimer) clearTimeout(state.toastTimer);
        toastNotification.classList.add('hidden');
    });

    toastNotification.addEventListener('click', async (event) => {
        if (event.button !== 0) return;
        if (event.target.closest('#toast-close-btn')) return;

        await maybeUndoNotification(state.activeToastNotificationId);
    });

    // --- Title Bar Logic ---
    if (closeBtn) closeBtn.addEventListener('click', () => window.electronAPI.closeApp());

    // --- Settings Logic ---
    changePathBtn.addEventListener('click', async () => {
        logTab('Settings', 'change downloads path requested');
        const newPath = await window.electronAPI.openFolderDialog();
        if (newPath) {
            logTab('Settings', 'downloads path changed', { newPath });
            downloadsPathInput.value = newPath;
            saveSettings();
        }
    });

    changePlaylistsPathBtn.addEventListener('click', async () => {
        logTab('Settings', 'change playlists path requested');
        const newPath = await window.electronAPI.openFolderDialog();
        if (newPath) {
            logTab('Settings', 'playlists path changed', { newPath });
            playlistsPathInput.value = newPath;
            saveSettings();
        }
    });

    toggleSecretBtn.addEventListener('click', () => {
        const isPassword = clientSecretInput.type === 'password';
        logTab('Settings', 'spotify client secret visibility toggled', { visible: isPassword });
        clientSecretInput.type = isPassword ? 'text' : 'password';
        toggleSecretBtn.textContent = isPassword ? 'Hide' : 'Show';
    });

    function applyTheme(themeName) {
        const theme = themeColors[themeName];
        if (!theme) return;
        logTab('Settings', 'theme applied', { themeName });
        for (const [key, value] of Object.entries(theme)) root.style.setProperty(key, value);
        state.currentThemeName = themeName;
        document.querySelectorAll('.theme-button').forEach(btn => btn.classList.toggle('active', btn.dataset.theme === themeName));
    }
    
    function populateThemeGrid() {
        themeGridContainer.innerHTML = '';
        favoriteThemeGrid.innerHTML = '';
        const sortedThemes = Object.entries(themeNames).sort(([, a], [, b]) => a.localeCompare(b));
        for (const [themeId, themeDisplayName] of sortedThemes) {
            const button = document.createElement('div');
            button.className = 'theme-button';
            button.textContent = themeDisplayName;
            button.dataset.theme = themeId;
            button.addEventListener('click', () => {
                applyTheme(themeId);
                saveSettings();
            });
            button.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                const isFavorited = state.favoriteThemes.includes(themeId);
                if (isFavorited) state.favoriteThemes = state.favoriteThemes.filter(id => id !== themeId);
                else state.favoriteThemes.push(themeId);
                saveSettings();
                populateThemeGrid();
            });
            if (state.favoriteThemes.includes(themeId)) favoriteThemeGrid.appendChild(button);
            else themeGridContainer.appendChild(button);
        }
        favoritesContainer.classList.toggle('hidden', state.favoriteThemes.length === 0);
        document.querySelectorAll('.theme-button').forEach(btn => btn.classList.toggle('active', btn.dataset.theme === state.currentThemeName));
    }

    const loadInitialSettings = async () => {
        log('Loading initial settings...');
        const currentConfig = await window.electronAPI.getSettings();
        const ytdlpCount = await window.electronAPI.getYtdlpCount();
        if (ytdlpCount > 0) {
            downloadThreadsInput.max = ytdlpCount;
            downloadThreadsInput.placeholder = `1-${ytdlpCount}`;
        } else {
            downloadThreadsInput.max = 1;
            downloadThreadsInput.placeholder = 'No yt-dlp found';
            downloadThreadsInput.disabled = true;
        }
        if (currentConfig) {
            applyTheme(currentConfig.theme || 'dark');
            state.favoriteThemes = currentConfig.favoriteThemes || [];
            state.favoritePlaylists = currentConfig.favoritePlaylists || [];
            const setSlider = (slider, valueEl, prop, value) => {
                slider.value = value;
                valueEl.textContent = `${value}s`;
                root.style.setProperty(prop, `${value}s`);
            };
            setSlider(tabSpeedSlider, tabSpeedValue, '--tab-switch-speed', currentConfig.tabSwitchSpeed || 0.3);
            log('Initial settings loaded');
            setSlider(dropdownSpeedSlider, dropdownSpeedValue, '--dropdown-speed', currentConfig.dropdownSpeed || 0.4);
            setSlider(themeFadeSlider, themeFadeValue, '--theme-fade-speed', currentConfig.themeFadeSpeed || 0.3);
            fileExtensionInput.value = currentConfig.fileExtension || 'm4a';
            downloadThreadsInput.value = currentConfig.downloadThreads || 3;
            clientIdInput.value = currentConfig.spotify.clientId;
            clientSecretInput.value = currentConfig.spotify.clientSecret;
            downloadsPathInput.value = currentConfig.downloadsPath;
            playlistsPathInput.value = currentConfig.playlistsFolderPath || '';
            const setToggle = (input, bodyClass, value) => {
                input.checked = value;
                body.classList.toggle(bodyClass, value);
            };
            autoCreatePlaylistInput.checked = currentConfig.autoCreatePlaylist || false;
            setToggle(hideRefreshButtonsInput, 'hide-refresh-buttons', currentConfig.hideRefreshButtons || false);
            setToggle(hidePlaylistCountsInput, 'hide-playlist-counts', currentConfig.hidePlaylistCounts || false);
            setToggle(hideTrackNumbersInput, 'hide-track-numbers', currentConfig.hideTrackNumbers || false);
            setToggle(hideSearchBarsInput, 'hide-search-bars', currentConfig.hideSearchBars || false);
            setToggle(hideMixButtonsInput, 'hide-mix-buttons', currentConfig.hideMixButtons || false);
            normalizeVolumeInput.checked = currentConfig.normalizeVolume || false;
            skipManualLinkPromptInput.checked = currentConfig.skipManualLinkPrompt || false;
            durationToleranceSecondsInput.value = currentConfig.durationToleranceSeconds || 20;
            silenceTrimThresholdDbInput.value = currentConfig.silenceTrimThresholdDb || 35;
            spotifySearchLimitInput.value = currentConfig.spotifySearchLimit || 10;
        }
        [fileExtensionInput, downloadThreadsInput, clientIdInput, clientSecretInput, tabSpeedSlider, dropdownSpeedSlider, themeFadeSlider, autoCreatePlaylistInput, hideRefreshButtonsInput, hidePlaylistCountsInput, hideTrackNumbersInput, normalizeVolumeInput, hideSearchBarsInput, hideMixButtonsInput, spotifySearchLimitInput, skipManualLinkPromptInput, durationToleranceSecondsInput, silenceTrimThresholdDbInput].forEach(input => input.addEventListener('change', saveSettings));
        hideRefreshButtonsInput.addEventListener('change', () => body.classList.toggle('hide-refresh-buttons', hideRefreshButtonsInput.checked));
        hidePlaylistCountsInput.addEventListener('change', () => body.classList.toggle('hide-playlist-counts', hidePlaylistCountsInput.checked));
        hideTrackNumbersInput.addEventListener('change', () => body.classList.toggle('hide-track-numbers', hideTrackNumbersInput.checked));
        hideSearchBarsInput.addEventListener('change', () => body.classList.toggle('hide-search-bars', hideSearchBarsInput.checked));
        hideMixButtonsInput.addEventListener('change', () => body.classList.toggle('hide-mix-buttons', hideMixButtonsInput.checked));
        downloadThreadsInput.addEventListener('input', () => {
            const max = parseInt(downloadThreadsInput.max, 10), min = parseInt(downloadThreadsInput.min, 10);
            let value = parseInt(downloadThreadsInput.value, 10);
            if (isNaN(value)) return;
            if (value > max) downloadThreadsInput.value = max;
            else if (value < min && downloadThreadsInput.value !== '') downloadThreadsInput.value = min;
        });
        spotifySearchLimitInput.addEventListener('input', () => {
            const max = parseInt(spotifySearchLimitInput.max, 10), min = parseInt(spotifySearchLimitInput.min, 10);
            let value = parseInt(spotifySearchLimitInput.value, 10);
            if (isNaN(value)) return;
            if (value > max) spotifySearchLimitInput.value = max;
            else if (value < min && spotifySearchLimitInput.value !== '') spotifySearchLimitInput.value = min;
        });
        durationToleranceSecondsInput.addEventListener('input', () => {
            const max = parseInt(durationToleranceSecondsInput.max, 10), min = parseInt(durationToleranceSecondsInput.min, 10);
            let value = parseInt(durationToleranceSecondsInput.value, 10);
            if (isNaN(value)) return;
            if (value > max) durationToleranceSecondsInput.value = max;
            else if (value < min && durationToleranceSecondsInput.value !== '') durationToleranceSecondsInput.value = min;
        });
        silenceTrimThresholdDbInput.addEventListener('input', () => {
            const max = parseInt(silenceTrimThresholdDbInput.max, 10), min = parseInt(silenceTrimThresholdDbInput.min, 10);
            let value = parseInt(silenceTrimThresholdDbInput.value, 10);
            if (isNaN(value)) return;
            if (value > max) silenceTrimThresholdDbInput.value = max;
            else if (value < min && silenceTrimThresholdDbInput.value !== '') silenceTrimThresholdDbInput.value = min;
        });
        populateThemeGrid();
    };






























































    

    // --- Drag and Drop for Links ---
    homeView.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); dropZone.classList.add('active'); });
    homeView.addEventListener('dragleave', (e) => { e.preventDefault(); e.stopPropagation(); dropZone.classList.remove('active'); });
    homeView.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.remove('active');
        const text = e.dataTransfer.getData('text/plain');
        logTab('Home', 'links dropped', { hasText: Boolean(text), textLength: text?.length || 0 });
        if (text) linksInput.value += (linksInput.value ? '\n' : '') + text;
    });

    // --- Tab Switching Logic ---
    homeBtn.addEventListener('click', () => showView(homeView, homeBtn));
    settingsBtn.addEventListener('click', () => showView(settingsView, settingsBtn));
    if (advancedSettingsBtn) {
        advancedSettingsBtn.addEventListener('click', () => showView(advancedSettingsView, settingsBtn));
    }
    if (openAdvancedSettingsBtn) {
        openAdvancedSettingsBtn.addEventListener('click', () => showView(advancedSettingsView, settingsBtn));
    }
    if (backToSettingsBtn) {
        backToSettingsBtn.addEventListener('click', () => showView(settingsView, settingsBtn));
    }
    playerBtn.addEventListener('click', () => {
        logTab('Player', 'open requested');
        showView(playerView, playerBtn);
        initializePlayer(context);
    });
    if (playlistManagementBtn && playlistManagementView) {
        playlistManagementBtn.addEventListener('click', () => {
            logTab('PlaylistManagement', 'open requested');
            showView(playlistManagementView, playlistManagementBtn);
        });
    }
    consoleBtn.addEventListener('click', () => {
        logTab('Console', 'open requested');
        showView(consoleView, consoleBtn);
    });
    statsBtn.addEventListener('click', () => {
        logTab('Stats', 'open requested');
        showView(statsView, statsBtn);
        initializeStats();
    });
    notificationHistoryBtn.addEventListener('click', () => {
        logTab('NotificationHistory', 'open requested');
        showView(notificationHistoryView, notificationHistoryBtn);
        renderNotificationHistory();
    });
    helpBtn.addEventListener('click', () => {
        logTab('Help', 'open requested');
        showView(helpView, helpBtn);
    });

    // --- Advanced Settings Actions ---
    updateYtdlpBtn.addEventListener('click', async () => {
        log('Manual yt-dlp update check triggered');
        showNotification('info', 'yt-dlp Update', 'Checking for updates...');
        const result = await window.electronAPI.updateYtdlp();
        showNotification('info', 'yt-dlp Update', result);
    });
    checkForUpdatesBtn.addEventListener('click', () => {
        log('Manual app update check triggered');
        showNotification('info', 'Auto-Updater', 'Checking for updates...');
        window.electronAPI.checkForUpdates();
    });
    clearCacheBtn.addEventListener('click', async () => {
        logTab('AdvancedSettings', 'clear cache requested');
        const result = await window.electronAPI.clearLinkCache();
        if (result.success) showNotification('success', 'Cache Cleared', result.message);
        else showNotification('error', 'Cache Error', result.error);
    });

    // --- Category Collapse Logic ---
    [configCategoryHeader, themesCategoryHeader, animationsCategoryHeader].forEach(header => {
        header.addEventListener('click', () => {
            logTab('Settings', 'category toggled', { categoryId: header.id });
            const content = header.nextElementSibling;
            content.classList.toggle('collapsed');
            header.classList.toggle('collapsed');
        });
    });

    // --- Animation speed slider logic ---
    const setupSlider = (slider, valueEl, prop) => {
        slider.addEventListener('input', () => {
            const speed = slider.value;
            valueEl.textContent = `${speed}s`;
            root.style.setProperty(prop, `${speed}s`);
        });
    };
    setupSlider(tabSpeedSlider, tabSpeedValue, '--tab-switch-speed');
    setupSlider(dropdownSpeedSlider, dropdownSpeedValue, '--dropdown-speed');
    setupSlider(themeFadeSlider, themeFadeValue, '--theme-fade-speed');

    // --- Console Output Logic ---
    function appendConsoleMessage(message) {
        logTab('Console', 'message appended', { length: message?.length || 0 });
        const div = document.createElement('div');
        div.className = 'console-message';
        div.textContent = message;
        consoleOutput.appendChild(div);
        consoleOutput.scrollTop = consoleOutput.scrollHeight;
    }

    window.electronAPI.onUpdateStatus((message, isFinished, payload) => {
        logTab('Console', 'download update status event', { isFinished, hasPayload: Boolean(payload) });
        appendConsoleMessage(message);
        if (isFinished) {
            downloadBtn.classList.remove('hidden');
            linksInput.disabled = false;
            cancelBtn.classList.add('hidden');
            bigCancelBtn.classList.add('hidden');
            downloadProgressContainer.classList.add('hidden');
            if (payload && payload.success && payload.filesDownloaded > 0) {
                if (autoCreatePlaylistInput.checked) {
                    appendConsoleMessage('Automatically creating playlist...');
                    createPlaylistBtn.click();
                } else {
                    createPlaylistBtn.classList.remove('hidden');
                }
            }
        }
    });

    window.electronAPI.onManualLinkRequest(async ({ requestId, trackName }) => {
        const manualLink = await showPromptDialog(
            'Manual Link Needed',
            `No duration-matching result found for "${trackName}" on YouTube or SoundCloud. Paste a direct link manually, or cancel to skip this track.`,
            '',
            { confirmText: 'Use Link', cancelText: 'Skip Track', placeholder: 'https://...' }
        );

        window.electronAPI.respondManualLink({
            requestId,
            cancelled: !manualLink,
            link: manualLink || '',
        });
    });

    // --- Download Logic ---
    downloadBtn.addEventListener('click', () => {
        const links = linksInput.value.split('\n').filter(link => link.trim() !== '');
        log('Download requested', { linkCount: links.length });
        if (links.length === 0) {
            appendConsoleMessage('Please enter at least one link.');
            return;
        }
        showView(consoleView, consoleBtn);
        downloadBtn.classList.add('hidden');
        linksInput.disabled = true;
        cancelBtn.classList.remove('hidden');
        bigCancelBtn.classList.remove('hidden');
        createPlaylistBtn.classList.add('hidden');
        consoleOutput.innerHTML = '';
        downloadProgressContainer.classList.remove('hidden');
        downloadProgressBar.style.width = '0%';
        downloadEta.textContent = 'Estimated time remaining: calculating...';
        window.electronAPI.startDownload(links);
    });
    cancelBtn.addEventListener('click', () => {
        log('Download cancel requested from small cancel button');
        window.electronAPI.cancelDownload();
    });
    bigCancelBtn.addEventListener('click', () => {
        log('Download cancel requested from console cancel button');
        window.electronAPI.cancelDownload();
    });
    createPlaylistBtn.addEventListener('click', async () => {
        logTab('Console', 'create playlist from download requested');
        const result = await window.electronAPI.createPlaylist();
        appendConsoleMessage(result);
        createPlaylistBtn.classList.add('hidden');
        if (!result.startsWith('Error:')) {
            showNotification('success', 'Playlist Created', 'Playlist created from last download session.');
        }
    });

    // --- Settings Reset Logic ---
    document.getElementById('reset-settings-btn').addEventListener('click', async () => {
        logTab('AdvancedSettings', 'reset settings requested');
        const defaultSettings = await window.electronAPI.getDefaultSettings();
        applyTheme(defaultSettings.theme || 'dark');
        state.favoriteThemes = defaultSettings.favoriteThemes || [];
        state.favoritePlaylists = defaultSettings.favoritePlaylists || [];
        fileExtensionInput.value = defaultSettings.fileExtension || 'm4a';
        downloadThreadsInput.value = defaultSettings.downloadThreads || 3;
        clientIdInput.value = defaultSettings.spotify.clientId;
        clientSecretInput.value = defaultSettings.spotify.clientSecret;
        downloadsPathInput.value = defaultSettings.downloadsPath;
        autoCreatePlaylistInput.checked = defaultSettings.autoCreatePlaylist || false;
        spotifySearchLimitInput.value = defaultSettings.spotifySearchLimit || 10;
        const setToggle = (input, bodyClass, value) => {
            input.checked = value;
            body.classList.toggle(bodyClass, value);
        };
        setToggle(hideRefreshButtonsInput, 'hide-refresh-buttons', defaultSettings.hideRefreshButtons || false);
        setToggle(hidePlaylistCountsInput, 'hide-playlist-counts', defaultSettings.hidePlaylistCounts || false);
        setToggle(hideTrackNumbersInput, 'hide-track-numbers', defaultSettings.hideTrackNumbers || false);
        setToggle(hideSearchBarsInput, 'hide-search-bars', defaultSettings.hideSearchBars || false);
        setToggle(hideMixButtonsInput, 'hide-mix-buttons', defaultSettings.hideMixButtons || false);
        skipManualLinkPromptInput.checked = defaultSettings.skipManualLinkPrompt || false;
        durationToleranceSecondsInput.value = defaultSettings.durationToleranceSeconds || 20;
        silenceTrimThresholdDbInput.value = defaultSettings.silenceTrimThresholdDb || 35;
        const setSlider = (slider, valueEl, prop, value) => {
            slider.value = value;
            valueEl.textContent = `${value}s`;
            root.style.setProperty(prop, `${value}s`);
        };
        setSlider(tabSpeedSlider, tabSpeedValue, '--tab-switch-speed', defaultSettings.tabSwitchSpeed || 0.3);
        setSlider(dropdownSpeedSlider, dropdownSpeedValue, '--dropdown-speed', defaultSettings.dropdownSpeed || 0.4);
        setSlider(themeFadeSlider, themeFadeValue, '--theme-fade-speed', defaultSettings.themeFadeSpeed || 0.3);
        populateThemeGrid();
        saveSettings();
        showNotification('success', 'Settings Reset', 'All settings have been restored to their defaults.');
    });

    trimLibrarySilenceBtn.addEventListener('click', async () => {
        const thresholdDb = Number.parseInt(silenceTrimThresholdDbInput.value, 10);
        const safeThresholdDb = Number.isFinite(thresholdDb) ? thresholdDb : 35;
        const confirmed = await showConfirmDialog(
            'Trim Silence from Library',
            `This will scan all tracks in your library and trim leading/trailing silence below -${safeThresholdDb}dB. This can be undone once from notifications. Continue?`,
            { confirmText: 'Trim Library', cancelText: 'Cancel', danger: true }
        );

        if (!confirmed) return;

        trimLibrarySilenceBtn.disabled = true;
        try {
            const startResult = await window.electronAPI.startTrimLibrarySilence({ thresholdDb: safeThresholdDb });
            if (!startResult?.success || !startResult?.started) {
                trimLibrarySilenceBtn.disabled = false;
                showNotification('error', 'Trim Not Started', startResult?.error || 'Failed to start trim task.');
                return;
            }

            state.activeSilenceTrimJobId = startResult.jobId;
            state.lastSilenceTrimProgressTick = 0;
            showNotification('info', 'Silence Trim Started', 'Running in background. You can continue using the app.', { recordHistory: false });
        } catch (error) {
            trimLibrarySilenceBtn.disabled = false;
            showNotification('error', 'Trim Failed', error?.message || 'Failed to trim library tracks.');
        }
    });

    window.electronAPI.onTrimLibrarySilenceProgress(async (payload = {}) => {
        if (!payload?.jobId || payload.jobId !== state.activeSilenceTrimJobId) return;

        const status = payload.status;
        if (status === 'started') {
            const totalCount = payload.totalCount || 0;
            const thresholdDb = payload.thresholdDb || 35;
            showNotification('info', 'Silence Trim Running', `Scanning ${totalCount} track(s) at -${thresholdDb}dB threshold.`, { recordHistory: false });
            return;
        }

        if (status === 'progress') {
            const processed = payload.processedCount || 0;
            const total = payload.totalCount || 0;
            const shouldNotify = processed === total || (processed - state.lastSilenceTrimProgressTick) >= 20;
            if (!shouldNotify) return;

            state.lastSilenceTrimProgressTick = processed;
            showNotification(
                'info',
                'Silence Trim Progress',
                `${processed}/${total} scanned • ${payload.modifiedCount || 0} trimmed • ${payload.failedCount || 0} failed`,
                { recordHistory: false }
            );
            return;
        }

        if (status === 'completed') {
            trimLibrarySilenceBtn.disabled = false;
            state.activeSilenceTrimJobId = null;
            state.lastSilenceTrimProgressTick = 0;

            if ((payload.modifiedCount || 0) > 0) {
                const message = payload.failedCount > 0
                    ? `Trimmed ${payload.modifiedCount} track(s). ${payload.failedCount} failed.`
                    : `Trimmed ${payload.modifiedCount} track(s) successfully.`;
                showNotification('success', 'Silence Trim Complete', message, { undoAction: payload.undoAction || null });
            } else {
                showNotification('info', 'No Trim Needed', 'No leading or trailing silence met the configured threshold.');
            }

            await refreshAfterUndo();
            return;
        }

        if (status === 'error') {
            trimLibrarySilenceBtn.disabled = false;
            state.activeSilenceTrimJobId = null;
            state.lastSilenceTrimProgressTick = 0;
            showNotification('error', 'Trim Failed', payload.error || 'Background trim task failed.');
        }
    });

    // --- Stats Logic ---
    async function initializeStats() {
        logTab('Stats', 'stats initialization requested');
        const statsData = await window.electronAPI.getStats();
        if (statsData) {
            totalSongsStat.textContent = statsData.totalSongsDownloaded || 0;
            playlistsCreatedStat.textContent = statsData.playlistsCreated || 0;
            downloadsInitiatedStat.textContent = statsData.downloadsInitiated || 0;
            songsFailedStat.textContent = statsData.songsFailed || 0;
            linksProcessedStat.textContent = statsData.totalLinksProcessed || 0;
            spotifyLinksStat.textContent = statsData.spotifyLinksProcessed || 0;
            youtubeLinksStat.textContent = statsData.youtubeLinksProcessed || 0;
            notificationsReceivedStat.textContent = statsData.notificationsReceived || 0;
            const successRate = (statsData.downloadsInitiated > 0) ? ((statsData.totalSongsDownloaded / (statsData.totalSongsDownloaded + statsData.songsFailed)) * 100) : 0;
            successRateStat.textContent = `${successRate.toFixed(1)}%`;
        }
    }
    resetStatsBtn.addEventListener('click', async () => {
        logTab('Stats', 'reset stats requested');
        const confirmed = await showConfirmDialog(
            'Reset Statistics',
            'Are you sure you want to reset all statistics? This cannot be undone.',
            { confirmText: 'Reset', cancelText: 'Cancel', danger: true }
        );
        if (confirmed) {
            await window.electronAPI.resetStats();
            initializeStats();
            showNotification('info', 'Stats Reset', 'Your statistics have been cleared.');
        }
    });

    // --- Help View Logic ---
    spotifyLink.addEventListener('click', (e) => {
        e.preventDefault();
        logTab('Help', 'open external spotify developer link');
        window.electronAPI.openExternalLink(e.target.href);
    });

    // --- Auto Updater Logic ---
    window.electronAPI.onShowUpdateNotAvailableNotification(() => {
        log('Update check completed: application is up to date');
    });
    window.electronAPI.onUpdateAvailable(() => {
        log('Update available event received');
        updateNotification.classList.remove('hidden');
        updateMessage.textContent = 'A new update is available. Downloading now...';
        showNotification('info', 'Update Found', 'Downloading new version...');
    });
    window.electronAPI.onUpdateDownloadProgress((progressObj) => {
        log('Update download progress', { percent: progressObj?.percent });
        updateNotification.classList.remove('hidden');
        const progress = progressObj.percent.toFixed(1);
        updateMessage.textContent = `Downloading update... ${progress}%`;
    });
    window.electronAPI.onUpdateDownloaded(() => {
        log('Update downloaded and ready to install');
        updateNotification.classList.remove('hidden');
        updateMessage.textContent = 'Update downloaded. Click the button to install on restart.';
        restartBtn.classList.remove('hidden');
        showNotification('success', 'Update Ready', 'Click the restart button or the system notification to install.');
    });
    restartBtn.addEventListener('click', () => {
        log('Restart to update clicked');
        window.electronAPI.restartApp();
    });

    window.electronAPI.onDownloadProgress(({ progress, eta }) => {
        log('Download progress event', { progress, eta });
        if (downloadProgressBar) downloadProgressBar.style.width = `${progress}%`;
        if (downloadEta) downloadEta.textContent = `Estimated time remaining: ${eta}`;
    });

    // --- Initial Load ---
    initializeClearButtons();
    loadNotificationHistory();
    loadInitialSettings();
    log('Renderer initialized');
    // The player is now initialized when its tab is clicked.
});