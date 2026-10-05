require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Telegraf, Markup } = require('telegraf');

const app = express();
const PORT = process.env.PORT || 3000;

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

const saves = new Map();

app.get('/api/save', (req, res) => {
  const user = validateInitData(req.headers['x-telegram-init-data']);
  if(!user) return res.status(401).json({ error: 'unauthorized' });
  res.json({ ok: true, save: saves.get(String(user.id)) || null });
});

app.post('/api/save', (req, res) => {
  const user = validateInitData(req.headers['x-telegram-init-data']);
  if(!user) return res.status(401).json({ error: 'unauthorized' });
  const { data } = req.body || {};
  if(!data) return res.status(400).json({ error: 'no data' });
  const safe = JSON.parse(JSON.stringify(data));
  if(typeof safe.level !== 'number' || safe.level < 1 || safe.level > 500) safe.level = 1;
  if(typeof safe.gold !== 'number' || safe.gold < 0 || safe.gold > 1e9) safe.gold = 0;
  if(typeof safe.rating !== 'number' || safe.rating < 0 || safe.rating > 100000) safe.rating = 0;
  if(typeof safe.age !== 'number' || safe.age < 6 || safe.age > 30) safe.age = 6;
  saves.set(String(user.id), safe);
  res.json({ ok: true });
});

const PRICES = {
  energy_pill: { title:'Пилюля энергии', description:'+50 энергии', price:30 },
  gold_pack:   { title:'Мешок золота', description:'+1000 золота', price:50 },
  res_pack:    { title:'Набор ресурсов', description:'+10 трав, +5 кристаллов, +10 руды', price:60 },
  talent_reset:{ title:'Сброс талантов', description:'Вернуть очки', price:40 }
};

app.post('/api/shop/invoice', (req, res) => {
  const user = validateInitData(req.headers['x-telegram-init-data']);
  if(!user) return res.status(401).json({ error: 'unauthorized' });
  const { itemCode } = req.body || {};
  const item = PRICES[itemCode];
  if(!item) return res.status(400).json({ error: 'unknown item' });
  const bot = global.__bot;
  if(!bot) return res.status(500).json({ error: 'bot not ready' });
  bot.telegram.createInvoiceLink({
    title: item.title, description: item.description,
    payload: JSON.stringify({ itemCode, userId: user.id, ts: Date.now() }),
    provider_token: '', currency: 'XTR',
    prices: [{ label: item.title, amount: item.price }]
  }).then(link => res.json({ invoiceLink: link }))
    .catch(e => res.status(500).json({ error: e.message }));
});

app.listen(PORT, () => console.log(`🌐 Сервер запущен: ${PORT}`));

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
      `• 100 уровней\n• 12 локаций\n• 10 глав сюжета\n• Секта Тан после победы над Королём Демонов`,
      Markup.inlineKeyboard([
        [Markup.button.webApp('🎮 Играть', WEBAPP_URL)],
        [Markup.button.callback('📜 Помощь', 'help'), Markup.button.callback('👥 Пригласить', 'invite')]
      ])
    );
  });

  bot.help((ctx) => ctx.replyWithMarkdown(
    `📜 *Как играть*\n\n1️⃣ Создай героя\n2️⃣ Исследуй карту\n3️⃣ Пройди 10 глав сюжета\n4️⃣ Победи Короля Демонов\n5️⃣ Оснуй Секту Тан`,
    Markup.inlineKeyboard([[Markup.button.webApp('🎮 Играть', WEBAPP_URL)]])
  ));
  bot.action('help', (ctx) => { ctx.answerCbQuery(); ctx.replyWithMarkdown('📜 Жми «Играть»!', Markup.inlineKeyboard([[Markup.button.webApp('🎮 Играть', WEBAPP_URL)]])); });

  bot.command('invite', (ctx) => sendInvite(ctx));
  bot.action('invite', (ctx) => { ctx.answerCbQuery(); sendInvite(ctx); });
  function sendInvite(ctx){
    const me = ctx.botInfo.username;
    const link = `https://t.me/${me}?start=ref_${ctx.from.id}`;
    ctx.replyWithMarkdown(
      `👥 *Пригласи друга*\n\n\`${link}\`\n\n+200💰 +20⚡ за друга`,
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

  const lastPushes = new Map();
  setInterval(async () => {
    try{
      for(const [uid, save] of saves){
        if(!save || !save.awakened) continue;
        const now = Date.now();
        const lastPush = lastPushes.get(uid) || 0;
        if(now - lastPush < 4*60*60*1000) continue;
        if(save.energy >= save.maxEnergy){
          try{
            await bot.telegram.sendMessage(uid,
              `⚡ *Энергия полная!*\n\nЗаходи, Мастер Души — пора в бой!`,
              { parse_mode:'Markdown', reply_markup: { inline_keyboard: [[{ text:'🎮 Играть', web_app: { url: WEBAPP_URL } }]] } }
            );
            lastPushes.set(uid, now);
          }catch(e){}
        }
      }
    }catch(e){}
  }, 60*60*1000);
} else {
  console.error('❌ BOT_TOKEN не задан');
}
