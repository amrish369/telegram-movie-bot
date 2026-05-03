require('dotenv').config();
const { Bot, InlineKeyboard } = require('grammy');
const fs = require('fs').promises;
const axios = require('axios');
const Fuse = require('fuse.js');
const AdmZip = require('adm-zip');
const { exec } = require('child_process');

// ═══════════════════════════════════
// 🔐 CONFIG
// ═══════════════════════════════════
const HELPER_TOKEN = process.env.HELPER_BOT_TOKEN;
if (!HELPER_TOKEN) throw new Error('❌ HELPER_BOT_TOKEN missing in .env');

const ADMIN_IDS = new Set(
  (process.env.ADMIN_ID || '5951923988')
    .split(',')
    .map(id => Number(id.trim()))
    .filter(Boolean)
);

const CHANNEL = process.env.CHANNEL || '@cineradarai';
const TMDB_KEY = process.env.TMDB_API_KEY;
const MAIN_BOT_USERNAME = process.env.BOT_USERNAME || 'cineradarai_bot';
const WEBSITE_URL = process.env.WEBSITE_URL || 'https://www.compressdocument.in/';

// ═══════════════════════════════════
// 📁 SHARED DATABASE (JSON FILES)
// ═══════════════════════════════════
let movies = {};
let requests = [];
let users = {};
let banned = {};
let chatLogs = {};
let dailyQueue = [];
let genreCache = {};
let postedMovies = {};
let backupConfig = {};   // { groupUsername, joinMessage }

// Pagination states
const paginationState = new Map();
const inputState = new Map();

// ═══════════════════════════════════
// 💾 DB HELPERS
// ═══════════════════════════════════
async function readJSON(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}
async function writeJSON(file, data) {
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}

async function loadAll() {
  movies       = await readJSON('movies.json', {});
  requests     = await readJSON('requests.json', []);
  users        = await readJSON('users.json', {});
  banned       = await readJSON('banned.json', {});
  chatLogs     = await readJSON('chatLogs.json', {});
  dailyQueue   = await readJSON('dailyQueue.json', []);
  genreCache   = await readJSON('genreCache.json', {});
  postedMovies = await readJSON('postedMovies.json', {});
  backupConfig = await readJSON('backupConfig.json', {});
}

async function saveMovies()    { await writeJSON('movies.json', movies); }
async function saveRequests()  { await writeJSON('requests.json', requests); }
async function saveUsers()     { await writeJSON('users.json', users); }
async function saveBanned()    { await writeJSON('banned.json', banned); }
async function saveChatLogs()  { await writeJSON('chatLogs.json', chatLogs); }
async function saveDailyQueue(){ await writeJSON('dailyQueue.json', dailyQueue); }
async function saveGenreCache(){ await writeJSON('genreCache.json', genreCache); }
async function saveBackupConfig() { await writeJSON('backupConfig.json', backupConfig); }

// ═══════════════════════════════════
// 🔍 SEARCH UTILITIES
// ═══════════════════════════════════
function searchMovies(query, filters = {}) {
  const q = query.toLowerCase();
  return Object.values(movies).filter(m => {
    if (!m.name.toLowerCase().includes(q)) return false;
    if (filters.language && (m.language||'').toLowerCase() !== filters.language.toLowerCase()) return false;
    if (filters.quality  && (m.quality||'').toLowerCase() !== filters.quality.toLowerCase()) return false;
    if (filters.year     && String(m.year) !== String(filters.year)) return false;
    return true;
  });
}

let fuseIndex = null;
function cleanName(s) { return s.replace(/[^a-zA-Z0-9\s]/g, '').toLowerCase().trim(); }
function rebuildFuse() {
  fuseIndex = new Fuse(Object.values(movies), {
    keys: ['name', { name:'clean', get:m=>cleanName(m.name) }],
    threshold: 0.5, minMatchCharLength: 3, includeScore: true
  });
}
function fuzzyMatch(q, limit=5) {
  if (!fuseIndex) return [];
  return fuseIndex.search(q).filter(r=>r.score<=0.6).slice(0,limit).map(r=>r.item);
}

function fmtSize(b) {
  if (!b) return '';
  const mb = b/(1024*1024);
  return mb>=1024 ? `${(mb/1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}
function escapeMarkdown(t) {
  return String(t||'').replace(/[_*\[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

// ═══════════════════════════════════
// ⌨️ PAGINATION HELPER
// ═══════════════════════════════════
async function sendPaginated(ctx, items, title, itemFormatter, pageSize = 8, backCallback = 'menu_main', extraButtons = null) {
  const userId = ctx.from.id;
  const total = items.length;
  let page = 0;

  const sendPage = async (p) => {
    const start = p * pageSize;
    const chunk = items.slice(start, start + pageSize);
    let text = `*${title} (${start+1}-${Math.min(start+pageSize,total)} / ${total})*\n\n`;
    chunk.forEach((item, i) => text += itemFormatter(item, start+i+1));
    
    const kb = new InlineKeyboard();
    chunk.forEach((item, i) => {
      if (extraButtons) extraButtons(kb, item, start+i+1);
    });
    kb.row();
    if (p > 0) kb.text('⬅️ Previous', `page_${p-1}`);
    kb.text('🏠 Main Menu', 'menu_main');
    if (start + pageSize < total) kb.text('➡️ Next', `page_${p+1}`);

    paginationState.set(userId, { page: p, totalPages: Math.ceil(total/pageSize), type: title, items, itemFormatter, pageSize, extraButtons, backCallback });

    try {
      await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: kb });
    } catch {
      await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: kb });
    }
  };

  await sendPage(0);
}

// ═══════════════════════════════════
// 🏠 MAIN MENU
// ═══════════════════════════════════
async function showMainMenu(ctx, edit = false) {
  await loadAll();
  rebuildFuse();
  const p = requests.filter(r=>!r.status||r.status==='Pending').length;
  const m = Object.keys(movies).length;
  const u = Object.keys(users).length;
  const b = Object.keys(banned).length;
  const backupStatus = backupConfig.groupUsername ? `✅ ${backupConfig.groupUsername}` : '❌ Not set';
  const txt = `📊 *CineRadar Admin Panel*\n\n` +
    `🎬 Movies: ${m}\n👥 Users: ${u}\n📩 Pending: ${p}\n🚫 Banned: ${b}\n` +
    `📢 Backup: ${backupStatus}\n\n` +
    `Select a module:`;

  const kb = new InlineKeyboard()
    .text('📩 Requests', 'm_req').text('👥 Users', 'm_user').row()
    .text('🎬 Movies', 'm_mov').text('📅 Daily', 'm_daily').row()
    .text('📊 Stats', 'm_anal').text('💾 Backup', 'm_backup').row()
    .text('🛠 Tools', 'm_tools').text('⚙️ Monitor', 'm_mon').row()
    .text('📢 Backup Group', 'm_bgp')   // NEW
    .text('🔄 Refresh DB', 'refresh_db');

  if (edit) await ctx.editMessageText(txt, { parse_mode: 'Markdown', reply_markup: kb }).catch(() => ctx.reply(txt, { parse_mode: 'Markdown', reply_markup: kb }));
  else await ctx.reply(txt, { parse_mode: 'Markdown', reply_markup: kb });
}

// ═══════════════════════════════════
// 🤖 BOT INIT
// ═══════════════════════════════════
const bot = new Bot(HELPER_TOKEN);

bot.use(async (ctx, next) => {
  if (!ctx.from || !ADMIN_IDS.has(ctx.from.id)) {
    await ctx.reply('⛔ Unauthorized.').catch(()=>{});
    return;
  }
  return next();
});

bot.command('start', async ctx => { await showMainMenu(ctx); });

// ═══════════════════════════════════
// 🔘 CALLBACK HANDLER
// ═══════════════════════════════════
bot.on('callback_query:data', async ctx => {
  const data = ctx.callbackQuery.data;
  const uid = ctx.from.id;
  await loadAll();
  rebuildFuse();

  // Pagination navigation
  if (data.startsWith('page_')) {
    const page = parseInt(data.split('_')[1]);
    const state = paginationState.get(uid);
    if (!state) return ctx.answerCallbackQuery({ text: 'Session expired' });
    await sendPaginated(ctx, state.items, state.type, state.itemFormatter, state.pageSize, state.backCallback, state.extraButtons);
    return ctx.answerCallbackQuery();
  }

  if (data === 'refresh_db') {
    await ctx.answerCallbackQuery('✅ Refreshed');
    return showMainMenu(ctx, true);
  }

  if (data === 'menu_main') return showMainMenu(ctx, true);

  // ═════════ REQUEST MANAGEMENT ═════
  if (data === 'm_req') {
    const kb = new InlineKeyboard()
      .text('📋 View Pending', 'req_pending')
      .text('🔍 Search', 'req_search').row()
      .text('🧹 Delete All Pending', 'req_delall')
      .text('📄 Export CSV', 'req_csv').row()
      .text('🔙 Back', 'menu_main');
    await ctx.editMessageText('📩 *Request Management*', { parse_mode:'Markdown', reply_markup:kb });
    return ctx.answerCallbackQuery();
  }

  if (data === 'req_pending') {
    const pending = requests.filter(r => !r.status || r.status === 'Pending');
    if (!pending.length) { await ctx.answerCallbackQuery('No pending requests'); return; }
    await sendPaginated(ctx, pending, '📋 Pending Requests', (r, idx) => {
      const uinfo = users[String(r.user)] || {};
      const name = uinfo.username ? `@${uinfo.username}` : uinfo.first_name || r.user;
      return `${idx}. *${escapeMarkdown(r.movie)}*\n   👤 ${escapeMarkdown(name)} (${r.user})\n   📅 ${new Date(r.time).toLocaleDateString('en-IN')}\n\n`;
    }, 5, 'm_req', (kb, r, idx) => {
      kb.text(`✅ Fulfill ${idx}`, `req_ful_${r.user}_${encodeURIComponent(r.movie)}`).row();
    });
    return ctx.answerCallbackQuery();
  }

  if (data === 'req_search') {
    inputState.set(uid, { action:'req_search' });
    await ctx.editMessageText('🔍 Send movie name or user ID.', { reply_markup: new InlineKeyboard().text('Cancel','m_req') });
    return ctx.answerCallbackQuery();
  }

  if (data === 'req_delall') {
    requests = requests.filter(r => r.status && r.status !== 'Pending');
    await saveRequests();
    await ctx.editMessageText('✅ All pending deleted.', { reply_markup: new InlineKeyboard().text('Back','m_req') });
    return ctx.answerCallbackQuery();
  }

  if (data === 'req_csv') {
    let csv = 'User,Movie,Time,Status\n';
    requests.forEach(r => csv += `${r.user},"${r.movie}",${r.time},${r.status||'Pending'}\n`);
    await ctx.replyWithDocument({ source: Buffer.from(csv), filename:'requests.csv' });
    await ctx.answerCallbackQuery();
  }

  if (data.startsWith('req_ful_')) {
    const parts = data.split('_');
    const reqUser = parts[2];
    const movieName = decodeURIComponent(parts.slice(3).join('_'));
    const pendingList = requests.filter(r => (String(r.user)===reqUser) && (!r.status||r.status==='Pending') && r.movie===movieName);
    if (pendingList.length) {
      pendingList[0].status = 'Fulfilled';
      await saveRequests();
      const found = searchMovies(movieName);
      if (found.length) {
        try {
          await ctx.api.sendVideo(reqUser, found[0].file_id, { caption: `🎉 Your request for *${escapeMarkdown(found[0].name)}* is fulfilled!`, parse_mode:'Markdown' });
          await ctx.answerCallbackQuery({ text: '✅ Sent' });
        } catch { await ctx.answerCallbackQuery({ text: '✅ Marked (DM failed)' }); }
      } else await ctx.answerCallbackQuery({ text: '✅ Marked fulfilled' });
    } else await ctx.answerCallbackQuery({ text: 'Not found' });
  }

  // ═════════ USER MANAGEMENT ═════
  if (data === 'm_user') {
    const kb = new InlineKeyboard()
      .text('🔎 Search', 'usr_search')
      .text('📋 Top Users', 'usr_top').row()
      .text('🚫 Banned', 'usr_banned')
      .text('💬 Bulk DM', 'usr_bulkdm').row()
      .text('🔙 Back', 'menu_main');
    await ctx.editMessageText('👥 *User Management*', { parse_mode:'Markdown', reply_markup:kb });
    return ctx.answerCallbackQuery();
  }

  if (data === 'usr_search') {
    inputState.set(uid, { action:'usr_search' });
    await ctx.editMessageText('Send user ID or @username', { reply_markup:new InlineKeyboard().text('Cancel','m_user') });
    return ctx.answerCallbackQuery();
  }

  if (data === 'usr_top') {
    const top = Object.values(users).sort((a,b)=>(b.search_count||0)-(a.search_count||0)).slice(0,20);
    await sendPaginated(ctx, top, '👑 Top Users', (u,i) => {
      const name = u.username ? `@${u.username}` : u.first_name || u.id;
      return `${i}. ${escapeMarkdown(name)} (${u.id}) - ${u.search_count||0} searches\n`;
    }, 10, 'm_user');
    return ctx.answerCallbackQuery();
  }

  if (data === 'usr_banned') {
    const list = Object.keys(banned);
    if (!list.length) { await ctx.answerCallbackQuery('No banned users'); return; }
    await sendPaginated(ctx, list, '🚫 Banned Users', (id,i) => {
      const info = users[id]||{};
      const name = info.first_name || id;
      return `${i}. ${escapeMarkdown(name)} (${id})\n`;
    }, 10, 'm_user', (kb, id, i) => {
      kb.text(`✅ Unban ${i}`, `usr_unban_${id}`).row();
    });
    return ctx.answerCallbackQuery();
  }

  if (data.startsWith('usr_unban_')) {
    const id = data.split('_')[2];
    delete banned[id];
    await saveBanned();
    await ctx.answerCallbackQuery('Unbanned');
  }

  if (data === 'usr_bulkdm') {
    inputState.set(uid, { action:'usr_bulkdm' });
    await ctx.editMessageText('Send message to broadcast to all users.', { reply_markup:new InlineKeyboard().text('Cancel','m_user') });
    return ctx.answerCallbackQuery();
  }

  if (data.startsWith('usr_dm_')) {
    const target = data.split('_')[2];
    inputState.set(uid, { action:'usr_dm', target });
    await ctx.editMessageText(`Send message to DM user ${target}`, { reply_markup:new InlineKeyboard().text('Cancel','m_user') });
    return ctx.answerCallbackQuery();
  }

  if (data.startsWith('usr_hist_')) {
    const target = data.split('_')[2];
    const logs = chatLogs[target] || [];
    if (!logs.length) { await ctx.answerCallbackQuery('No history'); return; }
    await sendPaginated(ctx, logs, `💬 Chat History (${target})`, (log,i) => {
      const time = new Date(log.time).toLocaleString('en-IN');
      const icon = log.role === 'user' ? '👤' : '🤖';
      return `${icon} *${log.role}* [${time}]\n${escapeMarkdown(log.text.slice(0,200))}\n\n`;
    }, 6, 'm_user', (kb, log, i) => {
      kb.text('🗑️ Delete', `usr_delhist_${target}`).row();
    });
    return ctx.answerCallbackQuery();
  }

  if (data.startsWith('usr_delhist_')) {
    const target = data.split('_')[2];
    delete chatLogs[target];
    await saveChatLogs();
    await ctx.answerCallbackQuery('History deleted');
  }

  // ═════════ MOVIE DATABASE ═════
  if (data === 'm_mov') {
    const kb = new InlineKeyboard()
      .text('🔍 Search', 'mov_search')
      .text('📊 Stats', 'mov_stats').row()
      .text('🗑️ Delete by ID', 'mov_delete')
      .text('🔄 Cache Genres', 'mov_cache').row()
      .text('🔙 Back', 'menu_main');
    await ctx.editMessageText('🎬 *Movie Database*', { parse_mode:'Markdown', reply_markup:kb });
    return ctx.answerCallbackQuery();
  }

  if (data === 'mov_search') {
    inputState.set(uid, { action:'mov_search' });
    await ctx.editMessageText('Send movie name or ID.', { reply_markup:new InlineKeyboard().text('Cancel','m_mov') });
    return ctx.answerCallbackQuery();
  }

  if (data === 'mov_stats') {
    const top = Object.values(movies).sort((a,b)=>(b.downloads||0)-(a.downloads||0)).slice(0,20);
    await sendPaginated(ctx, top, '📊 Top Downloaded', (m,i) => {
      return `${i}. *${escapeMarkdown(m.name)}* (${m.year||'?'}) - ${m.downloads||0} downloads\n`;
    }, 10, 'm_mov');
    return ctx.answerCallbackQuery();
  }

  if (data === 'mov_delete') {
    inputState.set(uid, { action:'mov_delete' });
    await ctx.editMessageText('Send movie ID to delete.', { reply_markup:new InlineKeyboard().text('Cancel','m_mov') });
    return ctx.answerCallbackQuery();
  }

  if (data === 'mov_cache') {
    const allMovies = Object.values(movies);
    const missing = allMovies.filter(m => !genreCache[m.id]?.genre);
    if (!missing.length) {
      await ctx.answerCallbackQuery('All cached');
      return;
    }
    const msg = await ctx.editMessageText(`🔄 Caching genres for ${missing.length} movies...`);
    let done=0, fail=0;
    for (const m of missing) {
      try {
        if (TMDB_KEY) {
          const res = await axios.get(`https://api.themoviedb.org/3/search/movie`, { params: { api_key: TMDB_KEY, query: m.name } });
          if (res.data.results.length) {
            const det = await axios.get(`https://api.themoviedb.org/3/movie/${res.data.results[0].id}`, { params: { api_key: TMDB_KEY } });
            if (det.data.genres) {
              genreCache[m.id] = { genre: det.data.genres.map(g=>g.name).join(', '), plot: det.data.overview||'', rating: det.data.vote_average?String(det.data.vote_average.toFixed(1)):'', fetched: new Date().toISOString() };
              done++;
            }
          }
        }
      } catch { fail++; }
      await new Promise(r=>setTimeout(r,300));
    }
    await saveGenreCache();
    await ctx.editMessageText(`✅ Cached: ${done} found, ${fail} failed.`);
    return ctx.answerCallbackQuery();
  }

  if (data.startsWith('mov_edit_')) {
    const mid = data.split('_')[2];
    const movie = movies[mid];
    if (!movie) { await ctx.answerCallbackQuery('Not found'); return; }
    const kb = new InlineKeyboard()
      .text('Name', `medit_${mid}_name`).text('Year', `medit_${mid}_year`).row()
      .text('Language', `medit_${mid}_lang`).text('Quality', `medit_${mid}_qual`).row()
      .text('Size', `medit_${mid}_size`).text('Delete', `mov_del_${mid}`).row()
      .text('Post to Channel', `mov_post_${mid}`).text('Back', 'm_mov');
    await ctx.editMessageText(`✏️ Editing *${escapeMarkdown(movie.name)}*`, { parse_mode:'Markdown', reply_markup:kb });
    return ctx.answerCallbackQuery();
  }

  if (data.startsWith('medit_')) {
    const parts = data.split('_');
    const mid = parts[1], field = parts[2];
    inputState.set(uid, { action:'mov_edit_field', mid, field });
    const prompts = { name:'Enter new name', year:'Enter year', lang:'Enter language', qual:'Enter quality', size:'Enter size (e.g. 1.5 GB)' };
    await ctx.editMessageText(`📝 ${prompts[field]}`, { reply_markup:new InlineKeyboard().text('Cancel','m_mov') });
    return ctx.answerCallbackQuery();
  }

  if (data.startsWith('mov_del_')) {
    const mid = data.split('_')[2];
    if (movies[mid]) {
      delete movies[mid];
      await saveMovies();
      rebuildFuse();
      await ctx.answerCallbackQuery('Deleted');
    }
  }

  if (data.startsWith('mov_post_')) {
    const mid = data.split('_')[2];
    const m = movies[mid];
    if (m) {
      try {
        await ctx.api.sendVideo(CHANNEL, m.file_id, { caption: `${m.name} (${m.year||'?'})` });
        await ctx.answerCallbackQuery('Posted');
      } catch { await ctx.answerCallbackQuery('Failed'); }
    }
  }

  // ═════════ DAILY QUEUE ═════
  if (data === 'm_daily') {
    const kb = new InlineKeyboard()
      .text('📋 View Queue', 'dq_view')
      .text('➕ Add', 'dq_add').row()
      .text('🧹 Clear All', 'dq_clear')
      .text('🔙 Back', 'menu_main');
    await ctx.editMessageText('📅 *Daily Post Control*', { parse_mode:'Markdown', reply_markup:kb });
    return ctx.answerCallbackQuery();
  }

  if (data === 'dq_view') {
    if (!dailyQueue.length) { await ctx.answerCallbackQuery('Empty'); return; }
    let txt = '*📅 Daily Queue*\n\n';
    dailyQueue.sort((a,b)=>a.date.localeCompare(b.date)).forEach(e => {
      txt += `*${e.date}*\n`;
      e.items.forEach(i => txt += `  ${i.type==='new'?'🆕':'🔮'} ${escapeMarkdown(i.movieData.Title)} (${i.movieData.Year})\n`);
    });
    await ctx.editMessageText(txt, { parse_mode:'Markdown', reply_markup: new InlineKeyboard().text('Back','m_daily') });
    return ctx.answerCallbackQuery();
  }

  if (data === 'dq_add') {
    inputState.set(uid, { action:'dq_add_type' });
    const kb = new InlineKeyboard().text('🆕 New', 'dq_type_new').text('🔮 Upcoming', 'dq_type_up').text('Cancel','m_daily');
    await ctx.editMessageText('Select type:', { reply_markup:kb });
    return ctx.answerCallbackQuery();
  }

  if (data.startsWith('dq_type_')) {
    const type = data === 'dq_type_new' ? 'new' : 'upcoming';
    inputState.set(uid, { action:'dq_add_name', type });
    await ctx.editMessageText('Send movie name to add.', { reply_markup:new InlineKeyboard().text('Cancel','m_daily') });
    return ctx.answerCallbackQuery();
  }

  if (data === 'dq_clear') {
    dailyQueue = [];
    await saveDailyQueue();
    await ctx.editMessageText('✅ Cleared.', { reply_markup:new InlineKeyboard().text('Back','m_daily') });
    return ctx.answerCallbackQuery();
  }

  // ═════════ BACKUP ═════
  if (data === 'm_backup') {
    const kb = new InlineKeyboard()
      .text('💾 Backup Now', 'backup_now')
      .text('♻️ Restore', 'backup_restore').row()
      .text('🔙 Back', 'menu_main');
    await ctx.editMessageText('💾 Backup & Restore', { parse_mode:'Markdown', reply_markup:kb });
    return ctx.answerCallbackQuery();
  }

  if (data === 'backup_now') {
    try {
      const zip = new AdmZip();
      const files = ['movies.json','requests.json','users.json','banned.json','chatLogs.json','dailyQueue.json','genreCache.json','postedMovies.json','backupConfig.json'];
      for (const f of files) {
        try { const content = await fs.readFile(f); zip.addFile(f, content); } catch {}
      }
      const buffer = zip.toBuffer();
      await ctx.replyWithDocument({ source: buffer, filename: `backup_${new Date().toISOString().slice(0,10)}.zip` });
      await ctx.answerCallbackQuery({ text: '✅ Backup sent' });
    } catch (e) { await ctx.answerCallbackQuery({ text: 'Error: '+e.message }); }
  }

  if (data === 'backup_restore') {
    await ctx.editMessageText('Send the backup ZIP file to restore.', { reply_markup:new InlineKeyboard().text('Cancel','m_backup') });
    return ctx.answerCallbackQuery();
  }

  // ═════════ TOOLS ═════
  if (data === 'm_tools') {
    const kb = new InlineKeyboard()
      .text('⏱ Auto Delete', 'tool_autodel')
      .text('🗳️ Debate', 'tool_debate').row()
      .text('📢 Broadcast', 'broadcast')
      .text('🔙 Back', 'menu_main');
    await ctx.editMessageText('🛠 Tools', { parse_mode:'Markdown', reply_markup:kb });
    return ctx.answerCallbackQuery();
  }

  if (data === 'tool_autodel') {
    inputState.set(uid, { action:'tool_autodel' });
    await ctx.editMessageText('Send new auto-delete time in minutes.', { reply_markup:new InlineKeyboard().text('Cancel','m_tools') });
    return ctx.answerCallbackQuery();
  }

  if (data === 'tool_debate') {
    inputState.set(uid, { action:'tool_debate' });
    await ctx.editMessageText('Send new debate duration in seconds.', { reply_markup:new InlineKeyboard().text('Cancel','m_tools') });
    return ctx.answerCallbackQuery();
  }

  if (data === 'broadcast') {
    inputState.set(uid, { action:'broadcast' });
    await ctx.editMessageText('Send message to broadcast to all users.', { reply_markup:new InlineKeyboard().text('Cancel','m_tools') });
    return ctx.answerCallbackQuery();
  }

  // ═════════ MONITOR ═════
  if (data === 'm_mon') {
    let status = '❓';
    if (process.env.BOT_TOKEN) {
      try { await axios.get(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/getMe`); status='✅ Online'; } catch { status='❌ Offline'; }
    }
    const kb = new InlineKeyboard()
      .text('🔁 Git Push', 'mon_gitpush')
      .text('🧹 Cleanup', 'mon_cleanup').row()
      .text('🔙 Back', 'menu_main');
    await ctx.editMessageText(`⚙️ Main Bot: ${status}`, { parse_mode:'Markdown', reply_markup:kb });
    return ctx.answerCallbackQuery();
  }

  if (data === 'mon_gitpush') {
    exec('git pull --rebase origin main && git add . && git commit -m "auto push helper" && git push', (err, stdout, stderr) => {
      if (err) ctx.reply(`❌ Git failed: ${stderr}`);
      else ctx.reply('✅ Git push done.');
    });
    return ctx.answerCallbackQuery({ text:'Pushing...' });
  }

  if (data === 'mon_cleanup') {
    const cutoff = Date.now() - 30*86400000;
    Object.keys(chatLogs).forEach(uid => {
      chatLogs[uid] = chatLogs[uid].filter(m => new Date(m.time).getTime() > cutoff);
    });
    await saveChatLogs();
    await ctx.answerCallbackQuery('Cleaned old logs');
  }

  // ═════════ NEW: BACKUP GROUP MANAGEMENT ═════
  if (data === 'm_bgp') {
    const grp = backupConfig.groupUsername || 'Not set';
    const msg = backupConfig.joinMessage || '';
    const txt = `📢 *Backup Group Settings*\n\n` +
      `🔗 Group: ${grp}\n` +
      `📝 Join Message: ${msg || '(empty)'}\n\n` +
      `Choose action:`;
    const kb = new InlineKeyboard()
      .text('✏️ Set Group', 'bgp_set_group')
      .text('📝 Set Join Message', 'bgp_set_msg').row()
      .text('📢 Broadcast Now', 'bgp_broadcast')
      .text('📋 View Config', 'bgp_view').row()
      .text('🔙 Back', 'menu_main');
    await ctx.editMessageText(txt, { parse_mode:'Markdown', reply_markup:kb });
    return ctx.answerCallbackQuery();
  }

  if (data === 'bgp_set_group') {
    inputState.set(uid, { action:'bgp_set_group' });
    await ctx.editMessageText('Send the backup group username (with @).', { reply_markup:new InlineKeyboard().text('Cancel','m_bgp') });
    return ctx.answerCallbackQuery();
  }

  if (data === 'bgp_set_msg') {
    inputState.set(uid, { action:'bgp_set_msg' });
    await ctx.editMessageText('Send the join message (use {link} for group link).\nExample: "Join our backup group: {link}"', { reply_markup:new InlineKeyboard().text('Cancel','m_bgp') });
    return ctx.answerCallbackQuery();
  }

  if (data === 'bgp_broadcast') {
    if (!backupConfig.groupUsername) {
      await ctx.answerCallbackQuery({ text:'Please set group username first', show_alert:true });
      return;
    }
    const link = `https://t.me/${backupConfig.groupUsername.replace('@','')}`;
    const msg = (backupConfig.joinMessage || 'Join our backup group: {link}').replace('{link}', link);
    const allUsers = Object.keys(users);
    let ok=0, fail=0;
    const statusMsg = await ctx.editMessageText(`📢 Broadcasting to ${allUsers.length} users...`).catch(()=>null);
    for (const uid of allUsers) {
      try {
        await ctx.api.sendMessage(uid, `📢 *Important!*\n\n${escapeMarkdown(msg)}`, { parse_mode:'Markdown', disable_web_page_preview: true });
        ok++;
      } catch { fail++; }
      await new Promise(r => setTimeout(r, 50));
    }
    const finalText = `✅ Broadcast finished.\nSuccess: ${ok}\nFailed: ${fail}`;
    if (statusMsg) await ctx.editMessageText(finalText).catch(() => ctx.reply(finalText));
    else await ctx.reply(finalText);
    return ctx.answerCallbackQuery();
  }

  if (data === 'bgp_view') {
    let txt = '*Backup Configuration*\n\n';
    txt += `Group: ${backupConfig.groupUsername || 'Not set'}\n`;
    txt += `Join Message: ${backupConfig.joinMessage || 'Not set'}`;
    await ctx.editMessageText(txt, { parse_mode:'Markdown', reply_markup:new InlineKeyboard().text('Back','m_bgp') });
    return ctx.answerCallbackQuery();
  }

  return ctx.answerCallbackQuery();
});

// ═══════════════════════════════════
// 📨 MESSAGE HANDLER (multi-step inputs)
// ═══════════════════════════════════
bot.on('message', async ctx => {
  const uid = ctx.from.id;
  const state = inputState.get(uid);
  if (!state) return;
  const text = ctx.message.text?.trim();

  // ── Request Search ──
  if (state.action === 'req_search') {
    if (!text) return;
    const results = requests.filter(r => r.movie.toLowerCase().includes(text.toLowerCase()) || String(r.user)===text);
    if (!results.length) { await ctx.reply('❌ No matches'); inputState.delete(uid); return; }
    await sendPaginated(ctx, results, `🔍 Results for "${text}"`, (r,i) => {
      const uinfo = users[String(r.user)]||{};
      const name = uinfo.username?`@${uinfo.username}`:uinfo.first_name||r.user;
      return `${i}. *${escapeMarkdown(r.movie)}*\n   👤 ${escapeMarkdown(name)} (${r.user})\n   Status: ${r.status||'Pending'}\n\n`;
    }, 8, 'm_req');
    inputState.delete(uid);
    return;
  }

  // ── User Search ──
  if (state.action === 'usr_search') {
    if (!text) return;
    const found = Object.values(users).filter(u => String(u.id)===text || (u.username&&u.username.toLowerCase()===text.toLowerCase().replace('@','')));
    if (!found.length) { await ctx.reply('❌ Not found'); inputState.delete(uid); return; }
    const user = found[0];
    let txt = `👤 *User Profile*\n\n` +
      `🆔 ${user.id}\n✍️ ${escapeMarkdown(user.first_name||'N/A')}\n` +
      `📧 ${user.username ? '@'+user.username : 'N/A'}\n` +
      `📅 First: ${user.first_seen?new Date(user.first_seen).toLocaleDateString('en-IN'):'?'}\n` +
      `🔄 Last: ${user.last_seen?new Date(user.last_seen).toLocaleDateString('en-IN'):'?'}\n` +
      `🔍 Searches: ${user.search_count||0}\n⬇️ Downloads: ${user.downloads||0}\n` +
      `💬 Chat messages: ${chatLogs[String(user.id)]?.length||0}\n` +
      `🚫 Banned: ${banned[user.id]?'Yes':'No'}`;
    const kb = new InlineKeyboard()
      .text(banned[user.id]?'✅ Unban':'🚫 Ban', `usr_toggle_${user.id}`)
      .text('💬 DM', `usr_dm_${user.id}`)
      .text('📜 History', `usr_hist_${user.id}`)
      .text('Back', 'm_user');
    await ctx.reply(txt, { parse_mode:'Markdown', reply_markup:kb });
    inputState.delete(uid);
    return;
  }

  // ── User DM ──
  if (state.action === 'usr_dm') {
    if (!text) return;
    try {
      await ctx.api.sendMessage(state.target, `📣 *Admin:* ${escapeMarkdown(text)}`, { parse_mode:'Markdown' });
      await ctx.reply('✅ Sent');
    } catch { await ctx.reply('❌ Failed'); }
    inputState.delete(uid);
    return;
  }

  // ── Bulk DM / Broadcast ──
  if (state.action === 'usr_bulkdm') {
    if (!text) return;
    const all = Object.keys(users);
    let ok=0, fail=0;
    for (const id of all) {
      try { await ctx.api.sendMessage(id, `📢 *Admin message*\n\n${escapeMarkdown(text)}`, { parse_mode:'Markdown' }); ok++; }
      catch { fail++; }
      await new Promise(r=>setTimeout(r,50));
    }
    await ctx.reply(`📢 Sent to ${ok} users (${fail} failed)`);
    inputState.delete(uid);
    return;
  }

  // ── Movie Search ──
  if (state.action === 'mov_search') {
    if (!text) return;
    let results = searchMovies(text);
    if (!results.length) results = fuzzyMatch(text, 10);
    if (!results.length) { await ctx.reply('❌ No movies'); inputState.delete(uid); return; }
    await sendPaginated(ctx, results, `🎬 Results for "${text}"`, (m,i) => {
      let s = `${i}. *${escapeMarkdown(m.name)}* (${m.year||'?'})\n   🆔 ${m.id} | 🌐 ${m.language||'N/A'} | 📺 ${m.quality||'N/A'}`;
      if (m.size) s += ` | ${fmtSize(m.size)}`;
      s += `\n   ⬇️ ${m.downloads||0}\n\n`;
      return s;
    }, 5, 'm_mov', (kb, m, idx) => {
      kb.text(`✏️ Edit ${idx}`, `mov_edit_${m.id}`).text(`🗑️ Del ${idx}`, `mov_del_${m.id}`).row();
    });
    inputState.delete(uid);
    return;
  }

  // ── Movie Delete by ID ──
  if (state.action === 'mov_delete') {
    if (movies[text]) {
      delete movies[text];
      await saveMovies(); rebuildFuse();
      await ctx.reply('✅ Deleted');
    } else await ctx.reply('❌ ID not found');
    inputState.delete(uid);
    return;
  }

  // ── Movie Edit Field ──
  if (state.action === 'mov_edit_field') {
    const m = movies[state.mid];
    if (!m) { await ctx.reply('Not found'); inputState.delete(uid); return; }
    const val = text;
    if (state.field === 'name') m.name = val;
    else if (state.field === 'year') m.year = val;
    else if (state.field === 'lang') m.language = val;
    else if (state.field === 'qual') m.quality = val;
    else if (state.field === 'size') {
      const match = val.match(/^([\d.]+)\s*(MB|GB)$/i);
      if (!match) { await ctx.reply('❌ Format: 1.5 GB'); return; }
      const num = parseFloat(match[1]);
      m.size = Math.round(match[2].toUpperCase()==='GB' ? num*1024*1024*1024 : num*1024*1024);
    }
    await saveMovies(); rebuildFuse();
    await ctx.reply('✅ Updated');
    inputState.delete(uid);
    return;
  }

  // ── Daily Queue Add Name ──
  if (state.action === 'dq_add_name') {
    if (!text || !TMDB_KEY) { await ctx.reply('❌ Missing movie name or TMDB_KEY'); inputState.delete(uid); return; }
    try {
      const res = await axios.get(`https://api.themoviedb.org/3/search/movie`, { params: { api_key: TMDB_KEY, query: text } });
      if (!res.data.results.length) { await ctx.reply('❌ Not found on TMDB'); inputState.delete(uid); return; }
      const m = res.data.results[0];
      const movieData = {
        Title: m.title,
        Year: m.release_date?.slice(0,4)||'?',
        Poster: m.poster_path?`https://image.tmdb.org/t/p/w500${m.poster_path}`:null,
        Plot: m.overview||'',
        imdbRating: m.vote_average?.toFixed(1)||'N/A',
        Language: m.original_language?.toUpperCase()||'N/A',
        _tmdbId: m.id,
        _releaseDate: m.release_date
      };
      const tomorrow = new Date(Date.now()+86400000).toISOString().slice(0,10);
      let entry = dailyQueue.find(e=>e.date===tomorrow);
      if (!entry) { entry = { date: tomorrow, items: [] }; dailyQueue.push(entry); }
      entry.items.push({ type: state.type, movieData });
      await saveDailyQueue();
      await ctx.reply(`✅ Added "${m.title}" to ${state.type} queue for ${tomorrow}`);
    } catch (e) { await ctx.reply('❌ Error: '+e.message); }
    inputState.delete(uid);
    return;
  }

  // ── Tools: Auto Delete ──
  if (state.action === 'tool_autodel') {
    await ctx.reply(`Auto-delete set to ${text} minutes (config file not changed, update main bot).`);
    inputState.delete(uid);
    return;
  }

  // ── Tools: Debate Duration ──
  if (state.action === 'tool_debate') {
    await ctx.reply(`Debate duration set to ${text}s (config file not changed).`);
    inputState.delete(uid);
    return;
  }

  // ── Tools: Broadcast ──
  if (state.action === 'broadcast') {
    if (!text) return;
    const all = Object.keys(users);
    let ok=0,fail=0;
    for (const id of all) {
      try { await ctx.api.sendMessage(id, text, { parse_mode:'Markdown' }); ok++; } catch { fail++; }
      await new Promise(r=>setTimeout(r,50));
    }
    await ctx.reply(`📢 Broadcast done. ${ok} ok, ${fail} failed`);
    inputState.delete(uid);
    return;
  }

  // ── Backup Group: Set Group ──
  if (state.action === 'bgp_set_group') {
    if (!text) return;
    backupConfig.groupUsername = text.startsWith('@') ? text : `@${text}`;
    await saveBackupConfig();
    await ctx.reply(`✅ Backup group set to ${backupConfig.groupUsername}`);
    inputState.delete(uid);
    return;
  }

  // ── Backup Group: Set Join Message ──
  if (state.action === 'bgp_set_msg') {
    if (!text) return;
    backupConfig.joinMessage = text;
    await saveBackupConfig();
    await ctx.reply(`✅ Join message saved.`);
    inputState.delete(uid);
    return;
  }
});

// Document handler for backup restore
bot.on('message:document', async ctx => {
  const uid = ctx.from.id;
  const state = inputState.get(uid);
  if (state?.action === 'backup_restore') {
    await ctx.reply('Restore feature under development. Please manually replace files.');
    inputState.delete(uid);
  }
});

// ═══════════════════════════════════
// 🚀 START
// ═══════════════════════════════════
bot.catch(err => console.error('Helper error:', err));
bot.start({ drop_pending_updates: true, onStart: () => console.log('🤖 Admin Helper Bot (v3) running...') });
