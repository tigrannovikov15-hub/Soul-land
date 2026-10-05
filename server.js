require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Telegraf, Markup } = require('telegraf');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// СТАТИКА С NO-CACHE
// ============================================================
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if(filePath.endsWith('.html')){
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));
app.use(express.json({ limit: '2mb' }));

app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// ============================================================
// POSTGRES (опционально)
// ============================================================
let db = null;
if(process.env.DATABASE_URL){
  db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('render.com') ? { rejectUnauthorized: false } : false
  });
  (async()=>{
    try{
      await db.query(`
        CREATE TABLE IF NOT EXISTS players (
          telegram_id BIGINT PRIMARY KEY,
          username VARCHAR(64),
          first_name VARCHAR(64),
          save_data JSONB,
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);
      console.log('✅ БД инициализирована');
    }catch(e){ console.error('❌ БД ошибка:', e.message); }
  })();
} else {
  console.log('⚠️ DATABASE_URL не задан — сохранения только в памяти');
}

// Fallback для сохранений без БД
const memSaves = new Map();

// ============================================================
// ВАЛИДАЦИЯ TELEGRAM INITDATA
// ============================================================
function validateInitData(initData){
  if(!initData || !process.env.BOT_TOKEN) return null;
  try{
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if(!hash) return null;
    params.delete('hash');
    const arr = [];
    [...params.keys()].sort().forEach(k => arr.push(`${k}=${params.get(k)}`));
    const str = arr.join('\n');
    const secret = crypto.createHmac('sha256','WebAppData').update(process.env.BOT_TOKEN).digest();
    const comp = crypto.createHmac('sha256', secret).update(str).digest('hex');
    if(comp !== hash) return null;
    const authDate = parseInt(params.get('auth_date') || '0');
    if(Date.now()/1000 - authDate > 86400) return null;
    const u = params.get('user');
    return u ? JSON.parse(u) : null;
  }catch(e){ return null; }
}

// ============================================================
// SAVE / LOAD
// ============================================================
app.get('/api/save', async (req, res) => {
  const user = validateInitData(req.headers['x-telegram-init-data']);
  if(!user) return res.status(401).json({ error: 'unauthorized' });
  try{
    if(db){
      const r = await db.query('SELECT save_data FROM players WHERE telegram_id = $1', [user.id]);
      if(r.rows.length === 0){
        await db.query('INSERT INTO players (telegram_id, username, first_name) VALUES ($1,$2,$3)',
          [user.id, user.username||null, user.first_name||null]);
        return res.json({ ok:true, save:null });
      }
      res.json({ ok:true, save: r.rows[0].save_data || null });
    } else {
      res.json({ ok:true, save: memSaves.get(String(user.id)) || null });
    }
  }catch(e){ res.status(500).json({ error: e.message }); }
});

app.post('/api/save', async (req, res) => {
  const user = validateInitData(req.headers['x-telegram-init-data']);
  if(!user) return res.status(401).json({ error: 'unauthorized' });
  const { data } = req.body || {};
  if(!data) return res.status(400).json({ error: 'no data' });

  // ============ АНТИЧИТ ============
  // Минимальные проверки: не даём обнулить уровни/золото/рейтинг
  const safe = JSON.parse(JSON.stringify(data));
  if(typeof safe.level !== 'number' || safe.level < 1 || safe.level > 200) safe.level = 1;
  if(typeof safe.gold !== 'number' || safe.gold < 0 || safe.gold > 1e9) safe.gold = 0;
  if(typeof safe.rating !== 'number' || safe.rating < 0 || safe.rating > 100000) safe.rating = 0;
  if(typeof safe.exp !== 'number' || safe.exp < 0) safe.exp = 0;
  if(typeof safe.energy !== 'number' || safe.energy < 0 || safe.energy > 1000) safe.energy = 50;

  try{
    if(db){
      await db.query(`
        INSERT INTO players (telegram_id, username, first_name, save_data, updated_at)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (telegram_id) DO UPDATE SET
          username = EXCLUDED.username,
          first_name = EXCLUDED.first_name,
          save_data = EXCLUDED.save_data,
          updated_at = NOW()
      `, [user.id, user.username||null, user.first_name||null, JSON.stringify(safe)]);
    } else {
      memSaves.set(String(user.id), safe);
    }
    res.json({ ok:true });
  }catch(e){ res.status(500).json({ error: e.message }); }
});

// ============================================================
// МАГАЗИН
// ============================================================
const PRICES = {
  energy_pill: { title:'Пилюля энергии', description:'+50 энергии', price:30 },
  gold_pack:   { title:'Мешок золота', description:'+1000 золота', price:50 },
  res_pack:    { title:'Набор ресурсов', description:'+10 трав, +5 кристаллов, +10 руды', price:60 },
  talent_reset:{ title:'Сброс талантов', description:'Вернуть очки', price:40 }
};

app.post('/api/shop/invoice', async (req, res) => {
  const user = validateInitData(req.headers['x-telegram-init-data']);
  if(!user) return res.status(401).json({ error: 'unauthorized' });
  const { itemCode } = req.body || {};
  const item = PRICES[itemCode];
  if(!item) return res.status(400).json({ error: 'unknown item' });
  const bot = global.__bot;
  if(!bot) return res.status(500).json({ error: 'bot not ready' });
  try{
    const link = await bot.telegram.createInvoiceLink({
      title: item.title, description: item.description,
      payload: JSON.stringify({ itemCode, userId: user.id, ts: Date.now() }),
      provider_token: '', currency: 'XTR',
      prices: [{ label: item.title, amount: item.price }]
    });
    res.json({ invoiceLink: link });
  }catch(e){ res.status(500).json({ error: e.message }); }
});

// ============================================================
// СТАРТ
// ============================================================
app.listen(PORT, () => console.log(`🌐 Сервер запущен: ${PORT}`));

// ============================================================
// БОТ
// ============================================================
const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL || (process.env.RENDER_EXTERNAL_HOSTNAME
  ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}` : 'https://example.com');

if(BOT_TOKEN){
  const bot = new Telegraf(BOT_TOKEN);
  global.__bot = bot;

  bot.start((ctx) => {
    const name = ctx.from.first_name || 'Мастер Души';
    ctx.replyWithMarkdown(
      `🐉 *Путь к Бессмертию*\n\nПривет, *${name}*!\n\n` +
      `• Создай персонажа\n• Пройди обучение\n• Поступи в школу\n• Исследуй мир`,
      Markup.inlineKeyboard([
        [Markup.button.webApp('🎮 Играть', WEBAPP_URL)],
        [Markup.button.callback('📜 Как играть', 'help'), Markup.button.callback('👥 Пригласить', 'invite')]
      ])
    );
  });
  bot.help((ctx) => sendHelp(ctx));
  bot.action('help', (ctx) => { ctx.answerCbQuery(); sendHelp(ctx); });
  function sendHelp(ctx){
    ctx.replyWithMarkdown(
      `📜 *Как играть*\n\n1️⃣ Создай персонажа\n2️⃣ 3 дня подготовки\n3️⃣ Экзамен\n4️⃣ Путь по миру`,
      Markup.inlineKeyboard([[Markup.button.webApp('🎮 Играть', WEBAPP_URL)]])
    );
  }
  bot.command('invite', (ctx) => sendInvite(ctx));
  bot.action('invite', (ctx) => { ctx.answerCbQuery(); sendInvite(ctx); });
  function sendInvite(ctx){
    const me = ctx.botInfo.username;
    const link = `https://t.me/${me}?start=ref_${ctx.from.id}`;
    ctx.replyWithMarkdown(
      `👥 *Пригласи друга*\n\n\`${link}\`\n\nЗа друга: +200💰 +20⚡`,
      Markup.inlineKeyboard([
        [Markup.button.url('📤 Поделиться', `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('Играю в «Путь к Бессмертию»! 🐉')}`)]
      ])
    );
  }
  bot.on('pre_checkout_query', (ctx) => ctx.answerPreCheckoutQuery(true).catch(console.error));
  bot.on('successful_payment', (ctx) => {
    const sp = ctx.message.successful_payment;
    let parsed = {};
    try { parsed = JSON.parse(sp.invoice_payload||'{}'); } catch(e){}
    const label = PRICES[parsed.itemCode]?.title || parsed.itemCode;
    ctx.replyWithMarkdown(
      `✅ *Оплата получена!*\n\n${label}\n⭐ ${sp.total_amount}`,
      Markup.inlineKeyboard([[Markup.button.webApp('🎮 Открыть', WEBAPP_URL)]])
    );
  });
  bot.launch(() => console.log('🚀 Бот запущен'))
     .catch((e) => console.error('❌ Ошибка бота:', e));
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
} else {
  console.error('❌ BOT_TOKEN не задан');
}
