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
    if (data.is_used) {
      // حالا هم fingerprint هم appId باید مچ باشن
      if (data.fingerprint === fingerprint && data.appId === appId) {
        const expiresAt = data.expires_at ? data.expires_at.toMillis() : null;

        if (expiresAt !== null && Date.now() > expiresAt) {
          return res.status(403).json({ error: "Your license has expired" });
        }

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

      return res.status(403).json({
        error: "This license code is already activated on another device",
      });
    }

    // اولین فعال‌سازی لایسنس اختصاصی
    const now = Date.now();
    const expiresAt = durationMs !== null ? now + durationMs : null;
    const expiresAtFirestore =
      expiresAt !== null
        ? admin.firestore.Timestamp.fromMillis(expiresAt)
        : null;

    await licenseRef.update({
      is_used: true,
      fingerprint,
      appId,
      license_type: licenseType,
      activated_at: admin.firestore.FieldValue.serverTimestamp(),
      expires_at: expiresAtFirestore,
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

// ── health check ──────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "LiveFX License Server is running" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`سرور لایسنس روی پورت ${PORT} در حال اجراست`);
});
