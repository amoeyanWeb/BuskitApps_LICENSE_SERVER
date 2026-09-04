const express = require("express");
const cors = require("cors");
require("dotenv").config();

const admin = require("firebase-admin");
const crypto = require("crypto");

// ── Firebase init ─────────────────────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

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
app.use(cors());

// ── body parser ──────────────────────────────────────────────────────────
// نکته‌ی مهم: مسیر وبهوک Lemon Squeezy باید body رو به‌صورت خام (raw buffer)
// دریافت کنه، چون امضای HMAC روی همون بایت‌های خامِ ارسالی محاسبه می‌شه، نه
// روی JSON.stringify شده‌ی دوباره. برای همین این مسیر رو از express.json()
// عمومی مستثنی می‌کنیم و خودش پایین‌تر express.raw() جداگانه می‌گیره.
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
const LICENSE_DURATIONS = {
  lifetime: null,
  "5days": 5 * 24 * 60 * 60 * 1000,
};

// ترتیب اولویت چک در زمان ساین‌این: مادام‌العمر > رایگان (تریال)
const DURATION_ORDER = ["lifetime", "5days"];

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

// ── ارسال ایمیل حاوی کد لایسنس به خریدار (بعد از تایید پرداخت Lemon Squeezy) ──
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
        try {
          await sendLicenseEmail(email, name, created.licenseCode);
          await db.collection("licenses").doc(created.licenseCode).update({
            delivered: true,
          });
        } catch (mailErr) {
          // اگه ایمیل fail بشه، لایسنس همچنان توی Firestore ساخته شده و
          // delivered:false می‌مونه — می‌تونی بعداً از پنل ادمین دستی بفرستیش
          console.error("خطا در ارسال ایمیل لایسنس:", mailErr);
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

// ── health check ──────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "LiveFX License Server is running" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`سرور لایسنس روی پورت ${PORT} در حال اجراست`);
});
