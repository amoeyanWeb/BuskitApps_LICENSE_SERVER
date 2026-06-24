const express = require('express');
const cors = require('cors');
require('dotenv').config();

const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccount.json');

const fs = require('fs');
const crypto = require('crypto');

// ── Firebase init ─────────────────────────────────────────────────────────
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// ── کلید خصوصی برای امضا ─────────────────────────────────────────────────
const privateKey = fs.readFileSync('./private_key.pem', 'utf8');

// ── Express ───────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// ── تابع ساخت token امضاشده ──────────────────────────────────────────────
function createSignedToken(fingerprint, licenseCode) {
    const payload = JSON.stringify({
        fingerprint,
        licenseCode,
        issuedAt: Date.now()
    });

    const sign = crypto.createSign('RSA-SHA256');
    sign.update(payload);
    const signature = sign.sign(privateKey, 'base64');

    // payload + signature رو با | جدا می‌کنیم
    const token = Buffer.from(payload).toString('base64') + '|' + signature;
    return token;
}

// ── مسیر فعال‌سازی لایسنس ────────────────────────────────────────────────
// POST /activate
// body: { licenseCode: "XXXX-XXXX-XXXX", fingerprint: "abc123..." }
app.post('/activate', async (req, res) => {
    try {
        const { licenseCode, fingerprint } = req.body;

        if (!licenseCode || !fingerprint) {
            return res.status(400).json({ error: 'کد لایسنس و fingerprint الزامیست' });
        }

        // لایسنس رو در Firestore پیدا کن
        const licenseRef = db.collection('licenses').doc(licenseCode);
        const licenseDoc = await licenseRef.get();

        if (!licenseDoc.exists) {
            return res.status(404).json({ error: 'کد لایسنس معتبر نیست' });
        }

        const licenseData = licenseDoc.data();

        // قبلاً استفاده شده؟
        if (licenseData.is_used) {
            return res.status(403).json({ error: 'این کد لایسنس قبلاً استفاده شده' });
        }

        // لایسنس رو در Firestore به‌روز کن
        await licenseRef.update({
            is_used: true,
            fingerprint: fingerprint,
            activated_at: admin.firestore.FieldValue.serverTimestamp()
        });

        // token امضاشده بساز
        const token = createSignedToken(fingerprint, licenseCode);

        return res.status(200).json({
            success: true,
            token: token
        });

    } catch (err) {
        console.error('خطا در فعال‌سازی:', err);
        return res.status(500).json({ error: 'خطای سرور' });
    }
});

// ── مسیر health check ─────────────────────────────────────────────────────
app.get('/', (req, res) => {
    res.json({ status: 'LiveFX License Server is running' });
});

// ── شروع سرور ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`سرور لایسنس روی پورت ${PORT} در حال اجراست`);
});
