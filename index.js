const express = require('express');
const cors = require('cors');
require('dotenv').config();

const admin = require('firebase-admin');
const crypto = require('crypto');

// ── Firebase init ─────────────────────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ── کلید خصوصی ───────────────────────────────────────────────────────────
const privateKey = process.env.PRIVATE_KEY.replace(/\\n/g, '\n');

// ── Express ───────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// ── مدت زمان انواع لایسنس (ms) ───────────────────────────────────────────
const LICENSE_DURATIONS = {
    'lifetime': null,
    '1year':    365 * 24 * 60 * 60 * 1000,
    '1month':   30  * 24 * 60 * 60 * 1000,
    '5days':    5   * 24 * 60 * 60 * 1000,
};

// ── ساخت token امضاشده ───────────────────────────────────────────────────
function createSignedToken(fingerprint, licenseCode, licenseType, expiresAt) {
    const payload = JSON.stringify({
        fingerprint,
        licenseCode,
        licenseType,
        expiresAt: expiresAt ?? null,
        issuedAt: Date.now()
    });
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(payload);
    const signature = sign.sign(privateKey, 'base64');
    return Buffer.from(payload).toString('base64') + '|' + signature;
}

// ── مسیر فعال‌سازی ────────────────────────────────────────────────────────
app.post('/activate', async (req, res) => {
    try {
        const { licenseCode, fingerprint } = req.body;

        if (!licenseCode || !fingerprint) {
            return res.status(400).json({ error: 'License code and fingerprint are required' });
        }

        const licenseRef = db.collection('licenses').doc(licenseCode);
        const licenseDoc = await licenseRef.get();

        if (!licenseDoc.exists) {
            return res.status(404).json({ error: 'Invalid license code' });
        }

        const data = licenseDoc.data();
        const licenseType = data.license_type ?? 'lifetime';
        const isShared    = data.is_shared === true;

        if (!LICENSE_DURATIONS.hasOwnProperty(licenseType)) {
            return res.status(400).json({ error: 'Invalid license type' });
        }

        const durationMs = LICENSE_DURATIONS[licenseType];

        // ════════════════════════════════════════════════════════════════
        // حالت ۱: لایسنس مشترک (is_shared = true) — مثل کد رایگان ۵ روزه
        // ════════════════════════════════════════════════════════════════
        if (isShared) {
            const userRef = licenseRef.collection('users').doc(fingerprint);
            const userDoc = await userRef.get();

            if (userDoc.exists) {
                const userData = userDoc.data();
                const expiresAt = userData.expires_at
                    ? userData.expires_at.toMillis()
                    : null;

                // هنوز در بازه → نصب مجدد مجازه
                if (expiresAt === null || Date.now() <= expiresAt) {
                    const token = createSignedToken(
                        fingerprint, licenseCode, licenseType, expiresAt
                    );
                    return res.status(200).json({ success: true, token, licenseType, expiresAt });
                }

                // بازه تموم شده → رد کن
                return res.status(403).json({
                    error: 'You have already used your free trial. Please purchase a license to continue.'
                });
            }

            // اولین بار این fingerprint → ثبت کن
            const now = Date.now();
            const expiresAt = durationMs !== null ? now + durationMs : null;
            const expiresAtFirestore = expiresAt !== null
                ? admin.firestore.Timestamp.fromMillis(expiresAt)
                : null;

            await userRef.set({
                fingerprint,
                activated_at: admin.firestore.FieldValue.serverTimestamp(),
                expires_at: expiresAtFirestore
            });

            // شمارنده کل کاربران رایگان
            await licenseRef.update({
                total_activations: admin.firestore.FieldValue.increment(1)
            });

            const token = createSignedToken(
                fingerprint, licenseCode, licenseType, expiresAt
            );
            return res.status(200).json({ success: true, token, licenseType, expiresAt });
        }

        // ════════════════════════════════════════════════════════════════
        // حالت ۲: لایسنس اختصاصی (is_shared = false) — منطق قبلی
        // ════════════════════════════════════════════════════════════════
        if (data.is_used) {
            if (data.fingerprint === fingerprint) {
                const expiresAt = data.expires_at ? data.expires_at.toMillis() : null;

                if (expiresAt !== null && Date.now() > expiresAt) {
                    return res.status(403).json({
                        error: 'Your license has expired'
                    });
                }

                const token = createSignedToken(fingerprint, licenseCode, licenseType, expiresAt);
                return res.status(200).json({ success: true, token, licenseType, expiresAt });
            }

            return res.status(403).json({
                error: 'This license code is already activated on another device'
            });
        }

        // اولین فعال‌سازی لایسنس اختصاصی
        const now = Date.now();
        const expiresAt = durationMs !== null ? now + durationMs : null;
        const expiresAtFirestore = expiresAt !== null
            ? admin.firestore.Timestamp.fromMillis(expiresAt)
            : null;

        await licenseRef.update({
            is_used: true,
            fingerprint,
            license_type: licenseType,
            activated_at: admin.firestore.FieldValue.serverTimestamp(),
            expires_at: expiresAtFirestore
        });

        const token = createSignedToken(fingerprint, licenseCode, licenseType, expiresAt);
        return res.status(200).json({ success: true, token, licenseType, expiresAt });

    } catch (err) {
        console.error('خطا در فعال‌سازی:', err);
        return res.status(500).json({ error: 'Server error' });
    }
});

// ── مسیر تأیید لایسنس (برای لایسنس‌های زمان‌دار) ─────────────────────────
app.post('/verify', async (req, res) => {
    try {
        const { licenseCode, fingerprint } = req.body;

        if (!licenseCode || !fingerprint) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const licenseRef = db.collection('licenses').doc(licenseCode);
        const licenseDoc = await licenseRef.get();

        if (!licenseDoc.exists) {
            return res.status(404).json({ valid: false, error: 'License not found' });
        }

        const data = licenseDoc.data();
        const licenseType = data.license_type ?? 'lifetime';
        const isShared    = data.is_shared === true;

        // مادام‌العمر نیازی به verify آنلاین نداره
        if (licenseType === 'lifetime') {
            return res.status(200).json({ valid: true, licenseType });
        }

        // لایسنس مشترک (shared) — چک کن این fingerprint ثبت شده و منقضی نشده
        if (isShared) {
            const userRef = licenseRef.collection('users').doc(fingerprint);
            const userDoc = await userRef.get();

            if (!userDoc.exists) {
                return res.status(403).json({ valid: false, error: 'This device has not been activated' });
            }

            const userData = userDoc.data();
            const expiresAt = userData.expires_at ? userData.expires_at.toMillis() : null;

            if (expiresAt !== null && Date.now() > expiresAt) {
                return res.status(403).json({ valid: false, error: 'مدت اعتبار لایسنس به پایان رسیده است' });
            }

            return res.status(200).json({ valid: true, licenseType, expiresAt });
        }

        // لایسنس اختصاصی — چک fingerprint و انقضا
        if (!data.is_used || data.fingerprint !== fingerprint) {
            return res.status(403).json({ valid: false, error: 'This license is not valid for this device' });
        }

        const expiresAt = data.expires_at ? data.expires_at.toMillis() : null;

        if (expiresAt !== null && Date.now() > expiresAt) {
            return res.status(403).json({ valid: false, error: 'مدت اعتبار لایسنس به پایان رسیده است' });
        }

        return res.status(200).json({ valid: true, licenseType, expiresAt });

    } catch (err) {
        console.error('خطا در تأیید لایسنس:', err);
        return res.status(500).json({ valid: false, error: 'Server error' });
    }
});

// ── health check ──────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    res.json({ status: 'LiveFX License Server is running' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`سرور لایسنس روی پورت ${PORT} در حال اجراست`);
});
