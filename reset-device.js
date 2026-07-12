/**
 * reset-device.js
 * ─────────────────────────────────────────────────────────────
 * برای تست: binding یک «دستگاه + اپ» رو در Firestore ریست می‌کنه تا
 * بشه دوباره با یک لایسنس دیگه (یا همون لایسنس) فعال‌سازی رو از اول
 * امتحان کرد — بدون گشتن دستی توی کنسول Firebase.
 *
 * کاری که انجام می‌ده:
 *   ۱. سند devices/{fingerprint__appId} رو پاک می‌کنه (تا /signin دیگه
 *      لایسنس قبلی رو پیدا نکنه و signup_required برگردونه).
 *   ۲. اگه --code داده بشه:
 *        - لایسنس اختصاصیه → فیلدهای is_used/fingerprint/appId/expires_at
 *          روی خودِ licenses/{code} ریست می‌شن (خودِ کد باقی می‌مونه و
 *          دوباره قابل فعال‌سازیه — چه با همین گوشی چه با یکی دیگه).
 *        - لایسنس مشترکه (مثل تریال) → فقط ساب‌داکیومنت خودِ همین
 *          fingerprint__appId زیر licenses/{code}/users پاک می‌شه؛ به
 *          خودِ سند مشترک (که بقیه‌ی کاربرا هم ازش استفاده می‌کنن) دست
 *          نمی‌زنه.
 *
 * اجرا:
 *   node reset-device.js --fingerprint=XXXXX --appId=com.BuskitApp.LiveFX [--code=SV1Y-XXXX-XXXX-XXXX]
 *
 * پیش‌نیاز: serviceAccount.json کنار این فایل باشه (همون فایلی که
 * generate-licenses.js هم استفاده می‌کنه).
 *
 * ⚠️ این اسکریپت فقط برای تست/دیباگ دستیه — با کلید ادمین Firebase اجرا
 * می‌شه، پس هیچ‌وقت نباید بخشی از اپ یا سرور عمومی بشه یا روی هاست عمومی
 * قابل‌صدا زدن باشه.
 * ─────────────────────────────────────────────────────────────
 */

const admin = require("firebase-admin");

const serviceAccount = require("./serviceAccount.json");
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ── پارس آرگومان‌های خط فرمان (--key=value) ─────────────────────────────
function parseArgs() {
  const out = {};
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function toSafeId(fingerprint) {
  return fingerprint.replace(/\//g, "_").replace(/\+/g, "-").replace(/=/g, "");
}

function deviceAppId(fingerprint, appId) {
  return `${toSafeId(fingerprint)}__${appId}`;
}

async function main() {
  const { fingerprint, appId, code } = parseArgs();

  if (!fingerprint || !appId) {
    console.error(
      "استفاده: node reset-device.js --fingerprint=XXXXX --appId=com.BuskitApp.LiveFX [--code=XXXX-XXXX-XXXX-XXXX]",
    );
    process.exit(1);
  }

  const safeId = deviceAppId(fingerprint, appId);

  // ── قدم ۱: پاک کردن ایندکس دستگاه ────────────────────────────────────
  const deviceRef = db.collection("devices").doc(safeId);
  const deviceSnap = await deviceRef.get();
  if (deviceSnap.exists) {
    await deviceRef.delete();
    console.log(`✓ devices/${safeId} حذف شد`);
  } else {
    console.log(`↷ devices/${safeId} از قبل وجود نداشت`);
  }

  // ── قدم ۲: ریست خود لایسنس (اگه --code داده شده باشه) ────────────────
  if (code) {
    const licenseCode = code.trim().toUpperCase();
    const licenseRef = db.collection("licenses").doc(licenseCode);
    const licenseSnap = await licenseRef.get();

    if (!licenseSnap.exists) {
      console.log(`↷ licenses/${licenseCode} پیدا نشد — کاری نکردم`);
    } else {
      const data = licenseSnap.data();

      if (data.is_shared) {
        // لایسنس مشترک (مثل تریال) — فقط رکورد همین دستگاه رو پاک کن
        const userRef = licenseRef.collection("users").doc(safeId);
        const userSnap = await userRef.get();
        if (userSnap.exists) {
          await userRef.delete();
          console.log(
            `✓ licenses/${licenseCode}/users/${safeId} حذف شد (خودِ لایسنس مشترک دست‌نخورده موند)`,
          );
        } else {
          console.log(`↷ licenses/${licenseCode}/users/${safeId} از قبل وجود نداشت`);
        }
      } else {
        // لایسنس اختصاصی — خودش رو دوباره «فعال‌نشده» کن
        await licenseRef.update({
          is_used: false,
          fingerprint: null,
          appId: null,
          activated_at: null,
          expires_at: null,
        });
        console.log(`✓ licenses/${licenseCode} ریست شد (دوباره قابل فعال‌سازیه)`);
      }
    }
  } else {
    console.log(
      "↷ --code داده نشده — فقط binding دستگاه پاک شد. اگه لایسنس اختصاصی قبلی رو هم می‌خواید دوباره قابل‌استفاده کنید، --code رو هم بدید.",
    );
  }

  console.log("\n🎉 تمام. حالا می‌تونید همین دستگاه رو با یک لایسنس (همین یا کد دیگه) از اول فعال کنید.");
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ خطا:", err);
  process.exit(1);
});
