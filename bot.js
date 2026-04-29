require('dotenv').config();
const { Bot, session, InlineKeyboard } = require('grammy');
const fs = require('fs').promises;
const axios = require('axios');
const Fuse = require('fuse.js');
const { exec } = require('child_process');

// ═══════════════════════════════════════
// 🔐 CONFIG
// ═══════════════════════════════════════
const BOT_TOKEN    = process.env.BOT_TOKEN;
const OMDB_API_KEY = process.env.OMDB_API_KEY;
const CHANNEL      = process.env.CHANNEL || '@cineradarai';
const CHANNEL_USERNAME = (process.env.CHANNEL || '@cineradarai').replace('@', ''); // for t.me links
const BOT_USERNAME = process.env.BOT_USERNAME || 'cineradarai_bot'; // .env mein add karo

// ── MULTI-ADMIN SUPPORT ──────────────────────────────────────
// .env mein: ADMIN_ID=111111,222222,333333  (comma separated)
// Pehla ID = PRIMARY_ADMIN — notifications & convo relays yahan aate hain
const ADMIN_IDS = new Set(
  (process.env.ADMIN_ID || '5951923988')
    .split(',')
    .map(id => Number(id.trim()))
    .filter(Boolean)
);
const PRIMARY_ADMIN = [...ADMIN_IDS][0];
function isAdmin(id) { return ADMIN_IDS.has(Number(id)); }
// ────────────────────────────────────────────────────────────
const AUTO_DELETE  = 3 * 60 * 1000;
const WELCOME_GIF  = 'https://media.tenor.com/8d9B7xYkZk0AAAAC/welcome.gif';
const OMDB_BASE    = 'https://www.omdbapi.com/';
const WEBSITE_URL  = 'https://www.compressdocument.in/';
const INSTAGRAM_URL = 'https://www.instagram.com/_www.compressdocument.in?igsh=MzNtdGVoeHp3YWhq';

if (!BOT_TOKEN)    throw new Error('❌ BOT_TOKEN missing in .env');
if (!OMDB_API_KEY) throw new Error('❌ OMDB_API_KEY missing in .env');
// ═══════════════════════════════════════
// 🎭 MOOD MAP — keywords + emojis → genre tags
// ═══════════════════════════════════════
const MOOD_MAP = {
  happy:    { label: '😄 Happy',    emojis: ['😄','😁','😊','🥳','😃','🤩','😀'], keywords: ['comedy','feel good','fun','musical','animation','family'] },
  sad:      { label: '😢 Sad',      emojis: ['😢','😭','💔','🥺','😞','😔'],       keywords: ['drama','emotional','tragedy','loss','heartbreak'] },
  romantic: { label: '❤️ Romantic', emojis: ['❤️','🥰','😍','💕','💑','💘','💞'], keywords: ['romance','love','romantic','relationship','couple'] },
  scary:    { label: '😱 Scary',    emojis: ['😱','👻','🎃','😨','🕷️','🧟','💀'], keywords: ['horror','thriller','scary','suspense','ghost','zombie'] },
  funny:    { label: '😂 Funny',    emojis: ['😂','🤣','😆','😝','🤪','😜'],       keywords: ['comedy','funny','laugh','spoof','parody'] },
  action:   { label: '💥 Action',   emojis: ['💥','🔥','⚡','🥊','🏎️','💣','🤜'], keywords: ['action','fight','war','adventure','superhero'] },
  chill:    { label: '😌 Chill',    emojis: ['😌','🧘','☕','🌙','🛋️','😴'],       keywords: ['slice of life','light','mild','gentle','calm'] },
  mystery:  { label: '🔍 Mystery',  emojis: ['🔍','🕵️','🤫','🧐','❓','🔎'],       keywords: ['mystery','detective','crime','whodunit','investigation'] },
};

// Flat emoji → mood lookup
const EMOJI_TO_MOOD = {};
Object.entries(MOOD_MAP).forEach(([mood, data]) => {
  data.emojis.forEach(e => { EMOJI_TO_MOOD[e] = mood; });
});

function detectMood(text) {
  if (!text) return null;
  const lower = text.toLowerCase().trim();
  for (const mood of Object.keys(MOOD_MAP)) {
    if (lower === mood || lower.startsWith(mood + ' ') || lower.endsWith(' ' + mood) || lower.includes(mood + ' movie') || lower.includes(mood + ' film')) {
      return mood;
    }
  }
  // Emoji match
  for (const char of [...text]) {
    if (EMOJI_TO_MOOD[char]) return EMOJI_TO_MOOD[char];
  }
  return null;
}

// ═══════════════════════════════════════
// 🗳️ DEBATE STORAGE
// debatePolls: chatId → { msgId, movie1, movie2, votes:{userId:1|2}, endTime }
// ═══════════════════════════════════════
const debatePolls = new Map();

// ═══════════════════════════════════════
// 📁 IN-MEMORY DATABASE
// ═══════════════════════════════════════
let movies   = {};
let requests = [];
let users    = {};
let banned   = {};

const adminUploadState = new Map();
let adminEditState = {};
let adminEditMode  = {};
let movieCounter   = 1;

const userLastSearch = new Map();

// ═══════════════════════════════════════
// 💬 CHAT HISTORY & DIRECT CONVO (NEW)
// ═══════════════════════════════════════
let chatLogs = {};
// Structure: { userId: [ { role: 'user'|'bot', text, time } ] }

let adminConvoTarget = null;
// When set, admin messages relay to this userId and their replies forward to admin

async function loadChatLogs() {
  chatLogs = await readJSON('chatLogs.json', {});
}
async function saveChatLogs() {
  await writeJSON('chatLogs.json', chatLogs);
}

// ═══════════════════════════════════════
// 🎭 GENRE CACHE
// movieId → { genre: "Action, Drama", plot: "...", fetched: ISO }
// OMDB se real genre store karke mood matching accurate banate hain
// ═══════════════════════════════════════
let genreCache = {};

async function loadGenreCache() {
  genreCache = await readJSON('genreCache.json', {});
}
async function saveGenreCache() {
  await writeJSON('genreCache.json', genreCache);
}

/**
 * Ek movie ka genre OMDB se fetch karo (cache-first).
 * Returns genre string like "Action, Drama, Thriller" or null.
 */
async function fetchGenreForMovie(movie) {
  if (!movie?.id) return null;
  // Cache hit
  if (genreCache[movie.id]?.genre) return genreCache[movie.id].genre;

  try {
    const data = await fetchOMDb(movie.name);
    if (data && data.Genre && data.Genre !== 'N/A') {
      genreCache[movie.id] = {
        genre:   data.Genre,
        plot:    data.Plot !== 'N/A' ? data.Plot : '',
        rating:  data.imdbRating !== 'N/A' ? data.imdbRating : '',
        fetched: new Date().toISOString()
      };
      saveGenreCache(); // fire-and-forget
      return data.Genre;
    }
  } catch (e) {
    console.error('[GENRE CACHE]', e.message);
  }
  return null;
}

/**
 * Mood ke liye OMDB genre se movies filter karo.
 * Sirf un movies ko fetch karta hai jinka cache missing ho.
 * Returns filtered movie list (empty array if nothing matches).
 */
async function filterMoviesByMood(movieList, mood) {
  if (!mood || !MOOD_MAP[mood]) return movieList;
  const moodKeywords = MOOD_MAP[mood].keywords; // e.g. ['horror','thriller','ghost']

  const matched = [];

  // Process movies — cache miss waale batchwise OMDB se fetch karo
  // Rate limit: 200ms gap between OMDB calls
  for (const movie of movieList) {
    let genre = genreCache[movie.id]?.genre || null;

    if (!genre) {
      // Cache miss — OMDB se fetch karo
      genre = await fetchGenreForMovie(movie);
      await new Promise(r => setTimeout(r, 200)); // rate limit
    }

    if (genre) {
      const genreLower = genre.toLowerCase();
      const isMatch = moodKeywords.some(kw => genreLower.includes(kw));
      if (isMatch) matched.push({ movie, genre });
    }
  }

  return matched.map(x => x.movie);
}



/**
 * Log a message in chatLogs
 * @param {string|number} userId
 * @param {'user'|'bot'} role
 * @param {string} text
 */
function logMessage(userId, role, text) {
  const uid = String(userId);
  if (!chatLogs[uid]) chatLogs[uid] = [];
  chatLogs[uid].push({
    role,
    text: String(text || '').slice(0, 500),
    time: new Date().toISOString()
  });
  // Keep last 300 messages per user to avoid bloat
  if (chatLogs[uid].length > 300) {
    chatLogs[uid] = chatLogs[uid].slice(-300);
  }
  saveChatLogs(); // async but fire-and-forget intentionally
}

// ═══════════════════════════════════════
// 📅 DAILY QUEUE
// ═══════════════════════════════════════
let dailyQueue = [];

async function loadDailyQueue() {
  dailyQueue = await readJSON('dailyQueue.json', []);
}
async function saveDailyQueue() {
  await writeJSON('dailyQueue.json', dailyQueue);
}

// ═══════════════════════════════════════
// 🔍 FUSE.JS INDEX
// ═══════════════════════════════════════
let fuseIndex = null;
function rebuildFuseIndex() {
  fuseIndex = new Fuse(Object.values(movies), {
    keys: ['name'],
    threshold: 0.4,
    includeScore: true
  });
}

// ═══════════════════════════════════════
// 💾 DB LOAD / SAVE
// ═══════════════════════════════════════
async function readJSON(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { return fallback; }
}
async function writeJSON(file, data) {
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}

async function loadDB() {
  movies   = await readJSON('movies.json', {});
  requests = await readJSON('requests.json', []);
  users    = await readJSON('users.json', {});
  banned   = await readJSON('banned.json', {});
  await loadDailyQueue();
  await loadChatLogs();
  await loadGenreCache(); // ← genre cache for mood search

  let needsMigration = false;
  const newMovies = {};
  let counter = 1;
  for (const key in movies) {
    const m = movies[key];
    if (key.startsWith('m_') && m.id?.startsWith('m_')) {
      newMovies[key] = m;
      const n = parseInt(key.slice(2));
      if (!isNaN(n) && n >= counter) counter = n + 1;
    } else {
      needsMigration = true;
      const newKey = `m_${counter}`;
      newMovies[newKey] = { ...m, id: newKey, shortId: counter, downloads: m.downloads || 0 };
      counter++;
    }
  }
  if (needsMigration) {
    movies = newMovies;
    await writeJSON('movies.json', movies);
    console.log('✅ Migration done');
  }
  movieCounter = counter;
  rebuildFuseIndex();
}

async function saveDB()       { await writeJSON('movies.json', movies); rebuildFuseIndex(); }
async function saveRequests() { await writeJSON('requests.json', requests); }
async function saveUsers()    { await writeJSON('users.json', users); }
async function saveBanned()   { await writeJSON('banned.json', banned); }

// ═══════════════════════════════════════
// 🛠️ UTILITIES
// ═══════════════════════════════════════
function sanitize(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>]/g, '').trim().slice(0, 200);
}

function escapeMarkdown(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

function fmtSize(bytes) {
  if (!bytes) return '';
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

function movieBtnLabel(m) {
  const parts = [m.name];
  if (m.year)     parts.push(m.year);
  parts.push('|');
  parts.push(m.language || 'N/A');
  parts.push('|');
  parts.push(m.quality  || 'N/A');
  if (m.size)     parts.push('| ' + fmtSize(m.size));
  return `⬇️ ${parts.join(' ')}`.slice(0, 60);
}

function scheduleDelete(chatId, ...msgIds) {
  setTimeout(() => {
    msgIds.forEach(id => {
      if (id) bot.api.deleteMessage(chatId, id).catch(() => {});
    });
  }, AUTO_DELETE);
}

async function tempReply(ctx, text, options = {}) {
  if (isAdmin(ctx.from?.id)) {
    return ctx.reply(text, options);
  }
  try {
    const msg = await ctx.reply(text, options);
    const chatId = ctx.chat?.id || ctx.message?.chat?.id;
    const userMsgId = ctx.message?.message_id;
    if (chatId) {
      scheduleDelete(chatId, msg.message_id, ...(userMsgId ? [userMsgId] : []));
    }
    return msg;
  } catch (e) {
    console.error('tempReply:', e.message);
    return null;
  }
}

async function tempPhoto(ctx, photo, options = {}) {
  if (isAdmin(ctx.from?.id)) {
    return ctx.replyWithPhoto(photo, options);
  }
  try {
    const msg = await ctx.replyWithPhoto(photo, options);
    const chatId = ctx.chat?.id || ctx.message?.chat?.id;
    const userMsgId = ctx.message?.message_id;
    if (chatId) {
      scheduleDelete(chatId, msg.message_id, ...(userMsgId ? [userMsgId] : []));
    }
    return msg;
  } catch (e) {
    console.error('tempPhoto:', e.message);
    return null;
  }
}

async function tempAnim(ctx, anim, options = {}) {
  if (isAdmin(ctx.from?.id)) {
    return ctx.replyWithAnimation(anim, options);
  }
  try {
    const msg = await ctx.replyWithAnimation(anim, options);
    const chatId = ctx.chat?.id;
    if (chatId) scheduleDelete(chatId, msg.message_id);
    return msg;
  } catch {
    return tempReply(ctx, options.caption || 'Welcome!', { parse_mode: options.parse_mode });
  }
}

function trackUser(userId, firstName, username) {
  const now = new Date().toISOString();
  if (!users[userId]) {
    users[userId] = { id: userId, first_name: firstName || 'User', username: username || '',
                      first_seen: now, last_seen: now, search_count: 0, downloads: 0 };
  } else {
    Object.assign(users[userId], { last_seen: now,
      first_name: firstName || users[userId].first_name,
      username:   username   || users[userId].username });
  }
  saveUsers();
}

function hasVisitedWebsiteToday(userId) {
  const user = users[userId];
  if (!user || !user.lastWebsiteVisit) return false;
  const lastVisit = new Date(user.lastWebsiteVisit);
  const today = new Date();
  return lastVisit.toDateString() === today.toDateString();
}

function markWebsiteVisited(userId) {
  if (!users[userId]) return;
  users[userId].lastWebsiteVisit = new Date().toISOString();
  saveUsers();
}

const rlMap = new Map();
async function rateLimit(ctx, next) {
  const uid = ctx.from?.id;
  if (!uid) return next();
  const now = Date.now();
  const d = rlMap.get(uid) || { count: 0, t: now };
  if (now - d.t > 10000) { d.count = 1; d.t = now; }
  else d.count++;
  rlMap.set(uid, d);
  if (d.count > 15) {
    await ctx.reply('⚠️ Too many requests! Slow down a bit.').catch(() => {});
    return;
  }
  return next();
}

async function banCheck(ctx, next) {
  if (!ctx.from) return next();
  if (banned[ctx.from.id]) {
    await ctx.reply('🚫 You are banned.').catch(() => {});
    return;
  }
  return next();
}

function mergeKeyboards(kb1, kb2) {
  const merged = new InlineKeyboard();
  const rows1 = kb1.inline_keyboard || [];
  const rows2 = kb2.inline_keyboard || [];
  [...rows1, ...rows2].forEach(row => {
    if (row.length) merged.row(...row);
  });
  return merged;
}

// ═══════════════════════════════════════
// 🎬 OMDB API CALLS
// ═══════════════════════════════════════
async function fetchOMDb(title) {
  try {
    const r = await axios.get(OMDB_BASE, {
      params: { apikey: OMDB_API_KEY, t: title, plot: 'short' },
      timeout: 5000
    });
    return r.data?.Response === 'True' ? r.data : null;
  } catch (e) { console.error('OMDb:', e.message); return null; }
}

async function searchOMDb(query, year = '') {
  try {
    const r = await axios.get(OMDB_BASE, {
      params: { apikey: OMDB_API_KEY, s: query, y: year, type: 'movie' },
      timeout: 5000
    });
    return r.data?.Response === 'True' ? r.data.Search : [];
  } catch (e) { console.error('OMDb search:', e.message); return []; }
}

// ═══════════════════════════════════════
// 🇮🇳 INDIAN MOVIES FETCHERS
// ═══════════════════════════════════════
const INDIAN_KEYWORDS = [
  'Bollywood', 'Hindi', 'Tamil', 'Telugu', 'Malayalam', 'Kannada',
  'Shah Rukh Khan', 'Salman Khan', 'Aamir Khan', 'Akshay Kumar', 'Ajay Devgn',
  'Rajinikanth', 'Vijay', 'Ajith', 'Allu Arjun', 'Prabhas', 'Yash'
];

async function getIndianMoviesByType(type = 'new', count = 5) {
  const year = type === 'new' ? new Date().getFullYear() : new Date().getFullYear() + 1;
  const allMovies = [];

  for (const kw of INDIAN_KEYWORDS.slice(0, 8)) {
    const res = await searchOMDb(kw, String(year));
    allMovies.push(...res);
    if (allMovies.length >= count * 3) break;
    await new Promise(r => setTimeout(r, 200));
  }

  const unique = [...new Map(allMovies.map(m => [m.imdbID, m])).values()];
  const indianMovies = [];

  for (const m of unique) {
    const details = await fetchOMDb(m.Title);
    if (!details || !details.Poster || details.Poster === 'N/A') continue;

    const lang    = (details.Language || '').toLowerCase();
    const country = (details.Country  || '').toLowerCase();
    const isIndian =
      lang.includes('hindi') || lang.includes('tamil') || lang.includes('telugu') ||
      lang.includes('malayalam') || lang.includes('kannada') ||
      country.includes('india');

    if (isIndian) {
      indianMovies.push(details);
      if (indianMovies.length >= count) break;
    }
    await new Promise(r => setTimeout(r, 200));
  }
  return indianMovies;
}

// ═══════════════════════════════════════
// 🔍 SEARCH HELPERS
// ═══════════════════════════════════════
function searchMovies(query, filters = {}) {
  const q = query.toLowerCase();
  return Object.values(movies).filter(m => {
    if (!m.name.toLowerCase().includes(q)) return false;
    if (filters.language && (m.language || '').toLowerCase() !== filters.language.toLowerCase()) return false;
    if (filters.quality  && (m.quality  || '').toLowerCase() !== filters.quality.toLowerCase())  return false;
    if (filters.year     && String(m.year) !== String(filters.year))                             return false;
    return true;
  });
}

function fuzzyMatch(query) {
  if (!fuseIndex) return null;
  const r = fuseIndex.search(query);
  return r.length && r[0].score <= 0.4 ? r[0].item.name : null;
}

function groupMovies(list) {
  const g = {};
  list.forEach(m => {
    const k = `${m.name.toLowerCase()}|${m.year || '0'}`;
    if (!g[k]) g[k] = { displayName: m.name, year: m.year, items: [] };
    g[k].items.push(m);
  });
  return Object.values(g);
}

function buildFilterKeyboard(query, results) {
  const years = [...new Set(results.map(m => m.year).filter(Boolean))].sort().reverse();
  const langs  = [...new Set(results.map(m => m.language).filter(Boolean))].sort();
  const quals  = [...new Set(results.map(m => m.quality).filter(Boolean))].sort();

  const kb = new InlineKeyboard();
  if (years.length > 1) {
    years.slice(0, 5).forEach(y => kb.text(`📅 ${y}`, `f|${query}|year|${y}`));
    kb.row();
  }
  if (langs.length > 1) {
    langs.slice(0, 4).forEach(l => kb.text(`🌐 ${l}`, `f|${query}|lang|${l}`));
    kb.row();
  }
  if (quals.length > 1) {
    quals.slice(0, 5).forEach(q => kb.text(`📺 ${q}`, `f|${query}|qual|${q}`));
    kb.row();
  }
  if (years.length > 1 || langs.length > 1 || quals.length > 1) {
    kb.text(`🔄 All (${results.length})`, `f|${query}|all|all`);
  }
  return kb;
}

// ═══════════════════════════════════════
// 🔍 SMART QUERY PARSER
// ═══════════════════════════════════════
const KNOWN_LANGUAGES = [
  'hindi', 'english', 'tamil', 'telugu', 'malayalam', 'kannada',
  'dual audio', 'multi audio', 'punjabi', 'bengali', 'marathi'
];

function parseQuery(rawQuery) {
  const query = rawQuery.toLowerCase().trim();

  const yearMatch = query.match(/\b(19\d{2}|20\d{2})\b/);
  const year = yearMatch ? yearMatch[0] : null;

  let namePart = query.replace(/\b(19\d{2}|20\d{2})\b/, '').trim();

  let language = null;
  const sortedLangs = [...KNOWN_LANGUAGES].sort((a, b) => b.length - a.length);
  for (const lang of sortedLangs) {
    const regex = new RegExp(`\\b${lang}\\b`, 'i');
    if (regex.test(namePart)) {
      language = lang.charAt(0).toUpperCase() + lang.slice(1);
      namePart = namePart.replace(regex, '').trim();
      break;
    }
  }

  let movieName = namePart.replace(/\s+/g, ' ').trim();
  if (!movieName) movieName = query;

  return { movieName, year, language };
}

// ═══════════════════════════════════════
// 🤖 BOT INIT
// ═══════════════════════════════════════
const bot = new Bot(BOT_TOKEN);
bot.use(session({ initial: () => ({}) }));

// ═══════════════════════════════════════
// 🔔 FORCE JOIN — Channel membership check
// Jab tak user channel join nahi karta, bot use nahi kar sakta.
// Isse "bot blocked/never started" users bhi wapas active ho jaate hain.
// ═══════════════════════════════════════

/**
 * Check if user is a member of the channel.
 * Returns true if member/admin/creator, false otherwise.
 */
async function isChannelMember(userId) {
  try {
    const member = await bot.api.getChatMember(CHANNEL, userId);
    return ['member', 'administrator', 'creator'].includes(member.status);
  } catch {
    return false;
  }
}

/**
 * Send force-join prompt to user.
 */
async function sendForceJoinMsg(ctx) {
  const kb = new InlineKeyboard()
    .url('📢 Channel Join Karein', `https://t.me/${CHANNEL_USERNAME}`)
    .row()
    .text('✅ Join Kar Li — Verify', 'verify_join');
  await ctx.reply(
    `🔒 *CineRadar AI Use Karne Ke Liye Pehle Channel Join Karein!*\n\n` +
    `📢 Channel: @${CHANNEL_USERNAME}\n\n` +
    `Channel join karne ke baad *"✅ Join Kar Li — Verify"* button dabaao.\n\n` +
    `_Join karne ke fayde:_\n` +
    `• 🎬 Daily new movies ki update\n` +
    `• 🗳️ Daily movie debate\n` +
    `• 📖 Daily bot usage guide\n` +
    `• ⚡ 3x Fast Download tips`,
    { parse_mode: 'Markdown', reply_markup: kb }
  ).catch(() => {});
}

// ── Auto-accept join requests ──────────────────────────────
// Jab koi channel/group mein join request bheje → auto approve
bot.on('chat_join_request', async ctx => {
  try {
    await ctx.approveChatJoinRequest(ctx.from.id);
    // Welcome DM send karo
    await bot.api.sendMessage(ctx.from.id,
      `🎉 *Welcome to CineRadar AI!*\n\n` +
      `✅ Aapki join request accept ho gayi!\n\n` +
      `🎬 Ab aap bot use kar sakte hain:\n` +
      `• Movie ka naam type karo\n` +
      `• /random — random movie\n` +
      `• /debate — live voting\n` +
      `• Mood type karo: happy, sad, action...\n\n` +
      `⚡ *3x Fast Download ke liye website visit karein ek baar!*\n` +
      `🔗 ${WEBSITE_URL}`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});
    console.log(`[JOIN REQUEST] Auto-approved: ${ctx.from.id}`);
  } catch (e) {
    console.error('[JOIN REQUEST] Error:', e.message);
  }
});

// ═══════════════════════════════════════
// 🧹 Global auto-delete for non-admin user messages (3 minutes)
// ═══════════════════════════════════════
bot.use(async (ctx, next) => {
  await next();

  const msg = ctx.message;
  if (!msg) return;

  const userId = ctx.from?.id;
  if (!userId || isAdmin(userId)) return;

  setTimeout(() => {
    bot.api.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {});
  }, AUTO_DELETE);
});

bot.use(rateLimit);
bot.use(banCheck);

// ═══════════════════════════════════════
// 🔔 FORCE JOIN MIDDLEWARE
// Admin aur already-joined users ko pass karo.
// Baaki sabko channel join karne ke liye kaho.
// Isse "bot blocked" wale users bhi channel se wapas active hote hain.
// ═══════════════════════════════════════
bot.use(async (ctx, next) => {
  const userId = ctx.from?.id;
  if (!userId || isAdmin(userId)) return next();

  // Callback queries mein sirf verify_join aur channel join check allow karo
  if (ctx.callbackQuery) {
    if (ctx.callbackQuery.data === 'verify_join') {
      const joined = await isChannelMember(userId);
      if (joined) {
        trackUser(userId, ctx.from.first_name, ctx.from.username);
        try { await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }); } catch {}
        await ctx.reply(
          `✅ *Verification Successful!*\n\n` +
          `🎬 Ab aap CineRadar AI use kar sakte hain!\n` +
          `Movie ka naam type karo ya /help dekho.`,
          { parse_mode: 'Markdown' }
        ).catch(() => {});
        return ctx.answerCallbackQuery({ text: '✅ Verified! Bot use kar sakte hain.' });
      } else {
        return ctx.answerCallbackQuery({
          text: '❌ Aap abhi channel member nahi hain. Pehle join karein!',
          show_alert: true
        });
      }
    }
    // Other callbacks — check membership
    const joined = await isChannelMember(userId);
    if (!joined) {
      await sendForceJoinMsg(ctx).catch(() => {});
      return ctx.answerCallbackQuery({ text: '⚠️ Pehle channel join karein!', show_alert: true });
    }
    return next();
  }

  // Message updates — /start allow karo bina check ke
  if (ctx.message?.text?.startsWith('/start')) return next();

  // Membership check
  const joined = await isChannelMember(userId);
  if (!joined) {
    return sendForceJoinMsg(ctx);
  }

  return next();
});

// ═══════════════════════════════════════
// 🔒 CONVO MODE INTERCEPTOR MIDDLEWARE
// Jab admin kisi user se convo mein ho, us user ke
// SAARE messages aur commands yahan intercept ho jaate hain.
// next() call nahi hoti — koi bhi command/search run nahi hogi.
// Sirf admin ke /endconvo se normal mode wapas aayega.
// ═══════════════════════════════════════
bot.use(async (ctx, next) => {
  const userId = ctx.from?.id;
  // Sirf non-admin users pe apply karo
  if (!userId || isAdmin(userId)) return next();
  // Sirf tab jab convo active ho aur ye user convo target ho
  if (!adminConvoTarget || adminConvoTarget !== String(userId)) return next();

  // ── Is user ka trackUser update karo ──
  const msg = ctx.message;
  if (msg?.from) trackUser(userId, msg.from.first_name, msg.from.username);

  const info = users[String(userId)];
  const name = info?.username ? `@${info.username}` : info?.first_name || `User ${userId}`;

  // ── Callback queries (inline buttons) allow karo — normal kaam kare ──
  if (ctx.callbackQuery) return next();

  if (!msg) return; // Koi aur update type — ignore

  // ── Commands block karo ──
  if (msg.text?.startsWith('/')) {
    await ctx.reply(
      `🔒 *Abhi aap admin se baat kar rahe hain.*\n\n` +
      `Is waqt commands available nahi hain.\n` +
      `Seedha message karein — admin jawab denge.\n\n` +
      `_Admin conversation khatam karne ke baad sab normal ho jayega._`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});
    return; // next() call nahi — command process nahi hogi
  }

  // ── Text message → Admin ko relay karo ──
  if (msg.text) {
    logMessage(userId, 'user', msg.text);
    try {
      const kb = new InlineKeyboard()
        .text('🛑 Conversation Khatam Karo', 'endconvo_confirm');
      await bot.api.sendMessage(PRIMARY_ADMIN,
        `💬 *${escapeMarkdown(name)}* \\(${userId}\\):\n\n${escapeMarkdown(msg.text)}`,
        { parse_mode: 'Markdown', reply_markup: kb }
      );
    } catch (e) {
      console.error('[CONVO INTERCEPT] Relay failed:', e.message);
    }
    return; // next() call nahi — message handler nahi chalega
  }

  // ── Sticker relay ──
  if (msg.sticker) {
    logMessage(userId, 'user', '[Sticker]');
    try {
      await bot.api.forwardMessage(PRIMARY_ADMIN, ctx.chat.id, msg.message_id);
      await bot.api.sendMessage(PRIMARY_ADMIN,
        `💬 *${escapeMarkdown(name)}* \\(${userId}\\) ne sticker bheja ↑`,
        { parse_mode: 'Markdown' }
      );
    } catch {}
    return;
  }

  // ── Photo relay ──
  if (msg.photo) {
    logMessage(userId, 'user', '[Photo]' + (msg.caption ? `: ${msg.caption}` : ''));
    try {
      const bestPhoto = msg.photo[msg.photo.length - 1];
      await bot.api.sendPhoto(PRIMARY_ADMIN, bestPhoto.file_id, {
        caption: `💬 *${escapeMarkdown(name)}* \\(${userId}\\) ne photo bheja` +
                 (msg.caption ? `:\n"${escapeMarkdown(msg.caption)}"` : ''),
        parse_mode: 'Markdown'
      });
    } catch {}
    return;
  }

  // ── Voice relay ──
  if (msg.voice) {
    logMessage(userId, 'user', '[Voice message]');
    try {
      await bot.api.sendVoice(PRIMARY_ADMIN, msg.voice.file_id, {
        caption: `💬 *${escapeMarkdown(name)}* \\(${userId}\\) ka voice message ↑`,
        parse_mode: 'Markdown'
      });
    } catch {}
    return;
  }

  // ── Video relay ──
  if (msg.video) {
    logMessage(userId, 'user', '[Video]');
    try {
      await bot.api.forwardMessage(PRIMARY_ADMIN, ctx.chat.id, msg.message_id);
      await bot.api.sendMessage(PRIMARY_ADMIN,
        `💬 *${escapeMarkdown(name)}* \\(${userId}\\) ne video bheja ↑`,
        { parse_mode: 'Markdown' }
      );
    } catch {}
    return;
  }

  // ── Document relay ──
  if (msg.document) {
    logMessage(userId, 'user', `[Document: ${msg.document.file_name || 'file'}]`);
    try {
      await bot.api.forwardMessage(PRIMARY_ADMIN, ctx.chat.id, msg.message_id);
      await bot.api.sendMessage(PRIMARY_ADMIN,
        `💬 *${escapeMarkdown(name)}* \\(${userId}\\) ne document bheja ↑`,
        { parse_mode: 'Markdown' }
      );
    } catch {}
    return;
  }

  // ── Kuch aur — bas block karo ──
  return;
  // next() intentionally never called for convo target user
});

loadDB().then(() => console.log('📀 DB loaded'));

// ═══════════════════════════════════════
// 🛠️ UPLOAD FINISH HELPER
// ═══════════════════════════════════════
async function finishUpload(ctx, state) {
  const key = `m_${movieCounter}`;
  const newMovie = {
    id: key, shortId: movieCounter,
    file_id:  state.file_id,
    name:     state.name,
    year:     state.year,
    language: state.language,
    quality:  state.quality,
    size:     state.size || null,
    downloads: 0,
    added: new Date().toISOString()
  };
  movies[key] = newMovie;
  movieCounter++;
  await saveDB();
  adminUploadState.delete(ctx.from.id);

  // ── AUTO GENRE CACHE: Upload hote waqt hi genre fetch kar lo ──
  fetchGenreForMovie(newMovie).catch(() => {}); // fire-and-forget, error ignored

  const matchedRequesters = requests.filter(r =>
    (!r.status || r.status === 'Pending') &&
    (
      r.movie.toLowerCase().includes(state.name.toLowerCase()) ||
      state.name.toLowerCase().includes(r.movie.toLowerCase())
    )
  );

  let notifiedCount = 0;
  for (const req of matchedRequesters) {
    try {
      const dmCaption =
        `🎉 *Aapki Requested Movie Upload Ho Gayi!*\n\n` +
        `🎬 *${escapeMarkdown(state.name)}* (${state.year || '?'})\n` +
        `🌐 ${state.language || 'N/A'} | 📺 ${state.quality || 'N/A'}${state.size ? ' | ' + fmtSize(state.size) : ''}\n\n` +
        `✅ *Ab aap is movie ko download kar sakte hain!*\n\n` +
        `⚡ *3x Fast Download ke liye website par ek baar visit karein!*\n` +
        `⏱️ *Yeh message 3 minute mein delete ho jayega — forward & save karein.*`;

      const dmKb = new InlineKeyboard()
        .text(`⬇️ Download Karein`, `send_${key}`)
        .row()
        .url('⚡ 3x Fast Download ke liye Website Visit Karein', WEBSITE_URL)
        .row()
        .url('📷 Instagram (Optional)', INSTAGRAM_URL);

      await bot.api.sendVideo(req.user, newMovie.file_id, {
        caption: dmCaption,
        parse_mode: 'Markdown',
        reply_markup: dmKb
      });

      // Log bot message
      logMessage(req.user, 'bot', `[Auto-DM] Movie uploaded: ${state.name}`);

      req.status = 'Fulfilled';
      notifiedCount++;
    } catch (e) {
      console.error(`[NOTIFY] Could not send to user ${req.user}:`, e.message);
    }
    await new Promise(r => setTimeout(r, 300));
  }

  if (notifiedCount > 0) await saveRequests();

  const caption =
    `✅ *Movie Saved!*\n\n` +
    `🎬 ${escapeMarkdown(state.name)} (${state.year})\n` +
    `🌐 ${state.language} | 📺 ${state.quality}` +
    `${state.size ? ' | ' + fmtSize(state.size) : ''}\n` +
    `🆔 ID: \`${key}\`` +
    (notifiedCount > 0 ? `\n\n📨 *${notifiedCount} requester(s) ko file DM kar di gayi!*` : '');

  const kb = new InlineKeyboard()
    .text('📢 Post to Channel', `post_to_channel_${key}`)
    .text('❌ No', 'dismiss_post');

  return ctx.reply(caption, { parse_mode: 'Markdown', reply_markup: kb });
}

// ═══════════════════════════════════════
// 🟢 COMMANDS
// ═══════════════════════════════════════
bot.command('start', async ctx => {
  const userId   = ctx.from.id;
  const chatType = ctx.chat?.type; // 'private', 'group', 'supergroup', 'channel'

  trackUser(userId, ctx.from.first_name, ctx.from.username);

  // ── Group mein /start → DM karne ko kaho ──
  if (chatType !== 'private') {
    const kb = new InlineKeyboard()
      .url('🤖 Bot DM Mein Start Karein', `https://t.me/${BOT_USERNAME}?start=from_group`);
    return ctx.reply(
      `👋 *Namaste!*\n\nBot ko DM mein start karein taaki aap movies download kar sakein aur updates milti rahein!`,
      { parse_mode: 'Markdown', reply_markup: kb }
    ).catch(() => {});
  }

  // ── Private DM start ──
  const safeFirstName = escapeMarkdown(ctx.from.first_name);

  // Check if started from group referral
  const startParam = ctx.match; // text after /start
  const fromGroup  = startParam?.includes('from_group') || startParam?.includes('ref');

  if (fromGroup) {
    await ctx.reply(
      `✅ *Bot Successfully Start Ho Gaya!*\n\n` +
      `Ab aapko milega:\n` +
      `• 📢 Daily movie updates\n` +
      `• 🎬 Movie download notifications\n` +
      `• 🗳️ Debate results\n` +
      `• 📩 Request fulfillment DMs\n\n` +
      `Ab movie ka naam type karo ya /help dekho 👇`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});
  }

  await tempAnim(ctx, WELCOME_GIF, {
    caption:
      `🎬 *Welcome to CineRadar AI, ${safeFirstName}\\!*\n\n` +
      `🔍 Movie ka naam type karo \\(min 3 chars\\)\n` +
      `🎭 Mood type karo: happy, sad, action\\.\\.\\.\n` +
      `🎲 /random — Random movie\n` +
      `🗳️ /debate — Live movie vote\n\n` +
      `⏱️ Messages auto\\-delete in 3 min\\. Forward & save\\.\n` +
      `⚡ *3x Fast Download ke liye website visit karein\\!*`,
    parse_mode: 'MarkdownV2'
  });
});

bot.command('help', async ctx => {
  const helpText =
    `🎬 *CineRadar AI — Commands*\n\n` +
    `🔍 *Search:* Just type movie name (min 3 chars)\n` +
    `📺 *Filters:* Year / Language / Quality buttons appear after search\n` +
    `📩 *Request:* Button appears if movie not found\n\n` +
    `🎭 *Mood Search:* Type your mood and get instant suggestion!\n` +
    `   happy • sad • romantic • scary • funny • action • chill • mystery\n` +
    `   Ya emoji bhejo: 😄 😢 ❤️ 😱 😂 💥 😌 🔍\n\n` +
    `🎲 /random — Database se random movie\n` +
    `   Ya sirf "random" type karo\n` +
    `🗳️ /debate — Do movies ke beech live vote\n\n` +
    `🆕 /new — New Bollywood & South Indian releases\n` +
    `🔮 /upcoming — Upcoming Indian movies\n` +
    `📋 /myrequests — Track your requests\n\n` +
    `⚡ *3x Fast Download:* Website par ek baar visit karein\n\n` +
    `👑 *Admin only:* /edit, /stats, /broadcast, /delete, /ban, /unban\n` +
    `               /pending, /search, /dm, /history, /delhistory\n` +
    `               /convo, /endconvo\n` +
    `               /queue\\_add, /queue\\_view, /queue\\_clear`;
  await tempReply(ctx, helpText, { parse_mode: 'Markdown' });
});

bot.command('new', async ctx => {
  const loading = await ctx.reply('🔄 Fetching new Indian releases...');
  try {
    const moviesList = await getIndianMoviesByType('new', 5);
    await bot.api.deleteMessage(ctx.chat.id, loading.message_id).catch(() => {});
    if (!moviesList.length) return tempReply(ctx, '❌ No new Indian movies found.');
    for (const m of moviesList) {
      const caption =
        `🆕 *${escapeMarkdown(m.Title)}* (${m.Year})\n` +
        `⭐ IMDb: ${m.imdbRating || 'N/A'}\n` +
        `🎭 ${escapeMarkdown(m.Genre || '')}\n` +
        `📖 ${escapeMarkdown(m.Plot || '')}\n\n` +
        `⚡ *3x Fast Download ke liye website par ek baar visit karein!*`;
      const isUploaded = searchMovies(m.Title).length > 0;
      const kb = new InlineKeyboard();
      if (!isUploaded) {
        kb.text('📩 Request', `request_${encodeURIComponent(m.Title)}`).row();
      }
      kb.url('⚡ 3x Fast Download ke liye Website Visit Karein', WEBSITE_URL)
        .row()
        .url('📷 Instagram (Optional)', INSTAGRAM_URL);
      await tempPhoto(ctx, m.Poster, { caption, parse_mode: 'Markdown', reply_markup: kb });
      await new Promise(r => setTimeout(r, 500));
    }
  } catch (e) {
    await bot.api.deleteMessage(ctx.chat.id, loading.message_id).catch(() => {});
    await tempReply(ctx, '❌ Error fetching new movies.');
  }
});

bot.command('upcoming', async ctx => {
  const loading = await ctx.reply('🔄 Fetching upcoming Indian movies...');
  try {
    const moviesList = await getIndianMoviesByType('upcoming', 5);
    await bot.api.deleteMessage(ctx.chat.id, loading.message_id).catch(() => {});
    if (!moviesList.length) return tempReply(ctx, '❌ No upcoming Indian movies found.');
    for (const m of moviesList) {
      const caption =
        `🔮 *${escapeMarkdown(m.Title)}* (${m.Year})\n` +
        `⭐ IMDb: ${m.imdbRating || 'N/A'}\n` +
        `🎭 ${escapeMarkdown(m.Genre || '')}\n` +
        `📖 ${escapeMarkdown(m.Plot || '')}\n\n` +
        `⚡ *3x Fast Download ke liye website par ek baar visit karein!*`;
      const isUploaded2 = searchMovies(m.Title).length > 0;
      const kbUp = new InlineKeyboard();
      if (!isUploaded2) {
        kbUp.text('📩 Request', `request_${encodeURIComponent(m.Title)}`).row();
      }
      kbUp.url('⚡ 3x Fast Download ke liye Website Visit Karein', WEBSITE_URL)
        .row()
        .url('📷 Instagram (Optional)', INSTAGRAM_URL);
      await tempPhoto(ctx, m.Poster, { caption, parse_mode: 'Markdown', reply_markup: kbUp });
      await new Promise(r => setTimeout(r, 500));
    }
  } catch (e) {
    await bot.api.deleteMessage(ctx.chat.id, loading.message_id).catch(() => {});
    await tempReply(ctx, '❌ Error fetching upcoming movies.');
  }
});

bot.command('myrequests', async ctx => {
  const uid  = ctx.from.id;
  const reqs = requests.filter(r => r.user === uid);
  if (!reqs.length) return tempReply(ctx, "📭 You haven't requested any movies yet.");
  let txt = `📩 *Your Requests (${reqs.length})*\n\n`;
  reqs.slice(-10).forEach((r, i) => {
    txt += `${i + 1}. 🎬 ${escapeMarkdown(r.movie)}\n   ${r.status || 'Pending'} — ${new Date(r.time).toLocaleDateString()}\n`;
  });
  await tempReply(ctx, txt, { parse_mode: 'Markdown' });
});

// ═══════════════════════════════════════
// 🎲 /random — Database se random movie
// ═══════════════════════════════════════
bot.command('random', async ctx => {
  trackUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
  await sendRandomMovie(ctx);
});

async function sendRandomMovie(ctx, mood = null) {
  const list = Object.values(movies);
  if (!list.length) return tempReply(ctx, '❌ Database abhi empty hai. Koi movie available nahi.');

  let pool = list;
  let moodMatchInfo = '';

  if (mood && MOOD_MAP[mood]) {
    // ── Loading message dikhao kyunki OMDB calls thodi slow ho sakti hain ──
    const loadingMsg = await ctx.reply(
      `🔍 *${MOOD_MAP[mood].label} mood ke liye movies dhundh raha hoon...*\n_OMDB se genre verify ho raha hai_`,
      { parse_mode: 'Markdown' }
    ).catch(() => null);

    // Real OMDB genre-based filtering
    const matched = await filterMoviesByMood(list, mood);

    // Loading message delete karo
    if (loadingMsg) {
      bot.api.deleteMessage(ctx.chat?.id || ctx.callbackQuery?.message?.chat?.id, loadingMsg.message_id).catch(() => {});
    }

    if (matched.length > 0) {
      pool = matched;
      moodMatchInfo = `✅ ${matched.length} movies mili ${MOOD_MAP[mood].label} genre se`;
    } else {
      // Fallback — koi match nahi mila OMDB genre mein
      pool = list;
      moodMatchInfo = `⚠️ Exact genre match nahi mila — random de raha hoon`;
    }
  }

  const pick = pool[Math.floor(Math.random() * pool.length)];
  const moodLabel = mood ? ` — ${MOOD_MAP[mood].label}` : '';

  // Genre info from cache
  const cached = genreCache[pick.id];
  const genreLine = cached?.genre ? `🎭 ${escapeMarkdown(cached.genre)}\n` : '';
  const ratingLine = cached?.rating ? `⭐ IMDb: ${cached.rating}/10\n` : '';
  const plotLine = cached?.plot ? `\n📖 _${escapeMarkdown(cached.plot.slice(0, 120))}${cached.plot.length > 120 ? '...' : ''}_\n` : '';

  const caption =
    `🎲 *Random Pick${moodLabel}*\n\n` +
    `🎬 *${escapeMarkdown(pick.name)}* (${pick.year || '?'})\n` +
    genreLine +
    ratingLine +
    `🌐 ${pick.language || 'N/A'} | 📺 ${pick.quality || 'N/A'}${pick.size ? ' | ' + fmtSize(pick.size) : ''}` +
    plotLine + `\n` +
    (moodMatchInfo ? `_${escapeMarkdown(moodMatchInfo)}_\n\n` : '') +
    `⚡ *3x Fast Download ke liye website visit karein!*`;

  const kb = new InlineKeyboard()
    .text(`⬇️ Download`, `send_${pick.id}`)
    .text(`🎲 Aur Ek`, mood ? `rand_mood_${mood}` : 'rand_any')
    .row()
    .url('⚡ 3x Fast Download ke liye Website Visit Karein', WEBSITE_URL)
    .row()
    .url('📷 Instagram (Optional)', INSTAGRAM_URL);

  return tempReply(ctx, caption, { parse_mode: 'Markdown', reply_markup: kb });
}

// ═══════════════════════════════════════
// 🗳️ /debate — Do movies ke beech live vote
// ═══════════════════════════════════════
bot.command('debate', async ctx => {
  trackUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
  return startDebate(ctx);
});

// ── Debate core logic — reusable from command AND new_debate button ──
async function startDebate(ctx) {
  const list = Object.values(movies);
  if (list.length < 2) return tempReply(ctx, '❌ Debate ke liye kam se kam 2 movies chahiye database mein.');

  // Pick 2 different random movies
  const shuffled = [...list].sort(() => Math.random() - 0.5);
  const [m1, m2] = shuffled;
  const chatId = ctx.chat?.id;
  const DEBATE_DURATION = 60; // seconds

  const txt =
    `🗳️ *Movie Debate — Kaun Behtar Hai?*\n\n` +
    `1️⃣ *${escapeMarkdown(m1.name)}* (${m1.year || '?'}) — ${m1.language || 'N/A'} | ${m1.quality || 'N/A'}\n\n` +
    `vs\n\n` +
    `2️⃣ *${escapeMarkdown(m2.name)}* (${m2.year || '?'}) — ${m2.language || 'N/A'} | ${m2.quality || 'N/A'}\n\n` +
    `⏱️ *${DEBATE_DURATION} seconds mein vote karo!*\n` +
    `_Abhi tak: 0 votes_`;

  const kb = new InlineKeyboard()
    .text(`1️⃣ ${m1.name.slice(0, 22)}`, `debate_vote_1`)
    .text(`2️⃣ ${m2.name.slice(0, 22)}`, `debate_vote_2`);

  const sent = await ctx.reply(txt, { parse_mode: 'Markdown', reply_markup: kb });

  // Store poll
  debatePolls.set(chatId, {
    msgId: sent.message_id,
    movie1: m1,
    movie2: m2,
    votes: {},
    endTime: Date.now() + DEBATE_DURATION * 1000
  });

  // Auto-close after DEBATE_DURATION seconds
  setTimeout(() => closeDebate(ctx.api, chatId), DEBATE_DURATION * 1000);
}

async function closeDebate(api, chatId) {
  const poll = debatePolls.get(chatId);
  if (!poll) return;
  debatePolls.delete(chatId);

  const v1 = Object.values(poll.votes).filter(v => v === 1).length;
  const v2 = Object.values(poll.votes).filter(v => v === 2).length;
  const total = v1 + v2;

  const bar1 = total ? Math.round((v1 / total) * 10) : 0;
  const bar2 = total ? Math.round((v2 / total) * 10) : 0;

  let winner, winnerMovie;
  if (v1 > v2)       { winner = `1️⃣ *${escapeMarkdown(poll.movie1.name)}*`; winnerMovie = poll.movie1; }
  else if (v2 > v1)  { winner = `2️⃣ *${escapeMarkdown(poll.movie2.name)}*`; winnerMovie = poll.movie2; }
  else               { winner = '🤝 *Tie!* Dono barabar hain'; winnerMovie = null; }

  const resultText =
    `🗳️ *Debate Result!*\n\n` +
    `1️⃣ *${escapeMarkdown(poll.movie1.name)}*\n` +
    `${'🟩'.repeat(bar1)}${'⬜'.repeat(10 - bar1)} ${v1} votes\n\n` +
    `2️⃣ *${escapeMarkdown(poll.movie2.name)}*\n` +
    `${'🟦'.repeat(bar2)}${'⬜'.repeat(10 - bar2)} ${v2} votes\n\n` +
    `🏆 Winner: ${winner}\n` +
    `👥 Total votes: ${total}`;

  const kb = new InlineKeyboard();
  if (winnerMovie) {
    kb.text(`⬇️ ${winnerMovie.name.slice(0, 28)} Download`, `send_${winnerMovie.id}`).row();
  }
  kb.text('🗳️ Naya Debate', 'new_debate')
    .url('⚡ Website Visit Karein', WEBSITE_URL);

  try {
    await api.editMessageText(chatId, poll.msgId, resultText, {
      parse_mode: 'Markdown',
      reply_markup: kb
    });
  } catch (e) {
    console.error('[DEBATE] closeDebate edit failed:', e.message);
  }
}


bot.command('edit', async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ Admin only.');
  adminEditMode[ctx.from.id] = !adminEditMode[ctx.from.id];
  ctx.reply(`✏️ Edit mode ${adminEditMode[ctx.from.id] ? '✅ ON' : '❌ OFF'}`);
});

bot.command('stats', async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ Admin only.');
  const totalDL = Object.values(movies).reduce((s, m) => s + (m.downloads || 0), 0);
  const usersWithHistory = Object.keys(chatLogs).filter(uid => chatLogs[uid]?.length > 0).length;
  ctx.reply(
    `📊 *Bot Statistics*\n\n` +
    `🎬 Movies: ${Object.keys(movies).length}\n` +
    `👥 Users: ${Object.keys(users).length}\n` +
    `⬇️ Total Downloads: ${totalDL}\n` +
    `📩 Pending Requests: ${requests.filter(r => !r.status || r.status === 'Pending').length}\n` +
    `🚫 Banned: ${Object.keys(banned).length}\n` +
    `💬 Users with chat history: ${usersWithHistory}`,
    { parse_mode: 'Markdown' });
});

bot.command('broadcast', async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ Admin only.');
  const text = ctx.message.text.replace('/broadcast', '').trim();
  if (!text) return ctx.reply('Usage: /broadcast <message>');
  const ids = Object.keys(users);
  await ctx.reply(`📢 Sending to ${ids.length} users...`);
  let ok = 0, fail = 0;
  for (const uid of ids) {
    try {
      await ctx.api.sendMessage(uid, `📢 *Announcement*\n\n${escapeMarkdown(text)}`, { parse_mode: 'Markdown' });
      logMessage(uid, 'bot', `[Broadcast] ${text}`);
      ok++;
    } catch { fail++; }
    await new Promise(r => setTimeout(r, 50));
  }
  ctx.reply(`✅ Done — Success: ${ok} | Failed: ${fail}`);
});

bot.command('delete', async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ Admin only.');
  const id = ctx.message.text.replace('/delete', '').trim();
  if (!movies[id]) return ctx.reply('❌ Movie not found. Use /search to find IDs.');
  const name = movies[id].name;
  delete movies[id];
  await saveDB();
  ctx.reply(`✅ Deleted: ${escapeMarkdown(name)}`);
});

bot.command('ban', async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ Admin only.');
  const id = ctx.message.text.replace('/ban', '').trim();
  if (!id) return ctx.reply('Usage: /ban <userId>');
  banned[id] = true;
  await saveBanned();
  ctx.reply(`✅ Banned: ${id}`);
});

bot.command('unban', async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ Admin only.');
  const id = ctx.message.text.replace('/unban', '').trim();
  delete banned[id];
  await saveBanned();
  ctx.reply(`✅ Unbanned: ${id}`);
});

// ═══════════════════════════════════════
// 💬 /history — User ki full chat history (NEW)
// Usage: /history         → All users with history list
//        /history <userId> → Specific user ki history
// ═══════════════════════════════════════
bot.command('history', async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ Admin only.');

  const targetId = ctx.message.text.replace('/history', '').trim();

  // ── No userId → Show all users who have history ──
  if (!targetId) {
    const userIds = Object.keys(chatLogs).filter(uid => chatLogs[uid]?.length > 0);
    if (!userIds.length) return ctx.reply('📭 Abhi tak kisi user ki chat history nahi hai.');

    let txt = `📋 *Chat History — ${userIds.length} Users*\n\n`;

    const kb = new InlineKeyboard();
    userIds.slice(0, 30).forEach((uid, i) => {
      const info = users[uid];
      const name = info?.username
        ? `@${info.username}`
        : info?.first_name || `User ${uid}`;
      const count = chatLogs[uid]?.length || 0;
      const lastMsg = chatLogs[uid]?.[chatLogs[uid].length - 1];
      const lastTime = lastMsg ? new Date(lastMsg.time).toLocaleDateString('en-IN') : '';
      txt += `${i + 1}\\. 👤 ${escapeMarkdown(name)}\n   🆔 \`${uid}\` | 💬 ${count} msgs | 📅 ${lastTime}\n\n`;
      // Inline button to view that user's history
      kb.text(`👁️ ${name.slice(0, 18)} (${count})`, `hist_view_${uid}`).row();
    });

    txt += `\n💡 _/history <userId> se full history dekho_`;

    try {
      await ctx.reply(txt, { parse_mode: 'Markdown', reply_markup: kb });
    } catch {
      // Fallback plain
      let plain = `Chat History — ${userIds.length} Users\n\n`;
      userIds.slice(0, 30).forEach((uid, i) => {
        const info = users[uid];
        const name = info?.first_name || `User ${uid}`;
        plain += `${i + 1}. ${name} | ID: ${uid} | ${chatLogs[uid]?.length || 0} msgs\n`;
      });
      await ctx.reply(plain, { reply_markup: kb });
    }
    return;
  }

  // ── Specific userId → Show full chat history ──
  await showUserHistory(ctx, targetId);
});

// Helper: show paginated history for a specific user
async function showUserHistory(ctx, targetId) {
  const logs = chatLogs[String(targetId)];
  if (!logs || !logs.length) {
    return ctx.reply(`📭 User \`${targetId}\` ki koi chat history nahi hai.`, { parse_mode: 'Markdown' });
  }

  const info = users[String(targetId)];
  const name = info?.username
    ? `@${info.username}`
    : info?.first_name || `User ${targetId}`;

  const CHUNK = 15; // messages per page
  const totalPages = Math.ceil(logs.length / CHUNK);

  for (let page = 0; page < totalPages; page++) {
    const chunk = logs.slice(page * CHUNK, (page + 1) * CHUNK);

    let txt = '';
    if (page === 0) {
      txt += `💬 *Chat History — ${escapeMarkdown(name)}*\n`;
      txt += `🆔 \`${targetId}\` | 📊 Total: ${logs.length} messages\n`;
      txt += `─────────────────────\n\n`;
    } else {
      txt += `📄 *Page ${page + 1}/${totalPages}*\n\n`;
    }

    chunk.forEach(log => {
      const time = new Date(log.time).toLocaleString('en-IN', {
        day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
      });
      const icon = log.role === 'user' ? '👤' : '🤖';
      const label = log.role === 'user' ? 'User' : 'Bot';
      txt += `${icon} *${label}* \\[${escapeMarkdown(time)}\\]\n`;
      txt += `${escapeMarkdown(log.text.slice(0, 300))}\n\n`;
    });

    // Add delete + convo buttons on last page
    let kb = null;
    if (page === totalPages - 1) {
      kb = new InlineKeyboard()
        .text(`🗑️ Delete History`, `delh_${targetId}`)
        .text(`💬 Start Convo`, `startconvo_${targetId}`);
    }

    try {
      await ctx.reply(txt, {
        parse_mode: 'Markdown',
        ...(kb ? { reply_markup: kb } : {})
      });
    } catch (e) {
      // Fallback: plain text
      let plain = `Chat History — ${name} (${targetId})\n\n`;
      chunk.forEach(log => {
        const time = new Date(log.time).toLocaleString('en-IN');
        plain += `[${log.role === 'user' ? 'USER' : 'BOT'}] ${time}\n${log.text.slice(0, 300)}\n\n`;
      });
      await ctx.reply(plain, { ...(kb ? { reply_markup: kb } : {}) });
    }

    if (page < totalPages - 1) await new Promise(r => setTimeout(r, 400));
  }
}

// ═══════════════════════════════════════
// 🗑️ /delhistory — Specific user ki history delete karo (NEW)
// Usage: /delhistory <userId>
// ═══════════════════════════════════════
bot.command('delhistory', async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ Admin only.');
  const targetId = ctx.message.text.replace('/delhistory', '').trim();
  if (!targetId) {
    return ctx.reply(
      `🗑️ *Delete Chat History*\n\n` +
      `Usage: /delhistory <userId>\n\n` +
      `💡 /history se user IDs dekh sakte hain.`,
      { parse_mode: 'Markdown' }
    );
  }
  if (!chatLogs[String(targetId)] || chatLogs[String(targetId)].length === 0) {
    return ctx.reply(`❌ User \`${targetId}\` ki koi history nahi mili.`, { parse_mode: 'Markdown' });
  }

  const info = users[String(targetId)];
  const name = info?.username ? `@${info.username}` : info?.first_name || `User ${targetId}`;
  const count = chatLogs[String(targetId)].length;

  // Confirm before deleting
  const kb = new InlineKeyboard()
    .text(`✅ Haan, Delete Karo (${count} msgs)`, `delh_${targetId}`)
    .row()
    .text('❌ Cancel', 'noop');

  ctx.reply(
    `⚠️ *Confirm Delete?*\n\n` +
    `👤 User: ${escapeMarkdown(name)} \\(${targetId}\\)\n` +
    `📊 Messages: ${count}\n\n` +
    `_Yeh action undo nahi ho sakta_`,
    { parse_mode: 'Markdown', reply_markup: kb }
  );
});

// ═══════════════════════════════════════
// 💬 /convo — Admin ↔ User direct conversation relay (NEW)
// Usage: /convo <userId>   → Start relaying with that user
//        /convo            → Show current convo target
//        /endconvo         → Stop relay
// ═══════════════════════════════════════
bot.command('convo', async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ Admin only.');

  const targetId = ctx.message.text.replace('/convo', '').trim();

  if (!targetId) {
    if (adminConvoTarget) {
      const info = users[adminConvoTarget];
      const name = info?.username ? `@${info.username}` : info?.first_name || `User ${adminConvoTarget}`;
      const kb = new InlineKeyboard()
        .text('🛑 End Conversation', 'endconvo_confirm')
        .row()
        .text(`📋 History Dekhein`, `hist_view_${adminConvoTarget}`);
      return ctx.reply(
        `💬 *Active Conversation*\n\n` +
        `👤 User: ${escapeMarkdown(name)}\n` +
        `🆔 ID: \`${adminConvoTarget}\`\n\n` +
        `✅ Jo bhi message bhejenge seedha user ko jayega.\n` +
        `📩 User ke replies yahan forward ho rahe hain.\n\n` +
        `🛑 /endconvo se band karo`,
        { parse_mode: 'Markdown', reply_markup: kb }
      );
    }
    return ctx.reply(
      `💬 *Direct Conversation*\n\n` +
      `Usage: /convo <userId>\n\n` +
      `Is feature se aap directly kisi user se baat kar sakte ho:\n` +
      `• Aapke messages seedha us user ko jayenge\n` +
      `• User ke replies aapko forward honge\n\n` +
      `💡 /pending ya /history se user IDs dekho`,
      { parse_mode: 'Markdown' }
    );
  }

  if (isNaN(Number(targetId))) {
    return ctx.reply('❌ Valid userId dein (sirf numbers).');
  }

  const info = users[String(targetId)];
  const name = info?.username ? `@${info.username}` : info?.first_name || `User ${targetId}`;

  adminConvoTarget = String(targetId);

  const msgCount = chatLogs[String(targetId)]?.length || 0;

  await ctx.reply(
    `✅ *Conversation Started!*\n\n` +
    `👤 User: ${escapeMarkdown(name)}\n` +
    `🆔 ID: \`${targetId}\`\n` +
    `💬 Previous messages: ${msgCount}\n\n` +
    `📤 Ab jo bhi message bhejoge (commands ke ilawa), seedha is user ko jayega.\n` +
    `📩 User ke replies yahan real-time forward honge.\n\n` +
    `📋 /history ${targetId} — purani history dekhein\n` +
    `🛑 /endconvo — baat khatam karein`,
    { parse_mode: 'Markdown' }
  );

  // Notify user that admin wants to talk (optional but good UX)
  try {
    await bot.api.sendMessage(targetId,
      `📣 *CineRadar Admin aapse baat karna chahte hain.*\n\n` +
      `Aap seedha yahan reply kar sakte hain.`,
      { parse_mode: 'Markdown' }
    );
    logMessage(targetId, 'bot', '[System] Admin ne conversation start ki');
  } catch (e) {
    await ctx.reply(`⚠️ User ko notification nahi gayi (blocked/not started bot?)\nLekin aap message kar sakte hain.`);
  }
});

bot.command('endconvo', async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ Admin only.');
  if (!adminConvoTarget) return ctx.reply('❌ Koi active conversation nahi hai.');

  const prev = adminConvoTarget;
  const info = users[prev];
  const name = info?.username ? `@${info.username}` : info?.first_name || `User ${prev}`;
  adminConvoTarget = null;

  ctx.reply(
    `🛑 *Conversation Ended*\n\n` +
    `👤 User: ${escapeMarkdown(name)} (${prev})\n\n` +
    `💡 /history ${prev} se full conversation dekh sakte hain.`,
    { parse_mode: 'Markdown' }
  );
});

// ═══════════════════════════════════════
// 📩 /pending
// ═══════════════════════════════════════
bot.command('pending', async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ Admin only.');

  try {
    if (!Array.isArray(requests)) requests = [];

    const pend = [];
    for (let i = 0; i < requests.length; i++) {
      const r = requests[i];
      if (!r.status || r.status === 'Pending') {
        pend.push({ ...r, _origIdx: i });
      }
    }

    if (!pend.length) return ctx.reply('✅ No pending requests.');

    const chunkSize = 8;
    const totalPages = Math.ceil(pend.length / chunkSize);

    for (let page = 0; page < totalPages; page++) {
      const chunk = pend.slice(page * chunkSize, (page + 1) * chunkSize);
      const startIdx = page * chunkSize;

      let txt = page === 0
        ? `📩 *Pending Requests — ${pend.length} total*\n\n`
        : `📋 *Page ${page + 1}/${totalPages}*\n\n`;

      const kb = new InlineKeyboard();

      for (let i = 0; i < chunk.length; i++) {
        const r = chunk[i];
        const globalIdx = startIdx + i + 1;

        const movieName = r.movie || 'Unknown';
        const reqUserId = String(r.user || 'Unknown');
        const reqTime   = r.time ? new Date(r.time).toLocaleDateString('en-IN') : 'N/A';

        const userInfo  = users[reqUserId];
        const userName  = userInfo?.username
          ? `@${userInfo.username}`
          : userInfo?.first_name || 'Unknown';

        txt += `*${globalIdx}.* 🎬 ${movieName}\n`;
        txt += `   👤 ${userName}  |  🆔 \`${reqUserId}\`\n`;
        txt += `   📅 ${reqTime}\n\n`;

        kb.text(`✅ Fulfill #${globalIdx}: ${movieName.slice(0, 20)}`, `rdi_${r._origIdx}`).row();
      }

      try {
        await ctx.reply(txt, { parse_mode: 'Markdown', reply_markup: kb });
      } catch (e) {
        let plain = `Pending Requests (${pend.length} total)\n\n`;
        for (let i = 0; i < chunk.length; i++) {
          const r = chunk[i];
          const gIdx = startIdx + i + 1;
          const userInfo = users[String(r.user)];
          const uName = userInfo?.first_name || String(r.user);
          plain += `${gIdx}. ${r.movie || 'Unknown'}\n   ${uName} | ID: ${r.user} | ${r.time ? new Date(r.time).toLocaleDateString('en-IN') : 'N/A'}\n\n`;
        }
        await ctx.reply(plain, { reply_markup: kb });
      }

      if (page < totalPages - 1) await new Promise(r => setTimeout(r, 400));
    }
  } catch (e) {
    console.error('[/pending] Error:', e);
    ctx.reply(`❌ Error: ${e.message}`).catch(() => {});
  }
});

bot.command('search', async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ Admin only.');
  const q = ctx.message.text.replace('/search', '').trim();
  if (!q) return ctx.reply('Usage: /search <name>');
  const res = searchMovies(q);
  if (!res.length) return ctx.reply('❌ No results.');
  let txt = `🔍 *${res.length} result(s) for "${escapeMarkdown(q)}"*\n\n`;
  res.slice(0, 15).forEach(m => {
    txt += `\`${m.id}\` — ${escapeMarkdown(m.name)} (${m.year || '?'}) | ${m.language || '?'} | ${m.quality || '?'}${m.size ? ' | ' + fmtSize(m.size) : ''}\n`;
  });
  ctx.reply(txt, { parse_mode: 'Markdown' });
});

// ═══════════════════════════════════════
// 💬 /dm — Single user ko message bhejo
// ═══════════════════════════════════════
bot.command('dm', async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ Admin only.');

  const args = ctx.message.text.replace('/dm', '').trim();
  if (!args) {
    return ctx.reply(
      `📤 *Direct Message — Usage:*\n\n` +
      `/dm <userId> <message>\n\n` +
      `*Example:*\n` +
      `/dm 123456789 Aapki movie upload ho gayi! Download karein.\n\n` +
      `💡 *Tip:* /pending se user IDs dekh sakte hain.`,
      { parse_mode: 'Markdown' }
    );
  }

  const spaceIdx = args.indexOf(' ');
  if (spaceIdx === -1) {
    return ctx.reply('❌ Message likhna zaroori hai.\n\nUsage: /dm <userId> <message>');
  }

  const targetId  = args.slice(0, spaceIdx).trim();
  const dmMessage = args.slice(spaceIdx + 1).trim();

  if (!targetId || isNaN(Number(targetId))) {
    return ctx.reply('❌ Valid userId dein. (sirf numbers)');
  }
  if (!dmMessage) {
    return ctx.reply('❌ Message empty nahi ho sakta.');
  }

  try {
    const userInfo = users[targetId];
    const userLabel = userInfo?.username
      ? `@${userInfo.username}`
      : userInfo?.first_name
        ? userInfo.first_name
        : `User ${targetId}`;

    const sentMsg =
      `📣 *CineRadar AI — Admin Message*\n\n` +
      `${escapeMarkdown(dmMessage)}\n\n` +
      `— 👑 CineRadar Admin`;

    await bot.api.sendMessage(targetId, sentMsg, { parse_mode: 'Markdown' });
    logMessage(targetId, 'bot', `[/dm] ${dmMessage}`);

    return ctx.reply(
      `✅ *Message Successfully Bheja!*\n\n` +
      `👤 To: ${escapeMarkdown(userLabel)} \\(${targetId}\\)\n` +
      `📝 Message:\n_${escapeMarkdown(dmMessage)}_`,
      { parse_mode: 'Markdown' }
    );
  } catch (e) {
    console.error('[/dm] Error:', e.message);
    const reason = e.message?.includes('blocked')
      ? 'User ne bot ko block kar diya hai.'
      : e.message?.includes('not found')
        ? 'User not found ya usne bot start nahi kiya.'
        : e.message;
    return ctx.reply(`❌ Message bhej nahi paya.\n\n*Reason:* ${escapeMarkdown(reason)}`, { parse_mode: 'Markdown' });
  }
});

// ─── ADMIN: DAILY QUEUE MANAGEMENT ──────────────────────────
bot.command('queue_add', async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ Admin only.');
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 2) return ctx.reply('Usage: /queue_add new|upcoming <movie name>');
  const type = args[0].toLowerCase();
  if (type !== 'new' && type !== 'upcoming') return ctx.reply('Type must be "new" or "upcoming".');
  const movieName = args.slice(1).join(' ');

  const omdb = await fetchOMDb(movieName);
  if (!omdb || !omdb.Poster || omdb.Poster === 'N/A') {
    return ctx.reply('❌ Movie not found on OMDb.');
  }

  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  let entry = dailyQueue.find(e => e.date === tomorrow);
  if (!entry) {
    entry = { date: tomorrow, items: [] };
    dailyQueue.push(entry);
  }
  entry.items.push({ type, movieData: omdb });
  await saveDailyQueue();
  ctx.reply(`✅ "${omdb.Title}" added to ${type} queue for ${tomorrow}.`);
});

bot.command('queue_view', async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ Admin only.');
  if (dailyQueue.length === 0) return ctx.reply('📭 Queue is empty.');

  let text = '📋 *Daily Post Queue*\n\n';
  for (const entry of dailyQueue.sort((a, b) => a.date.localeCompare(b.date))) {
    text += `*${entry.date}*\n`;
    entry.items.forEach(item => {
      text += `  ${item.type === 'new' ? '🆕' : '🔮'} ${escapeMarkdown(item.movieData.Title)} (${item.movieData.Year})\n`;
    });
  }
  await ctx.reply(text, { parse_mode: 'Markdown' });
});

bot.command('queue_clear', async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ Admin only.');
  dailyQueue = [];
  await saveDailyQueue();
  ctx.reply('✅ Queue cleared.');
});

// ═══════════════════════════════════════
// 🎭 /cache_genres — Existing saari movies ka genre OMDB se fetch karo
// Admin use kare ek baar — future mood searches instant honge
// ═══════════════════════════════════════
bot.command('cache_genres', async ctx => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ Admin only.');

  const allMovies = Object.values(movies);
  const missing = allMovies.filter(m => !genreCache[m.id]?.genre);

  if (!missing.length) {
    return ctx.reply(
      `✅ *Genre Cache Complete!*\n\n` +
      `🎬 ${allMovies.length} movies — sab cached hain.\n` +
      `Mood search instant kaam karega!`,
      { parse_mode: 'Markdown' }
    );
  }

  const statusMsg = await ctx.reply(
    `⏳ *Genre Cache Shuru...*\n\n` +
    `📋 Total movies: ${allMovies.length}\n` +
    `🔍 Missing cache: ${missing.length}\n` +
    `⏱️ ~${Math.ceil(missing.length * 0.3)} seconds lagenge\n\n` +
    `_Ek baar ho gaya toh sab instant hoga_`,
    { parse_mode: 'Markdown' }
  );

  let done = 0, failed = 0;

  for (const movie of missing) {
    const genre = await fetchGenreForMovie(movie);
    if (genre) done++;
    else failed++;
    await new Promise(r => setTimeout(r, 300)); // rate limit

    // Progress update every 10 movies
    if ((done + failed) % 10 === 0) {
      bot.api.editMessageText(ctx.chat.id, statusMsg.message_id,
        `⏳ *Genre Cache Progress...*\n\n` +
        `✅ Done: ${done + failed}/${missing.length}\n` +
        `🎭 Found: ${done} | ❌ Not found: ${failed}`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
    }
  }

  await saveGenreCache();

  bot.api.editMessageText(ctx.chat.id, statusMsg.message_id,
    `✅ *Genre Cache Complete!*\n\n` +
    `🎬 Total movies: ${allMovies.length}\n` +
    `🎭 Genre cached: ${done}\n` +
    `❌ Not found on OMDB: ${failed}\n\n` +
    `Mood search ab ${MOOD_MAP ? Object.keys(MOOD_MAP).join(', ') : ''} genres se match karega!`,
    { parse_mode: 'Markdown' }
  ).catch(() => {});
});


bot.on('message:new_chat_members', async ctx => {
  const newMembers = ctx.message.new_chat_members;
  for (const member of newMembers) {
    if (member.id === ctx.me.id) continue;
    const firstName = escapeMarkdown(member.first_name);
    const welcomeMsg =
      `👋 Welcome ${firstName}\\!\n\n` +
      `🎬 *CineRadar AI* me aapka swagat hai\\.\n` +
      `📌 Movie paane ke liye bas movie ka naam type karein \\(minimum 3 letters\\)\\.\n` +
      `🔍 Example: *Krish*\n\n` +
      `💡 *Website visit karein daily 3x speed download ke liye\\!*\n\n` +
      `🔥 Enjoy HD Movies\\!`;
    try {
      await tempReply(ctx, welcomeMsg, { parse_mode: 'MarkdownV2' });
    } catch (e) {
      console.error('Group welcome error:', e.message);
    }
  }
});

bot.on('my_chat_member', async ctx => {
  const chatId    = ctx.chat.id;
  const newStatus = ctx.update.my_chat_member.new_chat_member.status;
  const oldStatus = ctx.update.my_chat_member.old_chat_member.status;

  if (newStatus === 'member' && oldStatus !== 'member') {
    const helpText =
      `🤖 *CineRadar AI is now active in this group\\!*\n\n` +
      `🎬 *Available Commands:*\n` +
      `• Type movie name \\(min 3 letters\\) — Search & download\n` +
      `• /new — New Bollywood & South releases\n` +
      `• /upcoming — Upcoming Indian movies\n` +
      `• /myrequests — Track your requests\n` +
      `• /help — Show this message\n\n` +
      `⚡ *3x Speed:* Visit ${WEBSITE_URL} daily to unlock fast downloads\n\n` +
      `📌 *This message is pinned for easy access\\.*\n` +
      `🔞 No 18\\+ content allowed\\.\n` +
      `👑 Admin: @cineradarai\\_admin`;
    try {
      const sent = await ctx.api.sendMessage(chatId, helpText, { parse_mode: 'MarkdownV2' });
      await ctx.api.pinChatMessage(chatId, sent.message_id).catch(() => {});
    } catch (e) {
      console.error('Bot added welcome/pin error:', e.message);
    }
  }
});

// ═══════════════════════════════════════
// 📨 MESSAGE HANDLER
// ═══════════════════════════════════════
bot.on('message', async (ctx, next) => {
  const msg     = ctx.message;
  const userId  = msg.from.id;
  const isAdmin = ADMIN_IDS.has(userId);

  trackUser(userId, msg.from.first_name, msg.from.username);

  // ══════════════════════════════════════════════════════
  // 🤖 BOT START NUDGE — Group users jo DM start nahi kiye
  // In users ko broadcast/DM nahi milta. Fix: unhe ek baar
  // "Start Bot" button dikhao taaki woh users[] mein properly
  // register ho jayein aur DMs milne lagein.
  // ══════════════════════════════════════════════════════
  const chatType = ctx.chat?.type;
  if (!isAdmin && chatType && chatType !== 'private') {
    const userRecord = users[String(userId)];
    const alreadyStarted = userRecord?.bot_started;
    const lastPrompt     = userRecord?.bot_start_prompted;
    // Sirf tab prompt karo: bot start nahi kiya AND (pehle prompt nahi diya ya 24 ghante se zyada ho gaye)
    const needsPrompt = !alreadyStarted && (
      !lastPrompt || (Date.now() - new Date(lastPrompt).getTime() > 24 * 60 * 60 * 1000)
    );
    if (needsPrompt) {
      const startKb = new InlineKeyboard()
        .url('🤖 Bot DM Mein Start Karein (Zaroori!)', `https://t.me/${BOT_USERNAME}?start=from_group`);
      ctx.reply(
        `👋 *${escapeMarkdown(msg.from.first_name)}*, bot ko DM mein ek baar start karo!\n\n` +
        `📩 Tabhi aapko movies, notifications aur downloads milenge.\n` +
        `⬇️ Neeche button dabao:`,
        { parse_mode: 'Markdown', reply_markup: startKb }
      ).catch(() => {});
      if (users[String(userId)]) {
        users[String(userId)].bot_start_prompted = new Date().toISOString();
        saveUsers();
      }
    }
  }

  // Mark user as bot_started when they message in private
  if (!isAdmin && chatType === 'private' && users[String(userId)] && !users[String(userId)].bot_started) {
    users[String(userId)].bot_started = true;
    saveUsers();
  }


  // If admin is in convo mode and sends a plain text message
  // (not a command), relay it to the target user
  // ══════════════════════════════════════════════════════
  if (isAdmin && adminConvoTarget && msg.text && !msg.text.startsWith('/')) {
    const targetUserId = adminConvoTarget;
    const info = users[targetUserId];
    const name = info?.username ? `@${info.username}` : info?.first_name || `User ${targetUserId}`;

    try {
      await bot.api.sendMessage(targetUserId,
        `📣 *CineRadar Admin:*\n\n${escapeMarkdown(msg.text)}`,
        { parse_mode: 'Markdown' }
      );
      logMessage(targetUserId, 'bot', `[Admin Convo] ${msg.text}`);

      // Confirm to admin
      await ctx.reply(
        `✅ *Bhej diya!*\n` +
        `👤 To: ${escapeMarkdown(name)} (${targetUserId})\n\n` +
        `_/endconvo se conversation band karein_`,
        { parse_mode: 'Markdown' }
      );
    } catch (e) {
      console.error('[CONVO RELAY] Admin→User failed:', e.message);
      const reason = e.message?.includes('blocked') ? 'User ne bot block kiya' :
                     e.message?.includes('not found') ? 'User not found' : e.message;
      await ctx.reply(`❌ Message nahi gaya: ${reason}`);
    }
    return; // Don't process as regular admin upload / search
  }

  // ─── Normal upload flow ───────────────────────────────────
  if (isAdmin && (msg.video || msg.document)) {
    const fileId   = msg.video?.file_id   || msg.document?.file_id;
    const fileSize = msg.video?.file_size  || msg.document?.file_size || null;
    adminUploadState.set(userId, { step: 'name', file_id: fileId, size: fileSize });
    return ctx.reply('✅ File received!\n\n📝 *Step 1/4:* Enter movie name:', { parse_mode: 'Markdown' });
  }

  const uploadState = isAdmin ? adminUploadState.get(userId) : null;
  if (uploadState && msg.text) {
    const text = sanitize(msg.text);
    if (!text) return;

    if (uploadState.step === 'name') {
      uploadState.name = text;
      uploadState.step = 'year';
      return ctx.reply('📅 *Step 2/4:* Release year (e.g. 2025):', { parse_mode: 'Markdown' });
    }
    if (uploadState.step === 'year') {
      uploadState.year = text;
      uploadState.step = 'language';
      const kb = new InlineKeyboard()
        .text('🇮🇳 Hindi',      'ul_lang_Hindi')
        .text('🇺🇸 English',    'ul_lang_English').row()
        .text('🎭 Dual Audio',  'ul_lang_Dual Audio')
        .text('🌍 Multi Audio', 'ul_lang_Multi Audio').row()
        .text('🎬 Telugu',      'ul_lang_Telugu')
        .text('🎬 Tamil',       'ul_lang_Tamil').row()
        .text('🎬 Malayalam',   'ul_lang_Malayalam')
        .text('🎬 Kannada',     'ul_lang_Kannada');
      return ctx.reply('🌐 *Step 3/4:* Select language:', { parse_mode: 'Markdown', reply_markup: kb });
    }
    if (uploadState.step === 'quality') {
      uploadState.quality = text;
      return finishUpload(ctx, uploadState);
    }
    return;
  }

  const editState = adminEditState[userId];
  if (editState?.step === 'enter_value' && msg.text) {
    const movie = movies[editState.movieId];
    if (!movie) { delete adminEditState[userId]; return; }
    const val = sanitize(msg.text);
    if (!val) return ctx.reply('❌ Cannot be empty.');
    if (editState.field === 'name') movie.name     = val;
    if (editState.field === 'year') movie.year     = val;
    if (editState.field === 'lang') movie.language = val;
    if (editState.field === 'qual') movie.quality  = val;
    if (editState.field === 'size') {
      const m = val.match(/^([\d.]+)\s*(MB|GB)$/i);
      if (!m) return ctx.reply('❌ Format: 1.5 GB or 700 MB');
      const n = parseFloat(m[1]);
      movie.size = Math.round(m[2].toUpperCase() === 'GB' ? n * 1024 * 1024 * 1024 : n * 1024 * 1024);
    }
    await saveDB();
    delete adminEditState[userId];
    return ctx.reply(`✅ Updated: *${escapeMarkdown(movie.name)}*`, { parse_mode: 'Markdown' });
  }

  if (!msg.text || msg.text.startsWith('/')) return next();
  if (msg.text.length < 3) return tempReply(ctx, '⚠️ Please enter at least 3 characters.');

  const rawQuery = sanitize(msg.text);

  // ── Log user search message ──
  if (!isAdmin) {
    logMessage(userId, 'user', rawQuery);
  }

  // ══════════════════════════════════════════════════════
  // 🎭 MOOD DETECTION — "happy", "sad", 😂 emoji etc.
  // ══════════════════════════════════════════════════════
  const detectedMood = detectMood(rawQuery);
  if (detectedMood) {
    const moodData = MOOD_MAP[detectedMood];
    await sendRandomMovie(ctx, detectedMood);
    // Also show mood keyboard for other moods (3 per row)
    const kb = new InlineKeyboard();
    const otherMoods = Object.entries(MOOD_MAP).filter(([mood]) => mood !== detectedMood);
    otherMoods.forEach(([mood, data], idx) => {
      kb.text(data.label, `mood_${mood}`);
      if ((idx + 1) % 3 === 0) kb.row();
    });
    kb.row();
    await tempReply(ctx,
      `${moodData.label} mood detect kiya! Aur moods try karo:`,
      { parse_mode: 'Markdown', reply_markup: kb }
    );
    return;
  }

  // ── "random" keyword ──
  if (rawQuery.toLowerCase().trim() === 'random' || rawQuery.toLowerCase().includes('random movie')) {
    return sendRandomMovie(ctx);
  }

  const { movieName: parsedName, year: parsedYear, language: parsedLang } = parseQuery(rawQuery);

  const query = parsedName.toLowerCase();
  userLastSearch.set(userId, query);

  if (users[userId]) {
    users[userId].search_count = (users[userId].search_count || 0) + 1;
    saveUsers();
  }

  const omdb = await fetchOMDb(parsedName);

  if (omdb && omdb.Poster && omdb.Poster !== 'N/A') {
    let caption = `🎬 *${escapeMarkdown(omdb.Title)}* (${omdb.Year})\n`;
    if (omdb.Genre      !== 'N/A') caption += `🎭 ${escapeMarkdown(omdb.Genre)}\n`;
    if (omdb.imdbRating !== 'N/A') caption += `⭐ IMDb: ${omdb.imdbRating}/10\n`;
    if (omdb.Director   !== 'N/A') caption += `🎥 ${escapeMarkdown(omdb.Director)}\n`;
    if (omdb.Plot       !== 'N/A') caption += `\n📖 ${escapeMarkdown(omdb.Plot)}\n`;

    let matches = searchMovies(parsedName);
    if (parsedYear) matches = matches.filter(m => String(m.year) === parsedYear);
    if (parsedLang) matches = matches.filter(m => (m.language || '').toLowerCase() === parsedLang.toLowerCase());

    if (matches.length > 0) {
      caption += `\n✅ *Available — ${matches.length} version(s)*`;
      caption += `\n\n⚡ *3x Fast Download chahiye? Neeche button dabao!*`;

      const kb = new InlineKeyboard();
      matches.forEach(m => {
        kb.text(movieBtnLabel(m), `send_${m.id}`).row();
        if (isAdmin && adminEditMode[userId]) {
          kb.text(`✏️ Edit "${m.name.slice(0, 20)}"`, `edit_${m.id}`).row();
        }
      });
      kb.url('⚡ 3x Fast Download ke liye Website Visit Karein', WEBSITE_URL).row();
      kb.url('📷 Instagram Follow Karein (Optional)', INSTAGRAM_URL);

      if (matches.length > 1) {
        const fkb = buildFilterKeyboard(parsedName, matches);
        return tempPhoto(ctx, omdb.Poster, { caption, parse_mode: 'Markdown', reply_markup: mergeKeyboards(kb, fkb) });
      }
      return tempPhoto(ctx, omdb.Poster, { caption, parse_mode: 'Markdown', reply_markup: kb });
    } else {
      const alreadyUploaded = searchMovies(omdb.Title).length > 0;
      if (alreadyUploaded) {
        caption += `\n✅ *Available!* Search karo exact naam se.`;
      } else {
        caption += `\n❌ *Not available yet.*\n📩 Request below — admin will upload!`;
      }
      const kb = new InlineKeyboard();
      if (!alreadyUploaded) {
        kb.text('📩 Request', `request_${encodeURIComponent(omdb.Title)}`).row();
      }
      kb.url('⚡ 3x Fast Download ke liye Website Visit Karein', WEBSITE_URL)
        .row()
        .url('📷 Instagram (Optional)', INSTAGRAM_URL);
      return tempPhoto(ctx, omdb.Poster, { caption, parse_mode: 'Markdown', reply_markup: kb });
    }
  }

  let results = searchMovies(parsedName);
  if (parsedYear) results = results.filter(m => String(m.year) === parsedYear);
  if (parsedLang) results = results.filter(m => (m.language || '').toLowerCase() === parsedLang.toLowerCase());

  if (results.length > 0) {
    let txt = `🎬 *Found ${results.length} result(s) for "${escapeMarkdown(sanitize(msg.text))}"*\n\n`;
    const grouped = groupMovies(results);
    grouped.forEach(g => { txt += `• *${escapeMarkdown(g.displayName)}* ${g.year || ''}\n`; });
    txt += `\n🔽 *Tap to download:*\n\n⚡ *3x Fast Download ke liye neeche website visit karein!*`;

    const kb = new InlineKeyboard();
    results.forEach(m => {
      kb.text(movieBtnLabel(m), `send_${m.id}`).row();
      if (isAdmin && adminEditMode[userId]) {
        kb.text(`✏️ Edit`, `edit_${m.id}`).row();
      }
    });
    kb.url('⚡ 3x Fast Download ke liye Website Visit Karein', WEBSITE_URL).row();
    kb.url('📷 Instagram Follow Karein (Optional)', INSTAGRAM_URL);

    if (results.length > 1) {
      const fkb = buildFilterKeyboard(parsedName, results);
      return tempReply(ctx, txt, { parse_mode: 'Markdown', reply_markup: mergeKeyboards(kb, fkb) });
    }
    return tempReply(ctx, txt, { parse_mode: 'Markdown', reply_markup: kb });
  }

  const suggestion = fuzzyMatch(parsedName);
  if (suggestion) {
    let sugResults = searchMovies(suggestion);
    if (parsedYear) sugResults = sugResults.filter(m => String(m.year) === parsedYear);
    if (parsedLang) sugResults = sugResults.filter(m => (m.language || '').toLowerCase() === parsedLang.toLowerCase());

    if (sugResults.length) {
      const kb = new InlineKeyboard();
      sugResults.forEach(m => kb.text(movieBtnLabel(m), `send_${m.id}`).row());
      kb.url('⚡ 3x Fast Download ke liye Website Visit Karein', WEBSITE_URL).row();
      kb.url('📷 Instagram (Optional)', INSTAGRAM_URL);
      return tempReply(ctx,
        `❓ *"${escapeMarkdown(sanitize(msg.text))}"* not found.\n\nDid you mean *${escapeMarkdown(suggestion)}*?`,
        { parse_mode: 'Markdown', reply_markup: kb });
    }
  }

  const omdbFallback = await fetchOMDb(parsedName);
  if (omdbFallback && omdbFallback.Poster && omdbFallback.Poster !== 'N/A') {
    let caption = `🎬 *${escapeMarkdown(omdbFallback.Title)}* (${omdbFallback.Year})\n`;
    if (omdbFallback.Plot !== 'N/A') caption += `\n📖 ${escapeMarkdown(omdbFallback.Plot)}\n`;
    const alreadyUploaded2 = searchMovies(omdbFallback.Title).length > 0;
    if (alreadyUploaded2) {
      caption += `\n✅ *Available!* Search karo exact naam se.`;
    } else {
      caption += `\n❌ *Not in our database yet.*\n📩 Request below!`;
    }
    const kb = new InlineKeyboard();
    if (!alreadyUploaded2) {
      kb.text('📩 Request', `request_${encodeURIComponent(omdbFallback.Title)}`).row();
    }
    kb.url('⚡ 3x Fast Download ke liye Website Visit Karein', WEBSITE_URL)
      .row()
      .url('📷 Instagram (Optional)', INSTAGRAM_URL);
    return tempPhoto(ctx, omdbFallback.Poster, { caption, parse_mode: 'Markdown', reply_markup: kb });
  }

  const alreadyUploaded3 = searchMovies(parsedName).length > 0;
  const kb = new InlineKeyboard();
  if (!alreadyUploaded3) {
    kb.text('📩 Request Movie', `request_${encodeURIComponent(parsedName)}`).row();
  }
  kb.url('⚡ 3x Fast Download ke liye Website Visit Karein', WEBSITE_URL)
    .row()
    .url('📷 Instagram (Optional)', INSTAGRAM_URL);
  return tempReply(ctx,
    alreadyUploaded3
      ? `✅ *"${escapeMarkdown(sanitize(msg.text))}"* available hai! Thoda alag naam se search karo.`
      : `❌ *"${escapeMarkdown(sanitize(msg.text))}"* not found.\n\nRequest it below!`,
    { parse_mode: 'Markdown', reply_markup: kb });
});

// ═══════════════════════════════════════
// 🔘 CALLBACK HANDLER
// ═══════════════════════════════════════
bot.on('callback_query:data', async ctx => {
  const data   = ctx.callbackQuery.data;
  const userId = ctx.from.id;
  const chatId = ctx.callbackQuery.message?.chat?.id;

  // ── 🗳️ Daily Debate vote (channel post) ──
  // ddebate_1_<movieId> and ddebate_2_<movieId>
  if (data.startsWith('ddebate_1_') || data.startsWith('ddebate_2_')) {
    const choice  = data.startsWith('ddebate_1_') ? 1 : 2;
    const movieId = data.startsWith('ddebate_1_') ? data.slice('ddebate_1_'.length) : data.slice('ddebate_2_'.length);
    const today   = new Date().toISOString().slice(0, 10);
    const pollKey = `daily_${today}`;
    const poll    = debatePolls.get(pollKey);

    if (!poll) {
      return ctx.answerCallbackQuery({ text: '⏰ Aaj ka debate khatam ya expired ho gaya!', show_alert: true });
    }

    const prevVote = poll.votes[userId];
    if (prevVote === choice) {
      return ctx.answerCallbackQuery({ text: '✅ Tumne pehle se yahi vote diya hai!', show_alert: false });
    }

    poll.votes[userId] = choice;

    const v1    = Object.values(poll.votes).filter(v => v === 1).length;
    const v2    = Object.values(poll.votes).filter(v => v === 2).length;
    const total = v1 + v2;
    const bar1  = total ? Math.round((v1 / total) * 10) : 0;
    const bar2  = total ? Math.round((v2 / total) * 10) : 0;

    // Update channel message with live vote counts
    const updatedTxt =
      `🗳️ *Aaj Ka Movie Debate!*\n\n` +
      `1️⃣ *${escapeMarkdown(poll.movie1.name)}* (${poll.movie1.year || '?'})\n` +
      `🌐 ${poll.movie1.language || 'N/A'} | 📺 ${poll.movie1.quality || 'N/A'}\n` +
      `${'🟩'.repeat(bar1)}${'⬜'.repeat(10 - bar1)} ${v1} votes\n\n` +
      `vs\n\n` +
      `2️⃣ *${escapeMarkdown(poll.movie2.name)}* (${poll.movie2.year || '?'})\n` +
      `🌐 ${poll.movie2.language || 'N/A'} | 📺 ${poll.movie2.quality || 'N/A'}\n` +
      `${'🟦'.repeat(bar2)}${'⬜'.repeat(10 - bar2)} ${v2} votes\n\n` +
      `👥 *Total votes: ${total}* | 📅 ${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long' })}\n` +
      `👇 *Vote karo — Kaun behtar hai?*`;

    const updatedKb = new InlineKeyboard()
      .text(`1️⃣ ${poll.movie1.name.slice(0, 22)} (${v1})`, `ddebate_1_${poll.movie1.id}`)
      .text(`2️⃣ ${poll.movie2.name.slice(0, 22)} (${v2})`, `ddebate_2_${poll.movie2.id}`)
      .row()
      .url('⚡ Website Visit Karein', WEBSITE_URL)
      .url(`🤖 Bot: @${BOT_USERNAME}`, `https://t.me/${BOT_USERNAME}`);

    try {
      await ctx.editMessageText(updatedTxt, { parse_mode: 'Markdown', reply_markup: updatedKb });
    } catch {}

    const votedName = choice === 1 ? poll.movie1.name : poll.movie2.name;
    return ctx.answerCallbackQuery({
      text: `${prevVote ? '🔄 Vote badal diya!' : '✅ Vote diya!'} — ${votedName.slice(0, 30)}`,
      show_alert: false
    });
  }

  // ── 🎲 Random movie callback ──
  if (data === 'rand_any') {
    await ctx.answerCallbackQuery({ text: '🎲 Naya random pick...' });
    return sendRandomMovie(ctx);
  }
  if (data.startsWith('rand_mood_')) {
    const mood = data.slice('rand_mood_'.length);
    await ctx.answerCallbackQuery({ text: `🎲 ${MOOD_MAP[mood]?.label || mood} random...` });
    return sendRandomMovie(ctx, mood);
  }

  // ── 🎭 Mood keyboard callback ──
  if (data.startsWith('mood_')) {
    const mood = data.slice('mood_'.length);
    if (!MOOD_MAP[mood]) return ctx.answerCallbackQuery({ text: '❌ Invalid mood' });
    await ctx.answerCallbackQuery({ text: `${MOOD_MAP[mood].label} movies dekh rahe hain...` });
    return sendRandomMovie(ctx, mood);
  }

  // ── 🗳️ Debate vote callback ──
  if (data === 'debate_vote_1' || data === 'debate_vote_2') {
    const chatId = ctx.callbackQuery.message?.chat?.id;
    const poll = debatePolls.get(chatId);

    if (!poll) return ctx.answerCallbackQuery({ text: '⏰ Vote time khatam ho gaya!', show_alert: true });
    if (Date.now() > poll.endTime) {
      debatePolls.delete(chatId);
      return ctx.answerCallbackQuery({ text: '⏰ Debate khatam ho gaya!', show_alert: true });
    }

    const choice = data === 'debate_vote_1' ? 1 : 2;
    const prevVote = poll.votes[userId];

    if (prevVote === choice) {
      return ctx.answerCallbackQuery({ text: '✅ Tumne pehle se yahi vote diya hai!', show_alert: false });
    }

    poll.votes[userId] = choice;

    const v1 = Object.values(poll.votes).filter(v => v === 1).length;
    const v2 = Object.values(poll.votes).filter(v => v === 2).length;
    const total = v1 + v2;
    const secsLeft = Math.max(0, Math.round((poll.endTime - Date.now()) / 1000));

    // Update message with live vote count
    const liveText =
      `🗳️ *Movie Debate — Kaun Behtar Hai?*\n\n` +
      `1️⃣ *${escapeMarkdown(poll.movie1.name)}* (${poll.movie1.year || '?'})\n\n` +
      `vs\n\n` +
      `2️⃣ *${escapeMarkdown(poll.movie2.name)}* (${poll.movie2.year || '?'})\n\n` +
      `📊 *Live Results:*\n` +
      `1️⃣ ${v1} votes  |  2️⃣ ${v2} votes\n` +
      `👥 Total: ${total} | ⏱️ ${secsLeft}s baaki`;

    const kb = new InlineKeyboard()
      .text(`1️⃣ ${poll.movie1.name.slice(0, 22)} (${v1})`, `debate_vote_1`)
      .text(`2️⃣ ${poll.movie2.name.slice(0, 22)} (${v2})`, `debate_vote_2`);

    try {
      await ctx.editMessageText(liveText, { parse_mode: 'Markdown', reply_markup: kb });
    } catch {}

    const movieName = choice === 1 ? poll.movie1.name : poll.movie2.name;
    return ctx.answerCallbackQuery({
      text: `${prevVote ? '🔄 Vote badal diya!' : '✅ Vote diya!'} — ${movieName.slice(0, 30)}`,
      show_alert: false
    });
  }

  // ── 🗳️ New debate (result screen ka button) ──
  if (data === 'new_debate') {
    await ctx.answerCallbackQuery({ text: '🗳️ Naya debate shuru ho raha hai!' });
    return startDebate(ctx); // Direct call — /debate text bhejne se command trigger nahi hota
  }

  // ── End convo confirm (from inline button) ── (NEW)
  if (data === 'endconvo_confirm') {
    if (!isAdmin(userId)) return ctx.answerCallbackQuery({ text: '❌ Admin only' });
    if (!adminConvoTarget) return ctx.answerCallbackQuery({ text: 'No active conversation', show_alert: true });
    const prev = adminConvoTarget;
    const info = users[prev];
    const name = info?.username ? `@${info.username}` : info?.first_name || `User ${prev}`;
    adminConvoTarget = null;
    try { await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }); } catch {}
    await ctx.reply(`🛑 Conversation ended with ${escapeMarkdown(name)} (${prev})`, { parse_mode: 'Markdown' });
    return ctx.answerCallbackQuery({ text: '🛑 Conversation ended' });
  }

  // ── View user history (from /history list button) ── (NEW)
  if (data.startsWith('hist_view_')) {
    if (!isAdmin(userId)) return ctx.answerCallbackQuery({ text: '❌ Admin only' });
    const targetId = data.slice('hist_view_'.length);
    await ctx.answerCallbackQuery({ text: '📋 Loading history...' });
    return showUserHistory(ctx, targetId);
  }

  // ── Delete user history (from inline button) ── (NEW)
  if (data.startsWith('delh_')) {
    if (!isAdmin(userId)) return ctx.answerCallbackQuery({ text: '❌ Admin only' });
    const targetId = data.slice('delh_'.length);
    const info = users[String(targetId)];
    const name = info?.username ? `@${info.username}` : info?.first_name || `User ${targetId}`;
    const count = chatLogs[String(targetId)]?.length || 0;

    if (!chatLogs[String(targetId)] || count === 0) {
      return ctx.answerCallbackQuery({ text: '❌ History already empty', show_alert: true });
    }

    delete chatLogs[String(targetId)];
    await saveChatLogs();

    try { await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard().text('✅ History Deleted', 'noop') }); } catch {}
    await ctx.reply(
      `✅ *History Deleted!*\n\n` +
      `👤 User: ${escapeMarkdown(name)} (${targetId})\n` +
      `🗑️ ${count} messages removed.`,
      { parse_mode: 'Markdown' }
    );
    return ctx.answerCallbackQuery({ text: `✅ ${count} messages deleted` });
  }

  // ── Start convo (from history view button) ── (NEW)
  if (data.startsWith('startconvo_')) {
    if (!isAdmin(userId)) return ctx.answerCallbackQuery({ text: '❌ Admin only' });
    const targetId = data.slice('startconvo_'.length);
    adminConvoTarget = String(targetId);
    const info = users[String(targetId)];
    const name = info?.username ? `@${info.username}` : info?.first_name || `User ${targetId}`;

    await ctx.reply(
      `✅ *Conversation Started!*\n\n` +
      `👤 User: ${escapeMarkdown(name)} (${targetId})\n\n` +
      `📤 Ab jo bhi message bhejoge, seedha user ko jayega.\n` +
      `🛑 /endconvo se band karein.`,
      { parse_mode: 'Markdown' }
    );

    try {
      await bot.api.sendMessage(targetId,
        `📣 *CineRadar Admin aapse baat karna chahte hain.*\n\nAap seedha yahan reply kar sakte hain.`,
        { parse_mode: 'Markdown' }
      );
      logMessage(targetId, 'bot', '[System] Admin ne conversation start ki');
    } catch {}

    return ctx.answerCallbackQuery({ text: '✅ Conversation started!' });
  }

  // ── Website visit confirmation ──
  if (data.startsWith('visit_done_')) {
    const movieId = data.slice('visit_done_'.length);
    markWebsiteVisited(userId);

    const m = movies[movieId];
    if (!m) {
      return ctx.answerCallbackQuery({ text: '✅ 3x Fast Download aaj ke liye active ho gayi!', show_alert: true });
    }

    const newKb = new InlineKeyboard()
      .url('🌐 Website', WEBSITE_URL).row()
      .url('📷 Instagram Follow Karein (Optional)', INSTAGRAM_URL);

    try {
      await ctx.editMessageReplyMarkup({ reply_markup: newKb });
    } catch {}

    return ctx.answerCallbackQuery({ text: '✅ 3x Fast Download aaj ke liye active ho gayi! 🚀' });
  }

  // ── Language selection during upload ──
  if (data.startsWith('ul_lang_')) {
    if (!isAdmin(userId)) return ctx.answerCallbackQuery({ text: '❌ Admin only' });
    const state = adminUploadState.get(userId);
    if (!state) return ctx.answerCallbackQuery({ text: '❌ No active upload session', show_alert: true });
    const lang = data.slice('ul_lang_'.length);
    state.language = lang;
    state.step = 'quality';
    await ctx.answerCallbackQuery({ text: `Language: ${lang}` });
    const kb = new InlineKeyboard()
      .text('360p', 'ul_qual_360p').text('480p', 'ul_qual_480p').row()
      .text('720p', 'ul_qual_720p').text('1080p', 'ul_qual_1080p').row()
      .text('4K UHD', 'ul_qual_4K').text('HDR', 'ul_qual_HDR');
    return ctx.reply('📺 *Step 4/4:* Select quality:', { parse_mode: 'Markdown', reply_markup: kb });
  }

  // ── Quality selection during upload ──
  if (data.startsWith('ul_qual_')) {
    if (!isAdmin(userId)) return ctx.answerCallbackQuery({ text: '❌ Admin only' });
    const state = adminUploadState.get(userId);
    if (!state) return ctx.answerCallbackQuery({ text: '❌ No active upload session', show_alert: true });
    state.quality = data.slice('ul_qual_'.length);
    await ctx.answerCallbackQuery({ text: `Quality: ${state.quality}` });
    return finishUpload(ctx, state);
  }

  // ── Send movie to user ──
  if (data.startsWith('send_')) {
    const movieId = data.slice('send_'.length);
    const m = movies[movieId];
    if (!m) return ctx.answerCallbackQuery({ text: '❌ Movie not found', show_alert: true });

    m.downloads = (m.downloads || 0) + 1;
    if (users[userId]) users[userId].downloads = (users[userId].downloads || 0) + 1;
    saveDB(); saveUsers();

    // Log download action
    logMessage(userId, 'bot', `[Download] ${m.name} (${m.year || '?'})`);

    const alreadyFast = hasVisitedWebsiteToday(userId);

    const caption =
      `🎬 *${escapeMarkdown(m.name)}* (${m.year || '?'})\n` +
      `🌐 ${m.language || 'N/A'} | 📺 ${m.quality || 'N/A'}${m.size ? ' | ' + fmtSize(m.size) : ''}\n\n` +
      (alreadyFast
        ? `⚡ *3x Fast Download active hai aaj ke liye!*\n`
        : `💡 *3x Fast Download chahiye? Neeche website visit karein ek baar!*\n`) +
      `⏱️ *Auto-deletes in 3 min — forward & save karein.*`;

    const kb = new InlineKeyboard();
    if (!alreadyFast) {
      kb.url('⚡ 3x Fast Download ke liye Website Visit Karein', WEBSITE_URL).row();
      kb.text('✅ Website Visit Kar Li', `visit_done_${movieId}`).row();
    } else {
      kb.url('🌐 Website', WEBSITE_URL).row();
    }
    kb.url('📷 Instagram Follow Karein (Optional)', INSTAGRAM_URL);

    try {
      const sent = await ctx.replyWithVideo(m.file_id, { caption, parse_mode: 'Markdown', reply_markup: kb });
      if (!isAdmin(userId) && chatId) {
        scheduleDelete(chatId, sent.message_id);
      }
      return ctx.answerCallbackQuery({ text: `📥 ${m.name} download ho rahi hai!` });
    } catch (e) {
      console.error('send_ error:', e.message);
      return ctx.answerCallbackQuery({ text: '❌ Error sending file.', show_alert: true });
    }
  }

  // ── Filter buttons ──
  if (data.startsWith('f|')) {
    const parts = data.split('|');
    if (parts.length < 4) return ctx.answerCallbackQuery();
    const [, shortQ, type, val] = parts;
    const fullQuery = userLastSearch.get(userId) || shortQ;

    let filters = {};
    if (type === 'lang') filters.language = val;
    if (type === 'qual') filters.quality  = val;
    if (type === 'year') filters.year     = val;

    const results = type === 'all' ? searchMovies(fullQuery) : searchMovies(fullQuery, filters);
    if (!results.length) return ctx.answerCallbackQuery({ text: 'No results', show_alert: true });

    const kb = new InlineKeyboard();
    results.forEach(m => {
      kb.text(movieBtnLabel(m), `send_${m.id}`).row();
      if (isAdmin(userId) && adminEditMode[userId]) {
        kb.text(`✏️ Edit`, `edit_${m.id}`).row();
      }
    });
    kb.url('⚡ 3x Fast Download ke liye Website Visit Karein', WEBSITE_URL).row();
    kb.url('📷 Instagram (Optional)', INSTAGRAM_URL);

    const fkb = buildFilterKeyboard(fullQuery, results);
    const merged = mergeKeyboards(kb, fkb);
    try { await ctx.editMessageReplyMarkup({ reply_markup: merged }); } catch {}
    return ctx.answerCallbackQuery({ text: `${results.length} result(s)` });
  }

  // ── Movie request ──
  if (data.startsWith('request_')) {
    const movieName = decodeURIComponent(data.slice('request_'.length));
    const already = requests.find(r =>
      r.user === userId &&
      r.movie.toLowerCase() === movieName.toLowerCase() &&
      (!r.status || r.status === 'Pending')
    );
    if (already) return ctx.answerCallbackQuery({ text: '⚠️ Already requested!', show_alert: true });

    requests.push({ user: userId, movie: movieName, time: new Date().toISOString(), status: 'Pending' });
    await saveRequests();
    logMessage(userId, 'user', `[Request] ${movieName}`);
    await tempReply(ctx, `✅ *Request sent for "${escapeMarkdown(movieName)}"!*\n\nUse /myrequests to track.`, { parse_mode: 'Markdown' });
    try {
      await bot.api.sendMessage(PRIMARY_ADMIN,
        `📩 *New Request*\n\n🎬 ${escapeMarkdown(movieName)}\n👤 User: ${userId}`,
        { parse_mode: 'Markdown' });
    } catch {}
    return ctx.answerCallbackQuery({ text: '✅ Request sent!' });
  }

  // ── Edit movie (admin) ──
  if (data.startsWith('edit_')) {
    if (!isAdmin(userId)) return ctx.answerCallbackQuery({ text: '❌ Admin only' });
    const mid = data.slice('edit_'.length);
    const m = movies[mid];
    if (!m) return ctx.answerCallbackQuery({ text: '❌ Not found' });
    adminEditState[userId] = { movieId: mid, step: 'choose_field' };
    const kb = new InlineKeyboard()
      .text('📝 Name',     'ef_name').text('📅 Year',    'ef_year').row()
      .text('🌐 Language', 'ef_lang').text('📺 Quality', 'ef_qual').row()
      .text('💾 Size',     'ef_size').text('❌ Cancel',  'ef_cancel');
    await ctx.reply(`✏️ Editing: *${escapeMarkdown(m.name)}*\nChoose field:`, { parse_mode: 'Markdown', reply_markup: kb });
    return ctx.answerCallbackQuery();
  }

  if (data.startsWith('ef_')) {
    if (!isAdmin(userId)) return ctx.answerCallbackQuery({ text: '❌ Admin only' });
    const field = data.slice('ef_'.length);
    if (field === 'cancel') {
      delete adminEditState[userId];
      await ctx.reply('❌ Cancelled.');
      return ctx.answerCallbackQuery();
    }
    adminEditState[userId].field = field;
    adminEditState[userId].step  = 'enter_value';
    const prompts = {
      name: '📝 Enter new name:',
      year: '📅 Enter new year:',
      lang: '🌐 Enter new language:',
      qual: '📺 Enter quality (e.g. 1080p):',
      size: '💾 Enter size (e.g. 1.5 GB or 700 MB):'
    };
    await ctx.reply(prompts[field] || 'Enter value:');
    return ctx.answerCallbackQuery();
  }

  // ── Mark request fulfilled — index-based ──
  if (data.startsWith('rdi_')) {
    if (!isAdmin(userId)) return ctx.answerCallbackQuery({ text: '❌ Admin only' });

    const origIdx = parseInt(data.slice('rdi_'.length));
    if (isNaN(origIdx) || origIdx < 0 || origIdx >= requests.length) {
      return ctx.answerCallbackQuery({ text: '❌ Request not found (may be deleted)', show_alert: true });
    }

    const req = requests[origIdx];
    if (!req) return ctx.answerCallbackQuery({ text: '❌ Request not found', show_alert: true });
    if (req.status === 'Fulfilled') {
      return ctx.answerCallbackQuery({ text: '⚠️ Already fulfilled!', show_alert: true });
    }

    const reqUser   = String(req.user);
    const movieName = req.movie;

    req.status = 'Fulfilled';
    await saveRequests();

    const matchedMovies = searchMovies(movieName);

    if (matchedMovies.length === 0) {
      try {
        await bot.api.sendMessage(reqUser,
          `📩 *Aapki Request Update!*\n\n` +
          `🎬 *${escapeMarkdown(movieName)}*\n\n` +
          `✅ Admin ne aapki request dekh li hai!\n` +
          `⏳ Movie jaldi upload hogi — please wait karein.\n\n` +
          `_/myrequests se status track kar sakte hain._`,
          { parse_mode: 'Markdown' }
        );
        logMessage(reqUser, 'bot', `[Request Update] ${movieName} - Admin dekh liya`);
        return ctx.answerCallbackQuery({ text: '✅ User ko notify kar diya (movie DB mein nahi hai abhi)' });
      } catch (e) {
        console.error('[rdi] notify failed:', e.message);
        return ctx.answerCallbackQuery({ text: '✅ Marked fulfilled (DM failed — user blocked bot?)' });
      }
    }

    const m = matchedMovies[0];
    try {
      const dmCaption =
        `🎉 *Aapki Requested Movie Ready Hai!*\n\n` +
        `🎬 *${escapeMarkdown(m.name)}* (${m.year || '?'})\n` +
        `🌐 ${m.language || 'N/A'} | 📺 ${m.quality || 'N/A'}${m.size ? ' | ' + fmtSize(m.size) : ''}\n\n` +
        `✅ *Ab aap is movie ko download kar sakte hain!*\n\n` +
        `⚡ *3x Fast Download ke liye website par ek baar visit karein!*\n` +
        `⏱️ *Forward & save kar lo — baad mein bhi kaam aayegi!*`;

      const dmKb = new InlineKeyboard()
        .text(`⬇️ Download Karein`, `send_${m.id}`)
        .row()
        .url('⚡ 3x Fast Download ke liye Website Visit Karein', WEBSITE_URL)
        .row()
        .url('📷 Instagram (Optional)', INSTAGRAM_URL);

      await bot.api.sendVideo(reqUser, m.file_id, {
        caption: dmCaption,
        parse_mode: 'Markdown',
        reply_markup: dmKb
      });

      logMessage(reqUser, 'bot', `[Request Fulfilled] ${m.name} video bheja`);

      await ctx.reply(
        `✅ *Request Fulfilled!*\n\n` +
        `🎬 ${escapeMarkdown(m.name)}\n` +
        `👤 User: ${reqUser}\n` +
        `📨 Video DM bhej di gayi!`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});

      return ctx.answerCallbackQuery({ text: `✅ ${m.name} — DM bhej di!` });
    } catch (e) {
      console.error('[rdi] DM failed:', e.message);
      const reason = e.message?.includes('blocked') ? 'User ne bot block kiya' :
                     e.message?.includes('chat not found') ? 'User ne bot start nahi kiya' :
                     e.message;
      await ctx.reply(`⚠️ Marked fulfilled, lekin DM nahi gayi.\nReason: ${reason}`).catch(() => {});
      return ctx.answerCallbackQuery({ text: '✅ Fulfilled (DM failed — check reply)', show_alert: true });
    }
  }

  // ── Legacy req_done_ handler ──
  if (data.startsWith('req_done_')) {
    if (!isAdmin(userId)) return ctx.answerCallbackQuery({ text: '❌ Admin only' });
    const rest      = data.slice('req_done_'.length);
    const uIdx      = rest.indexOf('_');
    const reqUser   = rest.slice(0, uIdx);
    const movieName = decodeURIComponent(rest.slice(uIdx + 1));
    const req = requests.find(r =>
      String(r.user) === String(reqUser) &&
      (!r.status || r.status === 'Pending') &&
      (r.movie === movieName || r.movie.toLowerCase().includes(movieName.toLowerCase().slice(0, 15)))
    );
    if (req) {
      req.status = 'Fulfilled';
      await saveRequests();
      const matchedMovies = searchMovies(req.movie);
      if (matchedMovies.length > 0) {
        const m = matchedMovies[0];
        try {
          const dmKb = new InlineKeyboard()
            .text(`⬇️ Download Karein`, `send_${m.id}`).row()
            .url('⚡ Website Visit Karein', WEBSITE_URL).row()
            .url('📷 Instagram', INSTAGRAM_URL);
          await bot.api.sendVideo(reqUser, m.file_id, {
            caption: `🎉 *${escapeMarkdown(m.name)}* ready hai!\n\n✅ Ab download kar sakte hain!`,
            parse_mode: 'Markdown',
            reply_markup: dmKb
          });
          logMessage(reqUser, 'bot', `[Legacy Request Fulfilled] ${m.name}`);
          return ctx.answerCallbackQuery({ text: '✅ DM bhej di!' });
        } catch (e) {
          return ctx.answerCallbackQuery({ text: '✅ Fulfilled (DM failed)' });
        }
      }
    }
    return ctx.answerCallbackQuery({ text: '✅ Marked fulfilled' });
  }

  // ── Post to channel (admin) ──
  if (data.startsWith('post_to_channel_')) {
    if (!isAdmin(userId)) return ctx.answerCallbackQuery({ text: '❌ Admin only' });
    const movieId = data.slice('post_to_channel_'.length);
    const m = movies[movieId];
    if (!m) return ctx.answerCallbackQuery({ text: '❌ Movie not found' });

    try {
      await bot.api.sendVideo(CHANNEL, m.file_id, {
        caption:
          `🎬 *New Movie Added!*\n\n` +
          `${escapeMarkdown(m.name)} (${m.year || '?'})\n` +
          `🌐 ${m.language || 'N/A'} | 📺 ${m.quality || 'N/A'}${m.size ? ' | ' + fmtSize(m.size) : ''}\n\n` +
          `📥 Use the bot to download!\n` +
          `⚡ *3x Fast Download ke liye website par ek baar visit karein!*`,
        parse_mode: 'Markdown'
      });
      await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard().text('✅ Posted to Channel', 'noop') });
      return ctx.answerCallbackQuery({ text: '✅ Posted to channel!' });
    } catch (e) {
      console.error('post_to_channel error:', e.message);
      return ctx.answerCallbackQuery({ text: '❌ Failed to post.', show_alert: true });
    }
  }

  if (data === 'dismiss_post' || data === 'noop' || data === 'done') {
    try { await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }); } catch {}
    return ctx.answerCallbackQuery();
  }

  return ctx.answerCallbackQuery();
});

// ═══════════════════════════════════════
// 📅 DAILY AUTO POST
// ═══════════════════════════════════════
const DAILY_FILE = 'lastDailySent.json';

// ── Daily Guide Text ──────────────────────────────────────
function getDailyGuideText(date) {
  const day = new Date(date).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });
  return (
    `📖 *CineRadar AI — Daily Guide*\n` +
    `📅 ${day}\n` +
    `${'─'.repeat(28)}\n\n` +
    `🎬 *Movie Kaise Dhundein?*\n` +
    `Sirf movie ka naam type karo bot mein\n` +
    `Example: _Pathaan_, _KGF_, _RRR_\n\n` +
    `🎭 *Mood Se Movie:*\n` +
    `Type karo: \`happy\` \`sad\` \`action\` \`scary\`\n` +
    `\`romantic\` \`funny\` \`chill\` \`mystery\`\n` +
    `Ya emoji bhejo: 😄 😢 💥 😱 ❤️ 😂 😌 🔍\n\n` +
    `🎲 *Random Movie:* /random\n` +
    `🗳️ *Daily Debate:* /debate\n` +
    `📩 *Movie Request:* Search karo → Request button\n` +
    `📋 *My Requests:* /myrequests\n\n` +
    `${'─'.repeat(28)}\n` +
    `⚡ *3x Fast Download:*\n` +
    `Website ek baar visit karo → 3x speed milegi\n` +
    `🔗 ${WEBSITE_URL}\n\n` +
    `📢 *Channel:* @${CHANNEL_USERNAME}\n` +
    `💬 *Bot:* @${BOT_USERNAME}`
  );
}

async function sendDailySuggestions() {
  try {
    let lastDate = '';
    try { lastDate = (await fs.readFile(DAILY_FILE, 'utf8')).trim(); } catch {}
    const today = new Date().toISOString().slice(0, 10);

    if (lastDate === today) {
      console.log('[DAILY] Already sent today.');
      return;
    }

    console.log('[DAILY] Sending daily post...');

    const todayQueue = dailyQueue.find(entry => entry.date === today);
    let newMoviesList      = [];
    let upcomingMoviesList = [];

    if (todayQueue && todayQueue.items.length > 0) {
      console.log('[DAILY] Using admin queue for today.');
      newMoviesList      = todayQueue.items.filter(i => i.type === 'new').map(i => i.movieData);
      upcomingMoviesList = todayQueue.items.filter(i => i.type === 'upcoming').map(i => i.movieData);
    } else {
      console.log('[DAILY] No queue found, fetching automatically...');
      try { newMoviesList      = await getIndianMoviesByType('new', 3);      } catch (e) { console.error('[DAILY] New fetch error:', e); }
      try { upcomingMoviesList = await getIndianMoviesByType('upcoming', 2); } catch (e) { console.error('[DAILY] Upcoming fetch error:', e); }
    }

    // ── 1. New releases ──
    for (const m of newMoviesList) {
      if (!m.Poster || m.Poster === 'N/A') continue;
      await bot.api.sendPhoto(CHANNEL, m.Poster, {
        caption:
          `🆕 *New Indian Release!*\n\n` +
          `🎬 ${escapeMarkdown(m.Title)} (${m.Year})\n` +
          `⭐ IMDb: ${m.imdbRating || 'N/A'}\n` +
          `📖 ${escapeMarkdown(m.Plot || '')}\n\n` +
          `📥 Bot mein search karo!\n` +
          `⚡ *3x Fast Download ke liye website visit karein!*`,
        parse_mode: 'Markdown'
      }).catch(e => console.error('[DAILY] sendPhoto new error:', e.message));
      await new Promise(r => setTimeout(r, 1000));
    }

    // ── 2. Upcoming movies ──
    for (const m of upcomingMoviesList) {
      if (!m.Poster || m.Poster === 'N/A') continue;
      await bot.api.sendPhoto(CHANNEL, m.Poster, {
        caption:
          `🔮 *Upcoming Indian Movie!*\n\n` +
          `🎬 ${escapeMarkdown(m.Title)} (${m.Year})\n` +
          `⭐ IMDb: ${m.imdbRating || 'N/A'}\n` +
          `📖 ${escapeMarkdown(m.Plot || '')}\n\n` +
          `📥 Bot mein search karo!\n` +
          `⚡ *3x Fast Download ke liye website visit karein!*`,
        parse_mode: 'Markdown'
      }).catch(e => console.error('[DAILY] sendPhoto upcoming error:', e.message));
      await new Promise(r => setTimeout(r, 1000));
    }

    // ── 3. Daily movie suggestions ──
    const list = Object.values(movies);
    if (list.length) {
      const shuffled = [...list].sort(() => Math.random() - 0.5);
      const selected = shuffled.slice(0, Math.min(5, list.length));
      for (const m of selected) {
        await bot.api.sendVideo(CHANNEL, m.file_id, {
          caption:
            `🎬 *Today's Suggestion*\n\n` +
            `${escapeMarkdown(m.name)} (${m.year || '?'})\n` +
            `🌐 ${m.language || 'N/A'} | 📺 ${m.quality || 'N/A'}${m.size ? ' | ' + fmtSize(m.size) : ''}\n\n` +
            `📥 Bot se download karo!\n` +
            `⚡ *3x Fast Download ke liye website visit karein!*`,
          parse_mode: 'Markdown'
        }).catch(e => console.error('[DAILY] sendVideo error:', e.message));
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    // ── 4. Daily Debate — permanent, pinned at bottom ──
    if (list.length >= 2) {
      try {
        const shuffledDebate = [...list].sort(() => Math.random() - 0.5);
        const [dm1, dm2] = shuffledDebate;
        const DEBATE_DURATION = 24 * 60 * 60; // 24 hours for daily debate

        const debateTxt =
          `🗳️ *Aaj Ka Movie Debate!*\n\n` +
          `1️⃣ *${escapeMarkdown(dm1.name)}* (${dm1.year || '?'})\n` +
          `🌐 ${dm1.language || 'N/A'} | 📺 ${dm1.quality || 'N/A'}\n\n` +
          `vs\n\n` +
          `2️⃣ *${escapeMarkdown(dm2.name)}* (${dm2.year || '?'})\n` +
          `🌐 ${dm2.language || 'N/A'} | 📺 ${dm2.quality || 'N/A'}\n\n` +
          `👇 *Vote karo — Kaun behtar hai?*\n` +
          `📅 ${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long' })}`;

        const debateKb = new InlineKeyboard()
          .text(`1️⃣ ${dm1.name.slice(0, 25)}`, `ddebate_1_${dm1.id}`)
          .text(`2️⃣ ${dm2.name.slice(0, 25)}`, `ddebate_2_${dm2.id}`)
          .row()
          .url('⚡ Website Visit Karein', WEBSITE_URL)
          .url(`🤖 Bot: @${BOT_USERNAME}`, `https://t.me/${BOT_USERNAME}`);

        const debateSent = await bot.api.sendMessage(CHANNEL, debateTxt, {
          parse_mode: 'Markdown',
          reply_markup: debateKb
        });

        // Pin the debate post so it stays at bottom / visible
        await bot.api.pinChatMessage(CHANNEL, debateSent.message_id, {
          disable_notification: true // silent pin — no notification spam
        }).catch(e => console.error('[DAILY] Pin debate failed:', e.message));

        // Store daily debate poll (24h)
        debatePolls.set(`daily_${today}`, {
          msgId: debateSent.message_id,
          chatId: CHANNEL,
          movie1: dm1,
          movie2: dm2,
          votes: {},
          isDaily: true,
          endTime: Date.now() + DEBATE_DURATION * 1000
        });

        console.log('[DAILY] ✅ Debate posted & pinned');
      } catch (e) {
        console.error('[DAILY] Debate post error:', e.message);
      }
    }

    // ── 5. Daily Guide — bot usage guide, pinned at very bottom ──
    try {
      const guideKb = new InlineKeyboard()
        .url(`🤖 Bot Start Karein`, `https://t.me/${BOT_USERNAME}?start=guide`)
        .row()
        .url('⚡ 3x Fast Download Website', WEBSITE_URL)
        .row()
        .url('📷 Instagram Follow Karein', INSTAGRAM_URL);

      const guideSent = await bot.api.sendMessage(CHANNEL, getDailyGuideText(today), {
        parse_mode: 'Markdown',
        reply_markup: guideKb
      });

      // Pin guide AFTER debate — it becomes the bottommost pinned message
      await bot.api.pinChatMessage(CHANNEL, guideSent.message_id, {
        disable_notification: true
      }).catch(e => console.error('[DAILY] Pin guide failed:', e.message));

      console.log('[DAILY] ✅ Guide posted & pinned');
    } catch (e) {
      console.error('[DAILY] Guide post error:', e.message);
    }

    // ── 6. Broadcast to all users — "new posts available" notification ──
    const allUserIds = Object.keys(users);
    let broadcastOk = 0, broadcastFail = 0;
    const broadcastMsg =
      `🎬 *CineRadar AI — Aaj Ki Updates!*\n\n` +
      `✅ Naye movies suggest kiye gaye\n` +
      `🗳️ Aaj ka debate shuru ho gaya\n` +
      `📖 Daily guide available hai\n\n` +
      `👉 Channel dekho: @${CHANNEL_USERNAME}\n` +
      `🤖 Bot use karo: @${BOT_USERNAME}\n\n` +
      `⚡ *3x Fast Download:* ${WEBSITE_URL}`;

    for (const uid of allUserIds) {
      try {
        await bot.api.sendMessage(uid, broadcastMsg, { parse_mode: 'Markdown' });
        broadcastOk++;
      } catch {
        broadcastFail++;
      }
      await new Promise(r => setTimeout(r, 60)); // rate limit
    }
    console.log(`[DAILY] Broadcast: ✅ ${broadcastOk} | ❌ ${broadcastFail}`);

    await fs.writeFile(DAILY_FILE, today);
    console.log('[DAILY] ✅ All daily posts completed for', today);
  } catch (e) { console.error('[DAILY] Fatal error:', e); }
}

setInterval(() => {
  sendDailySuggestions().catch(e => console.error('[DAILY] Interval error:', e));
}, 60 * 60 * 1000);

setTimeout(() => {
  sendDailySuggestions().catch(e => console.error('[DAILY] Startup error:', e));
}, 5000);

// ═══════════════════════════════════════
// 🔄 AUTO GIT PUSH
// ═══════════════════════════════════════
function gitPush() {
  exec(
    'git pull --rebase origin main && git add . && git diff --cached --quiet || (git commit -m "auto update [skip ci]" && git push)',
    (err, stdout, stderr) => {
      if (err) console.error('[GIT]', stderr);
      else if (stdout) console.log('[GIT] ✅ Synced');
    }
  );
}
setInterval(gitPush, 60000);

// ═══════════════════════════════════════
// 🛑 GLOBAL ERROR HANDLER
// ═══════════════════════════════════════
bot.catch(err => {
  console.error('❌ Bot error:', err.error?.message || err);
});

// ═══════════════════════════════════════
// 🟢 START
// ═══════════════════════════════════════
bot.start({
  drop_pending_updates: true,
  onStart: info => console.log(`🚀 @${info.username} running — grammY`)
});

