const AUTH0_DOMAIN    = "dev-c3urwbeyfq7ld873.us.auth0.com";
const AUTH0_CLIENT_ID = "nvQtTELKBfNnZRiVavXhrhU50lCnizrT";
const AUTH0_REDIRECT  = window.location.origin + "/callback";
let auth0Client = null, isSharedView = false, sharedToken = null;
let _currentUserId = null;

async function initAuth() {
    const match = window.location.pathname.match(/^\/shared\/([^\/]+)/);
    if (match) { sharedToken = match[1]; isSharedView = true; showApp(); return; }

    try {
        auth0Client = await auth0.createAuth0Client({
            domain: AUTH0_DOMAIN,
            clientId: AUTH0_CLIENT_ID,
            authorizationParams: { redirect_uri: AUTH0_REDIRECT },
            cacheLocation: "localstorage",
            useRefreshTokens: true
        });

        const isCallback = (
            window.location.pathname === "/callback" ||
            window.location.pathname === "/"
        ) && window.location.search.includes("code=") && window.location.search.includes("state=");

        if (isCallback) {
            try {
                await auth0Client.handleRedirectCallback();
            } catch(e) {
                console.warn("Callback error:", e);
            }
          
            window.history.replaceState({}, document.title, "/");
        }

        const ok = await auth0Client.isAuthenticated();
        if (ok) {
            showApp();
        } else {
            try {
                const user = await auth0Client.getUser();
                if (user) _showLoginUserHint(user);
            } catch(e) {}
            showLoginScreen();
        }
    } catch(e) {
        console.error("Auth0 init error:", e);
        showLoginScreen();
    }
}

async function _apiFetch(url, options = {}, retries = 2) {
    if (isSharedView || !auth0Client) return _fetchWithRetry(url, options, retries);
    try {
        const token = await auth0Client.getTokenSilently();
        const user  = await auth0Client.getUser();
        const uid   = user?.sub || "";
        options.headers = {
            ...options.headers,
            "Authorization": `Bearer ${token}`,
            "x-user-id": uid
        };
        if (uid) _currentUserId = uid;
    } catch(e) {
        console.error("Auth0 token/user fetch failed:", e);
    }
    return _fetchWithRetry(url, options, retries);
}

async function _fetchWithRetry(url, options, retries) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const res = await fetch(url, options);
            return res;
        } catch(e) {
           
            if (attempt < retries) {
              
                await new Promise(r => setTimeout(r, 3000));
                continue;
            }
          
            throw new Error("Cannot reach server. It may be starting up — please try again in a moment.");
        }
    }
}

function showLoginScreen() {
    document.getElementById("auth-overlay").style.display = "flex";
    document.getElementById("main-app").style.display     = "none";
}
function showApp() {
    document.getElementById("auth-overlay").style.display = "none";
    document.getElementById("main-app").style.display     = "flex";
    initApp();
}

function _showLoginUserHint(user) {
    
    const card = document.querySelector(".auth-card");
    if (!card || !user) return;
    const existing = card.querySelector(".auth-user-hint");
    if (existing) existing.remove();
    const hint = document.createElement("div");
    hint.className = "auth-user-hint";
    const pic = user.picture
        ? `<img src="${user.picture}" alt="" class="auth-user-pic" onerror="this.style.display='none'">`
        : "";
    hint.innerHTML = `${pic}<span>Welcome back, <strong>${user.name || user.email || "User"}</strong></span>`;
 
    const btn = card.querySelector("#login-btn");
    if (btn) card.insertBefore(hint, btn);
}

document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("login-btn").addEventListener("click", async () => {
        if (!auth0Client) {
            
            await initAuth();
            return;
        }
        await auth0Client.loginWithRedirect({ 
            authorizationParams: { 
                redirect_uri: AUTH0_REDIRECT,
                prompt: "login consent"
            } 
        });
    });
    document.getElementById("logout-btn").addEventListener("click", async () => {
        clearPDFStore();
        await auth0Client.logout({ logoutParams: { returnTo: window.location.origin } });
    });
});

const PDF_STORE_KEY = "pdfBinStore";
function savePDFToStore(name, b64) {
    try {
        let store = getPDFStore().filter(p => p.name !== name);
        store.push({ name, b64 });
        if (store.length > 10) store = store.slice(-10);
        localStorage.setItem(PDF_STORE_KEY, JSON.stringify(store));
    } catch(e) {}
}
function getPDFStore() {
    try { return JSON.parse(localStorage.getItem(PDF_STORE_KEY) || "[]"); } catch { return []; }
}
function getBlobUrl(name) {
    try {
        const e = getPDFStore().find(p => p.name === name); if (!e) return null;
        const b = atob(e.b64), a = new Uint8Array(b.length);
        for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i);
        return URL.createObjectURL(new Blob([a], { type:"application/pdf" }));
    } catch { return null; }
}
function clearPDFStore() { localStorage.removeItem(PDF_STORE_KEY); }
function resolveUrl(name, live) { return live || getBlobUrl(name); }


const CHART_COLORS = ["#19c37d","#3b82f6","#f59e0b","#ef4444","#8b5cf6","#06b6d4","#f97316","#84cc16","#ec4899","#14b8a6","#a78bfa","#fb923c"];
const CHART_NAMES  = { bar:"Bar Chart", line:"Line Chart", pie:"Pie Chart", doughnut:"Doughnut Chart", radar:"Radar Chart" };
const chartRegistry = {};


let chats = [], currentChat = [], currentTitle = null, currentChatId = null;
let currentChatPDFs = [], pendingPDFs = [], currentTopic = null;

const _S = {
    debounce:   null,
    abort:      null,
    lastQuery:  null,
    
    cache:      {},

    ncReady:    false, 
    ncList:     [],     
    ncFetching: false,

    chatCtx:    "",     
    ccList:     [],     

    mode:       "new",  
};


(function _injectCSS() {
    if (document.getElementById("_sg_style")) return;
    const s = document.createElement("style"); s.id = "_sg_style";
    s.textContent = `
    /* wrapper must be position:relative for panel to anchor */
    .textarea-wrapper { position: relative !important; }

    #sg-panel {
        position: absolute;
        bottom: 100%;
        left: 0;
        right: 0;
        background: var(--input-bg, #40414f);
        border: 1px solid var(--user-msg, #19c37d);
        border-bottom: none;
        border-radius: 10px 10px 0 0;
        overflow: hidden;
        display: none;
        z-index: 9999;
        box-shadow: 0 -4px 16px rgba(0,0,0,0.25);
    }
    #sg-panel.sg-visible { display: block; }

    /* When panel visible, remove top radius from textarea */
    #sg-panel.sg-visible ~ textarea,
    .textarea-wrapper:has(#sg-panel.sg-visible) textarea {
        border-top-left-radius:  0 !important;
        border-top-right-radius: 0 !important;
    }

    .sg-row {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 11px 18px;
        font-size: 16px;
        font-family: var(--font, Calibri, sans-serif);
        color: rgba(255,255,255,0.82);
        background: transparent;
        border: none;
        border-bottom: 1px solid var(--border, rgba(255,255,255,0.08));
        width: 100%;
        text-align: left;
        cursor: pointer;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        transition: background .12s, color .12s, padding-left .1s;
        line-height: 1.45;
        box-sizing: border-box;
    }
    .sg-row:last-child { border-bottom: none; }
    .sg-row:hover, .sg-row.sg-active {
        background: rgba(25,195,125,.12);
        color: #fff;
        padding-left: 24px;
    }
    .sg-row svg.sg-ic {
        flex-shrink: 0; width:14px; height:14px; opacity:.38;
        stroke: currentColor; fill: none;
        stroke-width:2; stroke-linecap:round; stroke-linejoin:round;
    }
    .sg-row .sg-txt {
        flex:1; overflow:hidden; text-overflow:ellipsis; font-size:16px;
    }
    .sg-row .sg-txt strong { font-weight:700; color:var(--user-msg,#19c37d); }
    .sg-row svg.sg-arr {
        opacity:0; width:13px; height:13px; flex-shrink:0;
        stroke:currentColor; fill:none;
        stroke-width:2; stroke-linecap:round; stroke-linejoin:round;
        transition: opacity .12s;
    }
    .sg-row:hover .sg-arr, .sg-row.sg-active .sg-arr { opacity:.38; }

    body.light-mode #sg-panel { background:#f4f6fa; border-color:rgba(23,184,112,.55); }
    body.light-mode .sg-row { color:rgba(0,0,0,.65); border-bottom-color:rgba(0,0,0,.07); }
    body.light-mode .sg-row:hover, body.light-mode .sg-row.sg-active {
        background:rgba(23,184,112,.1); color:#111;
    }
    `;
    document.head.appendChild(s);
})();


function _getPanel() {
    let p = document.getElementById("sg-panel");
    if (!p) {
        p = document.createElement("div"); p.id = "sg-panel";
        const wrap = document.querySelector(".textarea-wrapper");
        if (wrap) {
            wrap.style.position = "relative";
            wrap.appendChild(p);  
        }
    }
    return p;

}

function _showPanel(list) {
    const panel = _getPanel();
    panel.innerHTML = "";
    if (!list || !list.length) { panel.classList.remove("sg-visible"); return; }

    const q = (document.getElementById("user-input") || {}).value || "";
    list.slice(0,3).forEach(text => {
        const btn = document.createElement("button");
        btn.type = "button"; btn.className = "sg-row";

        let label = _esc(text);
        const qt  = q.trim();
        if (qt) {
            if (text.toLowerCase().startsWith(qt.toLowerCase())) {
                label = `<strong>${_esc(text.slice(0,qt.length))}</strong>${_esc(text.slice(qt.length))}`;
            } else {
                const re = new RegExp(`(${qt.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")})`, "gi");
                label = _esc(text).replace(re, "<strong>$1</strong>");
            }
        }

        btn.innerHTML = `
            <svg class="sg-ic" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <span class="sg-txt">${label}</span>
            <svg class="sg-arr" viewBox="0 0 24 24"><polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></svg>`;

        btn.addEventListener("mousedown", e => {
            e.preventDefault();
            const ta = document.getElementById("user-input");
            if (ta) {
                ta.value = text;
                autoResize(ta);
            }
            _hidePanel();
       
            sendMessage();
        });
        panel.appendChild(btn);
    });
    panel.classList.add("sg-visible");
}

function _hidePanel() {
    clearTimeout(_S.debounce);
    if (_S.abort) { _S.abort.abort(); _S.abort = null; }
    _S.lastQuery = null;
    const p = document.getElementById("sg-panel");
    if (p) { p.classList.remove("sg-visible"); p.innerHTML = ""; }
}

function _esc(s) { return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }


const _DEFAULT_SUGGESTIONS = [
    "What can you help me with today?",
    "How do I get started with coding?",
    "Can you explain a complex topic simply?",
    "What are the best practices for software architecture?",
    "Help me brainstorm some new ideas.",
    "Explain the difference between AI and machine learning.",
    "What is the best way to learn a new programming language?",
    "What are some productivity tips for developers?",
    "How does the internet actually work?",
    "Can you summarize a topic for me?",
];

async function _prefetchNewChat() {
    if (_S.ncFetching) return;

    
    if (!_S.ncReady) {
        const shuffled = [..._DEFAULT_SUGGESTIONS].sort(() => Math.random() - 0.5);
        _S.ncList  = shuffled.slice(0, 3);
        _S.ncReady = true;
        const ta = document.getElementById("user-input");
        if (ta && !ta.value.trim() && _S.mode === "new") _showPanel(_S.ncList);
    }

    _S.ncFetching = true;
    try {
        const r = await _apiFetch("/suggest", {
            method: "POST",
            headers: { "Content-Type":"application/json" },
            body: JSON.stringify({ query:"", new_chat:true, context:"" })
        });
        if (!r.ok) throw new Error();
        const d    = await r.json();
        const list = Array.isArray(d.suggestions) ? d.suggestions.slice(0,3) : [];
        if (list.length) {
            _S.ncList = list; 
            const ta = document.getElementById("user-input");
            if (ta && !ta.value.trim() && _S.mode === "new") _showPanel(list);
        }
    } catch(e) { /* keep defaults */ }
    finally { _S.ncFetching = false; }
}


function _scheduleFetch(query, delay) {
    clearTimeout(_S.debounce);
    if (_S.abort) { _S.abort.abort(); _S.abort = null; }
    _S.debounce = setTimeout(() => _fetchSugg(query), delay);
}

async function _fetchSugg(query) {
    if (_S.cache[query]) {
        const ta = document.getElementById("user-input");
        if (ta && ta.value.trim() === query) _showPanel(_S.cache[query]);
        return;
    }
    const ctrl = new AbortController(); _S.abort = ctrl;
    try {
        const r = await _apiFetch("/suggest", {
            method: "POST",
            headers: { "Content-Type":"application/json" },
            body: JSON.stringify({ query, new_chat:false, context:_S.chatCtx }),
            signal: ctrl.signal
        });
        if (!r.ok) return;
        const d    = await r.json();
        const list = Array.isArray(d.suggestions) ? d.suggestions.slice(0,3) : [];
        if (!list.length) return;
        _S.cache[query] = list;
        const ta = document.getElementById("user-input");
        if (ta && ta.value.trim() === query) { _S.lastQuery = query; _showPanel(list); }
    } catch(e) { /* AbortError — silent */ }
}

async function _loadContinueChips() {
    if (_S.ccList.length) {
        const ta = document.getElementById("user-input");
        if (ta && !ta.value.trim()) _showPanel(_S.ccList);
        return;
    }
  
    const recent = currentChat
        .filter(m => m.content && m.content !== "[PDF uploaded]")
        .slice(-5)
        .map(m => (m.role === "user" ? "User: " : "Bot: ") + m.content.replace(/<[^>]*>/g,"").slice(0,200))
        .join("\n");
    if (!recent.trim()) return;
    _S.chatCtx = recent;
    try {
        const r = await _apiFetch("/suggest", {
            method: "POST",
            headers: { "Content-Type":"application/json" },
            body: JSON.stringify({ query:"", new_chat:false, context: recent })
        });
        if (!r.ok) return;
        const d    = await r.json();
        const list = Array.isArray(d.suggestions) ? d.suggestions.slice(0,3) : [];
        if (!list.length) return;
        _S.ccList = list;  
        const ta  = document.getElementById("user-input");
        if (ta && !ta.value.trim()) _showPanel(list);
    } catch(e) {}
}

function _initSuggestions() {
    const ta = document.getElementById("user-input"); if (!ta) return;

    ta.addEventListener("focus", () => {
        const q = ta.value.trim();
        if (!q) {
            if (_S.mode === "new") {
                if (_S.ncReady && _S.ncList.length) { _showPanel(_S.ncList); return; }
                if (!_S.ncFetching) _prefetchNewChat();
            } else {
                if (_S.ccList.length) { _showPanel(_S.ccList); return; }
                _loadContinueChips();
            }
            return;
        }
        if (_S.cache[q]) { _showPanel(_S.cache[q]); return; }
        _scheduleFetch(q, 0);
    });

    ta.addEventListener("input", () => {
        const q = ta.value.trim();
        autoResize(ta);
        if (!q) {
            _hidePanel();
            if (_S.mode === "new" && _S.ncReady && _S.ncList.length)  _showPanel(_S.ncList);
            else if (_S.mode === "chat" && _S.ccList.length)           _showPanel(_S.ccList);
            return;
        }
        if (_S.cache[q]) { _showPanel(_S.cache[q]); return; }
        
        const endsWithSpace = ta.value.endsWith(" ");
        _scheduleFetch(q, endsWithSpace ? 0 : 400);
    });

    ta.addEventListener("blur", () => setTimeout(_hidePanel, 220));

    ta.addEventListener("keydown", e => {
        const panel = document.getElementById("sg-panel");
        if (!panel || !panel.classList.contains("sg-visible")) return;
        const rows   = panel.querySelectorAll(".sg-row");
        const active = panel.querySelector(".sg-row.sg-active");
        if (e.key === "ArrowDown") {
            e.preventDefault();
            const nxt = active ? (active.nextElementSibling || rows[0]) : rows[0];
            rows.forEach(r => r.classList.remove("sg-active")); if (nxt) nxt.classList.add("sg-active");
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            const prv = active ? (active.previousElementSibling || rows[rows.length-1]) : rows[rows.length-1];
            rows.forEach(r => r.classList.remove("sg-active")); if (prv) prv.classList.add("sg-active");
        } else if (e.key === "Tab") {
            const sel = panel.querySelector(".sg-row.sg-active") || rows[0];
            if (sel) {
                e.preventDefault();
                const txt = sel.querySelector(".sg-txt");
                ta.value  = txt ? txt.textContent.trim() : "";
                autoResize(ta); _hidePanel();
            }
        } else if (e.key === "Escape") { _hidePanel(); }
    });
}

function _resetSugg(mode = "new") {
    _hidePanel();
    _S.cache     = {};
    _S.chatCtx   = "";
    _S.ccList    = [];
    _S.ncReady   = false;
    _S.ncList    = [];
    _S.ncFetching = false;
    _S.lastQuery = null;
    _S.mode      = mode;
}

let _appInitDone = false; 

function initApp() {
    if (isSharedView) {
        document.querySelector(".sidebar").style.display = "none";
        const sb = document.getElementById("share-btn");   if (sb) sb.style.display = "none";
        const pw = document.querySelector(".pinned-wrapper"); if (pw) pw.style.display = "none";
        loadSharedChatView();
        return;
    }

    _resetSugg("new");
    currentChatId = null; currentTitle = null; currentChat = [];
    currentChatPDFs = []; pendingPDFs = []; currentTopic = null;
    document.getElementById("chat-box").innerHTML = "";
    document.getElementById("selected-file").innerHTML = "";
    updateTopicUI();

    if (localStorage.getItem("theme") === "light") {
        document.body.classList.add("light-mode");
        document.getElementById("theme-btn").textContent = "☀️";
    }

    if (!_appInitDone) {
        _appInitDone = true;
        const ta = document.getElementById("user-input");
        ta.addEventListener("keydown", e => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
        });
        initMic();
        _initSuggestions();
    }

    loadHistory().then(() => {
        _prefetchNewChat();
    });
}

function cleanText(t) { return t.replace(/<[^>]*>/g, ""); }
function _uid()       { return "bot-" + Date.now() + "-" + Math.floor(Math.random()*9999); }


function autoResize(el) {
    if (!el) return;
    el.style.height = "auto";
    const maxH = 400;
    el.style.height = Math.min(el.scrollHeight, maxH) + "px";
}

function typewriterAnimate(container, html, onDone) {
    const tokens = []; const temp = document.createElement("div"); temp.innerHTML = html;
    function walk(node) {
        if (node.nodeType === Node.TEXT_NODE) {
            for (const ch of node.textContent) tokens.push({ type:"char", value:ch });
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            const tag = node.tagName.toLowerCase();
            if (["br","hr","img","input","canvas"].includes(tag)) {
                tokens.push({ type:"void", html:node.outerHTML });
            } else {
                const clone = node.cloneNode(false);
                tokens.push({ type:"open", html:clone.outerHTML.replace(/><\/[^>]+>$/,">") });
                node.childNodes.forEach(walk);
                tokens.push({ type:"close", tag });
            }
        }
    }
    temp.childNodes.forEach(walk);
    container.innerHTML = "";
    const cursor = document.createElement("span"); cursor.className = "typing-cursor";
    container.appendChild(cursor);
    const stack = [container]; let idx = 0;
    const interval = setInterval(() => {
        for (let b = 0; b < 3 && idx < tokens.length; b++, idx++) {
            const tok = tokens[idx]; const cur = stack[stack.length-1];
            if (tok.type === "char") {
                const last = cur.lastChild;
                if (last && last.nodeType === Node.TEXT_NODE && last !== cursor) last.textContent += tok.value;
                else cur.insertBefore(document.createTextNode(tok.value), cursor);
            } else if (tok.type === "open") {
                const w = document.createElement("div"); w.innerHTML = tok.html + " </div>";
                const el = w.firstChild; while (el.lastChild) el.removeChild(el.lastChild);
                cur.insertBefore(el, cursor); stack.push(el); el.appendChild(cursor);
            } else if (tok.type === "close") {
                if (stack.length > 1) { stack.pop(); stack[stack.length-1].appendChild(cursor); }
            } else if (tok.type === "void") {
                const w = document.createElement("div"); w.innerHTML = tok.html;
                cur.insertBefore(w.firstChild, cursor);
            }
        }
        if (idx >= tokens.length) { clearInterval(interval); cursor.remove(); if (onDone) onDone(); }
        scrollToBottom();
    }, 8);
}

let recognition = null, micListening = false, micFinalText = "";
let audioCtx = null, analyser = null, audioSource = null, audioStream = null, waveRAF = null;

function initMic() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const btn = document.getElementById("mic-btn");
    if (!SR) { if (btn) btn.style.display = "none"; return; }
    recognition = new SR();
    recognition.continuous      = true;
    recognition.interimResults  = true;
    recognition.maxAlternatives = 3;    
    recognition.lang            = "en-US";

    recognition.onresult = function(event) {
        let interim = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
            const t = event.results[i][0].transcript;
            if (event.results[i].isFinal) micFinalText += t + " "; else interim += t;
        }
        const ta = document.getElementById("user-input");
        ta.value = (micFinalText + interim).trim(); autoResize(ta);
    };
    recognition.onerror = function(ev) {
        if (ev.error === "no-speech" || ev.error === "aborted") return;
        if (ev.error === "not-allowed") { showUploadError("Microphone permission denied."); stopMic(); }
    };

    recognition.onend = function() {
        if (micListening) {
            const ta = document.getElementById("user-input");
            if (ta.value && !ta.value.endsWith(" ")) micFinalText = ta.value + " ";
            try { recognition.start(); } catch(e) {}
        }
    };
}

function toggleMic() {
    if (!recognition) { showUploadError("Speech recognition not supported. Use Chrome or Edge."); return; }
    if (micListening) stopMic(); else startMic();
}
async function startMic() {
    const ta = document.getElementById("user-input");
    micFinalText = ta.value; if (micFinalText && !micFinalText.endsWith(" ")) micFinalText += " ";
    micListening = true;
    document.getElementById("mic-btn").classList.add("listening"); ta.classList.add("mic-listening");
    try { recognition.start(); } catch(e) {} await startWave();
}
function stopMic() {
    micListening = false;
    document.getElementById("mic-btn").classList.remove("listening");
    const ta = document.getElementById("user-input"); ta.classList.remove("mic-listening");
    try { recognition.stop(); } catch(e) {}
    ta.value = ta.value.trim(); autoResize(ta); ta.focus(); stopWave();
}
async function startWave() {
    try {
        audioStream = await navigator.mediaDevices.getUserMedia({ audio:true, video:false });
        audioCtx    = new (window.AudioContext || window.webkitAudioContext)();
        analyser    = audioCtx.createAnalyser(); analyser.fftSize = 256; analyser.smoothingTimeConstant = 0.8;
        audioSource = audioCtx.createMediaStreamSource(audioStream); audioSource.connect(analyser);
        const canvas = document.getElementById("voice-wave-canvas"); canvas.classList.add("active"); drawWave(canvas);
    } catch(err) {}
}
function drawWave(canvas) {
    if (!analyser || !micListening) return;
    const ctx = canvas.getContext("2d"); const W = canvas.offsetWidth, H = canvas.offsetHeight;
    if (canvas.width !== W) canvas.width = W; if (canvas.height !== H) canvas.height = H;
    const bufLen = analyser.frequencyBinCount; const data = new Uint8Array(bufLen);
    analyser.getByteFrequencyData(data); ctx.clearRect(0,0,W,H);
    const isDark = !document.body.classList.contains("light-mode");
    ctx.fillStyle = isDark ? "rgba(40,42,54,0.45)" : "rgba(230,235,240,0.25)"; ctx.fillRect(0,0,W,H);
    const useBins = Math.floor(bufLen*0.55); const barCount = 48, gap = 2;
    const barW = Math.max(2,(W-gap*(barCount+1))/barCount); const green = isDark ? "#19c37d" : "#17b870";
    for (let i = 0; i < barCount; i++) {
        const binIdx = Math.floor((i/barCount)*useBins); const norm = Math.pow(data[binIdx]/255,0.6);
        const bH = Math.max(3,norm*H*0.80); const x = gap+i*(barW+gap); const y = H-bH;
        const grad = ctx.createLinearGradient(x,y,x,H);
        grad.addColorStop(0,green); grad.addColorStop(0.5,green+"bb"); grad.addColorStop(1,green+"44");
        ctx.fillStyle = grad; ctx.beginPath(); const r = Math.min(barW/2,3);
        ctx.moveTo(x+r,y); ctx.lineTo(x+barW-r,y); ctx.quadraticCurveTo(x+barW,y,x+barW,y+r);
        ctx.lineTo(x+barW,H); ctx.lineTo(x,H); ctx.lineTo(x,y+r); ctx.quadraticCurveTo(x,y,x+r,y);
        ctx.closePath(); ctx.fill();
    }
    waveRAF = requestAnimationFrame(() => drawWave(canvas));
}
function stopWave() {
    if (waveRAF) { cancelAnimationFrame(waveRAF); waveRAF = null; }
    const canvas = document.getElementById("voice-wave-canvas"); canvas.classList.remove("active");
    const ctx = canvas.getContext("2d"); ctx.clearRect(0,0,canvas.width,canvas.height);
    try { if (audioSource) audioSource.disconnect(); } catch(e) {}
    try { if (audioCtx) audioCtx.close(); } catch(e) {}
    try { if (audioStream) audioStream.getTracks().forEach(t => t.stop()); } catch(e) {}
    audioCtx = analyser = audioSource = audioStream = null;
}


function toggleVizDropdown(e) {
    e.stopPropagation();
    const menu = document.getElementById("viz-dropdown-menu"), btn = document.getElementById("viz-dropdown-btn");
    const open = menu.classList.contains("show"); closeAllDropdowns();
    if (!open) { menu.classList.add("show"); btn.classList.add("open"); }
}
function toggleChartTypes(e) { e.stopPropagation(); document.getElementById("chart-types-panel").classList.toggle("show"); }
function closeAllDropdowns() {
    document.querySelectorAll(".nav-dropdown-menu").forEach(m => m.classList.remove("show"));
    document.querySelectorAll(".nav-dropdown-btn").forEach(b => b.classList.remove("open"));
    document.getElementById("chart-types-panel").classList.remove("show");
    document.querySelectorAll(".menu").forEach(m => m.classList.remove("show"));
    document.getElementById("pinned-box").classList.remove("show");
    document.getElementById("file-menu").classList.remove("show");
}
document.addEventListener("click", e => {
    if (!e.target.closest(".nav-dropdown-wrapper") && !e.target.closest(".menu") &&
        !e.target.closest(".dots") && !e.target.closest(".pinned-wrapper") &&
        !e.target.closest(".file-wrapper")) closeAllDropdowns();
    if (!e.target.closest(".export-btn") && !e.target.closest(".export-dropdown"))
        document.querySelectorAll(".export-dropdown").forEach(d => d.classList.remove("show"));
});


function openTopicModal() {
    document.getElementById("topic-modal-overlay").classList.add("show");
    document.getElementById("topic-input").value = currentTopic || "";
    updateTopicActiveRow();
    setTimeout(() => document.getElementById("topic-input").focus(), 80);
}
function closeTopicModal(e) {
    if (e && e.target !== document.getElementById("topic-modal-overlay")) return;
    document.getElementById("topic-modal-overlay").classList.remove("show");
}
function saveTopic() {
    const val = document.getElementById("topic-input").value.trim();
    if (!val) { document.getElementById("topic-input").focus(); return; }
    currentTopic = val;
    document.getElementById("topic-modal-overlay").classList.remove("show");
    updateTopicUI(); saveCurrentChat(); showTopicBanner();
}
function clearTopic() {
    currentTopic = null;
    document.getElementById("topic-input").value = ""; updateTopicActiveRow();
    document.getElementById("topic-modal-overlay").classList.remove("show");
    updateTopicUI(); removeTopicBanner(); saveCurrentChat();

}
function updateTopicUI() {
    const btn = document.getElementById("topic-lock-btn"), label = document.getElementById("topic-lock-label");
    if (currentTopic) {
        btn.classList.add("locked");
        label.textContent = currentTopic.length > 12 ? currentTopic.slice(0,12)+"…" : currentTopic;
    } else { btn.classList.remove("locked"); label.textContent = "Topic"; }
    updateTopicActiveRow();
}
function updateTopicActiveRow() {
    const row = document.getElementById("topic-active-row"), name = document.getElementById("topic-active-name");
    if (currentTopic) { row.style.display = "flex"; name.textContent = currentTopic; }
    else              { row.style.display = "none";  name.textContent = ""; }
}
function showTopicBanner() {
    removeTopicBanner();
    const banner = document.createElement("div"); banner.className = "topic-banner"; banner.id = "topic-banner";
    banner.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg><span>Topic locked to: <strong>${currentTopic}</strong></span>`;
    document.getElementById("chat-box").insertBefore(banner, document.getElementById("chat-box").firstChild);
}
function removeTopicBanner() { const old = document.getElementById("topic-banner"); if (old) old.remove(); }

async function toggleShare() {
    if (!currentChatId) { showUploadError("Start a chat first before sharing."); return; }
    const btnText = document.getElementById("share-btn-text");
    const chatObj = chats.find(c => c.id === currentChatId);
    const wasShared = chatObj ? chatObj.is_shared : false;
    if (btnText) btnText.textContent = "Toggling...";
    try {
        const res  = await _apiFetch(wasShared ? `/unshare/${currentChatId}` : `/share/${currentChatId}`, { method:"POST" });
        const data = await res.json();
        if (data.status === "success") {
            if (chatObj) chatObj.is_shared = data.is_shared; updateHistory();
            if (btnText) btnText.textContent = data.is_shared ? "Unshare" : "Share";
            if (data.is_shared && data.share_id) {
                document.getElementById("share-link-input").value = `${window.location.origin}/shared/${data.share_id}`;
                document.getElementById("share-modal-overlay").classList.add("show");
            }
        } else {
            showUploadError("Failed to toggle share state.");
            if (btnText) btnText.textContent = wasShared ? "Unshare" : "Share";
        }
    } catch(e) {
        showUploadError("Failed to toggle share state.");
        if (btnText) btnText.textContent = wasShared ? "Unshare" : "Share";
    }
}
function copyShareLink() {
    const input = document.getElementById("share-link-input"); input.select(); document.execCommand("copy");
    const toast = document.getElementById("share-copy-toast"); toast.classList.add("show");
    setTimeout(() => toast.classList.remove("show"), 2000);
}
function closeShareModal(e) {
    if (e && e.target !== document.getElementById("share-modal-overlay")) return;
    document.getElementById("share-modal-overlay").classList.remove("show");
}

function _makeEditBtn(wrapper, text, msgIndex) {
    const btn = document.createElement("button"); btn.className = "msg-edit-btn"; btn.title = "Edit";
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
    btn.addEventListener("click", () => startEditMessage(wrapper, text, msgIndex));
    return btn;
}

function renderUserMessage(text, msgIndex, container) {
    const wrapper = document.createElement("div"); wrapper.className = "msg-user-wrap"; wrapper.dataset.index = msgIndex;
    const bubble  = document.createElement("div"); bubble.className = "msg user"; bubble.textContent = text;
    wrapper.appendChild(bubble); wrapper.appendChild(_makeEditBtn(wrapper, text, msgIndex));
    container.appendChild(wrapper); return wrapper;
}

function startEditMessage(wrapper, originalText, msgIndex) {
    wrapper.innerHTML = ""; wrapper.classList.add("editing");
    const ta = document.createElement("textarea"); ta.className = "msg-edit-textarea"; ta.value = originalText; ta.rows = 1;
    const resize = () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight,120)+"px"; };
    ta.addEventListener("input", resize);
    setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length,ta.value.length); resize(); }, 10);
    const actions   = document.createElement("div"); actions.className = "msg-edit-actions";
    const saveBtn   = document.createElement("button"); saveBtn.className = "msg-edit-save"; saveBtn.textContent = "Save & Send";
    const cancelBtn = document.createElement("button"); cancelBtn.className = "msg-edit-cancel"; cancelBtn.textContent = "Cancel";
    saveBtn.addEventListener("click",   () => saveEditMessage(wrapper, ta.value.trim(), msgIndex));
    cancelBtn.addEventListener("click", () => cancelEditMessage(wrapper, originalText, msgIndex));
    actions.appendChild(cancelBtn); actions.appendChild(saveBtn);
    wrapper.appendChild(ta); wrapper.appendChild(actions);
    ta.addEventListener("keydown", e => {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); saveEditMessage(wrapper, ta.value.trim(), msgIndex); }
        if (e.key === "Escape") cancelEditMessage(wrapper, originalText, msgIndex);
    });
}

function cancelEditMessage(wrapper, originalText, msgIndex) {
    wrapper.classList.remove("editing"); wrapper.innerHTML = "";
    const bubble = document.createElement("div"); bubble.className = "msg user"; bubble.textContent = originalText;
    wrapper.appendChild(bubble); wrapper.appendChild(_makeEditBtn(wrapper, originalText, msgIndex));
}

async function saveEditMessage(wrapper, newText, msgIndex) {
    if (!newText) return;
    currentChat[msgIndex].content = newText;
    const chatBox = document.getElementById("chat-box");
    const allItems = [...chatBox.querySelectorAll(".msg-user-wrap,.msg.bot,.msg-bot-wrap")];
    let found = false;
    for (const el of allItems) { if (el === wrapper) { found = true; continue; } if (found) el.remove(); }
    currentChat.splice(msgIndex + 1);
    wrapper.classList.remove("editing"); wrapper.innerHTML = "";
    const bubble = document.createElement("div"); bubble.className = "msg user"; bubble.textContent = newText;
    wrapper.appendChild(bubble); wrapper.appendChild(_makeEditBtn(wrapper, newText, msgIndex));
    await _sendAndAppend(newText, chatBox, true);
}

function renderBotMessage(msg, container) {
    if (!msg.msgId) msg.msgId = _uid();
    const wrapper = document.createElement("div"); wrapper.className = "msg bot"; wrapper.id = msg.msgId;
    wrapper.innerHTML = msg.content || ""; container.appendChild(wrapper);
    if (msg.selected_view && msg.extracted_data) {
        const vs = document.createElement("div"); vs.className = "msg-viz-section"; wrapper.appendChild(vs);
        renderVizSection(vs, msg.selected_view, msg.chart_type||"bar", msg.extracted_data);
        if (msg.viz_explanation) {
            const ed = document.createElement("div"); ed.className = "viz-explanation"; ed.innerHTML = msg.viz_explanation; vs.appendChild(ed);
        }
    }
    _appendMsgToolbar(wrapper, msg.msgId);
}

const _msgHistory = {};  
function _appendMsgToolbar(wrapper, msgId) {
    const existing = wrapper.parentNode && wrapper.parentNode.querySelector(`.msg-toolbar[data-for="${msgId}"]`);
    if (existing) existing.remove();


    if (!_msgHistory[msgId]) {
        _msgHistory[msgId] = { versions: [wrapper.innerHTML.replace(/<div class="msg-viz-section[\s\S]*/, "").trim()], current: 0 };
    }

    const hist    = _msgHistory[msgId];
    const total   = hist.versions.length;
    const current = hist.current + 1;

    const toolbar = document.createElement("div");
    toolbar.className = "msg-toolbar";
    toolbar.dataset.for = msgId;

    const navHtml = total > 1
        ? `<button class="tb-btn tb-prev" title="Previous response" onclick="_navResponse('${msgId}',-1)">
               <svg viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"/></svg>
           </button>
           <span class="tb-counter">${current}/${total}</span>
           <button class="tb-btn tb-next" title="Next response" onclick="_navResponse('${msgId}',1)">
               <svg viewBox="0 0 24 24"><polyline points="9 6 15 12 9 18"/></svg>
           </button>`
        : "";

    toolbar.innerHTML = `
        ${navHtml}
        <button class="tb-btn tb-copy" title="Copy" onclick="_copyMsg('${msgId}')">
            <svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        </button>
        <button class="tb-btn tb-regen" title="Regenerate response" onclick="_regenerateResponse('${msgId}')">
            <svg viewBox="0 0 24 24"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.5"/></svg>
        </button>`;

    if (wrapper.parentNode) wrapper.parentNode.insertBefore(toolbar, wrapper.nextSibling);
}

function _navResponse(msgId, dir) {
    const hist = _msgHistory[msgId];
    if (!hist || hist.versions.length <= 1) return;
    hist.current = (hist.current + dir + hist.versions.length) % hist.versions.length;
    const wrapper = document.getElementById(msgId);
    if (wrapper) {
        wrapper.innerHTML = hist.versions[hist.current];
        wrapTables(wrapper);
    }
    _appendMsgToolbar(wrapper, msgId);
}

function _copyMsg(msgId) {
    const wrapper = document.getElementById(msgId);
    if (!wrapper) return;
    const text = wrapper.innerText || wrapper.textContent || "";
    navigator.clipboard.writeText(text).catch(() => {
        const ta = document.createElement("textarea");
        ta.value = text; document.body.appendChild(ta); ta.select();
        document.execCommand("copy"); document.body.removeChild(ta);
    });
   
    const btn = document.querySelector(`.msg-toolbar[data-for="${msgId}"] .tb-copy`);
    if (btn) { btn.style.color = "#19c37d"; setTimeout(() => btn.style.color = "", 1000); }
}

async function _regenerateResponse(msgId) {
    const botIdx = currentChat.findIndex(m => m.msgId === msgId);
    if (botIdx < 0) return;

    let userMsg = null;
    for (let i = botIdx - 1; i >= 0; i--) {
        if (currentChat[i].role === "user") { userMsg = currentChat[i]; break; }
    }
    if (!userMsg) return;

    const chatBox  = document.getElementById("chat-box");
    const wrapper  = document.getElementById(msgId);
    const toolbar  = chatBox.querySelector(`.msg-toolbar[data-for="${msgId}"]`);


    if (toolbar) toolbar.remove();

    wrapper.innerHTML = `<span></span><span></span><span></span>`;
    wrapper.classList.add("loading");
    scrollToBottom();

    try {
        const pdfContent = currentChatPDFs.map(p => p.content).join("\n\n---\n\n");
        const history    = currentChat.slice(0, botIdx).filter(m => !m.vizType && m.content).slice(-10).map(m => ({ role:m.role, content:m.content }));
        const endpoint   = isSharedView ? "/shared/chat/"+sharedToken : "/chat";
        const res = await _apiFetch(endpoint, {
            method: "POST", headers: { "Content-Type":"application/json" },
            body: JSON.stringify({
                message: userMsg.content, pdf_text: pdfContent,
                use_pdf: currentChatPDFs.length > 0,
                conversation_history: history,
                topic_lock: currentTopic || null
            })
        });
        if (!res.ok) { const err = await res.json().catch(()=>({})); throw new Error(err.detail||`Server error ${res.status}`); }
        const data      = await res.json();
        const replyHtml = data.reply || "<p>Sorry, no response received.</p>";

        wrapper.classList.remove("loading");
        wrapper.innerHTML = "";

        typewriterAnimate(wrapper, replyHtml, () => {
            
            if (!_msgHistory[msgId]) _msgHistory[msgId] = { versions: [], current: 0 };
            _msgHistory[msgId].versions.push(replyHtml);
            _msgHistory[msgId].current = _msgHistory[msgId].versions.length - 1;

            
            currentChat[botIdx] = { ...currentChat[botIdx], content: replyHtml };

            wrapTables(wrapper); scrollToBottom();
            _appendMsgToolbar(wrapper, msgId);
            if (!isSharedView) saveCurrentChat();
        });
    } catch(err) {
        wrapper.classList.remove("loading");
        wrapper.innerHTML = `<p style="color:#e03e3e">Regenerate failed: ${err.message}</p>`;
        _appendMsgToolbar(wrapper, msgId);
    }
}

async function _sendAndAppend(msg, chatBox, isEdit = false) {
    const ld = document.createElement("div"); ld.className = "msg bot loading"; ld.innerHTML = "<span></span><span></span><span></span>";
    chatBox.appendChild(ld); scrollToBottom();
    try {
        const pdfContent = currentChatPDFs.map(p => p.content).join("\n\n---\n\n");
        const history    = currentChat.filter(m => !m.vizType && m.content).slice(-10).map(m => ({ role:m.role, content:m.content }));
        const endpoint   = isSharedView ? "/shared/chat/"+sharedToken : "/chat";
        const res = await _apiFetch(endpoint, {
            method: "POST", headers: { "Content-Type":"application/json" },
            body: JSON.stringify({
                message: msg, pdf_text: pdfContent,
                use_pdf: currentChatPDFs.length > 0,
                conversation_history: history,
                topic_lock: currentTopic || null  
            })
        });
        if (!res.ok) { const err = await res.json().catch(()=>({})); throw new Error(err.detail||`Server error ${res.status}`); }
        const data      = await res.json(); ld.remove();
        const replyHtml = data.reply || "<p>Sorry, no response received.</p>";
        const botMsg    = { role:"bot", content:replyHtml, msgId:_uid() };
        const wrapper   = document.createElement("div"); wrapper.className = "msg bot"; wrapper.id = botMsg.msgId;
        chatBox.appendChild(wrapper);
        typewriterAnimate(wrapper, replyHtml, () => {
            currentChat.push(botMsg); wrapTables(wrapper); scrollToBottom();
           
            _msgHistory[botMsg.msgId] = { versions: [replyHtml], current: 0 };
            _appendMsgToolbar(wrapper, botMsg.msgId);
            if (isSharedView) return;
            saveCurrentChat();
            _S.ccList  = [];
            _S.chatCtx = "";
            _loadContinueChips();
        });
    } catch(err) {
        ld.remove();
        const ed = document.createElement("div"); ed.className = "msg bot error";
        const msg = err.message || "Unknown error";
        ed.textContent = msg.includes("Cannot reach server")
            ? "⚠ Server is starting up, please wait a moment and try again."
            : "Error: " + msg;
        chatBox.appendChild(ed); scrollToBottom();
    }
}

async function requestVisualization(viewType, chartType) {
    closeAllDropdowns();
    const botMsgs = currentChat.filter(m => m.role==="bot" && !m.vizType);
    if (!botMsgs.length) { showUploadError("Ask a question first, then click Visualize."); return; }
    const lastBot = botMsgs[botMsgs.length-1];
    const msgEl   = document.getElementById(lastBot.msgId); if (!msgEl) return;
    let vizSection = msgEl.querySelector(".msg-viz-section");
    if (!vizSection) { vizSection = document.createElement("div"); vizSection.className = "msg-viz-section"; msgEl.appendChild(vizSection); }
    vizSection.innerHTML = `<div class="viz-loading"><div class="viz-spinner"></div>${viewType==="table"?"Extracting table...":"Extracting data..."}</div>`;
    scrollToBottom();
    try {
        const chatText    = currentChat.filter(m=>m.role==="bot"&&!m.vizType)
            .map(m=>{const d=document.createElement("div");d.innerHTML=m.content||"";return d.textContent;}).join("\n\n");
        const htmlContent = viewType==="table" ? (lastBot.content||"") : "";
        
        const res = await _apiFetch("/extract_viz", {
            method:"POST", headers:{"Content-Type":"application/json"},
            body: JSON.stringify({ viz_type:viewType, html_content:htmlContent, chat_text:chatText, chart_type:chartType||"bar" })
        });
        if (!res.ok) throw new Error(`Extract failed ${res.status}`);
        const extracted = await res.json();

        lastBot.selected_view  = viewType;
        lastBot.chart_type     = chartType;
        lastBot.extracted_data = extracted;

        renderVizSection(vizSection, viewType, chartType, extracted);
        wrapTables(vizSection);
        
        if (extracted.explanation) {
            lastBot.viz_explanation = extracted.explanation;
            const expDiv = document.createElement("div"); expDiv.className = "viz-explanation";
            expDiv.innerHTML = extracted.explanation; vizSection.appendChild(expDiv);
        }

        scrollToBottom(); saveCurrentChat();
    } catch(err) { vizSection.innerHTML = `<div class="viz-nodata">⚠ Could not extract data: ${err.message}</div>`; }
}

function renderVizSection(container, viewType, chartType, data) {
    const oldCanvas = container.querySelector("canvas");
    if (oldCanvas && chartRegistry[oldCanvas.id]) { chartRegistry[oldCanvas.id].destroy(); delete chartRegistry[oldCanvas.id]; }
    const expDiv = container.querySelector(".viz-explanation"); container.innerHTML = "";
    if (expDiv) container.appendChild(expDiv);
    if (viewType==="table") {
        if (!data||!data.headers||!data.rows||!data.rows.length) { container.innerHTML=`<div class="viz-nodata">ℹ No table data found.</div>`; return; }
        renderTable(container, data);
    } else {
        if (!data||!data.labels||data.labels.length<2) { container.innerHTML=`<div class="viz-nodata">ℹ Not enough numeric data to chart.</div>`; return; }
        renderChart(container, chartType||"bar", data);
    }
}
function renderTable(container, data) {
    const hdrs = data.headers.map(h=>`<th>${h}</th>`).join("");
    const rows = data.rows.map(r=>`<tr>${r.map(c=>`<td>${c}</td>`).join("")}</tr>`).join("");
    container.innerHTML = `<div class="viz-table-wrap"><div class="viz-table-title">📋 Table View</div><table><thead><tr>${hdrs}</tr></thead><tbody>${rows}</tbody></table></div>`;
}
function renderChart(container, chartType, data) {
    const canvasId = "viz-"+Date.now()+"-"+Math.floor(Math.random()*9999);
    container.innerHTML = `<div class="viz-chart-wrap"><div class="viz-chart-title">📊 ${CHART_NAMES[chartType]||"Chart"}</div><div class="viz-canvas-box"><canvas id="${canvasId}"></canvas></div></div>`;
    requestAnimationFrame(() => {
        const canvas = document.getElementById(canvasId); if (!canvas) return;
        const style  = getComputedStyle(document.documentElement);
        const textColor = style.getPropertyValue("--chart-text").trim()||"#e0e0e0";
        const gridColor = style.getPropertyValue("--chart-grid").trim()||"rgba(255,255,255,0.1)";
        const isCirc    = ["pie","doughnut"].includes(chartType); const isRadar = chartType==="radar";
        const numValues = data.values.map(v=>{const n=parseFloat(String(v).replace(/[^0-9.\-]/g,""));return isNaN(n)?0:n;});
        const count     = numValues.length;
        const bgColors  = Array.from({length:count},(_,i)=>CHART_COLORS[i%CHART_COLORS.length]+"cc");
        const bdrColors = Array.from({length:count},(_,i)=>CHART_COLORS[i%CHART_COLORS.length]);
        let datasets;
        if (isCirc||isRadar)       datasets=[{label:data.yLabel||"Value",data:numValues,backgroundColor:bgColors,borderColor:bdrColors,borderWidth:2}];
        else if (chartType==="line") datasets=[{label:data.yLabel||"Value",data:numValues,backgroundColor:bgColors[0],borderColor:bdrColors[0],borderWidth:2,fill:true,tension:0.4,pointRadius:6,pointHoverRadius:9,pointBackgroundColor:bdrColors}];
        else                        datasets=[{label:data.yLabel||"Value",data:numValues,backgroundColor:bgColors,borderColor:bdrColors,borderWidth:2,borderRadius:4}];
        const font = {family:"'Calibri',sans-serif"};
        const scalesConfig = isCirc?{}:isRadar
            ?{r:{ticks:{color:textColor,backdropColor:"transparent",font:{size:11,...font}},grid:{color:gridColor},pointLabels:{color:textColor,font:{size:12,...font}}}}
            :{x:{title:{display:true,text:data.xLabel||"Category",color:textColor,font:{size:13,weight:"bold",...font}},ticks:{color:textColor,font,maxRotation:40},grid:{color:gridColor}},
              y:{title:{display:true,text:data.yLabel||"Value",color:textColor,font:{size:13,weight:"bold",...font}},ticks:{color:textColor,font},grid:{color:gridColor},beginAtZero:true}};
        chartRegistry[canvasId] = new Chart(canvas,{type:chartType,data:{labels:data.labels,datasets},
            options:{responsive:true,maintainAspectRatio:false,animation:{duration:500},
                plugins:{legend:{display:true,labels:{color:textColor,font:{size:13,...font},padding:16,usePointStyle:true}},
                    tooltip:{bodyFont:{size:13,...font},titleFont:{size:13,...font}}},scales:scalesConfig}});
    });
}

let _historyFetching = false;


function _updateLocalChat(id, title, topic, pdfs) {
    const existing = chats.find(c => c.id === id);
    if (existing) {
        existing.title = title;
        existing.topic = topic;
    } else {
        chats.push({
            id, title, topic,
            is_pinned: false, is_shared: false,
            original_index: chats.length
        });
    }
    updateHistory();
}

function saveCurrentChat() {
    if (!currentTitle) return;
    _apiFetch("/save_chat", {
        method: "POST", headers: { "Content-Type":"application/json" },
        body: JSON.stringify({
            id: currentChatId, title: currentTitle, messages: currentChat,
            pdfs: currentChatPDFs.map(p=>({name:p.name,content:p.content})),
            topic: currentTopic || null
        })
    }).then(r=>r.json()).then(data=>{
        if (data.id) {
            currentChatId = data.id;
           
            _updateLocalChat(data.id, data.title || currentTitle, currentTopic || null,
                currentChatPDFs.map(p=>({name:p.name})));
        }
    })
    .catch(e=>console.warn("Save:",e));
}

function newChat() {
    currentChatId=null; currentTitle=null; currentChat=[]; currentChatPDFs=[]; pendingPDFs=[]; currentTopic=null;
    document.getElementById("chat-box").innerHTML="";
    document.getElementById("selected-file").innerHTML="";
    closePdfPreview(); if(micListening) stopMic(); updateTopicUI();
    _resetSugg("new");
    _prefetchNewChat();  
}

async function loadHistory() {
    if (_historyFetching) return;
    _historyFetching = true;
    try {
        const r = await _apiFetch("/chats"); chats = await r.json() || [];
    } catch { chats = []; }
    finally { _historyFetching = false; }
    updateHistory();
}
function updateHistory() {
    const q  = document.getElementById("search-box").value.toLowerCase();
    const fc = chats.filter(c => c.title.toLowerCase().includes(q));
    renderChatList(fc.filter(c=>c.is_shared),  "shared-history");
    renderChatList(fc.filter(c=>!c.is_shared), "chat-history");
}
function searchChats() { updateHistory(); }

function renderChatList(list, containerId) {
    const container = document.getElementById(containerId); if (!container) return;
    const pinned   = list.filter(c=>c.is_pinned);
    const unpinned = list.filter(c=>!c.is_pinned).sort((a,b)=>{
        const ai = a.original_index !== undefined ? a.original_index : chats.indexOf(a);
        const bi = b.original_index !== undefined ? b.original_index : chats.indexOf(b);
        return ai - bi;
    });
    const frag = document.createDocumentFragment();
    [...pinned,...unpinned].forEach(chat => {
        const id = chat.id; const li = document.createElement("li");
        li.className = "history-item"+(chat.is_pinned?" pinned":"");
        li.innerHTML = `<div class="title-container" id="title-${id}"><span class="chat-title" onclick="loadChat(${id})">${chat.is_pinned?"📌 ":""}${chat.is_shared?"🔗 ":""}${cleanText(chat.title)}</span></div><span class="dots" onclick="toggleMenu(event,'${id}')">⋮</span><div class="menu" id="menu-${id}"><div onclick="startRename('${encodeURIComponent(chat.title)}',${id})">Rename</div><div onclick="deleteChat(${id})">Delete</div><div onclick="togglePin(${id})">${chat.is_pinned?"Unpin":"Pin"}</div></div>`;
        frag.appendChild(li);
    });
    container.innerHTML = ""; container.appendChild(frag);
}

function toggleMenu(e, id) {
    e.stopPropagation(); document.querySelectorAll(".menu").forEach(m=>m.classList.remove("show"));
    const el = document.getElementById(`menu-${id}`); if (el) el.classList.toggle("show");
}
function togglePinned(e) {
    e.stopPropagation(); closeAllDropdowns();
    const box = document.getElementById("pinned-box");
    if (box.classList.contains("show")) { box.classList.remove("show"); return; }
    const pinnedList = chats.filter(c=>c.is_pinned&&!c.is_shared);
    box.innerHTML = pinnedList.length===0 ? "<div class='pinned-empty'>No pinned chats</div>"
        : pinnedList.map(c=>`<div class="pinned-item" onclick="loadChat(${c.id});document.getElementById('pinned-box').classList.remove('show')">📌 ${cleanText(c.title)}</div>`).join("");
    box.classList.add("show");
}

async function togglePin(id) {
    const numId = Number(id); const chat = chats.find(c=>Number(c.id)===numId); if (!chat) return;
    const ns = !chat.is_pinned;
    try {
        const res = await _apiFetch(`/chat/${numId}`, { method:"PATCH", headers:{"Content-Type":"application/json"}, body:JSON.stringify({is_pinned:ns}) });
        if (!res.ok) return;
        if (ns && chat.original_index === undefined) chat.original_index = chats.indexOf(chat);
        chat.is_pinned = ns; updateHistory();
    } catch(e) { console.error("togglePin:", e); }
}
async function deleteChat(id) {
    try {
        await _apiFetch(`/chat/${id}`, {method:"DELETE"});
        chats = chats.filter(c=>c.id!==id); if(currentChatId===id) newChat(); updateHistory();
    } catch(e) { console.error(e); }
}
function startRename(enc, id) {
    const title = decodeURIComponent(enc); const titleEl = document.getElementById(`title-${id}`); if (!titleEl) return;
    titleEl.innerHTML = `<input class="rename-input" id="rename-${id}" value="${title}" onclick="event.stopPropagation()"><button class="rename-btn" onclick="event.stopPropagation();saveRename(${id})">✔</button><button class="rename-cancel-btn" onclick="event.stopPropagation();cancelRename()">✕</button>`;
    const i = document.getElementById(`rename-${id}`); i.focus(); i.select();
}
function cancelRename() { updateHistory(); }
async function saveRename(id) {
    const ri = document.getElementById(`rename-${id}`); if (!ri) return;
    const nt = ri.value.trim(); if (!nt) { updateHistory(); return; }
    if (chats.find(c=>c.title===nt&&c.id!==id)) { alert("Title exists!"); updateHistory(); return; }
    try {
        await _apiFetch(`/chat/${id}`, { method:"PATCH", headers:{"Content-Type":"application/json"}, body:JSON.stringify({title:nt}) });
        const chat = chats.find(c=>c.id===id); if(chat) chat.title=nt; if(currentChatId===id) currentTitle=nt;
        updateHistory();
    } catch(e) { alert("Failed to rename."); updateHistory(); }
}


function toggleFileMenu(e) { e.stopPropagation(); document.getElementById("file-menu").classList.toggle("show"); }
async function handlePDF(e) {
    const file = e.target.files[0]; if (!file) return;
    document.getElementById("file-menu").classList.remove("show");
    if (file.size > 10*1024*1024) { showUploadError("PDF too large (max 10MB)."); e.target.value=""; return; }
    const lid = Date.now(); addPendingPDFUI(file.name, lid, true, null);
    try {
        const fd = new FormData(); fd.append("file", file);
        const res = await _apiFetch("/upload_pdf", { method:"POST", body:fd });
        let data = {}; try { data = await res.json(); } catch {}
        if (!res.ok) throw new Error(data.detail||`Server error ${res.status}`);
        if (!data.content) throw new Error("No text from PDF.");
        removePendingPDFUI(lid);
        const blobUrl = URL.createObjectURL(file);
        const reader  = new FileReader();
        reader.onload = ev => savePDFToStore(file.name, btoa(ev.target.result));
        reader.readAsBinaryString(file);
        const pd = {id:Date.now(),name:file.name,content:data.content,url:blobUrl};
        pendingPDFs.push(pd); addPendingPDFUI(pd.name, pd.id, false, blobUrl);
    } catch(err) { removePendingPDFUI(lid); showUploadError("Upload failed: "+err.message); }
    e.target.value = "";
}
function showUploadError(msg) {
    const w = document.getElementById("upload-error-wrap");
    w.innerHTML = `<div class="upload-error">⚠ ${msg}</div>`;
    clearTimeout(w._t); w._t = setTimeout(()=>{w.innerHTML="";}, 5000);
}
function makePdfChip(name, url, isPending) {
    const div = document.createElement("div"); const resolved = resolveUrl(name, url);
    if (isPending) {
        div.className="selected-pdf-item";
        div.innerHTML=`<span class="pdf-icon">📄</span><span class="pdf-name">${name}</span>`;
    } else {
        div.className="msg-pdf"+(resolved?"":" no-preview");
        div.innerHTML=`<span class="pdf-icon">📄</span><span class="pdf-label">${name}</span>`;
        if (!resolved) div.title="PDF not stored — re-upload";
    }
    if (resolved) {
        div.dataset.pdfUrl = resolved; div.dataset.pdfName = name;
        div.addEventListener("click", ev=>{ if (!ev.target.classList.contains("pdf-remove")) previewPDF(div.dataset.pdfUrl,div.dataset.pdfName); });
    }
    return div;
}
function addPendingPDFUI(name, id, isLoading, url) {
    const c = document.getElementById("selected-file");
    if (isLoading) {
        const d = document.createElement("div"); d.className="selected-pdf-item"; d.id=`pending-pdf-${id}`;
        d.innerHTML=`<span class="pdf-icon">📄</span><span class="pdf-name">${name}</span><span class="pdf-loading">Uploading...</span>`;
        c.appendChild(d);
    } else {
        const d = makePdfChip(name,url,true); d.id=`pending-pdf-${id}`;
        const rb = document.createElement("span"); rb.className="pdf-remove"; rb.textContent="✕";
        rb.addEventListener("click", ev=>{ev.stopPropagation();removePendingPDF(id);}); d.appendChild(rb); c.appendChild(d);
    }
}
function removePendingPDFUI(id) { const el=document.getElementById(`pending-pdf-${id}`); if(el) el.remove(); }
function removePendingPDF(id)   { pendingPDFs=pendingPDFs.filter(p=>p.id!==id); removePendingPDFUI(id); }
function previewPDF(url, name) {
    if (!url) { showUploadError("PDF not available — re-upload."); return; }
    document.getElementById("pdf-frame").src = url;
    document.getElementById("pdf-preview-title").textContent = name||"PDF Preview";
    document.getElementById("pdf-preview").classList.add("show");
}
function closePdfPreview() {
    document.getElementById("pdf-preview").classList.remove("show");
    document.getElementById("pdf-frame").src = "";
}

async function loadChat(id) {
    const meta = chats.find(c=>c.id===id); if (!meta) return;
    _resetSugg("chat");
    document.getElementById("chat-box").innerHTML = "<div class='msg bot loading'><span></span><span></span><span></span></div>";
    try {
        const r = await _apiFetch("/chat/"+id);
        if (!r.ok) throw new Error();
        const chat = await r.json();
        currentChatId   = id; currentTitle = chat.title; currentChat = [...chat.messages];
        currentChatPDFs = (chat.pdfs||[]).map(p=>({name:p.name,content:p.content,url:null}));
        pendingPDFs=[]; currentTopic=chat.topic||null; updateTopicUI();
        const chatBox = document.getElementById("chat-box"); chatBox.innerHTML="";
        document.getElementById("selected-file").innerHTML=""; closePdfPreview();
        if (currentTopic) showTopicBanner();
        const btnText = document.getElementById("share-btn-text");
        if (btnText) btnText.textContent = chat.is_shared?"Unshare":"Share";
        chat.messages.forEach((msg,idx)=>{
            if (msg.pdfs&&msg.pdfs.length>0) msg.pdfs.forEach(pdf=>chatBox.appendChild(makePdfChip(pdf.name,null,false)));
            if (msg.role==="bot") renderBotMessage(msg,chatBox); else renderUserMessage(msg.content||"",idx,chatBox);
        });
        wrapTables(chatBox); scrollToBottom();
        _loadContinueChips();
    } catch(e) {
        document.getElementById("chat-box").innerHTML="<div class='msg bot error'>Failed to load chat.</div>";
    }
}

async function loadSharedChatView() {
    _resetSugg("chat");
    document.getElementById("chat-box").innerHTML="";
    document.getElementById("selected-file").innerHTML=""; closePdfPreview();
    try {
        const r = await _apiFetch("/api/shared/"+sharedToken);
        if (!r.ok) { document.getElementById("chat-box").innerHTML="<div class='msg bot error'>Failed to load shared chat.</div>"; return; }
        const data = await r.json();
        currentTitle=data.title||"Shared Chat"; currentTopic=data.topic||null; updateTopicUI();
        if (currentTopic) showTopicBanner();
        const chatBox=document.getElementById("chat-box"); currentChat=[...data.messages];
        data.messages.forEach((msg,idx)=>{
            if (msg.role==="bot") renderBotMessage(msg,chatBox); else renderUserMessage(msg.content||"",idx,chatBox);
        });
        wrapTables(chatBox); scrollToBottom();
        _loadContinueChips(); 
    } catch(e) { document.getElementById("chat-box").innerHTML="<div class='msg bot error'>Error loading chat.</div>"; }
}

function scrollToBottom() { const cb=document.getElementById("chat-box"); if(cb) cb.scrollTop=cb.scrollHeight; }

async function sendMessage() {
    const input = document.getElementById("user-input"); const msg = input.value.trim();
    if (!msg && pendingPDFs.length===0) return;
    if (micListening) stopMic();
    _hidePanel();
    const chatBox = document.getElementById("chat-box"); const messagePDFs = [];
    pendingPDFs.forEach(pdf=>{
        chatBox.appendChild(makePdfChip(pdf.name,pdf.url,false));
        messagePDFs.push({name:pdf.name,content:pdf.content,url:pdf.url});
        currentChatPDFs.push({name:pdf.name,content:pdf.content,url:pdf.url});
    });
    const userMsgIndex=currentChat.length;
    if (msg) renderUserMessage(msg,userMsgIndex,chatBox);
    currentChat.push({role:"user",content:msg||"[PDF uploaded]",pdfs:messagePDFs.map(p=>({name:p.name}))});
    input.value=""; input.style.height="auto";
    pendingPDFs=[]; document.getElementById("selected-file").innerHTML="";
    scrollToBottom();
    _S.mode = "chat"; 

    const ld = document.createElement("div"); ld.className="msg bot loading"; ld.innerHTML="<span></span><span></span><span></span>";
    chatBox.appendChild(ld); scrollToBottom();
    try {
        const pdfContent=currentChatPDFs.map(p=>p.content).join("\n\n---\n\n");
        const history=currentChat.slice(0,-1).filter(m=>!m.vizType&&m.content).slice(-10).map(m=>({role:m.role,content:m.content}));
        const endpoint=isSharedView?"/shared/chat/"+sharedToken:"/chat";
        const res=await _apiFetch(endpoint,{method:"POST",headers:{"Content-Type":"application/json"},
            body:JSON.stringify({message:msg||"Summarize the uploaded PDF",pdf_text:pdfContent,
                use_pdf:currentChatPDFs.length>0,conversation_history:history,
                topic_lock: currentTopic || null  
            })});
        if (!res.ok) { const err=await res.json().catch(()=>({})); throw new Error(err.detail||`Server error ${res.status}`); }
        const data=await res.json(); ld.remove();
        const replyHtml=data.reply||"<p>Sorry, no response received.</p>";
        const botMsg={role:"bot",content:replyHtml,msgId:_uid()};
        const wrapper=document.createElement("div"); wrapper.className="msg bot"; wrapper.id=botMsg.msgId;
        chatBox.appendChild(wrapper);
        typewriterAnimate(wrapper,replyHtml,()=>{
            currentChat.push(botMsg); wrapTables(wrapper); scrollToBottom();
          
            _msgHistory[botMsg.msgId] = { versions: [replyHtml], current: 0 };
            _appendMsgToolbar(wrapper, botMsg.msgId);
            if (isSharedView) return;
            let tp=Promise.resolve(currentTitle);
            if (!currentTitle) {
                tp=_apiFetch("/generate_title",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({message:msg||"PDF Analysis"})})
                    .then(r=>r.json()).then(td=>{currentTitle=td.title||"New Chat";return currentTitle;})
                    .catch(()=>{currentTitle="New Chat";return "New Chat";});
            }
            tp.then(()=>{ saveCurrentChat(); });
            
            _S.ccList  = [];
            _S.chatCtx = "";
            _loadContinueChips();
        });
    } catch(err) {
        ld.remove();
        const ed=document.createElement("div"); ed.className="msg bot error";
        const emsg = err.message || "Unknown error";
        ed.textContent = emsg.includes("Cannot reach server")
            ? "⚠ Server is starting up, please wait a moment and try again."
            : "Error: " + emsg;
        chatBox.appendChild(ed); scrollToBottom();
    }
}

function toggleTheme() {
    document.body.classList.toggle("light-mode");
    document.getElementById("theme-btn").textContent=document.body.classList.contains("light-mode")?"☀️":"🌙";
    localStorage.setItem("theme",document.body.classList.contains("light-mode")?"light":"dark");
}

window.onload = initAuth;

function wrapTables(container) {
    if (!container) return;
    container.querySelectorAll("table").forEach(table => {
        if (table.closest(".table-container")) return;
        const containerDiv=document.createElement("div"); containerDiv.className="table-container";
        const headerDiv=document.createElement("div"); headerDiv.className="table-header";
        const exportBtn=document.createElement("button"); exportBtn.className="export-btn";
        exportBtn.innerHTML=`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;margin-right:4px;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Export`;
        const dropdownDiv=document.createElement("div"); dropdownDiv.className="export-dropdown";
        [
            {type:"csv",  label:"CSV",   svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>'},
            {type:"excel",label:"Excel", svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="18" rx="2"/><line x1="8" y1="3" x2="8" y2="21"/><line x1="2" y1="9" x2="22" y2="9"/><line x1="2" y1="15" x2="22" y2="15"/></svg>'},
            {type:"json", label:"JSON",  svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1"/><path d="M16 3h1a2 2 0 0 1 2 2v5a2 2 0 0 0 2 2 2 2 0 0 0-2 2v5a2 2 0 0 1-2 2h-1"/></svg>'}
        ].forEach(item => {
            const el=document.createElement("div"); el.className="export-item"; el.dataset.type=item.type;
            el.innerHTML=`<span class="export-item-icon">${item.svg}</span><span class="export-item-label">${item.label}</span>`;
            el.addEventListener("click",e=>{e.stopPropagation();exportTable(table,item.type);dropdownDiv.classList.remove("show");});
            dropdownDiv.appendChild(el);
        });
        exportBtn.addEventListener("click",e=>{
            e.stopPropagation();
            document.querySelectorAll(".export-dropdown").forEach(d=>{if(d!==dropdownDiv)d.classList.remove("show");});
            dropdownDiv.classList.toggle("show");
        });
        headerDiv.appendChild(exportBtn); headerDiv.appendChild(dropdownDiv);
        const tableWrapper=document.createElement("div"); tableWrapper.className="table-wrapper";
        table.parentNode.insertBefore(containerDiv,table);
        tableWrapper.appendChild(table); containerDiv.appendChild(headerDiv); containerDiv.appendChild(tableWrapper);
    });
}
function exportTable(table, format) {
    const rows=Array.from(table.querySelectorAll("tr")).map(row=>Array.from(row.querySelectorAll("th,td")).map(cell=>cell.innerText.trim()));
    if (!rows.length) return;
    const ts=new Date().toISOString().replace(/[:.]/g,"-").slice(0,19);
    let content="",mimeType="",ext="";
    if (format==="csv") {
        content="\uFEFF"+rows.map(r=>r.map(c=>`"${c.replace(/"/g,'""')}"`).join(",")).join("\r\n");
        mimeType="text/csv;charset=utf-8;"; ext="csv";
    } else if (format==="json") {
        if (rows.length<2) { showUploadError("Not enough data to export as JSON."); return; }
        const headers=rows[0];
        content=JSON.stringify(rows.slice(1).map(r=>{const o={};headers.forEach((h,i)=>{o[h]=r[i]||"";});return o;}),null,2);
        mimeType="application/json;charset=utf-8;"; ext="json";
    } else if (format==="excel") {
        content="\uFEFF"+rows.map(r=>r.map(c=>c.replace(/\t/g," ").replace(/\r?\n/g," ")).join("\t")).join("\r\n");
        mimeType="application/vnd.ms-excel;charset=utf-8;"; ext="xls";
    }
    const blob=new Blob([content],{type:mimeType}); const url=URL.createObjectURL(blob);
    const a=document.createElement("a"); a.href=url; a.download=`table_export_${ts}.${ext}`; a.style.display="none";
    document.body.appendChild(a); a.click(); setTimeout(()=>{document.body.removeChild(a);URL.revokeObjectURL(url);},200);
}

const scrollBtn=document.getElementById("scrollBottomBtn"), chatBoxElement=document.getElementById("chat-box");
if (chatBoxElement && scrollBtn) {
    chatBoxElement.addEventListener("scroll",()=>{
        scrollBtn.classList.toggle("show",
            chatBoxElement.scrollHeight - chatBoxElement.scrollTop - chatBoxElement.clientHeight > 100);
    });
}
function scrollToBottomSmooth() {
    if (chatBoxElement) chatBoxElement.scrollTo({top:chatBoxElement.scrollHeight,behavior:"smooth"});
}