// ════════════════════════════════════════════════════════════════════════
//  migrate-license-ids.js
//  اسکریپت یک‌باره: تمام اسناد کالکشن licenses که ID شون کامل UPPERCASE
//  نیست رو به یک سند جدید با ID کامل بزرگ منتقل می‌کنه (همراه با
//  ساب‌کالکشن users اگه is_shared=true باشه)، و سند قدیمی رو پاک می‌کنه.
//
//  چرا لازمه:
//  کلاینت (اپلیکیشن) همیشه کد لایسنس رو قبل از ارسال uppercase می‌کنه.
//  اگه یک سند تو Firestore با ID مثل "OneM-26GN-NJWE-MA8D" (mixed-case)
//  ساخته شده باشه، lookup سمت سرور با "ONEM-26GN-NJWE-MA8D" دیگه پیداش
//  نمی‌کنه و کاربر "Invalid license code" می‌گیره.
//
//  نحوه اجرا:
//    1) همین فایل رو کنار index.js (تو همون پروژه‌ی سرور) بذار.
//    2) مطمئن شو env varهای SERVICE_ACCOUNT تنظیم هستن (همونی که index.js
//       استفاده می‌کنه — این اسکریپت دقیقاً همون credential رو می‌خونه).
//    3) اجرا کن:   node migrate-license-ids.js
//    4) خروجی کنسول رو چک کن — تعداد renamed/skipped/collision نشون داده میشه.
//
//  ایمن برای اجرای چندباره: اگه یک سند از قبل uppercase باشه، نادیده گرفته
//  میشه و دوباره دست‌کاری نمیشه.
// ════════════════════════════════════════════════════════════════════════

require("dotenv").config();
const admin = require("firebase-admin");

const serviceAccount = require("./serviceAccount.json");
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

function toSafeId(fingerprint) {
  return fingerprint.replace(/\//g, "_").replace(/\+/g, "-").replace(/=/g, "");
}

async function copySubcollection(oldDocRef, newDocRef, subcollectionName) {
  const snap = await oldDocRef.collection(subcollectionName).get();
  if (snap.empty) return [];

  const copiedFingerprints = [];
  for (const subDoc of snap.docs) {
    await newDocRef
      .collection(subcollectionName)
      .doc(subDoc.id)
      .set(subDoc.data());
    const fp = subDoc.data().fingerprint;
    if (fp) copiedFingerprints.push(fp);
  }
  return copiedFingerprints;
}

async function deleteSubcollection(docRef, subcollectionName) {
  const snap = await docRef.collection(subcollectionName).get();
  for (const subDoc of snap.docs) {
    await subDoc.ref.delete();
  }
}

// ── اصلاح ارجاع devices/{fingerprint}.links.{tier} از کد قدیمی به جدید ──
// لازمه چون لایسنس‌هایی که از قبل توسط یک کاربر فعال شدن، یک ایندکس تو
// devices دارن که هنوز به ID قدیمی (mixed-case) اشاره می‌کنه.
async function fixDeviceLink(fingerprint, licenseType, oldId, newId) {
  if (!fingerprint) return false;
  const safeId = toSafeId(fingerprint);
  const deviceRef = db.collection("devices").doc(safeId);
  const deviceDoc = await deviceRef.get();
  if (!deviceDoc.exists) return false;

  const links = deviceDoc.data().links || {};
  if (links[licenseType] !== oldId) return false;

  await deviceRef.set(
    {
      links: { [licenseType]: newId },
    },
    { merge: true },
  );
  return true;
}

async function migrate() {
  console.log("شروع migration کد لایسنس‌ها...\n");

  const licensesSnap = await db.collection("licenses").get();

  let renamed = 0;
  let skipped = 0;
  let collisions = 0;

  for (const doc of licensesSnap.docs) {
    const oldId = doc.id;
    const newId = oldId.toUpperCase();

    if (oldId === newId) {
      skipped++;
      continue;
    }

    const newDocRef = db.collection("licenses").doc(newId);
    const existingNewDoc = await newDocRef.get();

    if (existingNewDoc.exists) {
      console.warn(
        `⚠ تداخل: هم "${oldId}" و هم "${newId}" وجود دارن — این یکی رو دستی بررسی کن.`,
      );
      collisions++;
      continue;
    }

    const data = doc.data();
    const licenseType = data.license_type ?? "lifetime";

    // ── کپی خود سند با ID جدید ──────────────────────────────────────
    await newDocRef.set(data);

    // ── کپی ساب‌کالکشن users (برای لایسنس‌های is_shared=true) ───────
    const sharedUserFingerprints = await copySubcollection(
      doc.ref,
      newDocRef,
      "users",
    );

    // ── حذف ساب‌کالکشن و سند قدیمی ───────────────────────────────────
    await deleteSubcollection(doc.ref, "users");
    await doc.ref.delete();

    // ── اصلاح ارجاع devices/* به ID جدید ─────────────────────────────
    let deviceLinksFixed = 0;
    if (data.is_shared) {
      for (const fp of sharedUserFingerprints) {
        if (await fixDeviceLink(fp, licenseType, oldId, newId))
          deviceLinksFixed++;
      }
    } else if (data.is_used && data.fingerprint) {
      if (await fixDeviceLink(data.fingerprint, licenseType, oldId, newId))
        deviceLinksFixed++;
    }

    console.log(
      `✓ "${oldId}" → "${newId}"` +
        (sharedUserFingerprints.length > 0
          ? ` (${sharedUserFingerprints.length} کاربر users منتقل شد)`
          : "") +
        (deviceLinksFixed > 0
          ? ` (${deviceLinksFixed} ارجاع devices اصلاح شد)`
          : ""),
    );
    renamed++;
  }

  console.log("\n── خلاصه ──");
  console.log(`منتقل‌شده: ${renamed}`);
  console.log(`از قبل uppercase (بدون تغییر): ${skipped}`);
  console.log(`تداخل (نیاز به بررسی دستی): ${collisions}`);
  console.log("\nتمام شد.");
}

migrate()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("خطا در migration:", err);
    process.exit(1);
  });
