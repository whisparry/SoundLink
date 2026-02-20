const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, globalShortcut, Notification } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const SpotifyWebApi = require('spotify-web-api-node');
const mm = require('music-metadata');
const axios = require('axios');
const log = require('electron-log');

const LOG_LEVELS = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
};

const currentLogLevel = process.env.SOUNDLINK_LOG_LEVEL?.toLowerCase() || 'debug';

function shouldLog(level) {
    const requested = LOG_LEVELS[level] ?? LOG_LEVELS.info;
    const active = LOG_LEVELS[currentLogLevel] ?? LOG_LEVELS.debug;
    return requested >= active;
}

function writeLog(level, scope, message, data) {
    const safeLevel = LOG_LEVELS[level] ? level : 'info';
    if (!shouldLog(safeLevel)) return;

    const timestamp = new Date().toISOString();
    const scopeText = scope ? `[${scope}]` : '';
    const prefix = `${timestamp} [${safeLevel.toUpperCase()}] ${scopeText}`.trim();

    if (data !== undefined) {
        console[safeLevel === 'debug' ? 'log' : safeLevel](`${prefix} ${message}`, data);
        return;
    }

    console[safeLevel === 'debug' ? 'log' : safeLevel](`${prefix} ${message}`);
}

// --- CONSTANTS & CONFIG ---
const supportedExtensions = ['.m4a', '.mp3', '.wav', '.flac', '.ogg', '.webm'];
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const isDev = !app.isPackaged;
const assetsPath = isDev ? path.join(__dirname, 'assets') : path.join(process.resourcesPath, 'assets');
const trayIconPath = path.join(assetsPath, 'icon.png');
const configPath = path.join(app.getPath('userData'), 'config.json');
const statsPath = path.join(app.getPath('userData'), 'stats.json');
const cachePath = path.join(app.getPath('userData'), 'link_cache.json');
const ytdlpDir = isDev ? path.join(__dirname, 'yt-dlp') : path.join(process.resourcesPath, 'yt-dlp');

// --- STATE VARIABLES ---
let config = {};
let stats = {};
let linkCache = {};
let downloadsDir = path.join(app.getPath('downloads'), 'SoundLink');
let mainWindow;
let tray = null;
let activeProcesses = new Set();
let ytdlpExecutables = [];
let ytdlpInstanceIndex = 0;
let lastDownloadedFiles = [];
let lastPlaylistName = null;
let isDownloadCancelled = false;

// --- HELPER FUNCTIONS (Pre-Startup) ---
function formatEta(ms) {
    if (ms < 0 || !isFinite(ms)) return 'calculating...';
    const seconds = Math.floor((ms / 1000) % 60);
    const minutes = Math.floor((ms / (1000 * 60)) % 60);
    const hours = Math.floor((ms / (1000 * 60 * 60)));

    if (hours > 0) return `${hours}h ${minutes}m remaining`;
    if (minutes > 0) return `${minutes}m ${seconds}s remaining`;
    if (seconds > 0) return `${seconds}s remaining`;
    return 'less than a second remaining';
}

function findYtdlpExecutables() {
    try {
        if (!fs.existsSync(ytdlpDir)) {
            console.error(`yt-dlp directory not found at: ${ytdlpDir}`);
            return;
        }
        const files = fs.readdirSync(ytdlpDir);
        ytdlpExecutables = files
            .filter(file => file.startsWith('yt-dlp') && file.endsWith('.exe'))
            .map(file => path.join(ytdlpDir, file));

        if (ytdlpExecutables.length === 0) {
            console.error(`No 'yt-dlp*.exe' executables found in ${ytdlpDir}`);
        } else {
            console.log(`Found ${ytdlpExecutables.length} yt-dlp instances.`);
        }
    } catch (error) {
        console.error('Failed to find yt-dlp executables:', error);
    }
}

function loadConfig() {
    try {
        if (fs.existsSync(configPath)) {
            config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            downloadsDir = config.downloadsPath || downloadsDir;
        } else {
            config = { 
                theme: 'dark',
                fileExtension: 'm4a',
                downloadThreads: 3,
                spotifySearchLimit: 10,
                tabSwitchSpeed: 0.2,
                dropdownSpeed: 0.4,
                themeFadeSpeed: 0.3,
                spotify: { clientId: '', clientSecret: '' }, 
                downloadsPath: downloadsDir,
                autoCreatePlaylist: false,
                favoriteThemes: [],
                favoritePlaylists: [],
                normalizeVolume: false,
                hideSearchBars: false,
                playlistsFolderPath: ''
            };
            fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
        }
    } catch (error) {
        console.error('Failed to load or create config file:', error);
        config = {}; // Fallback to empty config
    }
}

function loadStats() {
    try {
        if (fs.existsSync(statsPath)) {
            stats = JSON.parse(fs.readFileSync(statsPath, 'utf-8'));
        } else {
            stats = {
                totalSongsDownloaded: 0,
                playlistsCreated: 0,
                downloadsInitiated: 0,
                songsFailed: 0,
                totalLinksProcessed: 0,
                spotifyLinksProcessed: 0,
                youtubeLinksProcessed: 0,
                notificationsReceived: 0,
            };
            fs.writeFileSync(statsPath, JSON.stringify(stats, null, 4));
        }
    } catch (error) {
        console.error('Failed to load or create stats file:', error);
        stats = {}; // Fallback
    }
}

function loadCache() {
    try {
        if (fs.existsSync(cachePath)) {
            linkCache = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
        } else {
            linkCache = {};
            fs.writeFileSync(cachePath, JSON.stringify(linkCache, null, 4));
        }
    } catch (error) {
        console.error('Failed to load or create link cache file:', error);
        linkCache = {}; // Fallback
    }
}

function safeWriteFileSync(filePath, data) {
    const tempPath = `${filePath}.tmp-${Date.now()}`;
    try {
        fs.writeFileSync(tempPath, data, 'utf-8');
        fs.renameSync(tempPath, filePath);
    } catch (error) {
        if (fs.existsSync(tempPath)) {
            try {
                fs.unlinkSync(tempPath);
            } catch (unlinkError) {
                console.error('Failed to clean up temp file:', unlinkError);
            }
        }
        throw error;
    }
}

function saveStats() {
    try {
        safeWriteFileSync(statsPath, JSON.stringify(stats, null, 4));
    } catch (error) {
        console.error('Failed to save stats file:', error);
    }
}

function saveCache() {
    try {
        safeWriteFileSync(cachePath, JSON.stringify(linkCache, null, 4));
    } catch (error) {
        console.error('Failed to save link cache file:', error);
    }
}

function getNextYtdlpPath() {
    if (ytdlpExecutables.length === 0) return null;
    const path = ytdlpExecutables[ytdlpInstanceIndex];
    ytdlpInstanceIndex = (ytdlpInstanceIndex + 1) % ytdlpExecutables.length;
    return path;
}

// --- INITIAL SETUP ---
autoUpdater.logger = log;
autoUpdater.logger.transports.file.level = 'info';
log.info('App starting...');
writeLog('info', 'Main', 'App bootstrap started', { isDev, currentLogLevel });

loadConfig();
loadStats();
loadCache();
findYtdlpExecutables();
if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir, { recursive: true });
}

const spotifyApi = new SpotifyWebApi({
    clientId: config.spotify?.clientId,
    clientSecret: config.spotify?.clientSecret,
});

// --- SINGLE INSTANCE LOCK ---
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', (event, commandLine, workingDirectory) => {
        // Someone tried to run a second instance, we should focus our window.
        if (mainWindow) {
            if (!mainWindow.isVisible()) mainWindow.show();
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });

// --- MAIN WINDOW CREATION ---
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1000,
        height: 680,
        minWidth: 940,
        minHeight: 600,
        frame: false,
        show: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
        icon: trayIconPath
    });

    mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

    mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
        const levelMap = {
            0: 'debug',
            1: 'info',
            2: 'warn',
            3: 'error',
        };
        writeLog(levelMap[level] || 'info', 'RendererConsole', message, {
            line,
            sourceId,
        });
    });

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
        if (!isDev) {
            autoUpdater.checkForUpdates();
        }
    });

    mainWindow.on('close', (event) => {
        if (!app.isQuitting) {
            event.preventDefault();
            mainWindow.hide();
        }
        return false;
    });
}

// --- APP LIFECYCLE & IPC HANDLERS ---
app.whenReady().then(() => {
    ipcMain.on('renderer-log', (event, payload = {}) => {
        const { level = 'info', scope = 'Renderer', message = '', data } = payload;
        writeLog(level, `Renderer:${scope}`, message, data);
    });

    writeLog('info', 'Main', 'App ready event received');
    createWindow();

    // Start periodic update checks
    if (!isDev) {
        setInterval(() => {
            log.info('[AutoUpdater] Performing periodic check for updates.');
            autoUpdater.checkForUpdates();
        }, 3 * 60 * 1000); // 3 minutes
    }

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });

    try {
        tray = new Tray(trayIconPath);
        const contextMenu = Menu.buildFromTemplate([
            { label: 'Show App', click: () => mainWindow.show() },
            { 
                label: 'Quit', 
                click: () => {
                    app.isQuitting = true;
                    app.quit();
                } 
            }
        ]);
        tray.setToolTip('SoundLink');
        tray.setContextMenu(contextMenu);
        tray.on('click', () => {
            writeLog('debug', 'Tray', 'Tray icon clicked');
            mainWindow.show();
        });
    } catch (error) {
        writeLog('error', 'Tray', 'Failed to create system tray icon', { error: error.message });
    }

    // --- ALL IPC HANDLERS ARE DEFINED HERE ---

    ipcMain.handle('get-playlists', async () => {
        const webContents = mainWindow.webContents;
        try {
            const playlistsPath = config.playlistsFolderPath;
            webContents.send('update-status', `[Playlist Loader] Checking for playlists in: "${playlistsPath}"`);

            if (!playlistsPath || !fs.existsSync(playlistsPath)) {
                const errorMsg = !playlistsPath 
                    ? '[Playlist Loader] Error: Playlists folder path is not set in config.'
                    : `[Playlist Loader] Error: Path does not exist: "${playlistsPath}"`;
                webContents.send('update-status', errorMsg);
                return [];
            }

            const entries = await fs.promises.readdir(playlistsPath, { withFileTypes: true });
            const directories = entries.filter(entry => entry.isDirectory());
            webContents.send('update-status', `[Playlist Loader] Found ${directories.length} directories.`);
            return directories.map(entry => ({ name: entry.name, path: path.join(playlistsPath, entry.name) }));
        } catch (err) {
            console.error('Error loading playlists:', err);
            webContents.send('update-status', `[Playlist Loader] CRITICAL ERROR: ${err.message}`);
            return [];
        }
    });

    ipcMain.handle('get-playlist-tracks', async (event, playlistPath) => {
        try {
            if (!playlistPath || !fs.existsSync(playlistPath)) return { tracks: [], totalDuration: 0 };
            const files = await fs.promises.readdir(playlistPath);
            const tracks = [];
            // FIX: Removed the slow metadata reading loop to make playlist loading instant.
            for (const file of files) {
                const ext = path.extname(file).toLowerCase();
                if (supportedExtensions.includes(ext)) {
                    const filePath = path.join(playlistPath, file);
                    // We no longer read metadata, so duration is set to 0.
                    tracks.push({ name: path.basename(file, ext), path: filePath, duration: 0 });
                }
            }
            // Total duration is no longer calculated.
            return { tracks, totalDuration: 0 };
        } catch (err) {
            console.error(`Error loading tracks from "${playlistPath}":`, err);
            return { tracks: [], totalDuration: 0 };
        }
    });

    ipcMain.on('close-app', () => {
        mainWindow.close();
    });

    ipcMain.handle('get-ytdlp-count', () => ytdlpExecutables.length);

    ipcMain.handle('get-settings', () => config);

    ipcMain.handle('get-stats', () => stats);

    ipcMain.on('increment-notification-stat', () => {
        stats.notificationsReceived = (stats.notificationsReceived || 0) + 1;
        saveStats();
    });

    ipcMain.handle('reset-stats', () => {
        stats = {
            totalSongsDownloaded: 0,
            playlistsCreated: 0,
            downloadsInitiated: 0,
            songsFailed: 0,
            totalLinksProcessed: 0,
            spotifyLinksProcessed: 0,
            youtubeLinksProcessed: 0,
            notificationsReceived: 0,
        };
        saveStats();
        return stats;
    });

    ipcMain.handle('clear-link-cache', () => {
        linkCache = {};
        saveCache();
        return { success: true, message: 'Link cache cleared successfully.' };
    });

    ipcMain.handle('get-default-settings', () => {
        const defaultDownloadsPath = path.join(app.getPath('downloads'), 'SoundLink');
        return { 
            theme: 'dark',
            fileExtension: 'm4a',
            downloadThreads: 3,
            spotifySearchLimit: 10,
            tabSwitchSpeed: 0.2,
            dropdownSpeed: 0.4,
            themeFadeSpeed: 0.3,
            spotify: { clientId: '', clientSecret: '' }, 
            autoCreatePlaylist: false,
            hideRefreshButtons: false,
            hidePlaylistCounts: false,
            hideTrackNumbers: false,
            downloadsPath: defaultDownloadsPath,
            favoriteThemes: [],
            favoritePlaylists: [],
            normalizeVolume: false,
            hideSearchBars: false,
        };
    });

    ipcMain.handle('save-settings', (event, newSettings) => {
        try {
            config = { ...config, ...newSettings };
            safeWriteFileSync(configPath, JSON.stringify(config, null, 4));
            downloadsDir = config.downloadsPath;
            if (config.spotify) {
                spotifyApi.setClientId(config.spotify.clientId);
                spotifyApi.setClientSecret(config.spotify.clientSecret);
            }
            return { success: true };
        } catch (error) {
            console.error('Failed to save settings:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.on('show-in-explorer', (event, path) => {
        if (path && fs.existsSync(path)) {
            shell.showItemInFolder(path);
        }
    });

    ipcMain.handle('update-ytdlp', async () => {
        return new Promise((resolve) => {
            const ytdlpPath = getNextYtdlpPath();
            if (!ytdlpPath) {
                return resolve('Error: yt-dlp executable not found.');
            }
            const proc = spawn(ytdlpPath, ['-U']);
            let output = '';
            proc.stdout.on('data', (data) => output += data.toString());
            proc.stderr.on('data', (data) => output += data.toString());
            proc.on('close', (code) => {
                if (code === 0) {
                    if (output.includes('is up to date')) {
                        resolve('Up to date!');
                    } else if (output.includes('Updated yt-dlp to')) {
                        resolve('Updated successfully!');
                    } else {
                        resolve('Update check completed.'); // Fallback for unexpected output
                    }
                } else {
                    resolve(`Update failed with exit code ${code}:\n${output}`);
                }
            });
            proc.on('error', (err) => {
                resolve(`Failed to run updater: ${err.message}`);
            });
        });
    });

    ipcMain.handle('open-folder-dialog', async () => {
        try {
            const result = await dialog.showOpenDialog(mainWindow, {
                properties: ['openDirectory'],
                title: 'Select a Folder'
            });
            return result.canceled ? null : result.filePaths[0];
        } catch (err) {
            console.error('Error in open-folder-dialog:', err);
            return null;
        }
    });

    ipcMain.handle('get-library-stats', async () => {
        const stats = { playlistCount: 0, trackCount: 0 };
        const playlistsPath = config.playlistsFolderPath;
        try {
            if (!playlistsPath || !fs.existsSync(playlistsPath)) return stats;

            const playlistFolders = await fs.promises.readdir(playlistsPath, { withFileTypes: true });
            const directories = playlistFolders.filter(entry => entry.isDirectory());
            stats.playlistCount = directories.length;

            let totalTracks = 0;
            for (const folder of directories) {
                const playlistFolderPath = path.join(playlistsPath, folder.name);
                const files = await fs.promises.readdir(playlistFolderPath);
                for (const file of files) {
                    if (supportedExtensions.includes(path.extname(file).toLowerCase())) {
                        totalTracks++;
                    }
                }
            }
            stats.trackCount = totalTracks;
            return stats;
        } catch (error) {
            console.error('Error calculating library stats:', error);
            return stats; // Return default stats on error
        }
    });

    ipcMain.on('open-external-link', (event, url) => {
        if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
            shell.openExternal(url);
        }
    });

    ipcMain.handle('delete-track', async (event, filePath) => {
        try {
            if (!filePath || !fs.existsSync(filePath)) {
                return { success: false, error: 'File does not exist.' };
            }
            await fs.promises.unlink(filePath);
            return { success: true };
        } catch (error) {
            console.error(`Failed to delete track: ${filePath}`, error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('move-track', async (event, { sourcePath, destinationPlaylistPath }) => {
        try {
            if (!sourcePath || !fs.existsSync(sourcePath)) {
                return { success: false, error: 'Source file does not exist.' };
            }
            if (!destinationPlaylistPath || !fs.existsSync(destinationPlaylistPath)) {
                return { success: false, error: 'Destination playlist does not exist.' };
            }
            const fileName = path.basename(sourcePath);
            const destinationPath = path.join(destinationPlaylistPath, fileName);
            await fs.promises.rename(sourcePath, destinationPath);
            return { success: true };
        } catch (error) {
            console.error(`Failed to move track from ${sourcePath} to ${destinationPlaylistPath}`, error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('rename-playlist', async (event, { oldPath, newName }) => {
        try {
            const sanitizedNewName = sanitizeFilename(newName);
            if (!sanitizedNewName) {
                return { success: false, error: 'Invalid playlist name.' };
            }
            const parentDir = path.dirname(oldPath);
            const newPath = path.join(parentDir, sanitizedNewName);

            if (fs.existsSync(newPath)) {
                return { success: false, error: 'A playlist with this name already exists.' };
            }

            await fs.promises.rename(oldPath, newPath);
            return { success: true, newPath };
        } catch (error) {
            console.error(`Failed to rename playlist from ${oldPath} to ${newName}`, error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('create-new-playlist', async () => {
        const playlistsPath = config.playlistsFolderPath;
        if (!playlistsPath || !fs.existsSync(playlistsPath)) {
            return { success: false, error: 'Playlists folder is not set or does not exist.' };
        }

        let newPlaylistName = "New Playlist";
        let newPlaylistPath = path.join(playlistsPath, newPlaylistName);
        let counter = 2;

        // Handle name conflicts like Windows Explorer
        while (fs.existsSync(newPlaylistPath)) {
            newPlaylistName = `New Playlist (${counter})`;
            newPlaylistPath = path.join(playlistsPath, newPlaylistName);
            counter++;
        }

        try {
            await fs.promises.mkdir(newPlaylistPath, { recursive: true });
            stats.playlistsCreated = (stats.playlistsCreated || 0) + 1;
            saveStats();
            // Return the created playlist info
            return { 
                success: true, 
                newPlaylist: {
                    name: newPlaylistName,
                    path: newPlaylistPath
                }
            };
        } catch (error) {
            console.error('Failed to create new playlist folder:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('delete-playlist', async (event, playlistPath) => {
        try {
            if (!playlistPath || !fs.existsSync(playlistPath)) {
                return { success: false, error: 'Playlist folder does not exist.' };
            }
            await fs.promises.rm(playlistPath, { recursive: true, force: true });
            return { success: true };
        } catch (error) {
            console.error(`Failed to delete playlist: ${playlistPath}`, error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('rename-track', async (event, { oldPath, newName }) => {
        try {
            const sanitizedNewName = sanitizeFilename(newName);
            if (!sanitizedNewName) {
                return { success: false, error: 'Invalid track name.' };
            }
            const parentDir = path.dirname(oldPath);
            const extension = path.extname(oldPath);
            const newPath = path.join(parentDir, `${sanitizedNewName}${extension}`);

            if (fs.existsSync(newPath)) {
                return { success: false, error: 'A track with this name already exists in this playlist.' };
            }

            await fs.promises.rename(oldPath, newPath);
            return { success: true, newPath };
        } catch (error) {
            console.error(`Failed to rename track from ${oldPath} to ${newName}`, error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('get-spotify-item-details', async (event, { type, id }) => {
        try {
            await refreshSpotifyToken();
            if (type === 'playlist') {
                const data = await spotifyApi.getPlaylist(id);
                const tracks = data.body.tracks.items.map(item => item.track ? { name: item.track.name, artist: item.track.artists.map(a => a.name).join(', '), url: item.track.external_urls.spotify } : null).filter(Boolean);
                return { name: data.body.name, tracks };
            } else if (type === 'album') {
                const data = await spotifyApi.getAlbum(id);
                const tracks = data.body.tracks.items.map(track => ({ name: track.name, artist: track.artists.map(a => a.name).join(', '), url: track.external_urls.spotify }));
                return { name: data.body.name, tracks };
            } else if (type === 'track') {
                const data = await spotifyApi.getTrack(id);
                const track = { name: data.body.name, artist: data.body.artists.map(a => a.name).join(', '), url: data.body.external_urls.spotify };
                return { name: data.body.name, tracks: [track] };
            }
            return null;
        } catch (error) {
            console.error('Failed to get Spotify item details:', error);
            return { error: error.message };
        }
    });

    // --- DOWNLOAD & SPOTIFY LOGIC ---

    ipcMain.handle('search-spotify-playlists', async (event, { query, type, limit }) => {
        if (!query || query.trim().length < 3) {
            return [];
        }
        try {
            await refreshSpotifyToken();
            const searchLimit = limit && limit >= 1 && limit <= 50 ? limit : 10;
    
            const searchFunctions = {
                playlist: async () => {
                    const data = await spotifyApi.searchPlaylists(query, { limit: searchLimit });
                    return data.body.playlists.items
                        .filter(p => p)
                        .map(p => ({
                            name: p.name,
                            owner: p.owner.display_name,
                            url: p.external_urls.spotify,
                            type: 'Playlist'
                        }));
                },
                track: async () => {
                    const data = await spotifyApi.searchTracks(query, { limit: searchLimit });
                    return data.body.tracks.items
                        .filter(t => t)
                        .map(t => ({
                            name: t.name,
                            artist: t.artists.map(a => a.name).join(', '),
                            url: t.external_urls.spotify,
                            type: 'Track'
                        }));
                },
                album: async () => {
                    const data = await spotifyApi.searchAlbums(query, { limit: searchLimit });
                    return data.body.albums.items
                        .filter(a => a)
                        .map(a => ({
                            name: a.name,
                            artist: a.artists.map(a => a.name).join(', '),
                            url: a.external_urls.spotify,
                            type: 'Album'
                        }));
                },
                all: async () => {
                    const perTypeLimit = Math.max(1, Math.floor(searchLimit / 3));
                    const [playlists, tracks, albums] = await Promise.all([
                        spotifyApi.searchPlaylists(query, { limit: perTypeLimit }),
                        spotifyApi.searchTracks(query, { limit: perTypeLimit }),
                        spotifyApi.searchAlbums(query, { limit: perTypeLimit + (searchLimit % 3) })
                    ]);
    
                    const playlistResults = playlists.body.playlists.items.filter(p => p).map(p => ({ name: p.name, owner: p.owner.display_name, url: p.external_urls.spotify, type: 'Playlist' }));
                    const trackResults = tracks.body.tracks.items.filter(t => t).map(t => ({ name: t.name, artist: t.artists.map(a => a.name).join(', '), url: t.external_urls.spotify, type: 'Track' }));
                    const albumResults = albums.body.albums.items.filter(a => a).map(a => ({ name: a.name, artist: a.artists.map(a => a.name).join(', '), url: a.external_urls.spotify, type: 'Album' }));
    
                    return [...playlistResults, ...trackResults, ...albumResults];
                }
            };
    
            if (searchFunctions[type]) {
                return await searchFunctions[type]();
            } else {
                return await searchFunctions.playlist();
            }
    
        } catch (error) {
            console.error('Spotify search failed:', error);
            let errorMessage = 'Could not perform search.';
            if (error.body && error.body.error) {
                errorMessage = `Spotify Error: ${error.body.error.message}`;
            } else if (error.message.includes('token')) {
                errorMessage = 'Spotify auth failed. Check credentials in Settings.';
            }
            return { error: errorMessage };
        }
    });

    ipcMain.on('start-download', async (event, linksArray) => {
        if (!linksArray || linksArray.length === 0) return mainWindow.webContents.send('update-status', 'No links provided.', true, { success: false });
        if (ytdlpExecutables.length === 0) return mainWindow.webContents.send('update-status', 'Error: No yt-dlp executable found.', true, { success: false });

        stats.downloadsInitiated = (stats.downloadsInitiated || 0) + 1;
        lastDownloadedFiles = [];
        lastPlaylistName = null;
        isDownloadCancelled = false;
        mainWindow.webContents.send('update-status', 'Starting download process...');

        try {
            await refreshSpotifyToken();
            const concurrency = Math.min(config.downloadThreads || 3, ytdlpExecutables.length);
            const itemsToProcess = [];
            let trackIndex = 0;
            let spotifyLinkCount = 0;
            let youtubeLinkCount = 0;

            for (const link of linksArray) {
                if (isDownloadCancelled) break;
                if (link.includes('spotify.com')) {
                    spotifyLinkCount++;
                    const { tracks, playlistName, error } = await getSpotifyTracks(link);
                    if (error) {
                        mainWindow.webContents.send('update-status', `Error processing Spotify link: ${error}`);
                        continue;
                    }
                    if (playlistName && !lastPlaylistName) lastPlaylistName = playlistName;
                    if (tracks) {
                        for (const track of tracks) {
                            itemsToProcess.push({ type: 'search', query: `${track.name} ${track.artist}`, name: track.name, metadata: track.metadata, index: trackIndex++ });
                        }
                    }
                } else {
                    youtubeLinkCount++;
                    itemsToProcess.push({ type: 'direct', link: link, index: trackIndex++ });
                }
            }

            if (isDownloadCancelled) return;
            const totalItems = itemsToProcess.length;
            stats.totalLinksProcessed = (stats.totalLinksProcessed || 0) + totalItems;
            stats.spotifyLinksProcessed = (stats.spotifyLinksProcessed || 0) + spotifyLinkCount;
            stats.youtubeLinksProcessed = (stats.youtubeLinksProcessed || 0) + youtubeLinkCount;
            mainWindow.webContents.send('update-status', `Phase 1/2: Finding links for ${totalItems} tracks...`);
            
            const linkFindingQueue = [...itemsToProcess];
            const itemsToDownload = [];

            const linkFinderWorker = async () => {
                while (linkFindingQueue.length > 0) {
                    if (isDownloadCancelled) return;
                    const item = linkFindingQueue.shift();
                    if (!item) continue;

                    try {
                        let youtubeLink;
                        let trackName;
                        if (item.type === 'search') {
                            youtubeLink = await getYouTubeLink(item.query);
                            trackName = item.name;
                            mainWindow.webContents.send('update-status', `🔗 (${item.index + 1}/${totalItems}) Found link for: ${trackName}`);
                        } else { // 'direct'
                            youtubeLink = item.link;
                            trackName = await getYouTubeTitle(item.link);
                            mainWindow.webContents.send('update-status', `🔗 (${item.index + 1}/${totalItems}) Found title: ${trackName}`);
                        }
                        itemsToDownload.push({ youtubeLink, trackName, index: item.index, metadata: item.metadata });
                    } catch (error) {
                        if (!isDownloadCancelled) {
                            mainWindow.webContents.send('update-status', `❌ Failed to find link for "${item.name || item.link}": ${error.message}`);
                            stats.songsFailed = (stats.songsFailed || 0) + 1;
                        }
                    }
                }
            };
            await Promise.all(Array.from({ length: concurrency }, linkFinderWorker));

            if (isDownloadCancelled) return;
            
            const totalItemsToDownload = itemsToDownload.length;
            if (totalItemsToDownload === 0) {
                mainWindow.webContents.send('update-status', 'No valid tracks found to download.', true, { success: true, filesDownloaded: 0 });
                return;
            }

            mainWindow.webContents.send('update-status', `Phase 2/2: Downloading ${totalItemsToDownload} tracks...`);

            const fileProgress = new Array(totalItemsToDownload).fill(0);
            const downloadPhaseStartTime = Date.now();

            const updateOverallProgress = () => {
                const totalProgress = fileProgress.reduce((a, b) => a + b, 0) / totalItemsToDownload;
                const elapsedMs = Date.now() - downloadPhaseStartTime;
                let etaString = 'calculating...';
                if (totalProgress > 1) {
                    const totalEstimatedTime = (elapsedMs / totalProgress) * 100;
                    const remainingMs = totalEstimatedTime - elapsedMs;
                    etaString = formatEta(remainingMs);
                }
                mainWindow.webContents.send('download-progress', { progress: totalProgress, eta: etaString });
            };

            const downloadQueue = [...itemsToDownload.sort((a, b) => a.index - b.index).map((item, idx) => ({ ...item, queueIndex: idx }))];

            const downloadWorker = async () => {
                while (downloadQueue.length > 0) {
                    if (isDownloadCancelled) return;
                    const item = downloadQueue.shift();
                    if (!item) continue;
                    try {
                        const filePath = await downloadItem(item, item.index, totalItems, (progress) => {
                            fileProgress[item.queueIndex] = progress;
                            updateOverallProgress();
                        });
                        fileProgress[item.queueIndex] = 100;
                        updateOverallProgress();
                        lastDownloadedFiles.push(filePath);
                        stats.totalSongsDownloaded = (stats.totalSongsDownloaded || 0) + 1;
                    } catch (error) {
                        if (!isDownloadCancelled) {
                            console.error(`Download worker failed:`, error.message);
                            stats.songsFailed = (stats.songsFailed || 0) + 1;
                        }
                    }
                }
            };
            await Promise.all(Array.from({ length: concurrency }, downloadWorker));

            if (!isDownloadCancelled) {
                mainWindow.webContents.send('update-status', 'Task done.', true, { success: true, filesDownloaded: lastDownloadedFiles.length });
            }

        } catch (error) {
            console.error('An error occurred during the download process:', error);
            mainWindow.webContents.send('update-status', `Error: ${error.message}`, true, { success: false });
        } finally {
            if (!isDownloadCancelled) saveStats();
        }
    });

    ipcMain.handle('create-playlist', async () => {
        if (lastDownloadedFiles.length === 0) return 'No files from the last session to create a playlist with.';
        if (!lastPlaylistName) {
            const date = new Date();
            lastPlaylistName = `Playlist ${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
        }

        const sanitizedPlaylistName = sanitizeFilename(lastPlaylistName);
        const playlistsPath = config.playlistsFolderPath;
        if (!playlistsPath || !fs.existsSync(playlistsPath)) {
            return 'Error: Playlists folder is not set or does not exist. Please set it in Settings.';
        }

        const folderName = path.join(playlistsPath, sanitizedPlaylistName);
        try {
            if (!fs.existsSync(folderName)) {
                fs.mkdirSync(folderName, { recursive: true });
            }
            let movedCount = 0;
            for (const oldPath of lastDownloadedFiles) {
                if (fs.existsSync(oldPath)) {
                    const newPath = path.join(folderName, path.basename(oldPath));
                    fs.renameSync(oldPath, newPath);
                    movedCount++;
                }
            }
            lastDownloadedFiles = [];
            stats.playlistsCreated = (stats.playlistsCreated || 0) + 1;
            saveStats();
            return `Successfully created playlist and moved ${movedCount} files to "${sanitizedPlaylistName}".`;
        } catch (error) {
            console.error('Failed to create playlist folder:', error);
            return `Error: Could not create playlist. ${error.message}`;
        }
    });

    ipcMain.on('cancel-download', () => {
        isDownloadCancelled = true;
        for (const proc of activeProcesses) {
            try { proc.kill('SIGTERM'); } catch (err) { console.error('Failed to kill process:', err); }
        }
        activeProcesses.clear();
        if (mainWindow) mainWindow.webContents.send('update-status', 'Download cancelled by user.', true, { success: false });
        saveStats();
    });

    async function refreshSpotifyToken() {
        // Always sync credentials from the config object before use to ensure they are up-to-date.
        if (config.spotify) {
            spotifyApi.setClientId(config.spotify.clientId);
            spotifyApi.setClientSecret(config.spotify.clientSecret);
        }

        if (!spotifyApi.getClientId() || !spotifyApi.getClientSecret()) {
            const userMessage = 'Spotify credentials are not set. Please set them in the Settings tab.';
            mainWindow.webContents.send('update-status', userMessage);
            // Throw an error to halt the download process immediately.
            throw new Error(userMessage);
        }
        try {
            const data = await spotifyApi.clientCredentialsGrant();
            spotifyApi.setAccessToken(data.body['access_token']);
            mainWindow.webContents.send('update-status', 'Spotify token refreshed.');
        } catch (error) {
            let userMessage = 'Error: Could not refresh Spotify token. Please check your credentials in Settings.';
            if (error.body && error.body.error_description) {
                userMessage = `Spotify Auth Error: ${error.body.error_description}. Please check your credentials.`;
            }
            mainWindow.webContents.send('update-status', userMessage);
            throw new Error('Spotify token refresh failed.');
        }
    }

    async function getSpotifyTracks(link) {
        const regex = /spotify\.com\/(playlist|album|track)\/([a-zA-Z0-9]+)/;
        const match = link.match(regex);
        if (!match) return { error: 'Invalid Spotify link' };

        const type = match[1];
        const id = match[2];
        let tracks = [];
        let playlistName = null;

        try {
            if (type === 'playlist') {
                const playlistData = await spotifyApi.getPlaylist(id);
                playlistName = playlistData.body.name;
                let offset = 0;
                let total = playlistData.body.tracks.total;
                while (offset < total) {
                    const data = await spotifyApi.getPlaylistTracks(id, { offset, limit: 100 });
                    tracks.push(...data.body.items.map(item => {
                        if (!item.track) return null;
                        const track = item.track;
                        return {
                            name: track.name,
                            artist: track.artists.map(a => a.name).join(', '),
                        };
                    }));
                    offset += 100;
                }
            } else if (type === 'album') {
                const albumData = await spotifyApi.getAlbum(id);
                playlistName = albumData.body.name;
                const albumInfo = {
                    album: albumData.body.name,
                    year: albumData.body.release_date ? albumData.body.release_date.substring(0, 4) : '',
                    artworkUrl: albumData.body.images.length > 0 ? albumData.body.images[0].url : null
                };
                let offset = 0;
                let total = albumData.body.tracks.total;
                while (offset < total) {
                    const data = await spotifyApi.getAlbumTracks(id, { offset, limit: 50 });
                    tracks.push(...data.body.items.map(track => ({
                        name: track.name,
                        artist: track.artists.map(a => a.name).join(', '),
                    })));
                    offset += 50;
                }
            } else if (type === 'track') {
                const data = await spotifyApi.getTrack(id);
                const track = data.body;
                tracks.push({
                    name: track.name,
                    artist: track.artists.map(a => a.name).join(', '),
                });
            }
            return { tracks: tracks.filter(Boolean), playlistName };
        } catch (error) {
            let userMessage = `Error fetching from Spotify: ${error.message}`;
            if (error.statusCode === 404) userMessage = 'Error: Spotify resource not found. Check if the link is correct and the playlist/album is public.';
            else if (error.statusCode === 401) userMessage = 'Error: Bad or expired Spotify token. Check credentials in Settings.';
            else if (error.statusCode === 403) userMessage = 'Error: Not authorized to access this resource. It may be a private playlist.';
            mainWindow.webContents.send('update-status', userMessage);
            return { error: userMessage };
        }
    }

    function sanitizeFilename(name) {
        return name.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim();
    }

    function runYtdlp(args) {
        return new Promise((resolve, reject) => {
            if (isDownloadCancelled) return reject(new Error('Operation cancelled'));
            const ytdlpPath = getNextYtdlpPath();
            if (!ytdlpPath) return reject(new Error('No yt-dlp executable found.'));
            const proc = spawn(ytdlpPath, args);
            activeProcesses.add(proc);
            let stdout = '', stderr = '';

            proc.stdout.on('data', (data) => { stdout += data.toString(); });
            proc.stderr.on('data', (data) => { stderr += data.toString(); });
            proc.on('close', (code) => {
                activeProcesses.delete(proc);
                if (isDownloadCancelled) return reject(new Error('Operation cancelled'));
                if (code === 0) resolve(stdout);
                else reject(new Error(`yt-dlp exited with code ${code}: ${stderr}`));
            });
            proc.on('error', (err) => {
                activeProcesses.delete(proc);
                reject(err);
            });
        });
    }

    async function getYouTubeLink(query) {
        if (linkCache[query]) {
            mainWindow.webContents.send('update-status', `[Cache] Found link for: ${query}`);
            return linkCache[query];
        }
        const videoId = await runYtdlp(['--get-id', `ytsearch1:"${query}"`]);
        if (!videoId) throw new Error('No video found for query.');
        const youtubeLink = `https://www.youtube.com/watch?v=${videoId.trim()}`;
        linkCache[query] = youtubeLink;
        saveCache();
        return youtubeLink;
    }

    async function getYouTubeTitle(link) {
        const title = await runYtdlp(['--get-title', link]);
        return title.trim();
    }

    async function downloadItem(item, index, total, onProgress) {
        const { youtubeLink: link, trackName } = item;
        const sanitizedTrackName = sanitizeFilename(trackName);
        const numberPrefix = (index + 1).toString().padStart(3, '0');
        const outputTemplate = path.join(downloadsDir, `${numberPrefix} - ${sanitizedTrackName}.%(ext)s`);
        const audioFormat = config.fileExtension || 'm4a';
        const args = [
            '--extract-audio', 
            '--audio-format', audioFormat, 
            '--audio-quality', '0', 
            '--output', outputTemplate, 
            '--progress', 
            '--no-playlist', 
            '--ffmpeg-location', ytdlpDir, 
            link
        ];

        if (config.normalizeVolume) {
            args.push('--ppa', 'ffmpeg:-af loudnorm');
        }

        return new Promise((resolve, reject) => {
            if (isDownloadCancelled) return reject(new Error('Download cancelled'));
            const ytdlpPath = getNextYtdlpPath();
            if (!ytdlpPath) return reject(new Error('No yt-dlp executable found.'));
            const proc = spawn(ytdlpPath, args);
            activeProcesses.add(proc);
            let finalPath = '';
            proc.stdout.on('data', (data) => {
                const output = data.toString();
                const progressMatch = output.match(/\[download\]\s+([\d.]+)%/);
                if (progressMatch && onProgress) {
                    onProgress(parseFloat(progressMatch[1]));
                } else {
                    const progressMatchSimple = output.match(/(\d+)%/);
                    if (progressMatchSimple && onProgress) {
                        onProgress(parseFloat(progressMatchSimple[1]));
                    }
                }
                const destinationMatch = output.match(/\[ExtractAudio\] Destination: (.*)/);
                if (destinationMatch) finalPath = destinationMatch[1].trim();
            });
            proc.on('close', async (code) => {
                activeProcesses.delete(proc);
                if (isDownloadCancelled) return reject(new Error('Download cancelled'));
                if (code === 0 && finalPath) {
                    mainWindow.webContents.send('update-status', `✅ [${index + 1}/${total}] Finished: "${sanitizedTrackName}"`);
                    resolve(finalPath);
                } else {
                    const errorMsg = `❌ [${index + 1}/${total}] Failed: "${sanitizedTrackName}" (yt-dlp exit code ${code})`;
                    mainWindow.webContents.send('update-status', errorMsg);
                    reject(new Error(errorMsg));
                }
            });
            proc.on('error', (err) => {
                activeProcesses.delete(proc);
                reject(err);
            });
        });
    }
});

// --- AUTO UPDATER LOGIC ---
autoUpdater.on('checking-for-update', () => {
    log.info('Checking for update...');
});

autoUpdater.on('update-available', (info) => {
    log.info('Update available.', info);
    mainWindow.webContents.send('update-available');
});

autoUpdater.on('update-not-available', (info) => {
    log.info('Update not available.', info);
    mainWindow.webContents.send('show-update-not-available-notification');
});

autoUpdater.on('error', (err) => {
    log.error('Error in auto-updater. ' + err);
    mainWindow.webContents.send('update-status', `[Updater] Error: ${err.message}`);
});

autoUpdater.on('download-progress', (progressObj) => {
    const log_message = `Downloaded ${progressObj.percent.toFixed(2)}% (${(progressObj.bytesPerSecond / 1024).toFixed(2)} KB/s)`;
    log.info(log_message);
    mainWindow.webContents.send('update-download-progress', progressObj);
});

autoUpdater.on('update-downloaded', (info) => {
    log.info('Update downloaded.', info);
    mainWindow.webContents.send('update-downloaded');

    if (Notification.isSupported()) {
        const notification = new Notification({
            title: 'SoundLink Update Ready',
            body: 'A new version has been downloaded. Click to restart and install.',
            icon: trayIconPath
        });
        notification.show();
        notification.on('click', () => {
            log.info('Restart notification clicked. Quitting and installing silently...');
            app.isQuitting = true;
            autoUpdater.quitAndInstall(true, true);
        });
    }
});

ipcMain.on('restart-app', () => {
    app.isQuitting = true;
    autoUpdater.quitAndInstall(true, true);
});

// --- ERROR HANDLING ---
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    if (mainWindow) {
        mainWindow.webContents.send('update-status', `Unexpected error occurred: ${error.message}`, true, { success: false });
    }
});

app.on('will-quit', () => {
    // Unregister all shortcuts.
    globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
    if (tray) {
        tray.destroy();
        tray = null;
    }
    app.quit();
});
}