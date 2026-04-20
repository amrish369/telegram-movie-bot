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
const ADMIN_ID     = Number(process.env.ADMIN_ID) || 5951923988;
const CHANNEL      = process.env.CHANNEL || '@cineradarai';
const AUTO_DELETE  = 3 * 60 * 1000;
const WELCOME_GIF  = 'https://media.tenor.com/8d9B7xYkZk0AAAAC/welcome.gif';
const OMDB_BASE    = 'https://www.omdbapi.com/';
const WEBSITE_URL  = 'https://www.compressdocument.in/';
const INSTAGRAM_URL = 'https://www.instagram.com/_www.compressdocument.in?igsh=MzNtdGVoeHp3YWhq';

if (!BOT_TOKEN)    throw new Error('❌ BOT_TOKEN missing in .env');
if (!OMDB_API_KEY) throw new Error('❌ OMDB_API_KEY missing in .env');

// ═══════════════════════════════════════
// 📁 IN-MEMORY DATABASE
// ═══════════════════════════════════════
let movies   = {};
let requests = [];
let users    = {};
let banned   = {};

const adminUploadState = new Map(); // userId -> upload state
let adminEditState = {}; // userId -> edit state
let adminEditMode  = {}; // userId -> boolean
let movieCounter   = 1;

const userLastSearch = new Map();

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
  if (ctx.from?.id === ADMIN_ID) {
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
  if (ctx.from?.id === ADMIN_ID) {
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
  if (ctx.from?.id === ADMIN_ID) {
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
// 🧹 Global auto-delete for non-admin user messages (3 minutes)
// ═══════════════════════════════════════
bot.use(async (ctx, next) => {
  await next();

  const msg = ctx.message;
  if (!msg) return;

  const userId = ctx.from?.id;
  if (!userId || userId === ADMIN_ID) return;

  setTimeout(() => {
    bot.api.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {});
  }, AUTO_DELETE);
});

bot.use(rateLimit);
bot.use(banCheck);

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

  // ── AUTO-NOTIFY: Find pending requesters for this movie ──
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

      req.status = 'Fulfilled';
      notifiedCount++;
    } catch (e) {
      console.error(`[NOTIFY] Could not send to user ${req.user}:`, e.message);
    }
    await new Promise(r => setTimeout(r, 300));
  }

  if (notifiedCount > 0) await saveRequests();

  // ── Admin confirmation ──
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
  trackUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
  const safeFirstName = escapeMarkdown(ctx.from.first_name);
  await tempAnim(ctx, WELCOME_GIF, {
    caption: `🎬 *Welcome to CineRadar AI, ${safeFirstName}\\!*\n\n🔍 Type movie name \\(min 3 chars\\) to search\\.\n⏱️ Messages auto\\-delete in 3 minutes\\. Forward and save\\.\n⚡ *3x Fast Download ke liye website par ek baar visit karein\\!*`,
    parse_mode: 'MarkdownV2'
  });
});

bot.command('help', async ctx => {
  const helpText =
    `🎬 *CineRadar AI — Commands*\n\n` +
    `🔍 *Search:* Just type movie name (min 3 chars)\n` +
    `📺 *Filters:* Year / Language / Quality buttons appear after search\n` +
    `📩 *Request:* Button appears if movie not found\n\n` +
    `🆕 /new — New Bollywood & South Indian releases\n` +
    `🔮 /upcoming — Upcoming Indian movies\n` +
    `📋 /myrequests — Track your requests\n\n` +
    `⚡ *3x Fast Download:* Website par ek baar visit karein — normal download seedha milega, fast chahiye toh visit karein\n\n` +
    `👑 *Admin only:* /edit, /stats, /broadcast, /delete, /ban, /unban, /pending, /search\n` +
    `               /queue\\_add, /queue\\_view, /queue\\_clear\n` +
    `               /dm <userId> <message>`;
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

// ─── ADMIN COMMANDS ──────────────────────────────────────────
bot.command('edit', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('❌ Admin only.');
  adminEditMode[ctx.from.id] = !adminEditMode[ctx.from.id];
  ctx.reply(`✏️ Edit mode ${adminEditMode[ctx.from.id] ? '✅ ON' : '❌ OFF'}`);
});

bot.command('stats', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('❌ Admin only.');
  const totalDL = Object.values(movies).reduce((s, m) => s + (m.downloads || 0), 0);
  ctx.reply(
    `📊 *Bot Statistics*\n\n` +
    `🎬 Movies: ${Object.keys(movies).length}\n` +
    `👥 Users: ${Object.keys(users).length}\n` +
    `⬇️ Total Downloads: ${totalDL}\n` +
    `📩 Pending Requests: ${requests.filter(r => !r.status || r.status === 'Pending').length}\n` +
    `🚫 Banned: ${Object.keys(banned).length}`,
    { parse_mode: 'Markdown' });
});

bot.command('broadcast', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('❌ Admin only.');
  const text = ctx.message.text.replace('/broadcast', '').trim();
  if (!text) return ctx.reply('Usage: /broadcast <message>');
  const ids = Object.keys(users);
  await ctx.reply(`📢 Sending to ${ids.length} users...`);
  let ok = 0, fail = 0;
  for (const uid of ids) {
    try {
      await ctx.api.sendMessage(uid, `📢 *Announcement*\n\n${escapeMarkdown(text)}`, { parse_mode: 'Markdown' });
      ok++;
    } catch { fail++; }
    await new Promise(r => setTimeout(r, 50));
  }
  ctx.reply(`✅ Done — Success: ${ok} | Failed: ${fail}`);
});

bot.command('delete', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('❌ Admin only.');
  const id = ctx.message.text.replace('/delete', '').trim();
  if (!movies[id]) return ctx.reply('❌ Movie not found. Use /search to find IDs.');
  const name = movies[id].name;
  delete movies[id];
  await saveDB();
  ctx.reply(`✅ Deleted: ${escapeMarkdown(name)}`);
});

bot.command('ban', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('❌ Admin only.');
  const id = ctx.message.text.replace('/ban', '').trim();
  if (!id) return ctx.reply('Usage: /ban <userId>');
  banned[id] = true;
  await saveBanned();
  ctx.reply(`✅ Banned: ${id}`);
});

bot.command('unban', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('❌ Admin only.');
  const id = ctx.message.text.replace('/unban', '').trim();
  delete banned[id];
  await saveBanned();
  ctx.reply(`✅ Unbanned: ${id}`);
});

// ═══════════════════════════════════════
// 📩 /pending — Shows user ID + name, index-based DM buttons
// ═══════════════════════════════════════
bot.command('pending', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('❌ Admin only.');

  try {
    if (!Array.isArray(requests)) requests = [];

    // Get pending requests WITH their original index in the requests array
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

        // Use original index in requests array — no truncation, 100% match
        kb.text(`✅ Fulfill #${globalIdx}: ${movieName.slice(0, 20)}`, `rdi_${r._origIdx}`).row();
      }

      try {
        await ctx.reply(txt, { parse_mode: 'Markdown', reply_markup: kb });
      } catch (e) {
        // Fallback: plain text if Markdown parsing fails
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
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('❌ Admin only.');
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
// Usage: /dm <userId> <message>
// ═══════════════════════════════════════
bot.command('dm', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('❌ Admin only.');

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

  // Split: first word = userId, rest = message
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
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('❌ Admin only.');
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
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('❌ Admin only.');
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
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('❌ Admin only.');
  dailyQueue = [];
  await saveDailyQueue();
  ctx.reply('✅ Queue cleared.');
});

// ═══════════════════════════════════════
// 👋 WELCOME HANDLERS
// ═══════════════════════════════════════
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
  const isAdmin = userId === ADMIN_ID;

  trackUser(userId, msg.from.first_name, msg.from.username);

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
    if (userId !== ADMIN_ID) return ctx.answerCallbackQuery({ text: '❌ Admin only' });
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
    if (userId !== ADMIN_ID) return ctx.answerCallbackQuery({ text: '❌ Admin only' });
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
      if (userId !== ADMIN_ID && chatId) {
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
      if (userId === ADMIN_ID && adminEditMode[userId]) {
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
    await tempReply(ctx, `✅ *Request sent for "${escapeMarkdown(movieName)}"!*\n\nUse /myrequests to track.`, { parse_mode: 'Markdown' });
    try {
      await bot.api.sendMessage(ADMIN_ID,
        `📩 *New Request*\n\n🎬 ${escapeMarkdown(movieName)}\n👤 User: ${userId}`,
        { parse_mode: 'Markdown' });
    } catch {}
    return ctx.answerCallbackQuery({ text: '✅ Request sent!' });
  }

  // ── Edit movie (admin) ──
  if (data.startsWith('edit_')) {
    if (userId !== ADMIN_ID) return ctx.answerCallbackQuery({ text: '❌ Admin only' });
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
    if (userId !== ADMIN_ID) return ctx.answerCallbackQuery({ text: '❌ Admin only' });
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

  // ── Mark request fulfilled — index-based (rdi_<index>) ──────
  // Uses requests array index directly: no movie name truncation, 100% match
  if (data.startsWith('rdi_')) {
    if (userId !== ADMIN_ID) return ctx.answerCallbackQuery({ text: '❌ Admin only' });

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

    // Mark fulfilled first
    req.status = 'Fulfilled';
    await saveRequests();

    // Try to find movie in DB and send video DM
    const matchedMovies = searchMovies(movieName);

    if (matchedMovies.length === 0) {
      // Movie not in DB yet — just notify user that it will be uploaded soon
      try {
        await bot.api.sendMessage(reqUser,
          `📩 *Aapki Request Update!*\n\n` +
          `🎬 *${escapeMarkdown(movieName)}*\n\n` +
          `✅ Admin ne aapki request dekh li hai!\n` +
          `⏳ Movie jaldi upload hogi — please wait karein.\n\n` +
          `_/myrequests se status track kar sakte hain._`,
          { parse_mode: 'Markdown' }
        );
        return ctx.answerCallbackQuery({ text: '✅ User ko notify kar diya (movie DB mein nahi hai abhi)' });
      } catch (e) {
        console.error('[rdi] notify failed:', e.message);
        return ctx.answerCallbackQuery({ text: '✅ Marked fulfilled (DM failed — user blocked bot?)' });
      }
    }

    // Movie found — send video directly to user
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

      // Also confirm to admin which movie was sent
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

  // ── Legacy req_done_ handler (backward compat, kept for old buttons) ──
  if (data.startsWith('req_done_')) {
    if (userId !== ADMIN_ID) return ctx.answerCallbackQuery({ text: '❌ Admin only' });
    const rest      = data.slice('req_done_'.length);
    const uIdx      = rest.indexOf('_');
    const reqUser   = rest.slice(0, uIdx);
    const movieName = decodeURIComponent(rest.slice(uIdx + 1));
    // Find by user + loose movie name match
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
    if (userId !== ADMIN_ID) return ctx.answerCallbackQuery({ text: '❌ Admin only' });
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

    for (const m of newMoviesList) {
      if (!m.Poster || m.Poster === 'N/A') continue;
      await bot.api.sendPhoto(CHANNEL, m.Poster, {
        caption:
          `🆕 *New Indian Release!*\n\n` +
          `🎬 ${escapeMarkdown(m.Title)} (${m.Year})\n` +
          `⭐ IMDb: ${m.imdbRating || 'N/A'}\n` +
          `📖 ${escapeMarkdown(m.Plot || '')}\n\n` +
          `📥 Search on bot to request!\n` +
          `⚡ *3x Fast Download ke liye website par ek baar visit karein!*`,
        parse_mode: 'Markdown'
      }).catch(e => console.error('[DAILY] sendPhoto new error:', e.message));
      await new Promise(r => setTimeout(r, 1000));
    }

    for (const m of upcomingMoviesList) {
      if (!m.Poster || m.Poster === 'N/A') continue;
      await bot.api.sendPhoto(CHANNEL, m.Poster, {
        caption:
          `🔮 *Upcoming Indian Movie!*\n\n` +
          `🎬 ${escapeMarkdown(m.Title)} (${m.Year})\n` +
          `⭐ IMDb: ${m.imdbRating || 'N/A'}\n` +
          `📖 ${escapeMarkdown(m.Plot || '')}\n\n` +
          `📥 Search on bot to request!\n` +
          `⚡ *3x Fast Download ke liye website par ek baar visit karein!*`,
        parse_mode: 'Markdown'
      }).catch(e => console.error('[DAILY] sendPhoto upcoming error:', e.message));
      await new Promise(r => setTimeout(r, 1000));
    }

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
            `📥 Download using the bot!\n` +
            `⚡ *3x Fast Download ke liye website par ek baar visit karein!*`,
          parse_mode: 'Markdown'
        }).catch(e => console.error('[DAILY] sendVideo error:', e.message));
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    await fs.writeFile(DAILY_FILE, today);
    console.log('[DAILY] ✅ Post completed for', today);
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
bot.start({ onStart: info => console.log(`🚀 @${info.username} running — grammY`) });

