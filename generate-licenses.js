/**
 * generate-licenses.js
 * ─────────────────────────────────────────────────────────────
 * ساخت و آپلود لایسنس‌ها در Firestore
 *
 * هر لایسنس دو محور مستقل داره:
 *   - license_type : مدت زمان  → "1month" | "1year" | "lifetime" | "5days"
 *                     (این دقیقاً همون کلیدهاییه که index.js/LICENSE_DURATIONS
 *                      می‌شناسه — اگه این مقدار هرچیز دیگه‌ای باشه، سرور
 *                      فعال‌سازی رو با خطای "Invalid license type" رد می‌کنه)
 *   - tier          : سطح امکانات → "gold" | "silver" | "bronze"
 *                     (این فیلده که به توکن امضاشده اضافه میشه و اپ روش
 *                      FeatureGate رو اجرا می‌کنه)
 *
 * اجرا:
 *   npm install firebase-admin
 *   node generate-licenses.js
 *
 * پیش‌نیاز:
 *   فایل serviceAccount.json رو کنار این فایل بذار
 *   (از Firebase Console → Project Settings → Service Accounts دانلود کن)
 * ─────────────────────────────────────────────────────────────
 */

const admin = require("firebase-admin");
const crypto = require("crypto");
const fs = require("fs");

// ── Firebase init ─────────────────────────────────────────────
const serviceAccount = require("./serviceAccount.json");
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ── تنظیمات ──────────────────────────────────────────────────
const BATCH_SIZE = 490; // Firestore هر batch حداکثر 500 عملیات

// هر ترکیب (tier × duration) یک plan جداست.
// count رو هرجا خواستید عوض کنید — الان هرکدوم 20 تاست (جمعاً 9×20 = 180 لایسنس).
const PLANS = [
  { tier: "gold",   duration: "1month",   prefix: "GL1M", count: 20 },
  { tier: "gold",   duration: "1year",    prefix: "GL1Y", count: 20 },
  { tier: "gold",   duration: "lifetime", prefix: "GLLT", count: 20 },

  { tier: "silver", duration: "1month",   prefix: "SV1M", count: 20 },
  { tier: "silver", duration: "1year",    prefix: "SV1Y", count: 20 },
  { tier: "silver", duration: "lifetime", prefix: "SVLT", count: 20 },

  { tier: "bronze", duration: "1month",   prefix: "BZ1M", count: 20 },
  { tier: "bronze", duration: "1year",    prefix: "BZ1Y", count: 20 },
  { tier: "bronze", duration: "lifetime", prefix: "BZLT", count: 20 },
];

// ── لایسنس تریال ۵روزه‌ی رایگان (مشترک بین همه‌ی نصب‌ها) ────────────────
// برخلاف بقیه‌ی پلن‌ها، این is_shared:true هست و count نداره — فقط یک سند
// با کد ثابت ساخته می‌شه. همه‌ی کاربرا (هرکسی که اپ رو تازه نصب می‌کنه) با
// همین یک کد فعال می‌شن؛ سرور خودش هر device+appId رو جدا توی
// licenses/{TRIAL_CODE}/users/{fingerprint__appId} ثبت و ۵روزه محدود می‌کنه.
const TRIAL_CODE = "FREETRIAL5"; // اگه می‌خواید اسم/کد دیگه‌ای باشه همینجا عوض کنید
const TRIAL_TIER = "gold";       // طبق قرارمون: تریال همیشه با امکانات طلایی اجرا می‌شه

async function ensureTrialLicense() {
  console.log(`\n▶ بررسی/ساخت لایسنس تریال مشترک «${TRIAL_CODE}» (5days, ${TRIAL_TIER}) ...`);
  const ref = db.collection("licenses").doc(TRIAL_CODE);
  const existing = await ref.get();
  if (existing.exists) {
    console.log("  ↷ از قبل وجود داره، دست نمی‌زنیم (تا رکوردهای users زیرش از بین نره).");
    return;
  }
  await ref.set({
    license_type: "5days",
    tier: TRIAL_TIER,
    is_shared: true,
    total_activations: 0,
    created_at: admin.firestore.Timestamp.now(),
  });
  console.log("  ✓ ساخته شد.");
}

// ── ساخت کد تصادفی ───────────────────────────────────────────
// فرمت:  PREFIX-XXXX-XXXX-XXXX   (X = حرف بزرگ یا عدد)
function randomSegment(len = 4) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // بدون I,O,1,0 (گیج‌کننده)
  let s = "";
  for (let i = 0; i < len; i++) {
    s += chars[crypto.randomInt(chars.length)];
  }
  return s;
}

function generateCode(prefix) {
  return `${prefix}-${randomSegment()}-${randomSegment()}-${randomSegment()}`;
}

// ── آپلود با batch ────────────────────────────────────────────
async function uploadBatch(docs) {
  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const chunk = docs.slice(i, i + BATCH_SIZE);
    const batch = db.batch();
    for (const { id, data } of chunk) {
      batch.set(db.collection("licenses").doc(id), data);
    }
    await batch.commit();
    console.log(`  ✓ آپلود شد: ${i + chunk.length} / ${docs.length}`);
  }
}

// ── تولید و آپلود همه لایسنس‌ها ──────────────────────────────
async function main() {
  await ensureTrialLicense();

  const usedCodes = new Set(); // جلوگیری از تکرار کد
  const csvRows = ["code,tier,duration"]; // برای بایگانی خروجی
  csvRows.push(`${TRIAL_CODE},${TRIAL_TIER},5days`);

  let totalCount = 0;

  for (const plan of PLANS) {
    console.log(
      `\n▶ در حال ساخت ${plan.count} لایسنس ${plan.tier}/${plan.duration} (${plan.prefix}) ...`,
    );

    const docs = [];
    let attempts = 0;

    while (docs.length < plan.count) {
      attempts++;
      if (attempts > plan.count * 10) {
        throw new Error("خیلی زیاد تلاش شد — احتمالاً تصادم کد");
      }

      const code = generateCode(plan.prefix);
      if (usedCodes.has(code)) continue;
      usedCodes.add(code);

      docs.push({
        id: code,
        data: {
          license_type: plan.duration, // "1month" | "1year" | "lifetime" — باید دقیقاً یکی از کلیدهای LICENSE_DURATIONS در index.js باشه
          tier: plan.tier,              // "gold" | "silver" | "bronze"
          is_shared: false,
          is_used: false,
          fingerprint: null,
          appId: null,
          activated_at: null,
          expires_at: null,
          created_at: admin.firestore.Timestamp.now(),
        },
      });

      csvRows.push(`${code},${plan.tier},${plan.duration}`);
    }

    await uploadBatch(docs);
    totalCount += docs.length;
    console.log(`✅ ${docs.length} لایسنس ${plan.tier}/${plan.duration} آپلود شد`);
  }

  console.log(`\n🎉 همه‌ی ${totalCount} لایسنس با موفقیت در Firestore ذخیره شدند`);

  // ── ذخیره CSV برای بایگانی (کد + سطح + مدت، مستقیم از داده‌ی واقعی) ──
  fs.writeFileSync("licenses_export.csv", csvRows.join("\n"), "utf8");
  console.log("📄 فایل licenses_export.csv هم ذخیره شد (نگه‌دار!)");

  process.exit(0);
}

main().catch((err) => {
  console.error("❌ خطا:", err);
  process.exit(1);
});
