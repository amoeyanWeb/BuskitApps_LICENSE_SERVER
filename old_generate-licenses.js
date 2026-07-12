/**
 * generate-licenses.js
 * ─────────────────────────────────────────────────────────────
 * ساخت و آپلود ۱۵۰۰ لایسنس در Firestore
 *
 * اجرا:
 *   npm install firebase-admin
 *   node generate-licenses.js
 *
 * پیش‌نیاز:
 *   فایل serviceAccountKey.json رو کنار این فایل بذار
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

const PLANS = [
  {
    type: "1year",
    prefix: "OneY",
    count: 500,
    format: "OneY-XXXX-XXXX-XXXX", // فقط نمایشی
  },
  {
    type: "1month",
    prefix: "OneM",
    count: 500,
    format: "OneM-XXXX-XXXX-XXXX",
  },
  {
    type: "lifetime",
    prefix: "Ever",
    count: 500,
    format: "Ever-XXXX-XXXX-XXXX",
  },
];

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
  // Firestore batch حداکثر 500 عملیات → تقسیم کن
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
  const usedCodes = new Set(); // جلوگیری از تکرار

  for (const plan of PLANS) {
    console.log(`\n▶ در حال ساخت ${plan.count} لایسنس ${plan.type} ...`);

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
          license_type: plan.type,
          is_shared: false,
          is_used: false,
          fingerprint: null,
          activated_at: null,
          expires_at: null,
          created_at: admin.firestore.Timestamp.now(),
        },
      });
    }

    await uploadBatch(docs);
    console.log(`✅ ${plan.count} لایسنس ${plan.type} آپلود شد`);
  }

  console.log("\n🎉 همه ۱۵۰۰ لایسنس با موفقیت در Firestore ذخیره شدند");

  // ── ذخیره CSV برای بایگانی ───────────────────────────────
  const allCodes = [...usedCodes];
  const csv = [
    "code,type",
    ...allCodes.map((c) => {
      const type = c.startsWith("OneY")
        ? "1year"
        : c.startsWith("OneM")
          ? "1month"
          : "lifetime";
      return `${c},${type}`;
    }),
  ].join("\n");

  fs.writeFileSync("licenses_export.csv", csv, "utf8");
  console.log("📄 فایل licenses_export.csv هم ذخیره شد (نگه‌دار!)");

  process.exit(0);
}

main().catch((err) => {
  console.error("❌ خطا:", err);
  process.exit(1);
});
