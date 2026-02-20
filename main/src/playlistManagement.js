// This file contains all logic for the playlist management view.

let ctx = {}; // To hold context (elements, state, helpers, playerAPI)

async function pmRenderTracks(playlistPath) {
    const { pmTracksContainer, pmTrackSearchInput, moveTrackNameEl, moveTrackDestinationSelect, moveTrackModal, playerView, playerBtn } = ctx.elements;
    if (!playlistPath) {
        pmTracksContainer.innerHTML = `<div class="empty-playlist-message">Select a playlist to see its tracks.</div>`;
        return;
    }
    try {
        const { tracks } = await window.electronAPI.getPlaylistTracks(playlistPath);
        pmTracksContainer.innerHTML = '';
        if (tracks.length === 0) {
            pmTracksContainer.innerHTML = `<div class="empty-playlist-message">This playlist is empty.</div>`;
            return;
        }
        const searchQuery = pmTrackSearchInput.value.trim().toLowerCase();
        const filteredTracks = tracks.filter(t => t.name.toLowerCase().includes(searchQuery));
        filteredTracks.forEach(track => {
            const item = document.createElement('div');
            item.className = 'pm-track-item';
            item.innerHTML = `<span class="pm-track-name" title="${track.name}">${track.name}</span><div class="pm-track-actions"><button class="pm-action-btn">Move</button><button class="pm-action-btn pm-delete-btn">Delete</button></div>`;
            pmTracksContainer.appendChild(item);

            const moveButton = item.querySelector('.pm-action-btn:not(.pm-delete-btn)');
            const deleteButton = item.querySelector('.pm-delete-btn');
            const trackNameSpan = item.querySelector('.pm-track-name');

            item.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                const menuItems = [
                    {
                        label: 'Rename',
                        action: () => trackNameSpan.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
                    },
                    {
                        label: 'Move to...',
                        action: () => moveButton.click()
                    },
                    {
                        label: 'Delete',
                        action: () => deleteButton.click()
                    },
                    { type: 'separator' },
                    {
                        label: 'Show in Folder',
                        action: () => window.electronAPI.showInExplorer(track.path)
                    }
                ];
                ctx.helpers.showContextMenu(e.clientX, e.clientY, menuItems);
            });

            trackNameSpan.addEventListener('dblclick', () => {
                const newName = prompt('Enter new track name (without extension):', track.name);
                if (newName && newName.trim() !== track.name) {
                    window.electronAPI.renameTrack({ oldPath: track.path, newName: newName.trim() }).then(result => {
                        if (result.success) {
                            ctx.helpers.showNotification('success', 'Renamed', `Track renamed successfully.`);
                            pmRenderTracks(playlistPath);
                        } else {
                            ctx.helpers.showNotification('error', 'Rename Failed', result.error);
                        }
                    });
                }
            });
            deleteButton.addEventListener('click', async () => {
                if (confirm(`Are you sure you want to permanently delete "${track.name}"?`)) {
                    const result = await window.electronAPI.deleteTrack(track.path);
                    if (result.success) {
                        ctx.helpers.showNotification('success', 'Track Deleted', `"${track.name}" has been deleted.`);
                        pmRenderTracks(playlistPath);
                    } else {
                        ctx.helpers.showNotification('error', 'Delete Failed', result.error);
                    }
                }
            });
            moveButton.addEventListener('click', () => {
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
        console.error("Failed to render PM tracks:", error);
    }
}

async function pmRenderPlaylists() {
    const { pmAllPlaylistsGrid, pmFavoritePlaylistsGrid, pmFavoritePlaylistsContainer, pmTracksContainer, pmTracksHeader, playerView, playerBtn } = ctx.elements;
    try {
        ctx.state.playlists = await window.electronAPI.getPlaylists();
        pmAllPlaylistsGrid.innerHTML = '';
        pmFavoritePlaylistsGrid.innerHTML = '';
        if (ctx.state.playlists.length === 0) {
            pmAllPlaylistsGrid.innerHTML = `<div class="empty-playlist-message">No playlists found.</div>`;
            return;
        }
        const filteredPlaylists = ctx.state.playlists.filter(p => p.name.toLowerCase().includes(ctx.state.playlistSearchQuery));
        filteredPlaylists.forEach(p => {
            const isFavorite = ctx.state.favoritePlaylists.includes(p.path);
            const targetGrid = isFavorite ? pmFavoritePlaylistsGrid : pmAllPlaylistsGrid;
            const item = document.createElement('div');
            item.className = 'playlist-list-item';
            item.dataset.path = p.path;
            item.innerHTML = `<span class="playlist-name" title="${p.name}">${p.name}</span><button class="playlist-delete-btn" title="Delete Playlist"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></button>`;
            targetGrid.appendChild(item);
            item.addEventListener('click', (e) => {
                if (e.target.closest('.playlist-delete-btn') || e.target.tagName === 'INPUT') return;
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
                ctx.helpers.showContextMenu(e.clientX, e.clientY, menuItems);
            });

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
                                ctx.helpers.showNotification('success', 'Renamed', `Playlist renamed to "${newName}".`);
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
                if (confirm(`Are you sure you want to permanently delete the playlist "${p.name}"?`)) {
                    const result = await window.electronAPI.deletePlaylist(p.path);
                    if (result.success) {
                        ctx.helpers.showNotification('success', 'Playlist Deleted', `"${p.name}" has been deleted.`);
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
        console.error("Failed to render PM playlists:", error);
    }
}

export function initializePlaylistManagement(context) {
    ctx = context;
    const { createNewPlaylistBtnPm, pmTrackSearchInput, modalCloseBtn, moveTrackCancelBtn, moveTrackConfirmBtn, moveTrackDestinationSelect, moveTrackModal } = ctx.elements;

    if (ctx.state.isPmInitialized) {
        pmRenderPlaylists();
        return;
    }
    
    pmRenderPlaylists();
    ctx.state.isPmInitialized = true;

    createNewPlaylistBtnPm.addEventListener('click', async () => {
        const result = await window.electronAPI.createNewPlaylist();
        if (result.success) {
            ctx.helpers.showNotification('success', 'Playlist Created', `"${result.newPlaylist.name}" has been created.`);
            await pmRenderPlaylists();
            if (ctx.state.isPlayerInitialized) await ctx.playerAPI?.loadAndRenderPlaylists?.();
        } else {
            ctx.helpers.showNotification('error', 'Creation Failed', result.error);
        }
    });
    pmTrackSearchInput.addEventListener('input', () => pmRenderTracks(ctx.state.pmSelectedPlaylistPath));
    modalCloseBtn.addEventListener('click', () => moveTrackModal.classList.add('hidden'));
    moveTrackCancelBtn.addEventListener('click', () => moveTrackModal.classList.add('hidden'));
    moveTrackConfirmBtn.addEventListener('click', async () => {
        const destinationPlaylistPath = moveTrackDestinationSelect.value;
        if (ctx.state.trackToMove && destinationPlaylistPath) {
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