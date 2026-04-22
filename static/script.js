
const AUTH0_DOMAIN    = "dev-c3urwbeyfq7ld873.us.auth0.com";
const AUTH0_CLIENT_ID = "nvQtTELKBfNnZRiVavXhrhU50lCnizrT";
const AUTH0_REDIRECT  = window.location.origin;
let auth0Client = null;

let isSharedView = false;
let sharedToken = null;

async function initAuth() {
    const urlParams = new URLSearchParams(window.location.search);
    sharedToken = urlParams.get("token");
    if (sharedToken && window.location.pathname.startsWith("/view")) {
        isSharedView = true;
        showApp();
        return;
    }

    auth0Client = await auth0.createAuth0Client({
        domain:   AUTH0_DOMAIN,
        clientId: AUTH0_CLIENT_ID,
        authorizationParams: { redirect_uri: AUTH0_REDIRECT },
        cacheLocation:    "localstorage",
        useRefreshTokens: true
    });
    if (window.location.search.includes("code=") &&
        window.location.search.includes("state=")) {
        try { await auth0Client.handleRedirectCallback(); } catch(e) {}
        window.history.replaceState({}, document.title, window.location.pathname);
    }
    const ok = await auth0Client.isAuthenticated();
    if (ok) showApp(); else showLoginScreen();
}

function showLoginScreen() {
    document.getElementById("auth-overlay").style.display = "flex";
    document.getElementById("main-app").style.display    = "none";
}
function showApp() {
    document.getElementById("auth-overlay").style.display = "none";
    document.getElementById("main-app").style.display    = "flex";
    initApp();
}

document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("login-btn").addEventListener("click", async () => {
        await auth0Client.loginWithRedirect({
            authorizationParams: { redirect_uri: AUTH0_REDIRECT }
        });
    });
    document.getElementById("logout-btn").addEventListener("click", async () => {
        clearPDFStore();
        await auth0Client.logout({ logoutParams: { returnTo: AUTH0_REDIRECT } });
    });
});



const PDF_STORE_KEY = "pdfBinStore";

function savePDFToStore(name, b64) {
    try {
        let store = getPDFStore().filter(p => p.name !== name);
        store.push({ name, b64 });
        if (store.length > 10) store = store.slice(-10);
        localStorage.setItem(PDF_STORE_KEY, JSON.stringify(store));
    } catch(e) { console.warn("PDF store:", e); }
}
function getPDFStore() {
    try { return JSON.parse(localStorage.getItem(PDF_STORE_KEY) || "[]"); }
    catch { return []; }
}
function getBlobUrl(name) {
    try {
        const e = getPDFStore().find(p => p.name === name);
        if (!e) return null;
        const b = atob(e.b64), a = new Uint8Array(b.length);
        for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i);
        return URL.createObjectURL(new Blob([a], { type: "application/pdf" }));
    } catch { return null; }
}
function clearPDFStore() { localStorage.removeItem(PDF_STORE_KEY); }
function resolveUrl(name, live) { return live || getBlobUrl(name); }


const CHART_COLORS = [
    "#19c37d","#3b82f6","#f59e0b","#ef4444","#8b5cf6",
    "#06b6d4","#f97316","#84cc16","#ec4899","#14b8a6",
    "#a78bfa","#fb923c"
];
const CHART_NAMES = {
    bar:"Bar Chart", line:"Line Chart", pie:"Pie Chart",
    doughnut:"Doughnut Chart", radar:"Radar Chart"
};
const chartRegistry = {};



let chats           = [];
let currentChat     = [];
let currentTitle    = null;
let currentChatPDFs = [];
let pendingPDFs     = [];
let pinnedChats     = JSON.parse(localStorage.getItem("pinnedChats") || "[]");
let currentTopic    = null;  // topic lock



function initApp() {
    if (isSharedView) {
        document.querySelector('.sidebar').style.display = 'none';
        const tb = document.getElementById('topic-lock-btn');
        if (tb) tb.style.display = 'none';
        const sb = document.getElementById('share-btn');
        if (sb) sb.style.display = 'none';
        const pw = document.querySelector('.pinned-wrapper');
        if (pw) pw.style.display = 'none';
        loadSharedChatView();
    } else {
        loadHistory();
    }
    if (localStorage.getItem("theme") === "light") {
        document.body.classList.add("light-mode");
        document.getElementById("theme-btn").textContent = "☀️";
    }
    document.getElementById("user-input").addEventListener("keydown", e => {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
    initMic();
}
function cleanText(t) { return t.replace(/<[^>]*>/g, ""); }
function safeId(t)    { return btoa(encodeURIComponent(t)).replace(/[^a-zA-Z0-9]/g, ""); }
function autoResize(el) {
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 150) + "px";
}



function typewriterAnimate(container, html, onDone) {
    
    const tokens = [];
    const temp   = document.createElement("div");
    temp.innerHTML = html;

    function walk(node) {
        if (node.nodeType === Node.TEXT_NODE) {
            for (const ch of node.textContent) {
                tokens.push({ type: "char", value: ch });
            }
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            const tag  = node.tagName.toLowerCase();
            const void_tags = ["br","hr","img","input","canvas"];
            if (void_tags.includes(tag)) {
                tokens.push({ type: "void", html: node.outerHTML });
            } else {
                
                const clone = node.cloneNode(false);
                tokens.push({ type: "open", html: clone.outerHTML.replace(/><\/[^>]+>$/, ">") });
                node.childNodes.forEach(walk);
                tokens.push({ type: "close", tag });
            }
        }
    }
    temp.childNodes.forEach(walk);

    
    container.innerHTML = "";
    const cursor = document.createElement("span");
    cursor.className = "typing-cursor";
    container.appendChild(cursor);

    
    const stack   = [container];
    let   idx     = 0;
    const delay   = 8;  

    const interval = setInterval(() => {
        
        const batchSize = 3;
        for (let b = 0; b < batchSize && idx < tokens.length; b++, idx++) {
            const tok = tokens[idx];
            const current = stack[stack.length - 1];

            if (tok.type === "char") {
                
                const last = current.lastChild;
                if (last && last.nodeType === Node.TEXT_NODE && last !== cursor) {
                    last.textContent += tok.value;
                } else {
                    current.insertBefore(document.createTextNode(tok.value), cursor);
                }
            } else if (tok.type === "open") {
                const wrapper = document.createElement("div");
                wrapper.innerHTML = tok.html + " </div>";
                const el = wrapper.firstChild;
                
                while (el.lastChild) el.removeChild(el.lastChild);
                current.insertBefore(el, cursor);
                stack.push(el);
                
                el.appendChild(cursor);
            } else if (tok.type === "close") {
                if (stack.length > 1) {
                    stack.pop();
                    stack[stack.length - 1].appendChild(cursor);
                }
            } else if (tok.type === "void") {
                const wrapper = document.createElement("div");
                wrapper.innerHTML = tok.html;
                current.insertBefore(wrapper.firstChild, cursor);
            }
        }

        if (idx >= tokens.length) {
            clearInterval(interval);
            cursor.remove();
            if (onDone) onDone();
        }

        scrollToBottom();
    }, delay);
}


let recognition  = null;
let micListening = false;
let micFinalText = "";

let audioCtx     = null;
let analyser     = null;
let audioSource  = null;
let audioStream  = null;
let waveRAF      = null;

function initMic() {
    const SR  = window.SpeechRecognition || window.webkitSpeechRecognition;
    const btn = document.getElementById("mic-btn");
    if (!SR) { if (btn) btn.style.display = "none"; return; }

    recognition = new SR();
    recognition.continuous      = true;
    recognition.interimResults  = true;
    recognition.maxAlternatives = 1;
    recognition.lang            = "en-US";

    recognition.onresult = function(event) {
        let interim = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
            const t = event.results[i][0].transcript;
            if (event.results[i].isFinal) micFinalText += t + " ";
            else                           interim     += t;
        }
        const ta = document.getElementById("user-input");
        ta.value = (micFinalText + interim).trim();
        autoResize(ta);
    };

    recognition.onerror = function(ev) {
        if (ev.error === "no-speech" || ev.error === "aborted") return;
        if (ev.error === "not-allowed") {
            showUploadError("Microphone permission denied. Allow mic in browser settings.");
            stopMic(); return;
        }
        console.warn("Speech error:", ev.error);
    };

    recognition.onend = function() {
        if (micListening) {
            try { recognition.start(); } catch(e) {}
        }
    };
}

function toggleMic() {
    if (!recognition) {
        showUploadError("Speech recognition not supported. Use Chrome or Edge.");
        return;
    }
    if (micListening) stopMic(); else startMic();
}

async function startMic() {
    const ta = document.getElementById("user-input");
    micFinalText = ta.value;
    if (micFinalText && !micFinalText.endsWith(" ")) micFinalText += " ";
    micListening = true;
    document.getElementById("mic-btn").classList.add("listening");
    ta.classList.add("mic-listening");
    try { recognition.start(); } catch(e) {}
    await startWave();
}

function stopMic() {
    micListening = false;
    document.getElementById("mic-btn").classList.remove("listening");
    const ta = document.getElementById("user-input");
    ta.classList.remove("mic-listening");
    try { recognition.stop(); } catch(e) {}
    ta.value = ta.value.trim();
    autoResize(ta);
    ta.focus();
    stopWave();
}

async function startWave() {
    try {
        audioStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        audioCtx    = new (window.AudioContext || window.webkitAudioContext)();
        analyser    = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.8;
        audioSource = audioCtx.createMediaStreamSource(audioStream);
        audioSource.connect(analyser);
        const canvas = document.getElementById("voice-wave-canvas");
        canvas.classList.add("active");
        drawWave(canvas);
    } catch(err) {
        console.warn("Wave visualizer unavailable:", err.message);
    }
}

function drawWave(canvas) {
    if (!analyser || !micListening) return;
    const ctx = canvas.getContext("2d");
    const W   = canvas.offsetWidth, H = canvas.offsetHeight;
    if (canvas.width !== W)  canvas.width  = W;
    if (canvas.height !== H) canvas.height = H;
    const bufLen = analyser.frequencyBinCount;
    const data   = new Uint8Array(bufLen);
    analyser.getByteFrequencyData(data);
    ctx.clearRect(0, 0, W, H);
    const isDark = !document.body.classList.contains("light-mode");
    ctx.fillStyle = isDark ? "rgba(40,42,54,0.45)" : "rgba(230,235,240,0.25)";
    ctx.fillRect(0, 0, W, H);
    const useBins = Math.floor(bufLen * 0.55);
    const barCount = 48, gap = 2;
    const barW  = Math.max(2, (W - gap * (barCount + 1)) / barCount);
    const green = isDark ? "#19c37d" : "#17b870";
    for (let i = 0; i < barCount; i++) {
        const binIdx = Math.floor((i / barCount) * useBins);
        const norm   = Math.pow(data[binIdx] / 255, 0.6);
        const bH     = Math.max(3, norm * H * 0.80);
        const x      = gap + i * (barW + gap);
        const y      = H - bH;
        const grad   = ctx.createLinearGradient(x, y, x, H);
        grad.addColorStop(0,   green);
        grad.addColorStop(0.5, green + "bb");
        grad.addColorStop(1,   green + "44");
        ctx.fillStyle = grad;
        ctx.beginPath();
        const r = Math.min(barW / 2, 3);
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + barW - r, y);
        ctx.quadraticCurveTo(x + barW, y, x + barW, y + r);
        ctx.lineTo(x + barW, H);
        ctx.lineTo(x, H);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
        ctx.fill();
    }
    waveRAF = requestAnimationFrame(() => drawWave(canvas));
}

function stopWave() {
    if (waveRAF) { cancelAnimationFrame(waveRAF); waveRAF = null; }
    const canvas = document.getElementById("voice-wave-canvas");
    canvas.classList.remove("active");
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    try { if (audioSource) audioSource.disconnect(); } catch(e) {}
    try { if (audioCtx)    audioCtx.close();         } catch(e) {}
    try { if (audioStream) audioStream.getTracks().forEach(t => t.stop()); } catch(e) {}
    audioCtx = analyser = audioSource = audioStream = null;
}


function toggleVizDropdown(e) {
    e.stopPropagation();
    const menu = document.getElementById("viz-dropdown-menu");
    const btn  = document.getElementById("viz-dropdown-btn");
    const open = menu.classList.contains("show");
    closeAllDropdowns();
    if (!open) { menu.classList.add("show"); btn.classList.add("open"); }
}
function toggleChartTypes(e) {
    e.stopPropagation();
    document.getElementById("chart-types-panel").classList.toggle("show");
}
function closeAllDropdowns() {
    document.querySelectorAll(".nav-dropdown-menu").forEach(m => m.classList.remove("show"));
    document.querySelectorAll(".nav-dropdown-btn").forEach(b => b.classList.remove("open"));
    document.getElementById("chart-types-panel").classList.remove("show");
    document.querySelectorAll(".menu").forEach(m => m.classList.remove("show"));
    document.getElementById("pinned-box").classList.remove("show");
    document.getElementById("file-menu").classList.remove("show");
}
document.addEventListener("click", e => {
    if (!e.target.closest(".nav-dropdown-wrapper") &&
        !e.target.closest(".menu") && !e.target.closest(".dots") &&
        !e.target.closest(".pinned-wrapper") && !e.target.closest(".file-wrapper")) {
        closeAllDropdowns();
    }
});


function openTopicModal() {
    const modal = document.getElementById("topic-modal-overlay");
    modal.classList.add("show");
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
    updateTopicUI();
    saveCurrentChat();
    showTopicBanner();
}
function clearTopic() {
    currentTopic = null;
    document.getElementById("topic-input").value = "";
    updateTopicActiveRow();
    document.getElementById("topic-modal-overlay").classList.remove("show");
    updateTopicUI();
    removeTopicBanner();
    saveCurrentChat();
}
function updateTopicUI() {
    const btn   = document.getElementById("topic-lock-btn");
    const label = document.getElementById("topic-lock-label");
    if (currentTopic) {
        btn.classList.add("locked");
        label.textContent = currentTopic.length > 12
            ? currentTopic.slice(0, 12) + "…"
            : currentTopic;
    } else {
        btn.classList.remove("locked");
        label.textContent = "Topic";
    }
    updateTopicActiveRow();
}
function updateTopicActiveRow() {
    const row  = document.getElementById("topic-active-row");
    const name = document.getElementById("topic-active-name");
    if (currentTopic) {
        row.style.display = "flex";
        name.textContent  = currentTopic;
    } else {
        row.style.display = "none";
        name.textContent  = "";
    }
}
function showTopicBanner() {
    removeTopicBanner();
    const cb     = document.getElementById("chat-box");
    const banner = document.createElement("div");
    banner.className = "topic-banner";
    banner.id        = "topic-banner";
    banner.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
        </svg>
        <span>Topic locked to: <strong>${currentTopic}</strong> — responses are limited to this topic only.</span>`;
    cb.insertBefore(banner, cb.firstChild);
}
function removeTopicBanner() {
    const old = document.getElementById("topic-banner");
    if (old) old.remove();
}


function openShareModal() {
    if (!currentTitle) {
        showUploadError("Start a chat first before sharing.");
        return;
    }
    const overlay = document.getElementById("share-modal-overlay");
    overlay.classList.add("show");
    const input = document.getElementById("share-link-input");
    const btn   = document.getElementById("share-copy-btn");
    input.value = "Generating link...";
    btn.disabled = true;

    fetch("/share_chat", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ title: currentTitle })
    })
    .then(r => r.json())
    .then(data => {
        const link = `${window.location.origin}/view?token=${data.token}`;
        input.value  = link;
        btn.disabled = false;
    })
    .catch(() => {
        input.value  = "Failed to generate link. Try again.";
        btn.disabled = false;
    });
}
function closeShareModal(e) {
    if (e && e.target !== document.getElementById("share-modal-overlay")) return;
    document.getElementById("share-modal-overlay").classList.remove("show");
    document.getElementById("share-copy-toast").classList.remove("show");
}
function copyShareLink() {
    const input = document.getElementById("share-link-input");
    if (!input.value || input.value.startsWith("Generating") || input.value.startsWith("Failed")) return;
    navigator.clipboard.writeText(input.value).then(() => {
        const toast = document.getElementById("share-copy-toast");
        toast.classList.add("show");
        setTimeout(() => toast.classList.remove("show"), 2200);
    }).catch(() => {
        
        input.select();
        document.execCommand("copy");
    });
}

function renderUserMessage(text, msgIndex, container) {
    const wrapper = document.createElement("div");
    wrapper.className = "msg-user-wrap";
    wrapper.dataset.index = msgIndex;

    const bubble = document.createElement("div");
    bubble.className = "msg user";
    bubble.textContent = text;

    const editBtn = document.createElement("button");
    editBtn.className   = "msg-edit-btn";
    editBtn.title       = "Edit message";
    editBtn.innerHTML   = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
    </svg>`;

    editBtn.addEventListener("click", () => startEditMessage(wrapper, text, msgIndex));

    wrapper.appendChild(bubble);
    wrapper.appendChild(editBtn);
    container.appendChild(wrapper);
    return wrapper;
}

function startEditMessage(wrapper, originalText, msgIndex) {
    wrapper.innerHTML = "";
    wrapper.classList.add("editing");

    const ta      = document.createElement("textarea");
    ta.className  = "msg-edit-textarea";
    ta.value      = originalText;
    ta.rows       = 1;

    function resizeEditTA() {
        ta.style.height = "auto";
        ta.style.height = Math.min(ta.scrollHeight, 120) + "px";
    }
    ta.addEventListener("input", resizeEditTA);

    setTimeout(() => {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
        resizeEditTA();
    }, 10);

    const actions     = document.createElement("div");
    actions.className = "msg-edit-actions";

    const saveBtn       = document.createElement("button");
    saveBtn.className   = "msg-edit-save";
    saveBtn.textContent = "Save & Send";
    saveBtn.addEventListener("click", () => saveEditMessage(wrapper, ta.value.trim(), msgIndex));

    const cancelBtn       = document.createElement("button");
    cancelBtn.className   = "msg-edit-cancel";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => cancelEditMessage(wrapper, originalText, msgIndex));

    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);
    wrapper.appendChild(ta);
    wrapper.appendChild(actions);

    ta.addEventListener("keydown", e => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            saveEditMessage(wrapper, ta.value.trim(), msgIndex);
        }
        if (e.key === "Escape") cancelEditMessage(wrapper, originalText, msgIndex);
    });
}

function cancelEditMessage(wrapper, originalText, msgIndex) {
    wrapper.classList.remove("editing");
    wrapper.innerHTML = "";
    const bubble = document.createElement("div");
    bubble.className = "msg user";
    bubble.textContent = originalText;
    const editBtn = document.createElement("button");
    editBtn.className = "msg-edit-btn";
    editBtn.title     = "Edit message";
    editBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
    </svg>`;
    editBtn.addEventListener("click", () => startEditMessage(wrapper, originalText, msgIndex));
    wrapper.appendChild(bubble);
    wrapper.appendChild(editBtn);
}

async function saveEditMessage(wrapper, newText, msgIndex) {
    if (!newText) return;

    
    currentChat[msgIndex].content = newText;

    
    const chatBox  = document.getElementById("chat-box");
    const allItems = [...chatBox.querySelectorAll(".msg-user-wrap, .msg.bot, .msg-bot-wrap")];

    
    let foundEdit = false;
    for (const el of allItems) {
        if (el === wrapper) { foundEdit = true; continue; }
        if (foundEdit) el.remove();
    }

    
    currentChat.splice(msgIndex + 1);

    
    wrapper.classList.remove("editing");
    wrapper.innerHTML = "";
    const bubble = document.createElement("div");
    bubble.className = "msg user";
    bubble.textContent = newText;
    const editBtn = document.createElement("button");
    editBtn.className = "msg-edit-btn";
    editBtn.title     = "Edit message";
    editBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
    </svg>`;
    editBtn.addEventListener("click", () => startEditMessage(wrapper, newText, msgIndex));
    wrapper.appendChild(bubble);
    wrapper.appendChild(editBtn);

    
    await sendEditedMessage(newText);
}

async function sendEditedMessage(msg) {
    const chatBox = document.getElementById("chat-box");

    const ld = document.createElement("div");
    ld.className = "msg bot loading";
    ld.innerHTML = "<span></span><span></span><span></span>";
    chatBox.appendChild(ld);
    scrollToBottom();

    try {
        const pdfContent = currentChatPDFs.map(p => p.content).join("\n\n---\n\n");
        const history    = currentChat
            .filter(m => !m.vizType && m.content)
            .slice(-10)
            .map(m => ({ role: m.role, content: m.content }));

        const res = await fetch("/chat", {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({
                message:              msg,
                pdf_text:             pdfContent,
                use_pdf:              currentChatPDFs.length > 0,
                conversation_history: history,
                topic_lock:           currentTopic || null
            })
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || `Server error ${res.status}`);
        }

        const data      = await res.json();
        ld.remove();

        const replyHtml = data.reply || "<p>Sorry, no response received.</p>";
        const botMsg    = { role: "bot", content: replyHtml };

        
        const botMsgObj = { ...botMsg };
        if (!botMsgObj.msgId)
            botMsgObj.msgId = "bot-" + Date.now() + "-" + Math.floor(Math.random() * 9999);

        const wrapper = document.createElement("div");
        wrapper.className = "msg bot";
        wrapper.id        = botMsgObj.msgId;
        chatBox.appendChild(wrapper);

        typewriterAnimate(wrapper, replyHtml, () => {
            currentChat.push(botMsg);
            scrollToBottom();
            saveCurrentChat();
        });

    } catch(err) {
        ld.remove();
        const ed = document.createElement("div");
        ed.className   = "msg bot error";
        ed.textContent = "Error: " + err.message;
        chatBox.appendChild(ed);
        scrollToBottom();
    }
}


async function requestVisualization(viewType, chartType) {
    closeAllDropdowns();
    const botMsgs = currentChat.filter(m => m.role === "bot" && !m.vizType);
    if (!botMsgs.length) {
        showUploadError("Ask a question first, then click Visualize.");
        return;
    }
    const lastBot = botMsgs[botMsgs.length - 1];
    const msgEl   = document.getElementById(lastBot.msgId);
    if (!msgEl) return;

    let vizSection = msgEl.querySelector(".msg-viz-section");
    if (!vizSection) {
        vizSection = document.createElement("div");
        vizSection.className = "msg-viz-section";
        msgEl.appendChild(vizSection);
    }
    vizSection.innerHTML = `
        <div class="viz-loading">
            <div class="viz-spinner"></div>
            ${viewType === "table" ? "Extracting table..." : "Extracting data..."}
        </div>`;
    scrollToBottom();

    try {
        const chatText = currentChat
            .filter(m => m.role === "bot" && !m.vizType)
            .map(m => { const d = document.createElement("div"); d.innerHTML = m.content || ""; return d.textContent; })
            .join("\n\n");
        const htmlContent = viewType === "table" ? (lastBot.content || "") : "";

        const extractRes = await fetch("/extract_viz", {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ viz_type: viewType, html_content: htmlContent, chat_text: chatText })
        });
        if (!extractRes.ok) throw new Error(`Extract failed ${extractRes.status}`);
        const extracted = await extractRes.json();

        lastBot.selected_view  = viewType;
        lastBot.chart_type     = chartType;
        lastBot.extracted_data = extracted;

        renderVizSection(vizSection, viewType, chartType, extracted);
        scrollToBottom();

        const expRes = await fetch("/explain_viz", {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({
                viz_type: viewType, chart_type: chartType || "bar",
                labels:   extracted.labels  || [], values:  extracted.values  || [],
                xLabel:   extracted.xLabel  || "Category", yLabel: extracted.yLabel || "Value",
                headers:  extracted.headers || [], rows:   extracted.rows    || []
            })
        });
        if (expRes.ok) {
            const expData = await expRes.json();
            if (expData.explanation) {
                const expDiv = document.createElement("div");
                expDiv.className = "viz-explanation";
                expDiv.innerHTML = expData.explanation;
                vizSection.appendChild(expDiv);
                lastBot.viz_explanation = expData.explanation;
            }
        }
        saveCurrentChat();
        scrollToBottom();
    } catch(err) {
        vizSection.innerHTML = `<div class="viz-nodata">⚠ Could not extract data: ${err.message}</div>`;
    }
}

function renderVizSection(container, viewType, chartType, data) {
    const oldCanvas = container.querySelector("canvas");
    if (oldCanvas && chartRegistry[oldCanvas.id]) {
        chartRegistry[oldCanvas.id].destroy();
        delete chartRegistry[oldCanvas.id];
    }
    const expDiv = container.querySelector(".viz-explanation");
    container.innerHTML = "";
    if (expDiv) container.appendChild(expDiv);

    if (viewType === "table") {
        if (!data || !data.headers || !data.rows || !data.rows.length) {
            container.innerHTML = `<div class="viz-nodata">ℹ No table data found.</div>`; return;
        }
        renderTable(container, data);
    } else {
        if (!data || !data.labels || data.labels.length < 2) {
            container.innerHTML = `<div class="viz-nodata">ℹ Not enough numeric data to chart.</div>`; return;
        }
        renderChart(container, chartType || "bar", data);
    }
}

function renderTable(container, data) {
    const hdrs = data.headers.map(h => `<th>${h}</th>`).join("");
    const rows = data.rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join("")}</tr>`).join("");
    container.innerHTML = `
        <div class="viz-table-wrap">
            <div class="viz-table-title">📋 Table View</div>
            <table><thead><tr>${hdrs}</tr></thead><tbody>${rows}</tbody></table>
        </div>`;
}

function renderChart(container, chartType, data) {
    const typeName = CHART_NAMES[chartType] || "Chart";
    const canvasId = "viz-" + Date.now() + "-" + Math.floor(Math.random() * 9999);
    container.innerHTML = `
        <div class="viz-chart-wrap">
            <div class="viz-chart-title">📊 ${typeName}</div>
            <div class="viz-canvas-box"><canvas id="${canvasId}"></canvas></div>
        </div>`;

    requestAnimationFrame(() => {
        const canvas = document.getElementById(canvasId);
        if (!canvas) return;
        const style     = getComputedStyle(document.documentElement);
        const textColor = style.getPropertyValue("--chart-text").trim() || "#e0e0e0";
        const gridColor = style.getPropertyValue("--chart-grid").trim() || "rgba(255,255,255,0.1)";
        const isCirc    = ["pie","doughnut"].includes(chartType);
        const isRadar   = chartType === "radar";
        const numValues = data.values.map(v => { const n = parseFloat(String(v).replace(/[^0-9.\-]/g,"")); return isNaN(n)?0:n; });
        const count     = numValues.length;
        const bgColors  = Array.from({length:count},(_,i) => CHART_COLORS[i%CHART_COLORS.length]+"cc");
        const bdrColors = Array.from({length:count},(_,i) => CHART_COLORS[i%CHART_COLORS.length]);
        let datasets;
        if (isCirc||isRadar) {
            datasets=[{label:data.yLabel||"Value",data:numValues,backgroundColor:bgColors,borderColor:bdrColors,borderWidth:2}];
        } else if (chartType==="line") {
            datasets=[{label:data.yLabel||"Value",data:numValues,backgroundColor:bgColors[0],borderColor:bdrColors[0],borderWidth:2,fill:true,tension:0.4,pointRadius:6,pointHoverRadius:9,pointBackgroundColor:bdrColors}];
        } else {
            datasets=[{label:data.yLabel||"Value",data:numValues,backgroundColor:bgColors,borderColor:bdrColors,borderWidth:2,borderRadius:4}];
        }
        const font={family:"'Calibri',sans-serif"};
        const scalesConfig=isCirc?{}:isRadar?{r:{ticks:{color:textColor,backdropColor:"transparent",font:{size:11,...font}},grid:{color:gridColor},pointLabels:{color:textColor,font:{size:12,...font}}}}:{x:{title:{display:true,text:data.xLabel||"Category",color:textColor,font:{size:13,weight:"bold",...font}},ticks:{color:textColor,font,maxRotation:40},grid:{color:gridColor}},y:{title:{display:true,text:data.yLabel||"Value",color:textColor,font:{size:13,weight:"bold",...font}},ticks:{color:textColor,font},grid:{color:gridColor},beginAtZero:true}};
        chartRegistry[canvasId]=new Chart(canvas,{type:chartType,data:{labels:data.labels,datasets},options:{responsive:true,maintainAspectRatio:false,animation:{duration:500},plugins:{legend:{display:true,labels:{color:textColor,font:{size:13,...font},padding:16,usePointStyle:true}},tooltip:{bodyFont:{size:13,...font},titleFont:{size:13,...font}}},scales:scalesConfig}});
    });
}


function saveCurrentChat() {
    if (!currentTitle) return;
    fetch("/save_chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            title:    currentTitle,
            messages: currentChat,
            pdfs:     currentChatPDFs.map(p => ({ name: p.name, content: p.content })),
            topic:    currentTopic || null
        })
    }).then(() => loadHistory()).catch(e => console.warn("Save:", e));
}

function renderBotMessage(msg, container) {
    if (!msg.msgId)
        msg.msgId = "bot-" + Date.now() + "-" + Math.floor(Math.random() * 9999);

    const wrapper    = document.createElement("div");
    wrapper.className = "msg bot";
    wrapper.id        = msg.msgId;
    wrapper.innerHTML = msg.content || "";
    container.appendChild(wrapper);

    if (msg.selected_view && msg.extracted_data) {
        const vs = document.createElement("div");
        vs.className = "msg-viz-section";
        wrapper.appendChild(vs);
        renderVizSection(vs, msg.selected_view, msg.chart_type || "bar", msg.extracted_data);
        if (msg.viz_explanation) {
            const ed = document.createElement("div");
            ed.className = "viz-explanation";
            ed.innerHTML = msg.viz_explanation;
            vs.appendChild(ed);
        }
    }
}


function newChat() {
    currentTitle = null; currentChat = []; currentChatPDFs = []; pendingPDFs = [];
    currentTopic = null;
    document.getElementById("chat-box").innerHTML      = "";
    document.getElementById("selected-file").innerHTML = "";
    closePdfPreview();
    if (micListening) stopMic();
    updateTopicUI();
}
function searchChats() {
    const q = document.getElementById("search-box").value.toLowerCase();
    renderHistory(chats.filter(c => c.title.toLowerCase().includes(q)));
}

async function loadHistory() {
    try { const r = await fetch("/chats"); chats = await r.json() || []; }
    catch { chats = []; }
    pinnedChats = pinnedChats.filter(p => chats.some(c => c.title === p.title));
    localStorage.setItem("pinnedChats", JSON.stringify(pinnedChats));
    updateHistory();
    
    try {
        const sr = await fetch("/shared_list");
        const sharedData = await sr.json() || [];
        renderSharedHistory(sharedData);
    } catch {}
}
function renderSharedHistory(list) {
    const sh = document.getElementById("shared-history");
    if (!sh) return;
    sh.innerHTML = "";
    list.forEach(shared => {
        const li = document.createElement("li");
        li.className = "history-item";
        li.innerHTML = `
            <div class="title-container">
                <span class="chat-title" onclick="window.open('/view?token=${shared.token}', '_blank')">
                    <span class="shared-link-icon">🔗</span>${cleanText(shared.title)}
                </span>
            </div>`;
        sh.appendChild(li);
    });
}
function updateHistory() { renderHistory(chats); }
function renderHistory(list) {
    const h = document.getElementById("chat-history");
    h.innerHTML = "";
    const pinned   = list.filter(c =>  pinnedChats.find(p => p.title === c.title));
    const unpinned = list.filter(c => !pinnedChats.find(p => p.title === c.title));
    [...pinned, ...unpinned].forEach(chat => {
        const isPinned = pinnedChats.find(p => p.title === chat.title);
        const id = safeId(chat.title);
        const li = document.createElement("li");
        li.className = "history-item" + (isPinned ? " pinned" : "");
        li.innerHTML = `
            <div class="title-container" id="title-${id}">
                <span class="chat-title"
                      onclick="loadChat('${encodeURIComponent(chat.title)}')">
                    ${isPinned ? "📌 " : ""}${cleanText(chat.title)}
                </span>
            </div>
            <span class="dots" onclick="toggleMenu(event,'${id}')">⋮</span>
            <div class="menu" id="menu-${id}">
                <div onclick="startRename('${encodeURIComponent(chat.title)}','${id}')">Rename</div>
                <div onclick="deleteChat('${encodeURIComponent(chat.title)}')">Delete</div>
                <div onclick="togglePin('${encodeURIComponent(chat.title)}')">${isPinned?"Unpin":"Pin"}</div>
            </div>`;
        h.appendChild(li);
    });
}
function toggleMenu(e, id) {
    e.stopPropagation();
    document.querySelectorAll(".menu").forEach(m => m.classList.remove("show"));
    document.getElementById(`menu-${id}`).classList.toggle("show");
}
function togglePinned(e) {
    e.stopPropagation(); closeAllDropdowns();
    const box = document.getElementById("pinned-box");
    if (box.classList.contains("show")) { box.classList.remove("show"); return; }
    box.innerHTML = pinnedChats.length === 0
        ? "<div class='pinned-empty'>No pinned chats</div>"
        : pinnedChats.map(c =>
            `<div class="pinned-item"
                  onclick="loadChat('${encodeURIComponent(c.title)}');
                           document.getElementById('pinned-box').classList.remove('show')">
               📌 ${cleanText(c.title)}</div>`).join("");
    box.classList.add("show");
}
function togglePin(enc) {
    const title  = decodeURIComponent(enc);
    const chat   = chats.find(c => c.title === title);
    const exists = pinnedChats.find(c => c.title === title);
    if (exists) pinnedChats = pinnedChats.filter(c => c.title !== title);
    else if (chat) pinnedChats.unshift({ title: chat.title });
    localStorage.setItem("pinnedChats", JSON.stringify(pinnedChats));
    updateHistory();
}
async function deleteChat(enc) {
    const title = decodeURIComponent(enc);
    chats       = chats.filter(c => c.title !== title);
    pinnedChats = pinnedChats.filter(c => c.title !== title);
    localStorage.setItem("pinnedChats", JSON.stringify(pinnedChats));
    await fetch("/delete_chat", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({title}) });
    if (currentTitle === title) newChat();
    updateHistory();
}
function startRename(enc, id) {
    const title = decodeURIComponent(enc);
    document.getElementById(`title-${id}`).innerHTML = `
        <input class="rename-input" id="rename-${id}" value="${title}" onclick="event.stopPropagation()">
        <button class="rename-btn" onclick="event.stopPropagation();saveRename('${enc}','${id}')">✔</button>
        <button class="rename-cancel-btn" onclick="event.stopPropagation();cancelRename()">✕</button>`;
    const i = document.getElementById(`rename-${id}`); i.focus(); i.select();
}
function cancelRename() { updateHistory(); }
async function saveRename(encOld, id) {
    const oldTitle = decodeURIComponent(encOld);
    const newTitle = document.getElementById(`rename-${id}`).value.trim();
    if (!newTitle || newTitle === oldTitle) { updateHistory(); return; }
    if (chats.find(c => c.title === newTitle && c.title !== oldTitle)) { alert("Title exists!"); updateHistory(); return; }
    const ci = chats.findIndex(c => c.title === oldTitle);
    if (ci !== -1) chats[ci].title = newTitle;
    const pi = pinnedChats.findIndex(c => c.title === oldTitle);
    if (pi !== -1) { pinnedChats[pi].title = newTitle; localStorage.setItem("pinnedChats", JSON.stringify(pinnedChats)); }
    if (currentTitle === oldTitle) currentTitle = newTitle;
    await fetch("/update_chat", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({old_title:oldTitle, new_title:newTitle}) });
    updateHistory();
}


function toggleFileMenu(e) {
    e.stopPropagation();
    document.getElementById("file-menu").classList.toggle("show");
}
async function handlePDF(e) {
    const file = e.target.files[0]; if (!file) return;
    document.getElementById("file-menu").classList.remove("show");
    if (file.size > 10*1024*1024) { showUploadError("PDF too large (max 10MB)."); e.target.value=""; return; }
    const lid = Date.now(); addPendingPDFUI(file.name, lid, true, null);
    try {
        const fd = new FormData(); fd.append("file", file);
        const res = await fetch("/upload_pdf", { method:"POST", body:fd });
        let data = {}; try { data = await res.json(); } catch {}
        if (!res.ok) throw new Error(data.detail || `Server error ${res.status}`);
        if (!data.content) throw new Error("No text from PDF.");
        removePendingPDFUI(lid);
        const blobUrl = URL.createObjectURL(file);
        const reader  = new FileReader();
        reader.onload = ev => savePDFToStore(file.name, btoa(ev.target.result));
        reader.readAsBinaryString(file);
        const pd = { id:Date.now(), name:file.name, content:data.content, url:blobUrl };
        pendingPDFs.push(pd); addPendingPDFUI(pd.name, pd.id, false, blobUrl);
    } catch(err) { removePendingPDFUI(lid); showUploadError("Upload failed: " + err.message); }
    e.target.value = "";
}
function showUploadError(msg) {
    const w = document.getElementById("upload-error-wrap");
    w.innerHTML = `<div class="upload-error">⚠ ${msg}</div>`;
    clearTimeout(w._t); w._t = setTimeout(() => { w.innerHTML = ""; }, 5000);
}
function makePdfChip(name, url, isPending) {
    const div      = document.createElement("div");
    const resolved = resolveUrl(name, url);
    if (isPending) {
        div.className = "selected-pdf-item";
        div.innerHTML = `<span class="pdf-icon">📄</span><span class="pdf-name">${name}</span>`;
    } else {
        div.className = "msg-pdf" + (resolved ? "" : " no-preview");
        div.innerHTML = `<span class="pdf-icon">📄</span><span class="pdf-label">${name}</span>`;
        if (!resolved) div.title = "PDF not stored — re-upload";
    }
    if (resolved) {
        div.dataset.pdfUrl  = resolved;
        div.dataset.pdfName = name;
        div.addEventListener("click", ev => {
            if (!ev.target.classList.contains("pdf-remove"))
                previewPDF(div.dataset.pdfUrl, div.dataset.pdfName);
        });
    }
    return div;
}
function addPendingPDFUI(name, id, isLoading, url) {
    const c = document.getElementById("selected-file");
    if (isLoading) {
        const d = document.createElement("div");
        d.className = "selected-pdf-item"; d.id = `pending-pdf-${id}`;
        d.innerHTML = `<span class="pdf-icon">📄</span><span class="pdf-name">${name}</span><span class="pdf-loading">Uploading...</span>`;
        c.appendChild(d);
    } else {
        const d  = makePdfChip(name, url, true); d.id = `pending-pdf-${id}`;
        const rb = document.createElement("span");
        rb.className = "pdf-remove"; rb.textContent = "✕";
        rb.addEventListener("click", ev => { ev.stopPropagation(); removePendingPDF(id); });
        d.appendChild(rb); c.appendChild(d);
    }
}
function removePendingPDFUI(id) { const el = document.getElementById(`pending-pdf-${id}`); if (el) el.remove(); }
function removePendingPDF(id)   { pendingPDFs = pendingPDFs.filter(p => p.id !== id); removePendingPDFUI(id); }


function previewPDF(url, name) {
    if (!url) { showUploadError("PDF not available — re-upload."); return; }
    document.getElementById("pdf-frame").src                 = url;
    document.getElementById("pdf-preview-title").textContent = name || "PDF Preview";
    document.getElementById("pdf-preview").classList.add("show");
}
function closePdfPreview() {
    document.getElementById("pdf-preview").classList.remove("show");
    document.getElementById("pdf-frame").src = "";
}


function loadChat(enc) {
    const title = decodeURIComponent(enc);
    const chat  = chats.find(c => c.title === title);
    if (!chat) return;
    currentTitle    = title;
    currentChat     = [...chat.messages];
    currentChatPDFs = (chat.pdfs || []).map(p => ({ name:p.name, content:p.content, url:null }));
    pendingPDFs     = [];
    currentTopic    = chat.topic || null;
    updateTopicUI();
    document.getElementById("chat-box").innerHTML      = "";
    document.getElementById("selected-file").innerHTML = "";
    closePdfPreview();
    const chatBox = document.getElementById("chat-box");
    if (currentTopic) showTopicBanner();
    chat.messages.forEach((msg, idx) => {
        if (msg.pdfs && msg.pdfs.length > 0)
            msg.pdfs.forEach(pdf => chatBox.appendChild(makePdfChip(pdf.name, null, false)));
        if (msg.role === "bot") {
            renderBotMessage(msg, chatBox);
        } else {
            renderUserMessage(msg.content || "", idx, chatBox);
        }
    });
    scrollToBottom();
}

async function loadSharedChatView() {
    document.getElementById("chat-box").innerHTML = "";
    document.getElementById("selected-file").innerHTML = "";
    closePdfPreview();
    try {
        const r = await fetch("/shared/" + sharedToken);
        if (!r.ok) {
            document.getElementById("chat-box").innerHTML = "<div class='msg bot error'>Failed to load shared chat. Link may be invalid or expired.</div>";
            return;
        }
        const data = await r.json();
        currentTitle = data.title || "Shared Chat";
        currentTopic = data.topic || null;
        updateTopicUI();
        if (currentTopic) showTopicBanner();
        
        const chatBox = document.getElementById("chat-box");
        currentChat = [...data.messages];
        data.messages.forEach((msg, idx) => {
            if (msg.role === "bot") {
                renderBotMessage(msg, chatBox);
            } else {
                renderUserMessage(msg.content || "", idx, chatBox);
            }
        });
        scrollToBottom();
    } catch (e) {
        document.getElementById("chat-box").innerHTML = "<div class='msg bot error'>Error loading chat.</div>";
    }
}

function scrollToBottom() {
    const cb = document.getElementById("chat-box");
    cb.scrollTop = cb.scrollHeight;
}


async function sendMessage() {
    const input = document.getElementById("user-input");
    const msg   = input.value.trim();
    if (!msg && pendingPDFs.length === 0) return;
    if (micListening) stopMic();

    const chatBox    = document.getElementById("chat-box");
    const messagePDFs = [];

    pendingPDFs.forEach(pdf => {
        chatBox.appendChild(makePdfChip(pdf.name, pdf.url, false));
        messagePDFs.push({ name:pdf.name, content:pdf.content, url:pdf.url });
        currentChatPDFs.push({ name:pdf.name, content:pdf.content, url:pdf.url });
    });

    
    const userMsgIndex = currentChat.length;
    if (msg) renderUserMessage(msg, userMsgIndex, chatBox);

    currentChat.push({ role:"user", content:msg || "[PDF uploaded]", pdfs:messagePDFs.map(p=>({name:p.name})) });
    input.value = ""; input.style.height = "auto";
    pendingPDFs = []; document.getElementById("selected-file").innerHTML = "";
    scrollToBottom();

    
    const ld = document.createElement("div");
    ld.className = "msg bot loading";
    ld.innerHTML = "<span></span><span></span><span></span>";
    chatBox.appendChild(ld); scrollToBottom();

    try {
        const pdfContent = currentChatPDFs.map(p => p.content).join("\n\n---\n\n");
        const history    = currentChat
            .slice(0, -1)
            .filter(m => !m.vizType && m.content)
            .slice(-10)
            .map(m => ({ role: m.role, content: m.content }));

        const endpoint = isSharedView ? "/chat/shared/" + sharedToken : "/chat";
        const res = await fetch(endpoint, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({
                message:              msg || "Summarize the uploaded PDF",
                pdf_text:             pdfContent,
                use_pdf:              currentChatPDFs.length > 0,
                conversation_history: history,
                topic_lock:           currentTopic || null
            })
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || `Server error ${res.status}`);
        }

        const data      = await res.json();
        ld.remove();

        const replyHtml = data.reply || "<p>Sorry, no response received.</p>";
        const botMsg    = { role:"bot", content:replyHtml };

        
        const botMsgObj = { ...botMsg };
        if (!botMsgObj.msgId)
            botMsgObj.msgId = "bot-" + Date.now() + "-" + Math.floor(Math.random() * 9999);

        const wrapper = document.createElement("div");
        wrapper.className = "msg bot";
        wrapper.id        = botMsgObj.msgId;
        chatBox.appendChild(wrapper);

       
        typewriterAnimate(wrapper, replyHtml, () => {
            
            botMsg.msgId = botMsgObj.msgId;
            currentChat.push(botMsg);
            scrollToBottom();

            if (isSharedView) return;
           
            let tp = Promise.resolve(currentTitle);
            if (!currentTitle) {
                tp = fetch("/generate_title", {
                    method:  "POST",
                    headers: { "Content-Type": "application/json" },
                    body:    JSON.stringify({ message: msg || "PDF Analysis" })
                }).then(r => r.json())
                  .then(td => { currentTitle = td.title || "New Chat"; return currentTitle; })
                  .catch(() => { currentTitle = "New Chat"; return "New Chat"; });
            }
            tp.then(title => {
                fetch("/save_chat", {
                    method:  "POST",
                    headers: { "Content-Type": "application/json" },
                    body:    JSON.stringify({
                        title,
                        messages: currentChat,
                        pdfs:     currentChatPDFs.map(p => ({ name:p.name, content:p.content })),
                        topic:    currentTopic || null
                    })
                }).then(() => loadHistory());
            });
        });

    } catch(err) {
        ld.remove();
        const ed = document.createElement("div");
        ed.className   = "msg bot error";
        ed.textContent = "Error: " + err.message;
        chatBox.appendChild(ed); scrollToBottom();
    }
}

function toggleTheme() {
    document.body.classList.toggle("light-mode");
    document.getElementById("theme-btn").textContent =
        document.body.classList.contains("light-mode") ? "☀️" : "🌙";
    localStorage.setItem("theme",
        document.body.classList.contains("light-mode") ? "light" : "dark");
}


window.onload = initAuth;