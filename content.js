console.log("Floating Lyrics Extension: Loaded");

// --- Configuration ---
const API_BASE = "https://lrclib.net/api";
const POLLING_INTERVAL = 1000; // Check metadata every 1s
const SYNC_INTERVAL = 200; // Check time sync every 200ms

// --- State ---
let currentTrack = {
    title: "",
    artist: "",
    duration: 0,
    uri: ""
};

let lyrics = []; // Array of { time: seconds, text: string }
let isWidgetVisible = true;
let syncIntervalId = null;
let pollIntervalId = null;

// --- DOM Elements ---
let widget = null;
let lyricsContainer = null;

// --- Initialization ---
function init() {
    injectStyles();
    createWidget();
    startPolling();
    startSyncLoop();
}

function injectStyles() {
    // We are using manifest css injection, but if we used ShadowDOM we would need to fetch and inject inside.
    // For simplicity with "overlay", standard injection often works if z-index is high enough.
    // However, to ensure style isolation, we might eventually use ShadowDOM. 
    // For now, let's stick to simple DIV injection with prefixed IDs.
    // CSS is already loaded by manifest.
}

// --- UI Creation ---
function createWidget() {
    if (document.getElementById('lyric-floating-widget')) return;

    const div = document.createElement('div');
    div.id = 'lyric-floating-widget';

    div.innerHTML = `
    <div class="widget-header">
      <button class="control-btn" id="detach-lyrics-btn" title="Detach (Picture-in-Picture)">⧉</button>
      <button class="close-btn" id="hide-lyrics-btn">×</button>
    </div>
    <div class="lyrics-container" id="lyrics-content">
      <div class="loading-text">Waiting for music...</div>
    </div>
  `;

    document.body.appendChild(div);

    widget = div;
    lyricsContainer = div.querySelector('#lyrics-content');

    div.querySelector('#hide-lyrics-btn').addEventListener('click', () => {
        toggleWidget(false);
    });

    div.querySelector('#detach-lyrics-btn').addEventListener('click', togglePip);
}

function toggleWidget(show) {
    isWidgetVisible = show;
    if (widget) {
        if (show) widget.classList.remove('hidden');
        else widget.classList.add('hidden');
    }
}

// Re-show widget if song changes? Or maybe add a floating toggle button somewhere?
// For now, let's keep it simple. If closed, maybe it stays closed until song changes?
// User said: "only a X button to close it".

// --- Document PiP Logic ---
async function togglePip() {
    // Check API support
    if (!window.documentPictureInPicture) {
        alert("Document Picture-in-Picture API is not supported in this browser.");
        return;
    }

    // If already in PiP, close it (not really reachable button-wise if moved, but good safety)
    if (window.documentPictureInPicture.window) {
        window.documentPictureInPicture.window.close();
        return;
    }

    try {
        const pipWindow = await window.documentPictureInPicture.requestWindow({
            width: 300,
            height: 400
        });

        // Copy styles
        // We explicitly link our widget.css using chrome.runtime.getURL to ensure it's loaded.
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = chrome.runtime.getURL("widget.css");
        pipWindow.document.head.appendChild(link);

        // Optional: Copy other styles if needed, but for now we prioritize our widget css
        // to avoid "SecurityError" with cross-origin sheets that fail the whole block.

        // Also ensure we specifically link our widget.css if it wasn't caught (it usually is)
        // const widgetCssUrl = chrome.runtime.getURL("widget.css"); // This might work better for stability

        // Move widget
        pipWindow.document.body.append(widget);

        // Adjust widget styles for PiP mode (full window)
        widget.classList.add('pip-mode');

        // Listen for close
        pipWindow.addEventListener("pagehide", (event) => {
            // Restore to main document
            widget.classList.remove('pip-mode');
            document.body.append(widget);
        });

    } catch (err) {
        console.error("Failed to enter PiP:", err);
    }
}

// --- API & Parsing ---
async function fetchLyrics(track, artist, duration) {
    lyricsContainer.innerHTML = '<div class="loading-text">Searching lyrics...</div>';
    lyrics = [];

    try {
        // Detect if song is modified (Sped Up, Nightcore, etc.)
        const isSpeedModified = /sped up|nightcore|slowed|reverb/i.test(track);

        // Clean title for better search results
        let cleanTrack = track
            .replace(/[(\[\{〔【].*?[)\]\}〕】]/g, "") // Remove content in brackets
            .replace(/feat\..*/i, "")
            .replace(/ft\..*/i, "")
            .replace(/\s*[-—]\s*/g, " ") // Replace dashes with space
            .replace(/official video/gi, "")
            .replace(/lyrics/gi, "")
            .replace(/audio/gi, "")
            .trim();

        // Explicitly remove "sped up", "nightcore" if they were not in brackets
        cleanTrack = cleanTrack
            .replace(/sped up/gi, "")
            .replace(/nightcore/gi, "")
            .replace(/slowed/gi, "")
            .replace(/reverb/gi, "")
            .trim();

        // Fallback: If cleanTrack is empty, revert to original
        if (!cleanTrack) cleanTrack = track;

        console.log(`Searching for: "${cleanTrack}" (Artist: "${artist}") [Modified: ${isSpeedModified}]`);

        // Strategy: 
        // 1. Search with "Track Artist"
        // 2. If no result, search with "Track" only (handles cases where "Artist" is actually a channel name like "pipo")

        let results = [];
        let url = `${API_BASE}/search?q=${encodeURIComponent(cleanTrack + " " + artist)}`;

        let res = await fetch(url);
        if (res.ok) results = await res.json();

        if (!results || results.length === 0) {
            console.log("No results with artist. Retrying with only track name...");
            url = `${API_BASE}/search?q=${encodeURIComponent(cleanTrack)}`;
            res = await fetch(url);
            if (res.ok) results = await res.json();
        }

        if (!results || results.length === 0) throw new Error("No results");

        // Find best match
        let bestMatch = null;
        const validDuration = !isNaN(duration) && duration > 0 ? duration : null;

        // 1. Try strict duration match first (if not modified)
        if (validDuration && !isSpeedModified) {
            bestMatch = results.find(item => Math.abs(item.duration - validDuration) < 5 && item.syncedLyrics);
        }

        // 2. If modified, or no strict match, find ANY synced lyrics
        // We prioritize synced lyrics.
        if (!bestMatch) {
            bestMatch = results.find(item => item.syncedLyrics);
        }

        // 3. Fallback to plain lyrics
        if (!bestMatch) {
            bestMatch = results.find(item => item.plainLyrics);
        }

        if (!bestMatch) throw new Error("No matching lyrics");

        // Calculate speed ratio if modified and duration differs
        let speedRatio = 1;
        if (isSpeedModified && validDuration && bestMatch.duration) {
            const diff = Math.abs(bestMatch.duration - validDuration);
            if (diff > 5) {
                // Assuming the found lyrics are original text, and our playing song is modified.
                // Ratio = Original / Current
                speedRatio = bestMatch.duration / validDuration;
                console.log(`Speed mod detected. Ratio: ${speedRatio.toFixed(2)} (Orig: ${bestMatch.duration}s, Curr: ${validDuration}s)`);
            }
        }

        if (bestMatch.syncedLyrics) {
            lyrics = parseLRC(bestMatch.syncedLyrics);

            // Adjust timestamps if needed
            if (speedRatio !== 1) {
                lyrics = lyrics.map(line => ({
                    ...line,
                    time: line.time / speedRatio
                }));
            }

            renderLyrics(lyrics);
        } else if (bestMatch.plainLyrics) {
            lyricsContainer.innerHTML = `<div class="lyric-line">${bestMatch.plainLyrics.replace(/\n/g, '<br>')}</div>`;
        } else {
            throw new Error("No text content");
        }

    } catch (e) {
        console.warn("Lyrics fetch error:", e);
        lyricsContainer.innerHTML = `<div class="error-text">No lyrics found for<br>"${track}"</div>`;
    }
}

function parseLRC(lrc) {
    const lines = lrc.split('\n');
    const result = [];
    const timeRegex = /\[(\d{2}):(\d{2})\.(\d{2,3})\]/;

    for (const line of lines) {
        const match = timeRegex.exec(line);
        if (match) {
            const min = parseInt(match[1]);
            const sec = parseInt(match[2]);
            const ms = parseInt(match[3].length === 3 ? match[3] : match[3] * 10); // Normalizing to ms
            const time = min * 60 + sec + ms / 1000;
            const text = line.replace(timeRegex, '').trim();
            if (text) {
                result.push({ time, text });
            }
        }
    }
    return result;
}

function renderLyrics(parsedLyrics) {
    lyricsContainer.innerHTML = '';
    parsedLyrics.forEach((line, index) => {
        const p = document.createElement('p');
        p.className = 'lyric-line';
        p.dataset.index = index;
        p.dataset.time = line.time;
        p.innerText = line.text;

        // Calculate duration
        let duration = 0;
        if (index < parsedLyrics.length - 1) {
            duration = parsedLyrics[index + 1].time - line.time;
        } else {
            // For last line, guess a reasonable duration or use remaining track time if we had it handy in this scope
            // defaulting to 5s to be safe
            duration = 5;
        }

        // Mark as "epic" if longer than 5 seconds
        if (duration > 5) {
            p.classList.add('is-epic');
            // Optional: Store duration for animation timing if needed
            p.style.setProperty('--duration', `${duration}s`);
        }

        lyricsContainer.appendChild(p);
    });
}

// --- Player Detection ---
function getPlayerState() {
    // YouTube Music selectors
    const titleEl = document.querySelector('yt-formatted-string.title.style-scope.ytmusic-player-bar');
    const artistEl = document.querySelector('.byline.style-scope.ytmusic-player-bar');
    const videoResult = document.querySelector('video');

    // Parse artist (sometimes "Artist • Album • Year")
    let artistText = artistEl ? artistEl.innerText : "";
    if (artistText) {
        artistText = artistText.split('•')[0].trim();
    }

    // Duration logic
    const duration = videoResult ? videoResult.duration : 0;

    return {
        title: titleEl ? titleEl.innerText : "",
        artist: artistText,
        duration: duration,
        currentTime: videoResult ? videoResult.currentTime : 0
    };
}

function startPolling() {
    pollIntervalId = setInterval(() => {
        const state = getPlayerState();

        if (!state.title) return; // Not ready

        // Check if track changed
        if (state.title !== currentTrack.title || Math.abs(state.duration - currentTrack.duration) > 5) { // 5s tolerance for duration
            console.log("Track Changed:", state.title);
            currentTrack = { ...state };
            // Show widget detection
            if (state.title) {
                fetchLyrics(state.title, state.artist, state.duration);
                if (!isWidgetVisible) toggleWidget(true); // Auto-show on new song?
            }
        }

    }, POLLING_INTERVAL);
}

// --- Sync Logic ---
function startSyncLoop() {
    syncIntervalId = setInterval(() => {
        if (!lyrics.length || !widget || widget.classList.contains('hidden')) return;

        const state = getPlayerState();
        const currTime = state.currentTime;

        // Find active line
        // We want the last line where time <= currTime
        let activeIndex = -1;
        for (let i = 0; i < lyrics.length; i++) {
            if (lyrics[i].time <= currTime) {
                activeIndex = i;
            } else {
                break;
            }
        }

        updateActiveLine(activeIndex);

    }, SYNC_INTERVAL);
}

function updateActiveLine(index) {
    const lines = lyricsContainer.querySelectorAll('.lyric-line');
    if (!lines.length) return;

    lines.forEach(l => l.classList.remove('active'));

    if (index >= 0 && index < lines.length) {
        const activeLine = lines[index];
        activeLine.classList.add('active');

        // Auto Scroll
        activeLine.scrollIntoView({
            behavior: 'smooth',
            block: 'center'
        });
    }
}

// Start
// Wait for page to be reasonably loaded
setTimeout(init, 2000);

