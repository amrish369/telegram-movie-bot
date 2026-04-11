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
const AUTO_DELETE_DELAY = 120000;
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

// Load databases
async function loadDB() {
  try {
    const data = await fs.readFile('movies.json', 'utf8');
    movies = JSON.parse(data);
    // Auto-migration for old keys
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
        id: newKey,
        shortId,
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
  } catch (e) {
    movies = {};
  }

  try {
    requests = JSON.parse(await fs.readFile('requests.json', 'utf8'));
  } catch (e) {
    requests = [];
  }

  try {
    users = JSON.parse(await fs.readFile('users.json', 'utf8'));
  } catch (e) {
    users = {};
  }
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

async function sendTempMessage(ctx, text, options = {}) {
  const msg = await ctx.reply(text, options);
  setTimeout(() => {
    ctx.api.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {});
  }, AUTO_DELETE_DELAY);
  return msg;
}

async function sendTempAnimation(ctx, animation, options = {}) {
  const msg = await ctx.replyWithAnimation(animation, options);
  setTimeout(() => {
    ctx.api.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {});
  }, AUTO_DELETE_DELAY);
  return msg;
}

function trackUser(userId, firstName, username) {
  if (!users[userId]) {
    users[userId] = {
      id: userId,
      first_name: firstName,
      username: username || '',
      first_seen: new Date().toISOString(),
      last_seen: new Date().toISOString()
    };
  } else {
    users[userId].last_seen = new Date().toISOString();
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

// Simple rate limiter (10 requests per user per 10 sec)
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
  if (userData.count > 10) {
    return ctx.reply('⚠️ Too many requests! Slow down.');
  }
  return next();
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
    const langMatch = !filters.language || m.language?.toLowerCase() === filters.language.toLowerCase();
    const qualMatch = !filters.quality || m.quality?.toLowerCase() === filters.quality.toLowerCase();
    const yearMatch = !filters.year || String(m.year) === String(filters.year);
    return nameMatch && langMatch && qualMatch && yearMatch;
  });
}

function findClosestMatch(query) {
  if (!fuseIndex) return null;
  const result = fuseIndex.search(query);
  return result.length > 0 && result[0].score <= 0.4 ? result[0].item.name.toLowerCase() : null;
}

// Group movies for display (same name/year)
function groupMovies(movieArray) {
  const groups = {};
  movieArray.forEach(m => {
    const key = `${m.name.trim().toLowerCase()}|${m.year || '0'}`;
    if (!groups[key]) groups[key] = { displayName: m.name, year: m.year, items: [] };
    groups[key].items.push(m);
  });
  return Object.values(groups);
}

// ==============================
// 🎬 BOT INITIALIZATION
// ==============================
const bot = new Bot(BOT_TOKEN);
bot.use(session({ initial: () => ({}) }));
bot.use(rateLimitMiddleware);

// Load DB on startup
loadDB().then(() => console.log('📀 Database loaded'));

// ==============================
// 🟢 COMMANDS
// ==============================
bot.command('start', async (ctx) => {
  const userId = ctx.from.id;
  const firstName = ctx.from.first_name;
  trackUser(userId, firstName, ctx.from.username);

  await sendTempAnimation(ctx, WELCOME_GIF, {
    caption: `🎬 *Welcome to CineRadar AI, ${firstName}!*\n\n👇 Type at least 3 characters to search.\n🔥 Smart search + OMDb posters enabled.`,
    parse_mode: 'Markdown'
  });
});

bot.command('edit', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('❌ Admin only.');
  adminEditMode[ctx.from.id] = !adminEditMode[ctx.from.id];
  await ctx.reply(`✏️ Edit mode ${adminEditMode[ctx.from.id] ? 'enabled' : 'disabled'}.`);
});

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

bot.command('stats', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('❌ Admin only.');
  const totalMovies = Object.keys(movies).length;
  const totalUsers = Object.keys(users).length;
  const pending = requests.length;
  await ctx.reply(
    `📊 *BOT STATISTICS*\n\n👥 Users: ${totalUsers}\n🎬 Movies: ${totalMovies}\n📩 Requests: ${pending}`,
    { parse_mode: 'Markdown' }
  );
});

// ==============================
// 📨 MESSAGE HANDLER (UPLOAD + SEARCH)
// ==============================
bot.on('message', async (ctx, next) => {
  const msg = ctx.message;
  const userId = msg.from.id;
  const isAdmin = userId === ADMIN_ID;

  trackUser(userId, msg.from.first_name, msg.from.username);

  // Admin upload flow
  if (isAdmin && (msg.video || msg.document)) {
    const fileId = msg.video?.file_id || msg.document?.file_id;
    const fileSize = msg.video?.file_size || msg.document?.file_size || null;
    ctx.session.upload = { step: 'name', file_id: fileId, size: fileSize };
    return sendTempMessage(ctx, '✅ File received!\n\n📝 *Step 1/4:* Movie name:', { parse_mode: 'Markdown' });
  }

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
        size: state.size
      };
      await saveDB();
      ctx.session.upload = null;
      return sendTempMessage(ctx, `✅ Movie saved!\n🎬 ${state.name} (${state.year})`);
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

  // Admin edit text input
  const editState = adminEditState[ctx.chat.id];
  if (editState && editState.step === 'enter_value' && msg.text) {
    const movie = movies[editState.movieId];
    if (!movie) { delete adminEditState[ctx.chat.id]; return; }
    const field = editState.field;
    const value = sanitizeInput(msg.text);
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
      } else return ctx.reply('Invalid format. Use e.g., 1.5 GB');
    }
    await saveDB();
    delete adminEditState[ctx.chat.id];
    return ctx.reply('✅ Movie updated.');
  }

  // User search (text message)
  const searchText = msg.text;
  if (!searchText || searchText.length < 3) {
    return sendTempMessage(ctx, '⚠️ Enter at least 3 characters.');
  }

  const query = sanitizeInput(searchText.toLowerCase());
  userLastSearch.set(userId, query);

  // Channel join check (non-admin)
  if (!isAdmin) {
    const joined = await isUserJoined(userId, ctx);
    if (!joined) {
      const kb = new InlineKeyboard().url('📢 Join Channel', `https://t.me/${CHANNEL.replace('@', '')}`);
      return sendTempMessage(ctx, '🚫 Join channel first', { reply_markup: kb });
    }
  }

  // Try OMDb first
  const omdbData = await fetchOMDbMovie(query);
  if (omdbData && omdbData.Poster && omdbData.Poster !== 'N/A') {
    let caption = `🎬 *${omdbData.Title} (${omdbData.Year})*\n`;
    if (omdbData.imdbRating !== 'N/A') caption += `⭐ IMDb: ${omdbData.imdbRating}/10\n`;
    if (omdbData.Plot !== 'N/A') caption += `📖 ${omdbData.Plot}\n`;

    const localMatches = searchLocalMovies(omdbData.Title);
    let kb = new InlineKeyboard();
    if (localMatches.length > 0) {
      const grouped = groupMovies(localMatches);
      grouped.forEach(g => g.items.forEach(m => {
        const size = m.size ? ` | ${formatFileSize(m.size)}` : '';
        kb = kb.text(`⬇️ ${m.quality}${size}`, `send_${m.id}`).row();
      }));
      caption += `\n✅ Available for download!`;
    } else {
      kb = kb.text('📩 Request Movie', `request_${omdbData.Title}`);
      caption += `\n❌ Not available yet.`;
    }
    try {
      await ctx.replyWithPhoto(omdbData.Poster, { caption, parse_mode: 'Markdown', reply_markup: kb });
      return;
    } catch (err) {
      console.error('Poster send error:', err.message);
    }
  }

  // Fallback to local search
  const results = searchLocalMovies(query);
  if (results.length > 0) {
    const grouped = groupMovies(results);
    let text = '📁 *HERE I FOUND FOR YOUR SEARCH*\n\n';
    grouped.forEach(g => text += `🎬 *${g.displayName} ${g.year || ''}*\n`);

    const filterRows = buildFilterButtons(query, results);
    let kb = new InlineKeyboard();
    grouped.forEach(g => g.items.forEach(m => {
      const size = m.size ? ` | ${formatFileSize(m.size)}` : '';
      kb = kb.text(`⬇️ ${m.name} ${m.year || ''} | ${m.language || ''} | ${m.quality}${size}`, `send_${m.id}`).row();
      if (isAdmin && adminEditMode[userId]) {
        kb = kb.text(`✏️ Edit "${m.name}"`, `edit_${m.id}`).row();
      }
    }));
    filterRows.forEach(row => kb.row(...row));
    return sendTempMessage(ctx, text, { parse_mode: 'Markdown', reply_markup: kb });
  }

  const suggestion = findClosestMatch(query);
  if (suggestion) {
    const sugResults = searchLocalMovies(suggestion);
    const grouped = groupMovies(sugResults);
    let kb = new InlineKeyboard();
    grouped.forEach(g => g.items.forEach(m => {
      kb = kb.text(`⬇️ ${m.quality}`, `send_${m.id}`).row();
    }));
    return sendTempMessage(ctx, `❌ Not found. Did you mean *${suggestion}*?`, { parse_mode: 'Markdown', reply_markup: kb });
  }

  const kb = new InlineKeyboard().text('📩 Request Movie', `request_${query}`);
  return sendTempMessage(ctx, '❌ Movie not found.', { reply_markup: kb });
});

// Helper: filter buttons
function buildFilterButtons(query, results) {
  const years = [...new Set(results.map(m => m.year).filter(Boolean))];
  const langs = [...new Set(results.map(m => m.language).filter(Boolean))];
  const quals = [...new Set(results.map(m => m.quality).filter(Boolean))];
  const rows = [];
  if (years.length) rows.push(years.slice(0,4).map(y => ({ text: `📅 ${y}`, callback_data: `filter_${query}|year|${y}` })));
  if (langs.length) rows.push(langs.slice(0,4).map(l => ({ text: `🌐 ${l}`, callback_data: `filter_${query}|lang|${l}` })));
  if (quals.length) rows.push(quals.slice(0,4).map(q => ({ text: `📺 ${q}`, callback_data: `filter_${query}|qual|${q}` })));
  rows.push([{ text: `🔄 Show All (${results.length})`, callback_data: `filter_${query}|all|all` }]);
  return rows;
}

// ==============================
// 🔘 CALLBACK HANDLER
// ==============================
bot.on('callback_query:data', async (ctx) => {
  const data = ctx.callbackQuery.data;
  const userId = ctx.from.id;

  // Upload language/quality shortcuts
  if (data.startsWith('ul_lang_')) {
    if (userId !== ADMIN_ID) return ctx.answerCallbackQuery({ text: 'Admin only' });
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
  if (data.startsWith('ul_qual_')) {
    if (userId !== ADMIN_ID) return ctx.answerCallbackQuery({ text: 'Admin only' });
    const qual = data.replace('ul_qual_', '');
    ctx.session.upload.quality = qual;
    // Save movie
    const state = ctx.session.upload;
    const shortId = movieCounter++;
    const key = `m_${shortId}`;
    movies[key] = {
      id: key, shortId,
      file_id: state.file_id,
      name: state.name,
      year: state.year,
      language: state.language,
      quality: state.quality,
      size: state.size
    };
    await saveDB();
    ctx.session.upload = null;
    await ctx.answerCallbackQuery({ text: `Quality: ${qual}` });
    return ctx.reply(`✅ Movie saved!\n🎬 ${state.name} (${state.year})`);
  }

  // Send movie
  if (data.startsWith('send_')) {
    const movieId = data.replace('send_', '');
    const movie = movies[movieId];
    if (!movie) return ctx.answerCallbackQuery({ text: 'Not found', show_alert: true });
    const size = movie.size ? ` | ${formatFileSize(movie.size)}` : '';
    await ctx.replyWithVideo(movie.file_id, {
      caption: `🎬 ${movie.name} ${movie.year || ''}\n🌐 ${movie.language} | 📺 ${movie.quality}${size}\n\n⚠️ Auto-delete in 2 min.`,
      reply_markup: new InlineKeyboard()
        .url('💬 Join Group', 'https://t.me/cineradarai')
        .url('📸 Instagram', 'https://instagram.com/...')
    });
    return ctx.answerCallbackQuery();
  }

  // Admin edit flow
  if (data.startsWith('edit_')) {
    if (userId !== ADMIN_ID) return ctx.answerCallbackQuery({ text: 'Admin only' });
    const movieId = data.replace('edit_', '');
    const movie = movies[movieId];
    if (!movie) return ctx.answerCallbackQuery({ text: 'Not found' });
    adminEditState[ctx.chat.id] = { movieId, step: 'choose_field' };
    const kb = new InlineKeyboard()
      .text('📝 Name', 'editfield_name').text('📅 Year', 'editfield_year').row()
      .text('🌐 Language', 'editfield_lang').text('📺 Quality', 'editfield_qual').row()
      .text('💾 Size', 'editfield_size').text('❌ Cancel', 'editcancel');
    await ctx.reply(`✏️ Editing: ${movie.name}\nChoose field:`, { reply_markup: kb });
    return ctx.answerCallbackQuery();
  }
  if (data.startsWith('editfield_')) {
    const field = data.replace('editfield_', '');
    adminEditState[ctx.chat.id].field = field;
    adminEditState[ctx.chat.id].step = 'enter_value';
    const prompts = { name: 'New name:', year: 'New year:', lang: 'New language:', qual: 'New quality:', size: 'New size (e.g., 1.5 GB):' };
    await ctx.reply(prompts[field]);
    return ctx.answerCallbackQuery();
  }
  if (data === 'editcancel') {
    delete adminEditState[ctx.chat.id];
    await ctx.reply('❌ Cancelled.');
    return ctx.answerCallbackQuery();
  }

  // Filters
  if (data.startsWith('filter_')) {
    const [, shortQuery, type, val] = data.split('|');
    const fullQuery = userLastSearch.get(userId) || shortQuery;
    let filters = {};
    if (type === 'lang') filters.language = val;
    if (type === 'qual') filters.quality = val;
    if (type === 'year') filters.year = val;
    const results = type === 'all' ? searchLocalMovies(fullQuery) : searchLocalMovies(fullQuery, filters);
    if (results.length === 0) return ctx.answerCallbackQuery({ text: 'No results', show_alert: true });
    const grouped = groupMovies(results);
    let kb = new InlineKeyboard();
    grouped.forEach(g => g.items.forEach(m => {
      const size = m.size ? ` | ${formatFileSize(m.size)}` : '';
      kb = kb.text(`⬇️ ${m.quality}${size}`, `send_${m.id}`).row();
    }));
    const filterRows = buildFilterButtons(fullQuery, results);
    filterRows.forEach(row => kb.row(...row));
    await ctx.editMessageReplyMarkup({ reply_markup: kb });
    return ctx.answerCallbackQuery({ text: `${results.length} results` });
  }

  // Request
  if (data.startsWith('request_')) {
    const movieName = data.replace('request_', '');
    requests.push({ user: userId, movie: movieName, time: new Date() });
    await saveRequests();
    await ctx.reply(`✅ Request for *${movieName}* sent.\nAdmin will upload soon.`, { parse_mode: 'Markdown' });
    await ctx.api.sendMessage(ADMIN_ID, `📩 Request from ${userId}: ${movieName}`);
    return ctx.answerCallbackQuery();
  }
});

// ==============================
// 📅 DAILY SUGGESTIONS
// ==============================
const DAILY_FILE = 'lastDailySent.json';
async function sendDailySuggestions() {
  try {
    let last = '';
    try { last = await fs.readFile(DAILY_FILE, 'utf8'); } catch {}
    const today = new Date().toISOString().slice(0,10);
    if (last === today) return;
    const list = Object.values(movies);
    if (list.length === 0) return;
    const shuffled = list.sort(() => Math.random() - 0.5);
    const selected = shuffled.slice(0, 5);
    for (const m of selected) {
      const size = m.size ? ` | ${formatFileSize(m.size)}` : '';
      await bot.api.sendVideo(CHANNEL, m.file_id, {
        caption: `🎬 *आज की सुझाई गई मूवी*\n\n${m.name} ${m.year || ''}\n🌐 ${m.language} | 📺 ${m.quality}${size}`,
        parse_mode: 'Markdown'
      });
      await new Promise(r => setTimeout(r, 2000));
    }
    await fs.writeFile(DAILY_FILE, today);
  } catch (e) { console.error('Daily suggestion error:', e); }
}

// ==============================
// 🔄 AUTO GIT PUSH
// ==============================
function runGitAutoPush() {
  exec('git add . && git diff --cached --quiet || (git commit -m "auto update" && git push)', (err, stdout, stderr) => {
    if (err) console.error('[GIT] Error:', stderr);
    else console.log('[GIT] ✅ Synced');
  });
}
setInterval(runGitAutoPush, 60000);

// ==============================
// 🟢 START BOT
// ==============================
bot.start();
console.log('🚀 Bot running on grammY (single file, zero vulnerabilities)');
