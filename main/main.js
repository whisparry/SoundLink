const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, globalShortcut, Notification } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
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
const trackTagsPath = path.join(app.getPath('userData'), 'track_tags.json');
const undoTrashPath = path.join(app.getPath('userData'), 'undo-trash');
const trimUndoManifestPath = path.join(app.getPath('userData'), 'trim-undo-manifests');
const ytdlpDir = isDev ? path.join(__dirname, 'yt-dlp') : path.join(process.resourcesPath, 'yt-dlp');
const userDataPluginRoot = path.join(app.getPath('userData'), 'yt-dlp-plugins');
const ytdlpGetPotPluginDir = path.join(userDataPluginRoot, 'yt-dlp-get-pot');

// --- STATE VARIABLES ---
let config = {};
let stats = {};
let linkCache = {};
let trackTags = {};
let downloadsDir = path.join(app.getPath('downloads'), 'SoundLink');
let mainWindow;
let tray = null;
let activeProcesses = new Set();
let ytdlpExecutables = [];
let ytdlpInstanceIndex = 0;
let lastDownloadedFiles = [];
let lastPlaylistName = null;
let isDownloadCancelled = false;
let cachedYtdlpPluginPath = undefined;
let hasLoggedMissingYtdlpPlugin = false;
let cachedYtdlpPluginFlag = undefined;
let cachedNodeRuntimePath = undefined;
let manualLinkRequestCounter = 0;
const pendingManualLinkRequests = new Map();
const activeSilenceTrimJobs = new Map();

const DEFAULT_DOWNLOAD_TIMING_STATS = {
    trackSamples: 0,
    averageTrackDurationMs: 0,
    queueSamples: 0,
    averageQueueDurationMs: 0,
    linkTrackSamples: 0,
    averageLinkTrackDurationMs: 0,
    linkQueueSamples: 0,
    averageLinkQueueDurationMs: 0,
};

function ensureDownloadTimingStatsShape(targetStats) {
    if (!targetStats || typeof targetStats !== 'object') return { ...DEFAULT_DOWNLOAD_TIMING_STATS };

    const rawTiming = targetStats.downloadTiming || {};
    const safeTrackSamples = Number.isFinite(rawTiming.trackSamples) && rawTiming.trackSamples > 0
        ? Math.floor(rawTiming.trackSamples)
        : 0;
    const safeQueueSamples = Number.isFinite(rawTiming.queueSamples) && rawTiming.queueSamples > 0
        ? Math.floor(rawTiming.queueSamples)
        : 0;
    const safeAverageTrackDurationMs = Number.isFinite(rawTiming.averageTrackDurationMs) && rawTiming.averageTrackDurationMs > 0
        ? rawTiming.averageTrackDurationMs
        : 0;
    const safeAverageQueueDurationMs = Number.isFinite(rawTiming.averageQueueDurationMs) && rawTiming.averageQueueDurationMs > 0
        ? rawTiming.averageQueueDurationMs
        : 0;
    const safeLinkTrackSamples = Number.isFinite(rawTiming.linkTrackSamples) && rawTiming.linkTrackSamples > 0
        ? Math.floor(rawTiming.linkTrackSamples)
        : 0;
    const safeAverageLinkTrackDurationMs = Number.isFinite(rawTiming.averageLinkTrackDurationMs) && rawTiming.averageLinkTrackDurationMs > 0
        ? rawTiming.averageLinkTrackDurationMs
        : 0;
    const safeLinkQueueSamples = Number.isFinite(rawTiming.linkQueueSamples) && rawTiming.linkQueueSamples > 0
        ? Math.floor(rawTiming.linkQueueSamples)
        : 0;
    const safeAverageLinkQueueDurationMs = Number.isFinite(rawTiming.averageLinkQueueDurationMs) && rawTiming.averageLinkQueueDurationMs > 0
        ? rawTiming.averageLinkQueueDurationMs
        : 0;

    targetStats.downloadTiming = {
        trackSamples: safeTrackSamples,
        averageTrackDurationMs: safeAverageTrackDurationMs,
        queueSamples: safeQueueSamples,
        averageQueueDurationMs: safeAverageQueueDurationMs,
        linkTrackSamples: safeLinkTrackSamples,
        averageLinkTrackDurationMs: safeAverageLinkTrackDurationMs,
        linkQueueSamples: safeLinkQueueSamples,
        averageLinkQueueDurationMs: safeAverageLinkQueueDurationMs,
    };

    return targetStats.downloadTiming;
}

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
        const candidates = files
            .filter(file => file.startsWith('yt-dlp') && file.endsWith('.exe'))
            .map(file => path.join(ytdlpDir, file));

        const withVersion = candidates.map(filePath => {
            let versionDate = null;
            try {
                const versionText = execFileSync(filePath, ['--version'], {
                    encoding: 'utf8',
                    windowsHide: true,
                    maxBuffer: 256 * 1024,
                }).trim();
                const dateMatch = versionText.match(/(\d{4})\.(\d{2})\.(\d{2})/);
                if (dateMatch) {
                    const [, year, month, day] = dateMatch;
                    versionDate = Number.parseInt(`${year}${month}${day}`, 10);
                }
            } catch {
                versionDate = null;
            }

            let mtimeMs = 0;
            try {
                mtimeMs = fs.statSync(filePath).mtimeMs;
            } catch {
                mtimeMs = 0;
            }

            return { filePath, versionDate, mtimeMs };
        });

        withVersion.sort((a, b) => {
            const versionA = a.versionDate ?? -1;
            const versionB = b.versionDate ?? -1;
            if (versionA !== versionB) return versionB - versionA;
            return b.mtimeMs - a.mtimeMs;
        });

        const latestVersion = withVersion[0]?.versionDate ?? null;
        ytdlpExecutables = latestVersion
            ? withVersion.filter(entry => entry.versionDate === latestVersion).map(entry => entry.filePath)
            : withVersion.slice(0, 1).map(entry => entry.filePath);

        if (ytdlpExecutables.length === 0) {
            console.error(`No 'yt-dlp*.exe' executables found in ${ytdlpDir}`);
        } else {
            const selected = ytdlpExecutables[0];
            console.log(`Using ${ytdlpExecutables.length} yt-dlp instance(s), selected baseline: ${path.basename(selected)}`);
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
            if (!Number.isFinite(Number.parseInt(config.silenceTrimThresholdDb, 10))) {
                config.silenceTrimThresholdDb = 35;
            }
            if (!Number.isFinite(Number.parseFloat(config.playerVolume))) {
                config.playerVolume = 1;
            }
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
                hideMixButtons: false,
                visualThemeSync: false,
                skipManualLinkPrompt: false,
                durationToleranceSeconds: 20,
                silenceTrimThresholdDb: 35,
                playerVolume: 1,
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
                downloadTiming: { ...DEFAULT_DOWNLOAD_TIMING_STATS },
            };
            fs.writeFileSync(statsPath, JSON.stringify(stats, null, 4));
        }

        ensureDownloadTimingStatsShape(stats);
    } catch (error) {
        console.error('Failed to load or create stats file:', error);
        stats = {}; // Fallback
        ensureDownloadTimingStatsShape(stats);
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

function copyDirectoryRecursive(sourceDir, destinationDir) {
    if (!fs.existsSync(destinationDir)) {
        fs.mkdirSync(destinationDir, { recursive: true });
    }

    for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
        const sourcePath = path.join(sourceDir, entry.name);
        const destinationPath = path.join(destinationDir, entry.name);

        if (entry.isDirectory()) {
            copyDirectoryRecursive(sourcePath, destinationPath);
        } else {
            fs.copyFileSync(sourcePath, destinationPath);
        }
    }
}

function hasFilesInDirectory(directoryPath) {
    if (!fs.existsSync(directoryPath)) return false;
    const entries = fs.readdirSync(directoryPath, { withFileTypes: true });
    return entries.some(entry => entry.isFile() || entry.isDirectory());
}

function isValidYtdlpPluginDirectory(directoryPath) {
    if (!directoryPath || !fs.existsSync(directoryPath)) return false;
    return fs.existsSync(path.join(directoryPath, 'yt_dlp_plugins'));
}

function resolveYtdlpPluginSourcePath(sourceCandidates) {
    for (const candidate of sourceCandidates) {
        if (!fs.existsSync(candidate)) continue;

        if (isValidYtdlpPluginDirectory(candidate)) {
            return candidate;
        }

        const nestedGetPot = path.join(candidate, 'yt-dlp-get-pot');
        if (isValidYtdlpPluginDirectory(nestedGetPot)) {
            return nestedGetPot;
        }
    }

    return null;
}

function ensureYtdlpGetPotPlugin() {
    try {
        if (cachedYtdlpPluginPath !== undefined) {
            return cachedYtdlpPluginPath;
        }

        if (isValidYtdlpPluginDirectory(ytdlpGetPotPluginDir)) {
            cachedYtdlpPluginPath = ytdlpGetPotPluginDir;
            return cachedYtdlpPluginPath;
        }

        const packagedCandidates = [
            path.join(process.resourcesPath, 'yt-dlp-get-pot'),
            path.join(process.resourcesPath, 'plugins', 'yt-dlp-get-pot'),
            path.join(process.resourcesPath, 'plugins'),
            path.join(process.resourcesPath, 'yt-dlp', 'plugins', 'yt-dlp-get-pot'),
            path.join(process.resourcesPath, 'yt-dlp', 'plugins'),
        ];

        const devCandidates = [
            path.join(__dirname, 'yt-dlp-get-pot'),
            path.join(__dirname, 'plugins', 'yt-dlp-get-pot'),
            path.join(__dirname, 'plugins'),
            path.join(__dirname, 'yt-dlp', 'plugins', 'yt-dlp-get-pot'),
            path.join(__dirname, 'yt-dlp', 'plugins'),
        ];

        const sourceCandidates = isDev ? [...devCandidates, ...packagedCandidates] : [...packagedCandidates, ...devCandidates];
        const pluginSourcePath = resolveYtdlpPluginSourcePath(sourceCandidates);

        if (!pluginSourcePath) {
            if (!hasLoggedMissingYtdlpPlugin) {
                writeLog('warn', 'YTDLPPlugin', 'yt-dlp-get-pot plugin source folder not found in resources', {
                    sourceCandidates,
                    expectedLayout: '.../yt-dlp-get-pot/yt_dlp_plugins/** or .../yt-dlp/plugins/yt_dlp_plugins/**',
                });
                hasLoggedMissingYtdlpPlugin = true;
            }
            cachedYtdlpPluginPath = null;
            return null;
        }

        fs.mkdirSync(userDataPluginRoot, { recursive: true });
        copyDirectoryRecursive(pluginSourcePath, ytdlpGetPotPluginDir);
        if (!isValidYtdlpPluginDirectory(ytdlpGetPotPluginDir)) {
            writeLog('warn', 'YTDLPPlugin', 'Plugin files copied but expected yt_dlp_plugins folder was not found', {
                copiedFrom: pluginSourcePath,
                copiedTo: ytdlpGetPotPluginDir,
            });
            cachedYtdlpPluginPath = null;
            return null;
        }
        writeLog('info', 'YTDLPPlugin', 'yt-dlp-get-pot plugin copied to userData', {
            from: pluginSourcePath,
            to: ytdlpGetPotPluginDir,
        });
        cachedYtdlpPluginPath = ytdlpGetPotPluginDir;
        return cachedYtdlpPluginPath;
    } catch (error) {
        writeLog('error', 'YTDLPPlugin', 'Failed to prepare yt-dlp-get-pot plugin', { error: error.message });
        cachedYtdlpPluginPath = null;
        return null;
    }
}

function getYtdlpPluginFlag() {
    if (cachedYtdlpPluginFlag !== undefined) {
        return cachedYtdlpPluginFlag;
    }

    const ytdlpPath = ytdlpExecutables[0] || getNextYtdlpPath();
    if (!ytdlpPath) {
        cachedYtdlpPluginFlag = null;
        return null;
    }

    try {
        const helpOutput = execFileSync(ytdlpPath, ['--help'], {
            encoding: 'utf8',
            windowsHide: true,
            maxBuffer: 8 * 1024 * 1024,
        });

        if (helpOutput.includes('--plugin-path')) {
            cachedYtdlpPluginFlag = '--plugin-path';
            return cachedYtdlpPluginFlag;
        }

        if (helpOutput.includes('--plugin-dirs')) {
            cachedYtdlpPluginFlag = '--plugin-dirs';
            return cachedYtdlpPluginFlag;
        }

        cachedYtdlpPluginFlag = null;
        return null;
    } catch (error) {
        writeLog('warn', 'YTDLPPlugin', 'Failed to detect yt-dlp plugin CLI option', { error: error.message });
        cachedYtdlpPluginFlag = null;
        return null;
    }
}

function getNodeRuntimePath() {
    if (cachedNodeRuntimePath !== undefined) {
        return cachedNodeRuntimePath;
    }

    const pathEnv = process.env.PATH || process.env.Path || '';
    const pathEntries = pathEnv.split(path.delimiter).map(entry => entry.trim()).filter(Boolean);

    for (const entry of pathEntries) {
        const candidate = path.join(entry, process.platform === 'win32' ? 'node.exe' : 'node');
        if (fs.existsSync(candidate)) {
            cachedNodeRuntimePath = candidate;
            return cachedNodeRuntimePath;
        }
    }

    try {
        const whereOutput = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['node'], {
            encoding: 'utf8',
            windowsHide: true,
            maxBuffer: 1024 * 1024,
        });
        const firstPath = whereOutput
            .split(/\r?\n/)
            .map(line => line.trim())
            .find(Boolean);

        cachedNodeRuntimePath = firstPath || null;
        return cachedNodeRuntimePath;
    } catch {
        cachedNodeRuntimePath = null;
        return null;
    }
}

function getYtdlpCommonArgs() {
    const args = [
        '--no-update',
        '--extractor-args', 'youtube:player-client=android,web',
    ];

    const nodeRuntimePath = getNodeRuntimePath();
    if (nodeRuntimePath) {
        const normalizedNodePath = nodeRuntimePath.replace(/\\/g, '/');
        args.push('--js-runtimes', `node:${normalizedNodePath}`);
    }

    const bgutilScriptPath = path.join(app.getPath('home'), 'bgutil-ytdlp-pot-provider', 'server', 'build', 'generate_once.js');
    if (fs.existsSync(bgutilScriptPath)) {
        const normalizedScriptPath = bgutilScriptPath.replace(/\\/g, '/');
        args.push('--extractor-args', `youtubepot-bgutilscript:script_path=${normalizedScriptPath}`);
    }

    const pluginPath = ensureYtdlpGetPotPlugin();
    if (pluginPath) {
        const pluginFlag = getYtdlpPluginFlag();
        if (pluginFlag) {
            args.push(pluginFlag, pluginPath);
        } else {
            writeLog('warn', 'YTDLPPlugin', 'No supported yt-dlp plugin CLI option detected; plugin path argument skipped');
        }
    }

    return args;
}

function parseYtdlpEtaToMs(etaText) {
    if (!etaText) return null;
    const parts = etaText.trim().split(':').map(part => Number.parseInt(part, 10));
    if (parts.some(Number.isNaN)) return null;

    if (parts.length === 3) {
        const [hours, minutes, seconds] = parts;
        return ((hours * 3600) + (minutes * 60) + seconds) * 1000;
    }
    if (parts.length === 2) {
        const [minutes, seconds] = parts;
        return ((minutes * 60) + seconds) * 1000;
    }
    if (parts.length === 1) {
        return parts[0] * 1000;
    }

    return null;
}

function parseYtdlpProgressLine(line) {
    const progressMatch = line.match(/\[download\]\s+([\d.]+)%/i);
    if (!progressMatch) return null;

    const progress = Number.parseFloat(progressMatch[1]);
    if (!Number.isFinite(progress)) return null;

    const etaMatch = line.match(/ETA\s+([0-9:]+)/i);
    const etaText = etaMatch ? etaMatch[1] : null;
    return {
        progress,
        etaText,
        etaMs: parseYtdlpEtaToMs(etaText),
    };
}

// --- INITIAL SETUP ---
autoUpdater.logger = log;
autoUpdater.logger.transports.file.level = 'info';
log.info('App starting...');
writeLog('info', 'Main', 'App bootstrap started', { isDev, currentLogLevel });

loadConfig();
loadStats();
loadCache();
loadTrackTags();
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
            const trackCandidates = files.filter(file => supportedExtensions.includes(path.extname(file).toLowerCase()));
            const tracks = await Promise.all(trackCandidates.map(async (file) => {
                const ext = path.extname(file).toLowerCase();
                const filePath = path.join(playlistPath, file);
                let duration = 0;

                try {
                    const metadata = await mm.parseFile(filePath, { duration: true, skipCovers: true });
                    if (metadata?.format?.duration && Number.isFinite(metadata.format.duration)) {
                        duration = metadata.format.duration;
                    }
                } catch {
                    duration = 0;
                }

                return {
                    name: path.basename(file, ext),
                    path: filePath,
                    duration,
                    tags: getTrackTagsForPath(filePath),
                };
            }));

            const totalDuration = tracks.reduce((sum, track) => sum + (Number.isFinite(track.duration) ? track.duration : 0), 0);
            return { tracks, totalDuration };
        } catch (err) {
            console.error(`Error loading tracks from "${playlistPath}":`, err);
            return { tracks: [], totalDuration: 0 };
        }
    });

    ipcMain.handle('get-playlist-duration', async (event, playlistPath) => {
        try {
            if (!playlistPath || !fs.existsSync(playlistPath)) return 0;
            const files = await fs.promises.readdir(playlistPath);
            let totalDuration = 0;
            const promises = [];
            for (const file of files) {
                const ext = path.extname(file).toLowerCase();
                if (supportedExtensions.includes(ext)) {
                    const filePath = path.join(playlistPath, file);
                    promises.push(
                        mm.parseFile(filePath, { duration: true, skipCovers: true })
                            .then(metadata => {
                                if (metadata.format && metadata.format.duration) {
                                    totalDuration += metadata.format.duration;
                                }
                            })
                            .catch(() => {})
                    );
                }
            }
            await Promise.all(promises);
            return totalDuration;
        } catch (err) {
            console.error(`Error calculating duration for "${playlistPath}":`, err);
            return 0;
        }
    });

    ipcMain.handle('get-playlist-details', async (_event, playlistPath) => {
        try {
            if (!playlistPath || !fs.existsSync(playlistPath)) {
                return { success: false, error: 'Playlist folder does not exist.' };
            }

            const playlistStat = await fs.promises.stat(playlistPath);
            const files = await fs.promises.readdir(playlistPath);
            const trackCandidates = files.filter(file => supportedExtensions.includes(path.extname(file).toLowerCase()));

            let totalDurationSeconds = 0;
            let totalSizeBytes = 0;

            await Promise.all(trackCandidates.map(async (file) => {
                const filePath = path.join(playlistPath, file);

                try {
                    const stat = await fs.promises.stat(filePath);
                    totalSizeBytes += Number.isFinite(stat.size) ? stat.size : 0;
                } catch {
                    // noop
                }

                try {
                    const metadata = await mm.parseFile(filePath, { duration: true, skipCovers: true });
                    if (metadata?.format?.duration && Number.isFinite(metadata.format.duration)) {
                        totalDurationSeconds += metadata.format.duration;
                    }
                } catch {
                    // noop
                }
            }));

            return {
                success: true,
                details: {
                    name: path.basename(playlistPath),
                    path: playlistPath,
                    trackCount: trackCandidates.length,
                    totalDurationSeconds,
                    totalSizeBytes,
                    totalSizeFormatted: formatBytes(totalSizeBytes),
                    createdAt: playlistStat.birthtime?.toISOString?.() || null,
                    modifiedAt: playlistStat.mtime?.toISOString?.() || null,
                },
            };
        } catch (error) {
            return { success: false, error: error.message };
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

    ipcMain.on('manual-link-response', (_event, payload = {}) => {
        const requestId = Number.parseInt(payload.requestId, 10);
        if (!Number.isFinite(requestId)) return;

        const pending = pendingManualLinkRequests.get(requestId);
        if (!pending) return;

        pendingManualLinkRequests.delete(requestId);
        const manualLink = typeof payload.link === 'string' ? payload.link.trim() : '';
        pending.resolve({
            cancelled: Boolean(payload.cancelled),
            link: manualLink,
        });
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
            downloadTiming: { ...DEFAULT_DOWNLOAD_TIMING_STATS },
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
            hideMixButtons: false,
            visualThemeSync: false,
            skipManualLinkPrompt: false,
            durationToleranceSeconds: 20,
            silenceTrimThresholdDb: 35,
            playerVolume: 1,
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

    ipcMain.handle('open-track-file', async (_event, filePath) => {
        try {
            if (!filePath || !fs.existsSync(filePath)) {
                return { success: false, error: 'File does not exist.' };
            }
            const errorMessage = await shell.openPath(filePath);
            if (errorMessage) {
                return { success: false, error: errorMessage };
            }
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('get-track-tags', async (_event, filePath) => {
        return { success: true, tags: getTrackTagsForPath(filePath) };
    });

    ipcMain.handle('add-track-tag', async (_event, { filePath, tag }) => {
        try {
            if (!filePath || typeof filePath !== 'string') {
                return { success: false, error: 'Invalid track path.' };
            }

            const normalizedTag = typeof tag === 'string' ? tag.trim() : '';
            if (!normalizedTag) {
                return { success: false, error: 'Tag cannot be empty.' };
            }

            const existing = getTrackTagsForPath(filePath);
            existing.push(normalizedTag);
            setTrackTagsForPath(filePath, existing);
            saveTrackTags();

            return { success: true, tags: getTrackTagsForPath(filePath) };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('get-track-details', async (_event, filePath) => {
        try {
            if (!filePath || !fs.existsSync(filePath)) {
                return { success: false, error: 'Track file does not exist.' };
            }

            const fileStat = await fs.promises.stat(filePath);
            let metadata = null;
            try {
                metadata = await mm.parseFile(filePath, { duration: true, skipCovers: true });
            } catch {
                metadata = null;
            }

            const bitrate = metadata?.format?.bitrate;
            const details = {
                path: filePath,
                fileName: path.basename(filePath),
                title: path.parse(filePath).name,
                extension: path.extname(filePath).replace('.', '').toLowerCase(),
                directory: path.dirname(filePath),
                playlistName: path.basename(path.dirname(filePath)),
                sizeBytes: fileStat.size,
                sizeFormatted: formatBytes(fileStat.size),
                dateDownloaded: (fileStat.birthtime || fileStat.ctime || fileStat.mtime)?.toISOString?.() || null,
                modifiedAt: fileStat.mtime?.toISOString?.() || null,
                durationSeconds: Number.isFinite(metadata?.format?.duration) ? metadata.format.duration : null,
                bitrateKbps: Number.isFinite(bitrate) ? Math.round(bitrate / 1000) : null,
                source: inferTrackSource(filePath, metadata),
                tags: getTrackTagsForPath(filePath),
            };

            return { success: true, details };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('update-ytdlp', async () => {
        const candidates = fs.existsSync(ytdlpDir)
            ? fs.readdirSync(ytdlpDir)
                .filter(file => file.startsWith('yt-dlp') && file.endsWith('.exe'))
                .map(file => path.join(ytdlpDir, file))
            : [];

        if (candidates.length === 0) {
            return 'Error: yt-dlp executable not found.';
        }

        const summary = [];
        for (const executablePath of candidates) {
            const result = await new Promise((resolve) => {
                const proc = spawn(executablePath, ['-U']);
                let output = '';
                proc.stdout.on('data', (data) => output += data.toString());
                proc.stderr.on('data', (data) => output += data.toString());
                proc.on('close', (code) => {
                    const name = path.basename(executablePath);
                    if (code === 0) {
                        if (output.includes('Updated yt-dlp to')) {
                            resolve(`${name}: updated`);
                        } else if (output.includes('is up to date')) {
                            resolve(`${name}: up to date`);
                        } else {
                            resolve(`${name}: update check completed`);
                        }
                    } else {
                        resolve(`${name}: failed (exit ${code})`);
                    }
                });
                proc.on('error', (err) => {
                    resolve(`${path.basename(executablePath)}: failed (${err.message})`);
                });
            });
            summary.push(result);
        }

        findYtdlpExecutables();
        return summary.join('\n');
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

    ipcMain.handle('start-trim-library-silence', async (_event, options = {}) => {
        try {
            if (activeSilenceTrimJobs.size > 0) {
                return { success: false, error: 'A silence trim task is already running.' };
            }

            const playlistsPath = config.playlistsFolderPath;
            if (!playlistsPath || !fs.existsSync(playlistsPath)) {
                return { success: false, error: 'Playlists folder is not set or does not exist.' };
            }

            const thresholdRaw = Number.parseInt(options.thresholdDb, 10);
            const fallbackThreshold = Number.parseInt(config.silenceTrimThresholdDb, 10);
            const thresholdDb = Number.isFinite(thresholdRaw)
                ? Math.min(80, Math.max(10, thresholdRaw))
                : (Number.isFinite(fallbackThreshold) ? Math.min(80, Math.max(10, fallbackThreshold)) : 35);

            const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
            activeSilenceTrimJobs.set(jobId, {
                startedAt: Date.now(),
                thresholdDb,
            });

            setTimeout(async () => {
                const sendProgress = (payload) => {
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('trim-library-silence-progress', { jobId, ...payload });
                    }
                };

                try {
                    const playlistFolders = await fs.promises.readdir(playlistsPath, { withFileTypes: true });
                    const directories = playlistFolders.filter(entry => entry.isDirectory());
                    const trackPaths = [];

                    for (const folder of directories) {
                        const playlistFolderPath = path.join(playlistsPath, folder.name);
                        const files = await fs.promises.readdir(playlistFolderPath);
                        for (const file of files) {
                            if (supportedExtensions.includes(path.extname(file).toLowerCase())) {
                                trackPaths.push(path.join(playlistFolderPath, file));
                            }
                        }
                    }

                    const totalCount = trackPaths.length;
                    const backups = [];
                    const failures = [];
                    let processedCount = 0;

                    sendProgress({
                        status: 'started',
                        thresholdDb,
                        totalCount,
                    });

                    for (const trackPath of trackPaths) {
                        try {
                            const trimResult = await trimTrackSilenceInPlace(trackPath, thresholdDb);
                            if (trimResult.modified && trimResult.backup) {
                                backups.push(trimResult.backup);
                            }
                        } catch (error) {
                            failures.push({ path: trackPath, error: error.message });
                        }

                        processedCount += 1;
                        if (processedCount === totalCount || processedCount === 1 || processedCount % 10 === 0) {
                            sendProgress({
                                status: 'progress',
                                processedCount,
                                totalCount,
                                modifiedCount: backups.length,
                                failedCount: failures.length,
                            });
                        }
                    }

                    let undoAction = null;
                    if (backups.length > 0) {
                        const manifestId = await saveTrimUndoManifest(backups);
                        undoAction = {
                            type: 'trim-library-silence-batch',
                            payload: { manifestId },
                        };
                    }

                    sendProgress({
                        status: 'completed',
                        scannedCount: totalCount,
                        modifiedCount: backups.length,
                        failedCount: failures.length,
                        failures,
                        undoAction,
                    });
                } catch (error) {
                    console.error('Failed to trim library silence in background:', error);
                    sendProgress({
                        status: 'error',
                        error: error.message,
                    });
                } finally {
                    activeSilenceTrimJobs.delete(jobId);
                }
            }, 0);

            return { success: true, started: true, jobId, thresholdDb };
        } catch (error) {
            console.error('Failed to start background trim task:', error);
            return { success: false, error: error.message };
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
            const moved = await moveToUndoTrash(filePath);
            return {
                success: true,
                undoAction: {
                    type: 'delete-track',
                    payload: moved,
                },
            };
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
            moveTrackTagsPath(sourcePath, destinationPath);
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
            const moved = await moveToUndoTrash(playlistPath);
            return {
                success: true,
                undoAction: {
                    type: 'delete-playlist',
                    payload: moved,
                },
            };
        } catch (error) {
            console.error(`Failed to delete playlist: ${playlistPath}`, error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('undo-action', async (event, action) => {
        try {
            if (!action || !action.type) {
                return { success: false, error: 'Invalid undo action payload.' };
            }

            const payload = action.payload || {};

            if (action.type === 'delete-track' || action.type === 'delete-playlist') {
                return await restoreFromUndoTrash(payload.trashPath, payload.originalPath);
            }

            if (action.type === 'rename-playlist') {
                const currentPath = payload.currentPath;
                const previousName = sanitizeFilename(payload.previousName || '');

                if (!currentPath || !fs.existsSync(currentPath)) {
                    return { success: false, error: 'Current playlist path no longer exists.' };
                }
                if (!previousName) {
                    return { success: false, error: 'Invalid previous playlist name for undo.' };
                }

                const targetPath = path.join(path.dirname(currentPath), previousName);
                if (fs.existsSync(targetPath)) {
                    return { success: false, error: 'Cannot undo rename because the original name already exists.' };
                }

                await fs.promises.rename(currentPath, targetPath);
                return { success: true, restoredPath: targetPath };
            }

            if (action.type === 'rename-track') {
                const currentPath = payload.currentPath;
                const previousNameRaw = payload.previousName || '';
                const previousName = sanitizeFilename(path.parse(previousNameRaw).name || previousNameRaw);

                if (!currentPath || !fs.existsSync(currentPath)) {
                    return { success: false, error: 'Current track path no longer exists.' };
                }
                if (!previousName) {
                    return { success: false, error: 'Invalid previous track name for undo.' };
                }

                const extension = path.extname(currentPath);
                const targetPath = path.join(path.dirname(currentPath), `${previousName}${extension}`);
                if (fs.existsSync(targetPath)) {
                    return { success: false, error: 'Cannot undo rename because the original track name already exists.' };
                }

                await fs.promises.rename(currentPath, targetPath);
                moveTrackTagsPath(currentPath, targetPath);
                return { success: true, restoredPath: targetPath };
            }

            if (action.type === 'trim-library-silence-batch') {
                const manifestId = payload.manifestId;
                const manifestData = await readTrimUndoManifest(manifestId);
                if (!manifestData || !Array.isArray(manifestData.items) || manifestData.items.length === 0) {
                    return { success: false, error: 'Undo manifest for silence trim is missing or empty.' };
                }

                const failedItems = [];
                let restoredCount = 0;

                for (const item of manifestData.items) {
                    try {
                        if (item.originalPath && fs.existsSync(item.originalPath)) {
                            await moveToUndoTrash(item.originalPath);
                        }
                        const restored = await restoreFromUndoTrash(item.trashPath, item.originalPath);
                        if (!restored.success) {
                            failedItems.push(item);
                            continue;
                        }
                        restoredCount += 1;
                    } catch {
                        failedItems.push(item);
                    }
                }

                if (failedItems.length > 0) {
                    await writeTrimUndoManifest(manifestId, { createdAt: manifestData.createdAt, items: failedItems });
                    return {
                        success: restoredCount > 0,
                        restoredCount,
                        error: restoredCount > 0
                            ? `Restored ${restoredCount} track(s), but ${failedItems.length} could not be restored.`
                            : `Unable to restore ${failedItems.length} track(s).`,
                    };
                }

                await deleteTrimUndoManifest(manifestId);
                return { success: true, restoredCount };
            }

            return { success: false, error: `Unsupported undo action type: ${action.type}` };
        } catch (error) {
            console.error('Failed to undo action', { action, error });
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
            moveTrackTagsPath(oldPath, newPath);
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

        const pluginPath = ensureYtdlpGetPotPlugin();
        if (pluginPath) {
            mainWindow.webContents.send('update-status', `yt-dlp plugin ready: ${pluginPath}`);
        } else {
            mainWindow.webContents.send('update-status', 'Warning: yt-dlp-get-pot plugin not found in resources; continuing without plugin override.');
        }

        stats.downloadsInitiated = (stats.downloadsInitiated || 0) + 1;
        lastDownloadedFiles = [];
        lastPlaylistName = null;
        isDownloadCancelled = false;
        mainWindow.webContents.send('update-status', 'Starting download process...');

        try {
            await refreshSpotifyToken();
            const configuredThreads = Number.parseInt(config.downloadThreads, 10);
            const requestedThreads = Number.isFinite(configuredThreads) && configuredThreads > 0 ? configuredThreads : 3;
            const concurrency = Math.max(1, Math.min(requestedThreads, ytdlpExecutables.length));
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
                            itemsToProcess.push({
                                type: 'search',
                                query: `${track.name} ${track.artist}`,
                                name: track.name,
                                metadata: track.metadata,
                                durationMs: track.durationMs,
                                index: trackIndex++,
                            });
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

            const downloadTimingStats = ensureDownloadTimingStatsShape(stats);

            const blendEstimates = (firstMs, secondMs) => {
                if (Number.isFinite(firstMs) && firstMs >= 0 && Number.isFinite(secondMs) && secondMs >= 0) {
                    return (firstMs + secondMs) / 2;
                }
                if (Number.isFinite(firstMs) && firstMs >= 0) return firstMs;
                if (Number.isFinite(secondMs) && secondMs >= 0) return secondMs;
                return null;
            };

            const pushTimingSample = (sampleMs, sampleCountKey, averageKey) => {
                if (!Number.isFinite(sampleMs) || sampleMs <= 0) return;

                const currentSampleCount = downloadTimingStats[sampleCountKey];
                const nextSampleCount = currentSampleCount + 1;
                downloadTimingStats[averageKey] = currentSampleCount === 0
                    ? sampleMs
                    : ((downloadTimingStats[averageKey] * currentSampleCount) + sampleMs) / nextSampleCount;
                downloadTimingStats[sampleCountKey] = nextSampleCount;
            };

            const estimatePhaseRemainingMs = ({
                progressValues,
                totalCount,
                averageTrackDurationMs,
                trackSamples,
                averageQueueDurationMs,
                queueSamples,
                activeTrackEstimates = [],
            }) => {
                const safeTotalCount = Number.isFinite(totalCount) && totalCount > 0 ? totalCount : 0;
                if (safeTotalCount === 0) return 0;

                const progressSum = progressValues.reduce((sum, value) => sum + value, 0);
                const progressFraction = progressSum / (safeTotalCount * 100);
                const remainingTrackUnits = progressValues.reduce((sum, value) => sum + (Math.max(0, 100 - value) / 100), 0);

                let effectiveTrackDurationMs = null;
                if (averageTrackDurationMs > 0 && trackSamples > 0) {
                    effectiveTrackDurationMs = averageTrackDurationMs;
                } else {
                    const inFlightEstimates = activeTrackEstimates.filter(value => Number.isFinite(value) && value > 0);
                    if (inFlightEstimates.length > 0) {
                        effectiveTrackDurationMs = inFlightEstimates.reduce((sum, value) => sum + value, 0) / inFlightEstimates.length;
                    }
                }

                const trackBasedEtaMs = effectiveTrackDurationMs !== null
                    ? remainingTrackUnits * effectiveTrackDurationMs
                    : null;

                const queueBasedEtaMs = (averageQueueDurationMs > 0 && queueSamples > 0)
                    ? averageQueueDurationMs * Math.max(0, 1 - progressFraction)
                    : null;

                return blendEstimates(trackBasedEtaMs, queueBasedEtaMs);
            };

            const estimateFullPhaseFromAverages = ({
                itemCount,
                averageTrackDurationMs,
                trackSamples,
                averageQueueDurationMs,
                queueSamples,
            }) => {
                const safeItemCount = Number.isFinite(itemCount) && itemCount > 0 ? itemCount : 0;
                if (safeItemCount === 0) return 0;

                const trackBasedMs = (averageTrackDurationMs > 0 && trackSamples > 0)
                    ? safeItemCount * averageTrackDurationMs
                    : null;
                const queueBasedMs = (averageQueueDurationMs > 0 && queueSamples > 0)
                    ? averageQueueDurationMs
                    : null;

                return blendEstimates(trackBasedMs, queueBasedMs);
            };
            
            const linkFindingQueue = [...itemsToProcess];
            const itemsToDownload = [];
            const linkProgress = new Array(totalItems).fill(0);
            const activeLinkTimingEstimates = new Array(totalItems).fill(null);
            const linkTrackStartTimes = new Map();
            const linkQueueStartTimeMs = Date.now();

            const updateOverallProgressDuringLinkFinding = () => {
                const safeTotalItems = totalItems > 0 ? totalItems : 1;
                const linkPhaseProgressPercent = linkProgress.reduce((sum, value) => sum + value, 0) / safeTotalItems;
                const overallProgressPercent = Math.min(100, linkPhaseProgressPercent * 0.5);

                const linkRemainingMs = estimatePhaseRemainingMs({
                    progressValues: linkProgress,
                    totalCount: totalItems,
                    averageTrackDurationMs: downloadTimingStats.averageLinkTrackDurationMs,
                    trackSamples: downloadTimingStats.linkTrackSamples,
                    averageQueueDurationMs: downloadTimingStats.averageLinkQueueDurationMs,
                    queueSamples: downloadTimingStats.linkQueueSamples,
                    activeTrackEstimates: activeLinkTimingEstimates,
                });

                const fullDownloadEstimateMs = estimateFullPhaseFromAverages({
                    itemCount: totalItems,
                    averageTrackDurationMs: downloadTimingStats.averageTrackDurationMs,
                    trackSamples: downloadTimingStats.trackSamples,
                    averageQueueDurationMs: downloadTimingStats.averageQueueDurationMs,
                    queueSamples: downloadTimingStats.queueSamples,
                });

                const totalEtaMs = [linkRemainingMs, fullDownloadEstimateMs]
                    .filter(value => Number.isFinite(value) && value >= 0)
                    .reduce((sum, value) => sum + value, 0);
                const hasEta = Number.isFinite(totalEtaMs) && totalEtaMs > 0;

                mainWindow.webContents.send('download-progress', {
                    progress: overallProgressPercent,
                    eta: hasEta ? formatEta(totalEtaMs) : 'calculating...',
                });
            };

            updateOverallProgressDuringLinkFinding();

            const linkFinderWorker = async () => {
                while (linkFindingQueue.length > 0) {
                    if (isDownloadCancelled) return;
                    const item = linkFindingQueue.shift();
                    if (!item) continue;

                    const startedAt = Date.now();
                    linkTrackStartTimes.set(item.index, startedAt);

                    try {
                        let youtubeLink;
                        let trackName;
                        if (item.type === 'search') {
                            const resolved = await resolveTrackLink(item.query, item.name, item.durationMs);
                            youtubeLink = resolved.link;
                            trackName = item.name;
                            mainWindow.webContents.send('update-status', `🔗 (${item.index + 1}/${totalItems}) Found ${resolved.source} link for: ${trackName}`);
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
                    } finally {
                        if (!isDownloadCancelled) {
                            const elapsedMs = Date.now() - startedAt;
                            pushTimingSample(elapsedMs, 'linkTrackSamples', 'averageLinkTrackDurationMs');
                            activeLinkTimingEstimates[item.index] = null;
                            linkTrackStartTimes.delete(item.index);
                            linkProgress[item.index] = 100;
                            updateOverallProgressDuringLinkFinding();
                        }
                    }
                }
            };
            await Promise.all(Array.from({ length: concurrency }, linkFinderWorker));

            if (isDownloadCancelled) return;

            if (totalItems > 0) {
                pushTimingSample(Date.now() - linkQueueStartTimeMs, 'linkQueueSamples', 'averageLinkQueueDurationMs');
            }
            
            const totalItemsToDownload = itemsToDownload.length;
            if (totalItemsToDownload === 0) {
                mainWindow.webContents.send('download-progress', { progress: 100, eta: 'less than a second remaining' });
                mainWindow.webContents.send('update-status', 'No valid tracks found to download.', true, { success: true, filesDownloaded: 0 });
                return;
            }

            mainWindow.webContents.send('update-status', `Phase 2/2: Downloading ${totalItemsToDownload} tracks...`);

            const fileProgress = new Array(totalItemsToDownload).fill(0);
            const activeTrackTimingEstimates = new Array(totalItemsToDownload).fill(null);
            const trackStartTimes = new Map();
            const queueStartTimeMs = Date.now();

            const updateOverallProgress = () => {
                const downloadPhaseProgressPercent = totalItemsToDownload > 0
                    ? fileProgress.reduce((sum, value) => sum + value, 0) / totalItemsToDownload
                    : 100;
                const totalProgress = 50 + (downloadPhaseProgressPercent * 0.5);

                const smartEtaMs = estimatePhaseRemainingMs({
                    progressValues: fileProgress,
                    totalCount: totalItemsToDownload,
                    averageTrackDurationMs: downloadTimingStats.averageTrackDurationMs,
                    trackSamples: downloadTimingStats.trackSamples,
                    averageQueueDurationMs: downloadTimingStats.averageQueueDurationMs,
                    queueSamples: downloadTimingStats.queueSamples,
                    activeTrackEstimates: activeTrackTimingEstimates,
                });
                const etaString = smartEtaMs !== null ? formatEta(smartEtaMs) : 'calculating...';

                mainWindow.webContents.send('download-progress', { progress: totalProgress, eta: etaString });
            };

            updateOverallProgress();

            const downloadQueue = [...itemsToDownload.sort((a, b) => a.index - b.index).map((item, idx) => ({ ...item, queueIndex: idx }))];

            const downloadWorker = async () => {
                while (downloadQueue.length > 0) {
                    if (isDownloadCancelled) return;
                    const item = downloadQueue.shift();
                    if (!item) continue;
                    try {
                        const startedAt = Date.now();
                        trackStartTimes.set(item.queueIndex, startedAt);

                        const filePath = await downloadItem(item, item.index, totalItems, (progress) => {
                            fileProgress[item.queueIndex] = progress;
                            const elapsedMs = Date.now() - startedAt;
                            if (progress > 0) {
                                activeTrackTimingEstimates[item.queueIndex] = elapsedMs / (progress / 100);
                            }
                            updateOverallProgress();
                        });

                        const finishedAt = Date.now();
                        const startTime = trackStartTimes.get(item.queueIndex);
                        if (Number.isFinite(startTime)) {
                            pushTimingSample(finishedAt - startTime, 'trackSamples', 'averageTrackDurationMs');
                        }
                        trackStartTimes.delete(item.queueIndex);
                        activeTrackTimingEstimates[item.queueIndex] = null;
                        fileProgress[item.queueIndex] = 100;
                        updateOverallProgress();
                        lastDownloadedFiles.push(filePath);
                        stats.totalSongsDownloaded = (stats.totalSongsDownloaded || 0) + 1;
                    } catch (error) {
                        trackStartTimes.delete(item.queueIndex);
                        activeTrackTimingEstimates[item.queueIndex] = null;
                        fileProgress[item.queueIndex] = 100;
                        updateOverallProgress();

                        if (!isDownloadCancelled) {
                            console.error(`Download worker failed:`, error.message);
                            stats.songsFailed = (stats.songsFailed || 0) + 1;
                        }
                    }
                }
            };
            await Promise.all(Array.from({ length: concurrency }, downloadWorker));

            if (!isDownloadCancelled) {
                if (totalItemsToDownload > 0) {
                    pushTimingSample(Date.now() - queueStartTimeMs, 'queueSamples', 'averageQueueDurationMs');
                }
                mainWindow.webContents.send('download-progress', { progress: 100, eta: 'less than a second remaining' });
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
                            durationMs: track.duration_ms,
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
                        durationMs: track.duration_ms,
                    })));
                    offset += 50;
                }
            } else if (type === 'track') {
                const data = await spotifyApi.getTrack(id);
                const track = data.body;
                tracks.push({
                    name: track.name,
                    artist: track.artists.map(a => a.name).join(', '),
                    durationMs: track.duration_ms,
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
            const proc = spawn(ytdlpPath, [...getYtdlpCommonArgs(), ...args]);
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

    function getDurationToleranceMs() {
        const configured = Number.parseInt(config.durationToleranceSeconds, 10);
        const safeSeconds = Number.isFinite(configured) && configured >= 0 ? configured : 20;
        return safeSeconds * 1000;
    }

    function parseSearchCandidates(rawOutput) {
        return rawOutput
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(Boolean)
            .map(line => {
                const [url = '', durationText = ''] = line.split('\t');
                const parsedDurationSec = Number.parseFloat(durationText);
                return {
                    url: url.trim(),
                    durationMs: Number.isFinite(parsedDurationSec) ? Math.round(parsedDurationSec * 1000) : null,
                };
            })
            .filter(candidate => candidate.url);
    }

    function isDurationMatch(candidateDurationMs, expectedDurationMs) {
        if (!Number.isFinite(expectedDurationMs) || expectedDurationMs <= 0) {
            return true;
        }
        if (!Number.isFinite(candidateDurationMs) || candidateDurationMs <= 0) {
            return false;
        }

        return Math.abs(candidateDurationMs - expectedDurationMs) <= getDurationToleranceMs();
    }

    async function searchCandidates(providerPrefix, query, expectedDurationMs, maxResults = 5) {
        const rawOutput = await runYtdlp([
            '--flat-playlist',
            '--print', '%(webpage_url)s\t%(duration)s',
            `${providerPrefix}${maxResults}:${query}`,
        ]);

        const candidates = parseSearchCandidates(rawOutput);
        return candidates.find(candidate => isDurationMatch(candidate.durationMs, expectedDurationMs)) || null;
    }

    async function requestManualLink(trackName, query) {
        if (config.skipManualLinkPrompt) {
            return null;
        }

        if (!mainWindow || mainWindow.isDestroyed()) {
            return null;
        }

        return new Promise((resolve) => {
            const requestId = ++manualLinkRequestCounter;
            const timeoutHandle = setTimeout(() => {
                pendingManualLinkRequests.delete(requestId);
                resolve(null);
            }, 2 * 60 * 1000);

            pendingManualLinkRequests.set(requestId, {
                resolve: (response) => {
                    clearTimeout(timeoutHandle);
                    if (response?.cancelled) {
                        resolve(null);
                        return;
                    }
                    const manualLink = typeof response?.link === 'string' ? response.link.trim() : '';
                    resolve(manualLink || null);
                },
            });

            mainWindow.webContents.send('manual-link-request', {
                requestId,
                trackName,
                query,
            });
        });
    }

    async function resolveTrackLink(query, trackName, expectedDurationMs) {
        const youtubeMatch = await searchCandidates('ytsearch', query, expectedDurationMs);
        if (youtubeMatch) {
            return { link: youtubeMatch.url, source: 'youtube' };
        }

        mainWindow.webContents.send('update-status', `⚠️ No duration-matching YouTube result for: ${trackName}. Trying SoundCloud...`);
        const soundCloudMatch = await searchCandidates('scsearch', query, expectedDurationMs);
        if (soundCloudMatch) {
            return { link: soundCloudMatch.url, source: 'soundcloud' };
        }

        mainWindow.webContents.send('update-status', `⚠️ No duration-matching SoundCloud result for: ${trackName}.`);
        const manualLink = await requestManualLink(trackName, query);
        if (manualLink) {
            return { link: manualLink, source: 'manual' };
        }

        throw new Error('No matching result found in YouTube/SoundCloud and no manual link provided.');
    }

    async function getYouTubeLink(query) {
        if (linkCache[query]) {
            mainWindow.webContents.send('update-status', `[Cache] Found link for: ${query}`);
            return linkCache[query];
        }

        let videoId = '';
        try {
            const searchOutput = await runYtdlp(['--flat-playlist', '--playlist-items', '1', '--print', 'id', `ytsearch1:${query}`]);
            videoId = searchOutput
                .split(/\r?\n/)
                .map(line => line.trim())
                .find(Boolean) || '';
        } catch (flatSearchError) {
            const fallbackOutput = await runYtdlp(['--get-id', `ytsearch1:${query}`]);
            videoId = fallbackOutput
                .split(/\r?\n/)
                .map(line => line.trim())
                .find(Boolean) || '';
        }

        if (!videoId) throw new Error('No video found for query.');
        const youtubeLink = `https://www.youtube.com/watch?v=${videoId}`;
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
            const proc = spawn(ytdlpPath, [...getYtdlpCommonArgs(), ...args]);
            activeProcesses.add(proc);
            let finalPath = '';
            let stdoutBuffer = '';
            let stderrBuffer = '';

            const stripAnsi = (text) => text.replace(/\u001b\[[0-9;]*m/g, '');

            const parseDestinationFromLine = (line) => {
                const extractAudioDestinationMatch = line.match(/\[ExtractAudio\]\s+Destination:\s+(.*)/i);
                if (extractAudioDestinationMatch) return extractAudioDestinationMatch[1];

                const downloadDestinationMatch = line.match(/\[download\]\s+Destination:\s+(.*)/i);
                if (downloadDestinationMatch) return downloadDestinationMatch[1];

                const mergedDestinationMatch = line.match(/\[Merger\]\s+Merging formats into\s+"?(.+?)"?$/i);
                if (mergedDestinationMatch) return mergedDestinationMatch[1];

                const noConvertMatch = line.match(/\[ExtractAudio\]\s+Not converting audio\s+(.*?);\s+file is already in target format/i);
                if (noConvertMatch) return noConvertMatch[1];

                return null;
            };

            const processOutputLine = (line) => {
                const cleanLine = stripAnsi((line || '').trim());
                if (!cleanLine) return;

                const progressData = parseYtdlpProgressLine(cleanLine);
                if (progressData && onProgress) {
                    onProgress(progressData.progress, progressData.etaMs);
                }

                const parsedDestination = parseDestinationFromLine(cleanLine);
                if (parsedDestination) {
                    finalPath = parsedDestination.trim().replace(/^"|"$/g, '');
                }
            };

            const findFallbackDownloadedPath = () => {
                const expectedWithConfiguredExt = path.join(downloadsDir, `${numberPrefix} - ${sanitizedTrackName}.${audioFormat}`);
                if (fs.existsSync(expectedWithConfiguredExt)) {
                    return expectedWithConfiguredExt;
                }

                try {
                    const expectedPrefix = `${numberPrefix} - ${sanitizedTrackName}.`;
                    const matchedFile = fs.readdirSync(downloadsDir)
                        .find(fileName => fileName.startsWith(expectedPrefix));
                    if (matchedFile) {
                        return path.join(downloadsDir, matchedFile);
                    }
                } catch {
                    return '';
                }

                return '';
            };

            proc.stdout.on('data', (data) => {
                stdoutBuffer += data.toString();
                const lines = stdoutBuffer.split(/\r?\n|\r/g);
                stdoutBuffer = lines.pop() || '';

                for (const line of lines) {
                    processOutputLine(line);
                }
            });
            proc.stderr.on('data', (data) => {
                stderrBuffer += data.toString();
                const lines = stderrBuffer.split(/\r?\n|\r/g);
                stderrBuffer = lines.pop() || '';

                for (const line of lines) {
                    processOutputLine(line);
                }
            });
            proc.on('close', async (code) => {
                activeProcesses.delete(proc);
                if (isDownloadCancelled) return reject(new Error('Download cancelled'));

                if (stdoutBuffer) {
                    processOutputLine(stdoutBuffer);
                }
                if (stderrBuffer) {
                    processOutputLine(stderrBuffer);
                }

                if (code === 0 && !finalPath) {
                    finalPath = findFallbackDownloadedPath();
                }

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

async function ensureUndoTrashExists() {
    await fs.promises.mkdir(undoTrashPath, { recursive: true });
}

function getMediaToolPath(toolName) {
    const executableName = process.platform === 'win32' ? `${toolName}.exe` : toolName;
    const bundledPath = path.join(ytdlpDir, executableName);
    if (fs.existsSync(bundledPath)) {
        return bundledPath;
    }
    return executableName;
}

function runMediaTool(executablePath, args, { stdinNull = false } = {}) {
    return new Promise((resolve, reject) => {
        const proc = spawn(executablePath, args, {
            windowsHide: true,
            stdio: stdinNull ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data) => {
            stdout += data.toString();
        });
        proc.stderr.on('data', (data) => {
            stderr += data.toString();
        });
        proc.on('error', reject);
        proc.on('close', (code) => {
            resolve({ code, stdout, stderr });
        });
    });
}

async function getTrackDurationSeconds(filePath) {
    const ffprobePath = getMediaToolPath('ffprobe');
    const args = [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        filePath,
    ];
    const result = await runMediaTool(ffprobePath, args, { stdinNull: true });
    if (result.code !== 0) {
        throw new Error(`ffprobe failed (${result.code}): ${result.stderr.trim() || 'unknown error'}`);
    }
    const duration = Number.parseFloat((result.stdout || '').trim());
    if (!Number.isFinite(duration) || duration <= 0) {
        throw new Error('Unable to determine track duration.');
    }
    return duration;
}

function parseSilenceIntervals(ffmpegOutput, totalDurationSeconds) {
    const lines = ffmpegOutput.split(/\r?\n/);
    const intervals = [];
    let currentStart = null;

    for (const rawLine of lines) {
        const line = rawLine.trim();
        const startMatch = line.match(/silence_start:\s*([0-9.]+)/i);
        if (startMatch) {
            const parsedStart = Number.parseFloat(startMatch[1]);
            if (Number.isFinite(parsedStart)) {
                currentStart = parsedStart;
            }
            continue;
        }

        const endMatch = line.match(/silence_end:\s*([0-9.]+)/i);
        if (endMatch) {
            const parsedEnd = Number.parseFloat(endMatch[1]);
            if (!Number.isFinite(parsedEnd)) continue;

            const intervalStart = Number.isFinite(currentStart) ? currentStart : 0;
            intervals.push({
                start: Math.max(0, intervalStart),
                end: Math.max(0, parsedEnd),
            });
            currentStart = null;
        }
    }

    if (Number.isFinite(currentStart)) {
        intervals.push({ start: Math.max(0, currentStart), end: totalDurationSeconds });
    }

    return intervals;
}

async function detectLeadingTrailingSilence(filePath, thresholdDb, minimumSilenceSeconds = 0.2) {
    const ffmpegPath = getMediaToolPath('ffmpeg');
    const duration = await getTrackDurationSeconds(filePath);
    const safeThreshold = Math.min(80, Math.max(10, thresholdDb));
    const args = [
        '-hide_banner',
        '-i', filePath,
        '-af', `silencedetect=noise=-${safeThreshold}dB:d=${minimumSilenceSeconds}`,
        '-f', 'null',
        '-',
    ];

    const probe = await runMediaTool(ffmpegPath, args, { stdinNull: true });
    if (probe.code !== 0) {
        throw new Error(`ffmpeg silence scan failed (${probe.code}).`);
    }

    const intervals = parseSilenceIntervals(probe.stderr || '', duration);
    const epsilon = 0.05;

    let trimStartTo = 0;
    const leading = intervals.find(interval => interval.start <= epsilon && interval.end > interval.start);
    if (leading) {
        trimStartTo = Math.min(duration, Math.max(0, leading.end));
    }

    let trimEndFrom = duration;
    const trailing = [...intervals].reverse().find(interval => interval.end >= (duration - epsilon) && interval.end > interval.start);
    if (trailing) {
        trimEndFrom = Math.min(duration, Math.max(0, trailing.start));
    }

    if (trimEndFrom <= trimStartTo) {
        return {
            duration,
            trimStartTo: 0,
            trimEndFrom: duration,
            hasTrim: false,
        };
    }

    const hasLeadingTrim = trimStartTo > epsilon;
    const hasTrailingTrim = trimEndFrom < (duration - epsilon);

    return {
        duration,
        trimStartTo,
        trimEndFrom,
        hasTrim: hasLeadingTrim || hasTrailingTrim,
    };
}

function getCodecArgsForExtension(filePath) {
    const extension = path.extname(filePath).toLowerCase();
    if (extension === '.m4a') return ['-c:a', 'aac', '-b:a', '192k'];
    if (extension === '.mp3') return ['-c:a', 'libmp3lame', '-q:a', '2'];
    if (extension === '.wav') return ['-c:a', 'pcm_s16le'];
    if (extension === '.flac') return ['-c:a', 'flac'];
    if (extension === '.ogg') return ['-c:a', 'libvorbis', '-q:a', '5'];
    if (extension === '.webm') return ['-c:a', 'libopus', '-b:a', '160k'];
    return ['-c:a', 'copy'];
}

async function trimTrackSilenceInPlace(filePath, thresholdDb) {
    const { trimStartTo, trimEndFrom, hasTrim } = await detectLeadingTrailingSilence(filePath, thresholdDb);
    if (!hasTrim) {
        return { modified: false };
    }

    const keptDuration = trimEndFrom - trimStartTo;
    if (keptDuration <= 0.4) {
        return { modified: false };
    }

    const extension = path.extname(filePath);
    const baseName = path.basename(filePath, extension);
    const tempOutputPath = path.join(
        path.dirname(filePath),
        `${baseName}.trim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${extension}`
    );

    const ffmpegPath = getMediaToolPath('ffmpeg');
    const ffmpegArgs = [
        '-y',
        '-hide_banner',
        '-loglevel', 'error',
        '-ss', `${trimStartTo}`,
        '-to', `${trimEndFrom}`,
        '-i', filePath,
        '-vn',
        ...getCodecArgsForExtension(filePath),
        tempOutputPath,
    ];

    const trimRun = await runMediaTool(ffmpegPath, ffmpegArgs, { stdinNull: true });
    if (trimRun.code !== 0 || !fs.existsSync(tempOutputPath)) {
        if (fs.existsSync(tempOutputPath)) {
            await fs.promises.rm(tempOutputPath, { force: true });
        }
        throw new Error(`ffmpeg trim failed (${trimRun.code}).`);
    }

    const backup = await moveToUndoTrash(filePath);
    try {
        await fs.promises.rename(tempOutputPath, filePath);
    } catch (error) {
        if (fs.existsSync(tempOutputPath)) {
            await fs.promises.rm(tempOutputPath, { force: true });
        }
        await restoreFromUndoTrash(backup.trashPath, backup.originalPath);
        throw error;
    }

    return { modified: true, backup };
}

async function ensureTrimUndoManifestDir() {
    await fs.promises.mkdir(trimUndoManifestPath, { recursive: true });
}

function getTrimUndoManifestFilePath(manifestId) {
    return path.join(trimUndoManifestPath, `${manifestId}.json`);
}

async function writeTrimUndoManifest(manifestId, data) {
    await ensureTrimUndoManifestDir();
    await fs.promises.writeFile(getTrimUndoManifestFilePath(manifestId), JSON.stringify(data, null, 2), 'utf-8');
}

async function saveTrimUndoManifest(items) {
    const manifestId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    await writeTrimUndoManifest(manifestId, {
        createdAt: new Date().toISOString(),
        items,
    });
    return manifestId;
}

async function readTrimUndoManifest(manifestId) {
    if (!manifestId) return null;
    const filePath = getTrimUndoManifestFilePath(manifestId);
    if (!fs.existsSync(filePath)) return null;
    const raw = await fs.promises.readFile(filePath, 'utf-8');
    return JSON.parse(raw);
}

async function deleteTrimUndoManifest(manifestId) {
    if (!manifestId) return;
    const filePath = getTrimUndoManifestFilePath(manifestId);
    if (fs.existsSync(filePath)) {
        await fs.promises.rm(filePath, { force: true });
    }
}

function buildUndoTrashItemPath(targetPath) {
    const itemName = path.basename(targetPath);
    const uniqueId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    return path.join(undoTrashPath, `${uniqueId}-${itemName}`);
}

async function moveToUndoTrash(targetPath) {
    await ensureUndoTrashExists();
    const trashPath = buildUndoTrashItemPath(targetPath);
    try {
        await fs.promises.rename(targetPath, trashPath);
    } catch (error) {
        if (error.code !== 'EXDEV') throw error;

        const sourceStat = await fs.promises.stat(targetPath);
        if (sourceStat.isDirectory()) {
            await fs.promises.cp(targetPath, trashPath, { recursive: true });
            await fs.promises.rm(targetPath, { recursive: true, force: true });
        } else {
            await fs.promises.copyFile(targetPath, trashPath);
            await fs.promises.unlink(targetPath);
        }
    }
    return { trashPath, originalPath: targetPath, itemName: path.basename(targetPath) };
}

async function restoreFromUndoTrash(trashPath, originalPath) {
    if (!trashPath || !originalPath) {
        return { success: false, error: 'Undo payload is missing required paths.' };
    }

    if (!fs.existsSync(trashPath)) {
        return { success: false, error: 'Undo item no longer exists in temporary storage.' };
    }

    if (fs.existsSync(originalPath)) {
        return { success: false, error: 'Cannot restore because destination path already exists.' };
    }

    await fs.promises.mkdir(path.dirname(originalPath), { recursive: true });
    try {
        await fs.promises.rename(trashPath, originalPath);
    } catch (error) {
        if (error.code !== 'EXDEV') throw error;

        const sourceStat = await fs.promises.stat(trashPath);
        if (sourceStat.isDirectory()) {
            await fs.promises.cp(trashPath, originalPath, { recursive: true });
            await fs.promises.rm(trashPath, { recursive: true, force: true });
        } else {
            await fs.promises.copyFile(trashPath, originalPath);
            await fs.promises.unlink(trashPath);
        }
    }
    return { success: true, restoredPath: originalPath };
}

function loadTrackTags() {
    try {
        if (fs.existsSync(trackTagsPath)) {
            const parsed = JSON.parse(fs.readFileSync(trackTagsPath, 'utf-8'));
            trackTags = parsed && typeof parsed === 'object' ? parsed : {};
        } else {
            trackTags = {};
            fs.writeFileSync(trackTagsPath, JSON.stringify(trackTags, null, 4));
        }
    } catch (error) {
        console.error('Failed to load or create track tags file:', error);
        trackTags = {};
    }
}

function saveTrackTags() {
    try {
        safeWriteFileSync(trackTagsPath, JSON.stringify(trackTags, null, 4));
    } catch (error) {
        console.error('Failed to save track tags file:', error);
    }
}

function normalizeTagList(tags) {
    if (!Array.isArray(tags)) return [];

    const seen = new Set();
    const normalized = [];
    for (const rawTag of tags) {
        if (typeof rawTag !== 'string') continue;
        const trimmed = rawTag.trim();
        if (!trimmed) continue;
        const key = trimmed.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        normalized.push(trimmed);
    }
    return normalized;
}

function getTrackTagsForPath(filePath) {
    if (!filePath || typeof filePath !== 'string') return [];
    return normalizeTagList(trackTags[filePath]);
}

function setTrackTagsForPath(filePath, tags) {
    if (!filePath || typeof filePath !== 'string') return;
    const normalized = normalizeTagList(tags);
    if (normalized.length === 0) {
        delete trackTags[filePath];
    } else {
        trackTags[filePath] = normalized;
    }
}

function moveTrackTagsPath(fromPath, toPath) {
    if (!fromPath || !toPath || fromPath === toPath) return;
    const tags = getTrackTagsForPath(fromPath);
    if (tags.length === 0) return;
    setTrackTagsForPath(toPath, tags);
    delete trackTags[fromPath];
    saveTrackTags();
}

function inferTrackSource(filePath, metadata) {
    const hints = [
        filePath,
        metadata?.common?.comment,
        metadata?.common?.description,
        metadata?.common?.publisher,
    ]
        .flat()
        .filter(Boolean)
        .map(value => String(value).toLowerCase())
        .join(' ');

    if (hints.includes('spotify')) return 'Spotify';
    if (hints.includes('youtube') || hints.includes('youtu.be') || hints.includes('ytmusic')) return 'YouTube';
    if (hints.includes('soundcloud')) return 'SoundCloud';
    if (hints.includes('apple music') || hints.includes('music.apple.com')) return 'Apple Music';
    return 'Unknown';
}

function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return 'Unknown';
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / (1024 ** exponent);
    return `${value.toFixed(value >= 100 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}