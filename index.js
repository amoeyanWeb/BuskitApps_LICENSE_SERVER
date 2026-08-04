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

// ── Express ───────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// ── مدت زمان انواع لایسنس (ms) ───────────────────────────────────────────
const LICENSE_DURATIONS = {
  lifetime: null,
  "1year": 365 * 24 * 60 * 60 * 1000,
  "1month": 30 * 24 * 60 * 60 * 1000,
  "5days": 5 * 24 * 60 * 60 * 1000,
};

// ترتیب اولویت چک در زمان ساین‌این: مادام‌العمر > سالانه > ماهانه > رایگان
// نکته: این «duration» هست (مدت زمان لایسنس)، نه «tier» (سطح gold/silver/bronze).
// اسمش رو عمداً از TIER_ORDER به DURATION_ORDER عوض کردیم تا با مفهوم جدید
// tier (که پایین‌تر اضافه شده) قاطی نشه.
const DURATION_ORDER = ["lifetime", "1year", "1month", "5days"];

// ── appId های مجاز ────────────────────────────────────────────────────────
// لیست application id های سه اپ. اگه appId ارسالی توی این لیست نباشه
// درخواست رد میشه (جلوی سوءاستفاده با appId جعلی رو هم می‌گیره).
const ALLOWED_APP_IDS = [
  "com.BuskitApp.LiveFX",
  "com.BuskitApp.LiveMT", // ← application id واقعی اپ دوم رو اینجا بذار
  "com.BuskitApp.LiveMT.pro", // ← application id واقعی اپ سوم رو اینجا بذار
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
// tier (gold/silver/bronze) هم اینجا داخل payload امضا میشه — این همون
// فیلدیه که اپ روش FeatureGate رو اجرا می‌کنه، پس باید حتماً امضا بشه تا
// قابل جعل نباشه.
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

// ── سطح لایسنس (gold/silver/bronze) رو با fail-safe از سند لایسنس بخون ──
// اگه به هر دلیلی (داده‌ی قدیمی، دستکاری، ...) فیلد tier روی سند نبود یا
// مقدار ناشناخته داشت، fail-closed میره روی پایین‌ترین سطح (bronze)، نه بالاترین.
const VALID_TIERS = ["gold", "silver", "bronze"];
function resolveTier(licenseData) {
  // ── نرمال‌سازی: حروف بزرگ/کوچیک و فاصله‌ی اضافه نباید باعث fail-closed
  // بی‌صدا به bronze بشه — این دقیقاً همون چیزی بود که باعث میشد لایسنس
  // Silver/Gold درست‌ثبت‌شده توی Firestore، توی اپ Bronze نشون داده بشه.
  const raw = licenseData.tier;
  const t = typeof raw === "string" ? raw.trim().toLowerCase() : raw;
  if (!VALID_TIERS.includes(t)) {
    console.warn(
      `resolveTier: unrecognized/missing tier value (raw="${raw}") on license, falling back to bronze`,
    );
    return "bronze";
  }
  return t;
}

// ── ثبت/به‌روزرسانی ایندکس devices/{fingerprint__appId} ──────────────────
// این ایندکس باعث میشه /signin بتونه با یک خوندن بفهمه این ترکیب
// «گوشی + اپ» توی کدوم سطح(ها)ی لایسنس عضویت داره.
async function linkDevice(fingerprint, appId, licenseType, licenseCode) {
  const docId = deviceAppId(fingerprint, appId);
  await db
    .collection("devices")
    .doc(docId)
    .set(
      {
        fingerprint,
        appId,
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
// نگاشت شناسه‌ی محصول (همون pid هایی که در فرم خرید سایت/PURCHASE_ITEMS
// استفاده می‌شن) به سطح و مدت لایسنس. عمداً این نگاشت اینجا، سمت سرور،
// نگه داشته می‌شود — نه این‌که از خودِ درخواستِ مرورگر خونده بشه — تا کسی
// نتونه با دستکاری بدنه‌ی درخواست HTTP یک لایسنس با سطح/مدت دلخواه (مثلاً
// gold/lifetime) بگیرد. فقط کلیدهای زیر پذیرفته می‌شوند؛ هر چیز دیگری
// (مثلاً محصولات سخت‌افزاری) نادیده گرفته می‌شود.
const PRODUCT_LICENSE_MAP = {
  p4: { tier: "bronze", license_type: "1month" },
  p3: { tier: "bronze", license_type: "1year" },
  p1: { tier: "bronze", license_type: "lifetime" },
  p10: { tier: "silver", license_type: "1month" },
  p9: { tier: "silver", license_type: "1year" },
  p8: { tier: "silver", license_type: "lifetime" },
  p7: { tier: "gold", license_type: "1month" },
  p6: { tier: "gold", license_type: "1year" },
  p2: { tier: "gold", license_type: "lifetime" },
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



// ── مسیر فعال‌سازی (ساین‌آپ - وقتی کاربر کد لایسنس رو دستی وارد می‌کنه) ──
app.post("/activate", async (req, res) => {
  try {
    const {
      licenseCode: rawLicenseCode,
      fingerprint,
      appId,
      hardwareSignature,
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
          await linkDevice(fingerprint, appId, licenseType, licenseCode);
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
      await linkDevice(fingerprint, appId, licenseType, licenseCode);
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
    await linkDevice(fingerprint, appId, licenseType, licenseCode);
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
// ترتیب چک: lifetime → 1year → 1month → 5days
app.post("/signin", async (req, res) => {
  try {
    const { fingerprint, appId } = req.body;

    if (!fingerprint || !appId) {
      return res
        .status(400)
        .json({ status: "error", error: "Fingerprint and appId are required" });
    }

    if (!isValidAppId(appId)) {
      return res.status(400).json({ status: "error", error: "Unknown appId" });
    }

    const safeId = deviceAppId(fingerprint, appId);
    const deviceDoc = await db.collection("devices").doc(safeId).get();

    if (!deviceDoc.exists) {
      return res.status(200).json({ status: "signup_required" });
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
      });
    }

    return res.status(200).json({ status: "signup_required" });
  } catch (err) {
    console.error("خطا در signin:", err);
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
