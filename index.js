const express = require('express');
const cors = require('cors');
require('dotenv').config();

const admin = require('firebase-admin');
const fs = require('fs');
const crypto = require('crypto');

// ── Firebase init از environment variable ────────────────────────────────
const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// ── کلید خصوصی از environment variable ───────────────────────────────────
const privateKey = process.env.PRIVATE_KEY.replace(/\\n/g, '\n');

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

    const token = Buffer.from(payload).toString('base64') + '|' + signature;
    return token;
}

// ── مسیر فعال‌سازی لایسنس ────────────────────────────────────────────────
app.post('/activate', async (req, res) => {
    try {
        const { licenseCode, fingerprint } = req.body;

        if (!licenseCode || !fingerprint) {
            return res.status(400).json({ error: 'کد لایسنس و fingerprint الزامیست' });
        }

        const licenseRef = db.collection('licenses').doc(licenseCode);
        const licenseDoc = await licenseRef.get();

        if (!licenseDoc.exists) {
            return res.status(404).json({ error: 'کد لایسنس معتبر نیست' });
        }

        const licenseData = licenseDoc.data();

        if (licenseData.is_used) {
            return res.status(403).json({ error: 'این کد لایسنس قبلاً استفاده شده' });
        }

        await licenseRef.update({
            is_used: true,
            fingerprint: fingerprint,
            activated_at: admin.firestore.FieldValue.serverTimestamp()
        });

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

// ── health check ──────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    res.json({ status: 'LiveFX License Server is running' });
});

// ── شروع سرور ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`سرور لایسنس روی پورت ${PORT} در حال اجراست`);
});
