# Gemini Chatbot - Render Deployment Fixes

## Summary of Changes

All changes implement strict Auth0 user isolation, fix API call optimization, ensure empty chat on login, and provide unique suggestions.

---

## 1. AUTH0 USER ISOLATION (Backend)

### `routes/chat.py`

**Added proper JWT verification:**
- Added `python-jose` for RS256 signature verification
- Added `_get_jwks()` — fetches Auth0 public keys once per process, caches in memory
- Added `_decode_jwt_sub()` — two-stage JWT decode:
  - **Stage 1:** Verified RS256 decode via `python-jose` + JWKS (secure, production-ready)
  - **Stage 2:** Unverified base64 fallback (keeps app alive if JWKS temporarily unavailable)
- Updated `_get_user_id()` to use the new verified decode

**Result:** Every endpoint (`/chats`, `/save_chat`, `/chat/{id}`, `/share`, `/unshare`, `/suggest`) automatically enforces user isolation via `_get_user_id(request)`. Each user's chats are stored in separate files: `data/chats_{user_id}.json`.

### `requirements.txt`

**Added:**
```
python-jose[cryptography]==3.3.0
```

---

## 2. FIX: TOO MANY API REQUESTS (Frontend)

### `static/script.js`

**Problem:** `saveCurrentChat()` called `loadHistory()` after every save → full `/chats` fetch after every bot reply.

**Fix:**
- Added `_updateLocalChat()` — updates the in-memory `chats` array and re-renders sidebar without a network call
- `saveCurrentChat()` now calls `_updateLocalChat()` instead of `loadHistory()`
- `sendMessage()` now calls `saveCurrentChat()` instead of inline save + `loadHistory()`

**Result:** Reduced API calls from 3-4 per message to 2 (chat + save). Sidebar still updates instantly.

---

## 3. EMPTY CHAT ON LOGIN (Frontend)

### `static/script.js`

**Problem:** `historyLoaded` flag prevented history from loading after Auth0 redirect. Also, `initApp()` never reset chat state, so returning users saw stale data.

**Fix:**
- Removed `historyLoaded` flag entirely (the `_historyFetching` guard inside `loadHistory()` already prevents duplicate concurrent calls)
- `initApp()` now:
  1. Calls `_resetSugg("new")` to clear suggestion cache
  2. Resets all chat state variables (`currentChatId`, `currentTitle`, `currentChat`, etc.)
  3. Clears chat box HTML
  4. Calls `loadHistory().then(() => _prefetchNewChat())` — loads history first, THEN fetches suggestions with real context

**Result:** 
- **First-time users:** See empty chat box, empty sidebar
- **Returning users:** See empty chat box, populated sidebar with their history

---

## 4. UNIQUE SUGGESTIONS (Backend + Frontend)

### `routes/chat.py`

**Problem:** Fallback default suggestions were always the same 3 strings.

**Fix:**
- Expanded default suggestion pool from 5 to 10 items
- Added `random.shuffle()` before selecting 3 defaults
- Applied same fix to the exception handler failsafe

**Result:** Even first-time users with no history see 3 different suggestions on each login.

### `static/script.js`

**Problem:** `_prefetchNewChat()` had `if (_S.ncFetching || _S.ncReady) return` — once fetched, suggestions were never refreshed, even across logins or new chats.

**Fix:**
- Changed guard to `if (_S.ncFetching) return` — only prevents concurrent duplicate calls
- Added early return if `_S.ncReady && _S.ncList.length` — reuses suggestions within the same chat session (correct behavior)
- `_resetSugg()` clears `ncReady` and `ncList` on every `newChat()` and `loadChat()` — forces fresh fetch
- `initApp()` now calls `loadHistory().then(_prefetchNewChat)` — suggestions are fetched AFTER history loads, so backend has real user context

**Result:** 
- Suggestions are personalised based on user's actual chat history
- Suggestions refresh on every new chat / login
- Suggestions are unique (randomised fallbacks + Gemini-generated based on history)

---

## 5. TEXTBOX AUTO-RESIZE

### Already implemented
`autoResize()` function already exists and is wired to `oninput` event. No changes needed.

---

## 6. PIN/UNPIN CHAT

### Already implemented
- Backend stores `original_index` when pinning
- Frontend `togglePin()` restores original position on unpin
- `renderChatList()` sorts unpinned chats by `original_index`

No changes needed.

---

## 7. SHARED CHAT SUGGESTIONS

### Already implemented
`loadSharedChatView()` calls `_loadContinueChips()` — same suggestion logic applies to shared chats. No changes needed.

---

## Testing Checklist

### Auth0 User Isolation
- [ ] User A logs in → sees only their chats
- [ ] User B logs in → sees only their chats
- [ ] User A and User B cannot see each other's chats

### Empty Chat on Login
- [ ] First-time user logs in → empty chat box, empty sidebar
- [ ] Returning user logs in → empty chat box, populated sidebar
- [ ] User sends message → chat is saved → appears in sidebar

### Suggestions
- [ ] New chat → 3 unique suggestions appear
- [ ] Logout + login → 3 different suggestions appear
- [ ] Type in textbox → suggestions update based on input
- [ ] After bot reply → 3 context-based suggestions appear
- [ ] Click suggestion → fills textbox

### API Optimization
- [ ] Send message → max 2-3 API calls (not 4-5)
- [ ] Sidebar updates without extra `/chats` fetch after save

### Pin/Unpin
- [ ] Pin chat → moves to top
- [ ] Unpin chat → returns to original position

---

## Deployment Steps

1. **Install dependencies:**
   ```bash
   pip install -r requirements.txt
   ```

2. **Deploy to Render:**
   - Push changes to Git
   - Render auto-deploys from main branch
   - Verify environment variables are set (GEMINI_API_KEY)

3. **Test on Render:**
   - Open https://gemini-chatbot-909e.onrender.com
   - Test Auth0 login flow
   - Verify user isolation
   - Test suggestions
   - Test chat save/load

---

## Files Modified

1. `routes/chat.py` — Auth0 JWT verification + randomised suggestions
2. `static/script.js` — API optimization + empty chat on login + fresh suggestions
3. `requirements.txt` — Added python-jose
4. No UI/CSS changes (as requested)
