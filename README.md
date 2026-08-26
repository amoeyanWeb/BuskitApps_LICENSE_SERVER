# راهنمای کامل سیستم لایسنس BuskitApp

---

## فهرست
1. معماری کلی
2. انواع لایسنس
3. ساختار Firestore
4. نحوه ساخت لایسنس‌های جدید
5. اجرای اسکریپت generate-licenses.js
6. تنظیم لایسنس رایگان
7. منطق کامل سرور
8. منطق کامل اپ اندروید
9. سناریوهای مختلف کاربر

---

## ۱. معماری کلی

```
کاربر اپ رو نصب می‌کنه
        ↓
SplashActivity: token رو چک می‌کنه
        ↓
  token ندارد یا منقضیه؟
        ↓
ActivationActivity: کد لایسنس می‌گیره
        ↓
LicenseManager.activate() → POST /activate به سرور Render
        ↓
سرور Firestore رو چک می‌کنه
        ↓
token امضاشده RSA برمی‌گردونه
        ↓
token در EncryptedSharedPreferences ذخیره میشه
        ↓
دفعات بعد: فقط token آفلاین verify میشه (بدون اینترنت)
```

---

## ۲. انواع لایسنس

| نوع | مقدار license_type | مدت | is_shared | توضیح |
|-----|-------------------|-----|-----------|-------|
| مادام‌العمر | `lifetime` | بی‌نهایت | false | یه گوشی، برای همیشه |
| یکساله | `1year` | ۳۶۵ روز | false | یه گوشی، یک سال |
| یک‌ماهه | `1month` | ۳۰ روز | false | یه گوشی، یک ماه |
| رایگان ۵ روزه | `5days` | ۵ روز | **true** | همه می‌تونن استفاده کنن، هر کس فقط یه بار |

### قوانین کلی
- هر لایسنس اختصاصی (is_shared=false) فقط به **یه گوشی** وصل میشه
- نصب مجدد روی **همون گوشی** همیشه مجازه (تا زمانی که منقضی نشده)
- انتقال به گوشی دیگه برای هیچ نوعی ممکن نیست
- لایسنس رایگان روی **هر تعداد گوشی** کار می‌کنه ولی هر گوشی فقط یه بار ۵ روز می‌گیره

---

## ۳. ساختار Firestore

### کالکشن `licenses`

#### لایسنس اختصاصی (یکساله / یک‌ماهه / مادام‌العمر)
```
licenses/
  OneY-K7MN-P2QR-X4BV/        ← Document ID = کد لایسنس
    license_type: "1year"       ← نوع لایسنس
    is_shared:    false         ← اختصاصیه
    is_used:      false         ← هنوز فعال نشده
    fingerprint:  null          ← بعد از فعال‌سازی پر میشه
    activated_at: null          ← تاریخ فعال‌سازی
    expires_at:   null          ← تاریخ انقضا (بعد از فعال‌سازی پر میشه)
    created_at:   Timestamp     ← تاریخ ساخت (توسط اسکریپت)
```

#### بعد از فعال‌سازی توسط کاربر
```
licenses/
  OneY-K7MN-P2QR-X4BV/
    license_type: "1year"
    is_shared:    false
    is_used:      true                        ← تغییر کرد
    fingerprint:  "aB3kR9mX..."              ← hash گوشی
    activated_at: Timestamp(2025-06-01)
    expires_at:   Timestamp(2026-06-01)       ← یک سال بعد
    created_at:   Timestamp(2025-01-15)
```

#### لایسنس رایگان مشترک
```
licenses/
  Busk-itAPP-5Day-Free/
    license_type:       "5days"
    is_shared:          true          ← مشترکه
    total_activations:  1547          ← شمارنده (خودکار)

    users/                            ← subcollection
      aB3kR9mX.../                   ← fingerprint گوشی ۱
        fingerprint:  "aB3kR9mX..."
        activated_at: Timestamp(2025-06-01)
        expires_at:   Timestamp(2025-06-06)   ← ۵ روز بعد

      cD7pQ2nY.../                   ← fingerprint گوشی ۲
        fingerprint:  "cD7pQ2nY..."
        activated_at: Timestamp(2025-06-03)
        expires_at:   Timestamp(2025-06-08)
```

---

## ۴. فرمت کدهای لایسنس

```
OneY - XXXX - XXXX - XXXX    ← یکساله    (One Year)
OneM - XXXX - XXXX - XXXX    ← یک‌ماهه   (One Month)
Ever - XXXX - XXXX - XXXX    ← مادام‌العمر (Forever/Ever)
Busk-itAPP-5Day-Free         ← رایگان (ثابت، یه کد برای همه)
```

**کاراکترهای مجاز در XXXX:**
`A B C D E F G H J K L M N P Q R S T U V W X Y Z 2 3 4 5 6 7 8 9`

حروف `I` و `O` و اعداد `0` و `1` حذف شدن چون با هم اشتباه گرفته میشن.

**نمونه کدهای واقعی:**
```
OneY-K7MN-P2QR-X4BV
OneM-A3CK-F8HT-M5WZ
Ever-R9GJ-L2NB-Q6YD
```

---

## ۵. اجرای اسکریپت generate-licenses.js

### کجا ران کنی؟
روی **لپ‌تاپ یا کامپیوتر خودت** — فقط یه بار اجرا میشه.
نیازی به سرور Render نیست. Node.js باید نصب باشه.

### مراحل:

**قدم ۱ — دانلود Service Account از Firebase:**
```
Firebase Console
  → Project Settings (چرخ‌دنده بالا چپ)
  → Service Accounts
  → Generate new private key
  → دانلود کن
  → اسمش رو بذار: serviceAccountKey.json
```

**قدم ۲ — کنار فایل‌ها بذار:**
```
پوشه کارت/
  ├── generate-licenses.js
  └── serviceAccountKey.json      ← اینجا
```

**قدم ۳ — اجرا:**
```bash
npm install firebase-admin
node generate-licenses.js
```

**قدم ۴ — خروجی:**
```
▶ در حال ساخت 500 لایسنس 1year ...
  ✓ آپلود شد: 490 / 500
  ✓ آپلود شد: 500 / 500
✅ 500 لایسنس 1year آپلود شد

▶ در حال ساخت 500 لایسنس 1month ...
  ...
✅ 500 لایسنس 1month آپلود شد

▶ در حال ساخت 500 لایسنس lifetime ...
  ...
✅ 500 لایسنس lifetime آپلود شد

🎉 همه ۱۵۰۰ لایسنس با موفقیت در Firestore ذخیره شدند
📄 فایل licenses_export.csv هم ذخیره شد (نگه‌دار!)
```

**قدم ۵ — فایل CSV رو نگه‌دار:**
```
licenses_export.csv
─────────────────────
code,type
OneY-K7MN-P2QR-X4BV,1year
OneY-A3CK-F8HT-M5WZ,1year
...
OneM-R9GJ-L2NB-Q6YD,1month
...
Ever-T4BN-K8PX-H2QM,lifetime
...
```
این فایل بک‌آپ کدهاته — اگه Firestore رو پاک کنی این رو داری.

### مشکل احتمالی:
اگه خطای `PERMISSION_DENIED` گرفتی:
- Firestore Rules رو چک کن
- یا از همون سرور Render اجرا کن (service account همون پروژه باشه)

---

## ۶. تنظیم لایسنس رایگان (دستی)

این رو **یه بار** در Firestore Console بساز:

```
Firebase Console → Firestore Database → Start collection

Collection ID: licenses
Document ID:   Busk-itAPP-5Day-Free

Fields:
  license_type       (string)  →  5days
  is_shared          (boolean) →  true
  total_activations  (number)  →  0
```

همین. سرور بقیه کارها رو خودکار انجام میده.

---

## ۷. منطق کامل سرور (index.js)

### endpoint: POST /activate

```
ورودی: { licenseCode, fingerprint }

۱. کد رو در Firestore پیدا کن
   → اگه نبود: 404 "کد لایسنس معتبر نیست"

۲. is_shared رو چک کن:

   [is_shared = true] → لایسنس رایگان مشترک
     → subcollection users رو چک کن:
       - fingerprint قبلاً هست و هنوز معتبره؟ → token برگردون
       - fingerprint قبلاً هست و منقضی شده؟   → 403 "قبلاً استفاده کردی"
       - fingerprint جدیده؟                   → ثبت کن، expires_at بساز، token برگردون

   [is_shared = false] → لایسنس اختصاصی
     → is_used رو چک کن:
       - is_used=false: اولین فعال‌سازی → ثبت کن، token برگردون
       - is_used=true و fingerprint match: نصب مجدد
           - منقضی نشده? → token برگردون
           - منقضی شده?  → 403 "اعتبار تموم شده"
       - is_used=true و fingerprint دیگه: → 403 "روی گوشی دیگه فعاله"

۳. token امضاشده RSA برگردون:
   payload = { fingerprint, licenseCode, licenseType, expiresAt, issuedAt }
   token = base64(payload) + "|" + RSA_SHA256_signature
```

---

## ۸. منطق کامل اپ اندروید

### SplashActivity (اولین صفحه)
```
۱. LicenseManager.verifyToken() رو صدا بزن
۲. اگه نامعتبر یا منقضی → برو ActivationActivity
۳. اگه معتبر → نمایش اطلاعات لایسنس + دکمه ورود
```

### ActivationActivity
```
۱. کد لایسنس رو از کاربر بگیر
۲. LicenseManager.activate() رو صدا بزن
۳. اگه موفق → token ذخیره کن → برو SplashActivity
۴. اگه خطا → پیام نشون بده
```

### LicenseManager.verifyToken() — آفلاین
```
۱. token رو از EncryptedSharedPreferences بخون
۲. امضای RSA رو با public key verify کن
۳. fingerprint داخل token با fingerprint گوشی match کنه
۴. اگه expiresAt != null و الان > expiresAt → false
۵. همه چیز درست بود → true
```

### Device Fingerprint
```kotlin
SHA256( androidId + BOARD + BRAND + HARDWARE + MANUFACTURER )
```

---

## ۹. سناریوهای مختلف

### سناریو A: خرید لایسنس یکساله
```
کاربر OneY-K7MN-P2QR-X4BV رو وارد می‌کنه
  → سرور: is_used=false → فعال می‌کنه، expires_at = امروز + ۳۶۵ روز
  → token ذخیره میشه
  → اپ باز میشه ✓
```

### سناریو B: پاک کردن و نصب مجدد (لایسنس هنوز معتبره)
```
کاربر اپ رو پاک کرد → token رفت
کاربر دوباره نصب کرد
  → SplashActivity: token ندارد → ActivationActivity
  → کد رو دوباره وارد می‌کنه
  → سرور: is_used=true و fingerprint match و هنوز معتبره
  → token جدید با همون expires_at اصلی برمی‌گرده ✓
```

### سناریو C: لایسنس یکساله منقضی شده، نصب مجدد
```
کاربر اپ رو پاک کرد، بعد از یک سال دوباره نصب کرد
  → کد رو وارد می‌کنه
  → سرور: is_used=true، fingerprint match، ولی expires_at گذشته
  → 403: "مدت اعتبار لایسنس شما به پایان رسیده است" ✗
```

### سناریو D: تلاش برای استفاده روی گوشی دیگه
```
کاربر کد OneY-K7MN-P2QR-X4BV رو به دوستش میده
  → سرور: is_used=true و fingerprint متفاوته
  → 403: "این کد روی دستگاه دیگری فعال شده" ✗
```

### سناریو E: لایسنس رایگان ۵ روزه — اولین بار
```
کاربر Busk-itAPP-5Day-Free رو وارد می‌کنه
  → سرور: is_shared=true، fingerprint جدیده
  → subcollection/users/fingerprint ساخته میشه، expires_at = امروز + ۵ روز
  → token برمی‌گرده ✓
```

### سناریو F: لایسنس رایگان — نصب مجدد در ۵ روز
```
کاربر اپ رو پاک کرد، روز سوم دوباره نصب کرد
  → Busk-itAPP-5Day-Free رو وارد می‌کنه
  → سرور: fingerprint هست، expires_at هنوز نگذشته
  → همون token با همون تاریخ انقضا برمی‌گرده ✓
```

### سناریو G: لایسنس رایگان — تلاش بعد از ۵ روز
```
کاربر بعد از ۵ روز دوباره Busk-itAPP-5Day-Free رو وارد می‌کنه
  → سرور: fingerprint هست، expires_at گذشته
  → 403: "شما قبلاً از دوره رایگان استفاده کرده‌اید. برای ادامه لایسنس خریداری کنید." ✗
```

### سناریو H: دوست کاربر Busk-itAPP-5Day-Free رو وارد می‌کنه
```
  → سرور: is_shared=true، این fingerprint جدیده
  → ثبت میشه، ۵ روز اعتبار می‌گیره ✓
  (هر گوشی جداگانه ۵ روز می‌گیره)
```

---

## نکات امنیتی

- `serviceAccountKey.json` رو هرگز commit نکن (در .gitignore بذار)
- `PRIVATE_KEY` فقط در environment variable سرور Render باشه
- `PUBLIC_KEY` داخل اپ اندرویده و برای verify امضا استفاده میشه
- token در EncryptedSharedPreferences (AES-256) ذخیره میشه
- fingerprint هش SHA-256 اطلاعات سخت‌افزاریه — قابل جعل نیست

#   B u s k i t A p p s _ L I C E N S E _ S E R V E R  
 