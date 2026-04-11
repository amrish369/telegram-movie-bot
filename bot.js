require('dotenv').config();
const { Bot, session, InlineKeyboard } = require('grammy');
const fs = require('fs').promises;
const axios = require('axios');
const Fuse = require('fuse.js');
const { exec } = require('child_process');

// ═══════════════════════════════════════
// 🔐 CONFIG
// ═══════════════════════════════════════
const BOT_TOKEN   = process.env.BOT_TOKEN;
const OMDB_API_KEY = process.env.OMDB_API_KEY;
const ADMIN_ID    = Number(process.env.ADMIN_ID) || 5951923988;
const CHANNEL     = process.env.CHANNEL || '@cineradarai';
const AUTO_DELETE  = 5 * 60 * 1000;   // 5 minutes
const WELCOME_GIF = 'https://media.tenor.com/8d9B7xYkZk0AAAAC/welcome.gif';
const OMDB_BASE   = 'https://www.omdbapi.com/';

if (!BOT_TOKEN)    throw new Error('❌ BOT_TOKEN missing in .env');
if (!OMDB_API_KEY) throw new Error('❌ OMDB_API_KEY missing in .env');

// ═══════════════════════════════════════
// 📁 IN-MEMORY DATABASE
// ═══════════════════════════════════════
let movies   = {};
let requests = [];
let users    = {};
let banned    = {};
let adminEditState = {};
let adminEditMode  = {};
let movieCounter   = 1;

const userLastSearch = new Map();

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
  movies    = await readJSON('movies.json', {});
  requests  = await readJSON('requests.json', []);
  users     = await readJSON('users.json', {});
  banned    = await readJSON('banned.json', {});

  // Migration: ensure all movies have short m_N IDs
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

function scheduleDelete(api, chatId, ...msgIds) {
  setTimeout(() => {
    msgIds.forEach(id => api.deleteMessage(chatId, id).catch(() => {}));
  }, AUTO_DELETE);
}

async function tempReply(ctx, text, options = {}) {
  try {
    const msg = await ctx.reply(text, options);
    const chatId = ctx.chat.id;
    const userMsgId = ctx.message?.message_id;
    scheduleDelete(ctx.api, chatId, msg.message_id, ...(userMsgId ? [userMsgId] : []));
    return msg;
  } catch (e) {
    console.error('tempReply:', e.message);
    return null;
  }
}

async function tempPhoto(ctx, photo, options = {}) {
  try {
    const msg = await ctx.replyWithPhoto(photo, options);
    const chatId = ctx.chat.id;
    const userMsgId = ctx.message?.message_id;
    scheduleDelete(ctx.api, chatId, msg.message_id, ...(userMsgId ? [userMsgId] : []));
    return msg;
  } catch (e) {
    console.error('tempPhoto:', e.message);
    return null;
  }
}

async function tempAnim(ctx, anim, options = {}) {
  try {
    const msg = await ctx.replyWithAnimation(anim, options);
    scheduleDelete(ctx.api, ctx.chat.id, msg.message_id);
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
      username: username   || users[userId].username });
  }
  saveUsers();
}

async function isJoined(userId, ctx) {
  try {
    const r = await ctx.api.getChatMember(CHANNEL, userId);
    return ['member','administrator','creator'].includes(r.status);
  } catch { return false; }
}

// Rate limiter
const rlMap = new Map();
function rateLimit(ctx, next) {
  const uid = ctx.from?.id;
  if (!uid) return next();
  const now = Date.now();
  const d = rlMap.get(uid) || { count: 0, t: now };
  if (now - d.t > 10000) { d.count = 1; d.t = now; }
  else d.count++;
  rlMap.set(uid, d);
  if (d.count > 15) return ctx.reply('⚠️ Too many requests! Slow down a bit.');
  return next();
}

function banCheck(ctx, next) {
  if (banned[ctx.from?.id]) return ctx.reply('🚫 You are banned.');
  return next();
}

// ═══════════════════════════════════════
// 🎬 OMDB
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

// ═══════════════════════════════════════
// 🔍 SEARCH HELPERS
// ═══════════════════════════════════════
function searchMovies(query, filters = {}) {
  const q = query.toLowerCase();
  return Object.values(movies).filter(m => {
    if (!m.name.toLowerCase().includes(q)) return false;
    if (filters.language && (m.language||'').toLowerCase() !== filters.language.toLowerCase()) return false;
    if (filters.quality  && (m.quality ||'').toLowerCase() !== filters.quality.toLowerCase())  return false;
    if (filters.year     && String(m.year) !== String(filters.year))                           return false;
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
    const k = `${m.name.toLowerCase()}|${m.year||'0'}`;
    if (!g[k]) g[k] = { displayName: m.name, year: m.year, items: [] };
    g[k].items.push(m);
  });
  return Object.values(g);
}

// ═══════════════════════════════════════
// 🔘 FILTER BUTTONS
// ═══════════════════════════════════════
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
// 🤖 BOT INIT
// ═══════════════════════════════════════
const bot = new Bot(BOT_TOKEN);
bot.use(session({ initial: () => ({}) }));
bot.use(rateLimit);
bot.use(banCheck);

loadDB().then(() => console.log('📀 DB loaded'));

// ═══════════════════════════════════════
// 🟢 COMMANDS
// ═══════════════════════════════════════
bot.command('start', async ctx => {
  trackUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
  await tempAnim(ctx, WELCOME_GIF, {
    caption: `🎬 *Welcome to CineRadar AI, ${ctx.from.first_name}!*\n\n🔍 Type movie name (min 3 chars) to search.\n⏱️ Messages auto-delete in 5 minutes.`,
    parse_mode: 'Markdown'
  });
});

bot.command('help', async ctx => {
  await tempReply(ctx,
    `🎬 *CineRadar AI — Help*\n\n` +
    `🔍 *Search:* Type movie name (min 3 chars)\n` +
    `📺 *Filters:* Year / Language / Quality buttons appear after search\n` +
    `📩 *Request:* Button appears if movie not found\n\n` +
    `*/myrequests* — Track your requests`,
    { parse_mode: 'Markdown' });
});

bot.command('myrequests', async ctx => {
  const uid = ctx.from.id;
  const reqs = requests.filter(r => r.user === uid);
  if (!reqs.length) return tempReply(ctx, "📭 You haven't requested any movies yet.");
  let txt = `📩 *Your Requests (${reqs.length})*\n\n`;
  reqs.slice(-10).forEach((r,i) => {
    txt += `${i+1}. 🎬 ${r.movie}\n   ${r.status||'Pending'} — ${new Date(r.time).toLocaleDateString()}\n`;
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
  const totalDL = Object.values(movies).reduce((s,m) => s+(m.downloads||0), 0);
  ctx.reply(
    `📊 *Bot Statistics*\n\n` +
    `🎬 Movies: ${Object.keys(movies).length}\n` +
    `👥 Users: ${Object.keys(users).length}\n` +
    `⬇️ Total Downloads: ${totalDL}\n` +
    `📩 Pending Requests: ${requests.filter(r=>!r.status||r.status==='Pending').length}\n` +
    `🚫 Banned: ${Object.keys(banned).length}`,
    { parse_mode: 'Markdown' });
});

bot.command('broadcast', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('❌ Admin only.');
  const text = ctx.message.text.replace('/broadcast','').trim();
  if (!text) return ctx.reply('Usage: /broadcast <message>');
  const ids = Object.keys(users);
  await ctx.reply(`📢 Sending to ${ids.length} users...`);
  let ok = 0, fail = 0;
  for (const uid of ids) {
    try { await ctx.api.sendMessage(uid, `📢 *Announcement*\n\n${text}`, { parse_mode: 'Markdown' }); ok++; }
    catch { fail++; }
    await new Promise(r => setTimeout(r, 50));
  }
  ctx.reply(`✅ Done — Success: ${ok} | Failed: ${fail}`);
});

bot.command('delete', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('❌ Admin only.');
  const id = ctx.message.text.replace('/delete','').trim();
  if (!movies[id]) return ctx.reply('❌ Movie not found. Use /search to find IDs.');
  const name = movies[id].name;
  delete movies[id];
  await saveDB();
  ctx.reply(`✅ Deleted: ${name}`);
});

bot.command('ban', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('❌ Admin only.');
  const id = ctx.message.text.replace('/ban','').trim();
  if (!id) return ctx.reply('Usage: /ban <userId>');
  banned[id] = true; await saveBanned();
  ctx.reply(`✅ Banned: ${id}`);
});

bot.command('unban', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('❌ Admin only.');
  const id = ctx.message.text.replace('/unban','').trim();
  delete banned[id]; await saveBanned();
  ctx.reply(`✅ Unbanned: ${id}`);
});

bot.command('pending', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('❌ Admin only.');
  const pend = requests.filter(r => !r.status || r.status === 'Pending');
  if (!pend.length) return ctx.reply('✅ No pending requests.');
  let txt = `📩 *Pending Requests (${pend.length})*\n\n`;
  const kb = new InlineKeyboard();
  pend.slice(0,20).forEach((r,i) => {
    txt += `${i+1}. 🎬 ${r.movie} (User: ${r.user})\n`;
    kb.text(`✅ ${r.movie.slice(0,20)}`, `req_done_${r.user}_${encodeURIComponent(r.movie)}`).row();
  });
  ctx.reply(txt, { parse_mode: 'Markdown', reply_markup: kb });
});

bot.command('search', async ctx => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('❌ Admin only.');
  const q = ctx.message.text.replace('/search','').trim();
  if (!q) return ctx.reply('Usage: /search <name>');
  const res = searchMovies(q);
  if (!res.length) return ctx.reply('❌ No results.');
  let txt = `🔍 *${res.length} result(s) for "${q}"*\n\n`;
  res.slice(0,15).forEach(m => {
    txt += `\`${m.id}\` — ${m.name} (${m.year||'?'}) | ${m.language||'?'} | ${m.quality||'?'}${m.size?' | '+fmtSize(m.size):''}\n`;
  });
  ctx.reply(txt, { parse_mode: 'Markdown' });
});

// ═══════════════════════════════════════
// 👋 WELCOME NEW GROUP MEMBERS (FIXED)
// ═══════════════════════════════════════
bot.on('message:new_chat_members', async ctx => {
  const chatId = ctx.chat.id;
  const newMembers = ctx.message.new_chat_members;
  for (let member of newMembers) {
    if (member.id === ctx.me.id) continue;
    const firstName = member.first_name;
    const welcomeMsg = `👋 Welcome ${firstName}!\n\n🎬 *CineRadar AI* me aapka swagat hai.\n📌 Movie paane ke liye bas movie ka naam type karein (minimum 3 letters).\n🔍 Example: *Krish*\n\n🔥 Enjoy HD Movies!`;
    try {
      await ctx.api.sendMessage(chatId, welcomeMsg, { parse_mode: 'Markdown' });
    } catch (e) {
      console.error('Group welcome error:', e.message);
    }
  }
});

// ═══════════════════════════════════════
// 🤖 BOT ADDED TO GROUP WELCOME
// ═══════════════════════════════════════
bot.on('my_chat_member', async ctx => {
  const chatId = ctx.chat.id;
  const newStatus = ctx.update.my_chat_member.new_chat_member.status;
  const oldStatus = ctx.update.my_chat_member.old_chat_member.status;
  if (newStatus === 'member' && oldStatus !== 'member') {
    const welcomeMsg = `🤖 *CineRadar AI is now active in this group!*\n\n🎬 Members can search movies by typing the movie name (minimum 3 letters).\n📌 Example: *Krrish*\n\n🔞 No 18+ content allowed.\n👑 Admin contact: @cineradarai_admin`;
    try {
      await ctx.api.sendMessage(chatId, welcomeMsg, { parse_mode: 'Markdown' });
    } catch (e) {
      console.error('Bot added welcome error:', e.message);
    }
  }
});

// ═══════════════════════════════════════
// 📨 MESSAGE HANDLER
// ═══════════════════════════════════════
bot.on('message', async (ctx, next) => {
  const msg    = ctx.message;
  const userId = msg.from.id;
  const isAdmin = userId === ADMIN_ID;

  trackUser(userId, msg.from.first_name, msg.from.username);

  // ── Admin: receive video/document for upload ──
  if (isAdmin && (msg.video || msg.document)) {
    const fileId   = msg.video?.file_id   || msg.document?.file_id;
    const fileSize = msg.video?.file_size || msg.document?.file_size || null;
    ctx.session.upload = { step: 'name', file_id: fileId, size: fileSize };
    return ctx.reply('✅ File received!\n\n📝 *Step 1/4:* Enter movie name:', { parse_mode: 'Markdown' });
  }

  // ── Admin: upload wizard text steps ──
  if (ctx.session.upload && msg.text) {
    const state = ctx.session.upload;
    const text  = sanitize(msg.text);
    if (!text) return;

    if (state.step === 'name') {
      state.name = text; state.step = 'year';
      return ctx.reply('📅 *Step 2/4:* Release year (e.g. 2025):', { parse_mode: 'Markdown' });
    }
    if (state.step === 'year') {
      state.year = text; state.step = 'language';
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
    if (state.step === 'quality') {
      state.quality = text;
      return finishUpload(ctx, state);
    }
    if (state.step === 'language') {
      state.language = text; state.step = 'quality';
      const kb = new InlineKeyboard()
        .text('360p','ul_qual_360p').text('480p','ul_qual_480p').row()
        .text('720p','ul_qual_720p').text('1080p','ul_qual_1080p').row()
        .text('4K UHD','ul_qual_4K').text('HDR','ul_qual_HDR');
      return ctx.reply('📺 *Step 4/4:* Select quality:', { parse_mode: 'Markdown', reply_markup: kb });
    }
    return;
  }

  // ── Admin edit: text input for a field ──
  const editState = adminEditState[ctx.chat.id];
  if (editState?.step === 'enter_value' && msg.text) {
    const movie = movies[editState.movieId];
    if (!movie) { delete adminEditState[ctx.chat.id]; return; }
    const val = sanitize(msg.text);
    if (!val) return ctx.reply('❌ Cannot be empty.');
    if (editState.field === 'name')  movie.name     = val;
    if (editState.field === 'year')  movie.year     = val;
    if (editState.field === 'lang')  movie.language = val;
    if (editState.field === 'qual')  movie.quality  = val;
    if (editState.field === 'size')  {
      const m = val.match(/^([\d.]+)\s*(MB|GB)$/i);
      if (!m) return ctx.reply('❌ Format: 1.5 GB or 700 MB');
      const n = parseFloat(m[1]);
      movie.size = Math.round(m[2].toUpperCase() === 'GB' ? n*1024*1024*1024 : n*1024*1024);
    }
    await saveDB();
    delete adminEditState[ctx.chat.id];
    return ctx.reply(`✅ Updated: *${movie.name}*`, { parse_mode: 'Markdown' });
  }

  // ── User text search ──
  if (!msg.text || msg.text.startsWith('/')) return next();
  if (msg.text.length < 3) return tempReply(ctx, '⚠️ Please enter at least 3 characters.');

  const query = sanitize(msg.text.toLowerCase());
  userLastSearch.set(userId, query);

  if (users[userId]) { users[userId].search_count = (users[userId].search_count||0)+1; saveUsers(); }

  if (!isAdmin && !(await isJoined(userId, ctx))) {
    const kb = new InlineKeyboard().url('📢 Join Channel', `https://t.me/${CHANNEL.replace('@','')}`);
    return tempReply(ctx, '🚫 Please join our channel first!', { reply_markup: kb });
  }

  // ── Try OMDb for poster ──
  const omdb = await fetchOMDb(query);

  if (omdb && omdb.Poster && omdb.Poster !== 'N/A') {
    let caption = `🎬 *${omdb.Title}* (${omdb.Year})\n`;
    if (omdb.Genre    && omdb.Genre    !== 'N/A') caption += `🎭 ${omdb.Genre}\n`;
    if (omdb.imdbRating !== 'N/A')               caption += `⭐ IMDb: ${omdb.imdbRating}/10\n`;
    if (omdb.Runtime  && omdb.Runtime  !== 'N/A') caption += `⏱️ ${omdb.Runtime}\n`;
    if (omdb.Director && omdb.Director !== 'N/A') caption += `🎥 ${omdb.Director}\n`;
    if (omdb.Plot     && omdb.Plot     !== 'N/A') caption += `\n📖 ${omdb.Plot}\n`;

    const matches = searchMovies(omdb.Title);

    if (matches.length > 0) {
      caption += `\n✅ *Available — ${matches.length} version(s)*`;
      const kb = new InlineKeyboard();
      matches.forEach(m => {
        kb.text(movieBtnLabel(m), `send_${m.id}`).row();
        if (isAdmin && adminEditMode[userId]) {
          kb.text(`✏️ Edit "${m.name}"`, `edit_${m.id}`).row();
        }
      });
      if (matches.length > 1) {
        const fkb = buildFilterKeyboard(query, matches);
        caption += `\n🔽 *Filter:*`;
        return tempPhoto(ctx, omdb.Poster, { caption, parse_mode: 'Markdown', reply_markup: mergeKeyboards(kb, fkb) });
      }
      return tempPhoto(ctx, omdb.Poster, { caption, parse_mode: 'Markdown', reply_markup: kb });
    } else {
      caption += `\n❌ *Not available yet.*\n📩 Request below — admin will upload!`;
      const kb = new InlineKeyboard()
        .text('📩 Request This Movie', `request_${encodeURIComponent(omdb.Title)}`).row()
        .url('📢 Join Channel', `https://t.me/${CHANNEL.replace('@','')}`);
      return tempPhoto(ctx, omdb.Poster, { caption, parse_mode: 'Markdown', reply_markup: kb });
    }
  }

  // Fallback local search
  const results = searchMovies(query);
  if (results.length > 0) {
    let txt = `🎬 *Found ${results.length} result(s) for "${sanitize(msg.text)}"*\n\n`;
    const grouped = groupMovies(results);
    grouped.forEach(g => { txt += `• *${g.displayName}* ${g.year||''}\n`; });
    txt += `\n🔽 *Tap to download:*`;

    const kb = new InlineKeyboard();
    results.forEach(m => {
      kb.text(movieBtnLabel(m), `send_${m.id}`).row();
      if (isAdmin && adminEditMode[userId]) {
        kb.text(`✏️ Edit "${m.name}"`, `edit_${m.id}`).row();
      }
    });

    if (results.length > 1) {
      const fkb = buildFilterKeyboard(query, results);
      txt += `\n\n🔽 *Filter:*`;
      return tempReply(ctx, txt, { parse_mode: 'Markdown', reply_markup: mergeKeyboards(kb, fkb) });
    }
    return tempReply(ctx, txt, { parse_mode: 'Markdown', reply_markup: kb });
  }

  const suggestion = fuzzyMatch(query);
  if (suggestion) {
    const sugResults = searchMovies(suggestion);
    if (sugResults.length) {
      const kb = new InlineKeyboard();
      sugResults.forEach(m => kb.text(movieBtnLabel(m), `send_${m.id}`).row());
      return tempReply(ctx, `❓ *"${sanitize(msg.text)}"* not found.\n\nDid you mean *${suggestion}*?`,
        { parse_mode: 'Markdown', reply_markup: kb });
    }
  }

  const omdbFallback = await fetchOMDb(query);
  if (omdbFallback && omdbFallback.Poster && omdbFallback.Poster !== 'N/A') {
    let caption = `🎬 *${omdbFallback.Title}* (${omdbFallback.Year})\n`;
    if (omdbFallback.Plot && omdbFallback.Plot !== 'N/A') caption += `\n📖 ${omdbFallback.Plot}\n`;
    caption += `\n❌ *Not in our database yet.*\n📩 Request below!`;
    const kb = new InlineKeyboard()
      .text('📩 Request This Movie', `request_${encodeURIComponent(omdbFallback.Title)}`).row()
      .url('📢 Join Channel', `https://t.me/${CHANNEL.replace('@','')}`);
    return tempPhoto(ctx, omdbFallback.Poster, { caption, parse_mode: 'Markdown', reply_markup: kb });
  }

  const kb = new InlineKeyboard()
    .text('📩 Request Movie', `request_${encodeURIComponent(query)}`).row()
    .url('📢 Join Channel', `https://t.me/${CHANNEL.replace('@','')}`);
  return tempReply(ctx, `❌ *"${sanitize(msg.text)}"* not found in our database.\n\nRequest it below — admin will upload!`,
    { parse_mode: 'Markdown', reply_markup: kb });
});

function mergeKeyboards(kb1, kb2) {
  const merged = new InlineKeyboard();
  const rows1 = kb1.inline_keyboard || [];
  const rows2 = kb2.inline_keyboard || [];
  [...rows1, ...rows2].forEach(row => merged.row(...row));
  return merged;
}

async function finishUpload(ctx, state) {
  const key = `m_${movieCounter}`;
  movies[key] = {
    id: key, shortId: movieCounter,
    file_id: state.file_id,
    name: state.name,
    year: state.year,
    language: state.language,
    quality: state.quality,
    size: state.size,
    downloads: 0,
    added: new Date().toISOString()
  };
  movieCounter++;
  await saveDB();
  ctx.session.upload = null;
  return ctx.reply(
    `✅ *Movie Saved!*\n\n` +
    `🎬 ${state.name} (${state.year})\n` +
    `🌐 ${state.language} | 📺 ${state.quality}` +
    `${state.size ? ' | '+fmtSize(state.size) : ''}\n` +
    `🆔 ID: \`${key}\``,
    { parse_mode: 'Markdown' }
  );
}

// ═══════════════════════════════════════
// 🔘 CALLBACK HANDLER
// ═══════════════════════════════════════
bot.on('callback_query:data', async ctx => {
  const data   = ctx.callbackQuery.data;
  const userId = ctx.from.id;

  // Upload language
  if (data.startsWith('ul_lang_')) {
    if (userId !== ADMIN_ID) return ctx.answerCallbackQuery({ text: '❌ Admin only' });
    if (!ctx.session.upload) return ctx.answerCallbackQuery({ text: '❌ No active upload session' });
    const lang = data.slice('ul_lang_'.length);
    ctx.session.upload.language = lang;
    ctx.session.upload.step = 'quality';
    await ctx.answerCallbackQuery({ text: `Language: ${lang}` });
    const kb = new InlineKeyboard()
      .text('360p','ul_qual_360p').text('480p','ul_qual_480p').row()
      .text('720p','ul_qual_720p').text('1080p','ul_qual_1080p').row()
      .text('4K UHD','ul_qual_4K').text('HDR','ul_qual_HDR');
    return ctx.reply('📺 *Step 4/4:* Select quality:', { parse_mode: 'Markdown', reply_markup: kb });
  }

  // Upload quality → save
  if (data.startsWith('ul_qual_')) {
    if (userId !== ADMIN_ID) return ctx.answerCallbackQuery({ text: '❌ Admin only' });
    const state = ctx.session.upload;
    if (!state) return ctx.answerCallbackQuery({ text: '❌ No active upload session' });
    state.quality = data.slice('ul_qual_'.length);
    await ctx.answerCallbackQuery({ text: `Quality: ${state.quality}` });
    return finishUpload(ctx, state);
  }

  // Send movie
  if (data.startsWith('send_')) {
    const movieId = data.slice('send_'.length);
    const m = movies[movieId];
    if (!m) return ctx.answerCallbackQuery({ text: '❌ Movie not found', show_alert: true });

    m.downloads = (m.downloads||0) + 1;
    if (users[userId]) users[userId].downloads = (users[userId].downloads||0) + 1;
    saveDB(); saveUsers();

    const caption = `🎬 *${m.name}* (${m.year||'?'})\n🌐 ${m.language||'N/A'} | 📺 ${m.quality||'N/A'}${m.size?' | '+fmtSize(m.size):''}\n\n⏱️ *Auto-deletes in 5 minutes.*`;
    try {
      const sent = await ctx.replyWithVideo(m.file_id, {
        caption, parse_mode: 'Markdown',
        reply_markup: new InlineKeyboard().url('💬 Join Channel', `https://t.me/${CHANNEL.replace('@','')}`)
      });
      scheduleDelete(ctx.api, ctx.chat.id, sent.message_id);
      return ctx.answerCallbackQuery({ text: `📥 ${m.name}` });
    } catch (e) {
      console.error('send video:', e.message);
      return ctx.answerCallbackQuery({ text: '❌ Error sending file.', show_alert: true });
    }
  }

  // Filters (f|query|type|value)
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
    if (!results.length) return ctx.answerCallbackQuery({ text: 'No results for this filter', show_alert: true });

    const kb = new InlineKeyboard();
    results.forEach(m => {
      kb.text(movieBtnLabel(m), `send_${m.id}`).row();
      if (userId === ADMIN_ID && adminEditMode[userId]) {
        kb.text(`✏️ Edit "${m.name}"`, `edit_${m.id}`).row();
      }
    });

    const fkb = buildFilterKeyboard(fullQuery, results);
    const merged = mergeKeyboards(kb, fkb);

    try { await ctx.editMessageReplyMarkup({ reply_markup: merged }); } catch {}
    return ctx.answerCallbackQuery({ text: `${results.length} result(s)` });
  }

  // Old filter_ format
  if (data.startsWith('filter_')) {
    const firstPipe = data.indexOf('|');
    const secondPipe = data.indexOf('|', firstPipe+1);
    if (firstPipe === -1 || secondPipe === -1) return ctx.answerCallbackQuery();
    const shortQ = data.slice('filter_'.length, firstPipe);
    const type   = data.slice(firstPipe+1, secondPipe);
    const val    = data.slice(secondPipe+1);
    const fullQuery = userLastSearch.get(userId) || shortQ;
    let filters = {};
    if (type==='lang') filters.language = val;
    if (type==='qual') filters.quality  = val;
    if (type==='year') filters.year     = val;
    const results = type==='all' ? searchMovies(fullQuery) : searchMovies(fullQuery, filters);
    if (!results.length) return ctx.answerCallbackQuery({ text: 'No results', show_alert: true });
    const kb = new InlineKeyboard();
    results.forEach(m => kb.text(movieBtnLabel(m), `send_${m.id}`).row());
    try { await ctx.editMessageReplyMarkup({ reply_markup: kb }); } catch {}
    return ctx.answerCallbackQuery({ text: `${results.length} result(s)` });
  }

  // Request movie
  if (data.startsWith('request_')) {
    const movieName = decodeURIComponent(data.slice('request_'.length));
    const already = requests.find(r => r.user === userId && r.movie.toLowerCase() === movieName.toLowerCase() && (!r.status || r.status === 'Pending'));
    if (already) return ctx.answerCallbackQuery({ text: '⚠️ Already requested!', show_alert: true });
    requests.push({ user: userId, movie: movieName, time: new Date().toISOString(), status: 'Pending' });
    await saveRequests();
    await ctx.reply(`✅ *Request sent for "${movieName}"!*\n\nAdmin has been notified. Use /myrequests to track.`, { parse_mode: 'Markdown' });
    try {
      await ctx.api.sendMessage(ADMIN_ID, `📩 *New Request*\n\n🎬 ${movieName}\n👤 User: ${userId} (@${ctx.from.username||'N/A'})\n\nUse /pending to manage.`, { parse_mode: 'Markdown' });
    } catch {}
    return ctx.answerCallbackQuery({ text: '✅ Request sent!' });
  }

  // Admin fulfill request
  if (data.startsWith('req_done_')) {
    if (userId !== ADMIN_ID) return ctx.answerCallbackQuery({ text: '❌ Admin only' });
    const rest     = data.slice('req_done_'.length);
    const uIdx     = rest.indexOf('_');
    const reqUser  = rest.slice(0, uIdx);
    const movieName = decodeURIComponent(rest.slice(uIdx+1));
    const req = requests.find(r => String(r.user)===String(reqUser) && r.movie===movieName);
    if (req) {
      req.status = 'Fulfilled'; await saveRequests();
      try { await ctx.api.sendMessage(reqUser, `✅ Your request for *${movieName}* has been fulfilled! Search it now. 🎬`, { parse_mode: 'Markdown' }); } catch {}
    }
    return ctx.answerCallbackQuery({ text: '✅ Marked fulfilled' });
  }

  // ─── ADMIN EDIT FLOW ─────────────────────────────────────
  if (data.startsWith('edit_')) {
    if (userId !== ADMIN_ID) return ctx.answerCallbackQuery({ text: '❌ Admin only' });
    const mid = data.slice('edit_'.length);
    const m = movies[mid];
    if (!m) return ctx.answerCallbackQuery({ text: '❌ Not found' });
    adminEditState[ctx.chat.id] = { movieId: mid, step: 'choose_field' };
    const kb = new InlineKeyboard()
      .text('📝 Name', 'ef_name').text('📅 Year', 'ef_year').row()
      .text('🌐 Language', 'ef_lang').text('📺 Quality', 'ef_qual').row()
      .text('💾 Size', 'ef_size').text('❌ Cancel', 'ef_cancel');
    await ctx.reply(`✏️ Editing: *${m.name}*\nChoose field:`, { parse_mode: 'Markdown', reply_markup: kb });
    return ctx.answerCallbackQuery();
  }

  if (data.startsWith('ef_')) {
    if (userId !== ADMIN_ID) return ctx.answerCallbackQuery({ text: '❌ Admin only' });
    const field = data.slice('ef_'.length);
    if (field === 'cancel') { delete adminEditState[ctx.chat.id]; await ctx.reply('❌ Cancelled.'); return ctx.answerCallbackQuery(); }
    if (!adminEditState[ctx.chat.id]) return ctx.answerCallbackQuery({ text: '❌ No edit session' });
    adminEditState[ctx.chat.id].field = field;
    adminEditState[ctx.chat.id].step  = 'enter_value';
    const prompts = { name:'📝 Enter new name:', year:'📅 Enter new year:',
                      lang:'🌐 Enter new language:', qual:'📺 Enter quality (e.g. 1080p):',
                      size:'💾 Enter size (e.g. 1.5 GB or 700 MB):' };
    await ctx.reply(prompts[field] || 'Enter value:');
    return ctx.answerCallbackQuery();
  }

  return ctx.answerCallbackQuery();
});

// ═══════════════════════════════════════
// 📅 DAILY SUGGESTIONS
// ═══════════════════════════════════════
const DAILY_FILE = 'lastDailySent.json';
async function sendDailySuggestions() {
  try {
    let last = '';
    try { last = (await fs.readFile(DAILY_FILE,'utf8')).trim(); } catch {}
    const today = new Date().toISOString().slice(0,10);
    if (last === today) return;
    const list = Object.values(movies);
    if (!list.length) return;
    const selected = [...list].sort(()=>Math.random()-0.5).slice(0,5);
    for (const m of selected) {
      try {
        await bot.api.sendVideo(CHANNEL, m.file_id, {
          caption: `🎬 *आज की सुझाई गई मूवी*\n\n${m.name} (${m.year||'?'})\n🌐 ${m.language||'N/A'} | 📺 ${m.quality||'N/A'}${m.size?' | '+fmtSize(m.size):''}\n\n📥 Bot पर जाकर डाउनलोड करें!`,
          parse_mode: 'Markdown'
        });
        await new Promise(r => setTimeout(r, 2000));
      } catch (e) { console.error('Daily send error:', m.name, e.message); }
    }
    await fs.writeFile(DAILY_FILE, today);
    console.log(`✅ Daily suggestions sent for ${today}`);
  } catch (e) { console.error('Daily error:', e); }
}
setInterval(sendDailySuggestions, 3600000);
setTimeout(sendDailySuggestions, 5000);

// ═══════════════════════════════════════
// 🔄 AUTO GIT PUSH
// ═══════════════════════════════════════
function gitPush() {
  exec('git add . && git diff --cached --quiet || (git commit -m "auto update [skip ci]" && git push)',
    (err, stdout, stderr) => {
      if (err) console.error('[GIT]', stderr);
      else if (stdout) console.log('[GIT] ✅ Synced');
    });
}
setInterval(gitPush, 60000);

// ═══════════════════════════════════════
// 🛑 GLOBAL ERROR HANDLER
// ═══════════════════════════════════════
bot.catch(err => {
  console.error(`❌ Bot error on update ${err.ctx?.update?.update_id}:`, err.error);
  bot.api.sendMessage(ADMIN_ID, `⚠️ *Bot Error*\n\`\`\`${String(err.error?.message||err.error).slice(0,400)}\`\`\``, { parse_mode: 'Markdown' }).catch(()=>{});
});

// ═══════════════════════════════════════
// 🟢 START
// ═══════════════════════════════════════
bot.start({ onStart: info => console.log(`🚀 @${info.username} running — grammY`) });
