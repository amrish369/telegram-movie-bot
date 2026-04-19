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
const ADMIN_ID     = Number(process.env.ADMIN_ID);
const CHANNEL      = process.env.CHANNEL      || '@cineradarai';
const BACKUP_GROUP = process.env.BACKUP_GROUP || '-1005223253102';
const WEBSITE_URL  = process.env.WEBSITE_URL  || 'https://www.compressdocument.in/';
const INSTAGRAM_URL = process.env.INSTAGRAM_URL || 'https://www.instagram.com/cineradarai';
const AUTO_DELETE  = 3 * 60 * 1000;
const OMDB_BASE    = 'https://www.omdbapi.com/';
const WELCOME_GIF  = 'https://media.tenor.com/8d9B7xYkZk0AAAAC/welcome.gif';

if (!BOT_TOKEN)    { console.error('BOT_TOKEN missing'); process.exit(1); }
if (!OMDB_API_KEY) { console.error('OMDB_API_KEY missing'); process.exit(1); }
if (!ADMIN_ID)     { console.error('ADMIN_ID missing'); process.exit(1); }

console.log('Config OK | Admin:', ADMIN_ID, '| Channel:', CHANNEL, '| Backup:', BACKUP_GROUP);

// ═══════════════════════════════════════
// 📁 IN-MEMORY DATABASE
// ═══════════════════════════════════════
let movies       = {};
let requests     = [];
let users        = {};
let banned       = {};
let dailyQueue   = [];
let movieCounter = 1;
let adminEditMode = false;
const adminEditState = {};
const userLastSearch = new Map();

// ═══════════════════════════════════════
// 💾 FILE HELPERS
// ═══════════════════════════════════════
async function readJSON(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { return fallback; }
}
async function writeJSON(file, data) {
  try { await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8'); }
  catch (e) { console.error('writeJSON:', file, e.message); }
}
async function loadDB() {
  movies     = await readJSON('movies.json',     {});
  requests   = await readJSON('requests.json',   []);
  users      = await readJSON('users.json',      {});
  banned     = await readJSON('banned.json',     {});
  dailyQueue = await readJSON('dailyQueue.json', []);

  const fixed = {};
  let counter = 1;
  for (const key in movies) {
    const m = movies[key];
    if (key.startsWith('m_')) {
      fixed[key] = m;
      const n = parseInt(key.slice(2));
      if (!isNaN(n) && n >= counter) counter = n + 1;
    } else {
      const nk = 'm_' + counter;
      fixed[nk] = { ...m, id: nk, shortId: counter, downloads: m.downloads || 0 };
      counter++;
    }
  }
  movies = fixed;
  movieCounter = counter;
  await writeJSON('movies.json', movies);
  rebuildFuse();
  console.log('DB loaded:', Object.keys(movies).length, 'movies,', Object.keys(users).length, 'users');
}
async function saveMovies()   { await writeJSON('movies.json',     movies);     rebuildFuse(); }
async function saveRequests() { await writeJSON('requests.json',   requests);   }
async function saveUsers()    { await writeJSON('users.json',      users);      }
async function saveBanned()   { await writeJSON('banned.json',     banned);     }
async function saveQueue()    { await writeJSON('dailyQueue.json', dailyQueue); }

// ═══════════════════════════════════════
// 🔍 FUSE
// ═══════════════════════════════════════
let fuse = null;
function rebuildFuse() {
  fuse = new Fuse(Object.values(movies), { keys: ['name'], threshold: 0.4, includeScore: true });
}

// ═══════════════════════════════════════
// 🛠️ UTILS
// ═══════════════════════════════════════
function clean(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>]/g, '').trim().slice(0, 200);
}

// Escape for MarkdownV2
function e(text) {
  if (text === null || text === undefined) return '';
  return String(text).replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

function fmtSize(bytes) {
  if (!bytes) return '';
  const mb = bytes / 1048576;
  return mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : Math.round(mb) + ' MB';
}

function btnLabel(m) {
  let s = 'DL ' + m.name;
  if (m.year)     s += ' ' + m.year;
  if (m.language) s += ' | ' + m.language;
  if (m.quality)  s += ' | ' + m.quality;
  if (m.size)     s += ' | ' + fmtSize(m.size);
  return s.slice(0, 60);
}

function isAdmin(ctx) { return ctx.from?.id === ADMIN_ID; }

function trackUser(ctx) {
  const u = ctx.from;
  if (!u) return;
  const now = new Date().toISOString();
  if (!users[u.id]) {
    users[u.id] = { id: u.id, first_name: u.first_name || '', username: u.username || '',
      first_seen: now, last_seen: now, search_count: 0, downloads: 0, website_visited: null };
  } else {
    users[u.id].last_seen  = now;
    users[u.id].first_name = u.first_name || users[u.id].first_name;
    users[u.id].username   = u.username   || users[u.id].username;
  }
  saveUsers();
}

function hasVisitedToday(uid) {
  const v = users[uid]?.website_visited;
  if (!v) return false;
  return new Date(v).toDateString() === new Date().toDateString();
}
function markVisited(uid) {
  if (users[uid]) { users[uid].website_visited = new Date().toISOString(); saveUsers(); }
}

function autoDelete(api, chatId, ...ids) {
  setTimeout(() => ids.forEach(id => id && api.deleteMessage(chatId, id).catch(() => {})), AUTO_DELETE);
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// Safe reply — always returns message, falls back to plain if MarkdownV2 fails
async function safeReply(ctx, text, opts = {}) {
  try {
    return await ctx.reply(text, opts);
  } catch {
    const plain = text.replace(/[\\*_`[\]()~>#+=|{}.!-]/g, '');
    return await ctx.reply(plain, { reply_markup: opts.reply_markup }).catch(() => null);
  }
}

async function safePhoto(ctx, url, opts = {}) {
  try {
    return await ctx.replyWithPhoto(url, opts);
  } catch {
    return await safeReply(ctx, opts.caption || 'Movie found!', { reply_markup: opts.reply_markup });
  }
}

// ═══════════════════════════════════════
// 🔒 FORCE JOIN
// ═══════════════════════════════════════
async function checkMember(api, uid) {
  if (uid === ADMIN_ID) return true;
  for (const chat of [CHANNEL, BACKUP_GROUP]) {
    try {
      const m = await api.getChatMember(chat, uid);
      if (['left', 'kicked'].includes(m.status)) return false;
    } catch (err) {
      console.warn('[JOIN CHECK]', chat, err.message);
    }
  }
  return true;
}

async function enforceJoin(ctx) {
  if (isAdmin(ctx)) return true;
  const ok = await checkMember(ctx.api, ctx.from.id);
  if (ok) return true;

  const chLink = CHANNEL.startsWith('@') ? 'https://t.me/' + CHANNEL.slice(1) : 'https://t.me/cineradarai';
  const bkLink = 'https://t.me/+Pj9i4fPv6kQwNmE1';

  const kb = new InlineKeyboard()
    .url('📢 Join Channel', chLink)
    .url('🔒 Join Backup Group', bkLink)
    .row()
    .text('✅ I have joined', 'check_join');

  await safeReply(ctx,
    e('🔒 Access Restricted!\n\nCineRadar AI use karne ke liye join karein:\n📢 Channel: ') + e(CHANNEL) +
    e('\n🔒 Backup Group: Private Group\n\nJoin karne ke baad ✅ tap karein.'),
    { reply_markup: kb }
  );
  return false;
}

// ═══════════════════════════════════════
// 🎬 OMDB
// ═══════════════════════════════════════
async function omdbFetch(title) {
  try {
    const r = await axios.get(OMDB_BASE, { params: { apikey: OMDB_API_KEY, t: title, plot: 'short' }, timeout: 7000 });
    return r.data?.Response === 'True' ? r.data : null;
  } catch { return null; }
}
async function omdbSearch(query, year = '') {
  try {
    const r = await axios.get(OMDB_BASE, { params: { apikey: OMDB_API_KEY, s: query, y: year, type: 'movie' }, timeout: 7000 });
    return r.data?.Response === 'True' ? r.data.Search || [] : [];
  } catch { return []; }
}

// ═══════════════════════════════════════
// 🇮🇳 INDIAN MOVIES
// ═══════════════════════════════════════
const IND_KW = ['Bollywood','Hindi film','Tamil cinema','Telugu movie','Shah Rukh Khan','Salman Khan','Allu Arjun','Rajinikanth'];
async function fetchIndian(type = 'new', count = 5) {
  const year = type === 'new' ? new Date().getFullYear() : new Date().getFullYear() + 1;
  const all  = [];
  for (const kw of IND_KW) {
    const r = await omdbSearch(kw, String(year));
    all.push(...r);
    if (all.length >= count * 4) break;
    await delay(300);
  }
  const unique = [...new Map(all.map(m => [m.imdbID, m])).values()];
  const result = [];
  for (const m of unique) {
    if (result.length >= count) break;
    const d = await omdbFetch(m.Title);
    if (!d?.Poster || d.Poster === 'N/A') continue;
    const lang    = (d.Language || '').toLowerCase();
    const country = (d.Country  || '').toLowerCase();
    if (lang.includes('hindi') || lang.includes('tamil') || lang.includes('telugu') ||
        lang.includes('malayalam') || lang.includes('kannada') || country.includes('india')) {
      result.push(d);
    }
    await delay(200);
  }
  return result;
}

// ═══════════════════════════════════════
// 🔍 SEARCH
// ═══════════════════════════════════════
function searchDB(query, filters = {}) {
  const q = query.toLowerCase();
  return Object.values(movies).filter(m => {
    if (!m.name?.toLowerCase().includes(q)) return false;
    if (filters.language && m.language?.toLowerCase() !== filters.language.toLowerCase()) return false;
    if (filters.quality  && m.quality?.toLowerCase()  !== filters.quality.toLowerCase())  return false;
    if (filters.year     && String(m.year) !== String(filters.year))                      return false;
    return true;
  });
}
function fuzzySearch(q) {
  if (!fuse) return null;
  const r = fuse.search(q);
  return r.length && r[0].score <= 0.4 ? r[0].item.name : null;
}

const LANGS = ['hindi','english','tamil','telugu','malayalam','kannada','dual audio','multi audio','punjabi','bengali','marathi'];
function parseQuery(raw) {
  let q = raw.toLowerCase().trim();
  const ym = q.match(/\b(19|20)\d{2}\b/);
  const year = ym ? ym[0] : null;
  if (year) q = q.replace(year, '').trim();
  let language = null;
  for (const l of [...LANGS].sort((a,b) => b.length - a.length)) {
    if (new RegExp('\\b' + l + '\\b', 'i').test(q)) {
      language = l.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
      q = q.replace(new RegExp('\\b' + l + '\\b', 'i'), '').trim();
      break;
    }
  }
  return { movieName: q.replace(/\s+/g, ' ').trim() || raw, year, language };
}

function filterKB(query, results) {
  const years = [...new Set(results.map(m => m.year).filter(Boolean))].sort().reverse();
  const langs  = [...new Set(results.map(m => m.language).filter(Boolean))].sort();
  const quals  = [...new Set(results.map(m => m.quality).filter(Boolean))].sort();
  const kb = new InlineKeyboard();
  if (years.length > 1) { years.slice(0,5).forEach(y => kb.text('Y:' + y, 'f|' + query + '|year|' + y)); kb.row(); }
  if (langs.length > 1) { langs.slice(0,4).forEach(l => kb.text('L:' + l, 'f|' + query + '|lang|' + l)); kb.row(); }
  if (quals.length > 1) { quals.slice(0,5).forEach(q => kb.text('Q:' + q, 'f|' + query + '|qual|' + q)); kb.row(); }
  if (years.length > 1 || langs.length > 1 || quals.length > 1) kb.text('All (' + results.length + ')', 'f|' + query + '|all|all');
  return kb;
}
function mergeKB(kb1, kb2) {
  const out  = new InlineKeyboard();
  [...(kb1.inline_keyboard || []), ...(kb2.inline_keyboard || [])].forEach(row => { if (row?.length) out.row(...row); });
  return out;
}

// ═══════════════════════════════════════
// 📤 DELIVER MOVIE
// ═══════════════════════════════════════
async function deliverMovie(ctx, movie) {
  const uid = ctx.from.id;
  movie.downloads = (movie.downloads || 0) + 1;
  if (users[uid]) users[uid].downloads = (users[uid].downloads || 0) + 1;
  saveMovies(); saveUsers();

  const cap =
    '🎬 ' + e(movie.name) + ' \\(' + e(movie.year || '?') + '\\)\n' +
    '🌐 ' + e(movie.language || 'N/A') + ' \\| 📺 ' + e(movie.quality || 'N/A') +
    (movie.size ? ' \\| ' + e(fmtSize(movie.size)) : '') + '\n\n' +
    '⏱ Auto\\-deletes in 3 min — forward \\& save\\!';

  const kb = new InlineKeyboard()
    .url('🌐 Visit Website', WEBSITE_URL)
    .url('📷 Instagram', INSTAGRAM_URL);

  try {
    const sent = await ctx.replyWithVideo(movie.file_id, { caption: cap, parse_mode: 'MarkdownV2', reply_markup: kb });
    if (!isAdmin(ctx)) autoDelete(ctx.api, ctx.chat.id, sent.message_id);
    await ctx.answerCallbackQuery({ text: 'Sending: ' + movie.name });
  } catch (err) {
    console.error('[DELIVER]', err.message);
    await ctx.answerCallbackQuery({ text: 'Error sending file', show_alert: true });
  }
}

// ═══════════════════════════════════════
// 🤖 BOT
// ═══════════════════════════════════════
const bot = new Bot(BOT_TOKEN);
bot.use(session({ initial: () => ({ upload: null }) }));

// Rate limit
const rl = new Map();
bot.use(async (ctx, next) => {
  const uid = ctx.from?.id;
  if (!uid || uid === ADMIN_ID) return next();
  const now = Date.now();
  const d = rl.get(uid) || { n: 0, t: now };
  if (now - d.t > 10000) { d.n = 1; d.t = now; } else d.n++;
  rl.set(uid, d);
  if (d.n > 15) return ctx.reply('Too many requests! Slow down.').catch(() => {});
  return next();
});

// Ban check
bot.use(async (ctx, next) => {
  if (banned[ctx.from?.id]) return ctx.reply('You are banned.').catch(() => {});
  return next();
});

// Auto-delete user messages
bot.use(async (ctx, next) => {
  await next();
  if (!ctx.message || isAdmin(ctx)) return;
  setTimeout(() => ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {}), AUTO_DELETE);
});

// ═══════════════════════════════════════
// ✅ COMMANDS
// ═══════════════════════════════════════
bot.command('start', async ctx => {
  trackUser(ctx);
  if (!(await enforceJoin(ctx))) return;
  const name = e(ctx.from.first_name || 'Friend');
  try {
    const msg = await ctx.replyWithAnimation(WELCOME_GIF, {
      caption: '🎬 *Welcome to CineRadar AI, ' + name + '\\!*\n\n🔍 Movie naam type karein \\(min 3 chars\\)\n⏱ Messages 3 min mein auto\\-delete\n💡 Website daily visit karein 3x speed ke liye\\!',
      parse_mode: 'MarkdownV2'
    });
    if (!isAdmin(ctx)) autoDelete(ctx.api, ctx.chat.id, msg.message_id);
  } catch {
    const msg = await ctx.reply('Welcome to CineRadar AI, ' + (ctx.from.first_name || 'Friend') + '! Type a movie name to search.');
    if (!isAdmin(ctx)) autoDelete(ctx.api, ctx.chat.id, msg.message_id);
  }
});

bot.command('help', async ctx => {
  trackUser(ctx);
  if (!(await enforceJoin(ctx))) return;
  let txt =
    '🎬 *CineRadar AI*\n\n' +
    '🔍 Movie naam type karein \\(min 3 chars\\)\n' +
    '📩 Request button milega agar movie nahi mili\n\n' +
    '/new — New Indian releases\n' +
    '/upcoming — Upcoming movies\n' +
    '/myrequests — Apne requests';
  if (isAdmin(ctx)) {
    txt += '\n\n👑 *Admin:*\n' +
    '/stats /pending /search /delete /broadcast\n' +
    '/ban /unban /edit /queue\\_add /queue\\_view /queue\\_clear';
  }
  const msg = await safeReply(ctx, txt, { parse_mode: 'MarkdownV2' });
  if (msg && !isAdmin(ctx)) autoDelete(ctx.api, ctx.chat.id, msg.message_id);
});

bot.command('new', async ctx => {
  trackUser(ctx);
  if (!(await enforceJoin(ctx))) return;
  const loader = await ctx.reply('Fetching new Indian releases...');
  try {
    const list = await fetchIndian('new', 5);
    ctx.api.deleteMessage(ctx.chat.id, loader.message_id).catch(() => {});
    if (!list.length) return ctx.reply('No new Indian movies found right now.');
    for (const m of list) {
      const kb = new InlineKeyboard()
        .text('📩 Request', 'request_' + encodeURIComponent(m.Title))
        .row().url('🌐 Website', WEBSITE_URL).url('📷 Instagram', INSTAGRAM_URL);
      const cap = '🆕 *' + e(m.Title) + '* \\(' + e(m.Year) + '\\)\n⭐ ' + e(m.imdbRating||'N/A') + '\n🎭 ' + e(m.Genre||'') + '\n📖 ' + e((m.Plot||'').slice(0,200));
      const sent = await safePhoto(ctx, m.Poster, { caption: cap, parse_mode: 'MarkdownV2', reply_markup: kb });
      if (sent && !isAdmin(ctx)) autoDelete(ctx.api, ctx.chat.id, sent.message_id);
      await delay(600);
    }
  } catch (err) {
    ctx.api.deleteMessage(ctx.chat.id, loader.message_id).catch(() => {});
    ctx.reply('Error fetching movies. Try again later.');
    console.error('[NEW]', err.message);
  }
});

bot.command('upcoming', async ctx => {
  trackUser(ctx);
  if (!(await enforceJoin(ctx))) return;
  const loader = await ctx.reply('Fetching upcoming Indian movies...');
  try {
    const list = await fetchIndian('upcoming', 5);
    ctx.api.deleteMessage(ctx.chat.id, loader.message_id).catch(() => {});
    if (!list.length) return ctx.reply('No upcoming movies found right now.');
    for (const m of list) {
      const kb = new InlineKeyboard()
        .text('📩 Request', 'request_' + encodeURIComponent(m.Title))
        .row().url('🌐 Website', WEBSITE_URL).url('📷 Instagram', INSTAGRAM_URL);
      const cap = '🔮 *' + e(m.Title) + '* \\(' + e(m.Year) + '\\)\n⭐ ' + e(m.imdbRating||'N/A') + '\n🎭 ' + e(m.Genre||'') + '\n📖 ' + e((m.Plot||'').slice(0,200));
      const sent = await safePhoto(ctx, m.Poster, { caption: cap, parse_mode: 'MarkdownV2', reply_markup: kb });
      if (sent && !isAdmin(ctx)) autoDelete(ctx.api, ctx.chat.id, sent.message_id);
      await delay(600);
    }
  } catch (err) {
    ctx.api.deleteMessage(ctx.chat.id, loader.message_id).catch(() => {});
    ctx.reply('Error fetching movies. Try again later.');
    console.error('[UPCOMING]', err.message);
  }
});

bot.command('myrequests', async ctx => {
  trackUser(ctx);
  if (!(await enforceJoin(ctx))) return;
  const uid  = ctx.from.id;
  const mine = requests.filter(r => r.user === uid);
  if (!mine.length) return ctx.reply('You have not made any requests yet.').then(m => { if (!isAdmin(ctx)) autoDelete(ctx.api, ctx.chat.id, m.message_id); });
  let txt = '📩 *Your Requests \\(' + mine.length + '\\)*\n\n';
  mine.slice(-10).forEach((r, i) => {
    txt += (i+1) + '\\. *' + e(r.movie) + '*\n   ' + e(r.status||'Pending') + ' — ' + new Date(r.time).toLocaleDateString() + '\n\n';
  });
  const msg = await safeReply(ctx, txt, { parse_mode: 'MarkdownV2' });
  if (msg && !isAdmin(ctx)) autoDelete(ctx.api, ctx.chat.id, msg.message_id);
});

// ─── ADMIN COMMANDS ───────────────────────────────────────────
bot.command('stats', async ctx => {
  if (!isAdmin(ctx)) return ctx.reply('Admin only.');
  const totalDL   = Object.values(movies).reduce((s, m) => s + (m.downloads || 0), 0);
  const pending   = requests.filter(r => !r.status || r.status === 'Pending').length;
  const fulfilled = requests.filter(r => r.status === 'Fulfilled').length;
  const top5      = Object.values(movies).sort((a,b)=>(b.downloads||0)-(a.downloads||0)).slice(0,5);
  let txt =
    '📊 *CineRadar AI Stats*\n\n' +
    '🎬 Movies: *' + Object.keys(movies).length + '*\n' +
    '👥 Users: *' + Object.keys(users).length + '*\n' +
    '⬇️ Total Downloads: *' + totalDL + '*\n' +
    '📩 Pending: *' + pending + '*\n' +
    '✅ Fulfilled: *' + fulfilled + '*\n' +
    '🚫 Banned: *' + Object.keys(banned).length + '*';
  if (top5.length) {
    txt += '\n\n🏆 *Top Downloads:*\n';
    top5.forEach((m,i) => { txt += (i+1) + '\\. ' + e(m.name) + ' — ' + (m.downloads||0) + '\n'; });
  }
  safeReply(ctx, txt, { parse_mode: 'MarkdownV2' });
});

bot.command('pending', async ctx => {
  if (!isAdmin(ctx)) return ctx.reply('Admin only.');
  const pend = requests.filter(r => !r.status || r.status === 'Pending');
  if (!pend.length) return ctx.reply('No pending requests!');
  for (let i = 0; i < pend.length; i += 8) {
    const batch = pend.slice(i, i + 8);
    let txt = i === 0 ? '📩 *Pending \\(' + pend.length + '\\)*\n\n' : '*Continued*\n\n';
    const kb = new InlineKeyboard();
    batch.forEach((r, j) => {
      txt += (i+j+1) + '\\. *' + e(r.movie) + '*\n   ID: `' + r.user + '` — ' + new Date(r.time).toLocaleDateString() + '\n\n';
      kb.text('Done: ' + r.movie.slice(0,20), 'req_done_' + r.user + '_' + encodeURIComponent(r.movie)).row();
    });
    await safeReply(ctx, txt, { parse_mode: 'MarkdownV2', reply_markup: kb });
    await delay(300);
  }
});

bot.command('broadcast', async ctx => {
  if (!isAdmin(ctx)) return ctx.reply('Admin only.');
  const text = ctx.message.text.replace('/broadcast', '').trim();
  if (!text) return ctx.reply('Usage: /broadcast <message>');
  const ids = Object.keys(users);
  const status = await ctx.reply('Sending to ' + ids.length + ' users...');
  let ok = 0, fail = 0;
  for (const uid of ids) {
    try { await ctx.api.sendMessage(Number(uid), '📢 Announcement\n\n' + text); ok++; }
    catch { fail++; }
    await delay(60);
  }
  ctx.api.editMessageText(ctx.chat.id, status.message_id, 'Done! Success: ' + ok + ' | Failed: ' + fail).catch(() => ctx.reply('Done! Success: ' + ok + ' | Failed: ' + fail));
});

bot.command('delete', async ctx => {
  if (!isAdmin(ctx)) return ctx.reply('Admin only.');
  const id = ctx.message.text.replace('/delete', '').trim();
  if (!id) return ctx.reply('Usage: /delete <id>  e.g. /delete m_5');
  if (!movies[id]) return ctx.reply('Movie "' + id + '" not found. Use /search to find IDs.');
  const name = movies[id].name;
  delete movies[id];
  await saveMovies();
  ctx.reply('Deleted: ' + name);
});

bot.command('search', async ctx => {
  if (!isAdmin(ctx)) return ctx.reply('Admin only.');
  const q = ctx.message.text.replace('/search', '').trim();
  if (!q) return ctx.reply('Usage: /search <name>');
  const res = searchDB(q);
  if (!res.length) return ctx.reply('No results for "' + q + '".');
  let txt = '🔍 *' + res.length + ' result\\(s\\) for "' + e(q) + '"*\n\n';
  res.slice(0, 20).forEach(m => {
    txt += '`' + m.id + '` — *' + e(m.name) + '* \\(' + e(m.year||'?') + '\\) \\| ' + e(m.language||'?') + ' \\| ' + e(m.quality||'?') + (m.size ? ' \\| ' + e(fmtSize(m.size)) : '') + '\n';
  });
  safeReply(ctx, txt, { parse_mode: 'MarkdownV2' });
});

bot.command('ban', async ctx => {
  if (!isAdmin(ctx)) return ctx.reply('Admin only.');
  const id = ctx.message.text.replace('/ban', '').trim();
  if (!id || isNaN(Number(id))) return ctx.reply('Usage: /ban <userId>');
  banned[id] = true; await saveBanned();
  ctx.reply('Banned: ' + id);
});

bot.command('unban', async ctx => {
  if (!isAdmin(ctx)) return ctx.reply('Admin only.');
  const id = ctx.message.text.replace('/unban', '').trim();
  if (!id) return ctx.reply('Usage: /unban <userId>');
  delete banned[id]; await saveBanned();
  ctx.reply('Unbanned: ' + id);
});

bot.command('edit', async ctx => {
  if (!isAdmin(ctx)) return ctx.reply('Admin only.');
  adminEditMode = !adminEditMode;
  ctx.reply('Edit mode: ' + (adminEditMode ? 'ON' : 'OFF'));
});

bot.command('queue_add', async ctx => {
  if (!isAdmin(ctx)) return ctx.reply('Admin only.');
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 2) return ctx.reply('Usage: /queue_add new|upcoming <movie name>');
  const type = args[0].toLowerCase();
  if (!['new','upcoming'].includes(type)) return ctx.reply('Type must be new or upcoming.');
  const name = args.slice(1).join(' ');
  const data = await omdbFetch(name);
  if (!data?.Poster || data.Poster === 'N/A') return ctx.reply('Movie not found on OMDb.');
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0,10);
  let entry = dailyQueue.find(e => e.date === tomorrow);
  if (!entry) { entry = { date: tomorrow, items: [] }; dailyQueue.push(entry); }
  entry.items.push({ type, movieData: data });
  await saveQueue();
  ctx.reply('Added "' + data.Title + '" to ' + type + ' queue for ' + tomorrow);
});

bot.command('queue_view', async ctx => {
  if (!isAdmin(ctx)) return ctx.reply('Admin only.');
  if (!dailyQueue.length) return ctx.reply('Queue is empty.');
  let txt = 'Queue:\n\n';
  dailyQueue.sort((a,b) => a.date.localeCompare(b.date)).forEach(en => {
    txt += en.date + ':\n';
    en.items.forEach(i => { txt += '  ' + (i.type==='new'?'NEW':'UPCOMING') + ': ' + i.movieData.Title + '\n'; });
  });
  ctx.reply(txt);
});

bot.command('queue_clear', async ctx => {
  if (!isAdmin(ctx)) return ctx.reply('Admin only.');
  dailyQueue = []; await saveQueue();
  ctx.reply('Queue cleared.');
});

// ═══════════════════════════════════════
// 👋 GROUP EVENTS
// ═══════════════════════════════════════
bot.on('message:new_chat_members', async ctx => {
  for (const member of (ctx.message.new_chat_members || [])) {
    if (member.id === ctx.me.id) continue;
    ctx.reply('Welcome ' + (member.first_name||'') + '! Type a movie name to search. /help for commands.').catch(() => {});
  }
});

bot.on('my_chat_member', async ctx => {
  const n = ctx.update.my_chat_member.new_chat_member.status;
  const o = ctx.update.my_chat_member.old_chat_member.status;
  if (n === 'member' && o !== 'member') {
    ctx.api.sendMessage(ctx.chat.id, 'CineRadar AI is active! Type movie name to search.\n/help for all commands.').then(sent => {
      ctx.api.pinChatMessage(ctx.chat.id, sent.message_id).catch(() => {});
    }).catch(() => {});
  }
});

// ═══════════════════════════════════════
// 📨 MESSAGE HANDLER
// ═══════════════════════════════════════
bot.on('message', async ctx => {
  if (!ctx.message || !ctx.from) return;
  trackUser(ctx);
  const uid   = ctx.from.id;
  const admin = isAdmin(ctx);

  // Admin file upload
  if (admin && (ctx.message.video || ctx.message.document)) {
    const fileId = ctx.message.video?.file_id || ctx.message.document?.file_id;
    const size   = ctx.message.video?.file_size || ctx.message.document?.file_size || null;
    ctx.session.upload = { step: 'name', file_id: fileId, size };
    return ctx.reply('File received! Step 1/4: Enter movie name:');
  }

  // Upload wizard
  if (admin && ctx.session.upload && ctx.message.text && !ctx.message.text.startsWith('/')) {
    const state = ctx.session.upload;
    const text  = clean(ctx.message.text);
    if (!text) return;
    if (state.step === 'name') {
      state.name = text; state.step = 'year';
      return ctx.reply('Step 2/4: Enter release year (e.g. 2024):');
    }
    if (state.step === 'year') {
      if (!/^\d{4}$/.test(text)) return ctx.reply('Enter a valid 4-digit year.');
      state.year = text; state.step = 'language';
      const kb = new InlineKeyboard()
        .text('Hindi',     'ul_Hindi').text('English',  'ul_English').row()
        .text('Dual Audio','ul_Dual Audio').text('Multi','ul_Multi Audio').row()
        .text('Telugu',    'ul_Telugu').text('Tamil',   'ul_Tamil').row()
        .text('Malayalam', 'ul_Malayalam').text('Kannada','ul_Kannada');
      return ctx.reply('Step 3/4: Select language:', { reply_markup: kb });
    }
    if (state.step === 'quality') { state.quality = text; return finishUpload(ctx); }
    return;
  }

  // Admin edit value input
  const es = adminEditState[uid];
  if (admin && es?.step === 'enter_value' && ctx.message.text && !ctx.message.text.startsWith('/')) {
    const movie = movies[es.movieId];
    if (!movie) { delete adminEditState[uid]; return; }
    const val = clean(ctx.message.text);
    if (!val) return ctx.reply('Cannot be empty.');
    if (es.field === 'name')  movie.name     = val;
    if (es.field === 'year')  movie.year     = val;
    if (es.field === 'lang')  movie.language = val;
    if (es.field === 'qual')  movie.quality  = val;
    if (es.field === 'size') {
      const m = val.match(/^([\d.]+)\s*(MB|GB)$/i);
      if (!m) return ctx.reply('Format: 1.5 GB or 700 MB');
      movie.size = Math.round(parseFloat(m[1]) * (m[2].toUpperCase()==='GB' ? 1073741824 : 1048576));
    }
    await saveMovies();
    delete adminEditState[uid];
    return ctx.reply('Updated: ' + movie.name);
  }

  // Skip commands and non-text
  if (!ctx.message.text || ctx.message.text.startsWith('/')) return;
  if (ctx.message.text.length < 3) {
    const msg = await ctx.reply('Please type at least 3 characters.');
    if (!admin) autoDelete(ctx.api, ctx.chat.id, msg.message_id);
    return;
  }

  // Force join for search
  if (!(await enforceJoin(ctx))) return;

  const raw = clean(ctx.message.text);
  const { movieName, year, language } = parseQuery(raw);
  const q = movieName.toLowerCase();
  userLastSearch.set(uid, q);
  if (users[uid]) { users[uid].search_count = (users[uid].search_count||0)+1; saveUsers(); }

  // ── OMDB lookup ──────────────────────────────────────────────
  const omdb = await omdbFetch(movieName);
  if (omdb?.Poster && omdb.Poster !== 'N/A') {
    let matches = searchDB(movieName);
    if (year)     matches = matches.filter(m => String(m.year) === year);
    if (language) matches = matches.filter(m => m.language?.toLowerCase() === language.toLowerCase());

    let cap =
      '🎬 *' + e(omdb.Title) + '* \\(' + e(omdb.Year) + '\\)\n' +
      (omdb.Genre!=='N/A'      ? '🎭 ' + e(omdb.Genre) + '\n'               : '') +
      (omdb.imdbRating!=='N/A' ? '⭐ IMDb: ' + e(omdb.imdbRating) + '/10\n' : '') +
      (omdb.Director!=='N/A'   ? '🎥 ' + e(omdb.Director) + '\n'            : '') +
      (omdb.Plot!=='N/A'       ? '\n📖 ' + e(omdb.Plot.slice(0,250)) + '\n'  : '');

    if (matches.length) {
      cap += '\n✅ *Available — ' + matches.length + ' version\\(s\\)*';
      const kb = new InlineKeyboard();
      matches.forEach(m => {
        kb.text(btnLabel(m), 'send_' + m.id).row();
        if (admin && adminEditMode) kb.text('Edit: ' + m.name.slice(0,20), 'edit_' + m.id).row();
      });
      kb.url('🌐 Website (3x Speed)', WEBSITE_URL).url('📷 Instagram', INSTAGRAM_URL);
      const fkb  = matches.length > 1 ? filterKB(movieName, matches) : null;
      const sent = await safePhoto(ctx, omdb.Poster, { caption: cap, parse_mode: 'MarkdownV2', reply_markup: fkb ? mergeKB(kb,fkb) : kb });
      if (sent && !admin) autoDelete(ctx.api, ctx.chat.id, sent.message_id);
    } else {
      cap += '\n❌ *Not available yet* — request below\\!';
      const kb = new InlineKeyboard()
        .text('📩 Request', 'request_' + encodeURIComponent(omdb.Title))
        .row().url('🌐 Website', WEBSITE_URL).url('📷 Instagram', INSTAGRAM_URL);
      const sent = await safePhoto(ctx, omdb.Poster, { caption: cap, parse_mode: 'MarkdownV2', reply_markup: kb });
      if (sent && !admin) autoDelete(ctx.api, ctx.chat.id, sent.message_id);
    }
    return;
  }

  // ── Local DB ─────────────────────────────────────────────────
  let results = searchDB(movieName);
  if (year)     results = results.filter(m => String(m.year) === year);
  if (language) results = results.filter(m => m.language?.toLowerCase() === language.toLowerCase());
  if (results.length) {
    let txt = '🎬 *Found ' + results.length + ' result\\(s\\) for "' + e(raw) + '"*\n\n';
    results.forEach(m => { txt += '• *' + e(m.name) + '* \\(' + e(m.year||'?') + '\\)\n'; });
    txt += '\n⬇️ *Tap to download:*';
    const kb = new InlineKeyboard();
    results.forEach(m => {
      kb.text(btnLabel(m), 'send_' + m.id).row();
      if (admin && adminEditMode) kb.text('Edit', 'edit_' + m.id).row();
    });
    kb.url('🌐 Website (3x Speed)', WEBSITE_URL).url('📷 Instagram', INSTAGRAM_URL);
    const fkb  = results.length > 1 ? filterKB(movieName, results) : null;
    const sent = await safeReply(ctx, txt, { parse_mode: 'MarkdownV2', reply_markup: fkb ? mergeKB(kb,fkb) : kb });
    if (sent && !admin) autoDelete(ctx.api, ctx.chat.id, sent.message_id);
    return;
  }

  // ── Fuzzy ────────────────────────────────────────────────────
  const sug = fuzzySearch(movieName);
  if (sug) {
    const sugRes = searchDB(sug);
    if (sugRes.length) {
      const kb = new InlineKeyboard();
      sugRes.forEach(m => kb.text(btnLabel(m), 'send_' + m.id).row());
      kb.url('🌐 Website', WEBSITE_URL).url('📷 Instagram', INSTAGRAM_URL);
      const sent = await safeReply(ctx, '"' + raw + '" not found. Did you mean *' + e(sug) + '*?', { parse_mode: 'MarkdownV2', reply_markup: kb });
      if (sent && !admin) autoDelete(ctx.api, ctx.chat.id, sent.message_id);
      return;
    }
  }

  // ── Not found ────────────────────────────────────────────────
  const kb = new InlineKeyboard()
    .text('📩 Request Movie', 'request_' + encodeURIComponent(movieName))
    .row().url('🌐 Website', WEBSITE_URL).url('📷 Instagram', INSTAGRAM_URL);
  const sent = await safeReply(ctx, '"' + raw + '" not found. Request it below!', { reply_markup: kb });
  if (sent && !admin) autoDelete(ctx.api, ctx.chat.id, sent.message_id);
});

// ═══════════════════════════════════════
// 📤 FINISH UPLOAD
// ═══════════════════════════════════════
async function finishUpload(ctx) {
  const state = ctx.session.upload;
  if (!state) return;
  const key = 'm_' + movieCounter;
  movies[key] = {
    id: key, shortId: movieCounter,
    file_id: state.file_id, name: state.name, year: state.year,
    language: state.language, quality: state.quality,
    size: state.size || null, downloads: 0, added: new Date().toISOString()
  };
  movieCounter++;
  await saveMovies();
  ctx.session.upload = null;

  const kb = new InlineKeyboard()
    .text('📢 Post to Channel', 'post_channel_' + key)
    .text('🔒 Post to Backup',  'post_backup_'  + key)
    .row()
    .text('Skip', 'dismiss');

  ctx.reply(
    'Movie Saved!\n\n' + state.name + ' (' + state.year + ')\n' +
    state.language + ' | ' + state.quality + (state.size ? ' | ' + fmtSize(state.size) : '') +
    '\nID: ' + key,
    { reply_markup: kb }
  );
}

// ═══════════════════════════════════════
// 🔘 CALLBACKS
// ═══════════════════════════════════════
bot.on('callback_query:data', async ctx => {
  const data  = ctx.callbackQuery.data;
  const uid   = ctx.from.id;
  const admin = uid === ADMIN_ID;

  // check_join
  if (data === 'check_join') {
    const ok = await checkMember(ctx.api, uid);
    if (ok) {
      await ctx.answerCallbackQuery({ text: 'Access granted! Welcome!' });
      ctx.deleteMessage().catch(() => {});
      ctx.reply('You now have full access. Type a movie name to search!');
    } else {
      await ctx.answerCallbackQuery({ text: 'Please join both the channel and backup group first!', show_alert: true });
    }
    return;
  }

  // visit_done
  if (data === 'visit_done') {
    markVisited(uid);
    await ctx.answerCallbackQuery({ text: '3x speed enabled for today!' });
    ctx.deleteMessage().catch(() => {});
    return;
  }

  // Upload: language
  if (data.startsWith('ul_')) {
    if (!admin) return ctx.answerCallbackQuery({ text: 'Admin only' });
    if (!ctx.session.upload) return ctx.answerCallbackQuery({ text: 'No upload session' });
    ctx.session.upload.language = data.slice(3);
    ctx.session.upload.step     = 'quality';
    await ctx.answerCallbackQuery({ text: 'Language: ' + ctx.session.upload.language });
    const kb = new InlineKeyboard()
      .text('360p','uq_360p').text('480p','uq_480p').row()
      .text('720p','uq_720p').text('1080p','uq_1080p').row()
      .text('4K','uq_4K').text('HDR','uq_HDR');
    return ctx.reply('Step 4/4: Select quality:', { reply_markup: kb });
  }

  // Upload: quality
  if (data.startsWith('uq_')) {
    if (!admin) return ctx.answerCallbackQuery({ text: 'Admin only' });
    if (!ctx.session.upload) return ctx.answerCallbackQuery({ text: 'No upload session' });
    ctx.session.upload.quality = data.slice(3);
    await ctx.answerCallbackQuery({ text: 'Quality: ' + ctx.session.upload.quality });
    return finishUpload(ctx);
  }

  // send_
  if (data.startsWith('send_')) {
    const m = movies[data.slice(5)];
    if (!m) return ctx.answerCallbackQuery({ text: 'Movie not found', show_alert: true });
    if (!hasVisitedToday(uid)) {
      const kb = new InlineKeyboard()
        .url('🌐 Visit Website', WEBSITE_URL)
        .row()
        .text("I've Visited", 'visit_done')
        .text('Download Anyway', 'dl_' + data.slice(5));
      const pm = await ctx.reply('Visit our website for 3x download speed!\n\n1. Visit Website\n2. Come back\n3. Tap "I\'ve Visited"', { reply_markup: kb });
      if (!admin) autoDelete(ctx.api, ctx.chat.id, pm.message_id);
      return ctx.answerCallbackQuery({ text: 'Visit website for 3x speed!' });
    }
    return deliverMovie(ctx, m);
  }

  // dl_ (direct)
  if (data.startsWith('dl_')) {
    const m = movies[data.slice(3)];
    if (!m) return ctx.answerCallbackQuery({ text: 'Movie not found', show_alert: true });
    return deliverMovie(ctx, m);
  }

  // filter
  if (data.startsWith('f|')) {
    const parts = data.split('|');
    if (parts.length < 4) return ctx.answerCallbackQuery();
    const [, q, type, val] = parts;
    const fullQ   = userLastSearch.get(uid) || q;
    const filters = type==='lang'?{language:val}:type==='qual'?{quality:val}:type==='year'?{year:val}:{};
    const results = type==='all' ? searchDB(fullQ) : searchDB(fullQ, filters);
    if (!results.length) return ctx.answerCallbackQuery({ text: 'No results', show_alert: true });
    const kb = new InlineKeyboard();
    results.forEach(m => kb.text(btnLabel(m), 'send_' + m.id).row());
    kb.url('🌐 Website', WEBSITE_URL).url('📷 Instagram', INSTAGRAM_URL);
    const fkb = filterKB(fullQ, results);
    ctx.editMessageReplyMarkup({ reply_markup: mergeKB(kb, fkb) }).catch(() => {});
    return ctx.answerCallbackQuery({ text: results.length + ' result(s)' });
  }

  // request_
  if (data.startsWith('request_')) {
    const name = decodeURIComponent(data.slice(8));
    const dup  = requests.find(r => r.user===uid && r.movie.toLowerCase()===name.toLowerCase() && (!r.status||r.status==='Pending'));
    if (dup) return ctx.answerCallbackQuery({ text: 'Already requested!', show_alert: true });
    requests.push({ user: uid, movie: name, time: new Date().toISOString(), status: 'Pending' });
    await saveRequests();
    const msg = await ctx.reply('Request sent for "' + name + '"! Use /myrequests to track.');
    if (!admin) autoDelete(ctx.api, ctx.chat.id, msg.message_id);
    ctx.api.sendMessage(ADMIN_ID,
      'New Request\n\nMovie: ' + name + '\nUser: ' + (ctx.from.first_name||'') + ' (ID: ' + uid + ')'
    ).catch(() => {});
    return ctx.answerCallbackQuery({ text: 'Request sent!' });
  }

  // edit_
  if (data.startsWith('edit_')) {
    if (!admin) return ctx.answerCallbackQuery({ text: 'Admin only' });
    const mid = data.slice(5);
    const m   = movies[mid];
    if (!m) return ctx.answerCallbackQuery({ text: 'Not found' });
    adminEditState[uid] = { movieId: mid, step: 'choose_field' };
    const kb = new InlineKeyboard()
      .text('Name','ef_name').text('Year','ef_year').row()
      .text('Language','ef_lang').text('Quality','ef_qual').row()
      .text('Size','ef_size').text('Cancel','ef_cancel');
    await ctx.reply('Editing: ' + m.name + '\nChoose field:', { reply_markup: kb });
    return ctx.answerCallbackQuery();
  }

  if (data.startsWith('ef_')) {
    if (!admin) return ctx.answerCallbackQuery({ text: 'Admin only' });
    const field = data.slice(3);
    if (field === 'cancel') { delete adminEditState[uid]; await ctx.reply('Cancelled.'); return ctx.answerCallbackQuery(); }
    adminEditState[uid].field = field;
    adminEditState[uid].step  = 'enter_value';
    const prompts = { name:'Enter new name:', year:'Enter new year:', lang:'Enter new language:', qual:'Enter quality (e.g. 1080p):', size:'Enter size (e.g. 1.5 GB or 700 MB):' };
    await ctx.reply(prompts[field] || 'Enter value:');
    return ctx.answerCallbackQuery();
  }

  // req_done_
  if (data.startsWith('req_done_')) {
    if (!admin) return ctx.answerCallbackQuery({ text: 'Admin only' });
    const rest    = data.slice(9);
    const idx     = rest.indexOf('_');
    const reqUser = rest.slice(0, idx);
    const name    = decodeURIComponent(rest.slice(idx + 1));
    const req     = requests.find(r => String(r.user)===reqUser && r.movie===name);
    if (req) {
      req.status = 'Fulfilled';
      await saveRequests();
      ctx.api.sendMessage(Number(reqUser), 'Your request for "' + name + '" has been fulfilled! Search for it in the bot now.').catch(() => {});
    }
    return ctx.answerCallbackQuery({ text: 'Marked fulfilled + user notified!' });
  }

  // post_channel_
  if (data.startsWith('post_channel_')) {
    if (!admin) return ctx.answerCallbackQuery({ text: 'Admin only' });
    const m = movies[data.slice(13)];
    if (!m) return ctx.answerCallbackQuery({ text: 'Not found' });
    try {
      await ctx.api.sendVideo(CHANNEL, m.file_id, {
        caption: 'New Movie!\n\n' + m.name + ' (' + (m.year||'?') + ')\n' + (m.language||'N/A') + ' | ' + (m.quality||'N/A') + (m.size?' | '+fmtSize(m.size):'') + '\n\nSearch in bot to download!'
      });
      ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard().text('Posted to Channel', 'done') }).catch(() => {});
      return ctx.answerCallbackQuery({ text: 'Posted to channel!' });
    } catch (err) {
      console.error('[POST CH]', err.message);
      return ctx.answerCallbackQuery({ text: 'Failed: ' + err.message, show_alert: true });
    }
  }

  // post_backup_
  if (data.startsWith('post_backup_')) {
    if (!admin) return ctx.answerCallbackQuery({ text: 'Admin only' });
    const m = movies[data.slice(12)];
    if (!m) return ctx.answerCallbackQuery({ text: 'Not found' });
    try {
      await ctx.api.sendVideo(BACKUP_GROUP, m.file_id, {
        caption: 'BACKUP\n\n' + m.name + ' (' + (m.year||'?') + ')\n' + (m.language||'N/A') + ' | ' + (m.quality||'N/A') + (m.size?' | '+fmtSize(m.size):'') + '\nID: ' + m.id
      });
      ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard().text('Posted to Backup', 'done') }).catch(() => {});
      return ctx.answerCallbackQuery({ text: 'Posted to backup group!' });
    } catch (err) {
      console.error('[POST BK]', err.message);
      return ctx.answerCallbackQuery({ text: 'Failed: ' + err.message, show_alert: true });
    }
  }

  if (data === 'dismiss' || data === 'done') {
    ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    return ctx.answerCallbackQuery();
  }

  return ctx.answerCallbackQuery();
});

// ═══════════════════════════════════════
// 📅 DAILY POST
// ═══════════════════════════════════════
async function dailyPost() {
  try {
    const today = new Date().toISOString().slice(0,10);
    let last = '';
    try { last = (await fs.readFile('lastDaily.txt','utf8')).trim(); } catch {}
    if (last === today) { console.log('[DAILY] Already posted today'); return; }
    console.log('[DAILY] Posting...');

    const todayQ = dailyQueue.find(e => e.date === today);
    let newList = [], upList = [];
    if (todayQ?.items?.length) {
      newList = todayQ.items.filter(i=>i.type==='new').map(i=>i.movieData);
      upList  = todayQ.items.filter(i=>i.type==='upcoming').map(i=>i.movieData);
    } else {
      try { newList = await fetchIndian('new',3); } catch {}
      try { upList  = await fetchIndian('upcoming',2); } catch {}
    }

    for (const m of newList) {
      try {
        await bot.api.sendPhoto(CHANNEL, m.Poster, { caption: 'NEW: ' + m.Title + ' (' + m.Year + ')\nIMDb: ' + (m.imdbRating||'N/A') + '\n' + (m.Plot||'').slice(0,200) + '\n\nSearch in bot to request!' });
        await delay(1000);
      } catch {}
    }
    for (const m of upList) {
      try {
        await bot.api.sendPhoto(CHANNEL, m.Poster, { caption: 'UPCOMING: ' + m.Title + ' (' + m.Year + ')\nIMDb: ' + (m.imdbRating||'N/A') + '\n' + (m.Plot||'').slice(0,200) + '\n\nSearch in bot to request!' });
        await delay(1000);
      } catch {}
    }

    const local = Object.values(movies);
    if (local.length) {
      const pick = [...local].sort(()=>Math.random()-0.5).slice(0,Math.min(5,local.length));
      for (const m of pick) {
        try {
          await bot.api.sendVideo(CHANNEL, m.file_id, { caption: "Today's Pick\n\n" + m.name + ' (' + (m.year||'?') + ')\n' + (m.language||'N/A') + ' | ' + (m.quality||'N/A') + '\n\nDownload using the bot!' });
          await delay(2000);
        } catch (err) { console.error('[DAILY local]', err.message); }
      }
    }

    await fs.writeFile('lastDaily.txt', today, 'utf8');
    console.log('[DAILY] Done for', today);
  } catch (err) { console.error('[DAILY]', err.message); }
}

setInterval(() => dailyPost().catch(console.error), 60*60*1000);
setTimeout(() => dailyPost().catch(console.error), 8000);

// ═══════════════════════════════════════
// 🔄 GIT PUSH
// ═══════════════════════════════════════
function gitPush() {
  exec('git add -A && git diff --cached --quiet || (git commit -m "auto [skip ci]" && git push origin main)',
    { timeout: 30000 },
    (err, stdout, stderr) => {
      if (err && !String(stderr).includes('nothing to commit')) console.error('[GIT]', String(stderr).slice(0,100));
    }
  );
}
setInterval(gitPush, 5*60*1000);

// ═══════════════════════════════════════
// 🛑 ERROR HANDLING
// ═══════════════════════════════════════
bot.catch(err => { console.error('Bot error:', err.error?.message || err.error || err); });
process.on('unhandledRejection', e => console.error('Unhandled rejection:', e?.message || e));
process.on('uncaughtException',  e => { console.error('Uncaught exception:', e?.message || e); });

// ═══════════════════════════════════════
// 🟢 START
// ═══════════════════════════════════════
loadDB().then(() => {
  console.log('Starting bot...');
  bot.start({ onStart: info => console.log('Bot running: @' + info.username) });
}).catch(e => { console.error('Startup failed:', e); process.exit(1); });

