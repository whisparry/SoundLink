// This file contains all logic for the playlist management view.

let ctx = {}; // To hold context (elements, state, helpers, playerAPI)
const emitLog = (level, message, data) => {
    const payload = { level, scope: 'PlaylistManagement', message, data };
    try {
        window.electronAPI?.log?.(payload);
    } catch (_) {
        // noop
    }

    if (level === 'error') {
        if (data !== undefined) console.error(`[SoundLink][PlaylistManagement] ${message}`, data);
        else console.error(`[SoundLink][PlaylistManagement] ${message}`);
    } else if (level === 'warn') {
        if (data !== undefined) console.warn(`[SoundLink][PlaylistManagement] ${message}`, data);
        else console.warn(`[SoundLink][PlaylistManagement] ${message}`);
    } else {
        if (data !== undefined) console.log(`[SoundLink][PlaylistManagement] ${message}`, data);
        else console.log(`[SoundLink][PlaylistManagement] ${message}`);
    }
};

const logDebug = (message, data) => emitLog('debug', message, data);
const log = (message, data) => emitLog('info', message, data);
const logWarn = (message, data) => emitLog('warn', message, data);
const logError = (message, data) => emitLog('error', message, data);

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
    return [
        `Playlist: ${details.name || 'Unknown'}`,
        `Tracks: ${Number.isFinite(details.trackCount) ? details.trackCount : 0}`,
        `Total duration: ${formatTrackDetailsDuration(details.totalDurationSeconds)}`,
        `Size: ${details.totalSizeFormatted || 'Unknown'}`,
        `Created: ${formatPlaylistDetailsDate(details.createdAt)}`,
        `Modified: ${formatPlaylistDetailsDate(details.modifiedAt)}`,
        '',
        `Folder path: ${details.path || 'Unknown'}`,
    ].join('\n');
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

    await ctx.helpers.showInfoDialog('Track Details', buildTrackDetailsMessage(result.details), { confirmText: 'Close' });
}

async function addTagToTrackFromContext(track) {
    const tagInput = await ctx.helpers.showPromptDialog(
        'Add Tag',
        `Add a tag for "${track.name}"`,
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

    ctx.helpers.showNotification('success', 'Tag Added', `"${trimmedTag}" added to "${track.name}".`);
    await pmRenderTracks(ctx.state.pmSelectedPlaylistPath);
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
    await pmRenderTracks(ctx.state.pmSelectedPlaylistPath);
}

async function goToTrackFileFromContext(track) {
    const result = await window.electronAPI.openTrackFile(track.path);
    if (!result?.success) {
        ctx.helpers.showNotification('error', 'Go to File Failed', result?.error || 'Could not open track file.');
    }
}

async function showPlaylistInfoFromContext(playlist) {
    const result = await window.electronAPI.getPlaylistDetails(playlist.path);
    if (!result?.success || !result.details) {
        ctx.helpers.showNotification('error', 'More Info Failed', result?.error || 'Could not load playlist details.');
        return;
    }

    await ctx.helpers.showInfoDialog('Playlist Details', buildPlaylistDetailsMessage(result.details), { confirmText: 'Close' });
}

async function updatePlaylistFromContext(playlist) {
    if (!playlist?.path) return;

    const confirmed = await ctx.helpers.showConfirmDialog(
        'Update Playlist',
        `Sync "${playlist.name}" with its original Spotify playlist source? This can add, remove, rename, or replace tracks to match Spotify.`,
        { confirmText: 'Update', cancelText: 'Cancel' }
    );

    if (!confirmed) return;

    const result = await window.electronAPI.syncPlaylistWithSource(playlist.path);
    if (!result?.success) {
        ctx.helpers.showNotification('error', 'Update Failed', result?.error || 'Could not sync playlist from source.');
        return;
    }

    const summary = result.summary || {};
    ctx.helpers.showNotification(
        'success',
        'Playlist Updated',
        `Added ${summary.added || 0}, changed ${summary.changed || 0}, removed ${summary.removed || 0}.`
    );

    await pmRenderPlaylists();
    if (ctx.state.pmSelectedPlaylistPath) {
        const pathAfterSync = result.playlistPath || ctx.state.pmSelectedPlaylistPath;
        ctx.state.pmSelectedPlaylistPath = pathAfterSync;
        await pmRenderTracks(pathAfterSync);
    }
    if (ctx.state.isPlayerInitialized) ctx.playerAPI?.loadAndRenderPlaylists?.();
}

async function pmRenderTracks(playlistPath) {
    const { pmTracksContainer, pmTrackSearchInput, moveTrackNameEl, moveTrackDestinationSelect, moveTrackModal } = ctx.elements;
    log('Rendering tracks', { playlistPath });
    if (!playlistPath) {
        pmTracksContainer.innerHTML = `<div class="empty-playlist-message">Select a playlist to see its tracks.</div>`;
        return;
    }
    try {
        const { tracks } = await window.electronAPI.getPlaylistTracks(playlistPath);
        pmTracksContainer.innerHTML = '';
        if (tracks.length === 0) {
            log('Playlist has no tracks', { playlistPath });
            pmTracksContainer.innerHTML = `<div class="empty-playlist-message">This playlist is empty.</div>`;
            return;
        }
        const searchQuery = pmTrackSearchInput.value.trim().toLowerCase();
        const filteredTracks = tracks.filter((track) => {
            if (!searchQuery) return true;
            const tagList = Array.isArray(track.tags) ? track.tags : [];
            const tagsMatch = tagList.some(tag => tag.toLowerCase().includes(searchQuery));

            if (searchQuery.startsWith('tag:')) {
                const tagQuery = searchQuery.slice(4).trim();
                if (!tagQuery) return tagList.length > 0;
                return tagList.some(tag => tag.toLowerCase().includes(tagQuery));
            }

            return track.name.toLowerCase().includes(searchQuery) || tagsMatch;
        });
        log('Tracks filtered', { playlistPath, searchQuery, total: tracks.length, filtered: filteredTracks.length });
        filteredTracks.forEach(track => {
            const item = document.createElement('div');
            item.className = 'pm-track-item';
            const primaryTag = Array.isArray(track.tags) && track.tags.length > 0 ? track.tags[0] : '';
            const hasMoreTags = Array.isArray(track.tags) && track.tags.length > 1;
            const tagSuffix = hasMoreTags ? ` +${track.tags.length - 1}` : '';
            const tagMarkup = primaryTag
                ? `<span class="track-tag-shell"><span class="track-tag-badge" title="${primaryTag}">${primaryTag}${tagSuffix}</span></span>`
                : `<span class="track-tag-shell empty"></span>`;

            item.innerHTML = `<span class="pm-track-name" title="${track.name}">${track.name}</span><span class="pm-track-meta"><span class="track-duration">${formatTrackListDuration(track.duration)}</span>${tagMarkup}</span><div class="pm-track-actions"><button class="pm-action-btn">Move</button><button class="pm-action-btn pm-delete-btn">Delete</button></div>`;
            pmTracksContainer.appendChild(item);

            const moveButton = item.querySelector('.pm-action-btn:not(.pm-delete-btn)');
            const deleteButton = item.querySelector('.pm-delete-btn');
            const trackNameSpan = item.querySelector('.pm-track-name');

            item.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                const menuItems = [
                    {
                        label: 'More info',
                        action: () => { void showTrackInfoFromContext(track); }
                    },
                    {
                        label: 'Add tag',
                        action: () => { void addTagToTrackFromContext(track); }
                    },
                    {
                        label: 'Go to file',
                        action: () => { void goToTrackFileFromContext(track); }
                    },
                    { type: 'separator' },
                    {
                        label: 'Rename',
                        action: () => trackNameSpan.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
                    },
                    {
                        label: 'Move to...',
                        action: () => moveButton.click()
                    },
                    {
                        label: 'Remove from library',
                        action: () => deleteButton.click()
                    },
                    { type: 'separator' },
                    {
                        label: 'Show in folder',
                        action: () => window.electronAPI.showInExplorer(track.path)
                    }
                ];

                if (Array.isArray(track.tags) && track.tags.length > 0) {
                    menuItems.splice(2, 0, {
                        label: 'Edit tag',
                        action: () => { void editTagOnTrackFromContext(track); }
                    });
                }

                ctx.helpers.showContextMenu(e.clientX, e.clientY, menuItems);
            });

            trackNameSpan.addEventListener('dblclick', async () => {
                const newName = await ctx.helpers.showPromptDialog(
                    'Rename Track',
                    'Enter new track name (without extension):',
                    track.name,
                    { confirmText: 'Rename', cancelText: 'Cancel' }
                );
                if (newName && newName.trim() !== track.name) {
                    log('Renaming track', { oldName: track.name, newName: newName.trim() });
                    window.electronAPI.renameTrack({ oldPath: track.path, newName: newName.trim() }).then(result => {
                        if (result.success) {
                            ctx.helpers.showNotification(
                                'success',
                                'Renamed',
                                `Track renamed successfully.`,
                                {
                                    undoAction: {
                                        type: 'rename-track',
                                        payload: {
                                            currentPath: result.newPath,
                                            previousName: track.name,
                                        },
                                    },
                                }
                            );
                            pmRenderTracks(playlistPath);
                        } else {
                            ctx.helpers.showNotification('error', 'Rename Failed', result.error);
                        }
                    });
                }
            });
            deleteButton.addEventListener('click', async () => {
                const confirmed = await ctx.helpers.showConfirmDialog(
                    'Delete Track',
                    `Are you sure you want to permanently delete "${track.name}"?`,
                    { confirmText: 'Delete', cancelText: 'Cancel', danger: true }
                );
                if (confirmed) {
                    log('Deleting track', { trackName: track.name });
                    await ctx.playerAPI?.unloadTrackByPath?.(track.path);
                    const result = await window.electronAPI.deleteTrack(track.path);
                    if (result.success) {
                        ctx.helpers.showNotification(
                            'success',
                            'Track Deleted',
                            `"${track.name}" has been deleted.`,
                            { undoAction: result.undoAction || null }
                        );
                        pmRenderTracks(playlistPath);
                    } else {
                        ctx.helpers.showNotification('error', 'Delete Failed', result.error);
                    }
                }
            });
            moveButton.addEventListener('click', () => {
                log('Move track dialog opened', { trackName: track.name, sourcePlaylistPath: playlistPath });
                ctx.state.trackToMove = track;
                moveTrackNameEl.textContent = track.name;
                moveTrackDestinationSelect.innerHTML = '';
                ctx.state.playlists.forEach(p => {
                    if (p.path !== playlistPath) {
                        const option = document.createElement('option');
                        option.value = p.path;
                        option.textContent = p.name;
                        moveTrackDestinationSelect.appendChild(option);
                    }
                });
                moveTrackModal.classList.remove('hidden');
            });
        });
    } catch (error) {
        logError('Failed to render PM tracks', { error: error.message, playlistPath });
    }
}

async function pmRenderPlaylists() {
    const { pmAllPlaylistsGrid, pmFavoritePlaylistsGrid, pmFavoritePlaylistsContainer, pmTracksContainer, pmTracksHeader } = ctx.elements;
    log('Rendering playlists');
    try {
        ctx.state.playlists = await window.electronAPI.getPlaylists();
        pmAllPlaylistsGrid.innerHTML = '';
        pmFavoritePlaylistsGrid.innerHTML = '';
        if (ctx.state.playlists.length === 0) {
            log('No playlists found in playlist management view');
            pmAllPlaylistsGrid.innerHTML = `<div class="empty-playlist-message">No playlists found.</div>`;
            return;
        }
        const filteredPlaylists = ctx.state.playlists.filter(p => p.name.toLowerCase().includes(ctx.state.playlistSearchQuery));
        log('Playlists filtered', { total: ctx.state.playlists.length, query: ctx.state.playlistSearchQuery, filtered: filteredPlaylists.length });
        filteredPlaylists.forEach(p => {
            const isFavorite = ctx.state.favoritePlaylists.includes(p.path);
            const isSmartPlaylist = Boolean(p.isSmart);
            const targetGrid = isFavorite ? pmFavoritePlaylistsGrid : pmAllPlaylistsGrid;
            const item = document.createElement('div');
            item.className = 'playlist-list-item';
            if (isSmartPlaylist) item.classList.add('smart-playlist-item');
            item.dataset.path = p.path;
            item.innerHTML = `<span class="playlist-name" title="${p.name}">${p.name}</span>${isSmartPlaylist ? '' : '<button class="playlist-delete-btn" title="Delete Playlist"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></button>'}`;
            targetGrid.appendChild(item);
            item.addEventListener('click', (e) => {
                if (e.target.closest('.playlist-delete-btn') || e.target.tagName === 'INPUT') return;
                log('Playlist selected', { playlistName: p.name, playlistPath: p.path });
                ctx.state.pmSelectedPlaylistPath = p.path;
                document.querySelectorAll('#pm-playlists-container .playlist-list-item').forEach(el => el.classList.remove('active'));
                item.classList.add('active');
                pmTracksHeader.textContent = p.name;
                pmRenderTracks(p.path);
            });

            item.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                const playlistNameSpan = item.querySelector('.playlist-name');
                const menuItems = [
                    {
                        label: 'More info',
                        action: () => { void showPlaylistInfoFromContext(p); }
                    },
                    {
                        label: 'Update playlist',
                        action: () => { void updatePlaylistFromContext(p); }
                    },
                    { type: 'separator' },
                    {
                        label: 'Rename',
                        action: () => playlistNameSpan.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
                    },
                    {
                        label: 'Delete',
                        action: () => item.querySelector('.playlist-delete-btn').click()
                    },
                    { type: 'separator' },
                    {
                        label: 'Show in Folder',
                        action: () => window.electronAPI.showInExplorer(p.path)
                    }
                ];

                if (isSmartPlaylist) {
                    const smartMenuItems = [
                        {
                            label: 'More info',
                            action: () => { void showPlaylistInfoFromContext(p); }
                        }
                    ];
                    ctx.helpers.showContextMenu(e.clientX, e.clientY, smartMenuItems);
                    return;
                }
                ctx.helpers.showContextMenu(e.clientX, e.clientY, menuItems);
            });

            if (isSmartPlaylist) {
                return;
            }

            const playlistNameSpan = item.querySelector('.playlist-name');
            playlistNameSpan.addEventListener('dblclick', () => {
                const originalName = p.name;
                const input = document.createElement('input');
                input.type = 'text';
                input.value = originalName;
                input.className = 'playlist-rename-input';
                playlistNameSpan.replaceWith(input);
                input.focus();
                input.select();
                const commitChange = () => {
                    const newName = input.value.trim();
                    const newSpan = playlistNameSpan.cloneNode(true);
                    input.replaceWith(newSpan);
                    if (newName && newName !== originalName) {
                        window.electronAPI.renamePlaylist({ oldPath: p.path, newName: newName }).then(result => {
                            if (result.success) {
                                log('Playlist renamed successfully', { oldName: originalName, newName });
                                ctx.helpers.showNotification(
                                    'success',
                                    'Renamed',
                                    `Playlist renamed to "${newName}".`,
                                    {
                                        undoAction: {
                                            type: 'rename-playlist',
                                            payload: {
                                                currentPath: result.newPath,
                                                previousName: originalName,
                                            },
                                        },
                                    }
                                );
                                const oldPath = p.path;
                                const favoriteIndex = ctx.state.favoritePlaylists.indexOf(oldPath);
                                if (favoriteIndex > -1) {
                                    ctx.state.favoritePlaylists[favoriteIndex] = result.newPath;
                                    ctx.helpers.saveSettings();
                                }
                                if (ctx.state.activePlaylistPath === oldPath) ctx.state.activePlaylistPath = result.newPath;
                                if (ctx.state.activeQueuePaths.has(oldPath)) {
                                    ctx.state.activeQueuePaths.delete(oldPath);
                                    ctx.state.activeQueuePaths.add(result.newPath);
                                }
                                if (ctx.state.pmSelectedPlaylistPath === oldPath) ctx.state.pmSelectedPlaylistPath = result.newPath;
                                pmRenderPlaylists();
                                if (ctx.state.isPlayerInitialized) ctx.playerAPI?.loadAndRenderPlaylists?.();
                            } else {
                                ctx.helpers.showNotification('error', 'Rename Failed', result.error);
                            }
                        });
                    }
                };
                input.addEventListener('blur', commitChange);
                input.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') input.blur();
                    else if (e.key === 'Escape') {
                        input.removeEventListener('blur', commitChange);
                        const newSpan = playlistNameSpan.cloneNode(true);
                        input.replaceWith(newSpan);
                    }
                });
            });
            item.querySelector('.playlist-delete-btn').addEventListener('click', async () => {
                const confirmed = await ctx.helpers.showConfirmDialog(
                    'Delete Playlist',
                    `Are you sure you want to permanently delete the playlist "${p.name}"?`,
                    { confirmText: 'Delete', cancelText: 'Cancel', danger: true }
                );
                if (confirmed) {
                    log('Deleting playlist', { playlistName: p.name });
                    await ctx.playerAPI?.unloadPlaylistByPath?.(p.path);
                    const result = await window.electronAPI.deletePlaylist(p.path);
                    if (result.success) {
                        ctx.helpers.showNotification(
                            'success',
                            'Playlist Deleted',
                            `"${p.name}" has been deleted.`,
                            { undoAction: result.undoAction || null }
                        );
                        if (ctx.state.pmSelectedPlaylistPath === p.path) {
                            pmTracksContainer.innerHTML = '';
                            pmTracksHeader.textContent = 'Select a playlist';
                            ctx.state.pmSelectedPlaylistPath = null;
                        }
                        pmRenderPlaylists();
                        if (ctx.state.isPlayerInitialized) ctx.playerAPI?.loadAndRenderPlaylists?.();
                    } else {
                        ctx.helpers.showNotification('error', 'Delete Failed', result.error);
                    }
                }
            });
        });
        pmFavoritePlaylistsContainer.classList.toggle('hidden', pmFavoritePlaylistsGrid.children.length === 0);
    } catch (error) {
        logError('Failed to render PM playlists', { error: error.message });
    }
}

export function initializePlaylistManagement(context) {
    ctx = context;
    const { createNewPlaylistBtnPm, pmTrackSearchInput, modalCloseBtn, moveTrackCancelBtn, moveTrackConfirmBtn, moveTrackDestinationSelect, moveTrackModal } = ctx.elements;
    log('Initialize playlist management called', { alreadyInitialized: ctx.state.isPmInitialized });

    if (ctx.state.isPmInitialized) {
        pmRenderPlaylists();
        return;
    }

    ctx.pmAPI = ctx.pmAPI || {};
    ctx.pmAPI.refresh = async () => {
        await pmRenderPlaylists();
        if (ctx.state.pmSelectedPlaylistPath) {
            await pmRenderTracks(ctx.state.pmSelectedPlaylistPath);
        }
    };
    
    pmRenderPlaylists();
    ctx.state.isPmInitialized = true;

    createNewPlaylistBtnPm.addEventListener('click', async () => {
        log('Create new playlist requested');
        const result = await window.electronAPI.createNewPlaylist();
        if (result.success) {
            ctx.helpers.showNotification('success', 'Playlist Created', `"${result.newPlaylist.name}" has been created.`);
            await pmRenderPlaylists();
            if (ctx.state.isPlayerInitialized) await ctx.playerAPI?.loadAndRenderPlaylists?.();
        } else {
            ctx.helpers.showNotification('error', 'Creation Failed', result.error);
        }
    });
    pmTrackSearchInput.addEventListener('input', () => {
        log('Track search changed', { query: pmTrackSearchInput.value.trim().toLowerCase() });
        pmRenderTracks(ctx.state.pmSelectedPlaylistPath);
    });
    modalCloseBtn.addEventListener('click', () => {
        log('Move track dialog closed (x button)');
        moveTrackModal.classList.add('hidden');
    });
    moveTrackCancelBtn.addEventListener('click', () => {
        log('Move track dialog canceled');
        moveTrackModal.classList.add('hidden');
    });
    moveTrackConfirmBtn.addEventListener('click', async () => {
        const destinationPlaylistPath = moveTrackDestinationSelect.value;
        if (ctx.state.trackToMove && destinationPlaylistPath) {
            log('Move track confirmed', {
                trackName: ctx.state.trackToMove.name,
                destinationPlaylistPath,
            });
            const result = await window.electronAPI.moveTrack({ sourcePath: ctx.state.trackToMove.path, destinationPlaylistPath });
            if (result.success) {
                ctx.helpers.showNotification('success', 'Track Moved', `Moved "${ctx.state.trackToMove.name}" successfully.`);
                pmRenderTracks(ctx.state.pmSelectedPlaylistPath);
            } else {
                ctx.helpers.showNotification('error', 'Move Failed', result.error);
            }
            moveTrackModal.classList.add('hidden');
        }
    });
}