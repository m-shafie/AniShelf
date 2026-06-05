const API = window.__TAURI__;

async function invoke(cmd, args = {}) {
    if (API && API.invoke) {
        return await API.invoke(cmd, args);
    }
    throw new Error('Tauri API not available');
}

// ========== State ==========

let state = {
    rootPath: null,
    entries: [],
    mappings: [],
    filteredEntries: [],
    editingEntryId: null,
    searchTimer: null,
    autoFetchAbort: false,
    filterParent: null,
    addingNew: false,
    malUsername: null,
    malStatuses: {},
    malScores: {},
    malProfileImg: null,
    filterStatus: 'all',
    _prevFilterStatus: 'all',
    signingIn: false,
    theme: 'yumeko',
    sort: 'name-asc',
};

// ========== Poster Cache ==========

// Tracks which entry IDs currently have an in-flight cache_poster call so we
// never fire two concurrent downloads for the same poster (would cause a file
// sharing violation on Windows and crash the app).
const _posterCaching = new Set();

async function resolvePosterUrl(entryId, remoteUrl) {
    if (!remoteUrl) return null;
    try {
        const cached = await invoke('get_cached_poster', { entryId });
        if (cached) return cached;
    } catch (_) { /* ignore */ }
    // Fire-and-forget background cache — guard against concurrent calls
    if (!_posterCaching.has(entryId)) {
        _posterCaching.add(entryId);
        invoke('cache_poster', { entryId, posterUrl: remoteUrl })
            .catch(() => {})
            .finally(() => _posterCaching.delete(entryId));
    }
    return remoteUrl;
}

// ========== DOM Refs ==========

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

const welcome = $('#welcome');
const loadingOverlay = $('#loading-overlay');
const cardGrid = $('#card-grid');
const searchInput = $('#search-input');
const openFolderBtn = $('#open-folder-btn');
const welcomeBtn = $('#welcome-btn');
const currentPath = $('#current-path');
const entryCount = $('#entry-count');

function setSidebarPath(text) {
    currentPath.textContent = text;
    currentPath.title = text;
    currentPath.classList.remove('animating');
    void currentPath.offsetWidth;
    currentPath.classList.add('animating');
}
const addAnimeBtn = $('#add-anime-btn');
const contextMenu = $('#context-menu');
const editModal = $('#edit-modal');
const malSearchInput = $('#mal-search-input');
const malResults = $('#mal-results');

// ========== Init ==========

document.addEventListener('contextmenu', (e) => e.preventDefault());
openFolderBtn.addEventListener('click', openFolder);
welcomeBtn.addEventListener('click', openFolder);

renderStatusTabs();

document.addEventListener('click', (e) => {
    if (!contextMenu.contains(e.target)) contextMenu.classList.add('hidden');
});

searchInput.addEventListener('input', () => {
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(filterEntries, 150);
});

if (addAnimeBtn) addAnimeBtn.addEventListener('click', openAddModal);

// Status tab clicks
document.getElementById('status-tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    const status = tab.dataset.status;
    if (status === state.filterStatus) return;
    state.filterStatus = status;
    renderStatusTabs();
    filterEntries();
});

// Sign-in button click — toggle sign out dropdown / sign in
document.getElementById('signin-btn').addEventListener('click', () => {
    if (state.malUsername) {
        document.getElementById('signout-dropdown').classList.toggle('hidden');
    } else {
        openSignInModal();
    }
});

// Close dropdown on outside click
document.addEventListener('click', (e) => {
    const wrapper = document.getElementById('signin-wrapper');
    if (wrapper && !wrapper.contains(e.target)) {
        document.getElementById('signout-dropdown').classList.add('hidden');
    }
});

// Open profile item
document.getElementById('open-profile-item').addEventListener('click', () => {
    document.getElementById('signout-dropdown').classList.add('hidden');
    if (state.malUsername) {
        window.__TAURI__.shell.open('https://myanimelist.net/profile/' + state.malUsername);
    }
});

// Sign-out item
document.getElementById('signout-item').addEventListener('click', () => {
    document.getElementById('signout-dropdown').classList.add('hidden');
    signOut();
});

// MAL refresh button
document.getElementById('mal-refresh-btn').addEventListener('click', async () => {
    if (!state.malUsername) return;
    const btn = document.getElementById('mal-refresh-btn');
    btn.classList.add('spinning');
    try {
        const statuses = await invoke('fetch_user_animelist', { username: state.malUsername });
        state.malStatuses = {};
        state.malScores = {};
        for (const s of statuses) {
            state.malStatuses[s.mal_id] = s.status;
            if (s.score > 0) state.malScores[s.mal_id] = s.score;

            // Sync episode count to mapping if we have a matching entry
            if (s.episodes) {
                const mapping = state.mappings.find(m => m.mal_id === s.mal_id);
                if (mapping && (!mapping.episodes || mapping.episodes <= 0)) {
                    mapping.episodes = s.episodes;
                }
            }
        }
        try {
            const profile = await invoke('fetch_mal_user_profile', { username: state.malUsername });
            state.malProfileImg = profile.image_url;
        } catch (_) { /* ignore */ }

        // Save fresh cache to disk
        const cacheEntries = statuses.map(s => ({
            mal_id: s.mal_id,
            status: s.status,
            score: s.score,
            episodes: s.episodes,
        }));
        await invoke('save_mal_cache', {
            data: {
                username: state.malUsername,
                profile_img: state.malProfileImg || '',
                entries: cacheEntries,
            },
        }).catch(() => {});

        // Persist updated episode counts to mapping files
        for (const s of statuses) {
            if (s.episodes) {
                const mapping = state.mappings.find(m => m.mal_id === s.mal_id);
                if (mapping && mapping.episodes === s.episodes) {
                    await invoke('save_mapping', {
                        rootPath: state.rootPath,
                        entryId: mapping.id,
                        malId: mapping.mal_id,
                        posterUrl: mapping.poster_url || '',
                        title: mapping.title || '',
                        titleEnglish: mapping.title_english || '',
                        episodes: s.episodes,
                    }).catch(() => {});
                }
            }
        }

        updateSignInButton();
        filterEntries();

        // Fetch episode counts for any mapped entries not on the user's list
        syncMissingEpisodes();
    } catch (e) {
        console.error('Re-sync failed:', e);
    } finally {
        btn.classList.remove('spinning');
    }
});

// "All Anime" click — clears any parent filter
document.querySelector('.nav-item').addEventListener('click', () => {
    state.filterParent = null;
    filterEntries();
});

// ── Scroll-to-top arrow ──

const scrollTopBtn = $('#scroll-top-btn');
cardGrid.addEventListener('scroll', () => {
    if (cardGrid.scrollTop > 300) {
        scrollTopBtn.classList.remove('hidden');
    } else {
        scrollTopBtn.classList.add('hidden');
    }
});
scrollTopBtn.addEventListener('click', () => {
    cardGrid.scrollTo({ top: 0, behavior: 'smooth' });
});

// ── Custom Title Bar Controls ──

const appWindow = window.__TAURI__ && window.__TAURI__.window && window.__TAURI__.window.appWindow;

if (appWindow) {
    const minimizeBtn = $('#titlebar-minimize');
    const maximizeBtn = $('#titlebar-maximize');
    const closeBtn = $('#titlebar-close');

    minimizeBtn.addEventListener('click', () => appWindow.minimize());
    closeBtn.addEventListener('click', async () => {
        await saveWindowState();
        appWindow.close();
    });

    maximizeBtn.addEventListener('click', async () => {
        await appWindow.toggleMaximize();
        setTimeout(saveWindowState, 300);
    });

    // Update maximize icon on state change
    async function updateMaximizeIcon() {
        const maximized = await appWindow.isMaximized();
        maximizeBtn.innerHTML = maximized
            ? '<svg width="12" height="12" viewBox="0 0 12 12"><rect x="2" y="0.5" width="8" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="1.1"/><rect x="0.5" y="2.5" width="8" height="8" rx="1" fill="var(--bg-sidebar)" stroke="currentColor" stroke-width="1.1"/></svg>'
            : '<svg width="12" height="12" viewBox="0 0 12 12"><rect x="1.5" y="1.5" width="9" height="9" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';
    }

    window.addEventListener('resize', updateMaximizeIcon);
    updateMaximizeIcon();
}

// ── Auto-load last used folder on startup ──
(async function autoLoadLastPath() {
    try {
        const path = await invoke('load_last_path');
        if (path) {
            state.rootPath = path;
            setSidebarPath(path);
            await loadLibrary(path);
        }
    } catch (e) {
        // No last path or error — show welcome screen (default)
    }
})();

// ── Settings: load, apply, UI handlers ──

function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
}

// Apply default theme immediately on page load
applyTheme(state.theme);

function openSettingsModal() {
    const modal = document.getElementById('settings-modal');

    const cards = modal.querySelectorAll('.theme-card');
    cards.forEach(c => c.classList.toggle('active', c.dataset.theme === state.theme));

    document.getElementById('sort-select').value = state.sort;

    modal.classList.remove('hidden');
}

function closeSettingsModal() {
    document.getElementById('settings-modal').classList.add('hidden');
}

// Settings button
document.getElementById('settings-btn').addEventListener('click', openSettingsModal);

// Settings modal close buttons
document.getElementById('settings-close-btn').addEventListener('click', closeSettingsModal);
document.getElementById('settings-done-btn').addEventListener('click', closeSettingsModal);
document.getElementById('settings-modal').addEventListener('click', (e) => {
    if (!e.target.closest('.modal-panel')) closeSettingsModal();
});

// Theme card clicks
document.getElementById('settings-modal').addEventListener('click', (e) => {
    const card = e.target.closest('.theme-card');
    if (!card) return;
    const theme = card.dataset.theme;
    if (theme === state.theme) return;
    state.theme = theme;
    applyTheme(theme);
    document.getElementById('settings-modal').querySelectorAll('.theme-card').forEach(c => {
        c.classList.toggle('active', c.dataset.theme === theme);
    });
    invoke('save_settings', { settings: { theme: state.theme, sort: state.sort } }).catch(console.error);
});

// Sort select change
document.getElementById('sort-select').addEventListener('change', (e) => {
    state.sort = e.target.value;
    invoke('save_settings', { settings: { theme: state.theme, sort: state.sort } }).catch(console.error);
    filterEntries();
});

// Auto-load settings + restore window size
(async function autoLoadSettings() {
    try {
        const settings = await invoke('load_settings');
        if (settings) {
            state.theme = settings.theme || 'yumeko';
            state.sort = settings.sort || 'name-asc';
            applyTheme(state.theme);
            if (appWindow) {
                const minW = 800, minH = 600;
                // Restore maximized state first
                if (settings.window_maximized === true) {
                    try {
                        await appWindow.maximize();
                    } catch (e) {
                        console.warn('Window maximize restore failed:', e);
                    }
                } else if (settings.window_width >= minW && settings.window_height >= minH) {
                    try {
                        const { PhysicalSize, PhysicalPosition } = window.__TAURI__.window;
                        await appWindow.setSize(new PhysicalSize(settings.window_width, settings.window_height));

                        // Restore position — clamp so window is always fully on screen
                        if (settings.window_x != null && settings.window_y != null) {
                            try {
                                // Get available screen size via Tauri monitor info
                                const monitor = await window.__TAURI__.window.currentMonitor();
                                if (monitor) {
                                    const sw = monitor.size.width;
                                    const sh = monitor.size.height;
                                    const ww = settings.window_width;
                                    const wh = settings.window_height;
                                    // Clamp: keep at least 100px of window visible on each edge
                                    const margin = 100;
                                    const clampedX = Math.max(-ww + margin, Math.min(settings.window_x, sw - margin));
                                    const clampedY = Math.max(0, Math.min(settings.window_y, sh - margin));
                                    await appWindow.setPosition(new PhysicalPosition(clampedX, clampedY));
                                } else {
                                    await appWindow.setPosition(new PhysicalPosition(settings.window_x, settings.window_y));
                                }
                            } catch (e) {
                                console.warn('Window position restore failed:', e);
                            }
                        }
                    } catch (e) {
                        console.warn('Window restore failed:', e);
                    }
                }
            }
        }
    } catch (e) {
        // Use defaults
    }
})();

// Save window dimensions and position on resize/move
let windowResizeTimer;
async function saveWindowState() {
    if (!appWindow) return;
    try {
        const size = await appWindow.innerSize();
        const position = await appWindow.innerPosition();
        const maximized = await appWindow.isMaximized();
        if (size.width >= 800 && size.height >= 600) {
            await invoke('save_settings', {
                settings: {
                    theme: state.theme,
                    sort: state.sort,
                    window_width: size.width,
                    window_height: size.height,
                    window_x: position.x,
                    window_y: position.y,
                    window_maximized: maximized,
                }
            });
        }
    } catch (e) { /* ignore */ }
}

window.addEventListener('resize', () => {
    if (!appWindow) return;
    clearTimeout(windowResizeTimer);
    windowResizeTimer = setTimeout(saveWindowState, 500);
});

// Also save on window move (Tauri move event)
if (appWindow) {
    try {
        appWindow.onMoved(() => {
            clearTimeout(windowResizeTimer);
            windowResizeTimer = setTimeout(saveWindowState, 500);
        });
    } catch (e) { /* onMoved may not be available in all versions */ }
}

// ── Filter breadcrumb ──

function updateFilterBreadcrumb() {
    const container = document.getElementById('filter-breadcrumb');
    const path = document.getElementById('breadcrumb-path');
    const backBtn = document.getElementById('filter-back-btn');

    if (state.entries.length === 0) {
        container.classList.add('hidden');
        state._prevBreadcrumb = null;
        return;
    }

    container.classList.remove('hidden');

    let newText;
    if (state.filterParent !== null && state.filterParent) {
        backBtn.classList.remove('disabled');
        let label = state.filterParent;
        const entry = state.entries.find(e => e.id === state.filterParent);
        if (entry) {
            label = cleanEntryTitle(entry.title);
        }
        newText = 'Anime / <strong>' + label + '</strong>';
    } else {
        backBtn.classList.add('disabled');
        newText = 'Anime/';
    }

    if (newText === state._prevBreadcrumb) return;
    state._prevBreadcrumb = newText;
    path.innerHTML = newText;
}

document.getElementById('filter-back-btn').addEventListener('click', () => {
    state.filterParent = null;
    filterEntries();
});

function scrollSidebarToActive() {
    setTimeout(() => {
        const nav = document.querySelector('.sidebar-nav');
        const active = nav.querySelector('.nav-franchise.active');
        if (!active || !nav) return;
        const top = active.offsetTop - nav.offsetTop;
        nav.scrollTo({ top: top - nav.clientHeight / 3, behavior: 'smooth' });
    }, 50);
}

// ── Auto-sync MAL username on startup ──
(async function autoLoadMalUsername() {
    try {
        const username = await invoke('load_mal_username');
        if (!username) return;

        // Phase 1: Load cached data instantly (no network needed)
        try {
            const cached = await invoke('load_mal_cache');
            if (cached && cached.username === username) {
                state.malUsername = cached.username;
                state.malStatuses = {};
                state.malScores = {};
                for (const entry of cached.entries) {
                    state.malStatuses[entry.mal_id] = entry.status;
                    if (entry.score > 0) state.malScores[entry.mal_id] = entry.score;
                }
                if (cached.profile_img) {
                    state.malProfileImg = cached.profile_img;
                }
                updateSignInButton();
                renderStatusTabs();
                if (state.entries.length > 0) {
                    updateMalBadgesOnCards();
                    if (state.filterStatus !== 'all') {
                        filterEntries();
                    }
                }
            }
        } catch (_) { /* no cache — proceed to network fetch */ }

        // Phase 2: Background refresh from MAL (if online)
        try {
            const statuses = await invoke('fetch_user_animelist', { username });
            state.malUsername = username;
            state.malStatuses = {};
            state.malScores = {};
            for (const s of statuses) {
                state.malStatuses[s.mal_id] = s.status;
                if (s.score > 0) state.malScores[s.mal_id] = s.score;

                // Sync episode count to mapping if we have a matching entry
                if (s.episodes) {
                    const mapping = state.mappings.find(m => m.mal_id === s.mal_id);
                    if (mapping && (!mapping.episodes || mapping.episodes <= 0)) {
                        mapping.episodes = s.episodes;
                    }
                }
            }
            try {
                const profile = await invoke('fetch_mal_user_profile', { username });
                state.malProfileImg = profile.image_url;
            } catch (_) { /* ignore */ }

            // Save fresh cache to disk
            const cacheEntries = statuses.map(s => ({
                mal_id: s.mal_id,
                status: s.status,
                score: s.score,
                episodes: s.episodes,
            }));
            await invoke('save_mal_cache', {
                data: {
                    username,
                    profile_img: state.malProfileImg || '',
                    entries: cacheEntries,
                },
            }).catch(() => {});

            // Persist updated episode counts to mapping files
            for (const s of statuses) {
                if (s.episodes) {
                    const mapping = state.mappings.find(m => m.mal_id === s.mal_id);
                    if (mapping && mapping.episodes === s.episodes) {
                        await invoke('save_mapping', {
                            rootPath: state.rootPath,
                            entryId: mapping.id,
                            malId: mapping.mal_id,
                            posterUrl: mapping.poster_url || '',
                            title: mapping.title || '',
                            titleEnglish: mapping.title_english || '',
                            episodes: s.episodes,
                        }).catch(() => {});
                    }
                }
            }

            updateSignInButton();
            renderStatusTabs();
            updateMalBadgesOnCards();
            if (state.filterStatus !== 'all') {
                filterEntries();
            }

            // Fetch episode counts for any mapped entries not on the user's list
            syncMissingEpisodes();
        } catch (_) {
            // Offline or network error — cached data is already showing, no action needed
        }
    } catch (e) {
        // Failed to auto-sync — just don't show status tab, user can manually re-sync
    }
})();

function updateEpisodeBadgesOnCards() {
    const cards = document.querySelectorAll('#card-grid-inner .card');
    cards.forEach(card => {
        const entryId = card.dataset.entryId;
        const entry = state.entries.find(e => e.id === entryId);
        const mapping = state.mappings.find(m => m.id === entryId);
        if (!mapping || !mapping.mal_id) return;
        const badge = card.querySelector('.card-episodes-badge');
        if (!badge) return;
        const vc = entry ? (entry.video_count ?? 0) : 0;
        const totalEp = mapping.episodes > 0 ? mapping.episodes : '?';
        badge.textContent = vc + '/' + totalEp;
    });
}

async function syncMissingEpisodes() {
    const missing = state.mappings.filter(m => m.mal_id && (!m.episodes || m.episodes <= 0));
    for (const mapping of missing) {
        try {
            const episodes = await invoke('fetch_anime_episodes', { malId: mapping.mal_id });
            if (episodes && episodes > 0) {
                mapping.episodes = episodes;
                await invoke('save_mapping', {
                    rootPath: state.rootPath,
                    entryId: mapping.id,
                    malId: mapping.mal_id,
                    posterUrl: mapping.poster_url || '',
                    title: mapping.title || '',
                    titleEnglish: mapping.title_english || '',
                    episodes,
                }).catch(() => {});
            }
            // Be respectful to Jikan API — 1s between requests
            await new Promise(r => setTimeout(r, 1000));
        } catch (_) { /* skip this one, continue with next */ }
    }
    // Update badges in-place without re-rendering the grid
    updateEpisodeBadgesOnCards();
}

function updateMalBadgesOnCards() {
    const cards = document.querySelectorAll('#card-grid-inner .card');
    cards.forEach(card => {
        const entryId = card.dataset.entryId;
        const entry = state.entries.find(e => e.id === entryId);
        const mapping = state.mappings.find(m => m.id === entryId);
        if (!mapping || !mapping.mal_id) return;

        if (!card.querySelector('.card-mal-badge')) {
            const malBadge = document.createElement('div');
            malBadge.className = 'card-mal-badge';
            malBadge.title = 'View on MyAnimeList';
            malBadge.textContent = 'MAL';
            malBadge.addEventListener('click', (e) => {
                e.stopPropagation();
                const url = 'https://myanimelist.net/anime/' + mapping.mal_id;
                if (window.__TAURI__ && window.__TAURI__.shell) {
                    window.__TAURI__.shell.open(url);
                } else {
                    window.open(url, '_blank');
                }
            });
            card.appendChild(malBadge);
        }

        const status = state.malStatuses[mapping.mal_id];
        const score = state.malScores[mapping.mal_id];
        if (status) {
            if (!card.querySelector('.card-status-badge')) {
                const statusBadge = document.createElement('div');
                statusBadge.className = 'card-status-badge card-status-' + status;
                statusBadge.textContent = status.replace(/_/g, ' ');
                card.classList.add('has-status');
                card.appendChild(statusBadge);
            }
        }
        if (status && score && !card.querySelector('.card-score-badge')) {
            const scoreEl = document.createElement('div');
            scoreEl.className = 'card-score-badge';
            scoreEl.textContent = '★ ' + score;
            card.appendChild(scoreEl);
        }
    });
}

// ========== Title Cleaning ==========

/**
 * Cleans a raw folder/subfolder name into a display title and MAL search query.
 *
 * Subfolder names ARE the entry titles — this is the primary naming source:
 *   "1.Black Lagoon"                    → "Black Lagoon"
 *   "2.Black Lagoon The Second Barrage" → "Black Lagoon The Second Barrage"
 *   "3.Black Lagoon Roberta's Blood Trail" → "Black Lagoon Roberta's Blood Trail"
 *   "1.Frieren Beyond Journey's End Season 1" → "Frieren Beyond Journey's End Season 1"
 *   "Erased"                            → "Erased"  (top-level, no prefix)
 *
 * Parent/franchise folder prefixes to ignore in display:
 *   "AA-Black Lagoon"  → "Black Lagoon"
 *   "AA-Spy Classroom" → "Spy Classroom"
 */
function cleanEntryTitle(raw) {
    let title = raw.trim();

    // 1. Strip leading numeric prefix: "1.", "12.", "3. "
    title = title.replace(/^\d+\.\s*/, '');

    // 2. Strip sort prefixes: "AA-", "AAA-", "AA01-", "ZZ_"
    title = title.replace(/^[A-Z]{2,3}\d*[-_]\s*/i, '');

    // 3. Strip brackets/parens noise: [BD], (720p), [SubGroup], etc.
    title = title.replace(/[\[(][^\]\)]*[\]\)]/g, '');

    // 4. Remove library-only suffixes that don't appear on MAL
    const noiseSuffixes = [
        /\s*[-–]\s*censored$/i,
        /\s*[-–]\s*uncensored$/i,
        /\s+censored$/i,
        /\s+uncensored$/i,
        /\s*complete\s*series$/i,
        /\s*batch$/i,
    ];
    for (const rx of noiseSuffixes) {
        title = title.replace(rx, '');
    }

    // 5. Collapse extra spaces
    title = title.replace(/\s+/g, ' ').trim();

    return title;
}

/**
 * Cleans a parent/franchise folder name for display as a subtitle.
 * Strips sorting prefixes like "AA-", "ZZ-", "00-" used to force folder order.
 *
 *   "AA-Black Lagoon"  → "Black Lagoon"
 *   "AA-Spy Classroom" → "Spy Classroom"
 *   "Black Lagoon"     → "Black Lagoon"  (no change)
 */
function cleanParentTitle(raw) {
    if (!raw) return '';
    // Strip leading sort-prefix patterns: "AA-", "ZZ-", "AAA-", etc.
    // Requires at least 2 uppercase letters to avoid mangling titles like "K-ON!"
    let title = raw.trim().replace(/^[A-Z]{2,3}\d*[-_]\s*/i, '');
    // Also strip numeric prefix if present
    title = title.replace(/^\d+\.\s*/, '');
    return title.trim();
}

/**
 * Returns the query string to use when searching MAL for a given entry.
 * Uses the cleaned subfolder name directly — this IS the specific anime title.
 */
function getMalSearchQuery(entry) {
    return cleanEntryTitle(entry.title);
}

/**
 * Returns the best MAL search query for a given entry.
 *
 * For sub-entries with generic folder names like "Censored" or "Uncensored"
 * (that don't contain the actual anime title), falls back to the parent
 * franchise name instead.
 */
const GENERIC_NAMES = /^(censored|uncensored|uncut|complete|batch|ova|ona|movie|special|specials|season|part|vol|s\d+|v\d+)$/i;

function getSearchQuery(entry) {
    const cleaned = cleanEntryTitle(entry.title);

    if (entry.parent_title) {
        const bare = entry.title.replace(/^\d+\.?\s*/, '').trim();
        if (bare.length < 4 || GENERIC_NAMES.test(bare)) {
            return cleanForJikan(cleanParentTitle(entry.parent_title));
        }
    }

    return cleanForJikan(cleaned);
}

/**
 * Aggressively normalizes a title for fuzzy comparison:
 *   - lowercase
 *   - punctuation ( :;.!\-_'", ) → space
 *   - strip remaining non-alphanumeric
 *   - collapse whitespace
 */
function norm(s) {
    return s
        .toLowerCase()
        .replace(/['']/g, '')
        .replace(/[:;.!\-_",/()[\]]/g, ' ')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function cleanForJikan(s) {
    return s
        .replace(/[+#&%@=~`<>{}|^\\]/g, ' ')
        .replace(/['']/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Scores a MAL result against the cleaned local title.
 *
 * Key fixes over the old version:
 *   - Punctuation is normalised so "Steins;Gate" ≈ "SteinsGate" ≈ "Steins Gate"
 *   - Prefix / substring matches are penalised when one string is much shorter,
 *     preventing a short popular series from beating a long specific OVA/movie name.
 *   - Word-order bonus rewards consecutive matching words.
 *
 * Returns 0–100 (100 = exact match after normalisation).
 */
const STOP_WORDS = new Set([
    'a','an','the','is','of','in','to','and','or','for','on','at','by',
    'as','be','but','not','it','its','with','you','your','this','that',
    'was','are','were','been','have','has','had','do','does','did','will',
    'would','could','should','may','might','no','yes','so','if','all',
    'up','down','out','off','over','into','about','after','before',
    'from','than','then','also','just','more','some','very','well',
    'too','only','own','same','such','when','where','what','which',
    'who','whom','why','how','much','many','each','few','both',
    'part','season','movie','film','series','complete','batch',
]);

function scoreMatch(malTitle, malTitleEn, localClean) {
    const local = norm(localClean);
    if (!local) return 0;

    const candidates = [malTitleEn, malTitle].filter(Boolean);
    let bestScore = 0;

    for (const candidate of candidates) {
        const mal = norm(candidate);
        if (mal === local) return 100;

        if (mal.includes(local) || local.includes(mal)) {
            const short = Math.min(mal.length, local.length);
            const long  = Math.max(mal.length, local.length);
            const ratio = short / long;
            const score = ratio >= 0.8 ? 85 : Math.round(ratio * 35);
            bestScore = Math.max(bestScore, score);
        }

        const malWords  = mal.split(/\s+/).filter(w => w.length >= 2);
        const localWords = local.split(/\s+/).filter(w => w.length >= 2);

        if (malWords.length === 0 || localWords.length === 0) continue;

        let sharedWeight = 0;
        let totalWeight = 0;
        const malRemaining = malWords.map(w => ({ word: w, stop: STOP_WORDS.has(w) }));

        for (const lw of localWords) {
            const weight = STOP_WORDS.has(lw) ? 0.3 : 1.0;
            totalWeight += weight;
            const matchIdx = malRemaining.findIndex(mw => mw.word === lw.word);
            if (matchIdx !== -1) {
                sharedWeight += weight;
                malRemaining.splice(matchIdx, 1);
            }
        }

        const weightedRatio = totalWeight > 0 ? sharedWeight / totalWeight : 0;

        let orderBonus = 0;
        const matchedLocal = localWords.filter(w => !STOP_WORDS.has(w));
        if (matchedLocal.length >= 2) {
            let maxRun = 0;
            for (let i = 0; i < localWords.length; i++) {
                for (let j = 0; j < malWords.length; j++) {
                    let run = 0;
                    while (
                        i + run < localWords.length &&
                        j + run < malWords.length &&
                        localWords[i + run] === malWords[j + run]
                    ) { run++; }
                    maxRun = Math.max(maxRun, run);
                }
            }
            orderBonus = (maxRun / Math.max(localWords.length, malWords.length)) * 20;
        }

        bestScore = Math.max(bestScore, Math.min(weightedRatio * 75 + orderBonus, 90));
    }

    return Math.round(bestScore);
}

/**
 * From a list of MAL results, picks the one that best matches localClean.
 * Returns null if every result scores below MIN_CONFIDENCE.
 */
const MIN_SCORE = 25;

function pickBestMatch(results, compareTitle) {
    if (!results || results.length === 0) return null;
    if (!compareTitle) return null;

    let best = results[0];
    let bestScore = scoreMatch(results[0].title, results[0].title_english, compareTitle);

    for (let i = 1; i < results.length; i++) {
        const score = scoreMatch(results[i].title, results[i].title_english, compareTitle);
        if (score > bestScore) {
            bestScore = score;
            best = results[i];
        }
    }

    return bestScore >= MIN_SCORE ? best : null;
}

/**
 * Returns the display title to show on the card.
 * Priority: MAL-fetched title > cleaned subfolder name.
 */
function getDisplayTitle(entry, mapping) {
    if (mapping && mapping.title_english) return mapping.title_english;
    if (mapping && mapping.title) return mapping.title;
    return cleanEntryTitle(entry.title);
}

const STATUS_ORDER = { watching: 0, completed: 1, plan_to_watch: 2, on_hold: 3, dropped: 4 };

function applySort(entries) {
    const s = state.sort;
    const sorted = [...entries];

    switch (s) {
        case 'name-asc':
            sorted.sort((a, b) => {
                const ma = getMapping(a.id);
                const mb = getMapping(b.id);
                const ta = getDisplayTitle(a, ma).toLowerCase();
                const tb = getDisplayTitle(b, mb).toLowerCase();
                return ta.localeCompare(tb);
            });
            break;

        case 'name-desc':
            sorted.sort((a, b) => {
                const ma = getMapping(a.id);
                const mb = getMapping(b.id);
                const ta = getDisplayTitle(a, ma).toLowerCase();
                const tb = getDisplayTitle(b, mb).toLowerCase();
                return tb.localeCompare(ta);
            });
            break;

        case 'franchise':
            sorted.sort((a, b) => {
                const pa = (a.parent_title || '').toLowerCase();
                const pb = (b.parent_title || '').toLowerCase();
                if (pa !== pb) return pa.localeCompare(pb);
                const sa = a.season_number ? parseInt(a.season_number, 10) || 0 : 0;
                const sb = b.season_number ? parseInt(b.season_number, 10) || 0 : 0;
                if (sa !== sb) return sa - sb;
                return a.sort_order - b.sort_order;
            });
            break;

        case 'status': {
            const statusMap = {};
            for (const e of sorted) {
                const m = getMapping(e.id);
                const malId = m && m.mal_id;
                statusMap[e.id] = malId ? (state.malStatuses[malId] || 'unknown') : 'unknown';
            }
            sorted.sort((a, b) => {
                const sa = STATUS_ORDER[statusMap[a.id]] ?? 5;
                const sb = STATUS_ORDER[statusMap[b.id]] ?? 5;
                if (sa !== sb) return sa - sb;
                const ma = getMapping(a.id);
                const mb = getMapping(b.id);
                const ta = getDisplayTitle(a, ma).toLowerCase();
                const tb = getDisplayTitle(b, mb).toLowerCase();
                return ta.localeCompare(tb);
            });
            break;
        }

        case 'recent':
            sorted.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
            break;
    }

    return sorted;
}

// ========== Sidebar ==========

function renderSidebar(entries) {
    const allItem = document.querySelector('.nav-item');
    if (state.filterParent === null) {
        allItem.classList.add('active');
    } else {
        allItem.classList.remove('active');
    }

    // Collect unique parent titles + standalone
    const parentMap = new Map();
    const standalone = [];
    for (const e of entries) {
        if (e.parent_title) {
            const clean = cleanParentTitle(e.parent_title);
            parentMap.set(clean, (parentMap.get(clean) || 0) + 1);
        } else {
            standalone.push(e);
        }
    }

    const list = $('#entry-list');
    list.innerHTML = '';

    // Build flat sorted list of sidebar items
    const items = [];

    for (const [name, count] of parentMap) {
        items.push({ type: 'franchise', name, count });
    }
    for (const entry of standalone) {
        items.push({ type: 'standalone', name: cleanEntryTitle(entry.title), id: entry.id });
    }
    items.sort((a, b) => a.name.localeCompare(b.name));

    for (const item of items) {
        const el = document.createElement('div');
        el.className = 'nav-franchise';

        if (item.type === 'franchise') {
            el.dataset.parent = item.name;
            const fp = (state.filterParent || '').toLowerCase().trim();
            const iname = item.name.toLowerCase().trim();
            if (fp && fp === iname) el.classList.add('active');

            const label = document.createElement('span');
            label.textContent = item.name;

            const badge = document.createElement('span');
            badge.className = 'nav-franchise-badge';
            badge.textContent = item.count;

            el.appendChild(label);
            el.appendChild(badge);

            el.addEventListener('click', (e) => {
                e.stopPropagation();
                state.filterParent = state.filterParent === item.name ? null : item.name;
                filterEntries();
            });
        } else {
            el.dataset.entryId = item.id;
            if (state.filterParent === item.id) el.classList.add('active');

            const label = document.createElement('span');
            label.textContent = item.name.length > 24 ? item.name.slice(0, 22) + '…' : item.name;

            el.appendChild(label);

            const entryId = item.id;
            el.addEventListener('click', (ev) => {
                ev.stopPropagation();
                state.filterParent = state.filterParent === entryId ? null : entryId;
                filterEntries();
            });
        }

        list.appendChild(el);
    }
}

// ========== Core Functions ==========

async function openFolder() {
    try {
        const path = await invoke('select_directory');
        if (!path) return;
        state.rootPath = path;
        state.filterParent = null;
        setSidebarPath(path);
        invoke('save_last_path', { path }).catch(console.error);
        await loadLibrary(path);
    } catch (e) {
        console.error('Failed to open folder:', e);
    }
}

async function loadLibrary(rootPath) {
    try {
        welcome.classList.add('hidden');
        welcome.style.display = 'none';
        loadingOverlay.classList.remove('hidden');

        const [entries, rawMappings] = await Promise.all([
            invoke('scan_anime_folder', { rootPath }),
            invoke('load_mappings', { rootPath }),
        ]);

        // --- Graceful migration: if folder names were renamed while the app was
        //     closed, the entry IDs (which hash the relative path) will have changed.
        //     Ask the backend to match orphaned mapping entries to current entries
        //     by folder-name stem, rewrite the mapping file, and copy cached posters.
        let mappings = rawMappings.filter(m => entries.some(e => e.id === m.id));

        const unmappedEntries = entries.filter(e => !mappings.some(m => m.id === e.id));
        if (unmappedEntries.length > 0 && rawMappings.length > 0) {
            try {
                const migrations = await invoke('migrate_mappings', {
                    rootPath,
                    currentEntries: entries,
                });
                // migrations is [[new_id, old_id], ...]
                for (const [newId, oldId] of migrations) {
                    const orphan = rawMappings.find(m => m.id === oldId);
                    if (orphan) {
                        const migrated = { ...orphan, id: newId };
                        // Don't double-add if already present
                        if (!mappings.some(m => m.id === newId)) {
                            mappings.push(migrated);
                        }
                    }
                }
            } catch (e) {
                console.warn('migrate_mappings failed (non-fatal):', e);
            }
        }

        state.entries = entries;
        state.mappings = mappings;
        state.filteredEntries = applySort([...entries]);
        state.autoFetchAbort = false;

        loadingOverlay.classList.add('hidden');
        cardGrid.classList.remove('hidden');
        entryCount.textContent = entries.length;

        renderSidebar(entries);
        updateFilterBreadcrumb();
        renderGrid(state.filteredEntries, state.mappings);
        autoFetchPosters(entries, state.mappings);
    } catch (e) {
        console.error('Failed to load library:', e);
        loadingOverlay.classList.add('hidden');
        welcome.classList.remove('hidden');
        welcome.style.display = '';
        cardGrid.classList.add('hidden');
    }
}

function getMapping(id) {
    return state.mappings.find((m) => m.id === id);
}

function filterEntries() {
    const query = searchInput.value.toLowerCase().trim();
    let filtered = state.entries;

    // Apply text search
    if (query) {
        filtered = filtered.filter((e) => {
            const mapping = getMapping(e.id);
            const title = getDisplayTitle(e, mapping).toLowerCase();
            const parent = (e.parent_title || '').toLowerCase();
            const raw = e.title.toLowerCase();
            return title.includes(query) || parent.includes(query) || raw.includes(query);
        });
    }

    // Sidebar reflects text-search only, not parent filter
    const sidebarEntries = [...filtered];

    // Apply parent filter
    if (state.filterParent !== null) {
        filtered = filtered.filter((e) => {
            if (state.filterParent.includes('\\') || state.filterParent.includes('/')) {
                return e.folder_path === state.filterParent;
            }
            const parentClean = cleanParentTitle(e.parent_title || '');
            const entryClean = cleanEntryTitle(e.title);
            return parentClean === state.filterParent || entryClean === state.filterParent || e.id === state.filterParent;
        });
    }

    // Apply status filter
    if (state.malUsername && state.filterStatus !== 'all') {
        filtered = filtered.filter((e) => {
            const mapping = getMapping(e.id);
            if (!mapping || !mapping.mal_id) return false;
            return state.malStatuses[mapping.mal_id] === state.filterStatus;
        });
    }

    state.filteredEntries = applySort(filtered);
    entryCount.textContent = state.entries.length;
    renderSidebar(sidebarEntries);
    updateFilterBreadcrumb();

    // Trigger swipe animation on status tab change
    if (state._prevFilterStatus !== state.filterStatus) {
        state._prevFilterStatus = state.filterStatus;
        const inner = document.getElementById('card-grid-inner');
        if (inner) {
            inner.classList.remove('tab-swiping');
            void inner.offsetWidth;
            inner.classList.add('tab-swiping');
        }
    }

    renderGrid(state.filteredEntries, state.mappings);
}

// ========== Render ==========

const GAP = 18;
const ASPECT_H = 310 / 225; // ~1.378 → height = width * ASPECT_H
const BUFFER = 3;

let virtual = {
    entries: [],
    mappings: [],
    columns: 1,
    cardWidth: 150,
    rowHeight: 207, // 150 * 310/225
    rowPitch: 207 + GAP,
    inner: null,
    rendered: new Map(),
    pending: false,
};

function renderGrid(entries, mappings) {
    virtual.entries = entries;
    virtual.mappings = mappings;
    virtual.rendered.clear();

    let inner = cardGrid.querySelector('#card-grid-inner');
    if (!inner) {
        inner = document.createElement('div');
        inner.id = 'card-grid-inner';
        cardGrid.appendChild(inner);
    }
    inner.innerHTML = '';
    virtual.inner = inner;
    virtual.rendered = new Map();
    state._freshRender = true;

    measureLayout();
    updateVisibleCards();
    state._freshRender = false;
}

function measureLayout() {
    const w = cardGrid.clientWidth - 48; // subtract card-grid padding 24+24
    virtual.columns = Math.max(1, Math.floor((w + GAP) / (150 + GAP)));
    virtual.cardWidth = (w - (virtual.columns - 1) * GAP) / virtual.columns;
    virtual.rowHeight = Math.round(virtual.cardWidth * ASPECT_H);
    virtual.rowPitch = virtual.rowHeight + GAP;

    const rows = Math.ceil(virtual.entries.length / virtual.columns);
    const h = rows * virtual.rowHeight + (rows - 1) * GAP;
    if (virtual.inner) virtual.inner.style.height = h + 'px';
}

function updateVisibleCards() {
    const { entries, mappings, columns, cardWidth, rowPitch, rowHeight, rendered, inner } = virtual;
    if (!inner || entries.length === 0) return;

    const scrollTop = cardGrid.scrollTop;
    const viewH = cardGrid.clientHeight;

    const totalRows = Math.ceil(entries.length / columns);
    const firstRow = Math.max(0, Math.floor(scrollTop / rowPitch) - BUFFER);
    const lastRow = Math.min(totalRows - 1, Math.ceil((scrollTop + viewH) / rowPitch) + BUFFER);

    const firstIdx = firstRow * columns;
    const lastIdx = Math.min(entries.length, (lastRow + 1) * columns);

    const desired = new Set();
    for (let i = firstIdx; i < lastIdx; i++) desired.add(i);

    // Remove cards outside range
    for (const [idx, el] of rendered) {
        if (!desired.has(idx)) {
            el.remove();
            rendered.delete(idx);
        }
    }

    // Add / reposition cards in range
    for (let i = firstIdx; i < lastIdx; i++) {
        let card = rendered.get(i);
        if (!card) {
            card = createCard(entries[i], mappings);
            rendered.set(i, card);
        }
        const row = Math.floor(i / columns);
        const col = i % columns;
        card.style.position = 'absolute';
        card.style.top = (row * rowPitch) + 'px';
        card.style.left = (col * (cardWidth + GAP)) + 'px';
        card.style.width = cardWidth + 'px';
        card.style.height = rowHeight + 'px';

        if (!card.parentNode) {
            if (state._freshRender) {
                card.style.animation = 'card-appear 0.3s ease-out both';
                card.style.setProperty('--i', i);
                card.addEventListener('animationend', () => {
                    card.style.animation = '';
                    card.style.transform = '';
                }, { once: true });
            }
            inner.appendChild(card);
        }
    }
}

// Debounced scroll handler for virtual scroll
cardGrid.addEventListener('scroll', () => {
    if (!virtual.pending) {
        virtual.pending = true;
        requestAnimationFrame(() => {
            virtual.pending = false;
            updateVisibleCards();
        });
    }
});

// Re-measure on resize
let resizeTimer;
window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
        measureLayout();
        updateVisibleCards();
    }, 200);
});

function createCard(entry, mappings) {
    const mapping = mappings.find((m) => m.id === entry.id);
    const hasPoster = mapping && mapping.poster_url;
    const displayTitle = getDisplayTitle(entry, mapping);

    const card = document.createElement('div');
    card.className = 'card' + (hasPoster ? '' : ' skeleton');
    card.dataset.entryId = entry.id;

    if (hasPoster) {
        const img = document.createElement('img');
        img.className = 'card-poster';
        img.alt = displayTitle;
        img.onerror = () => {
            img.style.display = 'none';
            const ph = card.querySelector('.card-placeholder');
            if (ph) ph.style.display = 'flex';
            card.classList.remove('skeleton');
        };
        img.onload = () => card.classList.remove('skeleton');
        card.appendChild(img);

        // Resolve poster: try cached first, fall back to remote
        (async () => {
            const src = await resolvePosterUrl(entry.id, mapping.poster_url);
            if (src) {
                img.src = src;
            } else {
                img.style.display = 'none';
            }
        })();
    } else {
        const placeholder = document.createElement('div');
        placeholder.className = 'card-placeholder';

        const abbr = document.createElement('div');
        abbr.className = 'card-placeholder-abbr';
        abbr.textContent = displayTitle.slice(0, 2).toUpperCase();

        const name = document.createElement('div');
        name.className = 'card-placeholder-name';
        name.textContent = displayTitle;

        placeholder.appendChild(abbr);
        placeholder.appendChild(name);
        card.appendChild(placeholder);
    }

    const info = document.createElement('div');
    info.className = 'card-info';

    const titleEl = document.createElement('div');
    titleEl.className = 'card-title';
    titleEl.textContent = displayTitle;
    info.appendChild(titleEl);

    const bottomRow = document.createElement('div');
    bottomRow.className = 'card-bottom-row';

    if (entry.parent_title) {
        const sub = document.createElement('span');
        sub.className = 'card-subtitle';
        const parentClean = cleanParentTitle(entry.parent_title);
        if (entry.season_number) {
            sub.textContent = parentClean + ' · S' + entry.season_number;
        } else {
            sub.textContent = parentClean;
        }
        bottomRow.appendChild(sub);
    }

    if (bottomRow.children.length > 0) {
        info.appendChild(bottomRow);
    }

    card.appendChild(info);

    if (entry.season_number) {
        const badge = document.createElement('div');
        badge.className = 'card-season';
        badge.textContent = 'S' + entry.season_number;
        card.appendChild(badge);
    }

    // MAL badge
    if (mapping && mapping.mal_id) {
        const malBadge = document.createElement('div');
        malBadge.className = 'card-mal-badge';
        malBadge.title = 'View on MyAnimeList';
        malBadge.textContent = 'MAL';
        malBadge.addEventListener('click', (e) => {
            e.stopPropagation();
            const url = 'https://myanimelist.net/anime/' + mapping.mal_id;
            if (window.__TAURI__ && window.__TAURI__.shell) {
                window.__TAURI__.shell.open(url);
            } else {
                window.open(url, '_blank');
            }
        });
        card.appendChild(malBadge);
    }

    // Episodes badge (top-left, below season badge if present)
    if (mapping && mapping.mal_id) {
        const epBadge = document.createElement('div');
        epBadge.className = 'card-episodes-badge';
        const vc = entry.video_count ?? 0;
        const totalEp = mapping.episodes > 0 ? mapping.episodes : '?';
        epBadge.textContent = vc + '/' + totalEp;
        card.appendChild(epBadge);
    }

    // Score badge (after MAL badge so it renders on top at same position)
    if (state.malUsername && mapping && mapping.mal_id) {
        const status = state.malStatuses[mapping.mal_id];
        const score = state.malScores[mapping.mal_id];
        if (status && score) {
            const scoreEl = document.createElement('div');
            scoreEl.className = 'card-score-badge';
            scoreEl.textContent = '★ ' + score;
            card.appendChild(scoreEl);
        }
    }

    // MAL status badge (bottom-center)
    if (state.malUsername && mapping && mapping.mal_id) {
        const status = state.malStatuses[mapping.mal_id];
        if (status) {
            const statusBadge = document.createElement('div');
            statusBadge.className = 'card-status-badge card-status-' + status;
            statusBadge.textContent = status.replace(/_/g, ' ');
            card.classList.add('has-status');
            card.appendChild(statusBadge);
        }
    }

    card.addEventListener('click', () => {
        invoke('open_folder', { path: entry.folder_path }).catch(console.error);
    });

    card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        state.editingEntryId = entry.id;
        showContextMenu(e.clientX, e.clientY, entry);
    });

    return card;
}

// ========== Context Menu ==========

function showContextMenu(x, y, entry) {
    contextMenu.innerHTML = '';
    contextMenu.classList.remove('hidden');

    const mapping = getMapping(entry.id);

    const items = [
        { icon: '📁', label: 'Open in Explorer', action: 'open' },
        { divider: true },
        { icon: '📂', label: 'Open Anime', action: 'open-anime' },
        { icon: '📱', label: 'Transfer to Phone', action: 'transfer-phone' },
        { divider: true },
        { icon: '✏️', label: 'Edit MAL Link…', action: 'edit' },
        { icon: '🔄', label: 'Re-fetch Poster', action: 'refetch' },
    ];

    if (mapping && mapping.mal_id) {
        items.push({ divider: true });
        items.push({ icon: '🌐', label: 'Open on MyAnimeList', action: 'open-mal' });
    }

    for (const item of items) {
        if (item.divider) {
            const div = document.createElement('div');
            div.className = 'context-divider';
            contextMenu.appendChild(div);
        } else {
            const el = document.createElement('div');
            el.className = 'context-item';
            el.innerHTML = '<span class="context-icon">' + item.icon + '</span>' + item.label;
            el.addEventListener('click', () => {
                contextMenu.classList.add('hidden');
                if (item.action === 'open') {
                    invoke('open_folder', { path: entry.folder_path }).catch(console.error);
                } else if (item.action === 'open-anime') {
                    searchInput.value = '';
                    state.filterParent = entry.parent_title
                        ? cleanParentTitle(entry.parent_title)
                        : entry.id;
                    filterEntries();
                    scrollSidebarToActive();
                } else if (item.action === 'transfer-phone') {
                    openTransferModal(entry);
                } else if (item.action === 'edit') {
                    openEditModal(entry);
                } else if (item.action === 'refetch') {
                    refetchSingle(entry);
                } else if (item.action === 'open-mal') {
                    const mid = mapping && mapping.mal_id;
                    if (mid) {
                        const url = 'https://myanimelist.net/anime/' + mid;
                        if (window.__TAURI__ && window.__TAURI__.shell) {
                            window.__TAURI__.shell.open(url);
                        } else {
                            window.open(url, '_blank');
                        }
                    }
                }
            });
            contextMenu.appendChild(el);
        }
    }

    const rect = contextMenu.getBoundingClientRect();
    const maxX = window.innerWidth - (rect.width || 200);
    const maxY = window.innerHeight - (rect.height || 120);
    contextMenu.style.left = Math.min(x, maxX) + 'px';
    contextMenu.style.top = Math.min(y, maxY) + 'px';
}

// ========== Add New Anime ==========

function sanitizeFolderName(name) {
    return name.replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, ' ').trim();
}

async function openAddModal() {
    if (!state.rootPath) return;
    state.addingNew = true;
    state.editingEntryId = null;
    pendingMalResult = null;

    clearTimeout(malSearchInput._timer);
    document.getElementById('modal-current-info').style.display = 'none';
    document.querySelector('.modal-header h2').textContent = 'Add New Anime';

    document.getElementById('signin-fields').classList.add('hidden');
    document.getElementById('signin-error').classList.add('hidden');
    document.querySelector('.search-field').style.display = '';
    document.getElementById('mal-results').style.display = '';
    const addFields = document.getElementById('add-fields');
    addFields.classList.remove('hidden');
    document.getElementById('add-folder-name').value = '';
    const seasonInput = document.getElementById('add-season');
    seasonInput.value = '';

    const locationHint = document.getElementById('add-location-hint');

    // In root (All Anime) mode: standalone entry, no season needed
    // In franchise/entry filter mode: season is required
    const isParentMode = state.filterParent !== null;
    seasonInput.classList.toggle('hidden', !isParentMode);
    seasonInput.placeholder = isParentMode ? 'Season #' : 'Season (optional)';

    if (isParentMode) {
        // Determine the franchise name and count existing seasons
        let franchiseName = '';
        let existingSeasons = 0;

        // Try to find the franchise from entries
        for (const e of state.entries) {
            if (e.parent_title && cleanParentTitle(e.parent_title) === state.filterParent) {
                franchiseName = state.filterParent;
                if (e.season_number) {
                    const num = parseInt(e.season_number, 10);
                    if (!isNaN(num) && num >= existingSeasons) {
                        existingSeasons = num;
                    }
                }
            } else if (e.id === state.filterParent) {
                franchiseName = cleanParentTitle(e.title);
            }
        }

        // If no franchise name found from entries, use filterParent directly
        if (!franchiseName) {
            franchiseName = state.filterParent;
        }

        // Show location hint
        locationHint.textContent = 'Adding to: ' + franchiseName;
        locationHint.classList.remove('hidden');

        // Pre-fill season with next number
        seasonInput.value = String(existingSeasons + 1);

        // Pre-fill MAL search with franchise name
        malSearchInput.value = franchiseName;
    } else {
        // Root mode
        locationHint.textContent = 'Adding to: Main folder';
        locationHint.classList.remove('hidden');
        malSearchInput.value = '';
    }

    malResults.innerHTML = '<div class="mal-empty">Type at least 2 characters to search</div>';

    const footer = editModal.querySelector('.modal-footer');
    let existingSave = footer.querySelector('.btn-accent');
    if (existingSave) existingSave.remove();
    const addBtn = document.createElement('button');
    addBtn.className = 'btn-accent';
    addBtn.textContent = 'Add to Library';
    addBtn.addEventListener('click', addNewAnime);
    footer.appendChild(addBtn);

    editModal.classList.remove('hidden');
    document.getElementById('add-folder-name').focus();

    // Auto-trigger MAL search if we pre-filled a query
    if (malSearchInput.value.trim().length >= 2) {
        malResults.innerHTML = '<div class="mal-loading"><span class="loading-dots">Searching</span></div>';
        const query = malSearchInput.value.trim();
        malSearchInput._timer = setTimeout(async () => {
            try {
                const results = await invoke('search_mal', { query });
                renderMalResults(results, query);
            } catch (e) {
                malResults.innerHTML = '<div class="mal-empty">Error: ' + e + '</div>';
            }
        }, 100);
    }
}

async function addNewAnime() {
    if (!state.rootPath) return;

    const saveBtn = editModal.querySelector('.btn-accent');

    const manualName = document.getElementById('add-folder-name').value.trim();
    const seasonInput = document.getElementById('add-season');
    const season = seasonInput.value.trim();
    const isParentMode = state.filterParent !== null;
    const malName = pendingMalResult
        ? (pendingMalResult.title_english || pendingMalResult.title)
        : '';
    const finalName = manualName || malName;

    if (!finalName) {
        const fnInput = document.getElementById('add-folder-name');
        fnInput.classList.add('error');
        setTimeout(() => {
            fnInput.classList.remove('error');
            if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Add to Library'; }
        }, 2000);
        return;
    }

    if (isParentMode && !season) {
        seasonInput.classList.add('error');
        setTimeout(() => {
            seasonInput.classList.remove('error');
            if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Add to Library'; }
        }, 2000);
        return;
    }

    const cleanName = sanitizeFolderName(finalName);
    const sep = state.rootPath.includes('\\') ? '\\' : '/';
    let folderPath;
    let franchiseNameToFilter = null;
    let parentFolderPath = null;
    let convertingStandalone = false;

    if (season) {
        if (state.filterParent !== null) {
            // Try franchise parent first
            for (const e of state.entries) {
                if (e.parent_title && cleanParentTitle(e.parent_title) === state.filterParent) {
                    parentFolderPath = e.folder_path.substring(0, e.folder_path.lastIndexOf('\\'));
                    franchiseNameToFilter = state.filterParent;
                    break;
                }
            }
            // Try standalone entry — this means converting standalone to franchise
            if (!parentFolderPath) {
                for (const e of state.entries) {
                    if (e.id === state.filterParent) {
                        parentFolderPath = e.folder_path;
                        franchiseNameToFilter = cleanParentTitle(e.title);
                        convertingStandalone = true;
                        break;
                    }
                }
            }
        }

        if (!parentFolderPath) {
            // No existing parent — create a new parent folder at root
            const root = state.rootPath.replace(/\/+$/, '').replace(/\\+$/, '');
            parentFolderPath = root + sep + cleanName;
            franchiseNameToFilter = cleanName;
        }

        folderPath = parentFolderPath.replace(/\\+$/, '') + '\\' + season + '.' + cleanName;
    } else {
        const root = state.rootPath.replace(/\/+$/, '').replace(/\\+$/, '');
        folderPath = root + sep + cleanName;
    }

    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Creating…'; }

    try {
        let entryId;
        if (convertingStandalone) {
            entryId = await invoke('convert_standalone_to_franchise', {
                standalonePath: parentFolderPath,
                seasonNum: season,
                cleanName,
                rootPath: state.rootPath,
            });
        } else {
            entryId = await invoke('create_anime_folder', { folderPath, rootPath: state.rootPath });
        }

        // For standalone entries, switch to the new entry after creation
        if (!season && !franchiseNameToFilter) {
            franchiseNameToFilter = entryId;
        }

        if (pendingMalResult) {
            const titleEn = pendingMalResult.title_english || '';
            await invoke('save_mapping', {
                rootPath: state.rootPath,
                entryId,
                malId: pendingMalResult.mal_id,
                posterUrl: pendingMalResult.image_url,
                title: pendingMalResult.title,
                titleEnglish: titleEn,
                episodes: pendingMalResult.episodes,
            });
        }

        const [freshEntries, freshMappings] = await Promise.all([
            invoke('scan_anime_folder', { rootPath: state.rootPath }),
            invoke('load_mappings', { rootPath: state.rootPath }),
        ]);

        // Abort any in-progress autoFetchPosters loop before we replace state.
        // Yield a tick so the running loop can observe the flag and exit its
        // current iteration before we reset it and launch a new pass.
        state.autoFetchAbort = true;
        await new Promise(r => setTimeout(r, 0));

        state.entries = freshEntries;
        state.mappings = freshMappings.filter(m => freshEntries.some(e => e.id === m.id));
        state.autoFetchAbort = false;

        if (franchiseNameToFilter) {
            state.filterParent = franchiseNameToFilter;
        }

        closeAddModal();
        filterEntries();
        autoFetchPosters(freshEntries, state.mappings);
    } catch (e) {
        showToast('Failed to add anime');
        console.error('Failed to add anime:', e);
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Add to Library'; }
    }
}

function closeAddModal() {
    state.addingNew = false;
    editModal.classList.add('hidden');
    document.getElementById('modal-current-info').style.display = '';
    document.querySelector('.modal-header h2').textContent = 'Link to MyAnimeList';
    document.getElementById('add-fields').classList.add('hidden');
    document.getElementById('signin-fields').classList.add('hidden');
    document.getElementById('add-folder-name').value = '';
    document.getElementById('add-season').value = '';
}

// ========== Sign-In Modal ==========

function openSignInModal() {
    state.signingIn = true;
    state.editingEntryId = null;

    document.querySelector('.modal-header h2').textContent = 'Sync with MyAnimeList';
    document.getElementById('modal-current-info').style.display = 'none';
    document.getElementById('add-fields').classList.add('hidden');
    document.getElementById('mal-results').innerHTML = '';
    document.getElementById('signin-error').classList.add('hidden');

    // Hide MAL search section when in sign-in mode
    document.querySelector('.search-field').style.display = 'none';
    document.getElementById('mal-results').style.display = 'none';

    const signinFields = document.getElementById('signin-fields');
    signinFields.classList.remove('hidden');

    const urlInput = document.getElementById('mal-url-input');
    urlInput.value = state.malUsername ? 'https://myanimelist.net/animelist/' + state.malUsername : '';
    urlInput.classList.remove('error');

    const footer = editModal.querySelector('.modal-footer');
    let existingSave = footer.querySelector('.btn-accent');
    if (existingSave) existingSave.remove();

    const syncBtn = document.createElement('button');
    syncBtn.className = 'btn-accent';
    syncBtn.textContent = 'Sync';
    syncBtn.addEventListener('click', syncWithMal);
    footer.appendChild(syncBtn);

    editModal.classList.remove('hidden');
    urlInput.focus();
}

function closeSignInModal() {
    state.signingIn = false;
    editModal.classList.add('hidden');
    document.getElementById('signin-fields').classList.add('hidden');
    document.getElementById('signin-error').classList.add('hidden');
    document.querySelector('.modal-header h2').textContent = 'Link to MyAnimeList';
    document.getElementById('mal-url-input').value = '';

    // Restore MAL search section
    document.querySelector('.search-field').style.display = '';
    document.getElementById('mal-results').style.display = '';
}

async function syncWithMal() {
    const urlInput = document.getElementById('mal-url-input');
    const errorEl = document.getElementById('signin-error');
    const saveBtn = editModal.querySelector('.btn-accent');
    let url = urlInput.value.trim();

    errorEl.classList.add('hidden');

    if (!url) {
        urlInput.classList.add('error');
        setTimeout(() => urlInput.classList.remove('error'), 2000);
        return;
    }

    // Extract username from URL
    const match = url.match(/myanimelist\.net\/animelist\/([^\/\?#]+)/i);
    if (!match) {
        urlInput.classList.add('error');
        setTimeout(() => urlInput.classList.remove('error'), 2000);
        return;
    }

    const username = match[1];
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Syncing…'; }

    try {
        const statuses = await invoke('fetch_user_animelist', { username });
        state.malUsername = username;
        state.malStatuses = {};
        state.malScores = {};
        let scoreCount = 0;
        for (const s of statuses) {
            state.malStatuses[s.mal_id] = s.status;
            if (s.score > 0) {
                state.malScores[s.mal_id] = s.score;
                scoreCount++;
            }

            // Sync episode count to mapping if we have a matching entry
            if (s.episodes) {
                const mapping = state.mappings.find(m => m.mal_id === s.mal_id);
                if (mapping && (!mapping.episodes || mapping.episodes <= 0)) {
                    mapping.episodes = s.episodes;
                }
            }
        }

        // Show debug in fetch status
        const fetchStatus = document.getElementById('fetch-status');
        fetchStatus.textContent = `Synced ${statuses.length} entries, ${scoreCount} with scores`;
        fetchStatus.classList.remove('hidden');
        setTimeout(() => fetchStatus.classList.add('hidden'), 5000);

        // Fetch profile image
        try {
            const profile = await invoke('fetch_mal_user_profile', { username });
            state.malProfileImg = profile.image_url;
        } catch (_) { /* ignore */ }

        await invoke('save_mal_username', { username });

        // Save cache to disk for offline use
        const cacheEntries = statuses.map(s => ({
            mal_id: s.mal_id,
            status: s.status,
            score: s.score,
            episodes: s.episodes,
        }));
        await invoke('save_mal_cache', {
            data: {
                username,
                profile_img: state.malProfileImg || '',
                entries: cacheEntries,
            },
        }).catch(() => {});

        // Persist updated episode counts to mapping files
        for (const s of statuses) {
            if (s.episodes) {
                const mapping = state.mappings.find(m => m.mal_id === s.mal_id);
                if (mapping && mapping.episodes === s.episodes) {
                    await invoke('save_mapping', {
                        rootPath: state.rootPath,
                        entryId: mapping.id,
                        malId: mapping.mal_id,
                        posterUrl: mapping.poster_url || '',
                        title: mapping.title || '',
                        titleEnglish: mapping.title_english || '',
                        episodes: s.episodes,
                    }).catch(() => {});
                }
            }
        }

        updateSignInButton();
        renderStatusTabs();
        closeSignInModal();
        filterEntries();

        // Fetch episode counts for any mapped entries not on the user's list
        syncMissingEpisodes();
    } catch (e) {
        console.error('Sync failed:', e);
        errorEl.textContent = typeof e === 'string' ? e : (e.message || 'Sync failed. Check the username and try again.');
        errorEl.classList.remove('hidden');
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Sync'; }
    }
}

function signOut() {
    state.malUsername = null;
    state.malStatuses = {};
    state.malScores = {};
    state.malProfileImg = null;
    state.filterStatus = 'all';
    updateSignInButton();
    renderStatusTabs();
    filterEntries();
    invoke('save_mal_username', { username: '' }).catch(() => {});
    invoke('clear_mal_cache').catch(() => {});
}

function updateSignInButton() {
    const btn = document.getElementById('signin-btn');
    const label = document.getElementById('signin-label');
    const signinIcon = btn.querySelector('.signin-icon');
    const refreshBtn = document.getElementById('mal-refresh-btn');
    if (state.malUsername) {
        label.textContent = state.malUsername;
        btn.classList.add('signed-in');
        btn.title = '';
        refreshBtn.classList.remove('hidden');
        if (state.malProfileImg) {
            signinIcon.innerHTML = '<img class="signin-avatar" src="' + state.malProfileImg + '" alt="" />';
        }
    } else {
        label.textContent = 'Sign In';
        btn.classList.remove('signed-in');
        btn.title = 'Sync with MyAnimeList';
        refreshBtn.classList.add('hidden');
        signinIcon.innerHTML = '<svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="4.5" r="3"/><path d="M2 14c0-3.5 2.5-6 5.5-6s5.5 2.5 5.5 6"/></svg>';
    }
}

function renderStatusTabs() {
    const tabs = document.getElementById('status-tabs');
    tabs.classList.remove('hidden');

    const watchingTab = tabs.querySelector('[data-status="watching"]');
    const completedTab = tabs.querySelector('[data-status="completed"]');
    const planTab = tabs.querySelector('[data-status="plan_to_watch"]');

    if (state.malUsername) {
        watchingTab.style.display = '';
        completedTab.style.display = '';
        planTab.style.display = '';
    } else {
        watchingTab.style.display = 'none';
        completedTab.style.display = 'none';
        planTab.style.display = 'none';
    }

    tabs.querySelectorAll('.tab').forEach(t => {
        t.classList.toggle('active', t.dataset.status === state.filterStatus);
    });
}

let pendingMalResult = null;

function openEditModal(entry) {
    const mapping = getMapping(entry.id);
    state.editingEntryId = entry.id;
    pendingMalResult = null;

    document.getElementById('signin-fields').classList.add('hidden');
    document.getElementById('signin-error').classList.add('hidden');
    document.querySelector('.search-field').style.display = '';
    document.getElementById('mal-results').style.display = '';
    const displayTitle = getDisplayTitle(entry, mapping);
    $('#modal-current-title').textContent = displayTitle;
    $('#modal-entry-title').textContent = displayTitle;
    $('#modal-entry-parent').textContent =
        entry.parent_title
            ? cleanParentTitle(entry.parent_title) + (entry.season_number ? ' · S' + entry.season_number : '')
            : '';

    const posterImg = $('#modal-current-poster');
    if (mapping && mapping.poster_url) {
        posterImg.src = mapping.poster_url;
        posterImg.style.display = 'block';
    } else {
        posterImg.src = '';
        posterImg.style.display = 'none';
    }

    malResults.innerHTML = '<div class="mal-empty">Search MyAnimeList to link the correct entry</div>';

    // Pre-fill search with smart query: entry title for named entries, parent for generic subfolders
    const searchHint = getSearchQuery(entry);
    malSearchInput.value = searchHint;

    // Remove any previous save button
    const existingSave = editModal.querySelector('.btn-accent');
    if (existingSave) existingSave.remove();

    editModal.classList.remove('hidden');
    malSearchInput.focus();
    malSearchInput.select();

    // Auto-trigger search with cleaned title
    if (searchHint.length >= 2) {
        malResults.innerHTML = '<div class="mal-loading"><span class="loading-dots">Searching</span></div>';
        clearTimeout(malSearchInput._timer);
        malSearchInput._timer = setTimeout(async () => {
            try {
                const results = await invoke('search_mal', { query: searchHint });
                renderMalResults(results, searchHint);
            } catch (e) {
                malResults.innerHTML = '<div class="mal-empty">Error: ' + e + '</div>';
            }
        }, 100);
    }
}

malSearchInput.addEventListener('input', () => {
    const query = malSearchInput.value.trim();
    if (query.length < 2) {
        malResults.innerHTML = '<div class="mal-empty">Type at least 2 characters to search</div>';
        return;
    }
    malResults.innerHTML = '<div class="mal-loading"><span class="loading-dots">Searching</span></div>';
    clearTimeout(malSearchInput._timer);
    malSearchInput._timer = setTimeout(async () => {
        try {
            const results = await invoke('search_mal', { query });
            renderMalResults(results, query);
        } catch (e) {
            malResults.innerHTML = '<div class="mal-empty">Error: ' + e + '</div>';
        }
    }, 400);
});

function renderMalResults(results, queryHint) {
    if (!results || results.length === 0) {
        malResults.innerHTML = '<div class="mal-empty">No results found</div>';
        return;
    }

    // Sort by match score descending so best match is first
    const scored = results.map(r => ({ r, score: scoreMatch(r.title, r.title_english || '', queryHint || '') }));
    scored.sort((a, b) => b.score - a.score);

    malResults.innerHTML = '';
    for (const { r, score } of scored) {
        const item = document.createElement('div');
        item.className = 'mal-result-item';
        item.dataset.malId = r.mal_id;

        const img = document.createElement('img');
        img.className = 'mal-result-img';
        img.src = r.image_url || '';
        img.alt = r.title;
        img.onerror = () => { img.style.display = 'none'; };

        const info = document.createElement('div');
        info.className = 'mal-result-info';

        const title = document.createElement('div');
        title.className = 'mal-result-title';

        if (r.title_english && r.title_english !== r.title) {
            const en = document.createElement('span');
            en.textContent = r.title_english;
            title.appendChild(en);

            const jp = document.createElement('span');
            jp.className = 'mal-result-title-jp';
            jp.textContent = r.title;
            title.appendChild(jp);
        } else {
            title.textContent = r.title;
        }

        const meta = document.createElement('div');
        meta.className = 'mal-result-meta';
        const parts = [r.media_type];
        if (r.episodes) parts.push(r.episodes + ' eps');
        if (r.year) parts.push(r.year);
        if (r.score) parts.push('★ ' + r.score);
        meta.textContent = parts.join(' · ');

        const synopsis = document.createElement('div');
        synopsis.className = 'mal-result-synopsis';
        synopsis.textContent = r.synopsis || 'No description available';

        info.appendChild(title);
        info.appendChild(meta);
        info.appendChild(synopsis);
        item.appendChild(img);
        item.appendChild(info);

        // Highlight best match
        if (score >= 60) {
            const badge = document.createElement('span');
            badge.className = 'match-badge';
            badge.textContent = 'Best match';
            info.insertBefore(badge, title);
        }

        item.addEventListener('click', () => {
            $$('.mal-result-item').forEach((el) => el.classList.remove('selected'));
            item.classList.add('selected');
            pendingMalResult = r;

            // Pre-fill folder name from MAL result if empty
            if (state.addingNew) {
                const fn = document.getElementById('add-folder-name');
                if (fn && !fn.value.trim()) {
                    fn.value = r.title_english || r.title;
                }
            }

            const footer = editModal.querySelector('.modal-footer');
            let saveBtn = footer.querySelector('.btn-accent');
            if (saveBtn) saveBtn.remove();
            saveBtn = document.createElement('button');
            saveBtn.className = 'btn-accent';
            if (state.addingNew) {
                saveBtn.textContent = 'Add to Library';
                saveBtn.addEventListener('click', addNewAnime);
            } else {
                saveBtn.textContent = 'Save Link';
                saveBtn.addEventListener('click', saveMalMapping);
            }
            footer.appendChild(saveBtn);
        });

        malResults.appendChild(item);
    }
}

async function saveMalMapping() {
    if (!pendingMalResult || !state.editingEntryId) return;

    const saveBtn = editModal.querySelector('.btn-accent');
    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving…';
    }

    try {
        // Delete the old cached poster so resolvePosterUrl doesn't return stale image
        _posterCaching.delete(state.editingEntryId);
        await invoke('delete_cached_poster', { entryId: state.editingEntryId }).catch(() => {});

        const titleEn = pendingMalResult.title_english || '';
        await invoke('save_mapping', {
            rootPath: state.rootPath,
            entryId: state.editingEntryId,
            malId: pendingMalResult.mal_id,
            posterUrl: pendingMalResult.image_url,
            title: pendingMalResult.title,
            titleEnglish: titleEn,
            episodes: pendingMalResult.episodes,
        });

        const newMapping = {
            id: state.editingEntryId,
            mal_id: pendingMalResult.mal_id,
            poster_url: pendingMalResult.image_url,
            title: pendingMalResult.title,
            title_english: titleEn || null,
            episodes: pendingMalResult.episodes,
        };

        const existingIdx = state.mappings.findIndex((m) => m.id === state.editingEntryId);
        if (existingIdx >= 0) {
            state.mappings[existingIdx] = newMapping;
        } else {
            state.mappings.push(newMapping);
        }

        editModal.classList.add('hidden');
        renderGrid(state.filteredEntries, state.mappings);
    } catch (e) {
        console.error('Failed to save mapping:', e);
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.textContent = 'Save Link';
        }
    }
}

$('#modal-cancel-btn').addEventListener('click', () => {
    if (state.addingNew) { closeAddModal(); return; }
    editModal.classList.add('hidden');
});

editModal.addEventListener('click', (e) => {
    if (e.target.closest('.modal-panel')) return;
    if (state.addingNew) { closeAddModal(); return; }
    editModal.classList.add('hidden');
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        contextMenu.classList.add('hidden');
        if (state.addingNew) { closeAddModal(); return; }
        editModal.classList.add('hidden');
    }
});

// ========== Re-fetch Single ==========

async function refetchSingle(entry) {
    const best = await fetchSingleEntry(entry);

    if (!best) {
        console.warn('Re-fetch: no confident match for', entry.title);
        return;
    }

    try {
        // Delete old cached poster before saving new mapping
        await invoke('delete_cached_poster', { entryId: entry.id }).catch(() => {});

        const titleEn = best.title_english || '';
        await invoke('save_mapping', {
            rootPath: state.rootPath,
            entryId: entry.id,
            malId: best.mal_id,
            posterUrl: best.image_url,
            title: best.title,
            titleEnglish: titleEn,
            episodes: best.episodes,
        });

        const existingIdx = state.mappings.findIndex((m) => m.id === entry.id);
        const newMapping = {
            id: entry.id,
            mal_id: best.mal_id,
            poster_url: best.image_url,
            title: best.title,
            title_english: titleEn || null,
            episodes: best.episodes,
        };
        if (existingIdx >= 0) {
            state.mappings[existingIdx] = newMapping;
        } else {
            state.mappings.push(newMapping);
        }

        renderGrid(state.filteredEntries, state.mappings);
    } catch (e) {
        console.warn('Save failed for', entry.title, e);
    }
}

// ========== Auto-Fetch Posters ==========

async function autoFetchPosters(entries, mappings) {
    // Determine which entries still need a poster
    let pendingIds = new Set();
    for (const entry of entries) {
        const m = mappings.find((x) => x.id === entry.id);
        if (!m || !m.poster_url) {
            pendingIds.add(entry.id);
        }
    }

    if (pendingIds.size === 0) return;

    const total = pendingIds.size;

    // Up to 3 passes — if a card fails (rate-limit, no match, network error),
    // it gets retried in the next pass instead of being silently skipped.
    for (let pass = 0; pass < 3 && pendingIds.size > 0; pass++) {
        if (state.autoFetchAbort) break;

        const pending = entries.filter(e => pendingIds.has(e.id));
        const nextPending = new Set();

        for (let i = 0; i < pending.length; i++) {
            if (state.autoFetchAbort) break;

            const entry = pending[i];

            await delay(1800);

            const best = await fetchSingleEntry(entry);

            if (best) {
                try {
                    const titleEn = best.title_english || '';
                    await invoke('save_mapping', {
                        rootPath: state.rootPath,
                        entryId: entry.id,
                        malId: best.mal_id,
                        posterUrl: best.image_url,
                        title: best.title,
                        titleEnglish: titleEn,
                        episodes: best.episodes,
                    });

                    const newMapping = {
                        id: entry.id,
                        mal_id: best.mal_id,
                        poster_url: best.image_url,
                        title: best.title,
                        title_english: titleEn || null,
                        episodes: best.episodes,
                    };
                    const existingIdx = state.mappings.findIndex(m => m.id === entry.id);
                    if (existingIdx >= 0) {
                        state.mappings[existingIdx] = newMapping;
                    } else {
                        state.mappings.push(newMapping);
                    }

                    renderGrid(state.filteredEntries, state.mappings);
                } catch (e) {
                    console.warn('Save failed for', entry.title, e);
                    nextPending.add(entry.id);
                }
                pendingIds.delete(entry.id);
            } else {
                nextPending.add(entry.id);
            }
        }

        pendingIds = nextPending;
        if (pendingIds.size > 0 && pass < 2) {
            await delay(3000);
        }
    }

    entryCount.textContent = state.entries.length;
}

/**
 * Attempt to fetch a MAL match for a single entry.
 * Tries the smart query first, then falls back to parent title.
 * Returns the best MAL result, or null if nothing confident.
 */
async function fetchSingleEntry(entry) {
    const primaryQuery = getSearchQuery(entry);
    const alreadyParent = entry.parent_title && primaryQuery === cleanParentTitle(entry.parent_title);

    let allResults = [];
    let best = null;

    try {
        const results = await invoke('search_mal', { query: primaryQuery });
        if (results) allResults = results;
        best = pickBestMatch(results || [], primaryQuery);
    } catch (e) {
        console.warn('Primary search failed for', primaryQuery, e);
    }

    if (!best && entry.parent_title && !alreadyParent) {
        const fallbackQuery = cleanParentTitle(entry.parent_title);
        if (fallbackQuery && norm(fallbackQuery) !== norm(primaryQuery)) {
            await delay(1800);
            try {
                const results = await invoke('search_mal', { query: fallbackQuery });
                if (results) allResults = allResults.concat(results);
                best = pickBestMatch(allResults, fallbackQuery);
            } catch (e) {
                console.warn('Fallback search failed for', fallbackQuery, e);
            }
        }
    }

    return best;
}

// ========== Refresh All ==========

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ========== Transfer to Phone ==========

let transferEntry = null;
let transferPhoneIp = null;
let transferQueue = [];
let transferInProgress = false;
let isMinimized = false;
let currentUnlisten = null;
let speedUnlisten = null;

function showConfirmDialog(message) {
    return new Promise((resolve) => {
        const dialog = document.getElementById('confirm-dialog');
        const msgEl = document.getElementById('confirm-message');
        msgEl.textContent = message;
        dialog.classList.remove('hidden');

        const cleanup = () => {
            dialog.classList.add('hidden');
            okBtn.removeEventListener('click', onOk);
            cancelBtn.removeEventListener('click', onCancel);
        };

        const onOk = () => { cleanup(); resolve(true); };
        const onCancel = () => { cleanup(); resolve(false); };

        const okBtn = document.getElementById('confirm-ok-btn');
        const cancelBtn = document.getElementById('confirm-cancel-btn');
        okBtn.addEventListener('click', onOk);
        cancelBtn.addEventListener('click', onCancel);
    });
}

function showToast(msg) {
    let toast = document.getElementById('toast-notification');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'toast-notification';
        toast.className = 'toast-notification';
        document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove('show'), 2500);
}

let transferSelectedFiles = [];
let transferAllFiles = [];

function showTransferState(name) {
    ['discovery', 'found', 'files', 'progress', 'complete', 'error'].forEach(s => {
        document.getElementById(`transfer-${s}`).classList.toggle('hidden', s !== name);
    });
}

async function openTransferModal(entry) {
    if (transferInProgress) {
        const phoneIp = transferPhoneIp || await invoke('discover_smb_phone').catch(() => null);
        if (phoneIp) {
            transferQueue.push({ entry, phoneIp });
            updateQueueUI();
            showToast('Queued: ' + cleanEntryTitle(entry.title) + ' (#' + transferQueue.length + ')');
        }
        return;
    }

    transferEntry = entry;
    transferPhoneIp = null;
    transferSelectedFiles = [];
    transferAllFiles = [];

    const modal = document.getElementById('transfer-modal');
    const subtitle = document.getElementById('transfer-subtitle');
    subtitle.textContent = cleanEntryTitle(entry.title);

    document.getElementById('transfer-manual-ip').classList.add('hidden');
    document.getElementById('manual-ip-error').classList.add('hidden');
    document.getElementById('manual-ip-input').value = '';

    showTransferState('discovery');
    modal.classList.remove('hidden');
    isMinimized = false;
    document.getElementById('transfer-minimized').classList.add('hidden');

    try {
        const phoneIp = await invoke('discover_smb_phone');
        transferPhoneIp = phoneIp;

        document.getElementById('transfer-phone-ip').textContent = phoneIp;
        document.getElementById('transfer-folder-name').textContent =
            `\uD83D\uDCC1 ${cleanEntryTitle(entry.title)}`;
        showTransferState('found');
        loadFileList(entry);
    } catch (e) {
        document.getElementById('transfer-manual-ip').classList.remove('hidden');
    }
}

function startTransfer() {
    if (!transferEntry || !transferPhoneIp) return;

    const selected = transferSelectedFiles.length > 0 && transferSelectedFiles.length < transferAllFiles.length
        ? transferSelectedFiles
        : null;

    if (selected && selected.length === 0) return;

    transferInProgress = true;
    showTransferState('progress');
    updateQueueUI();

    document.getElementById('progress-percentage').textContent = '0%';
    document.getElementById('progress-bar-fill').style.width = '0%';
    document.getElementById('progress-status').textContent = 'Starting transfer...';
    document.getElementById('progress-detail').textContent = '';

    if (currentUnlisten) {
        currentUnlisten.then(u => u());
        currentUnlisten = null;
    }

    if (speedUnlisten) {
        speedUnlisten.then(u => u());
        speedUnlisten = null;
    }
    speedUnlisten = window.__TAURI__.event.listen('transfer-speed', (event) => {
        const speed = event.payload;
        if (speed) {
            const detail = document.getElementById('progress-detail');
            const currentText = detail.textContent || '';
            if (currentText.includes('files')) {
                detail.textContent = currentText.replace(/ · [\d.]+ [KM]?B\/s$/, '') + ' · ' + speed;
            } else {
                detail.textContent = speed;
            }
            if (isMinimized) {
                const statusEl = document.getElementById('minimized-status');
                const st = statusEl.textContent || '';
                statusEl.textContent = st.replace(/ · [\d.]+ [KM]?B\/s$/, '') + ' · ' + speed;
            }
        }
    });

    currentUnlisten = window.__TAURI__.event.listen('transfer-progress', (event) => {
        const { percentage, files_copied, total_files, status, speed } = event.payload;
        if (percentage > 0) {
            document.getElementById('progress-percentage').textContent = percentage + '%';
            document.getElementById('progress-bar-fill').style.width = percentage + '%';
            if (isMinimized) {
                document.getElementById('minimized-percentage').textContent = percentage + '%';
                document.getElementById('minimized-bar-fill').style.width = percentage + '%';
            }
        }
        if (files_copied > 0 && total_files > 0) {
            let detail = files_copied + ' / ' + total_files + ' files';
            if (speed) detail += ' · ' + speed;
            document.getElementById('progress-detail').textContent = detail;
            if (isMinimized && speed) {
                document.getElementById('minimized-status').textContent = status + ' · ' + speed;
            }
        }
        if (status) {
            document.getElementById('progress-status').textContent = status;
            if (isMinimized && !speed) {
                document.getElementById('minimized-status').textContent = status;
            }
        }
    });

    invoke('transfer_folder_to_phone', {
        entryId: transferEntry.id,
        rootPath: state.rootPath,
        phoneIp: transferPhoneIp,
        selectedFiles: selected,
    }).then((result) => {
        if (currentUnlisten) { currentUnlisten.then(u => u()); currentUnlisten = null; }
        if (speedUnlisten) { speedUnlisten.then(u => u()); speedUnlisten = null; }
        transferInProgress = false;
        showTransferState('complete');
        document.getElementById('transfer-complete-detail').textContent = result;
        processNextInQueue();
    }).catch((e) => {
        if (currentUnlisten) { currentUnlisten.then(u => u()); currentUnlisten = null; }
        if (speedUnlisten) { speedUnlisten.then(u => u()); speedUnlisten = null; }
        transferInProgress = false;
        if (typeof e === 'string' && e.includes('Cancelled')) {
            if (transferAllFiles.length > 0) {
                showTransferState('files');
                renderFileList();
            } else {
                showTransferState('found');
                document.getElementById('transfer-folder-name').textContent =
                    `\uD83D\uDCC1 ${cleanEntryTitle(transferEntry.title)}`;
            }
        } else {
            showTransferError(e);
        }
        processNextInQueue();
    });
}

function processNextInQueue() {
    if (transferQueue.length > 0) {
        const next = transferQueue.shift();
        updateQueueUI();
        transferPhoneIp = next.phoneIp;
        transferEntry = next.entry;
        transferAllFiles = [];
        transferSelectedFiles = [];

        const subtitle = document.getElementById('transfer-subtitle');
        subtitle.textContent = cleanEntryTitle(next.entry.title);

        document.getElementById('transfer-phone-ip').textContent = next.phoneIp;
        document.getElementById('transfer-folder-name').textContent =
            `\uD83D\uDCC1 ${cleanEntryTitle(next.entry.title)}`;

        setTimeout(() => startTransfer(), 300);
    }
}

function showTransferError(msg) {
    showTransferState('error');
    document.getElementById('transfer-error-msg').textContent =
        typeof msg === 'string' ? msg : (msg.message || 'Unknown error');
}

function updateQueueUI() {
    const section = document.getElementById('transfer-queue-section');
    const count = document.getElementById('queue-count');
    const list = document.getElementById('queue-list');

    if (transferQueue.length === 0) {
        section.classList.add('hidden');
        return;
    }

    section.classList.remove('hidden');
    count.textContent = transferQueue.length;
    list.innerHTML = '';

    transferQueue.forEach((item, idx) => {
        const el = document.createElement('div');
        el.className = 'queue-item';
        el.innerHTML = `<span class="queue-item-name">${cleanEntryTitle(item.entry.title)}</span>`;

        const removeBtn = document.createElement('button');
        removeBtn.className = 'queue-item-remove';
        removeBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 2l8 8M10 2l-8 8"/></svg>';
        removeBtn.addEventListener('click', () => {
            transferQueue.splice(idx, 1);
            updateQueueUI();
        });

        el.appendChild(removeBtn);
        list.appendChild(el);
    });
}

// ── File list for transfer ──

function formatFileSize(bytes) {
    if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + ' GB';
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
    if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return bytes + ' B';
}

async function loadFileList(entry) {
    try {
        const files = await invoke('list_entry_files', {
            entryId: entry.id,
            rootPath: state.rootPath,
        });
        transferAllFiles = files;
        transferSelectedFiles = files.map(f => f.relative_path);
        document.getElementById('transfer-files-ip').textContent = transferPhoneIp;
        showTransferState('files');
        renderFileList();
    } catch (e) {
        console.warn('Failed to list files:', e);
        transferAllFiles = [];
        transferSelectedFiles = [];
    }
}

function renderFileList() {
    const list = document.getElementById('transfer-file-list');
    const countEl = document.getElementById('transfer-files-count');
    const summaryEl = document.getElementById('transfer-selected-summary');
    list.innerHTML = '';

    for (let i = 0; i < transferAllFiles.length; i++) {
        const file = transferAllFiles[i];
        const isChecked = transferSelectedFiles.includes(file.relative_path);
        const item = document.createElement('div');
        item.className = 'transfer-file-item' + (isChecked ? ' checked' : '') + (file.is_video ? ' is-video' : '');
        item.style.animationDelay = (i * 20) + 'ms';
        item.dataset.path = file.relative_path;

        item.innerHTML = `
            <div class="transfer-file-check">
                <svg class="transfer-file-check-icon" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="2 5.5 4 7.5 8 3"/>
                </svg>
            </div>
            <svg class="transfer-file-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                ${file.is_video
                    ? '<polygon points="5 3 13 8 5 13"/>'
                    : '<path d="M3 2h6.5L13 5.5V14H3z"/><polyline points="9.5 2 9.5 5.5 13 5.5"/>'}
            </svg>
            <div class="transfer-file-info">
                <span class="transfer-file-name">${file.name}</span>
                <span class="transfer-file-meta">${formatFileSize(file.size)}</span>
            </div>
        `;

        item.addEventListener('click', () => {
            const idx = transferSelectedFiles.indexOf(file.relative_path);
            if (idx >= 0) {
                transferSelectedFiles.splice(idx, 1);
                item.classList.remove('checked');
            } else {
                transferSelectedFiles.push(file.relative_path);
                item.classList.add('checked');
            }
            updateFileSelectionSummary();
        });

        list.appendChild(item);
    }

    countEl.textContent = transferAllFiles.length + ' files';
    updateFileSelectionSummary();
}

function updateFileSelectionSummary() {
    const summaryEl = document.getElementById('transfer-selected-summary');
    const totalSize = transferAllFiles
        .filter(f => transferSelectedFiles.includes(f.relative_path))
        .reduce((sum, f) => sum + f.size, 0);
    summaryEl.textContent = transferSelectedFiles.length + '/' + transferAllFiles.length + ' selected · ' + formatFileSize(totalSize);

    const startBtn = document.getElementById('transfer-start-btn');
    if (startBtn) startBtn.disabled = transferSelectedFiles.length === 0;
}

// Select all / none / videos only
document.getElementById('transfer-select-all').addEventListener('click', () => {
    transferSelectedFiles = transferAllFiles.map(f => f.relative_path);
    document.querySelectorAll('.transfer-file-item').forEach(el => el.classList.add('checked'));
    updateFileSelectionSummary();
});

document.getElementById('transfer-select-none').addEventListener('click', () => {
    transferSelectedFiles = [];
    document.querySelectorAll('.transfer-file-item').forEach(el => el.classList.remove('checked'));
    updateFileSelectionSummary();
});

document.getElementById('transfer-select-videos').addEventListener('click', () => {
    transferSelectedFiles = transferAllFiles.filter(f => f.is_video).map(f => f.relative_path);
    document.querySelectorAll('.transfer-file-item').forEach(el => {
        const path = el.dataset.path;
        el.classList.toggle('checked', transferSelectedFiles.includes(path));
    });
    updateFileSelectionSummary();
});

// ── Manual IP connect (discovery state) ──

document.getElementById('manual-ip-connect').addEventListener('click', async () => {
    const input = document.getElementById('manual-ip-input');
    const errorEl = document.getElementById('manual-ip-error');
    const ip = input.value.trim();
    errorEl.classList.add('hidden');

    if (!ip || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
        errorEl.textContent = 'Enter a valid IP address';
        errorEl.classList.remove('hidden');
        return;
    }

    const btn = document.getElementById('manual-ip-connect');
    btn.disabled = true;
    btn.textContent = 'Connecting...';

    try {
        await invoke('verify_smb_ip', { ip });
        transferPhoneIp = ip;
        document.getElementById('transfer-phone-ip').textContent = ip;
        document.getElementById('transfer-folder-name').textContent =
            `📁 ${cleanEntryTitle(transferEntry.title)}`;
        showTransferState('found');
        loadFileList(transferEntry);
    } catch (e) {
        errorEl.textContent = typeof e === 'string' ? e : 'Connection failed';
        errorEl.classList.remove('hidden');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Connect';
    }
});

document.getElementById('manual-ip-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('manual-ip-connect').click();
});

// ── Manual IP connect (error state) ──

document.getElementById('error-manual-ip-connect').addEventListener('click', async () => {
    const input = document.getElementById('error-manual-ip-input');
    const errorEl = document.getElementById('error-manual-ip-error');
    const ip = input.value.trim();
    errorEl.classList.add('hidden');

    if (!ip || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
        errorEl.textContent = 'Enter a valid IP address';
        errorEl.classList.remove('hidden');
        return;
    }

    const btn = document.getElementById('error-manual-ip-connect');
    btn.disabled = true;
    btn.textContent = 'Connecting...';

    try {
        await invoke('verify_smb_ip', { ip });
        transferPhoneIp = ip;
        document.getElementById('transfer-phone-ip').textContent = ip;
        document.getElementById('transfer-folder-name').textContent =
            `📁 ${cleanEntryTitle(transferEntry.title)}`;
        showTransferState('found');
        loadFileList(transferEntry);
    } catch (e) {
        errorEl.textContent = typeof e === 'string' ? e : 'Connection failed';
        errorEl.classList.remove('hidden');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Connect';
    }
});

document.getElementById('error-manual-ip-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('error-manual-ip-connect').click();
});

document.getElementById('transfer-close-btn').addEventListener('click', async () => {
    if (transferInProgress) {
        const ok = await showConfirmDialog('Cancel transfer? The partially transferred file will be deleted.');
        if (ok) invoke('cancel_transfer');
    }
    document.getElementById('transfer-modal').classList.add('hidden');
    document.getElementById('transfer-minimized').classList.add('hidden');
    isMinimized = false;
});

document.getElementById('transfer-start-btn').addEventListener('click', () => {
    startTransfer();
});

document.getElementById('transfer-done-btn').addEventListener('click', () => {
    document.getElementById('transfer-modal').classList.add('hidden');
    document.getElementById('transfer-minimized').classList.add('hidden');
    isMinimized = false;
});

document.getElementById('transfer-retry-btn').addEventListener('click', () => {
    if (transferEntry) {
        openTransferModal(transferEntry);
    }
});

document.getElementById('transfer-error-done-btn').addEventListener('click', () => {
    document.getElementById('transfer-modal').classList.add('hidden');
    document.getElementById('transfer-minimized').classList.add('hidden');
    isMinimized = false;
});

document.getElementById('transfer-cancel-btn').addEventListener('click', () => {
    invoke('cancel_transfer');
});

document.getElementById('transfer-minimize-btn').addEventListener('click', () => {
    document.getElementById('transfer-modal').classList.add('hidden');
    document.getElementById('transfer-minimized').classList.remove('hidden');
    isMinimized = true;
});

document.getElementById('minimized-expand-btn').addEventListener('click', () => {
    document.getElementById('transfer-minimized').classList.add('hidden');
    document.getElementById('transfer-modal').classList.remove('hidden');
    isMinimized = false;
});

document.getElementById('minimized-cancel-btn').addEventListener('click', () => {
    invoke('cancel_transfer');
});

document.getElementById('transfer-modal').addEventListener('click', async (e) => {
    if (!e.target.closest('.modal-panel')) {
        if (transferInProgress) {
            const ok = await showConfirmDialog('Cancel transfer? The partially transferred file will be deleted.');
            if (ok) invoke('cancel_transfer');
        }
        document.getElementById('transfer-modal').classList.add('hidden');
        document.getElementById('transfer-minimized').classList.add('hidden');
        isMinimized = false;
    }
});