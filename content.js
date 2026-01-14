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
let lastActiveIndex = -1;

// --- DOM Elements ---
let widget = null;
let lyricsContainer = null;

// --- Initialization ---
function init() {
    injectStyles();
    createWidget();
    startPolling();
    startSyncLoop();

    // Attempt to set up visualizer slightly later to ensure video element exists
    setTimeout(setupAudioVisualizer, 1000);
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
      <button class="control-btn" id="settings-btn" title="AI Settings">⚙️</button>
      <button class="control-btn" id="detach-lyrics-btn" title="Detach (Picture-in-Picture)">⧉</button>
      <button class="close-btn" id="hide-lyrics-btn">×</button>
    </div>
    
    <!-- Settings Panel -->
    <div id="settings-panel" class="hidden">
        <h3>AI Effects Settings</h3>
        <label>
            <input type="checkbox" id="ai-enable-toggle"> Enable Gemini AI
        </label>
        <label>
            <input type="checkbox" id="translate-toggle"> Translate to Portuguese 🇧🇷
        </label>
        <div class="input-group">
            <label for="ai-api-key">Gemini API Key:</label>
            <input type="password" id="ai-api-key" placeholder="Paste your API Key here">
        </div>
        <button id="save-settings-btn">Save & Close</button>
        <div class="settings-info">Uses model: gemini-3-flash-preview</div>
    </div>

    <div id="effects-overlay"></div>
    <div class="lyrics-container" id="lyrics-content">
      <div class="loading-text">Waiting for music...</div>
    </div>
    
    <canvas id="audio-visualizer"></canvas>
  `;

    document.body.appendChild(div);

    widget = div;
    lyricsContainer = div.querySelector('#lyrics-content');

    // Button Listeners
    div.querySelector('#hide-lyrics-btn').addEventListener('click', () => toggleWidget(false));
    div.querySelector('#detach-lyrics-btn').addEventListener('click', togglePip);

    // Settings Logic
    const settingsBtn = div.querySelector('#settings-btn');
    const settingsPanel = div.querySelector('#settings-panel');
    const saveBtn = div.querySelector('#save-settings-btn');
    const apiKeyInput = div.querySelector('#ai-api-key');
    const enableToggle = div.querySelector('#ai-enable-toggle');
    const translateToggle = div.querySelector('#translate-toggle');

    // Load saved settings
    const savedKey = localStorage.getItem('gemini_api_key');
    const savedEnabled = localStorage.getItem('gemini_enabled') === 'true';
    const savedTranslate = localStorage.getItem('gemini_sub_translate') === 'true';

    if (savedKey) apiKeyInput.value = savedKey;
    enableToggle.checked = savedEnabled;
    translateToggle.checked = savedTranslate;

    settingsBtn.addEventListener('click', () => {
        settingsPanel.classList.toggle('hidden');
    });

    saveBtn.addEventListener('click', () => {
        const key = apiKeyInput.value.trim();
        const enabled = enableToggle.checked;
        const translation = translateToggle.checked;

        if ((enabled || translation) && !key) {
            alert("Please enter a valid API Key to enable AI features.");
            return;
        }

        localStorage.setItem('gemini_api_key', key);
        localStorage.setItem('gemini_enabled', enabled);
        localStorage.setItem('gemini_sub_translate', translation);

        settingsPanel.classList.add('hidden');
        alert("Settings Saved! AI effects will generate on the next song.");
    });
    settingsPanel.classList.add('hidden');
    alert("Settings Saved! AI effects will generate on the next song.");
    // Initialize Audio Visualizer
    setupAudioVisualizer();
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

        // Inject PiP-specific Global Resets (cannot put in widget.css as it affects main page)
        const resetStyle = pipWindow.document.createElement('style');
        resetStyle.textContent = `
            html, body {
                margin: 0;
                padding: 0;
                width: 100%;
                height: 100%;
                overflow: hidden; /* Widget handles internal scroll */
                background: #000;
            }
        `;
        pipWindow.document.head.appendChild(resetStyle);

        // Copy AI-generated styles to PiP head (so effects work in PiP mode)
        const aiStyles = widget.querySelector('#ai-generated-styles');
        if (aiStyles) {
            const aiStyleCopy = pipWindow.document.createElement('style');
            aiStyleCopy.id = 'ai-generated-styles-pip';
            aiStyleCopy.textContent = aiStyles.textContent;
            pipWindow.document.head.appendChild(aiStyleCopy);
        }

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
    lastActiveIndex = -1;

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

            // Sync Logic: WAIT for AI if enabled
            if (localStorage.getItem('gemini_enabled') === 'true') {
                lyricsContainer.innerHTML = '<div class="loading-text" style="color:#b388ff; animation: pulse 1s infinite;">Generating AI Magic... ✨</div>';

                // Artificial delay/timeout race to ensure we don't hang forever
                // We give AI 4 seconds max.
                const aiPromise = generateAiEffects(bestMatch.plainLyrics || bestMatch.syncedLyrics, artist, cleanTrack);
                const timeoutPromise = new Promise(resolve => setTimeout(resolve, 4000));

                await Promise.race([aiPromise, timeoutPromise]);
            }

            // Translation Logic
            if (localStorage.getItem('gemini_sub_translate') === 'true') {
                lyricsContainer.innerHTML = '<div class="loading-text" style="color:#ffd700; animation: pulse 1s infinite;">Translating to Portuguese... 🇧🇷</div>';
                const translated = await translateLyrics(lyrics, artist, cleanTrack);
                if (translated) {
                    lyrics = translated;
                }
            }

            renderLyrics(lyrics);

        } else if (bestMatch.plainLyrics) {
            let content = bestMatch.plainLyrics;

            // Translation Logic (Plain)
            if (localStorage.getItem('gemini_sub_translate') === 'true') {
                lyricsContainer.innerHTML = '<div class="loading-text" style="color:#ffd700; animation: pulse 1s infinite;">Translating to Portuguese... 🇧🇷</div>';
                const translated = await translateLyrics(content, artist, cleanTrack);
                if (translated) {
                    content = translated;
                }
            }

            lyricsContainer.innerHTML = `<div class="lyric-line">${content.replace(/\n/g, '<br>')}</div>`;
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

        if (activeIndex !== lastActiveIndex) {
            updateActiveLine(activeIndex);
            lastActiveIndex = activeIndex;
        }

    }, SYNC_INTERVAL);
}

// --- Creative Effects System ---
const EFFECTS_MAP = [
    { id: 'love', regex: /love|heart|kiss|amor|baby|honey|paixão|amar|coração|beijo/i },
    { id: 'vision', regex: /see|saw|look|watch|eye|vision|olhar|ver|visão|olho|enxergar/i },
    { id: 'fire', regex: /fire|burn|hot|flame|fuego|quema|fogo|chama|queimar|quente|arder/i },
    { id: 'rain', regex: /rain|cry|tear|sad|water|help|chover|chorar|chuva|gota|água|lágrima/i },
    { id: 'time', regex: /time|wait|forever|clock|tempo|hora|relógio|esperar|eterno/i },
    { id: 'star', regex: /star|shine|bright|sky|fly|estrela|brilho|céu|voar/i },
    { id: 'heaven', regex: /heaven|angel|sky|god|light|holy|paraíso|anjo|deus|luz|santo/i },
    { id: 'hell', regex: /hell|devil|demon|dark|sin|beast|inferno|diabo|demônio|escuridão|pecado/i },
    { id: 'holding', regex: /hold|keep|stay|loop|replaying|replay|segurar|manter|ficar|abraçar/i },
    { id: 'world', regex: /world|earth|planet|global|mundo|terra|planeta/i },
    { id: 'phone', regex: /phone|call|ring|mobile|cell|telefone|celular|ligar|chamada|alô/i },
    { id: 'thinking', regex: /thinking|feel alone|thought|mind|wonder|brain|pensar|pensamento|mente|imaginar|cérebro/i },
    { id: 'moon', regex: /watch the moon|moon|lua|night sky/i }
];

// --- AI Generation Logic ---
async function generateAiEffects(lyricsText, artist, track, retryCount = 0, lastError = null) {
    const apiKey = localStorage.getItem('gemini_api_key');
    if (!apiKey) return;

    console.log(`Generating AI Effects for: ${track} (Attempt ${retryCount + 1})`);

    // Truncate lyrics
    const truncatedLyrics = lyricsText.substring(0, 3000);

    let prompt = `
You are a creative visual effects coder.
Analyze the FULL lyrics for the song "${track}" by "${artist}".

1. KEEP existing effects in mind (love, fire, rain, etc. are already handled).
2. Create 3 NEW, UNIQUE visual effects for *other* specific words or phrases in these lyrics.
3. Specify the exact regex/keyword that should trigger them.

### EXAMPLES OF VALID PURE CSS EFFECTS:

/* Example: Centered Glow Effect */
.effect-glow {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 80px;
  height: 80px;
  background: radial-gradient(circle, #ff0, #f00, transparent);
  box-shadow: 0 0 30px #ff0;
  border-radius: 50%;
  opacity: 0;
  animation: glowPulse 3s ease-out forwards;
}
@keyframes glowPulse {
  0% { opacity: 0; transform: translate(-50%, -50%) scale(0.5); }
  30% { opacity: 1; transform: translate(-50%, -50%) scale(1.2); }
  100% { opacity: 0; transform: translate(-50%, -50%) scale(1.5); }
}

### INSTRUCTIONS:
Return ONLY a JSON array with this format (no markdown):
[
  {
    "id": "unique_id_string", // e.g. "shatter", "neon_glow"
    "regex": "keyword1|keyword2|phrase", // e.g. "broken|glass"
    "css": ".effect-unique_id_string { ... } @keyframes ... " // ONE string containing both class and keyframes
  }
]

Rules for CSS:
1. The main class must be exactly .effect-{id}
2. It must be positioned absolute with CENTERED positioning: top: 50%; left: 50%; transform: translate(-50%, -50%);
3. You MUST define @keyframes with unique names (e.g. @keyframes move-{id}) to avoid conflicts.
4. IMPORTANT: In @keyframes, always include translate(-50%, -50%) in EVERY transform step to keep the effect centered.
5. Use pseudo-elements (::before, ::after) for shapes. NO images. Pure CSS.
6. The effect should appear (opacity 0->1) and then disappear (opacity 1->0) over 3-5s.

Lyrics:
${truncatedLyrics}
`;

    // If this is a retry, append the error to guide the AI
    if (lastError) {
        prompt += `\n\n### PREVIOUS ERROR (Review and Fix):\nThe previous output caused this error: "${lastError}".\nPlease ensure the JSON is valid and CSS is correct.`;
    }

    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${apiKey}`;

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }]
            })
        });

        if (!response.ok) {
            const err = await response.json();
            throw new Error("Gemini API Error: " + JSON.stringify(err));
        }

        const data = await response.json();
        const text = data.candidates[0].content.parts[0].text;

        // Clean markdown code blocks if present
        const cleanJson = text.replace(/```json/g, '').replace(/```/g, '').trim();

        let effects;
        try {
            effects = JSON.parse(cleanJson);
        } catch (jsonErr) {
            throw new Error("Invalid JSON returned");
        }

        // Basic Validation
        if (!Array.isArray(effects) || effects.length === 0) {
            throw new Error("JSON is not an array or is empty");
        }
        if (!effects[0].id || !effects[0].css || !effects[0].regex) {
            throw new Error("Missing required fields (id, css, regex) in first item");
        }

        injectAiEffects(effects);
        console.log("AI Effects Applied:", effects.length);

    } catch (e) {
        console.error(`AI Generation Failed (Attempt ${retryCount + 1}):`, e.message);

        if (retryCount < 2) { // Max 3 retries (0, 1, 2)
            console.log("Retrying...");
            // Recursive call with incremented retry count and error message
            generateAiEffects(lyricsText, artist, track, retryCount + 1, e.message);
        } else {
            console.error("Max retries reached. Giving up.");
        }
    }
}

function injectAiEffects(effects) {
    // 1. Inject CSS inside the widget (so it travels with the widget to PiP)
    const effectsOverlay = widget.querySelector('#effects-overlay');
    if (!effectsOverlay) return;

    let styleBlock = widget.querySelector('#ai-generated-styles');
    if (!styleBlock) {
        styleBlock = document.createElement('style');
        styleBlock.id = 'ai-generated-styles';
        // Insert before the effects-overlay, keeping styles within the widget
        widget.insertBefore(styleBlock, effectsOverlay);
    }

    const cssContent = effects.map(e => e.css).join('\n');
    styleBlock.textContent = cssContent;

    // 2. Also inject into PiP window head if we're currently in PiP mode
    if (window.documentPictureInPicture && window.documentPictureInPicture.window) {
        const pipDoc = window.documentPictureInPicture.window.document;
        let pipStyleBlock = pipDoc.getElementById('ai-generated-styles-pip');
        if (!pipStyleBlock) {
            pipStyleBlock = pipDoc.createElement('style');
            pipStyleBlock.id = 'ai-generated-styles-pip';
            pipDoc.head.appendChild(pipStyleBlock);
        }
        pipStyleBlock.textContent = cssContent;
    }

    // 3. Update EFFECTS_MAP
    // We filter out old AI effects (if we tracked them) or just push new ones.
    // For simplicity, let's keep the core ones and just append new ones. 
    // Ideally we should clear previous song's AI effects.

    // Remove previous AI effects from map (filtering by some criteria? Or just keep adding? 
    // Adding indefinitely might be bad. Let's tag them or just clear non-core IDs?)
    // A simple way: Core IDs are 'love', 'vision', etc. Any ID not in the hardcoded list is AI.

    const coreIds = ['love', 'vision', 'fire', 'rain', 'time', 'star', 'heaven', 'hell', 'holding', 'world', 'phone', 'thinking', 'moon'];

    // Filter map to only core
    const coreEffects = EFFECTS_MAP.filter(e => coreIds.includes(e.id));

    // Convert AI effects to Map format
    const newAiEffects = effects.map(e => ({
        id: e.id,
        regex: new RegExp(e.regex, 'i')
    }));

    // Rebuild global map (modifying the const array in place if possible, or reassigning if let. It's const, so we modify content)
    EFFECTS_MAP.length = 0;
    EFFECTS_MAP.push(...coreEffects, ...newAiEffects);
}

// --- Translation Logic ---
async function translateLyrics(lyricsData, artist, track) {
    const apiKey = localStorage.getItem('gemini_api_key');
    if (!apiKey) return null;

    console.log(`Translating lyrics for: ${track}...`);

    let isSynced = Array.isArray(lyricsData);
    let prompt = "";

    if (isSynced) {
        // Extract just the text to save tokens and simplify
        const lines = lyricsData.map(l => l.text).join('\n');
        prompt = `
You are a professional translator. 
Translate the following song lyrics from English (or original language) to **Portuguese (Brazil)**.
Song: "${track}" by "${artist}".

IMPORTANT INSTRUCTIONS:
1. Return ONLY the translated lines.
2. Maintain the EXACT same number of lines as the input.
3. Preserve the meaning and tone.
4. If a line is empty, keep it empty.
5. Do NOT include timestamps in your output, just the raw text lines corresponding to the input.

Input:
${lines}
`;
    } else {
        prompt = `
You are a professional translator. 
Translate the following song lyrics from English (or original language) to **Portuguese (Brazil)**.
Song: "${track}" by "${artist}".

IMPORTANT INSTRUCTIONS:
1. Return ONLY the translated text.
2. Preserve the formatting (line breaks).

Input:
${lyricsData}
`;
    }

    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${apiKey}`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
        });

        if (!response.ok) throw new Error("Translation API Limit/Error");

        const data = await response.json();
        let translatedText = data.candidates[0].content.parts[0].text.trim();

        // Clean markdown if present
        translatedText = translatedText.replace(/```json/g, '').replace(/```/g, '').trim();

        if (isSynced) {
            const translatedLines = translatedText.split('\n');
            // Re-attach timestamps
            // Safety check for length mismatch
            if (Math.abs(translatedLines.length - lyricsData.length) > 5) {
                console.warn("Translation line count mismatch significantly. Aborting translation sync.");
                return null;
            }

            return lyricsData.map((item, index) => ({
                time: item.time,
                text: translatedLines[index] || item.text // Fallback to original if index out of bounds
            }));
        } else {
            return translatedText;
        }

    } catch (e) {
        console.error("Translation Failed:", e);
        return null;
    }
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

        // Trigger Effects
        triggerEffects(activeLine.innerText);
    }
}

function triggerEffects(text) {
    const overlay = widget.querySelector('#effects-overlay');
    if (!overlay) return;

    // Clear previous effects
    overlay.innerHTML = '';

    // SPECIAL RULE: "Moon" (watch the moon) overrides "Vision" (watch)
    const moonEffect = EFFECTS_MAP.find(e => e.id === 'moon');
    if (moonEffect && moonEffect.regex.test(text)) {
        spawnEffect(moonEffect, overlay);
        return;
    }

    // SPECIAL RULE: If "vision" (see/saw) is present, only show that effect and ignore others.
    // 80% probability to prevent overuse since these words are common
    const visionEffect = EFFECTS_MAP.find(e => e.id === 'vision');
    if (visionEffect && visionEffect.regex.test(text)) {
        if (Math.random() < 0.8) {
            spawnEffect(visionEffect, overlay);
        }
        return; // Stop here, don't trigger others
    }

    // Otherwise, trigger all matching effects (stacking allowed)
    EFFECTS_MAP.forEach(effect => {
        // Skip vision since we handled it (though it wouldn't match here if we returned, but good safety)
        if (effect.id === 'vision') return;

        // 80% probability for "thinking" effect to prevent overuse since these words are common
        if (effect.id === 'thinking' && Math.random() >= 0.8) return;

        if (effect.regex.test(text)) {
            spawnEffect(effect, overlay);
        }
    });
}

function spawnEffect(effect, container) {
    // Core effect IDs that use randomized particle positions
    const coreIds = ['love', 'fire', 'rain', 'star', 'heaven', 'hell'];
    const isCoreParticleEffect = coreIds.includes(effect.id);

    // Single-instance centered effects (vision, time, moon, holding, world, phone, thinking)
    const centeredEffects = ['vision', 'time', 'moon', 'holding', 'world', 'phone', 'thinking'];
    const isCenteredEffect = centeredEffects.includes(effect.id);

    // AI-generated effects are also centered (not in coreIds or centeredEffects)
    const isAiEffect = !isCoreParticleEffect && !isCenteredEffect;

    // Spawn multiple particles only for core particle effects
    const particleCount = isCoreParticleEffect ? 15 : 1;

    // Determine which document to use (main or PiP)
    const targetDoc = (window.documentPictureInPicture && window.documentPictureInPicture.window)
        ? window.documentPictureInPicture.window.document
        : document;

    for (let i = 0; i < particleCount; i++) {
        const el = targetDoc.createElement('div');
        el.className = `effect-particle effect-${effect.id}`;
        // No text/emoji content, purely CSS shapes

        // Only randomize position for core particle effects
        if (isCoreParticleEffect) {
            el.style.left = Math.random() * 100 + '%';
            el.style.animationDelay = Math.random() * 2 + 's';

            // For CSS shapes, we might want to vary scale instead of font-size
            const scale = 0.5 + Math.random();
            el.style.transform = `scale(${scale})`;
        }
        // For centered effects (core centered + AI), don't override positioning - let CSS handle it

        container.appendChild(el);
    }
}

// --- Audio Visualizer ---
let audioContext = null;
let analyser = null;
let dataArray = null;
let visualizerCanvas = null;
let visualizerCtx = null;
let audioSource = null;

function setupAudioVisualizer() {
    // 1. Find the video element
    const videoElement = document.querySelector('video');
    if (!videoElement) {
        console.log("Visualizer: No video element found yet. Retrying in 2s...");
        setTimeout(setupAudioVisualizer, 2000);
        return;
    }

    // 2. Setup Canvas
    if (!widget) return;
    visualizerCanvas = widget.querySelector('#audio-visualizer');
    if (!visualizerCanvas) return;

    visualizerCtx = visualizerCanvas.getContext('2d');

    // Resize canvas
    function resizeCanvas() {
        if (visualizerCanvas) {
            visualizerCanvas.width = visualizerCanvas.clientWidth;
            visualizerCanvas.height = visualizerCanvas.clientHeight;
        }
    }
    window.addEventListener('resize', resizeCanvas);
    resizeCanvas();

    // 3. Initialize Audio Context (requires user interaction usually, but here we hook into existing media usually OK)
    // We try/catch because sometimes browsers block Autoplay/Context until click
    try {
        if (!audioContext) {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            audioContext = new AudioContext();
        }

        if (!analyser) {
            analyser = audioContext.createAnalyser();
            analyser.fftSize = 64; // Low res for bars looks retro/clean
            const bufferLength = analyser.frequencyBinCount;
            dataArray = new Uint8Array(bufferLength);
        }

        // 4. Connect Source (Check if already connected to avoid error)
        if (!audioSource) {
            // Important: This can fail with CORS if crossOrigin isn't set. 
            // YTM sets crossOrigin="anonymous" usually, but sometimes not.
            try {
                audioSource = audioContext.createMediaElementSource(videoElement);
                audioSource.connect(analyser);
                analyser.connect(audioContext.destination); // Connect back to output so we can hear it!
                console.log("Visualizer: Audio connected successfully!");
            } catch (err) {
                console.warn("Visualizer: Failed to connect media element source. Likely CORS issue or already connected.", err);
                // If it fails, we might not get visualization, but audio still plays.
            }
        }

        // Start Render Loop
        renderVisualizer();

    } catch (e) {
        console.error("Visualizer Setup Error:", e);
    }
}

function renderVisualizer() {
    requestAnimationFrame(renderVisualizer);

    if (!analyser || !visualizerCtx || !visualizerCanvas) return;

    // Get frequency data
    analyser.getByteFrequencyData(dataArray);

    const width = visualizerCanvas.width;
    const height = visualizerCanvas.height;

    visualizerCtx.clearRect(0, 0, width, height);

    const barWidth = (width / dataArray.length) * 2.5; // Spread them out
    let barHeight;
    let x = 0;

    // Center the bars? Or just standard left-to-right?
    // Let's do a centered "Mirrored" look for maximum "Cool"

    const centerY = height; // Draw from bottom up

    for (let i = 0; i < dataArray.length; i++) {
        barHeight = dataArray[i] / 2; // Scale down

        // Gradient Color
        const gradient = visualizerCtx.createLinearGradient(0, height, 0, height - barHeight);
        gradient.addColorStop(0, `rgba(100, 100, 255, 0.8)`); // Blueish base
        gradient.addColorStop(1, `rgba(255, 50, 150, 0.8)`); // Pinkish top

        visualizerCtx.fillStyle = gradient;

        // Simple Bottom-Up Bars
        // visualizerCtx.fillRect(x, height - barHeight, barWidth, barHeight);

        // Rounded Bars
        const radius = 5;
        // visualizerCtx.beginPath();
        // visualizerCtx.roundRect(x, height - barHeight, barWidth, barHeight, [radius, radius, 0, 0]);
        // visualizerCtx.fill();

        // Let's try floating bars (more modern)
        visualizerCtx.fillRect(x, height - barHeight, barWidth - 2, barHeight);

        x += barWidth;
    }
}

// Start
// Wait for page to be reasonably loaded
setTimeout(init, 2000);

