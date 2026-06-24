// اجرا کن: node generate-licenses.js 10
// عدد = تعداد کدهایی که میخوای بسازی

const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccount.json');
const crypto = require('crypto');

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

function generateCode() {
    // فرمت: XXXX-XXXX-XXXX-XXXX (حروف بزرگ + اعداد)
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 4; i++) {
        if (i > 0) code += '-';
        for (let j = 0; j < 4; j++) {
            code += chars[crypto.randomInt(0, chars.length)];
        }
    }
    return code;
}

async function main() {
    const count = parseInt(process.argv[2]) || 1;
    const codes = [];

    for (let i = 0; i < count; i++) {
        const code = generateCode();
        await db.collection('licenses').doc(code).set({
            is_used: false,
            fingerprint: null,
            activated_at: null,
            created_at: admin.firestore.FieldValue.serverTimestamp()
        });
        codes.push(code);
        console.log(`✓ ${code}`);
    }

    console.log(`\n${count} کد لایسنس در Firestore ذخیره شد`);
    process.exit(0);
}

main().catch(console.error);
