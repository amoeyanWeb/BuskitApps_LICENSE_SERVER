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
const TIER_ORDER = ["lifetime", "1year", "1month", "5days"];

// ── fingerprint رو برای Firestore document ID ایمن کن ────────────────────
function toSafeId(fingerprint) {
  return fingerprint.replace(/\//g, "_").replace(/\+/g, "-").replace(/=/g, "");
}

// ── ساخت token امضاشده (RSA-SHA256) ──────────────────────────────────────
// این امضا تنها چیزیه که جلوی جعل/دستکاری توکن توسط کلاینت رو می‌گیره،
// چون کلید خصوصی فقط روی سرور وجود داره.
function createSignedToken(fingerprint, licenseCode, licenseType, expiresAt) {
  const payload = JSON.stringify({
    fingerprint,
    licenseCode,
    licenseType,
    expiresAt: expiresAt ?? null,
    issuedAt: Date.now(),
  });
  const sign = crypto.createSign("RSA-SHA256");
  sign.update(payload);
  const signature = sign.sign(privateKey, "base64");
  return Buffer.from(payload).toString("base64") + "|" + signature;
}

// ── ثبت/به‌روزرسانی ایندکس devices/{fingerprint} ─────────────────────────
// این ایندکس باعث میشه /signin بتونه با یک خوندن بفهمه این گوشی
// توی کدوم سطح(ها)ی لایسنس عضویت داره، بدون اسکن کل کالکشن licenses.
async function linkDevice(fingerprint, licenseType, licenseCode) {
  const safeId = toSafeId(fingerprint);
  await db
    .collection("devices")
    .doc(safeId)
    .set(
      {
        fingerprint,
        links: {
          [licenseType]: licenseCode,
        },
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
}

// ── مسیر فعال‌سازی (ساین‌آپ - وقتی کاربر کد لایسنس رو دستی وارد می‌کنه) ──
app.post("/activate", async (req, res) => {
  try {
    const {
      licenseCode: rawLicenseCode,
      fingerprint,
      hardwareSignature,
    } = req.body;

    if (!rawLicenseCode || !fingerprint) {
      return res
        .status(400)
        .json({ error: "License code and fingerprint are required" });
    }

    // ── نرمال‌سازی کد لایسنس به حروف بزرگ ──────────────────────────
    // کلاینت همیشه قبل از ارسال uppercase می‌کنه؛ این خط هم اینجا تضمین
    // می‌کنه که حتی اگه یک کد لایسنس با حروف mixed-case تو Firestore
    // ساخته شده باشه، lookup همچنان درست انجام بشه.
    const licenseCode = rawLicenseCode.trim().toUpperCase();

    const licenseRef = db.collection("licenses").doc(licenseCode);
    const licenseDoc = await licenseRef.get();

    if (!licenseDoc.exists) {
      return res.status(404).json({ error: "Invalid license code" });
    }

    const data = licenseDoc.data();
    const licenseType = data.license_type ?? "lifetime";
    const isShared = data.is_shared === true;

    if (!LICENSE_DURATIONS.hasOwnProperty(licenseType)) {
      return res.status(400).json({ error: "Invalid license type" });
    }

    const durationMs = LICENSE_DURATIONS[licenseType];
    const safeId = toSafeId(fingerprint);

    // ════════════════════════════════════════════════════════════════
    // حالت ۱: لایسنس مشترک (is_shared = true) — مثل کد رایگان ۵ روزه
    // ════════════════════════════════════════════════════════════════
    if (isShared) {
      const userRef = licenseRef.collection("users").doc(safeId);
      const userDoc = await userRef.get();

      if (userDoc.exists) {
        const userData = userDoc.data();
        const expiresAt = userData.expires_at
          ? userData.expires_at.toMillis()
          : null;

        // هنوز در بازه → نصب مجدد مجازه، یک توکن تازه با همون expiresAt قبلی صادر میشه
        if (expiresAt === null || Date.now() <= expiresAt) {
          const token = createSignedToken(
            fingerprint,
            licenseCode,
            licenseType,
            expiresAt,
          );
          await linkDevice(fingerprint, licenseType, licenseCode);
          return res
            .status(200)
            .json({
              success: true,
              token,
              licenseType,
              licenseCode,
              expiresAt,
            });
        }

        // بازه تموم شده → رد کن (آنینستال/نصب مجدد نباید ۵ روز تازه بده)
        return res.status(403).json({
          error:
            "You have already used your free trial. Please purchase a license to continue.",
        });
      }

      // اولین بار این fingerprint میاد سراغ trial → ثبت کن
      // hardwareSignature هم ذخیره میشه فقط برای بررسی دستی آینده
      // (مثلاً اگه یک روز الگوی مشکوک از تعداد ترایال‌های یک مدل خاص دیده شد)
      // — فعلاً هیچ بلاکی بر اساسش انجام نمیشه.
      const now = Date.now();
      const expiresAt = durationMs !== null ? now + durationMs : null;
      const expiresAtFirestore =
        expiresAt !== null
          ? admin.firestore.Timestamp.fromMillis(expiresAt)
          : null;

      await userRef.set({
        fingerprint,
        hardwareSignature: hardwareSignature || null,
        activated_at: admin.firestore.FieldValue.serverTimestamp(),
        expires_at: expiresAtFirestore,
      });

      await licenseRef.update({
        total_activations: admin.firestore.FieldValue.increment(1),
      });

      const token = createSignedToken(
        fingerprint,
        licenseCode,
        licenseType,
        expiresAt,
      );
      await linkDevice(fingerprint, licenseType, licenseCode);
      return res
        .status(200)
        .json({ success: true, token, licenseType, licenseCode, expiresAt });
    }

    // ════════════════════════════════════════════════════════════════
    // حالت ۲: لایسنس اختصاصی (is_shared = false)
    // ════════════════════════════════════════════════════════════════
    if (data.is_used) {
      if (data.fingerprint === fingerprint) {
        const expiresAt = data.expires_at ? data.expires_at.toMillis() : null;

        if (expiresAt !== null && Date.now() > expiresAt) {
          return res.status(403).json({ error: "Your license has expired" });
        }

        const token = createSignedToken(
          fingerprint,
          licenseCode,
          licenseType,
          expiresAt,
        );
        await linkDevice(fingerprint, licenseType, licenseCode);
        return res
          .status(200)
          .json({ success: true, token, licenseType, licenseCode, expiresAt });
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
      license_type: licenseType,
      activated_at: admin.firestore.FieldValue.serverTimestamp(),
      expires_at: expiresAtFirestore,
    });

    const token = createSignedToken(
      fingerprint,
      licenseCode,
      licenseType,
      expiresAt,
    );
    await linkDevice(fingerprint, licenseType, licenseCode);
    return res
      .status(200)
      .json({ success: true, token, licenseType, licenseCode, expiresAt });
  } catch (err) {
    console.error("خطا در فعال‌سازی:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ── مسیر ساین‌این (هر بار اجرای اپ — فقط fingerprint می‌فرسته) ───────────
// ترتیب چک: lifetime → 1year → 1month → 5days
// به محض پیدا شدن یک سطح (حتی اگه منقضی باشه)، به سطح‌های پایین‌تر نمیریم.
app.post("/signin", async (req, res) => {
  try {
    const { fingerprint } = req.body;

    if (!fingerprint) {
      return res
        .status(400)
        .json({ status: "error", error: "Fingerprint is required" });
    }

    const safeId = toSafeId(fingerprint);
    const deviceDoc = await db.collection("devices").doc(safeId).get();

    if (!deviceDoc.exists) {
      return res.status(200).json({ status: "signup_required" });
    }

    const links = deviceDoc.data().links || {};

    for (const tier of TIER_ORDER) {
      const licenseCode = links[tier];
      if (!licenseCode) continue; // این سطح اصلاً ثبت نشده، برو سطح بعد

      const licenseDoc = await db.collection("licenses").doc(licenseCode).get();
      if (!licenseDoc.exists) continue; // داده ناسازگار → نادیده بگیر

      const data = licenseDoc.data();
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
        if (!data.is_used || data.fingerprint !== fingerprint) continue;
        expiresAt = data.expires_at ? data.expires_at.toMillis() : null;
      }

      // ── این سطح "پیدا شد" → دیگه به سطح‌های پایین‌تر نمیریم ─────
      if (tier !== "lifetime" && expiresAt !== null && Date.now() > expiresAt) {
        return res.status(200).json({
          status: "purchase_required",
          licenseType: tier,
          licenseCode,
        });
      }

      const token = createSignedToken(
        fingerprint,
        licenseCode,
        tier,
        expiresAt,
      );
      return res.status(200).json({
        status: "valid",
        token,
        licenseType: tier,
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
