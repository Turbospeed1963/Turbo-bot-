// Starlink Telegram Bot — Cloudflare Worker + Supabase (Webhook)
// Secrets: BOT_TOKEN, WEBHOOK_SECRET, SUPABASE_SERVICE_KEY
// Vars: ADMIN_ID, CHANNEL, CHANNEL_URL, SUPABASE_URL

const PRICES = { new: 2, old: 2 };   // QR တစ်ခုအတွက် coin
const REF_REWARD = 2;                // လူတစ်ယောက်ခေါ်ရင် ရမယ့် coin
const WELCOME_COIN = 1;              // user အသစ်ရမယ့် coin
const DAILY_COIN = 1;                // နေ့စဉ် bonus
const MAX_USES = 2;                  // QR တစ်ပုံကို user ဘယ်နှယောက်ပေးမလဲ
const MM_OFFSET = 6.5 * 3600 * 1000; // မြန်မာစံတော်ချိန် UTC+6:30
const BC_CHUNK = 40;                 // broadcast တစ်ကြိမ်ကို ပို့မယ့် user အရေအတွက်

const DEV_USER = "turbomm750";       // Developer
const ADMIN_USER = "speedman750";    // Admin

const VERSIONS = {
  new: "Starlink New version",
  old: "Starlink old version",
};

// ---------------- Helpers ----------------
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const Btn = (text, cb) => ({ text, callback_data: cb });
const UrlBtn = (text, url) => ({ text, url });
const Markup = (rows) => ({ inline_keyboard: rows });
const BACK = Markup([[Btn("⬅️ နောက်သို့", "menu")]]);
const JOIN_TEXT = "⚠️ <b>Starlink Bot</b> သုံးရန်\nChannel ကို အရင် Join ပါ။";
const joinKb = (env) =>
  Markup([
    [UrlBtn("📢 Channel Join ရန်", env.CHANNEL_URL)],
    [Btn("✅ Join ပြီးပြီ", "check")],
  ]);
const adminId = (env) => Number(env.ADMIN_ID);

// ---------------- Telegram ----------------
async function tg(env, method, body) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return await r.json();
  } catch (e) {
    return { ok: false, description: String(e) };
  }
}
const send = (env, chat_id, text, extra = {}) => tg(env, "sendMessage", { chat_id, text, ...extra });
const edit = (env, q, text, reply_markup, html = false) =>
  tg(env, "editMessageText", {
    chat_id: q.message.chat.id,
    message_id: q.message.message_id,
    text,
    reply_markup,
    ...(html ? { parse_mode: "HTML" } : {}),
  });

let _botUsername = null;
async function botUsername(env) {
  if (!_botUsername) {
    const r = await tg(env, "getMe", {});
    _botUsername = r.result?.username;
  }
  return _botUsername;
}

// ---------------- Supabase ----------------
async function sb(env, path, { method = "GET", body, headers = {} } = {}) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Supabase ${r.status} ${path}: ${text}`);
  return text ? JSON.parse(text) : null;
}
const rpc = (env, fn, args = {}) => sb(env, `rpc/${fn}`, { method: "POST", body: args });

async function getSetting(env, name) {
  const rows = await sb(env, `settings?name=eq.${encodeURIComponent(name)}&select=value`);
  return rows && rows.length ? rows[0].value : null;
}
async function setSetting(env, name, value) {
  if (value === null || value === undefined) {
    await sb(env, `settings?name=eq.${encodeURIComponent(name)}`, { method: "DELETE" });
  } else {
    await sb(env, "settings?on_conflict=name", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: { name, value: String(value) },
    });
  }
}

const menuData = (env, uid) => rpc(env, "menu_data", { p_uid: uid, p_max: MAX_USES });

// ---------------- Time / QR ထုတ်ချိန် ----------------
const pad = (n) => String(n).padStart(2, "0");
function fmtMM(ms) {
  const d = new Date(ms + MM_OFFSET);
  let h = d.getUTCHours();
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(h)}:${pad(d.getUTCMinutes())} ${ap}`;
}
const todayMM = () => fmtMM(Date.now()).slice(0, 10); // မြန်မာစံတော်ချိန် ရက်စွဲ
function fmtLeft(ms) {
  let s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400); s %= 86400;
  const h = Math.floor(s / 3600); s %= 3600;
  const m = Math.floor(s / 60);
  const parts = [];
  if (d) parts.push(`${d} ရက်`);
  if (h) parts.push(`${h} နာရီ`);
  parts.push(`${m} မိနစ်`);
  return parts.join(" ");
}
function keysOpen(s) {
  if (s.open === "1") return true;
  return !!s.release_at && Date.now() >= Number(s.release_at);
}
function releaseText(s) {
  if (keysOpen(s)) return "🔓 QR ထုတ်ချိန်: ဖွင့်ထားပါပြီ ✅";
  if (s.release_at) {
    const rel = Number(s.release_at);
    return `🔒 QR ထုတ်ချိန်: ${fmtMM(rel)}\n⏳ ကျန်ချိန်: ${fmtLeft(rel - Date.now())}`;
  }
  return "🔒 QR ထုတ်ချိန်: ပိတ်ထားပါတယ် (Admin ဖွင့်ပေးမှ ရပါမယ်)";
}
function untilMidnight() {
  const shifted = Date.now() + MM_OFFSET;
  const next = (Math.floor(shifted / 86400000) + 1) * 86400000;
  return fmtLeft(next - shifted);
}
const limitText = () =>
  `⏳ ဒီနေ့ QR ထုတ်ပြီးပါပြီ။\nတစ်နေ့ကို QR ၁ ခုပဲ ထုတ်ပေးပါတယ်။\nနောက်တစ်ကြိမ်ရဖို့ ${untilMidnight()} ကျန်ပါတယ်။`;

// ---------------- Channel join ----------------
async function isMember(env, uid) {
  if (uid === adminId(env)) return true;
  const r = await tg(env, "getChatMember", { chat_id: env.CHANNEL, user_id: uid });
  return r.ok && ["member", "administrator", "creator"].includes(r.result.status);
}

// Join ပြီးမှ: user ဆောက် + referrer reward + welcome coin
async function activate(env, uid) {
  const a = await rpc(env, "activate_user", {
    p_uid: uid,
    p_welcome: WELCOME_COIN,
    p_ref_reward: REF_REWARD,
  });
  if (a.referrer) {
    await send(env, a.referrer, `🎉 သူငယ်ချင်း join လို့ +${REF_REWARD} coin ရပါပြီ!`);
  }
  return a.bonus === true;
}

// ---------------- UI ----------------
function mainMenu(env, uid, s) {
  const rows = [
    [Btn(`🚀 ${VERSIONS.new}`, "buy_new")],
    [Btn(`📡 ${VERSIONS.old}`, "buy_old")],
    [Btn(`🎁 နေ့စဉ် Bonus (+${DAILY_COIN} coin)`, "daily")],
    [Btn(`👥 လူခေါ်ရန် (+${REF_REWARD} coin)`, "invite"), Btn("💰 My Coin", "balance")],
    [Btn("📞 ဆက်သွယ်ရန်", "contact")],
  ];
  if (uid === adminId(env)) {
    const toggle = keysOpen(s) ? "🔒 QR ပိတ်ရန်" : "🔓 QR ဖွင့်ရန်";
    rows.push(
      [Btn(toggle, "adm_toggle")],
      [Btn("➕ New QR ထည့်", "adm_qr_new"), Btn("➕ Old QR ထည့်", "adm_qr_old")],
      [Btn("🪙 Coin ထည့်ရန်", "adm_coin"), Btn("⏰ ထုတ်ချိန်သတ်မှတ်", "adm_time")],
      [Btn("📢 User အားလုံးကို ပို့ရန်", "adm_all")],
      [Btn("✉️ User တစ်ယောက်ကို ပို့ရန်", "adm_one")]
    );
  }
  return Markup(rows);
}

function menuText(env, uid, s) {
  const qrToday = s.last_qr === todayMM() ? "ထုတ်ပြီးပါပြီ ❌" : "ထုတ်လို့ရပါသေးတယ် ✅";
  let text =
    `💰 Coin: ${s.coins}\n` +
    `🚀 New version QR လက်ကျန်: ${s.new}\n` +
    `📡 Old version QR လက်ကျန်: ${s.old}\n` +
    `🎟 ဒီနေ့ QR: ${qrToday}\n\n` +
    `${releaseText(s)}\n` +
    `💎 QR code များကို coin ဖြင့် လဲပါ (တစ်နေ့ ၁ ခုပဲ)\n\n` +
    `📞 Developer: @${DEV_USER}\n🛡 Admin: @${ADMIN_USER}`;
  if (uid === adminId(env)) {
    text +=
      `\n\n👤 User စုစုပေါင်း: ${s.users}` +
      `\n🕒 Bot time: ${fmtMM(Date.now())} (မြန်မာစံတော်ချိန်)`;
  }
  return text;
}

function welcomeText(name, bonus) {
  const gift = bonus ? `🎁 <b>Welcome Gift</b> ➜ <b>+${WELCOME_COIN} coin</b> ရရှိပါပြီ!\n\n` : "";
  return (
    "╔═══════════════╗\n" +
    "   ⭐ <b>STARLINK BOT</b> ⭐\n" +
    "╚═══════════════╝\n\n" +
    `မင်္ဂလာပါ <b>${esc(name)}</b> 👋\n` +
    "✨ <b>Starlink Bot</b> မှ ကြိုဆိုပါတယ် ✨\n\n" +
    gift +
    `🚀 <b>${VERSIONS.new}</b>\n` +
    `📡 <b>${VERSIONS.old}</b>\n\n` +
    "💎 QR code များကို <b>coin</b> ဖြင့်လဲပါ\n" +
    "📅 တစ်နေ့ကို QR <b>၁ ခု</b>ပဲ ထုတ်ပေးပါတယ်\n" +
    `🎁 နေ့စဉ် Bonus <b>+${DAILY_COIN} coin</b>\n` +
    `👥 သူငယ်ချင်းတစ်ယောက်ခေါ်ရင် <b>+${REF_REWARD} coin</b>\n` +
    "━━━━━━━━━━━━━━━\n"
  );
}

const contactKb = Markup([
  [UrlBtn("👨‍💻 Developer", `https://t.me/${DEV_USER}`), UrlBtn("🛡 Admin", `https://t.me/${ADMIN_USER}`)],
  [Btn("⬅️ နောက်သို့", "menu")],
]);
const contactText =
  "📞 <b>ဆက်သွယ်ရန်</b>\n\n" +
  `👨‍💻 Developer: @${DEV_USER}\n` +
  `🛡 Admin: @${ADMIN_USER}`;

// ---------------- Handlers ----------------
async function onStart(env, m) {
  const user = m.from;
  const uid = user.id;
  const arg = m.text.split(/\s+/)[1] || "";
  let ref = null;
  if (arg.startsWith("ref_")) {
    const n = parseInt(arg.slice(4), 10);
    if (Number.isFinite(n) && n !== uid) ref = n;
  }
  await rpc(env, "ensure_user", { p_uid: uid, p_ref: ref });

  if (!(await isMember(env, uid))) {
    return send(env, m.chat.id, JOIN_TEXT, { parse_mode: "HTML", reply_markup: joinKb(env) });
  }
  const bonus = await activate(env, uid);
  const s = await menuData(env, uid);
  return send(env, m.chat.id, welcomeText(user.first_name || "Friend", bonus) + esc(menuText(env, uid, s)), {
    parse_mode: "HTML",
    reply_markup: mainMenu(env, uid, s),
  });
}

async function buyQr(env, q, uid, version) {
  const price = PRICES[version];
  const today = todayMM();
  const s = await menuData(env, uid);

  if (!keysOpen(s)) {
    return edit(env, q, `🔒 QR ထုတ်ချိန် မဖွင့်သေးပါ။\n\n${releaseText(s)}`, BACK);
  }
  if (s.last_qr === today) return edit(env, q, limitText(), BACK);
  if (s.coins < price) {
    return edit(env, q, `❌ Coin မလုံလောက်ပါ။ (${price} coin လိုပါတယ်)`, BACK);
  }

  const r = await rpc(env, "buy_key", {
    p_uid: uid,
    p_version: version,
    p_price: price,
    p_max: MAX_USES,
    p_today: today,
  });

  if (r.status === "limit") return edit(env, q, limitText(), BACK);
  if (r.status === "no_coins") return edit(env, q, `❌ Coin မလုံလောက်ပါ။ (${price} coin လိုပါတယ်)`, BACK);
  if (r.status === "sold_out") return edit(env, q, `❌ ${VERSIONS[version]} QR ကုန်နေပါပြီ။`, BACK);

  // QR ပုံကို ပို့
  const res =
    r.kind === "document"
      ? await tg(env, "sendDocument", { chat_id: uid, document: r.file_id, caption: VERSIONS[version] })
      : await tg(env, "sendPhoto", { chat_id: uid, photo: r.file_id, caption: VERSIONS[version] });

  if (!res.ok) {
    return edit(env, q, `⚠️ QR ပို့လို့မရပါ။ Admin @${ADMIN_USER} ကို ဆက်သွယ်ပါ။`, BACK);
  }
  return edit(
    env, q,
    `✅ <b>${VERSIONS[version]}</b>\n\n📷 QR code ကို အောက်မှာ ပို့ပေးထားပါတယ်။\n📅 ဒီနေ့အတွက် QR ၁ ခု ထုတ်ပြီးပါပြီ။`,
    BACK, true
  );
}

async function onButton(env, ctx, q) {
  const uid = q.from.id;
  const d = q.data;
  await tg(env, "answerCallbackQuery", { callback_query_id: q.id });
  const isAdmin = uid === adminId(env);
  if (isAdmin) await setSetting(env, "admin_state", null);

  if (!(await isMember(env, uid))) {
    return edit(env, q, JOIN_TEXT, joinKb(env), true);
  }
  const bonus = await activate(env, uid);

  if (d === "menu" || d === "check") {
    const s = await menuData(env, uid);
    let text = menuText(env, uid, s);
    if (bonus) text = `🎁 Welcome Gift +${WELCOME_COIN} coin ရရှိပါပြီ!\n\n` + text;
    return edit(env, q, text, mainMenu(env, uid, s));
  }

  if (d === "balance") {
    const s = await menuData(env, uid);
    return edit(env, q, `💰 သင့် coin: ${s.coins}`, BACK);
  }

  if (d === "contact") return edit(env, q, contactText, contactKb, true);

  if (d === "daily") {
    const r = await rpc(env, "claim_daily", { p_uid: uid, p_coin: DAILY_COIN, p_today: todayMM() });
    if (r.ok) {
      return edit(
        env, q,
        `🎁 နေ့စဉ် Bonus +${DAILY_COIN} coin ရရှိပါပြီ!\n💰 Coin: ${r.coins}\n\nမနက်ဖြန် ပြန်လာပြီး ထပ်ယူပါ 😊`,
        BACK
      );
    }
    return edit(env, q, `⏳ ဒီနေ့ Bonus ယူပြီးပါပြီ။\nနောက်တစ်ကြိမ်ရဖို့ ${untilMidnight()} ကျန်ပါတယ်။`, BACK);
  }

  if (d === "invite") {
    const link = `https://t.me/${await botUsername(env)}?start=ref_${uid}`;
    return edit(
      env, q,
      `👥 ဒီ link ကို သူငယ်ချင်းတွေဆီ ပို့ပါ။\nသူတို့ Channel Join ပြီးတိုင်း ${REF_REWARD} coin ရပါမယ်။\n\n${link}`,
      BACK
    );
  }

  if (d === "buy_new" || d === "buy_old") return buyQr(env, q, uid, d.split("_")[1]);

  // ---------- Admin ----------
  if (!isAdmin) return;

  if (d === "adm_toggle") {
    const s0 = await menuData(env, uid);
    if (keysOpen(s0)) {
      await setSetting(env, "open", "0");
      await setSetting(env, "release_at", null);
    } else {
      await setSetting(env, "open", "1");
    }
    const s = await menuData(env, uid);
    return edit(env, q, menuText(env, uid, s), mainMenu(env, uid, s));
  }
  if (d === "adm_qr_new" || d === "adm_qr_old") {
    const version = d.split("_")[2];
    await setSetting(env, "admin_state", `addqr_${version}`);
    return edit(
      env, q,
      `➕ ${VERSIONS[version]} QR code ပုံများကို ပို့ပါ\n` +
        `(တစ်ပုံပြီးတစ်ပုံ ဆက်ပို့လို့ရပါတယ်။ ပြီးရင် နောက်သို့ ကိုနှိပ်ပါ။)\n\n` +
        `👥 QR တစ်ပုံကို user ${MAX_USES} ယောက်အထိ ပေးပါမယ်။`,
      BACK
    );
  }
  if (d === "adm_coin") {
    await setSetting(env, "admin_state", "addcoin");
    return edit(env, q, "ဒီပုံစံနဲ့ ပို့ပါ:\n<code>user_id amount</code>", BACK, true);
  }
  if (d === "adm_time") {
    await setSetting(env, "admin_state", "settime");
    const s = await menuData(env, uid);
    return edit(
      env, q,
      `${releaseText(s)}\n\n` +
        "QR အလိုအလျောက် ဖွင့်မယ့်ချိန်ကို ဒီပုံစံနဲ့ ပို့ပါ (မြန်မာစံတော်ချိန်၊ 24 နာရီ):\n" +
        "<code>2026-11-08 20:00</code>\n\n" +
        "သတ်မှတ်ချိန် ဖျက်ချင်ရင် <code>off</code> လို့ ပို့ပါ။",
      BACK, true
    );
  }
  if (d === "adm_all") {
    await setSetting(env, "admin_state", "bc_all");
    const s = await menuData(env, uid);
    return edit(env, q, `📢 User ${s.users} ယောက်လုံးကို ပို့မယ့် စာကို ရေးပို့ပါ:`, BACK);
  }
  if (d === "adm_one") {
    await setSetting(env, "admin_state", "bc_one");
    return edit(
      env, q,
      "ဒီပုံစံနဲ့ ပို့ပါ:\n<code>user_id စာ</code>\n\nဥပမာ:\n<code>123456789 မင်္ဂလာပါ</code>",
      BACK, true
    );
  }
}

// Admin က QR ပုံ (photo သို့မဟုတ် image file) တင်တာကို လက်ခံမယ်
async function onMedia(env, m) {
  const uid = m.from.id;
  if (uid !== adminId(env)) return;
  const state = await getSetting(env, "admin_state");
  if (!state || !state.startsWith("addqr_")) return;
  const version = state.split("_")[1];

  let file_id, kind, file_name;
  if (m.photo && m.photo.length) {
    file_id = m.photo[m.photo.length - 1].file_id; // အကြီးဆုံး size
    kind = "photo";
    file_name = "qr";
  } else if (m.document && (m.document.mime_type || "").startsWith("image/")) {
    file_id = m.document.file_id;
    kind = "document";
    file_name = m.document.file_name || "qr";
  } else {
    return send(env, m.chat.id, "❌ QR code ပုံပဲ လက်ခံပါတယ်။", { reply_markup: BACK });
  }

  await sb(env, "keys", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: { version, file_id, file_name, kind },
  });
  const s = await menuData(env, uid);
  return send(
    env, m.chat.id,
    `✅ ${VERSIONS[version]} QR ထည့်ပြီးပါပြီ။\n👥 ပေးလို့ရတဲ့နေရာ လက်ကျန်: ${s[version]}\n\nဆက်ပို့လို့ရပါတယ်။ ပြီးရင် နောက်သို့ ကိုနှိပ်ပါ။`,
    { reply_markup: BACK }
  );
}

async function onText(env, ctx, m) {
  const uid = m.from.id;
  if (uid !== adminId(env)) return;
  const state = await getSetting(env, "admin_state");
  if (!state) return;
  const chat = m.chat.id;
  const body = m.text;
  let msg;

  if (state.startsWith("addqr_")) {
    return send(env, chat, "📷 QR code ပုံကို ပို့ပါ (စာမဟုတ်ပါ)။", { reply_markup: BACK });
  }

  if (state === "addcoin") {
    const p = body.trim().split(/\s+/).map(Number);
    if (p.length !== 2 || !p.every(Number.isInteger)) {
      return send(env, chat, "ပုံစံမှား: <code>user_id amount</code>", { parse_mode: "HTML" });
    }
    const [target, amt] = p;
    await rpc(env, "add_coins", { p_uid: target, p_amt: amt });
    msg = `✅ ${target} ကို ${amt} coin ထည့်ပြီးပါပြီ။`;
  } else if (state === "settime") {
    if (body.trim().toLowerCase() === "off") {
      await setSetting(env, "release_at", null);
      msg = "✅ သတ်မှတ်ချိန် ဖျက်ပြီးပါပြီ။";
    } else {
      const mt = body.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2}) (\d{1,2}):(\d{2})$/);
      if (!mt) return send(env, chat, "ပုံစံမှား: <code>2026-11-08 20:00</code>", { parse_mode: "HTML" });
      const [, y, mo, d, h, mi] = mt.map(Number);
      await setSetting(env, "release_at", Date.UTC(y, mo - 1, d, h, mi) - MM_OFFSET);
      msg = `✅ သတ်မှတ်ပြီးပါပြီ။\n\n${releaseText(await menuData(env, uid))}`;
    }
  } else if (state === "bc_all") {
    await setSetting(env, "bc_text", body);
    await setSetting(env, "bc_cursor", 0);
    await setSetting(env, "bc_ok", 0);
    await setSetting(env, "bc_fail", 0);
    await setSetting(env, "bc_lock", null);
    ctx.waitUntil(bcStep(env));
    const s = await menuData(env, uid);
    msg = `⏳ User ${s.users} ယောက်ကို ပို့နေပါတယ်...\n(တစ်မိနစ်ကို ${BC_CHUNK} ယောက်နှုန်းနဲ့ ပို့ပြီး ပြီးရင် ရလဒ်ပြန်ပို့ပေးပါမယ်)`;
  } else if (state === "bc_one") {
    const parts = body.trim().split(/\s+/);
    const target = parts[0];
    const text = body.trim().slice(target.length).trim();
    if (!text || !/^-?\d+$/.test(target)) {
      return send(env, chat, "ပုံစံမှား: <code>user_id စာ</code>", { parse_mode: "HTML" });
    }
    const r = await send(env, Number(target), text);
    msg = r.ok
      ? `✅ ${target} ကို ပို့ပြီးပါပြီ။`
      : `❌ ${target} ကို မပို့နိုင်ပါ (bot ကို block/မစဖူးသူ ဖြစ်နိုင်)။`;
  } else {
    return;
  }

  await setSetting(env, "admin_state", null);
  const s = await menuData(env, uid);
  return send(env, chat, msg, { reply_markup: mainMenu(env, uid, s) });
}

// ---------------- Broadcast (chunk လိုက်ပို့ — cron က ဆက်လုပ်ပေးမယ်) ----------------
async function bcStep(env) {
  const text = await getSetting(env, "bc_text");
  if (text === null) return;
  const lock = Number((await getSetting(env, "bc_lock")) || 0);
  if (lock && Date.now() - lock < 90000) return; // တခြား run နေတုန်း
  await setSetting(env, "bc_lock", Date.now());

  const cursor = Number((await getSetting(env, "bc_cursor")) || 0);
  let ok = Number((await getSetting(env, "bc_ok")) || 0);
  let fail = Number((await getSetting(env, "bc_fail")) || 0);

  const rows = await sb(env, `users?select=id&id=gt.${cursor}&order=id.asc&limit=${BC_CHUNK}`);

  if (!rows.length) {
    await send(env, adminId(env), `✅ ပို့ပြီး: ${ok}\n❌ မရောက်: ${fail}`);
    for (const k of ["bc_text", "bc_cursor", "bc_ok", "bc_fail", "bc_lock"]) await setSetting(env, k, null);
    return;
  }
  let last = cursor;
  for (const r of rows) {
    const res = await send(env, r.id, text);
    res.ok ? ok++ : fail++;
    last = r.id;
    await sleep(50);
  }
  await setSetting(env, "bc_cursor", last);
  await setSetting(env, "bc_ok", ok);
  await setSetting(env, "bc_fail", fail);
  await setSetting(env, "bc_lock", null);
}

// ---------------- Worker entry ----------------
async function handleUpdate(env, ctx, u) {
  if (u.callback_query) return onButton(env, ctx, u.callback_query);
  const m = u.message;
  if (!m || !m.from) return;
  if (m.text && m.text.split(/[\s@]/)[0] === "/start") return onStart(env, m);
  if (m.photo || m.document) return onMedia(env, m);
  if (m.text && !m.text.startsWith("/")) return onText(env, ctx, m);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Webhook ကို တစ်ကြိမ်သတ်မှတ်ရန်: https://<worker>/setup?key=<WEBHOOK_SECRET>
    if (url.pathname === "/setup") {
      if (url.searchParams.get("key") !== env.WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
      const r = await tg(env, "setWebhook", {
        url: `${url.origin}/webhook`,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ["message", "callback_query"],
        drop_pending_updates: true,
      });
      return new Response(JSON.stringify(r, null, 2), { headers: { "content-type": "application/json" } });
    }

    if (url.pathname === "/webhook" && request.method === "POST") {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      const update = await request.json();
      ctx.waitUntil(handleUpdate(env, ctx, update).catch((e) => console.error("update error:", e)));
      return new Response("ok");
    }

    return new Response("Starlink bot is running ✅");
  },

  // Cron: broadcast ကျန်တာ ဆက်ပို့
  async scheduled(event, env, ctx) {
    ctx.waitUntil(bcStep(env).catch((e) => console.error("bc error:", e)));
  },
};
