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
const downloadCachePath = path.join(app.getPath('userData'), 'download_cache.json');
const trackTagsPath = path.join(app.getPath('userData'), 'track_tags.json');
const playlistTagsPath = path.join(app.getPath('userData'), 'playlist_tags.json');
const metadataCachePath = path.join(app.getPath('userData'), 'track_metadata_cache.json');
const trackPlayCountsPath = path.join(app.getPath('userData'), 'track_play_counts.json');
const playlistSyncCachePath = path.join(app.getPath('userData'), 'playlist_sync_cache.json');
const undoTrashPath = path.join(app.getPath('userData'), 'undo-trash');
const trimUndoManifestPath = path.join(app.getPath('userData'), 'trim-undo-manifests');
const ytdlpDir = isDev ? path.join(__dirname, 'yt-dlp') : path.join(process.resourcesPath, 'yt-dlp');
const userDataPluginRoot = path.join(app.getPath('userData'), 'yt-dlp-plugins');
const ytdlpGetPotPluginDir = path.join(userDataPluginRoot, 'yt-dlp-get-pot');
const ytdlpThreadInstancesDir = path.join(app.getPath('userData'), 'yt-dlp-thread-instances');

// --- STATE VARIABLES ---
let config = {};
let stats = {};
let linkCache = {};
let downloadCache = {};
let trackTags = {};
let playlistTags = {};
let metadataCache = {};
let trackPlayCounts = {};
let playlistSyncCache = {};
let downloadsDir = path.join(app.getPath('downloads'), 'SoundLink');
let mainWindow;
let tray = null;
let activeProcesses = new Set();
let ytdlpExecutables = [];
let ytdlpThreadInstances = [];
let ytdlpInstanceIndex = 0;
let lastDownloadedFiles = [];
let lastPlaylistName = null;
let isDownloadCancelled = false;
const activeDownloadArtifacts = new Map();
let lastDownloadedTrackContexts = {};
let cachedYtdlpPluginPath = undefined;
let hasLoggedMissingYtdlpPlugin = false;
let cachedYtdlpPluginFlag = undefined;
let cachedNodeRuntimePath = undefined;
let manualLinkRequestCounter = 0;
const pendingManualLinkRequests = new Map();
const activeSilenceTrimJobs = new Map();
let trayPlaybackState = {
    isPlaying: false,
    trackName: 'Nothing playing',
    playlistName: '—',
    durationSeconds: 0,
    currentTimeSeconds: 0,
    sleepTimerActive: false,
    sleepTimerRemainingSeconds: 0,
};

const SMART_PLAYLIST_RECENTLY_ADDED = '__smart__/recently-added';
const SMART_PLAYLIST_MOST_PLAYED = '__smart__/most-played';
const MAX_DOWNLOAD_THREADS = 10;
const IS_WINDOWS = process.platform === 'win32';

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

function isYtdlpExecutableName(fileName) {
    if (typeof fileName !== 'string') return false;
    const normalizedName = fileName.trim().toLowerCase();
    if (!normalizedName.startsWith('yt-dlp')) return false;
    if (normalizedName.endsWith('.old')) return false;

    if (IS_WINDOWS) {
        return normalizedName.endsWith('.exe');
    }

    return !normalizedName.includes('.');
}

function listYtdlpExecutableCandidates() {
    if (!fs.existsSync(ytdlpDir)) return [];
    return fs.readdirSync(ytdlpDir)
        .filter(isYtdlpExecutableName)
        .map(file => path.join(ytdlpDir, file));
}

function resolveCommandOnPath(commandName) {
    try {
        const resolver = IS_WINDOWS ? 'where.exe' : 'which';
        const output = execFileSync(resolver, [commandName], {
            encoding: 'utf8',
            windowsHide: true,
            maxBuffer: 1024 * 1024,
        });

        const resolved = output
            .split(/\r?\n/)
            .map(line => line.trim())
            .find(Boolean);

        return resolved || null;
    } catch {
        return null;
    }
}

function findYtdlpExecutables() {
    try {
        const bundledCandidates = listYtdlpExecutableCandidates();
        const pathCandidate = resolveCommandOnPath('yt-dlp');
        const candidates = bundledCandidates.length > 0
            ? bundledCandidates
            : (pathCandidate ? [pathCandidate] : []);

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
        const latestExecutables = latestVersion
            ? withVersion.filter(entry => entry.versionDate === latestVersion).map(entry => entry.filePath)
            : withVersion.slice(0, 1).map(entry => entry.filePath);

        ytdlpExecutables = latestExecutables;
        ytdlpThreadInstances = [];
        ytdlpInstanceIndex = 0;

        if (fs.existsSync(ytdlpThreadInstancesDir)) {
            fs.rmSync(ytdlpThreadInstancesDir, { recursive: true, force: true });
        }
        fs.mkdirSync(ytdlpThreadInstancesDir, { recursive: true });

        if (latestExecutables.length > 0) {
            const pluginSourcePath = ensureYtdlpGetPotPlugin();

            for (let index = 0; index < MAX_DOWNLOAD_THREADS; index++) {
                const sourceExecutablePath = latestExecutables[index % latestExecutables.length];
                const threadName = `yt-dlp Thread ${index + 1}`;
                const threadRootPath = path.join(ytdlpThreadInstancesDir, threadName);
                const threadExecutablePath = path.join(threadRootPath, path.basename(sourceExecutablePath));
                const threadPluginPath = path.join(threadRootPath, 'plugins');

                fs.mkdirSync(threadRootPath, { recursive: true });
                const useBundledExecutable = fs.existsSync(sourceExecutablePath);
                const runtimeExecutablePath = useBundledExecutable ? threadExecutablePath : sourceExecutablePath;

                if (useBundledExecutable) {
                    fs.copyFileSync(sourceExecutablePath, threadExecutablePath);
                    if (!IS_WINDOWS) {
                        try {
                            fs.chmodSync(threadExecutablePath, 0o755);
                        } catch {
                            // Ignore chmod failures; process spawn will surface real executable issues.
                        }
                    }
                }

                let resolvedPluginPath = null;
                if (pluginSourcePath && fs.existsSync(pluginSourcePath)) {
                    copyDirectoryRecursive(pluginSourcePath, threadPluginPath);
                    if (isValidYtdlpPluginDirectory(threadPluginPath)) {
                        resolvedPluginPath = threadPluginPath;
                    }
                }

                ytdlpThreadInstances.push({
                    threadIndex: index + 1,
                    threadName,
                    rootPath: threadRootPath,
                    executablePath: runtimeExecutablePath,
                    pluginPath: resolvedPluginPath,
                    sourceExecutablePath,
                });
            }
        }

        if (ytdlpThreadInstances.length === 0) {
            console.error(`No usable yt-dlp executable found in bundled resources (${ytdlpDir}) or system PATH.`);
        } else {
            const selected = ytdlpThreadInstances[0];
            const pluginEnabledCount = ytdlpThreadInstances.filter(instance => instance.pluginPath).length;
            console.log(`Prepared ${ytdlpThreadInstances.length} yt-dlp thread instance folder(s) from ${latestExecutables.length} executable(s), baseline: ${path.basename(selected.executablePath)}, plugin-ready: ${pluginEnabledCount}`);
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
            if (typeof config.disableToasts !== 'boolean') {
                config.disableToasts = false;
            }
            if (typeof config.spectrogramColor !== 'string' || !/^#[\da-f]{6}$/i.test(config.spectrogramColor)) {
                config.spectrogramColor = '#3b82f6';
            }
        } else {
            config = { 
                theme: 'dark',
                fileExtension: 'm4a',
                downloadThreads: 3,
                spotifySearchLimit: 10,
                spotify: { clientId: '', clientSecret: '' }, 
                downloadsPath: downloadsDir,
                autoCreatePlaylist: false,
                favoriteThemes: [],
                favoritePlaylists: [],
                normalizeVolume: false,
                hideSearchBars: false,
                hideMixButtons: false,
                visualThemeSync: false,
                enableSmartPlaylists: true,
                libraryPerformanceMode: true,
                skipManualLinkPrompt: false,
                disableToasts: false,
                durationToleranceSeconds: 20,
                silenceTrimThresholdDb: 35,
                playerVolume: 1,
                spectrogramColor: '#3b82f6',
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

function normalizeDownloadCacheShape(parsed) {
    const rawEntries = parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object'
        ? parsed.entries
        : {};

    const normalizedEntries = {};
    for (const [rawKey, value] of Object.entries(rawEntries)) {
        if (typeof rawKey !== 'string' || !rawKey.trim()) continue;
        if (!value || typeof value !== 'object') continue;

        const normalizedKey = rawKey.trim();
        normalizedEntries[normalizedKey] = {
            key: normalizedKey,
            sourceUrl: typeof value.sourceUrl === 'string' ? value.sourceUrl : null,
            spotifyUrl: typeof value.spotifyUrl === 'string' ? value.spotifyUrl : null,
            spotifyId: typeof value.spotifyId === 'string' ? value.spotifyId : null,
            name: typeof value.name === 'string' ? value.name : '',
            artist: typeof value.artist === 'string' ? value.artist : '',
            durationMs: Number.isFinite(value.durationMs) ? value.durationMs : null,
            localPath: typeof value.localPath === 'string' ? value.localPath : null,
            playlistPath: typeof value.playlistPath === 'string' ? value.playlistPath : null,
            fileName: typeof value.fileName === 'string' ? value.fileName : null,
            fileSize: Number.isFinite(value.fileSize) ? value.fileSize : null,
            downloadedAt: typeof value.downloadedAt === 'string' ? value.downloadedAt : null,
            updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
        };
    }

    return {
        version: 1,
        entries: normalizedEntries,
    };
}

function loadDownloadCache() {
    try {
        if (fs.existsSync(downloadCachePath)) {
            const parsed = JSON.parse(fs.readFileSync(downloadCachePath, 'utf-8'));
            downloadCache = normalizeDownloadCacheShape(parsed);
        } else {
            downloadCache = normalizeDownloadCacheShape({});
            fs.writeFileSync(downloadCachePath, JSON.stringify(downloadCache, null, 4));
        }
    } catch (error) {
        console.error('Failed to load or create download cache file:', error);
        downloadCache = normalizeDownloadCacheShape({});
    }
}

function saveDownloadCache() {
    try {
        safeWriteFileSync(downloadCachePath, JSON.stringify(downloadCache, null, 4));
    } catch (error) {
        console.error('Failed to save download cache file:', error);
    }
}

function buildDownloadCacheKey({ spotifyUrl, sourceUrl, localPath }) {
    if (typeof spotifyUrl === 'string' && spotifyUrl.trim()) {
        return `spotify:${spotifyUrl.trim().toLowerCase()}`;
    }
    if (typeof sourceUrl === 'string' && sourceUrl.trim()) {
        return `source:${sourceUrl.trim().toLowerCase()}`;
    }
    const normalizedPath = normalizePathKey(localPath);
    if (normalizedPath) {
        return `file:${normalizedPath}`;
    }
    return '';
}

function upsertDownloadCacheEntry({
    sourceUrl = null,
    spotifyUrl = null,
    spotifyId = null,
    name = '',
    artist = '',
    durationMs = null,
    localPath = null,
    playlistPath = null,
    downloadedAt = null,
}) {
    const key = buildDownloadCacheKey({ spotifyUrl, sourceUrl, localPath });
    if (!key) return;

    const existing = downloadCache.entries[key] || {};
    let fileName = null;
    let fileSize = null;
    if (localPath && fs.existsSync(localPath)) {
        fileName = path.basename(localPath);
        try {
            const stats = fs.statSync(localPath);
            fileSize = Number.isFinite(stats.size) ? stats.size : null;
        } catch {
            fileSize = null;
        }
    }

    const nowIso = new Date().toISOString();
    downloadCache.entries[key] = {
        key,
        sourceUrl: sourceUrl || existing.sourceUrl || null,
        spotifyUrl: spotifyUrl || existing.spotifyUrl || null,
        spotifyId: spotifyId || existing.spotifyId || null,
        name: name || existing.name || '',
        artist: artist || existing.artist || '',
        durationMs: Number.isFinite(durationMs) ? durationMs : (Number.isFinite(existing.durationMs) ? existing.durationMs : null),
        localPath: localPath || existing.localPath || null,
        playlistPath: playlistPath || existing.playlistPath || null,
        fileName: fileName || existing.fileName || null,
        fileSize: Number.isFinite(fileSize) ? fileSize : (Number.isFinite(existing.fileSize) ? existing.fileSize : null),
        downloadedAt: downloadedAt || existing.downloadedAt || nowIso,
        updatedAt: nowIso,
    };
    saveDownloadCache();
}

function removeDownloadCacheByLocalPath(localPath) {
    const normalizedTarget = normalizePathKey(localPath);
    if (!normalizedTarget) return;

    let hasChanges = false;
    for (const [entryKey, entry] of Object.entries(downloadCache.entries || {})) {
        if (normalizePathKey(entry.localPath) === normalizedTarget) {
            delete downloadCache.entries[entryKey];
            hasChanges = true;
        }
    }

    if (hasChanges) {
        saveDownloadCache();
    }
}

function moveDownloadCachePath(oldPath, newPath) {
    const normalizedOldPath = normalizePathKey(oldPath);
    const normalizedNewPath = normalizePathKey(newPath);
    if (!normalizedOldPath || !normalizedNewPath || normalizedOldPath === normalizedNewPath) return;

    let hasChanges = false;
    const nowIso = new Date().toISOString();
    for (const [entryKey, entry] of Object.entries(downloadCache.entries || {})) {
        if (normalizePathKey(entry.localPath) !== normalizedOldPath) continue;

        entry.localPath = newPath;
        entry.fileName = path.basename(newPath);
        entry.playlistPath = path.dirname(newPath);
        entry.updatedAt = nowIso;

        const desiredKey = buildDownloadCacheKey({ spotifyUrl: entry.spotifyUrl, sourceUrl: entry.sourceUrl, localPath: newPath });
        if (desiredKey && desiredKey !== entryKey) {
            delete downloadCache.entries[entryKey];
            entry.key = desiredKey;
            downloadCache.entries[desiredKey] = entry;
        }

        hasChanges = true;
    }

    if (hasChanges) {
        saveDownloadCache();
    }
}

function moveDownloadCachePlaylistPath(oldPlaylistPath, newPlaylistPath) {
    const normalizedOldPlaylistPath = normalizePathKey(oldPlaylistPath);
    const normalizedNewPlaylistPath = normalizePathKey(newPlaylistPath);
    if (!normalizedOldPlaylistPath || !normalizedNewPlaylistPath || normalizedOldPlaylistPath === normalizedNewPlaylistPath) return;

    let hasChanges = false;
    const nowIso = new Date().toISOString();
    for (const [entryKey, entry] of Object.entries(downloadCache.entries || {})) {
        const entryPlaylistPath = normalizePathKey(entry.playlistPath);
        const entryLocalPath = normalizePathKey(entry.localPath);
        if (entryPlaylistPath !== normalizedOldPlaylistPath && !(entryLocalPath && entryLocalPath.startsWith(`${normalizedOldPlaylistPath}${path.sep}`))) {
            continue;
        }

        const nextLocalPath = entry.localPath
            ? path.join(newPlaylistPath, path.basename(entry.localPath))
            : entry.localPath;

        entry.playlistPath = newPlaylistPath;
        entry.localPath = nextLocalPath;
        entry.fileName = nextLocalPath ? path.basename(nextLocalPath) : entry.fileName;
        entry.updatedAt = nowIso;

        const desiredKey = buildDownloadCacheKey({ spotifyUrl: entry.spotifyUrl, sourceUrl: entry.sourceUrl, localPath: nextLocalPath });
        if (desiredKey && desiredKey !== entryKey) {
            delete downloadCache.entries[entryKey];
            entry.key = desiredKey;
            downloadCache.entries[desiredKey] = entry;
        }

        hasChanges = true;
    }

    if (hasChanges) {
        saveDownloadCache();
    }
}

function removeDownloadCacheByPlaylistPath(playlistPath) {
    const normalizedPlaylistPath = normalizePathKey(playlistPath);
    if (!normalizedPlaylistPath) return;

    let hasChanges = false;
    for (const [entryKey, entry] of Object.entries(downloadCache.entries || {})) {
        const entryPlaylistPath = normalizePathKey(entry.playlistPath);
        const entryLocalPath = normalizePathKey(entry.localPath);
        const isInPlaylist = entryPlaylistPath === normalizedPlaylistPath
            || (entryLocalPath && entryLocalPath.startsWith(`${normalizedPlaylistPath}${path.sep}`));
        if (!isInPlaylist) continue;

        delete downloadCache.entries[entryKey];
        hasChanges = true;
    }

    if (hasChanges) {
        saveDownloadCache();
    }
}

function normalizePathKey(filePath) {
    if (typeof filePath !== 'string' || filePath.trim().length === 0) return '';
    const normalized = path.normalize(filePath.trim());
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function normalizePlaylistSyncCacheShape(parsed) {
    const playlistsRaw = parsed && typeof parsed === 'object' && parsed.playlists && typeof parsed.playlists === 'object'
        ? parsed.playlists
        : {};
    const normalizedPlaylists = {};

    for (const [rawKey, value] of Object.entries(playlistsRaw)) {
        const normalizedKey = normalizePathKey(rawKey);
        if (!normalizedKey || !value || typeof value !== 'object') continue;

        const source = value.source && typeof value.source === 'object' ? value.source : null;
        const tracksRaw = value.tracks && typeof value.tracks === 'object' ? value.tracks : {};
        const tracks = {};
        for (const [trackKey, trackValue] of Object.entries(tracksRaw)) {
            if (typeof trackKey !== 'string' || !trackKey.trim()) continue;
            if (!trackValue || typeof trackValue !== 'object') continue;
            tracks[trackKey] = {
                spotifyUrl: trackValue.spotifyUrl || trackKey,
                spotifyId: trackValue.spotifyId || null,
                name: trackValue.name || '',
                artist: trackValue.artist || '',
                durationMs: Number.isFinite(trackValue.durationMs) ? trackValue.durationMs : null,
                position: Number.isFinite(trackValue.position) ? trackValue.position : null,
                localPath: typeof trackValue.localPath === 'string' ? trackValue.localPath : null,
                updatedAt: trackValue.updatedAt || null,
            };
        }

        normalizedPlaylists[normalizedKey] = {
            source: source
                ? {
                    link: source.link || null,
                    type: source.type || null,
                    id: source.id || null,
                    name: source.name || null,
                    lastSyncedAt: source.lastSyncedAt || null,
                }
                : null,
            tracks,
        };
    }

    return {
        version: 1,
        playlists: normalizedPlaylists,
    };
}

function loadPlaylistSyncCache() {
    try {
        if (fs.existsSync(playlistSyncCachePath)) {
            const parsed = JSON.parse(fs.readFileSync(playlistSyncCachePath, 'utf-8'));
            playlistSyncCache = normalizePlaylistSyncCacheShape(parsed);
        } else {
            playlistSyncCache = normalizePlaylistSyncCacheShape({});
            fs.writeFileSync(playlistSyncCachePath, JSON.stringify(playlistSyncCache, null, 4));
        }
    } catch (error) {
        console.error('Failed to load or create playlist sync cache file:', error);
        playlistSyncCache = normalizePlaylistSyncCacheShape({});
    }
}

function savePlaylistSyncCache() {
    try {
        safeWriteFileSync(playlistSyncCachePath, JSON.stringify(playlistSyncCache, null, 4));
    } catch (error) {
        console.error('Failed to save playlist sync cache file:', error);
    }
}

function getPlaylistSyncEntry(playlistPath) {
    const key = normalizePathKey(playlistPath);
    if (!key) return null;
    return playlistSyncCache?.playlists?.[key] || null;
}

function ensurePlaylistSyncEntry(playlistPath) {
    const key = normalizePathKey(playlistPath);
    if (!key) return null;

    if (!playlistSyncCache.playlists[key]) {
        playlistSyncCache.playlists[key] = {
            source: null,
            tracks: {},
        };
    }

    return playlistSyncCache.playlists[key];
}

function removePlaylistSyncEntry(playlistPath) {
    const key = normalizePathKey(playlistPath);
    if (!key) return;
    if (!playlistSyncCache?.playlists?.[key]) return;
    delete playlistSyncCache.playlists[key];
    savePlaylistSyncCache();
}

function movePlaylistSyncEntry(oldPath, newPath) {
    const oldKey = normalizePathKey(oldPath);
    const newKey = normalizePathKey(newPath);
    if (!oldKey || !newKey || oldKey === newKey) return;

    const existing = playlistSyncCache?.playlists?.[oldKey];
    if (!existing) return;

    const moved = {
        source: existing.source ? { ...existing.source } : null,
        tracks: {},
    };
    for (const [spotifyUrl, trackEntry] of Object.entries(existing.tracks || {})) {
        const localPath = typeof trackEntry.localPath === 'string' && trackEntry.localPath
            ? path.join(newPath, path.basename(trackEntry.localPath))
            : null;
        moved.tracks[spotifyUrl] = {
            ...trackEntry,
            localPath,
        };
    }

    playlistSyncCache.playlists[newKey] = moved;
    delete playlistSyncCache.playlists[oldKey];
    savePlaylistSyncCache();
}

function parseSpotifyLinkInfo(link) {
    if (typeof link !== 'string') return null;
    const match = link.match(/spotify\.com\/(playlist|album|track)\/([a-zA-Z0-9]+)/i);
    if (!match) return null;
    return {
        type: match[1].toLowerCase(),
        id: match[2],
        link: link.trim(),
    };
}

function recordDownloadedTrackContext(filePath, context) {
    const key = normalizePathKey(filePath);
    if (!key || !context || typeof context !== 'object') return;
    lastDownloadedTrackContexts[key] = {
        spotifyUrl: context.spotifyUrl || null,
        spotifyId: context.spotifyId || null,
        name: context.name || '',
        artist: context.artist || '',
        durationMs: Number.isFinite(context.durationMs) ? context.durationMs : null,
        playlistSource: context.playlistSource || null,
    };
}

function hasPlaylistSourceContextForDownloads() {
    return Object.values(lastDownloadedTrackContexts).some(ctx => ctx?.playlistSource?.type === 'playlist');
}

function getNextYtdlpInstance() {
    if (ytdlpThreadInstances.length === 0) return null;
    const instance = ytdlpThreadInstances[ytdlpInstanceIndex];
    ytdlpInstanceIndex = (ytdlpInstanceIndex + 1) % ytdlpThreadInstances.length;
    return instance;
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

    const ytdlpPath = ytdlpThreadInstances[0]?.executablePath || ytdlpExecutables[0];
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

function getYtdlpCommonArgs(ytdlpInstance = null) {
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

    const pluginPath = ytdlpInstance?.pluginPath || ensureYtdlpGetPotPlugin();
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
loadDownloadCache();
loadTrackTags();
loadPlaylistTags();
loadMetadataCache();
loadTrackPlayCounts();
loadPlaylistSyncCache();
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
        refreshTrayContextMenu();
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

            const playlists = await getPhysicalPlaylists(playlistsPath);
            const smartPlaylists = isSmartPlaylistsEnabled()
                ? [
                    { name: 'Recently Added', path: SMART_PLAYLIST_RECENTLY_ADDED, isSmart: true },
                    { name: 'Most Played', path: SMART_PLAYLIST_MOST_PLAYED, isSmart: true },
                ]
                : [];

            webContents.send('update-status', `[Playlist Loader] Found ${playlists.length} directories.`);
            return [...smartPlaylists, ...playlists];
        } catch (err) {
            console.error('Error loading playlists:', err);
            webContents.send('update-status', `[Playlist Loader] CRITICAL ERROR: ${err.message}`);
            return [];
        }
    });

    ipcMain.handle('get-playlist-tracks', async (event, playlistPath) => {
        try {
            if (!playlistPath) return { tracks: [], totalDuration: 0 };

            if (isSmartPlaylistPath(playlistPath)) {
                const smart = await getSmartPlaylistTracks(playlistPath);
                if (smart.cacheUpdated) saveMetadataCache();
                return { tracks: smart.tracks, totalDuration: smart.totalDuration };
            }

            if (!fs.existsSync(playlistPath)) return { tracks: [], totalDuration: 0 };
            const files = await fs.promises.readdir(playlistPath);
            const trackCandidates = files.filter(file => supportedExtensions.includes(path.extname(file).toLowerCase()));
            let cacheUpdated = false;

            const tracks = await Promise.all(trackCandidates.map(async (file) => {
                const ext = path.extname(file).toLowerCase();
                const filePath = path.join(playlistPath, file);
                const metadataResult = await getTrackMetadata(filePath, { useCache: isLibraryPerformanceModeEnabled() });
                cacheUpdated = cacheUpdated || metadataResult.cacheUpdated;

                return {
                    name: path.basename(file, ext),
                    path: filePath,
                    duration: metadataResult.metadata.durationSeconds,
                    tags: getTrackTagsForPath(filePath),
                };
            }));

            if (cacheUpdated) saveMetadataCache();
            const totalDuration = tracks.reduce((sum, track) => sum + (Number.isFinite(track.duration) ? track.duration : 0), 0);
            return { tracks, totalDuration };
        } catch (err) {
            console.error(`Error loading tracks from "${playlistPath}":`, err);
            return { tracks: [], totalDuration: 0 };
        }
    });

    ipcMain.handle('get-playlist-duration', async (event, playlistPath) => {
        try {
            if (!playlistPath) return 0;

            if (isSmartPlaylistPath(playlistPath)) {
                const smart = await getSmartPlaylistTracks(playlistPath);
                if (smart.cacheUpdated) saveMetadataCache();
                return smart.totalDuration || 0;
            }

            if (!fs.existsSync(playlistPath)) return 0;
            const files = await fs.promises.readdir(playlistPath);
            const trackCandidates = files.filter(file => supportedExtensions.includes(path.extname(file).toLowerCase()));
            let totalDuration = 0;
            let cacheUpdated = false;

            await Promise.all(trackCandidates.map(async (file) => {
                const filePath = path.join(playlistPath, file);
                const metadataResult = await getTrackMetadata(filePath, { useCache: isLibraryPerformanceModeEnabled() });
                cacheUpdated = cacheUpdated || metadataResult.cacheUpdated;
                totalDuration += Number.isFinite(metadataResult.metadata.durationSeconds)
                    ? metadataResult.metadata.durationSeconds
                    : 0;
            }));

            if (cacheUpdated) saveMetadataCache();
            return totalDuration;
        } catch (err) {
            console.error(`Error calculating duration for "${playlistPath}":`, err);
            return 0;
        }
    });

    ipcMain.handle('get-playlist-details', async (_event, playlistPath) => {
        try {
            if (!playlistPath) {
                return { success: false, error: 'Playlist folder does not exist.' };
            }

            if (isSmartPlaylistPath(playlistPath)) {
                const smart = await getSmartPlaylistTracks(playlistPath);
                if (smart.cacheUpdated) saveMetadataCache();
                return {
                    success: true,
                    details: {
                        name: playlistPath === SMART_PLAYLIST_RECENTLY_ADDED ? 'Recently Added' : 'Most Played',
                        path: playlistPath,
                        trackCount: smart.tracks.length,
                        totalDurationSeconds: smart.totalDuration,
                        totalSizeBytes: 0,
                        totalSizeFormatted: formatBytes(0),
                        tags: [],
                        createdAt: null,
                        modifiedAt: null,
                    },
                };
            }

            if (!fs.existsSync(playlistPath)) {
                return { success: false, error: 'Playlist folder does not exist.' };
            }

            const playlistStat = await fs.promises.stat(playlistPath);
            const files = await fs.promises.readdir(playlistPath);
            const trackCandidates = files.filter(file => supportedExtensions.includes(path.extname(file).toLowerCase()));

            let totalDurationSeconds = 0;
            let totalSizeBytes = 0;
            let cacheUpdated = false;

            await Promise.all(trackCandidates.map(async (file) => {
                const filePath = path.join(playlistPath, file);

                try {
                    const stat = await fs.promises.stat(filePath);
                    totalSizeBytes += Number.isFinite(stat.size) ? stat.size : 0;
                } catch {
                    // noop
                }

                const metadataResult = await getTrackMetadata(filePath, { useCache: isLibraryPerformanceModeEnabled() });
                cacheUpdated = cacheUpdated || metadataResult.cacheUpdated;
                totalDurationSeconds += Number.isFinite(metadataResult.metadata.durationSeconds)
                    ? metadataResult.metadata.durationSeconds
                    : 0;
            }));

            if (cacheUpdated) saveMetadataCache();

            return {
                success: true,
                details: {
                    name: path.basename(playlistPath),
                    path: playlistPath,
                    trackCount: trackCandidates.length,
                    totalDurationSeconds,
                    totalSizeBytes,
                    totalSizeFormatted: formatBytes(totalSizeBytes),
                    tags: getPlaylistTagsForPath(playlistPath),
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

    ipcMain.handle('get-ytdlp-count', () => ytdlpThreadInstances.length);

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

    ipcMain.on('player-state-update', (_event, payload = {}) => {
        const currentTimeSeconds = Number.parseFloat(payload.currentTimeSeconds);
        const durationSeconds = Number.parseFloat(payload.durationSeconds);
        const sleepTimerRemainingSeconds = Number.parseInt(payload.sleepTimerRemainingSeconds, 10);

        trayPlaybackState = {
            isPlaying: Boolean(payload.isPlaying),
            trackName: sanitizeTrayText(payload.trackName, 'Nothing playing'),
            playlistName: sanitizeTrayText(payload.playlistName, '—'),
            durationSeconds: Number.isFinite(durationSeconds) && durationSeconds >= 0 ? durationSeconds : 0,
            currentTimeSeconds: Number.isFinite(currentTimeSeconds) && currentTimeSeconds >= 0 ? currentTimeSeconds : 0,
            sleepTimerActive: Boolean(payload.sleepTimerActive),
            sleepTimerRemainingSeconds: Number.isFinite(sleepTimerRemainingSeconds) && sleepTimerRemainingSeconds >= 0
                ? sleepTimerRemainingSeconds
                : 0,
        };

        refreshTrayContextMenu();
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
        downloadCache = normalizeDownloadCacheShape({});
        saveDownloadCache();
        return { success: true, message: 'Link cache and download cache cleared successfully.' };
    });

    ipcMain.handle('get-default-settings', () => {
        const defaultDownloadsPath = path.join(app.getPath('downloads'), 'SoundLink');
        return { 
            theme: 'dark',
            fileExtension: 'm4a',
            downloadThreads: 3,
            spotifySearchLimit: 10,
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
            enableSmartPlaylists: true,
            libraryPerformanceMode: true,
            skipManualLinkPrompt: false,
            disableToasts: false,
            durationToleranceSeconds: 20,
            silenceTrimThresholdDb: 35,
            playerVolume: 1,
            spectrogramColor: '#3b82f6',
        };
    });

    ipcMain.handle('save-settings', (event, newSettings) => {
        try {
            config = { ...config, ...newSettings };
            delete config.tabSwitchSpeed;
            delete config.dropdownSpeed;
            delete config.themeFadeSpeed;
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

    ipcMain.handle('get-playlist-tags', async (_event, playlistPath) => {
        return { success: true, tags: getPlaylistTagsForPath(playlistPath) };
    });

    ipcMain.handle('add-playlist-tag', async (_event, { playlistPath, tag }) => {
        try {
            if (!playlistPath || typeof playlistPath !== 'string') {
                return { success: false, error: 'Invalid playlist path.' };
            }

            const normalizedTag = typeof tag === 'string' ? tag.trim() : '';
            if (!normalizedTag) {
                return { success: false, error: 'Tag cannot be empty.' };
            }

            const existing = getPlaylistTagsForPath(playlistPath);
            existing.push(normalizedTag);
            setPlaylistTagsForPath(playlistPath, existing);
            savePlaylistTags();

            return { success: true, tags: getPlaylistTagsForPath(playlistPath) };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('update-playlist-tag', async (_event, { playlistPath, oldTag, newTag }) => {
        try {
            if (!playlistPath || typeof playlistPath !== 'string') {
                return { success: false, error: 'Invalid playlist path.' };
            }

            const normalizedOld = typeof oldTag === 'string' ? oldTag.trim().toLowerCase() : '';
            if (!normalizedOld) {
                return { success: false, error: 'Original tag is required.' };
            }

            const existing = getPlaylistTagsForPath(playlistPath);
            const updated = existing.filter(tagValue => tagValue.toLowerCase() !== normalizedOld);

            const nextTag = typeof newTag === 'string' ? newTag.trim() : '';
            if (nextTag) updated.push(nextTag);

            setPlaylistTagsForPath(playlistPath, updated);
            savePlaylistTags();
            return { success: true, tags: getPlaylistTagsForPath(playlistPath) };
        } catch (error) {
            return { success: false, error: error.message };
        }
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

    ipcMain.handle('update-track-tag', async (_event, { filePath, oldTag, newTag }) => {
        try {
            if (!filePath || typeof filePath !== 'string') {
                return { success: false, error: 'Invalid track path.' };
            }

            const normalizedOld = typeof oldTag === 'string' ? oldTag.trim().toLowerCase() : '';
            if (!normalizedOld) {
                return { success: false, error: 'Original tag is required.' };
            }

            const existing = getTrackTagsForPath(filePath);
            const updated = existing.filter(tagValue => tagValue.toLowerCase() !== normalizedOld);

            const nextTag = typeof newTag === 'string' ? newTag.trim() : '';
            if (nextTag) updated.push(nextTag);

            setTrackTagsForPath(filePath, updated);
            saveTrackTags();
            return { success: true, tags: getTrackTagsForPath(filePath) };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('record-track-play', async (_event, filePath) => {
        try {
            if (!filePath || typeof filePath !== 'string') {
                return { success: false, error: 'Invalid track path.' };
            }
            const current = Number.isFinite(trackPlayCounts[filePath]) ? trackPlayCounts[filePath] : 0;
            trackPlayCounts[filePath] = current + 1;
            saveTrackPlayCounts();
            return { success: true, playCount: trackPlayCounts[filePath] };
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
            const genre = Array.isArray(metadata?.common?.genre)
                ? metadata.common.genre.join(', ')
                : (metadata?.common?.genre || null);
            const details = {
                path: filePath,
                fileName: path.basename(filePath),
                title: metadata?.common?.title || path.parse(filePath).name,
                artist: metadata?.common?.artist || metadata?.common?.albumartist || null,
                album: metadata?.common?.album || null,
                genre,
                extension: path.extname(filePath).replace('.', '').toLowerCase(),
                directory: path.dirname(filePath),
                playlistName: path.basename(path.dirname(filePath)),
                sizeBytes: fileStat.size,
                sizeFormatted: formatBytes(fileStat.size),
                dateDownloaded: (fileStat.birthtime || fileStat.ctime || fileStat.mtime)?.toISOString?.() || null,
                modifiedAt: fileStat.mtime?.toISOString?.() || null,
                durationSeconds: Number.isFinite(metadata?.format?.duration) ? metadata.format.duration : null,
                sampleRate: Number.isFinite(metadata?.format?.sampleRate) ? metadata.format.sampleRate : null,
                channels: Number.isFinite(metadata?.format?.numberOfChannels) ? metadata.format.numberOfChannels : null,
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
        const candidates = listYtdlpExecutableCandidates();
        if (candidates.length === 0) {
            const pathCandidate = resolveCommandOnPath('yt-dlp');
            if (pathCandidate) {
                candidates.push(pathCandidate);
            }
        }

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
            for (const playlistEntry of Object.values(playlistSyncCache.playlists || {})) {
                for (const [spotifyUrl, trackEntry] of Object.entries(playlistEntry.tracks || {})) {
                    if (normalizePathKey(trackEntry.localPath) === normalizePathKey(filePath)) {
                        delete playlistEntry.tracks[spotifyUrl];
                    }
                }
            }
            savePlaylistSyncCache();
            removeDownloadCacheByLocalPath(filePath);
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
            moveDownloadCachePath(sourcePath, destinationPath);

            for (const playlistEntry of Object.values(playlistSyncCache.playlists || {})) {
                for (const [spotifyUrl, trackEntry] of Object.entries(playlistEntry.tracks || {})) {
                    if (normalizePathKey(trackEntry.localPath) === normalizePathKey(sourcePath)) {
                        delete playlistEntry.tracks[spotifyUrl];
                    }
                }
            }
            savePlaylistSyncCache();
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
            movePlaylistTagsPath(oldPath, newPath);
            movePlaylistSyncEntry(oldPath, newPath);
            moveDownloadCachePlaylistPath(oldPath, newPath);
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

    ipcMain.handle('create-playlist-from-tracks', async (_event, { playlistName, trackPaths }) => {
        try {
            const playlistsPath = config.playlistsFolderPath;
            if (!playlistsPath || !fs.existsSync(playlistsPath)) {
                return { success: false, error: 'Playlists folder is not set or does not exist.' };
            }

            const requestedName = sanitizeFilename(String(playlistName || '').trim());
            if (!requestedName) {
                return { success: false, error: 'Please enter a valid playlist name.' };
            }

            const normalizedTrackPaths = Array.isArray(trackPaths)
                ? trackPaths.filter(p => typeof p === 'string' && p.trim().length > 0)
                : [];

            if (normalizedTrackPaths.length === 0) {
                return { success: false, error: 'No tracks were provided to save.' };
            }

            let finalName = requestedName;
            let finalPath = path.join(playlistsPath, finalName);
            let nameCounter = 2;
            while (fs.existsSync(finalPath)) {
                finalName = `${requestedName} (${nameCounter})`;
                finalPath = path.join(playlistsPath, finalName);
                nameCounter += 1;
            }

            await fs.promises.mkdir(finalPath, { recursive: true });

            let savedTrackCount = 0;
            for (const sourcePath of normalizedTrackPaths) {
                if (!fs.existsSync(sourcePath)) continue;

                const sourceStat = await fs.promises.stat(sourcePath);
                if (!sourceStat.isFile()) continue;

                const parsedName = path.parse(path.basename(sourcePath));
                const baseName = sanitizeFilename(parsedName.name) || 'Track';
                const extension = parsedName.ext || '';

                let destinationPath = path.join(finalPath, `${baseName}${extension}`);
                let duplicateCounter = 2;
                while (fs.existsSync(destinationPath)) {
                    destinationPath = path.join(finalPath, `${baseName} (${duplicateCounter})${extension}`);
                    duplicateCounter += 1;
                }

                await fs.promises.copyFile(sourcePath, destinationPath);
                savedTrackCount += 1;
            }

            if (savedTrackCount === 0) {
                await fs.promises.rm(finalPath, { recursive: true, force: true });
                return { success: false, error: 'No valid source tracks were found.' };
            }

            stats.playlistsCreated = (stats.playlistsCreated || 0) + 1;
            saveStats();

            return {
                success: true,
                savedTrackCount,
                playlist: {
                    name: finalName,
                    path: finalPath,
                },
            };
        } catch (error) {
            console.error('Failed to create playlist from tracks:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('delete-playlist', async (event, playlistPath) => {
        try {
            if (!playlistPath || !fs.existsSync(playlistPath)) {
                return { success: false, error: 'Playlist folder does not exist.' };
            }
            removePlaylistSyncEntry(playlistPath);
            removeDownloadCacheByPlaylistPath(playlistPath);
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
                movePlaylistTagsPath(currentPath, targetPath);
                moveDownloadCachePlaylistPath(currentPath, targetPath);
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
                moveDownloadCachePath(currentPath, targetPath);
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
            moveDownloadCachePath(oldPath, newPath);

            for (const playlistEntry of Object.values(playlistSyncCache.playlists || {})) {
                for (const trackEntry of Object.values(playlistEntry.tracks || {})) {
                    if (normalizePathKey(trackEntry.localPath) === normalizePathKey(oldPath)) {
                        trackEntry.localPath = newPath;
                        trackEntry.updatedAt = new Date().toISOString();
                    }
                }
            }
            savePlaylistSyncCache();
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
        const queuedLinks = Array.isArray(linksArray)
            ? linksArray
                .map(link => (typeof link === 'string' ? link.trim() : ''))
                .filter(Boolean)
            : [];

        if (queuedLinks.length === 0) return mainWindow.webContents.send('update-status', 'No links provided.', true, { success: false });
        if (ytdlpThreadInstances.length === 0) return mainWindow.webContents.send('update-status', 'Error: No yt-dlp executable found.', true, { success: false });

        const pluginReadyInstance = ytdlpThreadInstances.find(instance => instance.pluginPath);
        if (pluginReadyInstance) {
            mainWindow.webContents.send('update-status', `yt-dlp plugin ready: ${pluginReadyInstance.pluginPath}`);
        } else {
            mainWindow.webContents.send('update-status', 'Warning: yt-dlp-get-pot plugin not found in resources; continuing without plugin override.');
        }

        stats.downloadsInitiated = (stats.downloadsInitiated || 0) + 1;
        lastDownloadedFiles = [];
        lastPlaylistName = null;
        lastDownloadedTrackContexts = {};
        isDownloadCancelled = false;
        mainWindow.webContents.send('update-status', `Starting download queue with ${queuedLinks.length} item(s)...`);

        try {
            await refreshSpotifyToken();
            const configuredThreads = Number.parseInt(config.downloadThreads, 10);
            const requestedThreads = Number.isFinite(configuredThreads) && configuredThreads > 0 ? configuredThreads : 3;
            const concurrency = Math.max(1, Math.min(requestedThreads, MAX_DOWNLOAD_THREADS));
            const downloadConcurrency = 1;
            const itemsToProcess = [];
            let trackIndex = 0;
            let spotifyLinkCount = 0;
            let youtubeLinkCount = 0;

            for (const [queueIndex, link] of queuedLinks.entries()) {
                if (isDownloadCancelled) break;
                const queuePosition = queueIndex + 1;
                mainWindow.webContents.send('update-status', `Queue ${queuePosition}/${queuedLinks.length}: preparing link...`);

                if (link.includes('spotify.com')) {
                    spotifyLinkCount++;
                    const { tracks, playlistName, playlistOwner, sourceInfo, error } = await getSpotifyTracks(link);
                    if (error) {
                        mainWindow.webContents.send('update-status', `Queue ${queuePosition}/${queuedLinks.length}: error processing Spotify link: ${error}`);
                        continue;
                    }

                    const playlistDisplayName = playlistName || `Playlist ${queuePosition}`;
                    const playlistFolderName = sanitizeFilename(playlistDisplayName) || `Playlist ${queuePosition}`;
                    const sourceType = sourceInfo?.type || 'playlist';
                    const queueTrackTotal = Array.isArray(tracks) ? tracks.length : 0;

                    if (playlistName && !lastPlaylistName) lastPlaylistName = playlistName;
                    if (tracks) {
                        for (const [trackOffset, track] of tracks.entries()) {
                            itemsToProcess.push({
                                type: 'search',
                                query: `${track.name} ${track.artist}`,
                                name: track.name,
                                metadata: track.metadata,
                                durationMs: track.durationMs,
                                sourceTrack: {
                                    spotifyUrl: track.spotifyUrl || null,
                                    spotifyId: track.spotifyId || null,
                                    name: track.name,
                                    artist: track.artist,
                                    durationMs: track.durationMs,
                                    playlistSource: sourceInfo && sourceInfo.type === 'playlist'
                                        ? {
                                            type: sourceInfo.type,
                                            id: sourceInfo.id,
                                            link: sourceInfo.link,
                                            name: playlistDisplayName,
                                        }
                                        : null,
                                },
                                index: trackIndex++,
                                queuePosition,
                                queueTotal: queuedLinks.length,
                                playlistFolderName,
                                playlistDisplayName,
                                queueItemType: sourceType,
                                queueTrackIndex: trackOffset + 1,
                                queueTrackTotal,
                                playlistOwner: playlistOwner || '',
                            });
                        }
                    }
                } else {
                    youtubeLinkCount++;
                    itemsToProcess.push({
                        type: 'direct',
                        link,
                        index: trackIndex++,
                        queuePosition,
                        queueTotal: queuedLinks.length,
                        playlistFolderName: `Queue ${queuePosition}`,
                        playlistDisplayName: `Queue ${queuePosition}`,
                        queueItemType: 'direct',
                        queueTrackIndex: 1,
                        queueTrackTotal: 1,
                        playlistOwner: '',
                    });
                }
            }

            if (isDownloadCancelled) return;
            const totalItems = itemsToProcess.length;
            stats.totalLinksProcessed = (stats.totalLinksProcessed || 0) + totalItems;
            stats.spotifyLinksProcessed = (stats.spotifyLinksProcessed || 0) + spotifyLinkCount;
            stats.youtubeLinksProcessed = (stats.youtubeLinksProcessed || 0) + youtubeLinkCount;
            mainWindow.webContents.send('update-status', `Phase 1/2: Finding links for ${totalItems} track(s) across ${queuedLinks.length} queue item(s)...`);

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

            const estimateTotalDurationMs = (items) => items.reduce((sum, item) => {
                const durationMs = item?.sourceTrack?.durationMs;
                return sum + (Number.isFinite(durationMs) ? durationMs : 0);
            }, 0);

            const buildProgressPayload = ({
                progress,
                eta,
                phase,
                statusText,
                trackProgress = null,
                contextItem = null,
                totalTrackCount = totalItems,
                totalDurationMs = estimateTotalDurationMs(itemsToProcess),
            }) => {
                const sourceType = contextItem?.queueItemType || (contextItem?.type === 'direct' ? 'direct' : 'playlist');
                const queueLabel = contextItem?.playlistDisplayName || contextItem?.queueLabel || null;
                const trackName = contextItem?.trackName || contextItem?.name || contextItem?.sourceTrack?.name || null;
                const trackArtist = contextItem?.sourceTrack?.artist || '';
                const trackDurationMs = contextItem?.sourceTrack?.durationMs;

                return {
                    progress,
                    eta,
                    phase,
                    statusText,
                    totalQueueItems: queuedLinks.length,
                    totalTracks: totalTrackCount,
                    totalDurationMs: Number.isFinite(totalDurationMs) ? totalDurationMs : 0,
                    queuePosition: Number.isFinite(contextItem?.queuePosition) ? contextItem.queuePosition : null,
                    queueTotal: Number.isFinite(contextItem?.queueTotal) ? contextItem.queueTotal : queuedLinks.length,
                    queueLabel,
                    sourceType,
                    playlistOwner: contextItem?.playlistOwner || '',
                    queueTrackIndex: Number.isFinite(contextItem?.queueTrackIndex) ? contextItem.queueTrackIndex : null,
                    queueTrackTotal: Number.isFinite(contextItem?.queueTrackTotal) ? contextItem.queueTrackTotal : null,
                    trackName,
                    trackArtist,
                    trackDurationMs: Number.isFinite(trackDurationMs) ? trackDurationMs : null,
                    trackProgress: Number.isFinite(trackProgress) ? trackProgress : null,
                };
            };

            const updateOverallProgressDuringLinkFinding = (activeItem = null) => {
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
                const etaText = hasEta ? formatEta(totalEtaMs) : 'calculating...';

                mainWindow.webContents.send('download-progress', buildProgressPayload({
                    progress: overallProgressPercent,
                    eta: etaText,
                    phase: 'finding-links',
                    statusText: activeItem?.name
                        ? `Finding links: ${activeItem.name}`
                        : `Finding links for ${totalItems} track(s)...`,
                    trackProgress: Number.isFinite(activeItem?.index) ? linkProgress[activeItem.index] : null,
                    contextItem: activeItem,
                    totalTrackCount: totalItems,
                }));
            };

            updateOverallProgressDuringLinkFinding();

            const linkFinderWorker = async () => {
                while (linkFindingQueue.length > 0) {
                    if (isDownloadCancelled) return;
                    const item = linkFindingQueue.shift();
                    if (!item) continue;

                    const startedAt = Date.now();
                    linkTrackStartTimes.set(item.index, startedAt);
                    updateOverallProgressDuringLinkFinding(item);

                    try {
                        let youtubeLink;
                        let trackName;
                        let playlistFolderName = item.playlistFolderName;
                        let playlistDisplayName = item.playlistDisplayName;
                        if (item.type === 'search') {
                            const resolved = await resolveTrackLink(item.query, item.name, item.durationMs);
                            youtubeLink = resolved.link;
                            trackName = item.name;
                            mainWindow.webContents.send('update-status', `🔗 [Queue ${item.queuePosition}/${item.queueTotal}] (${item.index + 1}/${totalItems}) Found ${resolved.source} link for: ${trackName}`);
                        } else { // 'direct'
                            youtubeLink = item.link;
                            trackName = await getYouTubeTitle(item.link);
                            if (!playlistDisplayName || playlistDisplayName.startsWith('Queue ')) {
                                playlistDisplayName = trackName || playlistDisplayName;
                            }
                            if (!playlistFolderName || playlistFolderName.startsWith('Queue ')) {
                                playlistFolderName = sanitizeFilename(playlistDisplayName || `Queue ${item.queuePosition}`) || `Queue ${item.queuePosition}`;
                            }
                            mainWindow.webContents.send('update-status', `🔗 [Queue ${item.queuePosition}/${item.queueTotal}] (${item.index + 1}/${totalItems}) Found title: ${trackName}`);
                        }

                        const outputDir = path.join(downloadsDir, playlistFolderName);
                        fs.mkdirSync(outputDir, { recursive: true });

                        itemsToDownload.push({
                            youtubeLink,
                            trackName,
                            index: item.index,
                            metadata: item.metadata,
                            sourceTrack: item.sourceTrack || null,
                            outputDir,
                            queuePosition: item.queuePosition,
                            queueTotal: item.queueTotal,
                            queueLabel: playlistDisplayName,
                            queueItemType: item.queueItemType || 'direct',
                            queueTrackIndex: item.queueTrackIndex || 1,
                            queueTrackTotal: item.queueTrackTotal || 1,
                            playlistOwner: item.playlistOwner || '',
                        });
                    } catch (error) {
                        if (!isDownloadCancelled) {
                            mainWindow.webContents.send('update-status', `❌ [Queue ${item.queuePosition}/${item.queueTotal}] Failed to find link for "${item.name || item.link}": ${error.message}`);
                            stats.songsFailed = (stats.songsFailed || 0) + 1;
                        }
                    } finally {
                        if (!isDownloadCancelled) {
                            const elapsedMs = Date.now() - startedAt;
                            pushTimingSample(elapsedMs, 'linkTrackSamples', 'averageLinkTrackDurationMs');
                            activeLinkTimingEstimates[item.index] = null;
                            linkTrackStartTimes.delete(item.index);
                            linkProgress[item.index] = 100;
                            updateOverallProgressDuringLinkFinding(item);
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
            const queueTotalDurationMs = estimateTotalDurationMs(itemsToDownload);
            if (totalItemsToDownload === 0) {
                mainWindow.webContents.send('download-progress', buildProgressPayload({
                    progress: 100,
                    eta: 'less than a second remaining',
                    phase: 'finding-links',
                    statusText: 'No valid tracks found to download.',
                    totalTrackCount: 0,
                    totalDurationMs: 0,
                }));
                mainWindow.webContents.send('update-status', 'No valid tracks found to download.', true, { success: true, filesDownloaded: 0 });
                return;
            }

            mainWindow.webContents.send('update-status', `Phase 2/2: Downloading ${totalItemsToDownload} track(s) sequentially through ${queuedLinks.length} queue item(s)...`);

            const fileProgress = new Array(totalItemsToDownload).fill(0);
            const activeTrackTimingEstimates = new Array(totalItemsToDownload).fill(null);
            const trackStartTimes = new Map();
            const queueStartTimeMs = Date.now();

            const updateOverallProgress = (activeItem = null, activeTrackProgress = null) => {
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

                mainWindow.webContents.send('download-progress', buildProgressPayload({
                    progress: totalProgress,
                    eta: etaString,
                    phase: 'downloading',
                    statusText: activeItem?.trackName
                        ? `Downloading: ${activeItem.trackName} ${Math.round(Number.isFinite(activeTrackProgress) ? activeTrackProgress : 0)}%`
                        : `Downloading ${totalItemsToDownload} track(s)...`,
                    trackProgress: activeTrackProgress,
                    contextItem: activeItem,
                    totalTrackCount: totalItemsToDownload,
                    totalDurationMs: queueTotalDurationMs,
                }));
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
                            updateOverallProgress(item, progress);
                        });

                        const finishedAt = Date.now();
                        const startTime = trackStartTimes.get(item.queueIndex);
                        if (Number.isFinite(startTime)) {
                            pushTimingSample(finishedAt - startTime, 'trackSamples', 'averageTrackDurationMs');
                        }
                        trackStartTimes.delete(item.queueIndex);
                        activeTrackTimingEstimates[item.queueIndex] = null;
                        fileProgress[item.queueIndex] = 100;
                        updateOverallProgress(item, 100);
                        lastDownloadedFiles.push(filePath);
                        if (item.sourceTrack?.spotifyUrl) {
                            recordDownloadedTrackContext(filePath, item.sourceTrack);
                        }
                        upsertDownloadCacheEntry({
                            sourceUrl: item.youtubeLink,
                            spotifyUrl: item.sourceTrack?.spotifyUrl || null,
                            spotifyId: item.sourceTrack?.spotifyId || null,
                            name: item.sourceTrack?.name || item.trackName,
                            artist: item.sourceTrack?.artist || '',
                            durationMs: Number.isFinite(item.sourceTrack?.durationMs) ? item.sourceTrack.durationMs : null,
                            localPath: filePath,
                            playlistPath: item.outputDir,
                            downloadedAt: new Date().toISOString(),
                        });
                        stats.totalSongsDownloaded = (stats.totalSongsDownloaded || 0) + 1;
                    } catch (error) {
                        trackStartTimes.delete(item.queueIndex);
                        activeTrackTimingEstimates[item.queueIndex] = null;
                        fileProgress[item.queueIndex] = 100;
                        updateOverallProgress(item, 100);

                        if (!isDownloadCancelled) {
                            console.error(`Download worker failed:`, error.message);
                            stats.songsFailed = (stats.songsFailed || 0) + 1;
                        }
                    }
                }
            };
            await Promise.all(Array.from({ length: downloadConcurrency }, downloadWorker));

            if (!isDownloadCancelled) {
                if (totalItemsToDownload > 0) {
                    pushTimingSample(Date.now() - queueStartTimeMs, 'queueSamples', 'averageQueueDurationMs');
                }
                mainWindow.webContents.send('download-progress', buildProgressPayload({
                    progress: 100,
                    eta: 'less than a second remaining',
                    phase: 'downloading',
                    statusText: 'Download queue finished.',
                    totalTrackCount: totalItemsToDownload,
                    totalDurationMs: queueTotalDurationMs,
                }));
                mainWindow.webContents.send('update-status', 'Task done.', true, { success: true, filesDownloaded: lastDownloadedFiles.length });
            }

        } catch (error) {
            console.error('An error occurred during the download process:', error);
            mainWindow.webContents.send('update-status', `Error: ${error.message}`, true, { success: false });
        } finally {
            if (!isDownloadCancelled) saveStats();
        }
    });

    function persistPlaylistSyncCacheFromMoves(playlistPath, movedTracks = []) {
        if (!playlistPath || !Array.isArray(movedTracks) || movedTracks.length === 0) return;

        const playlistSourceTracks = movedTracks
            .map(item => item.context)
            .filter(ctx => ctx?.playlistSource?.type === 'playlist' && ctx.spotifyUrl);

        if (playlistSourceTracks.length === 0) return;

        const sourceGroups = new Map();
        for (const track of playlistSourceTracks) {
            const sourceKey = `${track.playlistSource.id || ''}::${track.playlistSource.link || ''}`;
            if (!sourceGroups.has(sourceKey)) {
                sourceGroups.set(sourceKey, { count: 0, source: track.playlistSource });
            }
            sourceGroups.get(sourceKey).count += 1;
        }

        const primarySource = Array.from(sourceGroups.values())
            .sort((a, b) => b.count - a.count)[0]?.source;

        if (!primarySource) return;

        const entry = ensurePlaylistSyncEntry(playlistPath);
        if (!entry) return;

        entry.source = {
            link: primarySource.link || null,
            type: primarySource.type || 'playlist',
            id: primarySource.id || null,
            name: primarySource.name || path.basename(playlistPath),
            lastSyncedAt: new Date().toISOString(),
        };

        entry.tracks = {};

        for (const movedTrack of movedTracks) {
            const context = movedTrack.context;
            if (!context?.spotifyUrl) continue;
            if (context?.playlistSource?.id !== primarySource.id) continue;

            entry.tracks[context.spotifyUrl] = {
                spotifyUrl: context.spotifyUrl,
                spotifyId: context.spotifyId || null,
                name: context.name || '',
                artist: context.artist || '',
                durationMs: Number.isFinite(context.durationMs) ? context.durationMs : null,
                position: Number.isFinite(movedTrack.position) ? movedTrack.position : null,
                localPath: movedTrack.newPath,
                updatedAt: new Date().toISOString(),
            };
        }

        savePlaylistSyncCache();
    }

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
            const movedTracks = [];
            for (const oldPath of lastDownloadedFiles) {
                if (fs.existsSync(oldPath)) {
                    const newPath = path.join(folderName, path.basename(oldPath));
                    fs.renameSync(oldPath, newPath);
                    moveDownloadCachePath(oldPath, newPath);
                    const context = lastDownloadedTrackContexts[normalizePathKey(oldPath)] || null;
                    movedTracks.push({ oldPath, newPath, position: movedCount, context });
                    movedCount++;
                }
            }

            if (hasPlaylistSourceContextForDownloads()) {
                persistPlaylistSyncCacheFromMoves(folderName, movedTracks);
            }

            lastDownloadedFiles = [];
            lastDownloadedTrackContexts = {};
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

        const cleanupDownloadedPath = (filePath, deletedPathSet) => {
            const normalizedPath = normalizePathKey(filePath);
            if (!normalizedPath || deletedPathSet.has(normalizedPath)) return;

            try {
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                }
                removeDownloadCacheEntry(filePath);
                deletedPathSet.add(normalizedPath);
            } catch (error) {
                console.error('Failed to delete canceled download file:', filePath, error);
            }
        };

        const cleanupPartialArtifacts = (artifact, deletedPathSet) => {
            if (!artifact || typeof artifact !== 'object') return;

            const { outputDir, filePrefix, finalPath } = artifact;
            cleanupDownloadedPath(finalPath, deletedPathSet);

            if (!outputDir || !filePrefix || !fs.existsSync(outputDir)) return;

            const lowerPrefix = String(filePrefix).toLowerCase();
            const isTempArtifact = (name) => {
                const loweredName = name.toLowerCase();
                if (!loweredName.startsWith(lowerPrefix)) return false;
                return loweredName.endsWith('.part')
                    || loweredName.includes('.part-frag')
                    || loweredName.endsWith('.tmp')
                    || loweredName.endsWith('.temp')
                    || loweredName.endsWith('.ytdl');
            };

            try {
                const candidates = fs.readdirSync(outputDir);
                for (const fileName of candidates) {
                    if (!isTempArtifact(fileName)) continue;
                    const filePath = path.join(outputDir, fileName);
                    cleanupDownloadedPath(filePath, deletedPathSet);
                }
            } catch (error) {
                console.error('Failed to clean partial artifacts for canceled download:', artifact, error);
            }
        };

        for (const proc of activeProcesses) {
            try { proc.kill('SIGTERM'); } catch (err) { console.error('Failed to kill process:', err); }
        }
        activeProcesses.clear();

        const deletedPathSet = new Set();
        for (const artifact of activeDownloadArtifacts.values()) {
            cleanupPartialArtifacts(artifact, deletedPathSet);
        }
        activeDownloadArtifacts.clear();

        for (const downloadedPath of lastDownloadedFiles) {
            cleanupDownloadedPath(downloadedPath, deletedPathSet);
        }
        lastDownloadedFiles = [];
        lastDownloadedTrackContexts = {};

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
        const sourceInfo = parseSpotifyLinkInfo(link);
        const match = sourceInfo ? [null, sourceInfo.type, sourceInfo.id] : null;
        if (!match) return { error: 'Invalid Spotify link' };

        const type = match[1];
        const id = match[2];
        let tracks = [];
        let playlistName = null;
        let playlistOwner = '';

        try {
            if (type === 'playlist') {
                const playlistData = await spotifyApi.getPlaylist(id);
                playlistName = playlistData.body.name;
                playlistOwner = playlistData.body.owner?.display_name || '';
                let offset = 0;
                let total = playlistData.body.tracks.total;
                while (offset < total) {
                    const data = await spotifyApi.getPlaylistTracks(id, { offset, limit: 100 });
                    tracks.push(...data.body.items.map(item => {
                        if (!item.track) return null;
                        const track = item.track;
                        return {
                            spotifyUrl: track.external_urls?.spotify || (track.id ? `https://open.spotify.com/track/${track.id}` : null),
                            spotifyId: track.id || null,
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
                playlistOwner = Array.isArray(albumData.body.artists)
                    ? albumData.body.artists.map(artist => artist.name).join(', ')
                    : '';
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
                        spotifyUrl: track.external_urls?.spotify || (track.id ? `https://open.spotify.com/track/${track.id}` : null),
                        spotifyId: track.id || null,
                        name: track.name,
                        artist: track.artists.map(a => a.name).join(', '),
                        durationMs: track.duration_ms,
                    })));
                    offset += 50;
                }
            } else if (type === 'track') {
                const data = await spotifyApi.getTrack(id);
                const track = data.body;
                playlistOwner = Array.isArray(track.artists)
                    ? track.artists.map(artist => artist.name).join(', ')
                    : '';
                tracks.push({
                    spotifyUrl: track.external_urls?.spotify || (track.id ? `https://open.spotify.com/track/${track.id}` : null),
                    spotifyId: track.id || null,
                    name: track.name,
                    artist: track.artists.map(a => a.name).join(', '),
                    durationMs: track.duration_ms,
                });
            }
            return { tracks: tracks.filter(Boolean), playlistName, playlistOwner, sourceInfo };
        } catch (error) {
            let userMessage = `Error fetching from Spotify: ${error.message}`;
            if (error.statusCode === 404) userMessage = 'Error: Spotify resource not found. Check if the link is correct and the playlist/album is public.';
            else if (error.statusCode === 401) userMessage = 'Error: Bad or expired Spotify token. Check credentials in Settings.';
            else if (error.statusCode === 403) userMessage = 'Error: Not authorized to access this resource. It may be a private playlist.';
            mainWindow.webContents.send('update-status', userMessage);
            return { error: userMessage };
        }
    }

    function normalizeSpotifyIdentity(value) {
        if (typeof value !== 'string') return '';
        return value.trim().toLowerCase();
    }

    function isSpotifyTrackChanged(previousTrack, nextTrack) {
        if (!previousTrack || !nextTrack) return true;
        const prevName = normalizeSpotifyIdentity(previousTrack.name);
        const nextName = normalizeSpotifyIdentity(nextTrack.name);
        if (prevName !== nextName) return true;

        const prevArtist = normalizeSpotifyIdentity(previousTrack.artist);
        const nextArtist = normalizeSpotifyIdentity(nextTrack.artist);
        if (prevArtist !== nextArtist) return true;

        const prevDuration = Number.isFinite(previousTrack.durationMs) ? previousTrack.durationMs : null;
        const nextDuration = Number.isFinite(nextTrack.durationMs) ? nextTrack.durationMs : null;
        if (prevDuration === null || nextDuration === null) {
            return prevDuration !== nextDuration;
        }

        return Math.abs(prevDuration - nextDuration) > 1500;
    }

    async function applySafeRenameOperations(renameOperations) {
        if (!Array.isArray(renameOperations) || renameOperations.length === 0) return;

        const staged = [];
        const stamp = Date.now();
        let tempIndex = 0;

        for (const operation of renameOperations) {
            if (!operation?.from || !operation?.to || operation.from === operation.to) continue;
            if (!fs.existsSync(operation.from)) continue;

            const ext = path.extname(operation.from);
            const tmpPath = path.join(path.dirname(operation.from), `.__sl_sync_tmp_${stamp}_${tempIndex}${ext}`);
            tempIndex += 1;
            await fs.promises.rename(operation.from, tmpPath);
            moveTrackTagsPath(operation.from, tmpPath);
            staged.push({
                from: operation.from,
                tmpPath,
                to: operation.to,
            });
        }

        for (const operation of staged) {
            if (fs.existsSync(operation.to)) {
                await fs.promises.rm(operation.to, { force: true });
            }
            await fs.promises.rename(operation.tmpPath, operation.to);
            moveTrackTagsPath(operation.tmpPath, operation.to);
        }
    }

    async function syncPlaylistWithSource(playlistPath) {
        if (!playlistPath || typeof playlistPath !== 'string') {
            return { success: false, error: 'Playlist path is required.' };
        }
        if (!fs.existsSync(playlistPath)) {
            return { success: false, error: 'Playlist folder does not exist.' };
        }

        const entry = getPlaylistSyncEntry(playlistPath);
        if (!entry?.source?.link || entry.source.type !== 'playlist') {
            return { success: false, error: 'This playlist has no Spotify source metadata to sync from yet.' };
        }

        await refreshSpotifyToken();
        const spotifyFetchResult = await getSpotifyTracks(entry.source.link);
        if (spotifyFetchResult?.error) {
            return { success: false, error: spotifyFetchResult.error };
        }

        const remoteTracks = Array.isArray(spotifyFetchResult.tracks)
            ? spotifyFetchResult.tracks.filter(track => track?.spotifyUrl)
            : [];
        const remotePlaylistNameRaw = spotifyFetchResult.playlistName || entry.source.name || path.basename(playlistPath);

        let effectivePlaylistPath = playlistPath;
        const remotePlaylistName = sanitizeFilename(remotePlaylistNameRaw);
        const currentPlaylistName = path.basename(playlistPath);
        if (remotePlaylistName && remotePlaylistName !== currentPlaylistName) {
            const renamedPath = path.join(path.dirname(playlistPath), remotePlaylistName);
            if (!fs.existsSync(renamedPath)) {
                await fs.promises.rename(playlistPath, renamedPath);
                movePlaylistTagsPath(playlistPath, renamedPath);
                movePlaylistSyncEntry(playlistPath, renamedPath);
                moveDownloadCachePlaylistPath(playlistPath, renamedPath);
                effectivePlaylistPath = renamedPath;
            }
        }

        const freshEntry = getPlaylistSyncEntry(effectivePlaylistPath) || entry;
        const cachedTracks = freshEntry?.tracks || {};
        const remoteTrackByUrl = new Map(remoteTracks.map(track => [track.spotifyUrl, track]));
        const cachedUrls = Object.keys(cachedTracks);
        const removedUrls = cachedUrls.filter(url => !remoteTrackByUrl.has(url));
        const addedUrls = remoteTracks.filter(track => !cachedTracks[track.spotifyUrl]).map(track => track.spotifyUrl);

        const changedUrls = [];
        for (const track of remoteTracks) {
            const previous = cachedTracks[track.spotifyUrl];
            if (!previous) continue;
            const localPath = previous.localPath;
            const localMissing = !localPath || !fs.existsSync(localPath);
            if (localMissing || isSpotifyTrackChanged(previous, track)) {
                changedUrls.push(track.spotifyUrl);
            }
        }

        let removedCount = 0;
        for (const spotifyUrl of removedUrls) {
            const cachedTrack = cachedTracks[spotifyUrl];
            if (cachedTrack?.localPath) {
                removeDownloadCacheByLocalPath(cachedTrack.localPath);
            }
            if (cachedTrack?.localPath && fs.existsSync(cachedTrack.localPath)) {
                await fs.promises.rm(cachedTrack.localPath, { force: true });
                removedCount += 1;
            }
            delete cachedTracks[spotifyUrl];
        }

        const urlsToDownload = new Set([...addedUrls, ...changedUrls]);
        const downloadedPathByUrl = new Map();
        for (const spotifyUrl of urlsToDownload) {
            const track = remoteTrackByUrl.get(spotifyUrl);
            if (!track) continue;

            const query = `${track.name} ${track.artist}`;
            const resolved = await resolveTrackLink(query, track.name, track.durationMs);
            const temporaryOutputDir = path.join(effectivePlaylistPath, '.__sync_tmp__');
            fs.mkdirSync(temporaryOutputDir, { recursive: true });

            const filePath = await downloadItem(
                {
                    youtubeLink: resolved.link,
                    trackName: track.name,
                    outputDir: temporaryOutputDir,
                    queuePosition: 1,
                    queueTotal: 1,
                    queueLabel: 'Playlist Sync',
                },
                0,
                1,
                () => {}
            );

            downloadedPathByUrl.set(spotifyUrl, filePath);
        }

        const renameOperations = [];
        const nextTracks = {};

        for (let index = 0; index < remoteTracks.length; index += 1) {
            const track = remoteTracks[index];
            const spotifyUrl = track.spotifyUrl;
            const previous = cachedTracks[spotifyUrl] || null;
            const downloadedPath = downloadedPathByUrl.get(spotifyUrl) || null;
            const sourcePath = downloadedPath || previous?.localPath || null;
            if (!sourcePath || !fs.existsSync(sourcePath)) continue;

            const extension = path.extname(sourcePath) || `.${config.fileExtension || 'm4a'}`;
            const desiredBaseName = `${String(index + 1).padStart(3, '0')} - ${sanitizeFilename(track.name) || 'Track'}`;
            const desiredPath = path.join(effectivePlaylistPath, `${desiredBaseName}${extension}`);

            if (normalizePathKey(sourcePath) !== normalizePathKey(desiredPath)) {
                renameOperations.push({ from: sourcePath, to: desiredPath });
            }

            nextTracks[spotifyUrl] = {
                spotifyUrl,
                spotifyId: track.spotifyId || null,
                name: track.name,
                artist: track.artist,
                durationMs: Number.isFinite(track.durationMs) ? track.durationMs : null,
                position: index,
                localPath: desiredPath,
                updatedAt: new Date().toISOString(),
            };

            upsertDownloadCacheEntry({
                sourceUrl: downloadedPath ? null : previous?.sourceUrl || null,
                spotifyUrl,
                spotifyId: track.spotifyId || null,
                name: track.name,
                artist: track.artist,
                durationMs: Number.isFinite(track.durationMs) ? track.durationMs : null,
                localPath: desiredPath,
                playlistPath: effectivePlaylistPath,
            });
        }

        await applySafeRenameOperations(renameOperations);

        const temporarySyncDir = path.join(effectivePlaylistPath, '.__sync_tmp__');
        if (fs.existsSync(temporarySyncDir)) {
            await fs.promises.rm(temporarySyncDir, { recursive: true, force: true });
        }

        const syncedEntry = ensurePlaylistSyncEntry(effectivePlaylistPath);
        syncedEntry.source = {
            ...freshEntry.source,
            name: remotePlaylistNameRaw,
            lastSyncedAt: new Date().toISOString(),
        };
        syncedEntry.tracks = nextTracks;
        savePlaylistSyncCache();
        saveDownloadCache();

        return {
            success: true,
            playlistPath: effectivePlaylistPath,
            playlistRenamed: effectivePlaylistPath !== playlistPath,
            summary: {
                remoteCount: remoteTracks.length,
                added: addedUrls.length,
                changed: changedUrls.length,
                removed: removedUrls.length,
                filesRemoved: removedCount,
            },
        };
    }

    ipcMain.handle('sync-playlist-with-source', async (_event, playlistPath) => {
        try {
            return await syncPlaylistWithSource(playlistPath);
        } catch (error) {
            return {
                success: false,
                error: error?.message || 'Playlist sync failed unexpectedly.',
            };
        }
    });

    function sanitizeFilename(name) {
        return name.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim();
    }

    function runYtdlp(args) {
        return new Promise((resolve, reject) => {
            if (isDownloadCancelled) return reject(new Error('Operation cancelled'));
            const ytdlpInstance = getNextYtdlpInstance();
            if (!ytdlpInstance) return reject(new Error('No yt-dlp executable found.'));
            const proc = spawn(ytdlpInstance.executablePath, [...getYtdlpCommonArgs(ytdlpInstance), ...args], { cwd: ytdlpInstance.rootPath });
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

    function parseDurationToMs(durationText) {
        if (typeof durationText !== 'string') return null;
        const trimmed = durationText.trim();
        if (!trimmed) return null;

        const numericSeconds = Number.parseFloat(trimmed);
        if (Number.isFinite(numericSeconds)) {
            return Math.round(numericSeconds * 1000);
        }

        const timeParts = trimmed.split(':').map(part => Number.parseInt(part, 10));
        if (timeParts.length >= 2 && timeParts.every(value => Number.isFinite(value) && value >= 0)) {
            let seconds = 0;
            for (const part of timeParts) {
                seconds = (seconds * 60) + part;
            }
            return Math.round(seconds * 1000);
        }

        return null;
    }

    function parseSearchCandidates(rawOutput) {
        return rawOutput
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(Boolean)
            .map(line => {
                const [url = '', durationText = ''] = line.split('\t');
                return {
                    url: url.trim(),
                    durationMs: parseDurationToMs(durationText),
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

    async function searchCandidates(providerPrefix, query, expectedDurationMs, maxResults = 5, options = {}) {
        const {
            allowClosestMatch = false,
            allowFallbackAny = false,
        } = options;

        const rawOutput = await runYtdlp([
            '--flat-playlist',
            '--print', '%(webpage_url)s\t%(duration)s',
            `${providerPrefix}${maxResults}:${query}`,
        ]);

        const candidates = parseSearchCandidates(rawOutput);
        if (candidates.length === 0) return null;

        const strictMatch = candidates.find(candidate => isDurationMatch(candidate.durationMs, expectedDurationMs));
        if (strictMatch) return strictMatch;

        if (allowClosestMatch && Number.isFinite(expectedDurationMs) && expectedDurationMs > 0) {
            const candidatesWithDuration = candidates.filter(candidate => Number.isFinite(candidate.durationMs) && candidate.durationMs > 0);
            if (candidatesWithDuration.length > 0) {
                const closest = candidatesWithDuration.reduce((best, candidate) => {
                    const bestDistance = Math.abs(best.durationMs - expectedDurationMs);
                    const candidateDistance = Math.abs(candidate.durationMs - expectedDurationMs);
                    return candidateDistance < bestDistance ? candidate : best;
                });

                const relaxedToleranceMs = Math.max(getDurationToleranceMs() * 2, 45_000);
                if (Math.abs(closest.durationMs - expectedDurationMs) <= relaxedToleranceMs) {
                    return closest;
                }
            }
        }

        return allowFallbackAny ? candidates[0] : null;
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
        const cacheKey = query.trim().toLowerCase();
        const cachedLink = linkCache[cacheKey] || linkCache[query];
        if (cachedLink) {
            mainWindow.webContents.send('update-status', `⚡ [Cache] Using cached link for: ${trackName}`);
            return { link: cachedLink, source: 'cache' };
        }

        const youtubeMatch = await searchCandidates('ytsearch', query, expectedDurationMs);
        if (youtubeMatch) {
            linkCache[cacheKey] = youtubeMatch.url;
            saveCache();
            return { link: youtubeMatch.url, source: 'youtube' };
        }

        mainWindow.webContents.send('update-status', `⚠️ No duration-matching YouTube result for: ${trackName}. Trying SoundCloud...`);
        const soundCloudMatch = await searchCandidates('scsearch', query, expectedDurationMs, 8, {
            allowClosestMatch: true,
            allowFallbackAny: true,
        });
        if (soundCloudMatch) {
            const matchedStrictly = isDurationMatch(soundCloudMatch.durationMs, expectedDurationMs);
            if (!matchedStrictly) {
                mainWindow.webContents.send('update-status', `ℹ️ Using best available SoundCloud result for: ${trackName} (strict duration match unavailable).`);
            }
            linkCache[cacheKey] = soundCloudMatch.url;
            saveCache();
            return { link: soundCloudMatch.url, source: 'soundcloud' };
        }

        mainWindow.webContents.send('update-status', `⚠️ No duration-matching SoundCloud result for: ${trackName}.`);
        const manualLink = await requestManualLink(trackName, query);
        if (manualLink) {
            linkCache[cacheKey] = manualLink;
            saveCache();
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
        const { youtubeLink: link, trackName, outputDir, queuePosition, queueTotal, queueLabel } = item;
        const sanitizedTrackName = sanitizeFilename(trackName);
        const safeOutputDir = outputDir && outputDir.trim() ? outputDir : downloadsDir;
        fs.mkdirSync(safeOutputDir, { recursive: true });
        const numberPrefix = (index + 1).toString().padStart(3, '0');
        const outputTemplate = path.join(safeOutputDir, `${numberPrefix} - ${sanitizedTrackName}.%(ext)s`);
        const audioFormat = config.fileExtension || 'm4a';
        const queuePrefix = Number.isFinite(queuePosition) && Number.isFinite(queueTotal)
            ? `[Queue ${queuePosition}/${queueTotal}${queueLabel ? `: ${queueLabel}` : ''}] `
            : '';
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
            const ytdlpInstance = getNextYtdlpInstance();
            if (!ytdlpInstance) return reject(new Error('No yt-dlp executable found.'));
            const proc = spawn(ytdlpInstance.executablePath, [...getYtdlpCommonArgs(ytdlpInstance), ...args], { cwd: ytdlpInstance.rootPath });
            activeProcesses.add(proc);
            let finalPath = '';
            activeDownloadArtifacts.set(proc, {
                outputDir: safeOutputDir,
                filePrefix: `${numberPrefix} - ${sanitizedTrackName}.`,
                finalPath: '',
            });
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
                    const existingArtifact = activeDownloadArtifacts.get(proc);
                    if (existingArtifact) {
                        existingArtifact.finalPath = finalPath;
                    }
                }
            };

            const findFallbackDownloadedPath = () => {
                const expectedWithConfiguredExt = path.join(safeOutputDir, `${numberPrefix} - ${sanitizedTrackName}.${audioFormat}`);
                if (fs.existsSync(expectedWithConfiguredExt)) {
                    return expectedWithConfiguredExt;
                }

                try {
                    const expectedPrefix = `${numberPrefix} - ${sanitizedTrackName}.`;
                    const matchedFile = fs.readdirSync(safeOutputDir)
                        .find(fileName => fileName.startsWith(expectedPrefix));
                    if (matchedFile) {
                        return path.join(safeOutputDir, matchedFile);
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
                activeDownloadArtifacts.delete(proc);
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
                    mainWindow.webContents.send('update-status', `✅ ${queuePrefix}[${index + 1}/${total}] Finished: "${sanitizedTrackName}"`);
                    resolve(finalPath);
                } else {
                    const errorMsg = `❌ ${queuePrefix}[${index + 1}/${total}] Failed: "${sanitizedTrackName}" (yt-dlp exit code ${code})`;
                    mainWindow.webContents.send('update-status', errorMsg);
                    reject(new Error(errorMsg));
                }
            });
            proc.on('error', (err) => {
                activeProcesses.delete(proc);
                activeDownloadArtifacts.delete(proc);
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
    const executableName = IS_WINDOWS ? `${toolName}.exe` : toolName;
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

function loadMetadataCache() {
    try {
        if (fs.existsSync(metadataCachePath)) {
            const parsed = JSON.parse(fs.readFileSync(metadataCachePath, 'utf-8'));
            metadataCache = parsed && typeof parsed === 'object' ? parsed : {};
        } else {
            metadataCache = {};
            fs.writeFileSync(metadataCachePath, JSON.stringify(metadataCache, null, 4));
        }
    } catch (error) {
        console.error('Failed to load or create metadata cache file:', error);
        metadataCache = {};
    }
}

function saveMetadataCache() {
    try {
        safeWriteFileSync(metadataCachePath, JSON.stringify(metadataCache, null, 4));
    } catch (error) {
        console.error('Failed to save metadata cache file:', error);
    }
}

function loadTrackPlayCounts() {
    try {
        if (fs.existsSync(trackPlayCountsPath)) {
            const parsed = JSON.parse(fs.readFileSync(trackPlayCountsPath, 'utf-8'));
            trackPlayCounts = parsed && typeof parsed === 'object' ? parsed : {};
        } else {
            trackPlayCounts = {};
            fs.writeFileSync(trackPlayCountsPath, JSON.stringify(trackPlayCounts, null, 4));
        }
    } catch (error) {
        console.error('Failed to load or create track play counts file:', error);
        trackPlayCounts = {};
    }
}

function saveTrackPlayCounts() {
    try {
        safeWriteFileSync(trackPlayCountsPath, JSON.stringify(trackPlayCounts, null, 4));
    } catch (error) {
        console.error('Failed to save track play counts file:', error);
    }
}

function isSmartPlaylistPath(playlistPath) {
    return playlistPath === SMART_PLAYLIST_RECENTLY_ADDED || playlistPath === SMART_PLAYLIST_MOST_PLAYED;
}

function isSmartPlaylistsEnabled() {
    return config.enableSmartPlaylists !== false;
}

function isLibraryPerformanceModeEnabled() {
    return config.libraryPerformanceMode !== false;
}

async function getTrackStatSafe(filePath) {
    try {
        return await fs.promises.stat(filePath);
    } catch {
        return null;
    }
}

async function getTrackMetadata(filePath, options = {}) {
    const useCache = options.useCache !== false;
    const trackStat = await getTrackStatSafe(filePath);
    if (!trackStat) {
        return {
            metadata: {
                durationSeconds: 0,
                bitrateKbps: null,
                artist: null,
                album: null,
                genre: null,
                title: path.parse(filePath).name,
                source: 'Unknown',
            },
            cacheUpdated: false,
            stat: null,
        };
    }

    const cacheKey = filePath;
    const existing = metadataCache[cacheKey];
    const cacheValid = Boolean(
        existing
        && useCache
        && existing.mtimeMs === trackStat.mtimeMs
        && existing.size === trackStat.size
    );

    if (cacheValid) {
        return {
            metadata: {
                durationSeconds: existing.durationSeconds || 0,
                bitrateKbps: Number.isFinite(existing.bitrateKbps) ? existing.bitrateKbps : null,
                artist: existing.artist || null,
                album: existing.album || null,
                genre: existing.genre || null,
                title: existing.title || path.parse(filePath).name,
                source: existing.source || 'Unknown',
            },
            cacheUpdated: false,
            stat: trackStat,
        };
    }

    let parsedMetadata = null;
    try {
        parsedMetadata = await mm.parseFile(filePath, { duration: true, skipCovers: true });
    } catch {
        parsedMetadata = null;
    }

    const durationSeconds = Number.isFinite(parsedMetadata?.format?.duration) ? parsedMetadata.format.duration : 0;
    const bitrateRaw = parsedMetadata?.format?.bitrate;
    const bitrateKbps = Number.isFinite(bitrateRaw) ? Math.round(bitrateRaw / 1000) : null;
    const artist = parsedMetadata?.common?.artist || parsedMetadata?.common?.albumartist || null;
    const album = parsedMetadata?.common?.album || null;
    const genre = Array.isArray(parsedMetadata?.common?.genre)
        ? parsedMetadata.common.genre.join(', ')
        : (parsedMetadata?.common?.genre || null);
    const title = parsedMetadata?.common?.title || path.parse(filePath).name;
    const source = inferTrackSource(filePath, parsedMetadata);

    metadataCache[cacheKey] = {
        mtimeMs: trackStat.mtimeMs,
        size: trackStat.size,
        durationSeconds,
        bitrateKbps,
        artist,
        album,
        genre,
        title,
        source,
    };

    return {
        metadata: {
            durationSeconds,
            bitrateKbps,
            artist,
            album,
            genre,
            title,
            source,
        },
        cacheUpdated: true,
        stat: trackStat,
    };
}

async function getPhysicalPlaylists(playlistsPath) {
    if (!playlistsPath || !fs.existsSync(playlistsPath)) return [];
    const entries = await fs.promises.readdir(playlistsPath, { withFileTypes: true });
    const directories = entries.filter(entry => entry.isDirectory());
    return directories.map(entry => {
        const playlistPath = path.join(playlistsPath, entry.name);
        return {
            name: entry.name,
            path: playlistPath,
            isSmart: false,
            tags: getPlaylistTagsForPath(playlistPath),
        };
    });
}

async function getAllTrackEntriesFromLibrary(playlistsPath, options = {}) {
    const useCache = options.useCache !== false;
    const playlists = await getPhysicalPlaylists(playlistsPath);
    const entries = [];
    let cacheUpdated = false;

    for (const playlist of playlists) {
        const files = await fs.promises.readdir(playlist.path);
        const trackFiles = files.filter(file => supportedExtensions.includes(path.extname(file).toLowerCase()));

        for (const file of trackFiles) {
            const ext = path.extname(file).toLowerCase();
            const filePath = path.join(playlist.path, file);
            const metadataResult = await getTrackMetadata(filePath, { useCache });
            cacheUpdated = cacheUpdated || metadataResult.cacheUpdated;
            const stat = metadataResult.stat || await getTrackStatSafe(filePath);

            entries.push({
                name: path.basename(file, ext),
                path: filePath,
                playlistPath: playlist.path,
                playlistName: playlist.name,
                duration: metadataResult.metadata.durationSeconds,
                tags: getTrackTagsForPath(filePath),
                artist: metadataResult.metadata.artist,
                addedAtMs: stat?.birthtimeMs || stat?.ctimeMs || stat?.mtimeMs || 0,
                modifiedAtMs: stat?.mtimeMs || 0,
                playCount: Number.isFinite(trackPlayCounts[filePath]) ? trackPlayCounts[filePath] : 0,
            });
        }
    }

    return { entries, cacheUpdated };
}

async function getSmartPlaylistTracks(playlistPath) {
    const playlistsPath = config.playlistsFolderPath;
    if (!playlistsPath || !fs.existsSync(playlistsPath)) {
        return { tracks: [], totalDuration: 0, cacheUpdated: false };
    }

    const { entries, cacheUpdated } = await getAllTrackEntriesFromLibrary(playlistsPath, {
        useCache: isLibraryPerformanceModeEnabled(),
    });

    let selectedTracks = [];
    if (playlistPath === SMART_PLAYLIST_RECENTLY_ADDED) {
        selectedTracks = entries
            .sort((a, b) => b.addedAtMs - a.addedAtMs)
            .slice(0, 200);
    } else if (playlistPath === SMART_PLAYLIST_MOST_PLAYED) {
        selectedTracks = entries
            .filter(track => (track.playCount || 0) > 0)
            .sort((a, b) => {
                if (b.playCount !== a.playCount) return b.playCount - a.playCount;
                return b.modifiedAtMs - a.modifiedAtMs;
            })
            .slice(0, 200);
    }

    const tracks = selectedTracks.map(track => ({
        name: track.name,
        path: track.path,
        duration: track.duration,
        tags: track.tags,
    }));
    const totalDuration = tracks.reduce((sum, track) => sum + (Number.isFinite(track.duration) ? track.duration : 0), 0);
    return { tracks, totalDuration, cacheUpdated };
}

function formatDurationClock(totalSeconds) {
    const safeSeconds = Number.isFinite(totalSeconds) && totalSeconds > 0
        ? Math.floor(totalSeconds)
        : 0;
    const hours = Math.floor(safeSeconds / 3600);
    const minutes = Math.floor((safeSeconds % 3600) / 60);
    const seconds = safeSeconds % 60;

    if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }

    return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function sanitizeTrayText(value, fallback = '—') {
    if (typeof value !== 'string') return fallback;
    const trimmed = value.trim();
    if (!trimmed) return fallback;
    return trimmed.length > 72 ? `${trimmed.slice(0, 69)}...` : trimmed;
}

function sendTrayCommandToRenderer(channel, payload = {}) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send(channel, payload);
}

function buildTrayContextMenuTemplate() {
    const trackName = sanitizeTrayText(trayPlaybackState.trackName, 'Nothing playing');
    const playlistName = sanitizeTrayText(trayPlaybackState.playlistName, '—');
    const progressText = `${formatDurationClock(trayPlaybackState.currentTimeSeconds)} / ${formatDurationClock(trayPlaybackState.durationSeconds)}`;
    const sleepTimerText = trayPlaybackState.sleepTimerActive
        ? `⏳ Sleep Timer: ${formatDurationClock(trayPlaybackState.sleepTimerRemainingSeconds)} remaining`
        : '⏳ Sleep Timer: Off';

    return [
        { label: 'Show App', click: () => mainWindow?.show() },
        { type: 'separator' },
        {
            label: 'Playback Controls',
            submenu: [
                { label: '▶ Play', click: () => sendTrayCommandToRenderer('tray-playback-command', { command: 'play' }) },
                { label: '⏹ Stop', click: () => sendTrayCommandToRenderer('tray-playback-command', { command: 'stop' }) },
            ],
        },
        {
            label: 'Sleep Timer',
            submenu: [
                { label: '15 minutes', click: () => sendTrayCommandToRenderer('tray-sleep-timer-command', { minutes: 15 }) },
                { label: '30 minutes', click: () => sendTrayCommandToRenderer('tray-sleep-timer-command', { minutes: 30 }) },
                { label: '45 minutes', click: () => sendTrayCommandToRenderer('tray-sleep-timer-command', { minutes: 45 }) },
                { label: '60 minutes', click: () => sendTrayCommandToRenderer('tray-sleep-timer-command', { minutes: 60 }) },
                { type: 'separator' },
                { label: 'Cancel Timer', click: () => sendTrayCommandToRenderer('tray-sleep-timer-command', { minutes: 0 }) },
            ],
        },
        { type: 'separator' },
        { label: `♫ ${trackName}`, enabled: false },
        { label: `📁 ${playlistName}`, enabled: false },
        { label: `⏱ ${progressText}`, enabled: false },
        { label: sleepTimerText, enabled: false },
        { type: 'separator' },
        {
            label: 'Quit',
            click: () => {
                app.isQuitting = true;
                app.quit();
            },
        },
    ];
}

function refreshTrayContextMenu() {
    if (!tray) return;
    const contextMenu = Menu.buildFromTemplate(buildTrayContextMenuTemplate());
    tray.setContextMenu(contextMenu);

    const tooltipTrack = sanitizeTrayText(trayPlaybackState.trackName, 'Nothing playing');
    const tooltipSleep = trayPlaybackState.sleepTimerActive
        ? `Sleep ${formatDurationClock(trayPlaybackState.sleepTimerRemainingSeconds)}`
        : 'Sleep Off';
    const tooltipPrefix = trayPlaybackState.isPlaying ? 'Playing' : 'Paused';
    tray.setToolTip(`SoundLink • ${tooltipPrefix}\n${tooltipTrack}\n${tooltipSleep}`);
}

function loadPlaylistTags() {
    try {
        if (fs.existsSync(playlistTagsPath)) {
            const parsed = JSON.parse(fs.readFileSync(playlistTagsPath, 'utf-8'));
            playlistTags = parsed && typeof parsed === 'object' ? parsed : {};
        } else {
            playlistTags = {};
            fs.writeFileSync(playlistTagsPath, JSON.stringify(playlistTags, null, 4));
        }
    } catch (error) {
        console.error('Failed to load or create playlist tags file:', error);
        playlistTags = {};
    }
}

function savePlaylistTags() {
    try {
        safeWriteFileSync(playlistTagsPath, JSON.stringify(playlistTags, null, 4));
    } catch (error) {
        console.error('Failed to save playlist tags file:', error);
    }
}

function getPlaylistTagsForPath(playlistPath) {
    if (!playlistPath || typeof playlistPath !== 'string') return [];
    return normalizeTagList(playlistTags[playlistPath]);
}

function setPlaylistTagsForPath(playlistPath, tags) {
    if (!playlistPath || typeof playlistPath !== 'string') return;
    const normalized = normalizeTagList(tags);
    if (normalized.length === 0) {
        delete playlistTags[playlistPath];
    } else {
        playlistTags[playlistPath] = normalized;
    }
}

function movePlaylistTagsPath(fromPath, toPath) {
    if (!fromPath || !toPath || fromPath === toPath) return;
    const tags = getPlaylistTagsForPath(fromPath);
    if (tags.length === 0) return;
    setPlaylistTagsForPath(toPath, tags);
    delete playlistTags[fromPath];
    savePlaylistTags();
}