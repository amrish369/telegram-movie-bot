require('dotenv').config();
const { Bot, session, InlineKeyboard } = require('grammy');
const fs = require('fs').promises;
const axios = require('axios');
const Fuse = require('fuse.js');
const { exec } = require('child_process');

// ==============================
// 🔐 CONFIG & VALIDATION
// ==============================
const BOT_TOKEN = process.env.BOT_TOKEN;
const OMDB_API_KEY = process.env.OMDB_API_KEY;
const ADMIN_ID = Number(process.env.ADMIN_ID) || 5951923988;
const CHANNEL = process.env.CHANNEL || '@cineradarai';
const AUTO_DELETE_DELAY = 600000; // 10 minutes
const WELCOME_GIF = 'https://media.tenor.com/8d9B7xYkZk0AAAAC/welcome.gif';
const OMDB_BASE_URL = 'https://www.omdbapi.com/';

if (!BOT_TOKEN) throw new Error('❌ BOT_TOKEN missing in .env');
if (!OMDB_API_KEY) throw new Error('❌ OMDB_API_KEY missing in .env');

// ==============================
// 📁 DATABASE (JSON FILES)
// ==============================
let movies = {};
let requests = [];
let users = {};
let adminState = {};
let adminEditState = {};
let adminEditMode = {};
let movieCounter = 1;
let favorites = {}; // NEW: user favorites { userId: [movieId, ...] }
let watchlist = {}; // NEW: user watchlist { userId: [movieId, ...] }
let ratings = {};   // NEW: movie ratings { movieId: { total, count } }
let banned = {};    // NEW: banned users { userId: true }
const userLastSearch = new Map();

// Fuse.js search index
let fuseIndex = null;
function rebuildFuseIndex() {
  const movieList = Object.values(movies).map(m => ({
    id: m.id,
    name: m.name,
    year: m.year,
    language: m.language,
    quality: m.quality,
    size: m.size,
    file_id: m.file_id
  }));
  fuseIndex = new Fuse(movieList, {
    keys: ['name'],
    threshold: 0.4,
    includeScore: true
  });
}

// ==============================
// 💾 LOAD / SAVE DATABASE
// ==============================
async function loadDB() {
  // --- movies.json ---
  try {
    const data = await fs.readFile('movies.json', 'utf8');
    movies = JSON.parse(data);
    let needsMigration = false;
    const newMovies = {};
    let counter = 1;
    for (let key in movies) {
      const movie = movies[key];
      if (key.startsWith('m_') && movie.id && movie.id.startsWith('m_')) {
        newMovies[key] = movie;
        const num = parseInt(key.replace('m_', ''));
        if (!isNaN(num) && num >= counter) counter = num + 1;
        continue;
      }
      needsMigration = true;
      const shortId = counter++;
      const newKey = `m_${shortId}`;
      newMovies[newKey] = {
        id: newKey, shortId,
        file_id: movie.file_id,
        name: movie.name,
        year: movie.year,
        language: movie.language,
        quality: movie.quality,
        size: movie.size || null
      };
    }
    if (needsMigration) {
      movies = newMovies;
      await saveDB();
      console.log(`✅ Migrated ${counter - 1} movies to short ID format.`);
    }
    movieCounter = counter;
    rebuildFuseIndex();
  } catch (e) { movies = {}; }

  // --- requests.json ---
  try { requests = JSON.parse(await fs.readFile('requests.json', 'utf8')); }
  catch (e) { requests = []; }

  // --- users.json ---
  try { users = JSON.parse(await fs.readFile('users.json', 'utf8')); }
  catch (e) { users = {}; }

  // --- favorites.json ---
  try { favorites = JSON.parse(await fs.readFile('favorites.json', 'utf8')); }
  catch (e) { favorites = {}; }

  // --- watchlist.json ---
  try { watchlist = JSON.parse(await fs.readFile('watchlist.json', 'utf8')); }
  catch (e) { watchlist = {}; }

  // --- ratings.json ---
  try { ratings = JSON.parse(await fs.readFile('ratings.json', 'utf8')); }
  catch (e) { ratings = {}; }

  // --- banned.json ---
  try { banned = JSON.parse(await fs.readFile('banned.json', 'utf8')); }
  catch (e) { banned = {}; }
}

async function saveDB() {
  await fs.writeFile('movies.json', JSON.stringify(movies, null, 2));
  rebuildFuseIndex();
}
async function saveRequests() {
  await fs.writeFile('requests.json', JSON.stringify(requests, null, 2));
}
async function saveUsers() {
  await fs.writeFile('users.json', JSON.stringify(users, null, 2));
}
async function saveFavorites() {
  await fs.writeFile('favorites.json', JSON.stringify(favorites, null, 2));
}
async function saveWatchlist() {
  await fs.writeFile('watchlist.json', JSON.stringify(watchlist, null, 2));
}
async function saveRatings() {
  await fs.writeFile('ratings.json', JSON.stringify(ratings, null, 2));
}
async function saveBanned() {
  await fs.writeFile('banned.json', JSON.stringify(banned, null, 2));
}

// ==============================
// 🛠️ UTILITIES
// ==============================
function sanitizeInput(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>]/g, '').trim().slice(0, 200);
}

function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return '';
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? (mb / 1024).toFixed(2) + ' GB' : mb.toFixed(0) + ' MB';
}

// FIX: Escape Markdown special chars to prevent parse errors
function escapeMarkdown(text) {
  if (!text) return '';
  return String(text).replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

async function sendTempMessage(ctx, text, options = {}) {
  try {
    const msg = await ctx.reply(text, options);
    setTimeout(() => {
      ctx.api.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {});
    }, AUTO_DELETE_DELAY);
    return msg;
  } catch (error) {
    console.error('sendTempMessage error:', error.message);
    return null;
  }
}

async function sendTempAnimation(ctx, animation, options = {}) {
  try {
    const msg = await ctx.replyWithAnimation(animation, options);
    setTimeout(() => {
      ctx.api.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {});
    }, AUTO_DELETE_DELAY);
    return msg;
  } catch (error) {
    console.error('sendTempAnimation error:', error.message);
    return sendTempMessage(ctx, options.caption || 'Welcome!', { parse_mode: options.parse_mode });
  }
}

function trackUser(userId, firstName, username) {
  const now = new Date().toISOString();
  if (!users[userId]) {
    users[userId] = {
      id: userId,
      first_name: firstName || 'User',
      username: username || '',
      first_seen: now,
      last_seen: now,
      search_count: 0,
      downloads: 0
    };
  } else {
    users[userId].last_seen = now;
    users[userId].first_name = firstName || users[userId].first_name;
    users[userId].username = username || users[userId].username;
  }
  saveUsers();
}

async function isUserJoined(userId, ctx) {
  try {
    const res = await ctx.api.getChatMember(CHANNEL, userId);
    return ['member', 'administrator', 'creator'].includes(res.status);
  } catch {
    return false;
  }
}

// Rate limiter: 15 requests per user per 10 sec
const rateLimitMap = new Map();
function rateLimitMiddleware(ctx, next) {
  const userId = ctx.from?.id;
  if (!userId) return next();
  const now = Date.now();
  const userData = rateLimitMap.get(userId) || { count: 0, firstRequest: now };
  if (now - userData.firstRequest > 10000) {
    userData.count = 1;
    userData.firstRequest = now;
  } else {
    userData.count++;
  }
  rateLimitMap.set(userId, userData);
  if (userData.count > 15) {
    return ctx.reply('⚠️ Too many requests! Please slow down.');
  }
  return next();
}

// Ban check middleware
function banCheckMiddleware(ctx, next) {
  const userId = ctx.from?.id;
  if (userId && banned[userId]) {
    return ctx.reply('🚫 You are banned from using this bot.');
  }
  return next();
}

// Get average rating string
function getStarRating(movieId) {
  const r = ratings[movieId];
  if (!r || r.count === 0) return '';
  const avg = (r.total / r.count).toFixed(1);
  const stars = '⭐'.repeat(Math.round(avg));
  return `${stars} ${avg}/5 (${r.count} votes)`;
}

// ==============================
// 🎬 OMDb SERVICE
// ==============================
async function fetchOMDbMovie(title) {
  try {
    const response = await axios.get(OMDB_BASE_URL, {
      params: { apikey: OMDB_API_KEY, t: title, plot: 'short' },
      timeout: 5000
    });
    if (response.data.Response === 'False') return null;
    return response.data;
  } catch (error) {
    console.error('OMDb API error:', error.message);
    return null;
  }
}

// ==============================
// 🔍 SEARCH FUNCTIONS
// ==============================
function searchLocalMovies(query, filters = {}) {
  return Object.values(movies).filter(m => {
    const nameMatch = m.name.toLowerCase().includes(query.toLowerCase());
    const langMatch = !filters.language || (m.language || '').toLowerCase() === filters.language.toLowerCase();
    const qualMatch = !filters.quality || (m.quality || '').toLowerCase() === filters.quality.toLowerCase();
    const yearMatch = !filters.year || String(m.year) === String(filters.year);
    return nameMatch && langMatch && qualMatch && yearMatch;
  });
}

function findClosestMatch(query) {
  if (!fuseIndex) return null;
  const result = fuseIndex.search(query);
  return result.length > 0 && result[0].score <= 0.4 ? result[0].item.name.toLowerCase() : null;
}

function groupMovies(movieArray) {
  const groups = {};
  movieArray.forEach(m => {
    const key = `${m.name.trim().toLowerCase()}|${m.year || '0'}`;
    if (!groups[key]) groups[key] = { displayName: m.name, year: m.year, items: [] };
    groups[key].items.push(m);
  });
  return Object.values(groups);
}

// NEW: Get trending movies (most downloaded)
function getTrendingMovies(limit = 5) {
  return Object.values(movies)
    .filter(m => m.downloads && m.downloads > 0)
    .sort((a, b) => (b.downloads || 0) - (a.downloads || 0))
    .slice(0, limit);
}

// NEW: Get recently added movies
function getRecentMovies(limit = 5) {
  return Object.values(movies)
    .sort((a, b) => (b.shortId || 0) - (a.shortId || 0))
    .slice(0, limit);
}

// ==============================
// 🔘 BUILD FILTER BUTTONS
// ==============================
function buildFilterButtons(query, results) {
  const years = [...new Set(results.map(m => m.year).filter(Boolean))];
  const langs = [...new Set(results.map(m => m.language).filter(Boolean))];
  const quals = [...new Set(results.map(m => m.quality).filter(Boolean))];

  const rows = [];
  if (years.length > 1) {
    rows.push(years.slice(0, 4).map(y => InlineKeyboard.text(`📅 ${y}`, `filter_${query}|year|${y}`)));
  }
  if (langs.length > 1) {
    rows.push(langs.slice(0, 4).map(l => InlineKeyboard.text(`🌐 ${l}`, `filter_${query}|lang|${l}`)));
  }
  if (quals.length > 1) {
    rows.push(quals.slice(0, 4).map(q => InlineKeyboard.text(`📺 ${q}`, `filter_${query}|qual|${q}`)));
  }
  rows.push([InlineKeyboard.text(`🔄 Show All (${results.length})`, `filter_${query}|all|all`)]);
  return rows;
}

// ==============================
// 📋 BUILD MOVIE DETAIL KEYBOARD
// ==============================
function buildMovieKeyboard(movie, userId) {
  const kb = new InlineKeyboard();
  const size = movie.size ? ` | ${formatFileSize(movie.size)}` : '';
  kb.text(`⬇️ Download`, `send_${movie.id}`);

  // Favorites toggle
  const userFavs = favorites[userId] || [];
  const isFav = userFavs.includes(movie.id);
  kb.text(isFav ? '💔 Remove Fav' : '❤️ Favorite', `fav_${movie.id}`);
  kb.row();

  // Watchlist toggle
  const userWL = watchlist[userId] || [];
  const inWL = userWL.includes(movie.id);
  kb.text(inWL ? '✅ In Watchlist' : '📋 Watchlist', `wl_${movie.id}`);

  // Rating
  kb.text('⭐ Rate', `rate_${movie.id}`);
  kb.row();

  return kb;
}

// ==============================
// 🎬 BOT INITIALIZATION
// ==============================
const bot = new Bot(BOT_TOKEN);
bot.use(session({ initial: () => ({}) }));
bot.use(rateLimitMiddleware);
bot.use(banCheckMiddleware);

loadDB().then(() => console.log('📀 Database loaded'));

// ==============================
// 🟢 COMMANDS
// ==============================

// /start
bot.command('start', async (ctx) => {
  const userId = ctx.from.id;
  const firstName = ctx.from.first_name || 'User';
  trackUser(userId, firstName, ctx.from.username);

  const kb = new InlineKeyboard()
    .text('🔥 Trending', 'menu_trending')
    .text('🆕 Recent', 'menu_recent')
    .row()
    .text('❤️ Favorites', 'menu_favorites')
    .text('📋 Watchlist', 'menu_watchlist')
    .row()
    .text('ℹ️ Help', 'menu_help');

  try {
    await sendTempAnimation(ctx, WELCOME_GIF, {
      caption: `🎬 *Welcome to CineRadar AI, ${firstName}!*\n\n👇 Type at least 3 characters to search a movie.\n🔥 Smart search + OMDb posters enabled.\n\n📌 Use the menu below to explore:`,
      parse_mode: 'Markdown',
      reply_markup: kb
    });
  } catch {
    await sendTempMessage(ctx,
      `🎬 *Welcome to CineRadar AI, ${firstName}!*\n\n👇 Type at least 3 characters to search.\n\n📌 Use the menu below to explore:`,
      { parse_mode: 'Markdown', reply_markup: kb }
    );
  }
});

// /help
bot.command('help', async (ctx) => {
  const helpText = `🎬 *CineRadar AI — Help*\n\n` +
    `🔍 *Search:* Just type a movie name (min 3 chars)\n` +
    `❤️ *Favorites:* Save movies to your list\n` +
    `📋 *Watchlist:* Plan what to watch next\n` +
    `⭐ *Rate:* Rate movies 1–5 stars\n` +
    `📩 *Request:* Ask admin to upload missing movies\n\n` +
    `*Commands:*\n` +
    `/start — Welcome screen\n` +
    `/help — This help\n` +
    `/trending — 🔥 Top downloads\n` +
    `/recent — 🆕 Latest uploads\n` +
    `/favorites — Your saved movies\n` +
    `/watchlist — Your watchlist\n` +
    `/myrequests — Your movie requests\n` +
    `/profile — Your stats\n` +
    `/random — 🎲 Random movie pick`;
  await sendTempMessage(ctx, helpText, { parse_mode: 'Markdown' });
});

// /trending — top downloaded
bot.command('trending', async (ctx) => {
  const userId = ctx.from.id;
  const list = getTrendingMovies(10);
  if (list.length === 0) return sendTempMessage(ctx, '📭 No trending movies yet.');
  let kb = new InlineKeyboard();
  list.forEach(m => {
    const size = m.size ? ` | ${formatFileSize(m.size)}` : '';
    kb = kb.text(`⬇️ ${m.name} ${m.year || ''} | ${m.quality}${size} (${m.downloads||0}⬇)`, `send_${m.id}`).row();
  });
  return sendTempMessage(ctx, '🔥 *Trending Movies (Most Downloaded)*', { parse_mode: 'Markdown', reply_markup: kb });
});

// /recent — latest uploads
bot.command('recent', async (ctx) => {
  const list = getRecentMovies(10);
  if (list.length === 0) return sendTempMessage(ctx, '📭 No movies yet.');
  let kb = new InlineKeyboard();
  list.forEach(m => {
    const size = m.size ? ` | ${formatFileSize(m.size)}` : '';
    kb = kb.text(`🆕 ${m.name} ${m.year || ''} | ${m.quality}${size}`, `send_${m.id}`).row();
  });
  return sendTempMessage(ctx, '🆕 *Recently Added Movies*', { parse_mode: 'Markdown', reply_markup: kb });
});

// /favorites
bot.command('favorites', async (ctx) => {
  const userId = ctx.from.id;
  const userFavs = favorites[userId] || [];
  if (userFavs.length === 0) return sendTempMessage(ctx, '💔 You have no favorites yet.\nSearch a movie and tap ❤️ to add!');
  let kb = new InlineKeyboard();
  userFavs.forEach(id => {
    const m = movies[id];
    if (!m) return;
    const size = m.size ? ` | ${formatFileSize(m.size)}` : '';
    kb = kb.text(`🎬 ${m.name} ${m.year || ''} | ${m.quality}${size}`, `send_${m.id}`).row();
  });
  return sendTempMessage(ctx, `❤️ *Your Favorites (${userFavs.length})*`, { parse_mode: 'Markdown', reply_markup: kb });
});

// /watchlist
bot.command('watchlist', async (ctx) => {
  const userId = ctx.from.id;
  const userWL = watchlist[userId] || [];
  if (userWL.length === 0) return sendTempMessage(ctx, '📋 Your watchlist is empty.\nSearch a movie and tap 📋 to add!');
  let kb = new InlineKeyboard();
  userWL.forEach(id => {
    const m = movies[id];
    if (!m) return;
    const size = m.size ? ` | ${formatFileSize(m.size)}` : '';
    kb = kb.text(`🎬 ${m.name} ${m.year || ''} | ${m.quality}${size}`, `send_${m.id}`).row();
    kb = kb.text(`❌ Remove`, `wl_remove_${m.id}`).row();
  });
  return sendTempMessage(ctx, `📋 *Your Watchlist (${userWL.length})*`, { parse_mode: 'Markdown', reply_markup: kb });
});

// /myrequests
bot.command('myrequests', async (ctx) => {
  const userId = ctx.from.id;
  const userReqs = requests.filter(r => r.user === userId);
  if (userReqs.length === 0) return sendTempMessage(ctx, '📭 You haven\'t requested any movies yet.');
  let text = `📩 *Your Requests (${userReqs.length})*\n\n`;
  userReqs.slice(-10).forEach((r, i) => {
    const date = new Date(r.time).toLocaleDateString();
    text += `${i + 1}. 🎬 ${r.movie} — ${r.status || 'Pending'} (${date})\n`;
  });
  return sendTempMessage(ctx, text, { parse_mode: 'Markdown' });
});

// /profile
bot.command('profile', async (ctx) => {
  const userId = ctx.from.id;
  const u = users[userId];
  if (!u) return sendTempMessage(ctx, '❌ Profile not found.');
  const userFavs = (favorites[userId] || []).length;
  const userWL = (watchlist[userId] || []).length;
  const userReqs = requests.filter(r => r.user === userId).length;
  const joined = new Date(u.first_seen).toLocaleDateString();
  const text = `👤 *Your Profile*\n\n` +
    `🆔 ID: \`${userId}\`\n` +
    `📛 Name: ${u.first_name}\n` +
    `🔗 Username: ${u.username ? '@' + u.username : 'N/A'}\n` +
    `📅 Joined: ${joined}\n` +
    `⬇️ Downloads: ${u.downloads || 0}\n` +
    `🔍 Searches: ${u.search_count || 0}\n` +
    `❤️ Favorites: ${userFavs}\n` +
    `📋 Watchlist: ${userWL}\n` +
    `📩 Requests: ${userReqs}`;
  return sendTempMessage(ctx, text, { parse_mode: 'Markdown' });
});

// /random — random movie
bot.command('random', async (ctx) => {
  const list = Object.values(movies);
  if (list.length === 0) return sendTempMessage(ctx, '📭 No movies in database.');
  const m = list[Math.floor(Math.random() * list.length)];
  const size = m.size ? ` | ${formatFileSize(m.size)}` : '';
  const starRating = getStarRating(m.id);
  const kb = buildMovieKeyboard(m, ctx.from.id);
  const text = `🎲 *Random Pick!*\n\n🎬 ${m.name} ${m.year || ''}\n🌐 ${m.language || 'N/A'} | 📺 ${m.quality}${size}${starRating ? '\n' + starRating : ''}`;
  return sendTempMessage(ctx, text, { parse_mode: 'Markdown', reply_markup: kb });
});

// ==============================
// 🔑 ADMIN COMMANDS
// ==============================

// /edit toggle
bot.command('edit', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('❌ Admin only.');
  adminEditMode[ctx.from.id] = !adminEditMode[ctx.from.id];
  await ctx.reply(`✏️ Edit mode ${adminEditMode[ctx.from.id] ? '✅ enabled' : '❌ disabled'}.`);
});

// /broadcast
bot.command('broadcast', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('❌ Admin only.');
  const text = ctx.message.text.replace('/broadcast', '').trim();
  if (!text) return ctx.reply('Usage: /broadcast <message>');
  const userIds = Object.keys(users);
  let success = 0, fail = 0;
  await ctx.reply(`📢 Broadcasting to ${userIds.length} users...`);
  for (const uid of userIds) {
    try {
      await ctx.api.sendMessage(uid, `📢 *Announcement*\n\n${text}`, { parse_mode: 'Markdown' });
      success++;
    } catch { fail++; }
    await new Promise(r => setTimeout(r, 50));
  }
  await ctx.reply(`✅ Done. Success: ${success}, Failed: ${fail}`);
});

// /stats
bot.command('stats', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('❌ Admin only.');
  const totalMovies = Object.keys(movies).length;
  const totalUsers = Object.keys(users).length;
  const pending = requests.filter(r => !r.status || r.status === 'Pending').length;
  const totalDownloads = Object.values(movies).reduce((a, m) => a + (m.downloads || 0), 0);
  const bannedCount = Object.keys(banned).length;
  await ctx.reply(
    `📊 *BOT STATISTICS*\n\n` +
    `👥 Users: ${totalUsers}\n` +
    `🎬 Movies: ${totalMovies}\n` +
    `⬇️ Total Downloads: ${totalDownloads}\n` +
    `📩 Pending Requests: ${pending}\n` +
    `🚫 Banned Users: ${bannedCount}`,
    { parse_mode: 'Markdown' }
  );
});

// /delete <movieId> — admin delete a movie
bot.command('delete', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('❌ Admin only.');
  const args = ctx.message.text.replace('/delete', '').trim();
  if (!args) return ctx.reply('Usage: /delete m_<id>');
  if (!movies[args]) return ctx.reply('❌ Movie not found.');
  const name = movies[args].name;
  delete movies[args];
  await saveDB();
  await ctx.reply(`✅ Deleted: ${name}`);
});

// /ban <userId>
bot.command('ban', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('❌ Admin only.');
  const args = ctx.message.text.replace('/ban', '').trim();
  if (!args || isNaN(Number(args))) return ctx.reply('Usage: /ban <userId>');
  banned[args] = true;
  await saveBanned();
  await ctx.reply(`✅ Banned user: ${args}`);
});

// /unban <userId>
bot.command('unban', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('❌ Admin only.');
  const args = ctx.message.text.replace('/unban', '').trim();
  if (!args || isNaN(Number(args))) return ctx.reply('Usage: /unban <userId>');
  delete banned[args];
  await saveBanned();
  await ctx.reply(`✅ Unbanned user: ${args}`);
});

// /pending — view pending requests
bot.command('pending', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('❌ Admin only.');
  const pending = requests.filter(r => !r.status || r.status === 'Pending');
  if (pending.length === 0) return ctx.reply('✅ No pending requests.');
  let text = `📩 *Pending Requests (${pending.length})*\n\n`;
  let kb = new InlineKeyboard();
  pending.slice(0, 20).forEach((r, i) => {
    text += `${i + 1}. 🎬 ${r.movie} — User: ${r.user}\n`;
    kb = kb.text(`✅ ${r.movie.slice(0, 20)}`, `req_done_${r.user}_${encodeURIComponent(r.movie)}`).row();
  });
  await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: kb });
});

// /search <query> — inline search for admin
bot.command('search', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('❌ Admin only.');
  const query = ctx.message.text.replace('/search', '').trim();
  if (!query) return ctx.reply('Usage: /search <movie name>');
  const results = searchLocalMovies(query);
  if (results.length === 0) return ctx.reply('❌ No results.');
  let text = `🔍 Found ${results.length} result(s):\n\n`;
  results.slice(0, 10).forEach(m => {
    text += `🆔 \`${m.id}\` — ${m.name} (${m.year}) | ${m.language} | ${m.quality}\n`;
  });
  await ctx.reply(text, { parse_mode: 'Markdown' });
});

// ==============================
// 📨 MESSAGE HANDLER
// ==============================
bot.on('message', async (ctx, next) => {
  const msg = ctx.message;
  const userId = msg.from.id;
  const isAdmin = userId === ADMIN_ID;

  trackUser(userId, msg.from.first_name, msg.from.username);

  // --- Admin upload flow (video/document) ---
  if (isAdmin && (msg.video || msg.document)) {
    const fileId = msg.video?.file_id || msg.document?.file_id;
    const fileSize = msg.video?.file_size || msg.document?.file_size || null;
    ctx.session.upload = { step: 'name', file_id: fileId, size: fileSize };
    return sendTempMessage(ctx, '✅ File received!\n\n📝 *Step 1/4:* Movie name:', { parse_mode: 'Markdown' });
  }

  // --- Admin upload state machine ---
  if (ctx.session.upload && msg.text) {
    const state = ctx.session.upload;
    const text = sanitizeInput(msg.text);
    if (!text) return;

    if (state.step === 'name') {
      state.name = text;
      state.step = 'year';
      return sendTempMessage(ctx, '📅 *Step 2/4:* Release year:', { parse_mode: 'Markdown' });
    }
    if (state.step === 'year') {
      state.year = text;
      state.step = 'language';
      const kb = new InlineKeyboard()
        .text('🇮🇳 Hindi', 'ul_lang_Hindi').text('🇺🇸 English', 'ul_lang_English')
        .row().text('🎭 Dual Audio', 'ul_lang_Dual Audio').text('🌍 Multi', 'ul_lang_Multi Audio');
      return sendTempMessage(ctx, '🌐 *Step 3/4:* Language:', { parse_mode: 'Markdown', reply_markup: kb });
    }
    if (state.step === 'quality') {
      state.quality = text;
      // Save movie
      const shortId = movieCounter++;
      const key = `m_${shortId}`;
      movies[key] = {
        id: key, shortId,
        file_id: state.file_id,
        name: state.name,
        year: state.year,
        language: state.language,
        quality: state.quality,
        size: state.size,
        downloads: 0,
        added: new Date().toISOString()
      };
      await saveDB();
      ctx.session.upload = null;
      return sendTempMessage(ctx, `✅ Movie saved!\n🎬 ${state.name} (${state.year})\n🆔 ID: ${key}`);
    }
    if (state.step === 'language') {
      state.language = text;
      state.step = 'quality';
      const kb = new InlineKeyboard()
        .text('360p', 'ul_qual_360p').text('480p', 'ul_qual_480p')
        .row().text('720p', 'ul_qual_720p').text('1080p', 'ul_qual_1080p')
        .row().text('4K', 'ul_qual_4K');
      return sendTempMessage(ctx, '📺 *Step 4/4:* Quality:', { parse_mode: 'Markdown', reply_markup: kb });
    }
    return;
  }

  // --- Admin edit text input ---
  const editState = adminEditState[ctx.chat.id];
  if (editState && editState.step === 'enter_value' && msg.text) {
    const movie = movies[editState.movieId];
    if (!movie) { delete adminEditState[ctx.chat.id]; return; }
    const field = editState.field;
    const value = sanitizeInput(msg.text);
    if (!value) return ctx.reply('❌ Value cannot be empty.');
    if (field === 'name') movie.name = value;
    else if (field === 'year') movie.year = value;
    else if (field === 'lang') movie.language = value;
    else if (field === 'qual') movie.quality = value;
    else if (field === 'size') {
      const match = value.match(/^([\d.]+)\s*(MB|GB)$/i);
      if (match) {
        let num = parseFloat(match[1]);
        num = match[2].toUpperCase() === 'GB' ? num * 1024 * 1024 * 1024 : num * 1024 * 1024;
        movie.size = Math.round(num);
      } else return ctx.reply('❌ Invalid format. Use e.g., 1.5 GB or 700 MB');
    }
    await saveDB();
    delete adminEditState[ctx.chat.id];
    return ctx.reply(`✅ Movie updated: *${movie.name}*`, { parse_mode: 'Markdown' });
  }

  // --- User text search ---
  const searchText = msg.text;
  if (!searchText || searchText.startsWith('/')) return next();
  if (searchText.length < 3) {
    return sendTempMessage(ctx, '⚠️ Please enter at least 3 characters.');
  }

  const query = sanitizeInput(searchText.toLowerCase());
  userLastSearch.set(userId, query);

  // Update search count
  if (users[userId]) {
    users[userId].search_count = (users[userId].search_count || 0) + 1;
    saveUsers();
  }

  // Channel join check
  if (!isAdmin) {
    const joined = await isUserJoined(userId, ctx);
    if (!joined) {
      const kb = new InlineKeyboard().url('📢 Join Channel', `https://t.me/${CHANNEL.replace('@', '')}`);
      return sendTempMessage(ctx, '🚫 Please join our channel first to use this bot!', { reply_markup: kb });
    }
  }

  // Try OMDb
  const omdbData = await fetchOMDbMovie(query);
  if (omdbData && omdbData.Poster && omdbData.Poster !== 'N/A') {
    let caption = `🎬 *${omdbData.Title} (${omdbData.Year})*\n`;
    if (omdbData.Genre && omdbData.Genre !== 'N/A') caption += `🎭 ${omdbData.Genre}\n`;
    if (omdbData.imdbRating !== 'N/A') caption += `⭐ IMDb: ${omdbData.imdbRating}/10\n`;
    if (omdbData.Runtime && omdbData.Runtime !== 'N/A') caption += `⏱️ ${omdbData.Runtime}\n`;
    if (omdbData.Plot !== 'N/A') caption += `\n📖 ${omdbData.Plot}\n`;

    const localMatches = searchLocalMovies(omdbData.Title);
    let kb = new InlineKeyboard();

    if (localMatches.length > 0) {
      const grouped = groupMovies(localMatches);
      grouped.forEach(g => g.items.forEach(m => {
        const size = m.size ? ` | ${formatFileSize(m.size)}` : '';
        const starRating = getStarRating(m.id);
        kb = kb.text(
          `⬇️ ${m.language || 'N/A'} | ${m.quality}${size}${starRating ? ' | ' + (ratings[m.id]?.total / ratings[m.id]?.count).toFixed(1) + '⭐' : ''}`,
          `send_${m.id}`
        ).row();
        // Favorites + Watchlist buttons
        const userFavs = favorites[userId] || [];
        const userWL = watchlist[userId] || [];
        kb = kb
          .text(userFavs.includes(m.id) ? '💔 Fav' : '❤️ Fav', `fav_${m.id}`)
          .text(userWL.includes(m.id) ? '✅ WL' : '📋 WL', `wl_${m.id}`)
          .text('⭐ Rate', `rate_${m.id}`)
          .row();
      }));
      caption += `\n✅ *Available for download!*`;
    } else {
      kb = kb.text('📩 Request Movie', `request_${omdbData.Title}`);
      caption += `\n❌ *Not available yet.*`;
    }

    try {
      await ctx.replyWithPhoto(omdbData.Poster, { caption, parse_mode: 'Markdown', reply_markup: kb });
      return;
    } catch (err) {
      console.error('Poster send error:', err.message);
      // fallback below
    }
  }

  // Fallback: local search only
  const results = searchLocalMovies(query);
  if (results.length > 0) {
    const grouped = groupMovies(results);
    let text = `📁 *Search Results for "${sanitizeInput(searchText)}"*\n\n`;
    grouped.forEach(g => text += `🎬 *${g.displayName}* ${g.year || ''}\n`);

    let kb = new InlineKeyboard();
    grouped.forEach(g => g.items.forEach(m => {
      const size = m.size ? ` | ${formatFileSize(m.size)}` : '';
      const starRating = getStarRating(m.id);
      kb = kb.text(
        `⬇️ ${m.name} ${m.year || ''} | ${m.language || 'N/A'} | ${m.quality}${size}`,
        `send_${m.id}`
      ).row();
      const userFavs = favorites[userId] || [];
      const userWL = watchlist[userId] || [];
      kb = kb
        .text(userFavs.includes(m.id) ? '💔 Fav' : '❤️ Fav', `fav_${m.id}`)
        .text(userWL.includes(m.id) ? '✅ WL' : '📋 WL', `wl_${m.id}`)
        .text('⭐ Rate', `rate_${m.id}`)
        .row();
      if (isAdmin && adminEditMode[userId]) {
        kb = kb.text(`✏️ Edit "${m.name.slice(0, 20)}"`, `edit_${m.id}`).row();
      }
    }));

    const filterRows = buildFilterButtons(query, results);
    filterRows.forEach(row => kb.row(...row));

    return sendTempMessage(ctx, text, { parse_mode: 'Markdown', reply_markup: kb });
  }

  // Closest match suggestion
  const suggestion = findClosestMatch(query);
  if (suggestion) {
    const sugResults = searchLocalMovies(suggestion);
    const grouped = groupMovies(sugResults);
    let kb = new InlineKeyboard();
    grouped.forEach(g => g.items.forEach(m => {
      const size = m.size ? ` | ${formatFileSize(m.size)}` : '';
      kb = kb.text(`⬇️ ${m.name} ${m.year || ''} | ${m.language || 'N/A'} | ${m.quality}${size}`, `send_${m.id}`).row();
    }));
    return sendTempMessage(ctx, `❌ Not found. Did you mean *${suggestion}*?`, { parse_mode: 'Markdown', reply_markup: kb });
  }

  const kb = new InlineKeyboard().text('📩 Request Movie', `request_${query}`);
  return sendTempMessage(ctx, '❌ Movie not found in our database.', { reply_markup: kb });
});

// ==============================
// 🔘 CALLBACK HANDLER
// ==============================
bot.on('callback_query:data', async (ctx) => {
  const data = ctx.callbackQuery.data;
  const userId = ctx.from.id;

  // ── Upload: language selection ──
  if (data.startsWith('ul_lang_')) {
    if (userId !== ADMIN_ID) return ctx.answerCallbackQuery({ text: '❌ Admin only' });
    if (!ctx.session.upload) return ctx.answerCallbackQuery({ text: '❌ No upload session' });
    const lang = data.replace('ul_lang_', '');
    ctx.session.upload.language = lang;
    ctx.session.upload.step = 'quality';
    await ctx.answerCallbackQuery({ text: `Language: ${lang}` });
    const kb = new InlineKeyboard()
      .text('360p', 'ul_qual_360p').text('480p', 'ul_qual_480p')
      .row().text('720p', 'ul_qual_720p').text('1080p', 'ul_qual_1080p')
      .row().text('4K', 'ul_qual_4K');
    return sendTempMessage(ctx, '📺 *Step 4/4:* Quality:', { parse_mode: 'Markdown', reply_markup: kb });
  }

  // ── Upload: quality selection & save ──
  if (data.startsWith('ul_qual_')) {
    if (userId !== ADMIN_ID) return ctx.answerCallbackQuery({ text: '❌ Admin only' });
    const qual = data.replace('ul_qual_', '');
    const state = ctx.session.upload;
    if (!state) return ctx.answerCallbackQuery({ text: '❌ No upload session' });
    state.quality = qual;
    const shortId = movieCounter++;
    const key = `m_${shortId}`;
    movies[key] = {
      id: key, shortId,
      file_id: state.file_id,
      name: state.name,
      year: state.year,
      language: state.language,
      quality: state.quality,
      size: state.size,
      downloads: 0,
      added: new Date().toISOString()
    };
    await saveDB();
    ctx.session.upload = null;
    await ctx.answerCallbackQuery({ text: `✅ Saved: ${state.name}` });
    return ctx.reply(`✅ Movie saved!\n🎬 ${state.name} (${state.year})\n🆔 ID: ${key}`);
  }

  // ── Send movie (download) ──
  if (data.startsWith('send_')) {
    const movieId = data.replace('send_', '');
    const movie = movies[movieId];
    if (!movie) return ctx.answerCallbackQuery({ text: '❌ Movie not found', show_alert: true });

    // Track downloads
    movie.downloads = (movie.downloads || 0) + 1;
    if (users[userId]) users[userId].downloads = (users[userId].downloads || 0) + 1;
    await saveDB();
    saveUsers();

    const size = movie.size ? ` | ${formatFileSize(movie.size)}` : '';
    const starRating = getStarRating(movieId);

    try {
      const sent = await ctx.replyWithVideo(movie.file_id, {
        caption: `🎬 *${movie.name}* ${movie.year || ''}\n🌐 ${movie.language || 'N/A'} | 📺 ${movie.quality}${size}${starRating ? '\n' + starRating : ''}\n\n⚠️ This file will auto-delete in 10 min.`,
        parse_mode: 'Markdown',
        reply_markup: new InlineKeyboard()
          .url('💬 Join Group', `https://t.me/${CHANNEL.replace('@', '')}`)
      });
      setTimeout(() => {
        ctx.api.deleteMessage(ctx.chat.id, sent.message_id).catch(() => {});
      }, AUTO_DELETE_DELAY);
      return ctx.answerCallbackQuery({ text: `📥 Sending: ${movie.name}` });
    } catch (err) {
      console.error('Video send error:', err.message);
      return ctx.answerCallbackQuery({ text: '❌ Error sending file. Please try again.', show_alert: true });
    }
  }

  // ── Favorites toggle ──
  if (data.startsWith('fav_')) {
    const movieId = data.replace('fav_', '');
    if (!movies[movieId]) return ctx.answerCallbackQuery({ text: '❌ Movie not found' });
    if (!favorites[userId]) favorites[userId] = [];
    const idx = favorites[userId].indexOf(movieId);
    if (idx === -1) {
      favorites[userId].push(movieId);
      await saveFavorites();
      return ctx.answerCallbackQuery({ text: `❤️ Added to favorites: ${movies[movieId].name}`, show_alert: false });
    } else {
      favorites[userId].splice(idx, 1);
      await saveFavorites();
      return ctx.answerCallbackQuery({ text: `💔 Removed from favorites`, show_alert: false });
    }
  }

  // ── Watchlist toggle ──
  if (data.startsWith('wl_remove_')) {
    const movieId = data.replace('wl_remove_', '');
    if (!watchlist[userId]) watchlist[userId] = [];
    watchlist[userId] = watchlist[userId].filter(id => id !== movieId);
    await saveWatchlist();
    await ctx.answerCallbackQuery({ text: '✅ Removed from watchlist' });
    // Refresh watchlist view
    const userWL = watchlist[userId] || [];
    if (userWL.length === 0) {
      return ctx.editMessageText('📋 Your watchlist is now empty.');
    }
    let kb = new InlineKeyboard();
    userWL.forEach(id => {
      const m = movies[id];
      if (!m) return;
      const size = m.size ? ` | ${formatFileSize(m.size)}` : '';
      kb = kb.text(`🎬 ${m.name} ${m.year || ''} | ${m.quality}${size}`, `send_${m.id}`).row();
      kb = kb.text(`❌ Remove`, `wl_remove_${m.id}`).row();
    });
    return ctx.editMessageReplyMarkup({ reply_markup: kb });
  }

  if (data.startsWith('wl_')) {
    const movieId = data.replace('wl_', '');
    if (!movies[movieId]) return ctx.answerCallbackQuery({ text: '❌ Movie not found' });
    if (!watchlist[userId]) watchlist[userId] = [];
    const idx = watchlist[userId].indexOf(movieId);
    if (idx === -1) {
      watchlist[userId].push(movieId);
      await saveWatchlist();
      return ctx.answerCallbackQuery({ text: `📋 Added to watchlist: ${movies[movieId].name}`, show_alert: false });
    } else {
      watchlist[userId].splice(idx, 1);
      await saveWatchlist();
      return ctx.answerCallbackQuery({ text: `✅ Removed from watchlist`, show_alert: false });
    }
  }

  // ── Rating ──
  if (data.startsWith('rate_')) {
    const movieId = data.replace('rate_', '');
    if (!movies[movieId]) return ctx.answerCallbackQuery({ text: '❌ Movie not found' });
    const kb = new InlineKeyboard()
      .text('1⭐', `dorate_${movieId}_1`)
      .text('2⭐', `dorate_${movieId}_2`)
      .text('3⭐', `dorate_${movieId}_3`)
      .text('4⭐', `dorate_${movieId}_4`)
      .text('5⭐', `dorate_${movieId}_5`);
    await ctx.reply(`⭐ Rate *${movies[movieId].name}*:`, { parse_mode: 'Markdown', reply_markup: kb });
    return ctx.answerCallbackQuery();
  }

  if (data.startsWith('dorate_')) {
    const parts = data.replace('dorate_', '').split('_');
    const movieId = parts[0];
    const score = parseInt(parts[1]);
    if (!movies[movieId] || isNaN(score)) return ctx.answerCallbackQuery({ text: '❌ Invalid rating' });
    if (!ratings[movieId]) ratings[movieId] = { total: 0, count: 0, voters: {} };
    // Allow re-rating: subtract old vote first
    if (ratings[movieId].voters && ratings[movieId].voters[userId]) {
      ratings[movieId].total -= ratings[movieId].voters[userId];
      ratings[movieId].count--;
    }
    ratings[movieId].voters[userId] = score;
    ratings[movieId].total += score;
    ratings[movieId].count++;
    await saveRatings();
    const avg = (ratings[movieId].total / ratings[movieId].count).toFixed(1);
    return ctx.answerCallbackQuery({ text: `✅ Rated ${score}⭐! Avg: ${avg}/5`, show_alert: true });
  }

  // ── Admin edit flow ──
  if (data.startsWith('edit_')) {
    if (userId !== ADMIN_ID) return ctx.answerCallbackQuery({ text: '❌ Admin only' });
    const movieId = data.replace('edit_', '');
    const movie = movies[movieId];
    if (!movie) return ctx.answerCallbackQuery({ text: '❌ Not found' });
    adminEditState[ctx.chat.id] = { movieId, step: 'choose_field' };
    const kb = new InlineKeyboard()
      .text('📝 Name', 'editfield_name').text('📅 Year', 'editfield_year').row()
      .text('🌐 Language', 'editfield_lang').text('📺 Quality', 'editfield_qual').row()
      .text('💾 Size', 'editfield_size').text('❌ Cancel', 'editcancel');
    await ctx.reply(`✏️ Editing: *${movie.name}*\nChoose field to edit:`, { parse_mode: 'Markdown', reply_markup: kb });
    return ctx.answerCallbackQuery();
  }

  if (data.startsWith('editfield_')) {
    if (userId !== ADMIN_ID) return ctx.answerCallbackQuery({ text: '❌ Admin only' });
    const field = data.replace('editfield_', '');
    if (!adminEditState[ctx.chat.id]) return ctx.answerCallbackQuery({ text: '❌ No edit session' });
    adminEditState[ctx.chat.id].field = field;
    adminEditState[ctx.chat.id].step = 'enter_value';
    const prompts = {
      name: '📝 Enter new name:',
      year: '📅 Enter new year:',
      lang: '🌐 Enter new language:',
      qual: '📺 Enter new quality (e.g. 720p):',
      size: '💾 Enter size (e.g. 1.5 GB or 700 MB):'
    };
    await ctx.reply(prompts[field] || 'Enter new value:');
    return ctx.answerCallbackQuery();
  }

  if (data === 'editcancel') {
    delete adminEditState[ctx.chat.id];
    await ctx.reply('❌ Edit cancelled.');
    return ctx.answerCallbackQuery();
  }

  // ── Filters ──
  if (data.startsWith('filter_')) {
    // FIX: handle query strings that might contain | chars
    const firstPipe = data.indexOf('|');
    const secondPipe = data.indexOf('|', firstPipe + 1);
    if (firstPipe === -1 || secondPipe === -1) return ctx.answerCallbackQuery();
    const shortQuery = data.slice('filter_'.length, firstPipe);
    const type = data.slice(firstPipe + 1, secondPipe);
    const val = data.slice(secondPipe + 1);
    const fullQuery = userLastSearch.get(userId) || shortQuery;
    let filters = {};
    if (type === 'lang') filters.language = val;
    if (type === 'qual') filters.quality = val;
    if (type === 'year') filters.year = val;
    const results = type === 'all' ? searchLocalMovies(fullQuery) : searchLocalMovies(fullQuery, filters);
    if (results.length === 0) return ctx.answerCallbackQuery({ text: 'No results for this filter', show_alert: true });

    const grouped = groupMovies(results);
    let kb = new InlineKeyboard();
    grouped.forEach(g => g.items.forEach(m => {
      const size = m.size ? ` | ${formatFileSize(m.size)}` : '';
      kb = kb.text(`⬇️ ${m.name} ${m.year || ''} | ${m.language || 'N/A'} | ${m.quality}${size}`, `send_${m.id}`).row();
    }));
    const filterRows = buildFilterButtons(fullQuery, results);
    filterRows.forEach(row => kb.row(...row));
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: kb });
    } catch { /* message may not have markup */ }
    return ctx.answerCallbackQuery({ text: `${results.length} result(s)` });
  }

  // ── Movie request ──
  if (data.startsWith('request_')) {
    const movieName = decodeURIComponent(data.replace('request_', ''));
    // Prevent duplicate requests from same user for same movie
    const alreadyRequested = requests.find(r => r.user === userId && r.movie.toLowerCase() === movieName.toLowerCase() && (!r.status || r.status === 'Pending'));
    if (alreadyRequested) {
      return ctx.answerCallbackQuery({ text: '⚠️ You already requested this movie!', show_alert: true });
    }
    requests.push({ user: userId, movie: movieName, time: new Date().toISOString(), status: 'Pending' });
    await saveRequests();
    await ctx.reply(`✅ Request sent for *${movieName}*!\nAdmin will be notified. Check /myrequests to track status.`, { parse_mode: 'Markdown' });
    try {
      await ctx.api.sendMessage(ADMIN_ID, `📩 *New Movie Request*\n\n🎬 Movie: ${movieName}\n👤 User: ${userId} (@${ctx.from.username || 'N/A'})\n\nUse /pending to manage.`, { parse_mode: 'Markdown' });
    } catch {}
    return ctx.answerCallbackQuery();
  }

  // ── Admin: mark request done ──
  if (data.startsWith('req_done_')) {
    if (userId !== ADMIN_ID) return ctx.answerCallbackQuery({ text: '❌ Admin only' });
    const parts = data.replace('req_done_', '').split('_');
    const reqUserId = parts[0];
    const movieName = decodeURIComponent(parts.slice(1).join('_'));
    const req = requests.find(r => String(r.user) === String(reqUserId) && r.movie === movieName);
    if (req) {
      req.status = 'Fulfilled';
      await saveRequests();
      try {
        await ctx.api.sendMessage(reqUserId, `✅ Your request for *${movieName}* has been fulfilled! Search for it now.`, { parse_mode: 'Markdown' });
      } catch {}
    }
    return ctx.answerCallbackQuery({ text: '✅ Marked as fulfilled' });
  }

  // ── Menu buttons ──
  if (data === 'menu_trending') {
    const list = getTrendingMovies(8);
    if (list.length === 0) return ctx.answerCallbackQuery({ text: '📭 No trending movies yet', show_alert: true });
    let kb = new InlineKeyboard();
    list.forEach(m => {
      const size = m.size ? ` | ${formatFileSize(m.size)}` : '';
      kb = kb.text(`🔥 ${m.name} ${m.year || ''} | ${m.quality} (${m.downloads || 0}⬇)`, `send_${m.id}`).row();
    });
    await ctx.reply('🔥 *Trending Movies*', { parse_mode: 'Markdown', reply_markup: kb });
    return ctx.answerCallbackQuery();
  }

  if (data === 'menu_recent') {
    const list = getRecentMovies(8);
    if (list.length === 0) return ctx.answerCallbackQuery({ text: '📭 No movies yet', show_alert: true });
    let kb = new InlineKeyboard();
    list.forEach(m => {
      const size = m.size ? ` | ${formatFileSize(m.size)}` : '';
      kb = kb.text(`🆕 ${m.name} ${m.year || ''} | ${m.quality}${size}`, `send_${m.id}`).row();
    });
    await ctx.reply('🆕 *Recently Added*', { parse_mode: 'Markdown', reply_markup: kb });
    return ctx.answerCallbackQuery();
  }

  if (data === 'menu_favorites') {
    const userFavs = favorites[userId] || [];
    if (userFavs.length === 0) return ctx.answerCallbackQuery({ text: '💔 No favorites yet! ❤️ tap Fav on a movie.', show_alert: true });
    let kb = new InlineKeyboard();
    userFavs.forEach(id => {
      const m = movies[id];
      if (!m) return;
      const size = m.size ? ` | ${formatFileSize(m.size)}` : '';
      kb = kb.text(`🎬 ${m.name} ${m.year || ''} | ${m.quality}${size}`, `send_${m.id}`).row();
    });
    await ctx.reply(`❤️ *Your Favorites (${userFavs.length})*`, { parse_mode: 'Markdown', reply_markup: kb });
    return ctx.answerCallbackQuery();
  }

  if (data === 'menu_watchlist') {
    const userWL = watchlist[userId] || [];
    if (userWL.length === 0) return ctx.answerCallbackQuery({ text: '📋 Watchlist is empty! 📋 tap WL on a movie.', show_alert: true });
    let kb = new InlineKeyboard();
    userWL.forEach(id => {
      const m = movies[id];
      if (!m) return;
      const size = m.size ? ` | ${formatFileSize(m.size)}` : '';
      kb = kb.text(`🎬 ${m.name} ${m.year || ''} | ${m.quality}${size}`, `send_${m.id}`).row();
    });
    await ctx.reply(`📋 *Your Watchlist (${userWL.length})*`, { parse_mode: 'Markdown', reply_markup: kb });
    return ctx.answerCallbackQuery();
  }

  if (data === 'menu_help') {
    const helpText = `🎬 *CineRadar AI — Help*\n\n` +
      `🔍 *Search:* Type any movie name (min 3 chars)\n` +
      `❤️ *Favorites:* Save movies you love\n` +
      `📋 *Watchlist:* Plan what to watch next\n` +
      `⭐ *Rate:* Rate movies 1–5 stars\n` +
      `📩 *Request:* Ask admin to upload missing movies\n\n` +
      `*/trending* — Top downloaded movies\n` +
      `*/recent* — Latest additions\n` +
      `*/favorites* — Your saved movies\n` +
      `*/watchlist* — Your watchlist\n` +
      `*/random* — Random movie\n` +
      `*/profile* — Your stats\n` +
      `*/myrequests* — Your requests`;
    await ctx.reply(helpText, { parse_mode: 'Markdown' });
    return ctx.answerCallbackQuery();
  }

  // Fallback for unhandled callbacks
  return ctx.answerCallbackQuery();
});

// ==============================
// 📅 DAILY SUGGESTIONS
// ==============================
const DAILY_FILE = 'lastDailySent.json';
async function sendDailySuggestions() {
  try {
    let last = '';
    try { last = (await fs.readFile(DAILY_FILE, 'utf8')).trim(); } catch {}
    const today = new Date().toISOString().slice(0, 10);
    if (last === today) return;
    const list = Object.values(movies);
    if (list.length === 0) return;
    const shuffled = [...list].sort(() => Math.random() - 0.5);
    const selected = shuffled.slice(0, 5);
    for (const m of selected) {
      const size = m.size ? ` | ${formatFileSize(m.size)}` : '';
      try {
        await bot.api.sendVideo(CHANNEL, m.file_id, {
          caption: `🎬 *आज की सुझाई गई मूवी*\n\n${m.name} ${m.year || ''}\n🌐 ${m.language || 'N/A'} | 📺 ${m.quality}${size}\n\n📥 Bot पर जाकर डाउनलोड करें!`,
          parse_mode: 'Markdown'
        });
        await new Promise(r => setTimeout(r, 2000));
      } catch (e) {
        console.error(`Daily suggestion send error for ${m.name}:`, e.message);
      }
    }
    await fs.writeFile(DAILY_FILE, today);
    console.log(`✅ Daily suggestions sent for ${today}`);
  } catch (e) {
    console.error('Daily suggestion error:', e);
  }
}

// Check daily suggestions every hour
setInterval(sendDailySuggestions, 3600000);

// ==============================
// 🔄 AUTO GIT PUSH
// ==============================
function runGitAutoPush() {
  exec('git add . && git diff --cached --quiet || (git commit -m "auto update [skip ci]" && git push)', (err, stdout, stderr) => {
    if (err) console.error('[GIT] Error:', stderr);
    else if (stdout) console.log('[GIT] ✅ Synced');
  });
}
setInterval(runGitAutoPush, 60000);

// ==============================
// 🛑 ERROR HANDLING
// ==============================
bot.catch((err) => {
  const ctx = err.ctx;
  console.error(`❌ Error handling update ${ctx?.update?.update_id}:`, err.error);
  // Optionally notify admin of errors
  if (err.error?.message) {
    bot.api.sendMessage(ADMIN_ID, `⚠️ Bot error:\n\`${err.error.message.slice(0, 300)}\``, { parse_mode: 'Markdown' }).catch(() => {});
  }
});

// ==============================
// 🟢 START BOT
// ==============================
bot.start({
  onStart: (info) => console.log(`🚀 @${info.username} running on grammY`),
});

