// ════════════════════════════════════════════════════════════════════════
//  🎫 اسکریپت تولید انبوه لایسنس‌های دائمی (lifetime) — بدون هیچ محدودیت زمانی
// ════════════════════════════════════════════════════════════════════════
// این اسکریپت هیچ ربطی به سرور index.js نداره و جدا اجرا می‌شه (یک‌بار،
// روی کامپیوتر خودت). مستقیم توی همون پروژه‌ی Firestore که سرورت بهش وصله
// یک‌سری سند در کالکشن licenses می‌سازه — دقیقاً با همون فرمتی که /activate
// و /signin انتظارش رو دارن (tier/license_type/is_shared/is_used).
//
// ── استفاده ─────────────────────────────────────────────────────────────
//   1) این فایل رو کنار index.js (همون پوشه‌ی پروژه‌ی سرور) بذار، چون به
//      همون firebase-admin که آنجا نصبه نیاز داره.
//   2) اگه سرورت روی Render با متغیر محیطی SERVICE_ACCOUNT اجرا می‌شه،
//      کافیه یک فایل .env محلی (یا export مستقیم توی ترمینال) با همون
//      متغیر SERVICE_ACCOUNT (رشته‌ی JSON کامل Service Account) بسازی.
//      اگه نه، یک فایل serviceAccountKey.json از Firebase Console
//      (Project settings → Service accounts → Generate new private key)
//      دانلود کن و کنار این اسکریپت بذار.
//   3) اجرا:
//        node generate-licenses.js 50
//        node generate-licenses.js BMM 50
//      یکی از آرگومان‌ها عدد تعداد لایسنس‌هاست (پیش‌فرض: 10)، اون یکی
//      (اختیاری) نام فروشنده‌ست — ترتیبشون مهم نیست، هرکدوم عدد بود
//      بعنوان تعداد در نظر گرفته می‌شه. نام فروشنده روی تک‌تک لایسنس‌های
//      همون دسته (فیلد seller) درج می‌شه.
//   4) روی هر لایسنس، فیلدهای name (پیش‌فرض «Noname»)، email و whatsapp
//      هم خالی/پیش‌فرض ساخته می‌شن تا بعداً از پنل ادمین یا مستقیم توی
//      Firestore پرشون کنی؛ همون فیلدهایی‌ان که admin.html هم نمایش می‌ده.
//   5) بعد از اجرا، یک فایل licenses-<تاریخ>.csv کنار همین اسکریپت ساخته
//      می‌شه که کدها + نام فروشنده رو داره؛ ستون‌های name/email/whatsapp/note
//      رو می‌تونی دستی پر کنی.

const admin = require("firebase-admin");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// ── اتصال به Firebase (همون منطق سرور، با یک fallback به فایل محلی) ──────
let serviceAccount;
if (process.env.SERVICE_ACCOUNT) {
  serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT);
} else {
  const keyPath = path.join(__dirname, "serviceAccountKey.json");
  if (!fs.existsSync(keyPath)) {
    console.error(
      "❌ نه متغیر محیطی SERVICE_ACCOUNT ست شده، نه فایل serviceAccountKey.json کنار این اسکریپت پیدا شد.\n" +
        "   یکی از این دو راه رو انجام بده (توضیحات بالای همین فایل رو ببین) و دوباره اجرا کن.",
    );
    process.exit(1);
  }
  serviceAccount = JSON.parse(fs.readFileSync(keyPath, "utf8"));
}

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ── همون الفبا و روش تولید کدِ سرور (بدون حروف/ارقام شبیه‌به‌هم مثل O/0, I/1) ──
const LICENSE_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function generateLicenseCode() {
  let code = "";
  for (let i = 0; i < 10; i++) {
    code += LICENSE_CODE_ALPHABET[crypto.randomInt(LICENSE_CODE_ALPHABET.length)];
  }
  return code;
}

// ── فیلدهای سند لایسنس — دقیقاً هم‌شکل با چیزی که create-order/webhook ──
// برای یک لایسنس دائمی (لایف‌تایم) می‌سازن؛ یعنی expires_at اصلاً ست
// نمی‌شه (نامحدود)، و is_used:false یعنی هنوز روی هیچ گوشی‌ای فعال نشده —
// اولین گوشی‌ای که این کد رو توی اپ وارد کنه، صاحبش می‌شه.
// seller/name/email/whatsapp هیچ‌کدوم توسط /activate یا /signin خونده
// نمی‌شن (اون دو مسیر فقط tier/license_type/is_shared/is_used/expires_at
// رو نگاه می‌کنن)، پس اضافه‌شدنشون هیچ اثری روی فعال‌سازی/شناسایی نداره؛
// فقط برای پیگیری و نمایش توی پنل ادمین (admin.html) هستن — همون فیلدهایی
// که جدول لایسنس‌ها همین الان هم نمایش می‌ده.
function buildLifetimeLicenseDoc(sellerName) {
  return {
    tier: "gold",
    license_type: "lifetime",
    appGeneration: "v1",
    is_shared: false,
    is_used: false,
    source: "manual-batch", // فقط برای تشخیص در پنل ادمین/گزارش‌گیری
    seller: sellerName || "", // نام فروشنده — دستی از خط فرمان گرفته می‌شه
    name: "Noname", // نام خریدار — بعداً دستی پر می‌شه
    email: "", // ایمیل خریدار — بعداً دستی پر می‌شه
    whatsapp: "", // واتس‌اپ خریدار — بعداً دستی پر می‌شه
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

async function main() {
  // ── آرگومان‌های خط فرمان — ترتیب مهم نیست ────────────────────────────
  // هرکدوم از دو آرگومان که خالص عدد بود، «تعداد»ه؛ اون یکی (اگه بود)
  // «نام فروشنده»ست. یعنی هم «BMM 50» هم «50 BMM» یکی‌ان.
  const rawArgs = process.argv.slice(2);
  let sellerName = "";
  let count = null;
  for (const arg of rawArgs) {
    const trimmed = arg.trim();
    const n = parseInt(trimmed, 10);
    if (!Number.isNaN(n) && String(n) === trimmed) {
      count = n;
    } else if (trimmed) {
      sellerName = trimmed;
    }
  }
  if (count === null) count = 10;

  if (count <= 0 || count > 500) {
    console.error("❌ تعداد باید بین ۱ تا ۵۰۰ باشه (برای اعداد بزرگ‌تر، چندبار اجرا کن).");
    process.exit(1);
  }

  console.log(
    `در حال ساخت ${count} لایسنس دائمی${sellerName ? ` برای فروشنده «${sellerName}»` : ""}...`,
  );

  const codes = [];
  const licensesRef = db.collection("licenses");

  // ── تولید کدهای یکتا: هر کد رو قبل از رزرو چک می‌کنیم که توی همین دسته
  // یا توی Firestore تکراری نباشه (برخورد عملاً غیرممکنه، ولی محکم‌کاریه) ──
  const seen = new Set();
  while (codes.length < count) {
    const code = generateLicenseCode();
    if (seen.has(code)) continue;
    const existing = await licensesRef.doc(code).get();
    if (existing.exists) continue;
    seen.add(code);
    codes.push(code);
  }

  // ── نوشتن همه‌ی اسناد در یک batch اتمیک (حداکثر ۵۰۰ نوشتن در هر batch) ──
  const batch = db.batch();
  codes.forEach((code) => {
    batch.set(licensesRef.doc(code), buildLifetimeLicenseDoc(sellerName));
  });
  await batch.commit();

  console.log(`✅ ${codes.length} لایسنس دائمی با موفقیت در Firestore ساخته شد.`);

  // ── خروجی CSV کنار همین اسکریپت — ستون‌های name/email/whatsapp/note رو
  // خودت بعداً دستی، هر کد رو که به کسی دادی، پر کن (فقط برای پیگیری خودت،
  // هیچ اثری روی خودِ لایسنس نداره؛ مقدار seller همون چیزیه که همین الان
  // روی خودِ سند Firestore هم نوشته شده) ──
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(__dirname, `licenses-${stamp}.csv`);
  const csvLines = [
    "license_code,seller,name,email,whatsapp,note",
    ...codes.map((c) => `${c},${sellerName},Noname,,,`),
  ];
  fs.writeFileSync(outPath, csvLines.join("\n"), "utf8");

  console.log(`📄 لیست کدها اینجا ذخیره شد: ${outPath}`);
  console.log("");
  codes.forEach((c) => console.log("  " + c));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ خطا در ساخت لایسنس‌ها:", err);
    process.exit(1);
  });
