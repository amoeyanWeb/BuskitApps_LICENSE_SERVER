const express = require("express");
const cors = require("cors");
require("dotenv").config();

const admin = require("firebase-admin");
const crypto = require("crypto");
const https = require("https");

// ── اعلان واتس‌آپ به مالک سایت (CallMeBot) ──────────────────────────────────
// هر بار یک لایسنس صادر و ایمیلش با موفقیت ارسال می‌شود، همان لحظه یک پیام
// واتس‌آپ هم به شماره‌ی خودمان می‌رود. fire-and-forget است؛ خطای احتمالی‌اش
// هرگز روند اصلی صدور لایسنس/پاسخ به کاربر را مختل نمی‌کند.
const CALLMEBOT_PHONE = "905312691609"; // بدون + و بدون صفر اضافه
const CALLMEBOT_APIKEY = process.env.CALLMEBOT_APIKEY || "8925384";

function notifyWhatsapp(text) {
  const url = `https://api.callmebot.com/whatsapp.php?phone=${CALLMEBOT_PHONE}&text=${encodeURIComponent(text)}&apikey=${CALLMEBOT_APIKEY}`;
  https
    .get(url, (res) => {
      res.resume();
    })
    .on("error", (err) => {
      console.error("خطا در ارسال اعلان واتس‌آپ:", err.message);
    });
}

// ── Firebase init ─────────────────────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ── اتصال دوم: پروژه‌ی buskitlivefxsite ─────────────────────────────────────
// سایت اصلی (index.html/script.js) و بخش نمایش نرخ در پنل ادمین، هر دو از
// اپ پیش‌فرض Firebase با projectId «buskitlivefxsite» می‌خونن — که کاملاً از
// پروژه‌ی livefx-b43d5 (بالا) جداست. برای همین سند rates/latest باید توی
// همین پروژه‌ی دوم نوشته بشه، نه توی livefx-b43d5؛ در غیر این صورت سرور
// موفق می‌نویسه ولی جایی که کسی نمی‌بینتش. بقیه‌ی مسیرها (license, discount
// code, appVersions و...) دست‌نخورده از همون اتصال اول (db/livefx-b43d5)
// استفاده می‌کنن، چون admin.html هم دقیقاً همونجا می‌خونتشون (dbLiveFX).
const buskitSiteServiceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_BUSKITSITE);
const buskitSiteApp = admin.initializeApp(
  { credential: admin.credential.cert(buskitSiteServiceAccount) },
  "buskitSite",
);
const buskitSiteDb = buskitSiteApp.firestore();

// ══════════════════════════════════════════════════════════════════════════
// ── نرخ ارز (دلار/لیر و دلار/ریال بازار آزاد) ───────────────────────────────
// این بخش دو نرخ را خودکار و روزانه می‌گیرد و در سند Firestore به آدرس
// rates/latest ذخیره می‌کند؛ همان سندی که کلاینت (script.js، تابع
// fetchTryToIrrRate) مستقیماً از Firestore می‌خواند — پس صفحه‌ی خرید لایسنس
// بدون نیاز به هیچ مسیر جدیدی، به‌محض باز شدن مودال (یا رفرش ساعتیِ خودش)
// آخرین نرخ ذخیره‌شده را نشان می‌دهد.
//
// زمان‌بندی (به وقت استانبول — ترکیه ساعت تابستانی/زمستانی ندارد، همیشه UTC+3):
//   • ساعت ۱۳:۰۰ → نرخ دلار به لیر: اول doviz.com، اگر جواب نداد Frankfurter.
//   • ساعت ۱۵:۰۰ → نرخ دلار به ریال بازار آزاد: اول bonbast، اگر جواب نداد brsapi.
//   • اگر هر دو منبع یک نرخ شکست بخورند، هر ۳۰ دقیقه دوباره تلاش می‌شود تا
//     موفق شود؛ در تمام این مدت آخرین نرخ معتبر قبلی (چه مال امروز چه دیروز)
//     همچنان روی سایت نمایش داده می‌شود — هیچ‌وقت نرخ با مقدار خالی/صفر
//     جایگزین نمی‌شود.
//
// نکته‌ی مهم درباره‌ی منابع: doviz.com هیچ API عمومی رسمی‌ای منتشر نکرده و
// دسترسی برنامه‌نویسی به آن را عملاً مسدود می‌کند؛ همین‌طور «ارزهام» /
// apiDeveloper که اشاره کردی آدرس دقیقشان برایم قابل تأیید نبود. برای همین
// در ادامه از bonbast (منبع رایگان و شناخته‌شده‌ی نرخ بازار آزاد ریال) و
// brsapi به‌عنوان جایگزین استفاده شده. اگر آدرس دقیق مدنظرت را داری، کافیست
// در همین دو تابع (fetchUsdIrrFromBonbast / fetchUsdIrrFromBrsApi، یا
// fetchUsdTryFromDovizCom) فقط URL و نگاشت فیلدها را عوض کنی؛ بقیه‌ی سیستم
// (زمان‌بندی، تلاش مجدد، کش، ذخیره در Firestore) دست‌نخورده کار می‌کند.
// ══════════════════════════════════════════════════════════════════════════
const RATES_DOC_REF = buskitSiteDb.collection("rates").doc("latest");
const ISTANBUL_TZ = "Europe/Istanbul";
const RATE_RETRY_INTERVAL_MS = 30 * 60 * 1000; // نیم ساعت

// آخرین نرخ‌های معتبر در حافظه (برای جلوگیری از خواندن مکرر Firestore)
const latestRates = {
  usdToTry: null, // ۱ دلار = چند لیر
  usdToTrySource: null,
  usdToTryUpdatedAt: null,
  usdToIrr: null, // ۱ دلار = چند ریال (بازار آزاد)
  usdToIrrSource: null,
  usdToIrrUpdatedAt: null,
};
const rateJobRetryTimers = { usdTry: null, usdIrr: null };

// ── منبع ۱ برای نرخ دلار/لیر و منبع ۱ برای نرخ دلار/ریال: alanchand.com ────
// yekrial.com پشت Cloudflare قرار گرفته و همیشه به سرورها ۴۰۳ (صفحه‌ی چالش)
// می‌ده — از سرورهای هاستینگ ابری (مثل Render) اصلاً قابل‌عبور نیست، پس
// جایگزینش کردیم. alanchand.com توی یک صفحه (exchange-rates/usd-try) هم
// نرخ دلار/لیر و هم نرخ دلار/ریالِ بازار آزاد رو با هم نشون می‌ده — با یک
// fetch هر دو عدد از دقیقاً همون یک لحظه به دست می‌آد، نه دو درخواست جدا در
// دو زمان متفاوت. مقدار ریال مستقیماً به «ریال» گزارش می‌شه (نه تومان)، پس
// نیازی به ضرب در ۱۰ نیست.
let alanchandCache = { at: 0, data: null };
const ALANCHAND_CACHE_TTL_MS = 60 * 1000; // ۶۰ ثانیه

// به‌جای وابستگی به کلاس‌های CSS یا چیدمان تگ‌ها (که با هر ریدیزاین سایت
// می‌شکنه)، اول همه‌ی تگ‌ها رو حذف می‌کنیم و روی متن سادهٔ صفحه دنبال دو
// جمله‌ی طبیعیِ انگلیسیِ صفحه می‌گردیم که خیلی بعیده عوض بشن:
//   «1 US Dollar = 48.7 Turkish Lira»   → نرخ دلار به لیر
//   «...price of US Dollar in the market was 2,313,000 Iranian Rials»
//                                        → نرخ دلار به ریالِ بازار آزاد
function extractAlanchandRates(html) {
  const plainText = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ");

  const tryMatch = plainText.match(/1\s*US Dollar\s*=\s*([\d,]+(?:\.\d+)?)\s*Turkish Lira/i);
  const irrMatch = plainText.match(/price of US Dollar in the market was\s*([\d,]+)\s*Iranian Rials/i);

  const usdToTry = tryMatch ? Number(tryMatch[1].replace(/,/g, "")) : null;
  const usdToIrr = irrMatch ? Number(irrMatch[1].replace(/,/g, "")) : null;

  return {
    usdToTry: Number.isFinite(usdToTry) && usdToTry > 0 ? usdToTry : null,
    usdToIrr: Number.isFinite(usdToIrr) && usdToIrr > 0 ? usdToIrr : null,
  };
}

async function fetchRatesFromAlanchand() {
  const now = Date.now();
  if (alanchandCache.data && now - alanchandCache.at < ALANCHAND_CACHE_TTL_MS) {
    return alanchandCache.data;
  }

  const res = await fetch("https://alanchand.com/en/exchange-rates/usd-try", {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; BuskitRateBot/1.0)" },
  });
  if (!res.ok) throw new Error(`alanchand.com پاسخ HTTP ${res.status} داد`);
  const html = await res.text();

  const { usdToTry, usdToIrr } = extractAlanchandRates(html);
  if (!usdToTry || !usdToIrr) {
    throw new Error("alanchand.com: نرخ دلار/لیر یا دلار/ریال در صفحه پیدا نشد (شاید ساختار صفحه تغییر کرده)");
  }

  const data = { usdToTry, usdToIrr };
  alanchandCache = { at: now, data };
  return data;
}

async function fetchUsdTryFromAlanchand() {
  const { usdToTry } = await fetchRatesFromAlanchand();
  return usdToTry;
}
async function fetchUsdIrrFromAlanchand() {
  const { usdToIrr } = await fetchRatesFromAlanchand();
  return usdToIrr;
}

// ── منبع ۲ برای نرخ دلار/لیر: doviz.com ────────────────────────────────────
async function fetchUsdTryFromDovizCom() {
  const res = await fetch("https://www.doviz.com/api/v1/currencies/all/latest", {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; BuskitRateBot/1.0)" },
  });
  if (!res.ok) throw new Error(`doviz.com پاسخ HTTP ${res.status} داد`);
  const json = await res.json();
  const list = Array.isArray(json) ? json : json?.data || Object.values(json || {});
  const usdItem = list.find(
    (it) => (it?.code || it?.symbol || it?.Symbol || "").toString().toUpperCase() === "USD",
  );
  const buy = Number(usdItem?.buying ?? usdItem?.buy ?? usdItem?.Alis ?? usdItem?.alis);
  const sell = Number(usdItem?.selling ?? usdItem?.sell ?? usdItem?.Satis ?? usdItem?.satis);
  const rate = buy > 0 && sell > 0 ? (buy + sell) / 2 : Number(buy || sell);
  if (!rate || Number.isNaN(rate)) throw new Error("doviz.com: نرخ USD در پاسخ پیدا نشد");
  return rate; // ۱ دلار = rate لیر
}

// ── منبع ۳ برای نرخ دلار/لیر: Frankfurter (نرخ رسمی بانک مرکزی اروپا) ──────
async function fetchUsdTryFromFrankfurter() {
  const res = await fetch("https://api.frankfurter.dev/v1/latest?base=USD&symbols=TRY");
  if (!res.ok) throw new Error(`Frankfurter پاسخ HTTP ${res.status} داد`);
  const json = await res.json();
  const rate = Number(json?.rates?.TRY);
  if (!rate || Number.isNaN(rate)) throw new Error("Frankfurter: نرخ TRY در پاسخ پیدا نشد");
  return rate;
}

// ── منبع ۲ و ۳ برای نرخ دلار/ریال بازار آزاد: bonbast و brsapi ─────────────
// هر دو فعلاً از کار افتاده‌ن (bonbast.amirhn.com دیگه اصلاً resolve نمی‌شه؛
// کلید رایگانِ مستندشدهٔ brsapi هم دیگه معتبر نیست) ولی به‌عنوان fallback
// نگه داشته شدن — اگه یه روز دوباره سرپا شدن، خودکار دوباره استفاده می‌شن،
// و تا اون موقع فقط سریع شکست می‌خورن و به منبع بعدی می‌رن.
async function fetchUsdIrrFromBonbast() {
  const res = await fetch("https://bonbast.amirhn.com/latest");
  if (!res.ok) throw new Error(`bonbast پاسخ HTTP ${res.status} داد`);
  const json = await res.json();
  const buyToman = Number(json?.usd1 ?? json?.usd_sell ?? json?.usd?.sell);
  const sellToman = Number(json?.usd2 ?? json?.usd_buy ?? json?.usd?.buy);
  const toman = buyToman > 0 && sellToman > 0 ? (buyToman + sellToman) / 2 : Number(buyToman || sellToman);
  if (!toman || Number.isNaN(toman)) throw new Error("bonbast: نرخ usd در پاسخ پیدا نشد");
  return toman * 10; // تومان → ریال
}

async function fetchUsdIrrFromBrsApi() {
  const res = await fetch("https://BrsApi.ir/FreeTsetmcBourseApi/Api_Free_Gold_Currency_v2.json");
  if (!res.ok) throw new Error(`brsapi پاسخ HTTP ${res.status} داد`);
  const json = await res.json();
  const list = json?.currency || json?.Currency || [];
  const usdItem = list.find((it) =>
    (it?.symbol || it?.name_en || it?.Symbol || "").toString().toUpperCase().includes("USD"),
  );
  const toman = Number(usdItem?.price ?? usdItem?.Price);
  if (!toman || Number.isNaN(toman)) throw new Error("brsapi: نرخ usd در پاسخ پیدا نشد");
  return toman * 10; // تومان → ریال
}

const USD_TRY_SOURCES = [
  { name: "alanchand.com", fn: fetchUsdTryFromAlanchand },
  { name: "doviz.com", fn: fetchUsdTryFromDovizCom },
  { name: "Frankfurter", fn: fetchUsdTryFromFrankfurter },
];
const USD_IRR_SOURCES = [
  { name: "alanchand.com", fn: fetchUsdIrrFromAlanchand },
  { name: "bonbast", fn: fetchUsdIrrFromBonbast },
  { name: "brsapi", fn: fetchUsdIrrFromBrsApi },
];

// منابع یک نرخ را به‌ترتیب امتحان می‌کند؛ به محض موفقیت اولی برمی‌گردد
async function fetchFirstSuccessful(sources) {
  let lastErr;
  for (const src of sources) {
    try {
      const value = await src.fn();
      return { value, source: src.name };
    } catch (err) {
      lastErr = err;
      console.warn(`[نرخ ارز] منبع «${src.name}» ناموفق بود: ${err.message}`);
    }
  }
  throw lastErr || new Error("همه‌ی منابع ناموفق بودند");
}

// معادل تومان/ریالِ نرخ‌های خام را محاسبه و در Firestore ذخیره می‌کند
// (merge: true یعنی اگر یکی از دو نرخ هنوز امروز به‌روز نشده، مقدار قبلی‌اش
// دست‌نخورده می‌ماند — دقیقاً همان رفتاری که خواسته شده بود)
async function persistRatesToFirestore() {
  if (!latestRates.usdToTry) return;
  const payload = {
    usdToTry: latestRates.usdToTry,
    usdToTrySource: latestRates.usdToTrySource,
    usdToTryUpdatedAt: latestRates.usdToTryUpdatedAt,
    tryToUsd: 1 / latestRates.usdToTry,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (latestRates.usdToIrr) {
    payload.usdToIrr = latestRates.usdToIrr;
    payload.usdToIrrSource = latestRates.usdToIrrSource;
    payload.usdToIrrUpdatedAt = latestRates.usdToIrrUpdatedAt;
    payload.tryToRial = latestRates.usdToIrr / latestRates.usdToTry;
  }
  await RATES_DOC_REF.set(payload, { merge: true });
}

// یک بار تلاش برای گرفتن نرخ؛ اگر شکست بخورد هر ۳۰ دقیقه دوباره امتحان می‌کند
async function runRateJob(jobKey, sources, applyResult, label) {
  if (rateJobRetryTimers[jobKey]) {
    clearTimeout(rateJobRetryTimers[jobKey]);
    rateJobRetryTimers[jobKey] = null;
  }
  try {
    const { value, source } = await fetchFirstSuccessful(sources);
    applyResult(value, source);
    await persistRatesToFirestore();
    console.log(`[نرخ ارز] ${label} با موفقیت از «${source}» گرفته شد: ${value}`);
    return { success: true, value, source };
  } catch (err) {
    console.error(
      `[نرخ ارز] دریافت ${label} ناموفق بود: ${err.message}؛ تا ۳۰ دقیقه‌ی دیگر دوباره تلاش می‌شود. ` +
        `تا آن زمان آخرین نرخ معتبر همچنان روی سایت نمایش داده می‌شود.`,
    );
    rateJobRetryTimers[jobKey] = setTimeout(
      () => runRateJob(jobKey, sources, applyResult, label),
      RATE_RETRY_INTERVAL_MS,
    );
    return { success: false, error: err.message };
  }
}

function applyUsdTryResult(value, source) {
  latestRates.usdToTry = value;
  latestRates.usdToTrySource = source;
  latestRates.usdToTryUpdatedAt = new Date();
}
function applyUsdIrrResult(value, source) {
  latestRates.usdToIrr = value;
  latestRates.usdToIrrSource = source;
  latestRates.usdToIrrUpdatedAt = new Date();
}

// محاسبه‌ی میلی‌ثانیه تا نزدیک‌ترین ساعت:دقیقه‌ی بعدی به وقت استانبول
function msUntilNextIstanbulTime(hour, minute) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ISTANBUL_TZ,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(now);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const istNow = new Date(
    Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")),
  );
  const target = new Date(istNow);
  target.setUTCHours(hour, minute, 0, 0);
  if (target <= istNow) target.setUTCDate(target.getUTCDate() + 1);
  return target.getTime() - istNow.getTime();
}

function scheduleDailyRateJob(hour, minute, jobKey, sources, applyResult, label) {
  const delay = msUntilNextIstanbulTime(hour, minute);
  console.log(
    `[نرخ ارز] زمان‌بندی ${label}: اولین اجرا تا ${Math.round(delay / 60000)} دقیقه‌ی دیگر ` +
      `(ساعت ${hour}:${String(minute).padStart(2, "0")} به وقت استانبول)`,
  );
  setTimeout(function runAndReschedule() {
    runRateJob(jobKey, sources, applyResult, label);
    setInterval(() => runRateJob(jobKey, sources, applyResult, label), 24 * 60 * 60 * 1000);
  }, delay);
}

// آیا این تاریخ مربوط به «امروز» به وقت استانبول است؟
function isUpdatedToday(date) {
  if (!date) return false;
  const d = typeof date.toDate === "function" ? date.toDate() : new Date(date);
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: ISTANBUL_TZ });
  return fmt.format(new Date()) === fmt.format(d);
}

async function initRatesSystem() {
  try {
    const doc = await RATES_DOC_REF.get();
    if (doc.exists) {
      const data = doc.data();
      if (data.usdToTry) {
        latestRates.usdToTry = data.usdToTry;
        latestRates.usdToTrySource = data.usdToTrySource || null;
        latestRates.usdToTryUpdatedAt = data.usdToTryUpdatedAt?.toDate?.() || null;
      }
      if (data.usdToIrr) {
        latestRates.usdToIrr = data.usdToIrr;
        latestRates.usdToIrrSource = data.usdToIrrSource || null;
        latestRates.usdToIrrUpdatedAt = data.usdToIrrUpdatedAt?.toDate?.() || null;
      }
    }
  } catch (err) {
    console.error("[نرخ ارز] خواندن نرخ ذخیره‌شده از Firestore ناموفق بود:", err.message);
  }

  // اگر سرور همین امروز ری‌استارت شده و نرخ امروز هنوز گرفته نشده، یک تلاش فوری بزن
  if (!isUpdatedToday(latestRates.usdToTryUpdatedAt)) {
    runRateJob("usdTry", USD_TRY_SOURCES, applyUsdTryResult, "نرخ دلار/لیر");
  }
  if (!isUpdatedToday(latestRates.usdToIrrUpdatedAt)) {
    runRateJob("usdIrr", USD_IRR_SOURCES, applyUsdIrrResult, "نرخ دلار/ریال بازار آزاد");
  }

  scheduleDailyRateJob(13, 0, "usdTry", USD_TRY_SOURCES, applyUsdTryResult, "نرخ دلار/لیر");
  scheduleDailyRateJob(15, 0, "usdIrr", USD_IRR_SOURCES, applyUsdIrrResult, "نرخ دلار/ریال بازار آزاد");
}

initRatesSystem();
// ══════════════════════════════════════════════════════════════════════════

// ── کلید خصوصی ───────────────────────────────────────────────────────────
const privateKey = process.env.PRIVATE_KEY.replace(/\\n/g, "\n");

// ── سرویس ایمیل (Brevo — از طریق HTTP API، نه SMTP) ──────────────────────
// چرا Brevo به‌جای Gmail SMTP: Render (پلن رایگان) پورت‌های خروجی SMTP
// (۲۵/۴۶۵/۵۸۷) رو کاملاً مسدود می‌کنه — این یک محدودیت شناخته‌شده‌ی خودِ
// Render روی همه‌ی SMTP providerهاست (Gmail، Zoho، هرچی)، نه چیزی که با
// تنظیمات کد حل بشه. Brevo برخلاف nodemailer، از یک HTTP API (روی پورت
// ۴۴۳، همون پورتی که هیچ‌وقت مسدود نمی‌شه) استفاده می‌کنه، پس این مشکل رو
// نداره. پلن رایگانش ۳۰۰ ایمیل در روزه و نیازی به دامنه هم نداره.
const SibApiV3Sdk = require("sib-api-v3-sdk");
SibApiV3Sdk.ApiClient.instance.authentications["api-key"].apiKey =
  process.env.BREVO_API_KEY;
const brevoEmailApi = new SibApiV3Sdk.TransactionalEmailsApi();

// ── Express ───────────────────────────────────────────────────────────────
const app = express();
// ── دامنه‌های مجاز برای CORS — case-insensitive چک می‌شن، پس فرقی نمی‌کنه
// کسی آدرس رو با حروف بزرگ/کوچیک بزنه (مثلاً BuskitApps.com هم قبول می‌شه) ──
const ALLOWED_ORIGINS = [
  "https://buskitapps.com",
  "https://www.buskitapps.com",
  "https://buskitapps.onrender.com",
];
app.use(
  cors({
    origin: (origin, callback) => {
      // درخواست‌های بدون هدر Origin (مثل curl، Postman، یا سرور-به-سرور) رو رد نکن
      if (!origin) return callback(null, true);
      const normalizedOrigin = origin.toLowerCase();
      const isAllowed = ALLOWED_ORIGINS.some(
        (allowed) => allowed.toLowerCase() === normalizedOrigin,
      );
      return isAllowed
        ? callback(null, true)
        : callback(new Error("Not allowed by CORS"));
    },
  }),
);

// ── body parser ──────────────────────────────────────────────────────────
// نکته‌ی مهم: مسیرهای وبهوکِ درگاه‌های پرداخت باید body رو به‌صورت خام (raw
// buffer) دریافت کنن، چون در حالتی که امضای HMAC هم لازم باشه، امضا روی
// همون بایت‌های خامِ ارسالی محاسبه می‌شه، نه روی JSON.stringify شده‌ی
// دوباره. برای همین این مسیرها رو از express.json() عمومی مستثنی می‌کنیم و
// خودشون پایین‌تر express.raw() جداگانه می‌گیرن.
// ⚠️ TODO_VERIFY: مسیر /webhooks/payoneer با فرض احراز هویت Basic
// Auth نوشته شده (ساده‌ترین و رایج‌ترین حالت برای این خانواده از APIهای
// Optile/Payoneer Checkout)، که نیازی به raw body ندارد — اما اگه توی پنل
// Payoneer دیدید که یک هدر امضا (مثلاً X-Payoneer-Signature) هم می‌فرسته،
// حتماً این مسیر رو هم مثل lemonsqueezy به express.raw() ببرید و امضا رو
// روی raw body چک کنید، نه روی body پارس‌شده.
app.use((req, res, next) => {
  if (req.originalUrl === "/webhooks/lemonsqueezy") {
    return next();
  }
  express.json()(req, res, next);
});

// ── مدت زمان انواع لایسنس (ms) ───────────────────────────────────────────
// چون فقط یک محصول (لایسنس مادام‌العمر) می‌فروشی، فقط "lifetime" مونده.
// "5days" رو نگه داشتیم چون مال کد رایگان Free Trial (is_shared) هست که
// یک قابلیت جداست، نه یکی از سطح‌های خرید، و توی ActivationActivity هنوز
// استفاده می‌شه.
// "probation": لایسنس اختصاصی (is_shared=false) که قبل از دریافت پول به
// مشتری داده می‌شه — فقط ۲ روز مهلت داره تا پول رو واریز کنه. اگه پرداخت
// کرد، ادمین دستی expires_at همون سند رو توی Firestore به تاریخ دلخواه
// (مثلاً ۲۰ سال بعد) تغییر می‌ده. اگه پرداخت نکرد، بعد از ۲ روز خودکار
// منقضی می‌شه. سقف «هر دستگاه فقط یک‌بار probation» با فیلد
// hadProbationLicense روی سند devices/{fingerprint__appId} تضمین می‌شه
// (پایین‌تر در /activate) تا کسی نتونه با گرفتن پی‌درپی کدهای probation
// جدید، یک تریال نامحدود رایگان برای خودش بسازه.
const LICENSE_DURATIONS = {
  lifetime: null,
  "5days": 5 * 24 * 60 * 60 * 1000,
  probation: 2 * 24 * 60 * 60 * 1000,
};

// ترتیب اولویت چک در زمان ساین‌این: مادام‌العمر > رایگان (تریال) > probation
const DURATION_ORDER = ["lifetime", "5days", "probation"];

// ── appId های مجاز ────────────────────────────────────────────────────────
// لیست application id های سه اپ. اگه appId ارسالی توی این لیست نباشه
// درخواست رد میشه (جلوی سوءاستفاده با appId جعلی رو هم می‌گیره).
const ALLOWED_APP_IDS = [
  "com.BuskitApp.LiveFX",
  "com.BuskitApp.Tools", // ← application id واقعی اپ دوم رو اینجا بذار
  "com.BuskitApp.LiveTools", // ← application id واقعی اپ سوم رو اینجا بذار
];

// ── fingerprint رو برای Firestore document ID ایمن کن ────────────────────
function toSafeId(fingerprint) {
  return fingerprint.replace(/\//g, "_").replace(/\+/g, "-").replace(/=/g, "");
}

// ── شناسه‌ی ترکیبی «دستگاه + اپ» ──────────────────────────────────────────
// همه جایی که قبلاً فقط از fingerprint به‌عنوان کلید استفاده می‌شد، حالا از
// این ترکیب استفاده می‌کنیم تا سه اپ روی یک گوشی کاملاً از هم جدا بمونن.
function deviceAppId(fingerprint, appId) {
  return `${toSafeId(fingerprint)}__${appId}`;
}

// ── ساخت token امضاشده (RSA-SHA256) ──────────────────────────────────────
// appId هم داخل payload امضا میشه، پس کلاینت هم می‌تونه (به‌عنوان لایه‌ی دفاع
// دوم) چک کنه که این توکن واقعاً برای همین اپ صادر شده، نه یک اپ دیگه.
// tier هم اینجا داخل payload امضا میشه چون FeatureGate سمت اپ هنوز روی
// همین فیلد کار می‌کنه؛ فعلاً فقط مقدار "gold" صادر می‌شه (تک‌محصولی).
function createSignedToken(
  fingerprint,
  appId,
  licenseCode,
  licenseType,
  expiresAt,
  tier,
) {
  const payload = JSON.stringify({
    fingerprint,
    appId,
    licenseCode,
    licenseType,
    tier,
    expiresAt: expiresAt ?? null,
    issuedAt: Date.now(),
  });
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(payload);
  const signature = sign.sign(privateKey, "base64");
  return Buffer.from(payload).toString("base64") + "|" + signature;
}

// ── سطح لایسنس رو با fail-safe از سند لایسنس بخون ──────────────────────
// دیگه فقط یک سطح ("gold") وجود داره چون فقط یک محصول می‌فروشی. اگه به هر
// دلیلی (داده‌ی قدیمی از قبل که bronze/silver داشت، یا فیلد خالی) مقدار
// نامعتبر بود، به‌جای این‌که کاربر رو قفل کنیم (fail-closed به یک سطح
// پایین‌تر که دیگه اصلاً وجود نداره)، همون "gold" برمی‌گردونیم — چون همه‌ی
// لایسنس‌های معتبر الان یک سطح دارن.
function resolveTier(licenseData) {
  return "gold";
}

// ── appGeneration: شناسه‌ی «نسل» اپ (برای نسخه‌های بعدی/اپ‌های جدید) ──────
// این فیلد فقط زیرساخته — فعلاً هیچ منطق قفل‌کردن/تشخیص ارتقا روش سوار
// نیست. هدف این‌ه که از همین الان، هم لایسنس‌ها (بسته به این‌که برای کدوم
// نسل خریداری شدن) هم دستگاه‌ها (بسته به این‌که کلاینتِ کدوم نسل داره
// باهاشون حرف می‌زنه) این مقدار رو ذخیره کنن، تا هروقت فیچر تشخیص/ارتقا
// پیاده‌سازی شد، نیازی به migration داده‌ی قدیمی نباشه.
const CURRENT_APP_GENERATION = "v1";
function resolveAppGeneration(licenseData) {
  return (licenseData && licenseData.appGeneration) || "v1";
}

// ════════════════════════════════════════════════════════════════════════
//  اعلام سراسری ورژن/آپدیت اپ
// ════════════════════════════════════════════════════════════════════════
// هر appId یک سند مستقل در appVersions/{appId} داره:
//   {
//     version: 2, versionType: "free"|"paid",
//     versionDownloadUrl, versionPurchaseUrl, versionNotes,
//     update: 3, updateType: "free"|"paid",
//     updateDownloadUrl, updatePurchaseUrl, updateNotes,
//   }
// "version" و "update" همیشه عددِ صرف هستن (نه رشته‌ی "v2"/"u3") — پیشوند
// v/u فقط موقع ساختن پاسخ برای کلاینت اضافه می‌شه. هر بار که یک ورژن جدید
// اعلام بشه (با /admin/announce-version)، update خودکار صفر می‌شه چون
// آپدیت‌های ورژن قبلی دیگه به دردی نمی‌خورن.
async function getVersionDoc(appId) {
  const doc = await db.collection("appVersions").doc(appId).get();
  return doc.exists ? doc.data() : null;
}

// کلاینت currentVersion/currentUpdate رو به‌صورت عدد می‌فرسته. اگه هنوز
// چیزی روی سرور اعلام نشده (versionDoc=null)، یعنی آپدیتی مطرح نیست.
// اگه هم ورژن هم آپدیتِ سرور از کلاینت جلوتره، ورژن اولویت داره (چون خودِ
// ورژن جدید معمولاً شامل همه‌ی آپدیت‌های قبلی هم هست).
function buildVersionInfo(versionDoc, clientVersion, clientUpdate) {
  if (!versionDoc) return { updateAvailable: false };

  const serverVersion = Number(versionDoc.version) || 1;
  const serverUpdate = Number(versionDoc.update) || 0;
  const cVersion = Number(clientVersion) || 0;
  const cUpdate = Number(clientUpdate) || 0;

  const newVersionAvailable = serverVersion > cVersion;
  const newUpdateAvailable = !newVersionAvailable && serverUpdate > cUpdate;

  if (!newVersionAvailable && !newUpdateAvailable) {
    return { updateAvailable: false };
  }

  if (newVersionAvailable) {
    return {
      updateAvailable: true,
      kind: "version",
      label: `v${serverVersion}`,
      type: versionDoc.versionType || "free",
      downloadUrl: versionDoc.versionDownloadUrl || null,
      purchaseUrl: versionDoc.versionPurchaseUrl || null,
      notes: versionDoc.versionNotes || "",
    };
  }

  return {
    updateAvailable: true,
    kind: "update",
    label: `u${serverUpdate}`,
    type: versionDoc.updateType || "free",
    downloadUrl: versionDoc.updateDownloadUrl || null,
    purchaseUrl: versionDoc.updatePurchaseUrl || null,
    notes: versionDoc.updateNotes || "",
  };
}

// ── ثبت/به‌روزرسانی ایندکس devices/{fingerprint__appId} ──────────────────
// این ایندکس باعث میشه /signin بتونه با یک خوندن بفهمه این ترکیب
// «گوشی + اپ» توی کدوم سطح(ها)ی لایسنس عضویت داره.
// appGeneration: نسل اپی که همین الان روی این دستگاه نصبه و داره درخواست
// می‌زنه (نه لزوماً نسل لایسنس) — صرفاً ذخیره می‌شه، فعلاً جایی ازش برای
// تصمیم‌گیری استفاده نمی‌کنیم.
async function linkDevice(
  fingerprint,
  appId,
  licenseType,
  licenseCode,
  appGeneration,
) {
  const docId = deviceAppId(fingerprint, appId);
  await db
    .collection("devices")
    .doc(docId)
    .set(
      {
        fingerprint,
        appId,
        appGeneration: appGeneration || CURRENT_APP_GENERATION,
        links: {
          [licenseType]: licenseCode,
        },
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
}

function isValidAppId(appId) {
  return typeof appId === "string" && ALLOWED_APP_IDS.includes(appId);
}

// ════════════════════════════════════════════════════════════════════════
//  کد تخفیف سایت → رزرو لایسنس واقعی (Buskit-Tools purchase form)
// ════════════════════════════════════════════════════════════════════════
//
// چون فقط یک محصول (لایسنس مادام‌العمر) می‌فروشی، این نگاشت هم به یک
// ورودی محدود شده. اگه فرم خرید سایت هنوز فعاله، مطمئن شو فقط همین یک
// productKey ("p1") رو به سرور می‌فرسته.
const PRODUCT_LICENSE_MAP = {
  p1: { tier: "gold", license_type: "lifetime", appGeneration: "v1" },
};

// ── نگاشت variant_id لمون‌اسکوییزی → سطح و مدت لایسنس ─────────────────────
// فقط یک محصول/یک Variant می‌فروشی (لایسنس مادام‌العمر)، پس این نگاشت فقط
// یک ورودی داره. مقدار 111001 رو با variant_id واقعی محصولت توی داشبورد
// Lemon Squeezy (Products → آن محصول → Variant) جایگزین کن. این نگاشت
// عمداً سمت سرور نگه داشته می‌شه (نه چیزی که از بدنه‌ی وبهوک خونده بشه)،
// تا کسی نتونه با جعل payload لایسنس مجانی بگیره.
const LS_VARIANT_LICENSE_MAP = {
  2059669: { tier: "gold", license_type: "lifetime", appGeneration: "v1" },
};

// ── نگاشت مرجع سفارش Payoneer Checkout → سطح و مدت لایسنس ────────────────
// برخلاف Lemon Squeezy که یک variant_id ثابت روی محصول داشبوردش بود،
// Payoneer Checkout معمولاً یک «مرجع سفارش» (merchant reference / order
// id) رو خودِ سرور شما موقع ساخت صفحه‌ی پرداخت تعیین می‌کنه (یا اگه لینک
// پرداخت ثابت از پنل دارید، همون لینک یک کد ثابت داره که می‌تونید توی
// تنظیمات آن لینک یک reference دلخواه برایش بگذارید). پس این مقدار رو با
// همون رشته‌ای که خودتان برای این محصول (لایسنس مادام‌العمر) انتخاب
// می‌کنید عوض کنید — مثلاً "buskit-lifetime". این نگاشت عمداً سمت سرور
// نگه داشته می‌شه (نه چیزی که از payload وبهوک خونده بشه)، تا کسی نتونه
// با جعل payload لایسنس مجانی بگیره.
const PAYONEER_REFERENCE_LICENSE_MAP = {
  "buskit-lifetime": { tier: "gold", license_type: "lifetime", appGeneration: "v1" },
};

// ── احراز هویت وبهوک Payoneer Checkout ────────────────────────────────────
// ⚠️ TODO_VERIFY: این تابع بر اساس رایج‌ترین مدل احراز هویتِ این خانواده از
// APIها (Optile/Payoneer Checkout) نوشته شده: شما توی پنل Payoneer، بخش
// Checkout → Integration → API access (یا معادلش برای notification URL)
// یک username/password یا token تنظیم می‌کنید؛ Payoneer همون‌ها رو به‌صورت
// HTTP Basic Auth روی هدر Authorization هر وبهوک می‌فرسته. من نتوانستم
// مستقیماً صفحه‌ی رسمی وبهوک Payoneer را باز کنم (دسترسی برایم مسدود بود)،
// پس این را حتماً یک بار با یک پرداخت تستی/Sandbox چک کنید: اگر واقعاً
// Authorization: Basic ... می‌آید همین تابع کافیست؛ اگر به‌جایش یک هدر
// امضا (مثل X-Payoneer-Signature) دیدید، این تابع را با HMAC (شبیه تابع
// وبهوک Lemon Squeezy بالاتر) جایگزین کنید.
function verifyPayoneerNotification(req) {
  const authHeader = req.headers["authorization"] || "";
  if (!authHeader.startsWith("Basic ")) return false;

  const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
  const separatorIndex = decoded.indexOf(":");
  if (separatorIndex === -1) return false;

  const user = decoded.slice(0, separatorIndex);
  const pass = decoded.slice(separatorIndex + 1);

  const expectedUser = process.env.PAYONEER_NOTIFICATION_USER || "";
  const expectedPass = process.env.PAYONEER_NOTIFICATION_PASS || "";
  if (!expectedUser || !expectedPass) return false;

  // constant-time compare تا از timing attack جلوگیری شه
  const userBuf = Buffer.from(user);
  const expectedUserBuf = Buffer.from(expectedUser);
  const passBuf = Buffer.from(pass);
  const expectedPassBuf = Buffer.from(expectedPass);

  const userMatches =
    userBuf.length === expectedUserBuf.length &&
    crypto.timingSafeEqual(userBuf, expectedUserBuf);
  const passMatches =
    passBuf.length === expectedPassBuf.length &&
    crypto.timingSafeEqual(passBuf, expectedPassBuf);

  return userMatches && passMatches;
}

// ── کد سیستمیِ «بدون کد تخفیف» ────────────────────────────────────────────
// هر سفارشی که هیچ کد تخفیفِ واقعی روش اعمال نشده (یا مشتری اصلاً کدی وارد
// نکرده، یا برای همین آیتم مشخص discountApplied نداشته) به‌جای این‌که هیچ
// جا ثبت نشه، زیر همین کد جمع می‌شه؛ این‌طوری از همون تب «کدهای تخفیف»ِ پنل
// ادمین می‌تونی آمار فروشِ مستقیم/بدون‌نماینده رو هم کنار آمار هر نماینده
// ببینی، بدون این‌که مشتری مجبور باشه چیزی تایپ کنه. این کد صفر درصد/صفر
// مبلغ تخفیف داره — پس هیچ تاثیری روی قیمت نمی‌ذاره، فقط برای آماره.
const NO_DISCOUNT_CODE = "NODISCOUNT";

// ── تولید یک کد لایسنس تصادفی و خوانا (بدون حروف/ارقام شبیه‌به‌هم مثل O/0, I/1) ──
const LICENSE_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function generateLicenseCode() {
  let code = "";
  for (let i = 0; i < 10; i++) {
    code += LICENSE_CODE_ALPHABET[crypto.randomInt(LICENSE_CODE_ALPHABET.length)];
  }
  return code;
}

// ── ارسال ایمیل حاوی کد لایسنس به خریدار (بعد از تایید پرداخت — مستقل از
// درگاه، همین تابع برای Lemon Squeezy و Payoneer هردو صدا زده می‌شه) ──────
async function sendLicenseEmail(email, name, licenseCode) {
  const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
  sendSmtpEmail.sender = {
    name: "Buskit",
    email: process.env.BREVO_SENDER_EMAIL, // ← همون ایمیلی که توی Brevo verify کردی
  };
  sendSmtpEmail.to = [{ email, name: name || undefined }];
  sendSmtpEmail.subject = "کد لایسنس Buskit شما";

  // ── کادر آبی جداکننده‌ی بین دو زبان — فقط اسم زبانِ بخش بعدی، وسط‌چین ──
  const langDivider = (label) => `
    <div style="background:#4472C4; color:#ffffff; text-align:center; font-weight:bold; padding:6px 0; margin:18px 0; border-radius:4px; font-family: Tahoma, Arial, sans-serif;">
      ${label}
    </div>
  `;

  sendSmtpEmail.htmlContent = `
    <div style="font-family: Tahoma, Arial, sans-serif;">

      <!-- Türkçe -->
      <div dir="ltr" style="text-align:left;">
        <p>Merhaba ${name || ""},</p>
        <p>Güveniniz ve satın alımınız için içtenlikle teşekkür ederiz. Bu uygulamayı kullanarak unutulmaz anlar yaratmanızı umuyoruz.</p>
        <p>Ömür boyu geçerli lisans kodunuz:</p>
        <h2 style="letter-spacing:2px;">${licenseCode}</h2>
        <p>Uygulamayı etkinleştirmek için ilk girişte yukarıdaki kodu, uygulama içindeki Activation sayfasında belirtilen alana girin.</p>
        <p>Not: Her lisans yalnızca bir cihazda etkinleştirilebilir.</p>
        <p>Herhangi bir sorunla karşılaşırsanız veya yardıma ihtiyaç duyarsanız bizimle şu yollarla iletişime geçebilirsiniz:<br>
        WhatsApp: 00905312691609<br>
        Web sitesi: www.BuskitApps.onrender.com</p>
      </div>

      ${langDivider("English")}

      <!-- English -->
      <div dir="ltr" style="text-align:left;">
        <p>Hello ${name || ""},</p>
        <p>We are truly grateful for your trust and purchase. We hope you create unforgettable moments using this application.</p>
        <p>Your lifetime license code:</p>
        <h2 style="letter-spacing:2px;">${licenseCode}</h2>
        <p>To activate the app, on first launch enter the code above in the designated field on the Activation page inside the app.</p>
        <p>Note: Each license can only be activated on one device.</p>
        <p>If you run into any issues or need assistance, you can reach us via:<br>
        WhatsApp: 00905312691609<br>
        Website: www.BuskitApps.onrender.com</p>
      </div>

      ${langDivider("فارسی")}

      <!-- فارسی -->
      <div dir="rtl" style="text-align:right;">
        <p>سلام ${name || ""}،</p>
        <p>از اعتماد و خرید شما بسیار سپاسگزاریم. امیدواریم با استفاده از این اپلیکیشن لحظاتی به یاد ماندنی خلق کنید.</p>
        <p>کد لایسنس دائمی شما:</p>
        <h2 style="letter-spacing:2px;">${licenseCode}</h2>
        <p>برای فعال سازی اپلیکیشن، در هنگام اولین ورود، کد بالا را داخل اپلیکیشن در محل مشخص شده در صفحه‌ی Activation وارد کنید.</p>
        <p>توجه: هر لایسنس فقط روی یک دستگاه قابل فعال‌سازی میباشد.</p>
        <p>در صورت بروز هر گونه مشکل یا نیاز به هرگونه راهنمایی از طرق زیر می‌توانید با ما در تماس باشید:<br>
        واتس‌آپ: 00905312691609<br>
        وب‌سایت: www.BuskitApps.onrender.com</p>
      </div>

    </div>
  `;

  await brevoEmailApi.sendTransacEmail(sendSmtpEmail);
}

// ════════════════════════════════════════════════════════════════════════
//  📧 ایمیل تحویل لایسنس probation (۲ روزه، پیش از دریافت وجه)
// ════════════════════════════════════════════════════════════════════════
// این ایمیل بلافاصله بعد از زدن دکمه «ثبت و دریافت لایسنس» در سایت برای
// مشتری فرستاده می‌شود: کد لایسنس را همان لحظه تحویل می‌دهد و هم‌زمان
// یادآوری می‌کند که ظرف ۲ روز باید وجه را واریز کند، وگرنه سیستم خودش
// لایسنس را غیرفعال می‌کند (چون license_type = "probation" است و
// expires_at آن دو روز بعد از فعال‌سازی ست می‌شود).
// متن بر اساس زبانِ انتخاب‌شده در سایت (fa / en / tr / de) فرستاده می‌شود.

const PROBATION_PRICE_USD = 50;

// اطلاعات حساب‌ها یک‌جا نگه داشته می‌شود تا در هر چهار زبان یکسان باشد و
// اگر روزی عوض شد فقط همین‌جا ویرایش شود.
const PAYMENT_ACCOUNTS = {
  iranCard: "6104-3373-3362-3831",
  iranBank: "Bank Mellat",
  iranOwnerFa: "محمدرضا عموئیان",
  iranOwnerEn: "MohammadReza Amoeyan",
  trIban: "TR10 0001 0008 3596 2786 0050 01",
  trBank: "Ziraat Bank",
  trOwner: "MohammadReza Amoeyan",
  contactEmail: "BuskitApps@gmail.com",
  whatsapp: "00905312691609",
};

function buildAccountsBlock(lang) {
  const t = {
    fa: {
      heading: "حساب‌های بانکی جهت واریز وجه:",
      iran: "کارت بانکی ایران (بانک ملت):",
      owner: "به نام:",
      tr: "حساب لیر ترکیه (Ziraat Bank):",
    },
    en: {
      heading: "Bank accounts for payment:",
      iran: "Iranian bank card (Bank Mellat):",
      owner: "Account holder:",
      tr: "Turkish Lira account (Ziraat Bank):",
    },
    tr: {
      heading: "Ödeme için banka hesapları:",
      iran: "İran banka kartı (Bank Mellat):",
      owner: "Hesap sahibi:",
      tr: "Türk Lirası hesabı (Ziraat Bank):",
    },
    de: {
      heading: "Bankkonten für die Zahlung:",
      iran: "Iranische Bankkarte (Bank Mellat):",
      owner: "Kontoinhaber:",
      tr: "Türkische-Lira-Konto (Ziraat Bank):",
    },
  }[lang] || null;
  const L = t || {
    heading: "Bank accounts for payment:",
    iran: "Iranian bank card (Bank Mellat):",
    owner: "Account holder:",
    tr: "Turkish Lira account (Ziraat Bank):",
  };
  const owner =
    lang === "fa" ? PAYMENT_ACCOUNTS.iranOwnerFa : PAYMENT_ACCOUNTS.iranOwnerEn;
  return `
    <div style="border:1px solid #d0d7e2; border-radius:6px; padding:12px; margin:14px 0;">
      <p style="font-weight:bold; margin:0 0 8px 0;">${L.heading}</p>
      <p style="margin:0 0 4px 0;">${L.iran}</p>
      <p dir="ltr" style="font-family:monospace; font-size:15px; margin:0 0 2px 0; text-align:left;">${PAYMENT_ACCOUNTS.iranCard}</p>
      <p style="margin:0 0 10px 0; font-size:12px; color:#555;">${L.owner} ${owner}</p>
      <p style="margin:0 0 4px 0;">${L.tr}</p>
      <p dir="ltr" style="font-family:monospace; font-size:15px; margin:0 0 2px 0; text-align:left;">${PAYMENT_ACCOUNTS.trIban}</p>
      <p style="margin:0; font-size:12px; color:#555;">${L.owner} ${PAYMENT_ACCOUNTS.trOwner}</p>
    </div>
  `;
}

function buildProbationEmail(lang, name, licenseCode) {
  const code = `<h2 style="letter-spacing:3px; font-family:monospace; direction:ltr; text-align:center; background:#f2f4f8; padding:10px; border-radius:6px;">${licenseCode}</h2>`;
  const price = PROBATION_PRICE_USD;
  const mail = PAYMENT_ACCOUNTS.contactEmail;
  const wa = PAYMENT_ACCOUNTS.whatsapp;

  if (lang === "fa") {
    return {
      subject: "لایسنس اپلیکیشن BuskitTools شما",
      html: `
      <div dir="rtl" style="font-family: Tahoma, Arial, sans-serif; text-align:right; line-height:1.9;">
        <p>هنرمند گرامی، سلام</p>
        <p>بدین وسیله لایسنس شما به شماره‌ی زیر برای اپلیکیشن <b>BuskitTools</b> تقدیم می‌گردد:</p>
        ${code}
        <p>امیدواریم تا اجراهایی با کیفیت و شنیدنی با استفاده از این اپلیکیشن داشته باشید. بسیار خوشحال خواهیم شد تا پیشنهادات یا نظرات خود را در خصوص این اپلیکیشن از طریق همین آدرس ایمیل اعلام فرمایید.</p>
        <p>ضمناً خواهشمند است ظرف مدت <b>۲ روز</b> وجه این لایسنس را (<b>${price} دلار</b>) به یکی از حساب‌های زیر واریز و سند واریزی را از طریق همین ایمیل ارسال دارید؛ متأسفانه در غیر این صورت سیستم بعد از ۲ روز این لایسنس را غیرفعال خواهد کرد.</p>
        ${buildAccountsBlock("fa")}
        <p>در صورت وجود هرگونه ابهام، از طریق واتس‌آپ ${wa} یا همین ایمیل (${mail}) با ما در تماس باشید.</p>
        <p>به امید شادی و سلامت</p>
      </div>`,
    };
  }

  if (lang === "tr") {
    return {
      subject: "BuskitTools uygulaması lisansınız",
      html: `
      <div dir="ltr" style="font-family: Tahoma, Arial, sans-serif; text-align:left; line-height:1.8;">
        <p>Değerli sanatçı, merhaba${name ? " " + name : ""},</p>
        <p><b>BuskitTools</b> uygulaması için lisansınızı aşağıda sunuyoruz:</p>
        ${code}
        <p>Bu uygulamayı kullanarak kaliteli ve keyifli performanslar gerçekleştirmenizi diliyoruz. Uygulamayla ilgili öneri ve görüşlerinizi bu e-posta adresi üzerinden bizimle paylaşırsanız çok memnun oluruz.</p>
        <p>Ayrıca lisans bedelini (<b>${price} USD</b>) <b>2 gün</b> içinde aşağıdaki hesaplardan birine yatırmanızı ve dekontu yine bu e-posta adresine göndermenizi rica ederiz. Aksi hâlde sistem 2 gün sonra bu lisansı otomatik olarak devre dışı bırakacaktır.</p>
        ${buildAccountsBlock("tr")}
        <p>Herhangi bir sorunuz olursa WhatsApp ${wa} numarasından veya ${mail} adresinden bize ulaşabilirsiniz.</p>
        <p>Sağlık ve mutluluk dileğiyle.</p>
      </div>`,
    };
  }

  if (lang === "de") {
    return {
      subject: "Ihre Lizenz für die BuskitTools-App",
      html: `
      <div dir="ltr" style="font-family: Tahoma, Arial, sans-serif; text-align:left; line-height:1.8;">
        <p>Sehr geehrte Künstlerin, sehr geehrter Künstler${name ? " " + name : ""},</p>
        <p>hiermit überreichen wir Ihnen Ihre Lizenz für die App <b>BuskitTools</b>:</p>
        ${code}
        <p>Wir hoffen, dass Sie mit dieser App hochwertige und mitreißende Auftritte gestalten. Über Ihre Anregungen oder Rückmeldungen zur App an diese E-Mail-Adresse freuen wir uns sehr.</p>
        <p>Bitte überweisen Sie den Lizenzbetrag (<b>${price} USD</b>) innerhalb von <b>2 Tagen</b> auf eines der unten genannten Konten und senden Sie den Zahlungsbeleg an diese E-Mail-Adresse. Andernfalls wird das System diese Lizenz nach 2 Tagen leider automatisch deaktivieren.</p>
        ${buildAccountsBlock("de")}
        <p>Bei Fragen erreichen Sie uns über WhatsApp ${wa} oder unter ${mail}.</p>
        <p>Mit den besten Wünschen für Gesundheit und Freude.</p>
      </div>`,
    };
  }

  return {
    subject: "Your BuskitTools app license",
    html: `
      <div dir="ltr" style="font-family: Tahoma, Arial, sans-serif; text-align:left; line-height:1.8;">
        <p>Dear artist${name ? " " + name : ""}, hello,</p>
        <p>We are pleased to present your license for the <b>BuskitTools</b> app:</p>
        ${code}
        <p>We hope you create high-quality and memorable performances with this application. We would be very glad to hear your suggestions or feedback about the app at this same email address.</p>
        <p>Please also transfer the license fee (<b>${price} USD</b>) within <b>2 days</b> to one of the accounts below and send the payment receipt to this same email address. Otherwise, the system will unfortunately deactivate this license after 2 days.</p>
        ${buildAccountsBlock("en")}
        <p>If anything is unclear, contact us via WhatsApp ${wa} or at ${mail}.</p>
        <p>Wishing you health and happiness.</p>
      </div>`,
  };
}

async function sendProbationLicenseEmail(email, name, licenseCode, lang) {
  const { subject, html } = buildProbationEmail(lang, name, licenseCode);
  const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
  sendSmtpEmail.sender = {
    name: "Buskit",
    // باید همان آدرسی باشد که در Brevo verify شده؛ اگر BuskitApps@gmail.com
    // را آنجا به‌عنوان sender تایید کرده‌اید، همین مقدار را در متغیر محیطی
    // BREVO_SENDER_EMAIL بگذارید.
    email: process.env.BREVO_SENDER_EMAIL || PAYMENT_ACCOUNTS.contactEmail,
  };
  // پاسخ مشتری (ارسال سند واریزی) همیشه به آدرس اصلی برگردد
  sendSmtpEmail.replyTo = { email: PAYMENT_ACCOUNTS.contactEmail, name: "Buskit" };
  sendSmtpEmail.to = [{ email, name: name || undefined }];
  sendSmtpEmail.subject = subject;
  sendSmtpEmail.htmlContent = html;
  await brevoEmailApi.sendTransacEmail(sendSmtpEmail);
}

// ════════════════════════════════════════════════════════════════════════
//  🎫 صدور فوری لایسنس probation از فرم سایت («ثبت و دریافت لایسنس»)
// ════════════════════════════════════════════════════════════════════════
// جریان کار:
//   ۱) نام/ایمیل/واتس‌اپ را از فرم سایت می‌گیرد.
//   ۲) چک می‌کند که همین ایمیل قبلاً یک لایسنس probation نگرفته باشد (تا
//      کسی با زدنِ پی‌درپی دکمه، ده‌ها کد رایگان نسازد). سقف اصلی و
//      غیرقابل‌دورزدن همچنان در /activate است (hadProbationLicense روی سند
//      دستگاه) — این‌جا فقط جلوی ساختِ سندهای زائد را می‌گیریم.
//   ۳) یک سند در licenses با license_type:"probation" می‌سازد.
//   ۴) کد را فوراً با ایمیل (به زبان انتخاب‌شده در سایت) می‌فرستد.
//   ۵) یک سند در licenseRequests هم برای پنل ادمین ثبت می‌کند.
// نکته: expires_at این‌جا ست نمی‌شود؛ شمارش ۲ روز از لحظه‌ی فعال‌سازی روی
// گوشی در /activate شروع می‌شود (LICENSE_DURATIONS.probation).
app.post("/request-probation-license", async (req, res) => {
  try {
    const { name, email, whatsapp, lang } = req.body || {};

    const cleanName = typeof name === "string" ? name.trim() : "";
    const cleanEmail =
      typeof email === "string" ? email.trim().toLowerCase() : "";
    const cleanWhatsapp = typeof whatsapp === "string" ? whatsapp.trim() : "";
    const safeLang = ["fa", "en", "tr", "de"].includes(lang) ? lang : "en";

    if (!cleanName || !cleanEmail || !/^\S+@\S+\.\S+$/.test(cleanEmail)) {
      return res
        .status(400)
        .json({ success: false, error: "invalid-input" });
    }

    // ── یک ایمیل = یک لایسنس probation ──────────────────────────────────
    const dup = await db
      .collection("licenses")
      .where("email", "==", cleanEmail)
      .where("license_type", "==", "probation")
      .limit(1)
      .get();
    if (!dup.empty) {
      return res
        .status(409)
        .json({ success: false, error: "already-issued" });
    }

    const licenseCode = generateLicenseCode();
    await db
      .collection("licenses")
      .doc(licenseCode)
      .set({
        tier: "gold",
        license_type: "probation",
        appGeneration: CURRENT_APP_GENERATION,
        is_shared: false,
        is_used: false,
        // فلگ درخواستیِ شما روی خود سند لایسنس. توجه: گیتِ واقعیِ «هر دستگاه
        // فقط یک probation» در /activate روی سند devices/{fingerprint__appId}
        // نوشته می‌شود؛ این فیلد صرفاً برای گزارش‌گیری در پنل ادمین است.
        hadProbationLicense: true,
        name: cleanName,
        email: cleanEmail,
        whatsapp: cleanWhatsapp,
        lang: safeLang,
        priceUsd: PROBATION_PRICE_USD,
        paid: false, // بعد از دریافت سند واریزی، دستی true کنید
        source: "website-probation",
        delivered: false, // پایین‌تر، بعد از ارسال موفق ایمیل، true می‌شود
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    let emailSent = true;
    const now = new Date().toLocaleString("fa-IR", {
      timeZone: "Europe/Istanbul",
    });
    try {
      await sendProbationLicenseEmail(
        cleanEmail,
        cleanName,
        licenseCode,
        safeLang,
      );
      await db
        .collection("licenses")
        .doc(licenseCode)
        .update({
          delivered: true,
          deliveredAt: admin.firestore.FieldValue.serverTimestamp(),
        });

      notifyWhatsapp(
        `📩 لایسنس جدید صادر شد\n` +
          `منبع خرید: Probation (آزمایشی رایگان)\n` +
          `نام: ${cleanName}\n` +
          `ایمیل: ${cleanEmail}\n` +
          `واتس‌آپ خریدار: ${cleanWhatsapp}\n` +
          `کد لایسنس: ${licenseCode}\n` +
          `تاریخ/ساعت: ${now}`,
      );
    } catch (mailErr) {
      emailSent = false;
      console.error("خطا در ارسال ایمیل لایسنس probation:", mailErr);

      notifyWhatsapp(
        `⚠️ لایسنس صادر شد ولی ایمیل ارسال نشد\n` +
          `منبع خرید: Probation (آزمایشی رایگان)\n` +
          `نام: ${cleanName}\n` +
          `ایمیل: ${cleanEmail}\n` +
          `واتس‌آپ خریدار: ${cleanWhatsapp}\n` +
          `کد لایسنس: ${licenseCode}\n` +
          `تاریخ/ساعت: ${now}\n` +
          `خطا: ${mailErr.message || mailErr}`,
      );
    }

    // ثبت درخواست برای پنل ادمین (همان کالکشنی که قبلاً سایت خودش می‌نوشت)
    try {
      await db.collection("licenseRequests").add({
        name: cleanName,
        email: cleanEmail,
        whatsapp: cleanWhatsapp,
        lang: safeLang,
        licenseCode,
        license_type: "probation",
        license_sent: emailSent,
        paid: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (reqErr) {
      console.error("خطا در ثبت licenseRequests:", reqErr);
    }

    // اگر ایمیل نرفت، به کاربر می‌گوییم که با پشتیبانی تماس بگیرد — کد
    // لایسنس را عمداً در پاسخ HTTP برنمی‌گردانیم تا فقط از راه ایمیل
    // تحویل داده شود.
    if (!emailSent) {
      return res.status(502).json({ success: false, error: "email-failed" });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("خطا در request-probation-license:", err);
    return res.status(500).json({ success: false, error: "server-error" });
  }
});

// ── بررسی سریع و فقط-خواندنیِ یک کد تخفیف (پیش‌نمایش درصد/مبلغ تخفیف در فرم
//    خرید سایت) — این مسیر چیزی رو مصرف/تغییر نمی‌دهد، فقط گزارش می‌کند.
app.get("/check-discount/:code", async (req, res) => {
  try {
    const code = (req.params.code || "").trim().toUpperCase();
    if (!code) {
      return res.status(400).json({ valid: false, error: "no-code" });
    }
    // این کد یک بازه‌ی داخلی/سیستمی برای آمارِ فروش مستقیم است، نه یک کدِ
    // تخفیفِ واقعی که قرار باشد مشتری‌ها دستی واردش کنند
    if (code === NO_DISCOUNT_CODE) {
      return res.status(404).json({ valid: false, error: "not-found" });
    }

    const snap = await db.collection("discountCodes").doc(code).get();
    if (!snap.exists) {
      return res.status(404).json({ valid: false, error: "not-found" });
    }
    // کد تخفیف صرفاً باید وجود داشته باشد؛ می‌تواند به دفعات نامحدود
    // استفاده شود (هر بار فقط برای آمار/پورسانتِ نماینده ثبت می‌گردد)
    const data = snap.data();
    return res.status(200).json({
      valid: true,
      percent: Number(data.percent) || 0,
      amount: Number(data.amount) || 0,
    });
  } catch (err) {
    console.error("خطا در بررسی کد تخفیف:", err);
    return res.status(500).json({ valid: false, error: "server-error" });
  }
});

// ── ثبت نهایی سفارش: وقتی کاربر در فرم خرید سایت محصولات را انتخاب کرد و
//    روی «ثبت سفارش» زد صدا زده می‌شود — چه کد تخفیف داشته باشد چه نه.
//    با یک تراکنش Firestore:
//      ۱) هر آیتمِ سفارش می‌تواند جداگانه discountApplied:true/false داشته
//         باشد (یعنی «این محصول با کد تخفیف حساب شود یا نه»). فقط به تعدادِ
//         آیتم‌هایی که واقعاً discountApplied:true دارند، آمار فروشِ کدِ
//         واقعی (salesCount) در discountCodes بالا می‌رود. بقیه‌ی آیتم‌ها
//         (چه کدی وارد نشده باشد، چه discountApplied آن‌ها false باشد) به‌جای
//         این‌که هیچ‌جا ثبت نشوند، زیر کد سیستمیِ NO_DISCOUNT_CODE جمع
//         می‌شوند تا آمار فروش مستقیم/بدون‌نماینده هم قابل پیگیری باشد.
//      ۲) به ازای هر محصولِ نرم‌افزاریِ انتخاب‌شده، یک سند واقعی و کاربردی
//         در همون کالکشن licenses می‌سازد (is_used:false) — دقیقاً همون
//         سندی که بعداً با /activate کامل می‌شود (fingerprint/expires_at/...)
//      ۳) یک سند سفارش در orders برای پیگیری/جست‌وجو با ایمیل ثبت می‌کند
// توجه: کدِ لایسنس واقعی هرگز در پاسخ برنمی‌گردد — چون از همین الان قابل
// فعال‌سازی است و نباید قبل از تایید واریزی دست کاربر باشد. مدیر سایت بعداً
// از پنل ادمین (تب لایسنس‌ها) یا با جست‌وجوی ایمیل در Firestore پیدایش می‌کند.
app.post("/create-order", async (req, res) => {
  try {
    const { discountCode: rawCode, name, email, items } = req.body;

    if (!name || !email) {
      return res.status(400).json({
        success: false,
        error: "نام و ایمیل الزامی است",
      });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res
        .status(400)
        .json({ success: false, error: "هیچ محصولی انتخاب نشده" });
    }

    let code = rawCode ? rawCode.trim().toUpperCase() : null;
    // کدِ سیستمیِ فروشِ مستقیم را از ورودیِ عمومی نادیده می‌گیریم — این کد
    // فقط داخلی است و پایین‌تر خودِ سرور به‌صورت خودکار مدیریتش می‌کند
    if (code === NO_DISCOUNT_CODE) code = null;

    // فقط آیتم‌های نرم‌افزاریِ لایسنس‌دار را از روی نگاشت امن سمت سرور جدا
    // می‌کنیم؛ برای هر کدام، کنارِ اطلاعات لایسنس، پرچمِ discountApplied
    // همان آیتم را هم نگه می‌داریم (فقط وقتی کد ارسال شده معتبر باشد معنا دارد)
    const licenseItems = items
      .map((it) => {
        const info = PRODUCT_LICENSE_MAP[it && it.productKey];
        if (!info) return null;
        return { info, discountApplied: !!(code && it && it.discountApplied) };
      })
      .filter(Boolean);

    if (licenseItems.length === 0) {
      return res.status(400).json({
        success: false,
        error: "هیچ محصول لایسنس‌داری در سفارش انتخاب نشده",
      });
    }

    // آیتم‌هایی که واقعاً قرار است کد تخفیفِ وارد شده رویشان اعمال شود، در
    // برابر بقیه‌ی آیتم‌ها که (بدون کد یا با discountApplied:false) زیر کد
    // سیستمیِ «فروش مستقیم» جمع می‌شوند
    const discountedCount = licenseItems.filter((it) => it.discountApplied).length;
    const directCount = licenseItems.length - discountedCount;

    const codeRef =
      code && discountedCount > 0 ? db.collection("discountCodes").doc(code) : null;
    const directRef =
      directCount > 0 ? db.collection("discountCodes").doc(NO_DISCOUNT_CODE) : null;
    const orderRef = db.collection("orders").doc();
    const licenseRefs = licenseItems.map(() =>
      db.collection("licenses").doc(generateLicenseCode()),
    );

    const reservedCount = await db.runTransaction(async (tx) => {
      // اگر کد تخفیفی واقعاً روی حداقل یک آیتم اعمال شده بود، فقط وجودش را
      // چک می‌کنیم — کد تخفیف یک‌بارمصرف نیست و هر نماینده/فروشنده می‌تواند
      // بارها آن را برای خریداران مختلف به کار ببرد. این‌جا صرفاً آمار
      // فروشِ آن کد (به تعداد آیتم‌های discountApplied، نه کل سفارش) بالا
      // می‌رود.
      if (codeRef) {
        const codeSnap = await tx.get(codeRef);
        if (!codeSnap.exists) throw new Error("not-found");

        tx.update(codeRef, {
          salesCount: admin.firestore.FieldValue.increment(discountedCount),
          purchases: admin.firestore.FieldValue.arrayUnion({
            name,
            email,
            orderId: orderRef.id,
            itemsCount: discountedCount,
            usedAt: new Date(),
          }),
        });
      }

      // کد سیستمیِ «فروش مستقیم/بدون نماینده» — اگر سندش هنوز وجود نداشته
      // باشه همین‌جا با ۰٪ تخفیف ساخته می‌شه (پس هیچ اثری روی قیمت نداره)،
      // فقط برای اینه که همون تب «کدهای تخفیف» پنل ادمین بتونه آمار فروش
      // مستقیم رو هم کنار آمار نماینده‌ها نشون بده.
      if (directRef) {
        const directSnap = await tx.get(directRef);
        const purchaseEntry = {
          name,
          email,
          orderId: orderRef.id,
          itemsCount: directCount,
          usedAt: new Date(),
        };
        if (!directSnap.exists) {
          tx.set(directRef, {
            percent: 0,
            amount: 0,
            repName: "فروش مستقیم (بدون کد تخفیف)",
            isSystemCode: true,
            salesCount: directCount,
            purchases: [purchaseEntry],
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        } else {
          tx.update(directRef, {
            salesCount: admin.firestore.FieldValue.increment(directCount),
            purchases: admin.firestore.FieldValue.arrayUnion(purchaseEntry),
          });
        }
      }

      licenseItems.forEach(({ info, discountApplied }, idx) => {
        tx.set(licenseRefs[idx], {
          tier: info.tier,
          license_type: info.license_type,
          appGeneration: info.appGeneration || CURRENT_APP_GENERATION,
          is_shared: false,
          is_used: false,
          // ── فیلدهای اضافه، فقط برای پیگیری شما در Firestore. /activate و
          //    /signin هیچ‌کدوم بهشون کاری ندارن، پس چیزی رو خراب نمی‌کنن ──
          name,
          email,
          discountCode: discountApplied ? code : NO_DISCOUNT_CODE,
          source: discountApplied ? "website-discount" : "website-direct",
          delivered: false, // شما بعد از فرستادن کد به مشتری این را true می‌کنید (پنل ادمین)
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      });

      tx.set(orderRef, {
        name,
        email,
        discountCode: discountedCount > 0 ? code : null,
        items,
        licenseCodes: licenseRefs.map((r) => r.id),
        status: "awaiting_payment",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return licenseRefs.length;
    });

    return res.status(200).json({ success: true, reserved: reservedCount });
  } catch (err) {
    if (err.message === "used") {
      return res.status(409).json({ success: false, error: "used" });
    }
    if (err.message === "not-found") {
      return res.status(404).json({ success: false, error: "not-found" });
    }
    console.error("خطا در create-order:", err);
    return res.status(500).json({ success: false, error: "server-error" });
  }
});



// ════════════════════════════════════════════════════════════════════════
//  وبهوک Lemon Squeezy → ساخت خودکار لایسنس + ایمیل به خریدار
// ════════════════════════════════════════════════════════════════════════
// Lemon Squeezy بعد از هر سفارشِ موفق (پرداخت کامل) یک POST به این آدرس
// می‌فرسته. جریان کار:
//   ۱) امضای HMAC رو با signing secret چک می‌کنیم تا مطمئن بشیم درخواست
//      واقعاً از Lemon Squeezy اومده (نه یک نفر که مستقیم این آدرس رو
//      صدا زده تا لایسنس مجانی بگیره).
//   ۲) فقط رویداد order_created با status=paid رو پردازش می‌کنیم.
//   ۳) variant_id سفارش رو از LS_VARIANT_LICENSE_MAP (نگاشتِ امنِ سمت
//      سرور، نه چیزی که از payload خونده بشه) به tier/duration تبدیل می‌کنیم.
//   ۴) با یک تراکنش، هم سند لایسنس جدید (is_used:false) می‌سازیم هم سند
//      lsOrders/{orderId} رو برای idempotency (چون Lemon Squeezy ممکنه
//      همون وبهوک رو بیشتر از یک‌بار retry کنه).
//   ۵) کد لایسنس رو با ایمیل به خریدار می‌فرستیم.
// توجه: این مسیر باید همیشه (حتی وقتی خطای داخلی داریم و لاگ می‌کنیم) با
// status نزدیک به 200 جواب بده وگرنه Lemon Squeezy مدام retry می‌کنه؛
// فقط برای امضای نامعتبر 401 برمی‌گردونیم چون اونجا واقعاً می‌خوایم رد کنیم.
app.post(
  "/webhooks/lemonsqueezy",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const signature = req.headers["x-signature"];
      if (!signature) {
        return res.status(401).json({ error: "missing signature" });
      }

      const hmac = crypto.createHmac("sha256", process.env.LEMON_WEBHOOK_SECRET);
      const digest = Buffer.from(hmac.update(req.body).digest("hex"), "utf8");
      const received = Buffer.from(signature, "utf8");

      if (
        digest.length !== received.length ||
        !crypto.timingSafeEqual(digest, received)
      ) {
        return res.status(401).json({ error: "invalid signature" });
      }

      const payload = JSON.parse(req.body.toString("utf8"));
      const eventName = payload?.meta?.event_name;

      // فقط سفارش‌های ساخته‌شده رو پردازش می‌کنیم؛ بقیه‌ی رویدادها (اگه بعداً
      // subscription_* رو هم فعال کردی) رو فعلاً بی‌خیال می‌شیم
      if (eventName !== "order_created") {
        return res.status(200).json({ ok: true, ignored: eventName });
      }

      const attrs = payload?.data?.attributes;
      const orderId = payload?.data?.id ? String(payload.data.id) : null;

      if (!attrs || !orderId) {
        console.error("وبهوک Lemon Squeezy با ساختار نامعتبر:", payload);
        return res.status(200).json({ ok: true });
      }

      // ── نکته: چک جداگانه‌ای برای رد کردن سفارش‌های test_mode لازم نیست.
      // Lemon Squeezy برای Test mode و Live mode، دو وبهوک کاملاً جدا با
      // secret متفاوت داره؛ همین وبهوک هیچ‌وقت داده‌ی Live دریافت نمی‌کنه
      // (و برعکس)، پس فیلتر کردن اینجا فقط باعث می‌شه سفارش‌های تستی هم
      // که عمداً داریم باهاشون سیستم رو تست می‌کنیم، نادیده گرفته بشن.

      if (attrs.status !== "paid") {
        return res.status(200).json({ ok: true, ignored: attrs.status });
      }

      const email = attrs.user_email;
      const name = attrs.user_name || "";
      const variantId = attrs.first_order_item?.variant_id;
      const info = LS_VARIANT_LICENSE_MAP[variantId];

      if (!email || !info) {
        console.error(
          `وبهوک Lemon Squeezy: variant ناشناخته یا ایمیل خالی (variantId=${variantId}, order=${orderId})`,
        );
        return res.status(200).json({ ok: true });
      }

      const licenseCode = generateLicenseCode();
      const orderRef = db.collection("lsOrders").doc(orderId);

      const created = await db.runTransaction(async (tx) => {
        const existing = await tx.get(orderRef);
        if (existing.exists) {
          // این orderId قبلاً پردازش شده (وبهوک تکراری) — چیزی نساز
          return { alreadyProcessed: true, licenseCode: existing.data().licenseCode };
        }

        tx.set(db.collection("licenses").doc(licenseCode), {
          tier: info.tier,
          license_type: info.license_type,
          appGeneration: info.appGeneration || CURRENT_APP_GENERATION,
          is_shared: false,
          is_used: false,
          name,
          email,
          source: "lemonsqueezy",
          ls_order_id: orderId,
          delivered: false,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        tx.set(orderRef, {
          email,
          name,
          licenseCode,
          tier: info.tier,
          licenseType: info.license_type,
          processedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        return { alreadyProcessed: false, licenseCode };
      });

      // اگه وبهوک تکراری بود، دیگه دوباره ایمیل نفرست
      if (!created.alreadyProcessed) {
        const now = new Date().toLocaleString("fa-IR", {
          timeZone: "Europe/Istanbul",
        });
        try {
          await sendLicenseEmail(email, name, created.licenseCode);
          await db.collection("licenses").doc(created.licenseCode).update({
            delivered: true,
          });
          notifyWhatsapp(
            `💰 لایسنس خریداری‌شده صادر شد\n` +
              `منبع خرید: Lemon Squeezy\n` +
              `نام: ${name}\n` +
              `ایمیل: ${email}\n` +
              `تیر: ${info.tier}\n` +
              `کد لایسنس: ${created.licenseCode}\n` +
              `تاریخ/ساعت: ${now}`,
          );
        } catch (mailErr) {
          // اگه ایمیل fail بشه، لایسنس همچنان توی Firestore ساخته شده و
          // delivered:false می‌مونه — می‌تونی بعداً از پنل ادمین دستی بفرستیش
          console.error("خطا در ارسال ایمیل لایسنس:", mailErr);
          notifyWhatsapp(
            `⚠️ لایسنس خریداری‌شده صادر شد ولی ایمیل ارسال نشد\n` +
              `منبع خرید: Lemon Squeezy\n` +
              `نام: ${name}\n` +
              `ایمیل: ${email}\n` +
              `کد لایسنس: ${created.licenseCode}\n` +
              `تاریخ/ساعت: ${now}\n` +
              `خطا: ${mailErr.message || mailErr}`,
          );
        }
      }

      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error("خطا در وبهوک Lemon Squeezy:", err);
      // 200 برمی‌گردونیم تا Lemon Squeezy بی‌نهایت retry نکنه؛ خطا لاگ شده
      // و از پنل ادمین/لاگ‌ها قابل پیگیریه
      return res.status(200).json({ ok: false });
    }
  },
);

// ════════════════════════════════════════════════════════════════════════
//  وبهوک Payoneer Checkout → ساخت خودکار لایسنس + ایمیل به خریدار
// ════════════════════════════════════════════════════════════════════════
// جایگزین همون منطقِ وبهوک Lemon Squeezy بالا، برای Payoneer Checkout.
// جریان کار:
//   ۱) احراز هویت درخواست (فعلاً Basic Auth — به کامنت verifyPayoneerNotification
//      نگاه کن، این بخش باید با یک تست واقعی تایید شه).
//   ۲) فقط رویدادِ «پرداخت موفق» رو پردازش می‌کنیم.
//   ۳) مرجع سفارش (reference) رو از PAYONEER_REFERENCE_LICENSE_MAP (نگاشتِ
//      امنِ سمت سرور، نه چیزی که از payload خونده بشه) به tier/duration
//      تبدیل می‌کنیم.
//   ۴) با یک تراکنش، هم سند لایسنس جدید (is_used:false) می‌سازیم هم سند
//      payoneerOrders/{orderId} رو برای idempotency (چون خیلی از این
//      درگاه‌ها ممکنه همون وبهوک رو بیشتر از یک‌بار retry کنن).
//   ۵) کد لایسنس رو با ایمیل به خریدار می‌فرستیم (از همون sendLicenseEmail
//      قبلی، که مستقل از درگاه پرداخته).
// توجه: این مسیر باید همیشه (حتی وقتی خطای داخلی داریم و لاگ می‌کنیم) با
// status نزدیک به 200 جواب بده وگرنه Payoneer مدام retry می‌کنه؛ فقط برای
// احراز هویت نامعتبر 401 برمی‌گردونیم چون اونجا واقعاً می‌خوایم رد کنیم.
//
// ⚠️ TODO_VERIFY (مهم): فیلدهای زیر (orderId/status/reference/email/name)
// بر اساس ساختار عمومیِ رایج در این خانواده از APIها (Optile/Payoneer
// Checkout) تخمین زده شده‌ن، نه از مستندات رسمی که من نتونستم بازش کنم.
// حتماً قبل از رفتن به Production، یک پرداخت تستی (Sandbox) بزنید، payload
// واقعی وبهوک رو لاگ کنید (یک console.log(JSON.stringify(payload)) موقت
// همین زیر کافیه)، و اسم فیلدهای واقعی رو با آنچه در extractPayoneerFields
// پایین‌تر خوانده می‌شه مقایسه/اصلاح کنید.
function extractPayoneerFields(payload) {
  // چند حالتِ محتمل رو امتحان می‌کنیم (fail-safe)، دقیقاً مثل الگوی
  // fetchUsd... بالاتر که چند فیلد جایگزین رو با ?? امتحان می‌کنه.
  const txn = payload?.transaction || payload;

  const orderId =
    txn?.transactionId || txn?.longId || payload?.longId || payload?.id;

  const status =
    txn?.payment?.status ||
    txn?.status ||
    payload?.status ||
    payload?.transactionStatus;

  const reference =
    txn?.merchantTransactionId ||
    txn?.reference ||
    payload?.reference ||
    payload?.merchantReference;

  const email =
    txn?.customer?.email ||
    payload?.customer?.email ||
    payload?.email;

  const name =
    [txn?.customer?.firstName, txn?.customer?.lastName]
      .filter(Boolean)
      .join(" ") ||
    payload?.customer?.name ||
    "";

  return { orderId, status, reference, email, name };
}

app.post(
  "/webhooks/payoneer",
  async (req, res) => {
    try {
      if (!verifyPayoneerNotification(req)) {
        return res.status(401).json({ error: "invalid authentication" });
      }

      const payload = req.body;

      // برای پیدا کردن اسم واقعی فیلدها در اولین تست Sandbox، این خط رو
      // موقتاً از کامنت خارج کن:
      // console.log("Payoneer webhook payload:", JSON.stringify(payload));

      const { orderId, status, reference, email, name } =
        extractPayoneerFields(payload);

      // فقط رویداد پرداخت موفق رو پردازش می‌کنیم؛ بقیه (pending/failed/...)
      // رو نادیده می‌گیریم.
      const successStatuses = ["SUCCESS", "CAPTURED", "CHARGED", "PAID"];
      if (!status || !successStatuses.includes(String(status).toUpperCase())) {
        return res.status(200).json({ ok: true, ignored: status || "unknown" });
      }

      if (!orderId || !email) {
        console.error(
          `وبهوک Payoneer با ساختار نامعتبر (orderId=${orderId}, email=${email}):`,
          payload,
        );
        return res.status(200).json({ ok: true });
      }

      const info = PAYONEER_REFERENCE_LICENSE_MAP[reference];
      if (!info) {
        console.error(
          `وبهوک Payoneer: reference ناشناخته (reference=${reference}, order=${orderId})`,
        );
        return res.status(200).json({ ok: true });
      }

      const licenseCode = generateLicenseCode();
      const orderRef = db.collection("payoneerOrders").doc(String(orderId));

      const created = await db.runTransaction(async (tx) => {
        const existing = await tx.get(orderRef);
        if (existing.exists) {
          // این orderId قبلاً پردازش شده (وبهوک تکراری) — چیزی نساز
          return { alreadyProcessed: true, licenseCode: existing.data().licenseCode };
        }

        tx.set(db.collection("licenses").doc(licenseCode), {
          tier: info.tier,
          license_type: info.license_type,
          appGeneration: info.appGeneration || CURRENT_APP_GENERATION,
          is_shared: false,
          is_used: false,
          name,
          email,
          source: "payoneer",
          payoneer_order_id: String(orderId),
          delivered: false,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        tx.set(orderRef, {
          email,
          name,
          licenseCode,
          tier: info.tier,
          licenseType: info.license_type,
          processedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        return { alreadyProcessed: false, licenseCode };
      });

      // اگه وبهوک تکراری بود، دیگه دوباره ایمیل نفرست
      if (!created.alreadyProcessed) {
        const now = new Date().toLocaleString("fa-IR", {
          timeZone: "Europe/Istanbul",
        });
        try {
          await sendLicenseEmail(email, name, created.licenseCode);
          await db.collection("licenses").doc(created.licenseCode).update({
            delivered: true,
          });
          notifyWhatsapp(
            `💰 لایسنس خریداری‌شده صادر شد\n` +
              `منبع خرید: Payoneer\n` +
              `نام: ${name}\n` +
              `ایمیل: ${email}\n` +
              `تیر: ${info.tier}\n` +
              `کد لایسنس: ${created.licenseCode}\n` +
              `تاریخ/ساعت: ${now}`,
          );
        } catch (mailErr) {
          // اگه ایمیل fail بشه، لایسنس همچنان توی Firestore ساخته شده و
          // delivered:false می‌مونه — می‌تونی بعداً از پنل ادمین دستی بفرستیش
          console.error("خطا در ارسال ایمیل لایسنس:", mailErr);
          notifyWhatsapp(
            `⚠️ لایسنس خریداری‌شده صادر شد ولی ایمیل ارسال نشد\n` +
              `منبع خرید: Payoneer\n` +
              `نام: ${name}\n` +
              `ایمیل: ${email}\n` +
              `کد لایسنس: ${created.licenseCode}\n` +
              `تاریخ/ساعت: ${now}\n` +
              `خطا: ${mailErr.message || mailErr}`,
          );
        }
      }

      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error("خطا در وبهوک Payoneer:", err);
      // 200 برمی‌گردونیم تا Payoneer بی‌نهایت retry نکنه؛ خطا لاگ شده و از
      // پنل ادمین/لاگ‌ها قابل پیگیریه
      return res.status(200).json({ ok: false });
    }
  },
);

// ── مسیر فعال‌سازی (ساین‌آپ - وقتی کاربر کد لایسنس رو دستی وارد می‌کنه) ──
app.post("/activate", async (req, res) => {
  try {
    const {
      licenseCode: rawLicenseCode,
      fingerprint,
      appId,
      hardwareSignature,
      // appGeneration اختیاریه — نسخه‌های قدیمی‌تر اپ که هنوز این فیلد رو
      // نمی‌فرستن هم مشکلی پیش نمیاد، fallback به CURRENT_APP_GENERATION.
      appGeneration,
    } = req.body;

    if (!rawLicenseCode || !fingerprint || !appId) {
      return res
        .status(400)
        .json({ error: "License code, fingerprint and appId are required" });
    }

    if (!isValidAppId(appId)) {
      return res.status(400).json({ error: "Unknown appId" });
    }

    // ── نرمال‌سازی کد لایسنس به حروف بزرگ ──────────────────────────
    const licenseCode = rawLicenseCode.trim().toUpperCase();

    const licenseRef = db.collection("licenses").doc(licenseCode);
    const licenseDoc = await licenseRef.get();

    if (!licenseDoc.exists) {
      return res.status(404).json({ error: "Invalid license code" });
    }

    const data = licenseDoc.data();
    const licenseType = data.license_type ?? "lifetime";
    const tier = resolveTier(data);
    const isShared = data.is_shared === true;

    if (!LICENSE_DURATIONS.hasOwnProperty(licenseType)) {
      return res.status(400).json({ error: "Invalid license type" });
    }

    const durationMs = LICENSE_DURATIONS[licenseType];
    const safeId = deviceAppId(fingerprint, appId);

    // ════════════════════════════════════════════════════════════════
    // حالت ۱: لایسنس مشترک (is_shared = true) — مثل کد رایگان ۵ روزه
    // ════════════════════════════════════════════════════════════════
    if (isShared) {
      // subcollection users حالا بر اساس «دستگاه + اپ» ایندکس میشه، نه فقط دستگاه
      const userRef = licenseRef.collection("users").doc(safeId);
      const userDoc = await userRef.get();

      if (userDoc.exists) {
        const userData = userDoc.data();
        const expiresAt = userData.expires_at
          ? userData.expires_at.toMillis()
          : null;

        if (expiresAt === null || Date.now() <= expiresAt) {
          const token = createSignedToken(
            fingerprint,
            appId,
            licenseCode,
            licenseType,
            expiresAt,
            tier,
          );
          await linkDevice(fingerprint, appId, licenseType, licenseCode, appGeneration);
          return res.status(200).json({
            success: true,
            token,
            licenseType,
            tier,
            licenseCode,
            expiresAt,
          });
        }

        return res.status(403).json({
          error:
            "You have already used your free trial. Please purchase a license to continue.",
        });
      }

      // اولین بار این ترکیب «دستگاه + اپ» میاد سراغ trial → ثبت کن
      const now = Date.now();
      const expiresAt = durationMs !== null ? now + durationMs : null;
      const expiresAtFirestore =
        expiresAt !== null
          ? admin.firestore.Timestamp.fromMillis(expiresAt)
          : null;

      await userRef.set({
        fingerprint,
        appId,
        hardwareSignature: hardwareSignature || null,
        activated_at: admin.firestore.FieldValue.serverTimestamp(),
        expires_at: expiresAtFirestore,
      });

      await licenseRef.update({
        total_activations: admin.firestore.FieldValue.increment(1),
      });

      const token = createSignedToken(
        fingerprint,
        appId,
        licenseCode,
        licenseType,
        expiresAt,
        tier,
      );
      await linkDevice(fingerprint, appId, licenseType, licenseCode, appGeneration);
      return res
        .status(200)
        .json({ success: true, token, licenseType, tier, licenseCode, expiresAt });
    }

    // ════════════════════════════════════════════════════════════════
    // حالت ۲: لایسنس اختصاصی (is_shared = false)
    // ════════════════════════════════════════════════════════════════
    // نکته‌ی مهم: چک «آیا قبلاً استفاده شده» و ثبتِ «is_used:true» باید
    // در یک تراکنش اتمیک (runTransaction) انجام بشه. قبلاً این دو کار
    // جدا از هم بودن (یک get ساده، بعد یک update جدا) و همین باعث
    // می‌شد اگه یک کد لایسنس تقریباً هم‌زمان از دو گوشی فعال بشه، هر دو
    // درخواست licenseDoc را با is_used=false ببینن (چون فاصله‌ی
    // میلی‌ثانیه‌ای بین خواندن اولی و نوشتنِ آن کافی بود) و هر دو یک
    // توکن معتبر بگیرند — دقیقاً همون اتفاقی که برات افتاد.
    // runTransaction این مشکل رو حل می‌کند: اگر دو درخواست هم‌زمان به
    // همین سند بنویسند، Firestore یکی را با موفقیت انجام می‌دهد و
    // دیگری را با داده‌ی تازه (is_used=true) دوباره اجرا می‌کند، پس
    // فقط یکی برنده می‌شود.
    // probation فقط یک‌بار در سطح دستگاه مجازه — سند ایندکس دستگاه رو
    // از قبل می‌گیریم تا داخل تراکنش هم بخونیمش هم (در صورت لزوم) بنویسیمش.
    const deviceRef = db.collection("devices").doc(safeId);

    let txResult;
    try {
      txResult = await db.runTransaction(async (tx) => {
        const freshDoc = await tx.get(licenseRef);
        if (!freshDoc.exists) {
          throw Object.assign(new Error("not-found"), { isActivateErr: true });
        }
        const freshData = freshDoc.data();

        if (freshData.is_used) {
          // حالا هم fingerprint هم appId باید مچ باشن
          if (freshData.fingerprint === fingerprint && freshData.appId === appId) {
            const expiresAt = freshData.expires_at
              ? freshData.expires_at.toMillis()
              : null;
            if (expiresAt !== null && Date.now() > expiresAt) {
              throw Object.assign(new Error("expired"), { isActivateErr: true });
            }
            return { expiresAt };
          }
          throw Object.assign(new Error("already-activated"), {
            isActivateErr: true,
          });
        }

        // ── سقف probation: این دستگاه قبلاً یک کد probation دیگه (هرچی
        // بوده، پرداخت‌شده یا نشده) گرفته؟ اگه آره، رد کن — وگرنه می‌شه با
        // گرفتن پی‌درپی کدهای probation جدید، یک تریال نامحدود ساخت.
        if (licenseType === "probation") {
          const deviceDoc = await tx.get(deviceRef);
          if (deviceDoc.exists && deviceDoc.data().hadProbationLicense) {
            throw Object.assign(new Error("probation-used"), {
              isActivateErr: true,
            });
          }
        }

        // اولین فعال‌سازی لایسنس اختصاصی
        const now = Date.now();
        const expiresAt = durationMs !== null ? now + durationMs : null;
        const expiresAtFirestore =
          expiresAt !== null
            ? admin.firestore.Timestamp.fromMillis(expiresAt)
            : null;

        tx.update(licenseRef, {
          is_used: true,
          fingerprint,
          appId,
          license_type: licenseType,
          activated_at: admin.firestore.FieldValue.serverTimestamp(),
          expires_at: expiresAtFirestore,
        });

        // این دستگاه از سهمیه‌ی probation‌اش استفاده کرد — این فلگ برای
        // همیشه true می‌مونه (حتی بعد از پرداخت/تمدید دستی expires_at)،
        // چون مربوط به «آیا این دستگاه probation گرفته» است، نه به
        // وضعیت فعلی این کد خاص.
        if (licenseType === "probation") {
          tx.set(deviceRef, { hadProbationLicense: true }, { merge: true });
        }

        return { expiresAt };
      });
    } catch (err) {
      if (err.isActivateErr) {
        if (err.message === "not-found") {
          return res.status(404).json({ error: "Invalid license code" });
        }
        if (err.message === "expired") {
          return res.status(403).json({ error: "Your license has expired" });
        }
        if (err.message === "probation-used") {
          return res.status(403).json({
            error: "This device has already used its one-time trial license.",
          });
        }
        return res.status(403).json({
          error: "This license code is already activated on another device",
        });
      }
      throw err;
    }

    const token = createSignedToken(
      fingerprint,
      appId,
      licenseCode,
      licenseType,
      txResult.expiresAt,
      tier,
    );
    await linkDevice(fingerprint, appId, licenseType, licenseCode, appGeneration);
    return res.status(200).json({
      success: true,
      token,
      licenseType,
      tier,
      licenseCode,
      expiresAt: txResult.expiresAt,
    });
  } catch (err) {
    console.error("خطا در فعال‌سازی:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ── مسیر ساین‌این (هر بار اجرای اپ — fingerprint + appId می‌فرسته) ───────
// ترتیب چک: lifetime → 5days (تریال)
app.post("/signin", async (req, res) => {
  try {
    const {
      fingerprint,
      appId,
      // اختیاریه (نسخه‌های قدیمی‌تر اپ ممکنه هنوز نفرستنش) — اگه اومد،
      // پایین‌تر روی سند دستگاه به‌روزش می‌کنیم تا همیشه نشون بده کلاینتِ
      // کدوم نسل، آخرین‌بار با این fingerprint ساین‌این کرده.
      appGeneration,
      // ورژن/آپدیت (عدد) همین نصبی که داره ساین‌این می‌کنه — برای اعلام
      // سراسری ورژن/آپدیت جدید استفاده می‌شه (نسخه‌های خیلی قدیمی اپ که
      // این فیلدها رو نمی‌فرستن هم مشکلی پیش نمیاد: 0 در نظر گرفته می‌شن).
      currentVersion,
      currentUpdate,
    } = req.body;

    if (!fingerprint || !appId) {
      return res
        .status(400)
        .json({ status: "error", error: "Fingerprint and appId are required" });
    }

    if (!isValidAppId(appId)) {
      return res.status(400).json({ status: "error", error: "Unknown appId" });
    }

    // ── اعلام ورژن/آپدیت: مستقل از وضعیت لایسنس، همراه هر پاسخ برمی‌گرده ──
    const versionDoc = await getVersionDoc(appId);
    const versionInfo = buildVersionInfo(versionDoc, currentVersion, currentUpdate);

    const safeId = deviceAppId(fingerprint, appId);
    const deviceRef = db.collection("devices").doc(safeId);
    const deviceDoc = await deviceRef.get();

    if (!deviceDoc.exists) {
      return res.status(200).json({ status: "signup_required", versionInfo });
    }

    // نسل اپ فعلی رو روی سند دستگاه به‌روز نگه می‌داریم (بی‌ضرر، فقط برای
    // زیرساخت فیچرهای بعدی — الان هیچ تصمیمی روش گرفته نمی‌شه)
    if (appGeneration) {
      deviceRef.set({ appGeneration }, { merge: true }).catch(() => {});
    }

    const links = deviceDoc.data().links || {};

    for (const durationType of DURATION_ORDER) {
      const licenseCode = links[durationType];
      if (!licenseCode) continue;

      const licenseDoc = await db.collection("licenses").doc(licenseCode).get();
      if (!licenseDoc.exists) continue;

      const data = licenseDoc.data();
      const tier = resolveTier(data);
      let expiresAt = null;

      if (data.is_shared) {
        const userDoc = await licenseDoc.ref
          .collection("users")
          .doc(safeId)
          .get();
        if (!userDoc.exists) continue;
        expiresAt = userDoc.data().expires_at
          ? userDoc.data().expires_at.toMillis()
          : null;
      } else {
        // هم fingerprint هم appId باید مطابقت داشته باشن
        if (
          !data.is_used ||
          data.fingerprint !== fingerprint ||
          data.appId !== appId
        )
          continue;
        expiresAt = data.expires_at ? data.expires_at.toMillis() : null;
      }

      if (
        durationType !== "lifetime" &&
        expiresAt !== null &&
        Date.now() > expiresAt
      ) {
        return res.status(200).json({
          status: "purchase_required",
          licenseType: durationType,
          tier,
          licenseCode,
          versionInfo,
        });
      }

      const token = createSignedToken(
        fingerprint,
        appId,
        licenseCode,
        durationType,
        expiresAt,
        tier,
      );
      return res.status(200).json({
        status: "valid",
        token,
        licenseType: durationType,
        tier,
        licenseCode,
        expiresAt,
        versionInfo,
      });
    }

    return res.status(200).json({ status: "signup_required", versionInfo });
  } catch (err) {
    console.error("خطا در signin:", err);
    return res.status(500).json({ status: "error", error: "Server error" });
  }
});

// ── مسیر خروج از لایسنس (Log out — آزادسازی برای فعال‌سازی روی دستگاه دیگه) ──
// اپ در این درخواست licenseCode (از توکن محلی)، fingerprint و appId
// همین دستگاه رو می‌فرسته. دو حالت داریم:
//   ۱) لایسنس اختصاصی (is_shared=false): با runTransaction دقیقاً مثل
//      /activate چک می‌کنیم fingerprint+appId فرستاده‌شده واقعاً همون
//      چیزیه که روی سند لایسنس ثبته، بعد is_used رو false می‌کنیم و
//      fingerprint/appId/activated_at/expires_at رو پاک می‌کنیم تا
//      لایسنس دوباره «دست‌نخورده» برای فعال‌سازی بعدی باشه.
//   ۲) لایسنس مشترک/تریال (is_shared=true): به‌جای is_used، رکورد
//      استفاده‌ی این «دستگاه+اپ» توی licenses/{code}/users/{safeId} حذف
//      می‌شه (منطقاً بی‌فایده‌ست چون تریال محدود به یک دستگاهه، ولی برای
//      یکدست بودن رفتار endpoint پیاده شده).
// در هر دو حالت، در انتها ایندکس devices/{fingerprint__appId} هم آپدیت
// می‌شه تا کلید همین licenseType از links پاک بشه (نه کل سند دستگاه،
// چون ممکنه هم‌زمان لینک دیگه‌ای مثل تریال هم داشته باشه).
app.post("/logout", async (req, res) => {
  try {
    const { licenseCode: rawLicenseCode, fingerprint, appId } = req.body;

    if (!rawLicenseCode || !fingerprint || !appId) {
      return res
        .status(400)
        .json({ error: "License code, fingerprint and appId are required" });
    }

    if (!isValidAppId(appId)) {
      return res.status(400).json({ error: "Unknown appId" });
    }

    const licenseCode = rawLicenseCode.trim().toUpperCase();
    const licenseRef = db.collection("licenses").doc(licenseCode);
    const licenseDoc = await licenseRef.get();

    if (!licenseDoc.exists) {
      return res.status(404).json({ error: "Invalid license code" });
    }

    const data = licenseDoc.data();
    const isShared = data.is_shared === true;
    const licenseType = data.license_type ?? "lifetime";
    const safeId = deviceAppId(fingerprint, appId);

    if (isShared) {
      // ════════════════════════════════════════════════════════════
      // حالت ۱: لایسنس مشترک/تریال
      // ════════════════════════════════════════════════════════════
      const userRef = licenseRef.collection("users").doc(safeId);
      const userDoc = await userRef.get();

      if (
        !userDoc.exists ||
        userDoc.data().fingerprint !== fingerprint ||
        userDoc.data().appId !== appId
      ) {
        return res
          .status(403)
          .json({ error: "This license is not linked to this device" });
      }

      await userRef.delete();
    } else {
      // ════════════════════════════════════════════════════════════
      // حالت ۲: لایسنس اختصاصی — دقیقاً هم‌ساختار با تراکنش /activate
      // ════════════════════════════════════════════════════════════
      try {
        await db.runTransaction(async (tx) => {
          const freshDoc = await tx.get(licenseRef);
          if (!freshDoc.exists) {
            throw Object.assign(new Error("not-found"), { isLogoutErr: true });
          }
          const freshData = freshDoc.data();

          if (
            !freshData.is_used ||
            freshData.fingerprint !== fingerprint ||
            freshData.appId !== appId
          ) {
            throw Object.assign(new Error("not-owner"), { isLogoutErr: true });
          }

          tx.update(licenseRef, {
            is_used: false,
            fingerprint: admin.firestore.FieldValue.delete(),
            appId: admin.firestore.FieldValue.delete(),
            activated_at: admin.firestore.FieldValue.delete(),
            expires_at: admin.firestore.FieldValue.delete(),
          });
        });
      } catch (err) {
        if (err.isLogoutErr) {
          if (err.message === "not-found") {
            return res.status(404).json({ error: "Invalid license code" });
          }
          return res
            .status(403)
            .json({ error: "This license is not linked to this device" });
        }
        throw err;
      }
    }

    // ── پاک کردن ایندکس devices/{fingerprint__appId} ──────────────────
    // فقط کلید همین licenseType از links حذف بشه؛ اگه سند دستگاه اصلاً
    // وجود نداشته باشه update() خطای NOT_FOUND می‌ده که بی‌ضرره و می‌گیریمش
    // (لایسنس روی سرور هر حال آزاد شده، این فقط پاکسازی ایندکسه).
    await db
      .collection("devices")
      .doc(safeId)
      .update({
        [`links.${licenseType}`]: admin.firestore.FieldValue.delete(),
      })
      .catch(() => {});

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("خطا در logout:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ── میدل‌ور احراز هویت ادمین (Firebase idToken) ─────────────────────────
// دقیقاً همون روشی که پایین‌تر /admin/discount/:code استفاده می‌کنه: کلاینتِ
// پنل ادمین idToken کاربریِ که توی پروژه لاگین کرده رو توی هدر Authorization
// (Bearer ...) می‌فرسته.
async function requireAdmin(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!idToken) {
      return res.status(401).json({ status: "error", error: "توکن ورود ارسال نشده" });
    }
    await admin.auth().verifyIdToken(idToken);
    next();
  } catch (err) {
    return res.status(401).json({ status: "error", error: "دسترسی نامعتبر یا خطای سرور" });
  }
}

// ── اعلام ورژن جدید (فقط ادمین) ─────────────────────────────────────────
// body: { appId, version, versionType: "free"|"paid", versionDownloadUrl,
//          versionPurchaseUrl, versionNotes }
// اعلام ورژن جدید همیشه شمارنده‌ی آپدیت (u) رو برای همین appId صفر می‌کنه.
app.post("/admin/announce-version", requireAdmin, async (req, res) => {
  try {
    const {
      appId,
      version,
      versionType,
      versionDownloadUrl,
      versionPurchaseUrl,
      versionNotes,
    } = req.body;

    if (!isValidAppId(appId)) {
      return res.status(400).json({ status: "error", error: "Unknown appId" });
    }
    if (!version || !Number.isFinite(Number(version)) || Number(version) <= 0) {
      return res.status(400).json({ status: "error", error: "Invalid version number" });
    }
    if (versionType !== "free" && versionType !== "paid") {
      return res
        .status(400)
        .json({ status: "error", error: "versionType must be 'free' or 'paid'" });
    }
    if (versionType === "free" && !versionDownloadUrl) {
      return res
        .status(400)
        .json({ status: "error", error: "versionDownloadUrl is required for a free version" });
    }
    if (versionType === "paid" && !versionPurchaseUrl) {
      return res
        .status(400)
        .json({ status: "error", error: "versionPurchaseUrl is required for a paid version" });
    }

    await db.collection("appVersions").doc(appId).set(
      {
        version: Number(version),
        versionType,
        versionDownloadUrl: versionDownloadUrl || null,
        versionPurchaseUrl: versionPurchaseUrl || null,
        versionNotes: versionNotes || "",
        // اعلام ورژن جدید یعنی آپدیت‌های ورژن قبلی دیگه بی‌معنی‌ان
        update: 0,
        updateType: "free",
        updateDownloadUrl: null,
        updatePurchaseUrl: null,
        updateNotes: "",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return res.status(200).json({ status: "ok" });
  } catch (err) {
    console.error("خطا در announce-version:", err);
    return res.status(500).json({ status: "error", error: "Server error" });
  }
});

// ── اعلام آپدیت جدید برای ورژن فعلی (فقط ادمین) ─────────────────────────
// body: { appId, update, updateType: "free"|"paid", updateDownloadUrl,
//          updatePurchaseUrl, updateNotes }
// باید قبلش حداقل یک بار /admin/announce-version برای همین appId زده شده باشه.
app.post("/admin/announce-update", requireAdmin, async (req, res) => {
  try {
    const {
      appId,
      update,
      updateType,
      updateDownloadUrl,
      updatePurchaseUrl,
      updateNotes,
    } = req.body;

    if (!isValidAppId(appId)) {
      return res.status(400).json({ status: "error", error: "Unknown appId" });
    }
    if (!update || !Number.isFinite(Number(update)) || Number(update) <= 0) {
      return res.status(400).json({ status: "error", error: "Invalid update number" });
    }
    if (updateType !== "free" && updateType !== "paid") {
      return res
        .status(400)
        .json({ status: "error", error: "updateType must be 'free' or 'paid'" });
    }
    if (updateType === "free" && !updateDownloadUrl) {
      return res
        .status(400)
        .json({ status: "error", error: "updateDownloadUrl is required for a free update" });
    }
    if (updateType === "paid" && !updatePurchaseUrl) {
      return res
        .status(400)
        .json({ status: "error", error: "updatePurchaseUrl is required for a paid update" });
    }

    const ref = db.collection("appVersions").doc(appId);
    const existing = await ref.get();
    if (!existing.exists) {
      return res.status(400).json({
        status: "error",
        error: "No version announced yet for this appId — call /admin/announce-version first.",
      });
    }

    await ref.set(
      {
        update: Number(update),
        updateType,
        updateDownloadUrl: updateDownloadUrl || null,
        updatePurchaseUrl: updatePurchaseUrl || null,
        updateNotes: updateNotes || "",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return res.status(200).json({ status: "ok" });
  } catch (err) {
    console.error("خطا در announce-update:", err);
    return res.status(500).json({ status: "error", error: "Server error" });
  }
});

// ── مشاهده‌ی وضعیت فعلی ورژن/آپدیت یک اپ (فقط ادمین) ─────────────────────
app.get("/admin/version-info/:appId", requireAdmin, async (req, res) => {
  try {
    const versionDoc = await getVersionDoc(req.params.appId);
    return res.status(200).json({ status: "ok", data: versionDoc || null });
  } catch (err) {
    console.error("خطا در version-info:", err);
    return res.status(500).json({ status: "error", error: "Server error" });
  }
});

// ── لغو کامل اعلام ورژن یک اپ (فقط ادمین) ─────────────────────────────────
// کل سند appVersions/{appId} پاک می‌شه — یعنی انگار هیچ‌وقت ورژن/آپدیتی
// برای این اپ اعلام نشده (چون آپدیت هم زیرمجموعه‌ی همون ورژنه، با پاک شدن
// ورژن، آپدیتش هم به‌صورت خودکار حذف می‌شه). برای وقتی که یک ورژن رو
// اشتباهی اعلام کردی و می‌خوای کامل برگردی عقب.
app.delete("/admin/version/:appId", requireAdmin, async (req, res) => {
  try {
    const { appId } = req.params;
    if (!isValidAppId(appId)) {
      return res.status(400).json({ status: "error", error: "Unknown appId" });
    }
    await db.collection("appVersions").doc(appId).delete();
    return res.status(200).json({ status: "ok" });
  } catch (err) {
    console.error("خطا در حذف ورژن:", err);
    return res.status(500).json({ status: "error", error: "Server error" });
  }
});

// ── لغو فقط اعلام آپدیت یک اپ (فقط ادمین) ─────────────────────────────────
// خود ورژن دست‌نخورده می‌مونه؛ فقط فیلدهای آپدیت به حالت «هیچ آپدیتی اعلام
// نشده» برمی‌گردن (update=0). برای وقتی که فقط پشیمون شدی از یک آپدیتِ
// روی ورژن فعلی، نه از خود ورژن.
app.delete("/admin/update/:appId", requireAdmin, async (req, res) => {
  try {
    const { appId } = req.params;
    if (!isValidAppId(appId)) {
      return res.status(400).json({ status: "error", error: "Unknown appId" });
    }
    const ref = db.collection("appVersions").doc(appId);
    const existing = await ref.get();
    if (!existing.exists) {
      // چیزی برای لغو کردن وجود نداره — این خودش خطا نیست
      return res.status(200).json({ status: "ok" });
    }
    await ref.set(
      {
        update: 0,
        updateType: "free",
        updateDownloadUrl: null,
        updatePurchaseUrl: null,
        updateNotes: "",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    return res.status(200).json({ status: "ok" });
  } catch (err) {
    console.error("خطا در حذف آپدیت:", err);
    return res.status(500).json({ status: "error", error: "Server error" });
  }
});

// ── حذف کد تخفیف (فقط ادمین) ───────────────────────────────────────────────
// Firestore Security Rules پروژه‌ی livefx-b43d5 اجازه‌ی delete مستقیم از
// کلاینت رو نمی‌دن (برای همینه که پنل ادمین موقع حذف کد تخفیف خطای «دسترسی
// کافی نداری» می‌ده)، در حالی که Admin SDK همیشه از این قوانین رد می‌شه.
// پس حذف رو از همینجا (سرور) با Admin SDK انجام می‌دیم. کلاینت (admin.html)
// باید idToken کاربریِ که توی پروژه‌ی LiveFX لاگین کرده رو توی هدر
// Authorization بفرسته تا مطمئن بشیم درخواست از طرف ادمین واقعیه.
app.delete("/admin/discount/:code", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || "";
    const idToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;

    if (!idToken) {
      return res
        .status(401)
        .json({ status: "error", error: "توکن ورود ارسال نشده" });
    }

    // اگه توکن معتبر نباشه (یا لاگین نکرده باشه) اینجا خطا می‌ده و وارد
    // catch میشیم
    await admin.auth().verifyIdToken(idToken);

    const { code } = req.params;
    if (!code) {
      return res.status(400).json({ status: "error", error: "کد تخفیف نامعتبر" });
    }

    await db.collection("discountCodes").doc(code).delete();
    return res.status(200).json({ status: "ok" });
  } catch (err) {
    console.error("خطا در حذف کد تخفیف:", err);
    return res
      .status(401)
      .json({ status: "error", error: "دسترسی نامعتبر یا خطای سرور" });
  }
});

// ── نرخ ارز فعلی (فقط برای دیباگ/مانیتورینگ — کلاینت مستقیماً از Firestore
// می‌خواند، پس نیازی به این مسیر برای نمایش روی سایت نیست) ─────────────────
app.get("/rates/latest", (req, res) => {
  res.json({
    usdToTry: latestRates.usdToTry,
    usdToTrySource: latestRates.usdToTrySource,
    usdToTryUpdatedAt: latestRates.usdToTryUpdatedAt,
    usdToIrr: latestRates.usdToIrr,
    usdToIrrSource: latestRates.usdToIrrSource,
    usdToIrrUpdatedAt: latestRates.usdToIrrUpdatedAt,
    tryToUsd: latestRates.usdToTry ? 1 / latestRates.usdToTry : null,
    tryToRial:
      latestRates.usdToTry && latestRates.usdToIrr
        ? latestRates.usdToIrr / latestRates.usdToTry
        : null,
  });
});

// ── مسیر موقت دیباگ (بدون نیاز به Shell) — برای دیدن اینکه از شبکه‌ی همین
// سرور Render واقعاً چه پاسخی از منبع‌های نرخ ریال می‌گیریم. فقط GET، بدون
// نیاز به توکن، چون هیچ داده‌ی حساسی برنمی‌گردونه و برای موقتی‌ست.
// بعد از رفع مشکل حتماً این بلوک حذف بشه.
// نمونه استفاده (مستقیم توی مرورگر باز کن):
//   https://<آدرس-سرور-شما>/debug/probe?source=brsapi
//   https://<آدرس-سرور-شما>/debug/probe?source=bonbast
//   https://<آدرس-سرور-شما>/debug/probe?source=yekrial
//   https://<آدرس-سرور-شما>/debug/probe?source=doviz
const DEBUG_PROBE_URLS = {
  brsapi:
    "https://Api.BrsApi.ir/Market/Gold_Currency_Pro.php?key=FreeSV0E1LSgB9RDjuf0QorSLViX8pPG&symbol=USD",
  bonbast: "https://bonbast.amirhn.com/latest",
  yekrial: "https://yekrial.com/toman-rate/USD",
  doviz: "https://www.doviz.com/api/v1/currencies/all/latest",
  alanchand: "https://alanchand.com/en/exchange-rates/usd-try",
};
app.get("/debug/probe", async (req, res) => {
  const key = (req.query.source || "").toString();
  const url = DEBUG_PROBE_URLS[key];
  if (!url) {
    return res.status(400).json({
      status: "error",
      error: `پارامتر source نامعتبر یا خالی؛ یکی از این‌ها رو بده: ${Object.keys(DEBUG_PROBE_URLS).join(", ")}`,
    });
  }
  const startedAt = Date.now();
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; BuskitRateBot/1.0)" },
    });
    const text = await r.text();
    return res.status(200).json({
      status: "ok",
      source: key,
      url,
      httpStatus: r.status,
      httpStatusText: r.statusText,
      ms: Date.now() - startedAt,
      bodyPreview: text.slice(0, 3000),
      bodyLength: text.length,
    });
  } catch (err) {
    return res.status(200).json({
      status: "error",
      source: key,
      url,
      ms: Date.now() - startedAt,
      error: err.message,
      errorCause: err.cause ? String(err.cause) : null,
    });
  }
});

// ── واداشتن سرور به گرفتن فوری نرخ‌ها (فقط ادمین) — برای تست ─────────────
app.post("/admin/refresh-rates", requireAdmin, async (req, res) => {
  const [usdTry, usdIrr] = await Promise.all([
    runRateJob("usdTry", USD_TRY_SOURCES, applyUsdTryResult, "نرخ دلار/لیر"),
    runRateJob("usdIrr", USD_IRR_SOURCES, applyUsdIrrResult, "نرخ دلار/ریال بازار آزاد"),
  ]);

  const allFailed = !usdTry.success && !usdIrr.success;
  res.status(allFailed ? 502 : 200).json({
    status: allFailed ? "error" : "ok",
    error: allFailed
      ? "هیچ‌کدام از منبع‌های نرخ در دسترس نبودند — جزئیات را در لاگ سرور ببین."
      : undefined,
    usdTry,
    usdIrr,
    rates: latestRates,
  });
});

// ── health check ──────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "LiveFX License Server is running" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`سرور لایسنس روی پورت ${PORT} در حال اجراست`);
});
