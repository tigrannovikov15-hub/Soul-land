require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Telegraf, Markup } = require('telegraf');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '2mb' }));

// ============================================================
// БАЗА ДАННЫХ
// ============================================================
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('render.com')
    ? { rejectUnauthorized: false } : false
});

async function initDb(){
  await db.query(`
    CREATE TABLE IF NOT EXISTS players (
      telegram_id   BIGINT PRIMARY KEY,
      username      VARCHAR(64),
      first_name    VARCHAR(64),
      level         INT DEFAULT 1,
      gold          BIGINT DEFAULT 200,
      energy        INT DEFAULT 50,
      max_energy    INT DEFAULT 50,
      rating        INT DEFAULT 0,
      save_data     JSONB,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW(),
      last_energy_tick TIMESTAMPTZ DEFAULT NOW(),
      banned        BOOLEAN DEFAULT FALSE
    );
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS raid (
      id            INT PRIMARY KEY DEFAULT 1,
      boss_name     VARCHAR(128),
      hp            BIGINT,
      max_hp        BIGINT,
      week_number   INT,
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS raid_damage (
      telegram_id   BIGINT,
      week_number   INT,
      damage        BIGINT DEFAULT 0,
      last_attack   TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (telegram_id, week_number)
    );
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS payments (
      charge_id     VARCHAR(128) PRIMARY KEY,
      telegram_id   BIGINT,
      item_code     VARCHAR(64),
      stars         INT,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('✅ БД инициализирована');
}

// ============================================================
// ВАЛИДАЦИЯ TELEGRAM INITDATA
// ============================================================
function validateInitData(initData){
  if(!initData || !process.env.BOT_TOKEN) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if(!hash) return null;
    params.delete('hash');
    const dataCheckArr = [];
    const sortedKeys = [...params.keys()].sort();
    for(const key of sortedKeys){
      dataCheckArr.push(`${key}=${params.get(key)}`);
    }
    const dataCheckString = dataCheckArr.join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData')
      .update(process.env.BOT_TOKEN).digest();
    const computedHash = crypto.createHmac('sha256', secretKey)
      .update(dataCheckString).digest('hex');
    if(computedHash !== hash) return null;
    const userJson = params.get('user');
    if(!userJson) return null;
    const user = JSON.parse(userJson);
    // Проверяем возраст auth_date (не старше 24ч)
    const authDate = parseInt(params.get('auth_date') || '0');
    if(Date.now() / 1000 - authDate > 86400) return null;
    return user;
  } catch(e){
    console.error('initData validation error:', e.message);
    return null;
  }
}

// Middleware авторизации
async function authMiddleware(req, res, next){
  const initData = req.headers['x-telegram-init-data'];
  const user = validateInitData(initData);
  if(!user) return res.status(401).json({ error: 'unauthorized' });
  req.tgUser = user;
  try {
    const existing = await db.query('SELECT telegram_id FROM players WHERE telegram_id = $1', [user.id]);
    if(existing.rows.length === 0){
      await db.query(
        `INSERT INTO players (telegram_id, username, first_name) VALUES ($1, $2, $3)`,
        [user.id, user.username || null, user.first_name || null]
      );
    } else {
      await db.query(
        `UPDATE players SET username = $2, first_name = $3, updated_at = NOW() WHERE telegram_id = $1`,
        [user.id, user.username || null, user.first_name || null]
      );
    }
    next();
  } catch(e){
    console.error('auth middleware error:', e.message);
    res.status(500).json({ error: 'db error' });
  }
}

// ============================================================
// АУТЕНТИФИКАЦИЯ
// ============================================================
app.post('/api/auth', authMiddleware, async (req, res) => {
  const r = await db.query(
    'SELECT level, gold, energy, max_energy, rating, save_data FROM players WHERE telegram_id = $1',
    [req.tgUser.id]
  );
  const p = r.rows[0];
  res.json({
    ok: true,
    player: {
      telegramId: req.tgUser.id,
      level: p.level,
      gold: p.gold,
      energy: p.energy,
      maxEnergy: p.max_energy,
      rating: p.rating
    },
    save: p.save_data || null
  });
});

// ============================================================
// СОХРАНЕНИЕ
// ============================================================
// Регенерация энергии перед сохранением/получением
function calcEnergy(row){
  const now = Date.now();
  const lastTick = new Date(row.last_energy_tick).getTime();
  const elapsed = now - lastTick;
  const regen = Math.floor(elapsed / (5 * 60 * 1000));
  let energy = row.energy;
  let maxEnergy = row.max_energy;
  let newTick = lastTick;
  if(regen > 0 && energy < maxEnergy){
    const add = Math.min(regen, maxEnergy - energy);
    energy += add;
    newTick = now;
  }
  if(energy >= maxEnergy) newTick = now;
  return { energy, maxEnergy, newTick };
}

app.post('/api/save', authMiddleware, async (req, res) => {
  const { data } = req.body || {};
  if(!data) return res.status(400).json({ error: 'no data' });

  try {
    const cur = await db.query('SELECT * FROM players WHERE telegram_id = $1', [req.tgUser.id]);
    const row = cur.rows[0];
    const e = calcEnergy(row);

    // ============ АНТИ-ЧИТ ============
    // Сервер не доверяет клиенту критичные значения. Принимает только разумные изменения.
    const clientLevel = Math.max(1, Math.min(100, parseInt(data.level) || 1));
    const clientGold = Math.max(0, Math.min(row.gold + 50000, parseInt(data.gold) || row.gold)); // +50k/сессия
    const clientRating = Math.max(0, Math.min(row.rating + 200, parseInt(data.rating) || row.rating));
    const clientEnergy = Math.max(0, Math.min(e.maxEnergy, parseInt(data.energy) || e.energy));

    // Уровень может расти, но не более +5 за сессию
    const newLevel = Math.min(row.level + 5, clientLevel);
    // Энергия: если клиент использовал меньше, чем сервер посчитал — берём серверное
    const finalEnergy = Math.max(e.energy, clientEnergy) > e.maxEnergy
      ? e.maxEnergy : Math.max(e.energy - 50, clientEnergy);

    await db.query(`
      UPDATE players
      SET level = $2, gold = $3, energy = $4, max_energy = $5,
          rating = $6, save_data = $7, updated_at = NOW(), last_energy_tick = to_timestamp($8 / 1000.0)
      WHERE telegram_id = $1
    `, [req.tgUser.id, newLevel, clientGold, finalEnergy, e.maxEnergy,
        clientRating, JSON.stringify(data), e.newTick]);

    res.json({ ok: true, level: newLevel, gold: clientGold, energy: finalEnergy, rating: clientRating });
  } catch(e){
    console.error('save error:', e.message);
    res.status(500).json({ error: 'save failed' });
  }
});

app.get('/api/save', authMiddleware, async (req, res) => {
  const r = await db.query('SELECT * FROM players WHERE telegram_id = $1', [req.tgUser.id]);
  const row = r.rows[0];
  const e = calcEnergy(row);
  await db.query(
    'UPDATE players SET energy = $2, max_energy = $3, last_energy_tick = to_timestamp($4 / 1000.0) WHERE telegram_id = $1',
    [req.tgUser.id, e.energy, e.maxEnergy, e.newTick]
  );
  res.json({
    ok: true,
    player: { level: row.level, gold: row.gold, energy: e.energy, maxEnergy: e.maxEnergy, rating: row.rating },
    save: row.save_data || null
  });
});

// ============================================================
// ЛИДЕРБОРД
// ============================================================
app.get('/api/leaderboard', authMiddleware, async (req, res) => {
  const r = await db.query(
    `SELECT telegram_id, username, first_name, rating, level
     FROM players WHERE rating > 0 AND banned = FALSE
     ORDER BY rating DESC LIMIT 100`
  );
  res.json({
    ok: true,
    players: r.rows.map(row => ({
      telegramId: row.telegram_id,
      name: row.username || row.first_name || 'Игрок',
      rating: row.rating,
      level: row.level,
      isMe: row.telegram_id == req.tgUser.id
    }))
  });
});

// ============================================================
// МИРОВОЙ РЕЙД
// ============================================================
function currentWeek(){
  return Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000));
}

async function ensureRaid(){
  const week = currentWeek();
  const r = await db.query('SELECT * FROM raid WHERE id = 1');
  if(r.rows.length === 0){
    await db.query(
      `INSERT INTO raid (id, boss_name, hp, max_hp, week_number) VALUES (1, $1, $2, $2, $3)`,
      ['🐲 Небесный Дракон Бездны', 500000, week]
    );
  } else if(r.rows[0].week_number !== week){
    await db.query(
      `UPDATE raid SET hp = max_hp, week_number = $1, updated_at = NOW() WHERE id = 1`,
      [week]
    );
    // Обнуляем урон за прошлую неделю
    await db.query('DELETE FROM raid_damage WHERE week_number != $1', [week]);
  }
}

app.get('/api/raid', authMiddleware, async (req, res) => {
  await ensureRaid();
  const r = await db.query('SELECT * FROM raid WHERE id = 1');
  const raid = r.rows[0];
  const d = await db.query(
    'SELECT damage FROM raid_damage WHERE telegram_id = $1 AND week_number = $2',
    [req.tgUser.id, raid.week_number]
  );
  const top = await db.query(
    `SELECT rd.telegram_id, rd.damage, p.username, p.first_name
     FROM raid_damage rd
     LEFT JOIN players p ON p.telegram_id = rd.telegram_id
     WHERE rd.week_number = $1
     ORDER BY rd.damage DESC LIMIT 10`,
    [raid.week_number]
  );
  res.json({
    ok: true,
    boss: raid.boss_name,
    hp: raid.hp,
    maxHp: raid.max_hp,
    myDamage: d.rows[0] ? d.rows[0].damage : 0,
    top: top.rows.map(x => ({
      name: x.username || x.first_name || 'Игрок',
      damage: x.damage,
      isMe: x.telegram_id == req.tgUser.id
    }))
  });
});

app.post('/api/raid/attack', authMiddleware, async (req, res) => {
  const { damage } = req.body || {};
  const dmg = Math.max(0, Math.min(50000, parseInt(damage) || 0));
  if(dmg <= 0) return res.status(400).json({ error: 'bad damage' });

  await ensureRaid();
  const week = currentWeek();

  // Списываем энергию
  const cur = await db.query('SELECT * FROM players WHERE telegram_id = $1', [req.tgUser.id]);
  const row = cur.rows[0];
  const e = calcEnergy(row);
  if(e.energy < 10) return res.status(400).json({ error: 'no energy', energy: e.energy });

  const newEnergy = e.energy - 10;
  await db.query(
    'UPDATE players SET energy = $2, last_energy_tick = to_timestamp($3 / 1000.0) WHERE telegram_id = $1',
    [req.tgUser.id, newEnergy, e.newTick]
  );

  // Урон в рейд
  await db.query(`
    INSERT INTO raid_damage (telegram_id, week_number, damage, last_attack)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (telegram_id, week_number)
    DO UPDATE SET damage = raid_damage.damage + $3, last_attack = NOW()
  `, [req.tgUser.id, week, dmg]);

  // Уменьшаем HP босса
  await db.query('UPDATE raid SET hp = GREATEST(0, hp - $1), updated_at = NOW() WHERE id = 1', [dmg]);

  const r2 = await db.query('SELECT hp, max_hp FROM raid WHERE id = 1');
  res.json({ ok: true, dealt: dmg, bossHp: r2.rows[0].hp, bossMaxHp: r2.rows[0].max_hp, energyLeft: newEnergy });
});

// ============================================================
// ОПЛАТА STARS
// ============================================================
const PRICES = {
  energy_pill: { title: 'Пилюля энергии', description: '+50 энергии', price: 30 },
  gold_pack:   { title: 'Мешок золота', description: '+1000 золота', price: 50 },
  res_pack:    { title: 'Набор ресурсов', description: '+10 трав, +5 кристаллов, +10 руды', price: 60 },
  talisman:    { title: 'Зелье опыта', description: '+500 опыта', price: 80 },
  talent_reset:{ title: 'Сброс талантов', description: 'Вернуть все очки таланта', price: 40 }
};

app.post('/api/shop/invoice', authMiddleware, async (req, res) => {
  const { itemCode } = req.body || {};
  const item = PRICES[itemCode];
  if(!item) return res.status(400).json({ error: 'unknown item' });
  const bot = global.__bot;
  if(!bot) return res.status(500).json({ error: 'bot not ready' });

  try {
    const payload = JSON.stringify({ itemCode, userId: req.tgUser.id, ts: Date.now() });
    const link = await bot.telegram.createInvoiceLink({
      title: item.title,
      description: item.description,
      payload,
      provider_token: '',
      currency: 'XTR',
      prices: [{ label: item.title, amount: item.price }]
    });
    res.json({ invoiceLink: link });
  } catch(e){
    console.error('invoice error:', e.message);
    res.status(500).json({ error: 'invoice failed' });
  }
});

app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// ============================================================
// ЗАПУСК
// ============================================================
initDb().then(() => {
  app.listen(PORT, () => console.log(`🌐 Сервер: ${PORT}`));
}).catch(e => {
  console.error('❌ Ошибка init БД:', e.message);
  app.listen(PORT, () => console.log(`🌐 Сервер (без БД): ${PORT}`));
});

// ============================================================
// TELEGRAM БОТ
// ============================================================
const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL || (process.env.RENDER_EXTERNAL_HOSTNAME
  ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}` : 'https://example.com');

if(!BOT_TOKEN){
  console.error('❌ BOT_TOKEN не задан');
} else {
  const bot = new Telegraf(BOT_TOKEN);
  global.__bot = bot;

  bot.start((ctx) => {
    const name = ctx.from.first_name || 'Мастер Души';
    ctx.replyWithMarkdown(
      `🐉 *Боевой Континент: Путь Души*\n\nПривет, *${name}*!\n\n` +
      `• Пробуди Боевую Душу\n• Побеждай зверей\n• Поглощай кольца\n• Сражайся на Арене`,
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
      `📜 *Как играть*\n\n1️⃣ Открой Mini App\n2️⃣ Пробуди душу\n3️⃣ Побеждай зверей\n4️⃣ Поглощай кольца\n5️⃣ Прокачивайся`,
      Markup.inlineKeyboard([[Markup.button.webApp('🎮 Играть', WEBAPP_URL)]])
    );
  }

  bot.command('profile', (ctx) => {
    ctx.replyWithMarkdown(`👤 *${ctx.from.first_name}*\n\nОткрой Mini App для прогресса.`,
      Markup.inlineKeyboard([[Markup.button.webApp('🎮 Открыть', WEBAPP_URL)]]));
  });

  bot.command('invite', (ctx) => sendInvite(ctx));
  bot.action('invite', (ctx) => { ctx.answerCbQuery(); sendInvite(ctx); });

  function sendInvite(ctx){
    const me = ctx.botInfo.username;
    const link = `https://t.me/${me}?start=ref_${ctx.from.id}`;
    ctx.replyWithMarkdown(
      `👥 *Пригласи друга*\n\nТвоя ссылка:\n\`${link}\`\n\nЗа друга: +200 💰 +20 ⚡`,
      Markup.inlineKeyboard([
        [Markup.button.url('📤 Поделиться', `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('Играю в «Путь Души»! 🐉')}`)]
      ])
    );
  }

  bot.on('pre_checkout_query', (ctx) => ctx.answerPreCheckoutQuery(true).catch(console.error));

  bot.on('successful_payment', async (ctx) => {
    const sp = ctx.message.successful_payment;
    let parsed = {};
    try { parsed = JSON.parse(sp.invoice_payload || '{}'); } catch(e){}
    const userId = ctx.from.id;
    const itemCode = parsed.itemCode || 'unknown';

    try {
      await db.query(
        'INSERT INTO payments (charge_id, telegram_id, item_code, stars) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
        [sp.telegram_payment_charge_id, userId, itemCode, sp.total_amount]
      );
      // Начисляем награду
      if(itemCode === 'energy_pill'){
        await db.query('UPDATE players SET energy = LEAST(max_energy, energy + 50) WHERE telegram_id = $1', [userId]);
      } else if(itemCode === 'gold_pack'){
        await db.query('UPDATE players SET gold = gold + 1000 WHERE telegram_id = $1', [userId]);
      }
    } catch(e){ console.error('payment db:', e.message); }

    ctx.replyWithMarkdown(
      `✅ *Оплата получена!*\n\nТовар: *${PRICES[itemCode]?.title || itemCode}*\n⭐ ${sp.total_amount}\n\nОткрой игру чтобы забрать.`,
      Markup.inlineKeyboard([[Markup.button.webApp('🎮 Открыть', WEBAPP_URL)]])
    );
  });

  bot.launch(() => console.log('🚀 Бот запущен'))
     .catch((e) => console.error('❌ Ошибка бота:', e));

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

// ============================================================
// ПУШ-УВЕДОМЛЕНИЯ
// ============================================================
setInterval(async () => {
  if(!global.__bot) return;
  try {
    const full = await db.query(`
      SELECT telegram_id FROM players
      WHERE energy >= max_energy AND max_energy > 0
        AND updated_at < NOW() - INTERVAL '2 hours'
        AND banned = FALSE
      LIMIT 50
    `);
    for(const row of full.rows){
      try {
        await global.__bot.telegram.sendMessage(row.telegram_id,
          `⚡ *Энергия полная!*\n\nЗаходи, Мастер Души — пора в бой!`,
          { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🎮 Играть', web_app: { url: WEBAPP_URL } }]] } }
        );
      } catch(e){}
    }
  } catch(e){}
}, 30 * 60 * 1000);
