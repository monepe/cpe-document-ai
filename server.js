require('dotenv').config();

const express = require('express');
const session = require('express-session');
const multer = require('multer');
const { createWorker } = require('tesseract.js');
const { Groq } = require('groq-sdk');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const heicConvert = require('heic-convert');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const flash = require('connect-flash');
const { google } = require('googleapis');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const app = express();
const PORT = Number(process.env.PORT) || 3000;
const uploadDir = path.join(__dirname, 'uploads');

if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
    dest: uploadDir,
    limits: { fileSize: 50 * 1024 * 1024 }
});

const db = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'document_ai',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    charset: 'utf8mb4'
});

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const CATEGORIES = [
    'ภาระงานบริการวิชาการ',
    'ภาระงานทำนุบำรุงศิลปวัฒนธรรม',
    'ภาระงานที่ปรากฏเป็นผลงานทางวิชาการ',
    'ภาระงานพัฒนานักศึกษา',
    'อื่นๆ'
];

const APP_DRIVE_FOLDER = 'CPE Document AI';
const pendingUploads = new Map();

const ENABLE_USER_WHITELIST =
    process.env.ENABLE_USER_WHITELIST === 'true';

/* =====================================================
   OCR WORKER POOL
===================================================== */

const OCR_POOL_SIZE = Math.max(1, Number(process.env.OCR_POOL_SIZE) || 2);
const ocrWorkers = [];
const ocrWaiters = [];

async function initOcrPool() {
    console.log(`⏳ เตรียม OCR workers ${OCR_POOL_SIZE} ตัว...`);

    for (let i = 0; i < OCR_POOL_SIZE; i++)
        ocrWorkers.push(await createWorker(['tha', 'eng']));

    console.log('✅ OCR workers พร้อมใช้งาน');
}

async function acquireOcrWorker() {
    if (ocrWorkers.length) return ocrWorkers.pop();
    return new Promise(resolve => ocrWaiters.push(resolve));
}

function releaseOcrWorker(worker) {
    const waiter = ocrWaiters.shift();
    if (waiter) waiter(worker);
    else ocrWorkers.push(worker);
}

async function recognizeText(source) {
    const worker = await acquireOcrWorker();

    try {
        const { data: { text } } = await worker.recognize(source);
        return text;
    } finally {
        releaseOcrWorker(worker);
    }
}

/* =====================================================
   GENERAL
===================================================== */

function fixThaiFilename(filename) {
    if (!filename) return filename;

    try {
        const fixed = Buffer.from(filename, 'latin1').toString('utf8');
        return fixed.includes('\uFFFD') ? filename : fixed;
    } catch {
        return filename;
    }
}

function cleanupFile(file) {
    try {
        if (file && fs.existsSync(file)) fs.unlinkSync(file);
    } catch (error) {
        console.error('ลบไฟล์ไม่สำเร็จ:', error.message);
    }
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);

app.use(session({
    secret: process.env.SESSION_SECRET || 'change-this-session-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 30 * 60 * 1000,
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production'
    }
}));

app.use(flash());
app.use(passport.initialize());
app.use(passport.session());

/* =====================================================
   GOOGLE LOGIN
===================================================== */

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL:
        process.env.GOOGLE_CALLBACK_URL ||
        'http://localhost:3000/auth/google/callback'
}, async (accessToken, refreshToken, profile, done) => {

    try {

        const email =
            profile.emails?.[0]?.value?.trim().toLowerCase();

        if (!email) {
            return done(null, false, {
                message: 'ไม่พบ Gmail จากบัญชี Google นี้'
            });
        }

        // ค้นหาผู้ใช้จาก Database
        let [rows] = await db.execute(
            `SELECT id, email
             FROM users
             WHERE LOWER(email) = LOWER(?)
             LIMIT 1`,
            [email]
        );

        /*
        =====================================================
        USER WHITELIST
        =====================================================

        true  = เฉพาะ email ที่มีอยู่ใน users เท่านั้น
        false = ทุก Google Account เข้าได้
                และเพิ่ม email ลง users อัตโนมัติ
        */

        if (ENABLE_USER_WHITELIST) {

            // เปิดระบบตรวจสอบสิทธิ์
            if (!rows.length) {
                return done(null, false, {
                    message:
                        'อีเมลของคุณไม่มีสิทธิ์เข้าใช้งานระบบนี้!'
                });
            }

        } else {

            // ปิดระบบตรวจสอบชั่วคราว
            // ถ้ายังไม่มี user → เพิ่มเข้า Database เพื่อเก็บข้อมูล
            if (!rows.length) {

                const [result] = await db.execute(
                    `INSERT INTO users (email)
                     VALUES (?)`,
                    [email]
                );

                rows = [{
                    id: result.insertId,
                    email
                }];

                console.log(
                    `👤 เพิ่มผู้ใช้ใหม่อัตโนมัติ: ${email}`
                );
            }
        }

        const dbUser = rows[0];

        // Token สำหรับใช้งาน Google Drive
        profile.accessToken = accessToken;
        profile.refreshToken = refreshToken;

        // ข้อมูลจาก Database
        profile.dbUser = dbUser;

        return done(null, profile);

    } catch (error) {

        console.error(
            '❌ Google Login Error:',
            error
        );

        return done(error);
    }
}));   

function checkAuth(req, res, next) {
    if (req.isAuthenticated()) return next();
    res.redirect('/login.html');
}

app.get('/auth/google', passport.authenticate('google', {
    scope: ['profile', 'email', 'https://www.googleapis.com/auth/drive.file'],
    accessType: 'offline',
    prompt: 'consent'
}));

app.get('/auth/google/callback',
    passport.authenticate('google', {
        failureRedirect: '/login.html',
        failureFlash: true
    }),
    (req, res) => res.redirect('/index.html')
);

app.get('/api/auth-error', (req, res) =>
    res.json({ error: req.flash('error')[0] || null })
);

app.get('/api/me', checkAuth, (req, res) => {
    res.json({
        success: true,
        user: {
            id: req.user.dbUser?.id,
            email: req.user.dbUser?.email,

            // ชื่อและรูปใช้จาก Google โดยตรง
            displayName:
                req.user.displayName ||
                req.user.dbUser?.email,

            photo:
                req.user.photos?.[0]?.value || null
        }
    });
});

app.get('/api/logout', (req, res, next) => {
    req.logout(error => {
        if (error) return next(error);
        req.session.destroy(() => res.redirect('/login.html'));
    });
});

app.get('/index.html', checkAuth);
app.get('/', checkAuth, (req, res) =>
    res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

app.use(express.static(path.join(__dirname, 'public')));

/* =====================================================
   GOOGLE DRIVE
===================================================== */

function escapeDriveQuery(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function findDriveFolder(name, parentId, drive) {
    const folderName = escapeDriveQuery(name);

    let q =
        `name='${folderName}' and ` +
        `mimeType='application/vnd.google-apps.folder' and trashed=false`;

    q += parentId
        ? ` and '${parentId}' in parents`
        : ` and 'root' in parents`;

    const response = await drive.files.list({
        q,
        spaces: 'drive',
        fields: 'files(id,name,parents)',
        pageSize: 10
    });

    return response.data.files?.[0] || null;
}

async function createDriveFolder(name, parentId, drive) {
    const response = await drive.files.create({
        resource: {
            name,
            mimeType: 'application/vnd.google-apps.folder',
            parents: [parentId || 'root']
        },
        fields: 'id,name,parents'
    });

    return response.data;
}

async function getOrCreateDriveFolder(name, parentId, drive) {
    const folder = await findDriveFolder(name, parentId, drive);
    if (folder) return folder.id;

    return (await createDriveFolder(name, parentId, drive)).id;
}

async function getUserCategoryFolder(category, drive) {
    const mainFolder =
        await getOrCreateDriveFolder(APP_DRIVE_FOLDER, null, drive);

    return getOrCreateDriveFolder(category, mainFolder, drive);
}

/* =====================================================
   PDF -> JPEG
===================================================== */

async function convertPdfFirstPage(filePath) {
    const outputPrefix = path.join(
        path.dirname(filePath),
        path.basename(filePath) + '-page'
    );

    await execFileAsync('pdftoppm', [
        '-f', '1',
        '-singlefile',
        '-jpeg',
        '-r', '200',
        filePath,
        outputPrefix
    ], {
        timeout: 60000,
        maxBuffer: 10 * 1024 * 1024
    });

    const outputFile = outputPrefix + '.jpg';

    if (!fs.existsSync(outputFile))
        throw new Error('ไม่สามารถแปลง PDF เป็นรูปภาพได้');

    return outputFile;
}

/* =====================================================
   PARSE AI RESULT
===================================================== */

function parseAiJson(text) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');

    if (start === -1 || end === -1) {
        throw new Error('AI ไม่ได้ส่ง JSON กลับมา');
    }

    const parsed = JSON.parse(
        text.slice(start, end + 1)
    );

    const result = new Map();

    if (Array.isArray(parsed.categories)) {
        for (const item of parsed.categories) {
            if (
                !item ||
                !CATEGORIES.includes(item.name)
            ) {
                continue;
            }

            const value = Number(item.percentage);

            result.set(
                item.name,
                Number.isFinite(value)
                    ? Math.max(0, value)
                    : 0
            );
        }
    }

    let categories = CATEGORIES.map(name => ({
        name,
        percentage: result.get(name) ?? 0
    }));

    // รวมคะแนนดิบที่ AI ส่งมา
    const total = categories.reduce(
        (sum, item) => sum + item.percentage,
        0
    );

    if (total <= 0) {
        // ถ้า AI ไม่ส่งคะแนนที่ใช้ได้
        // ให้ "อื่นๆ" เป็น 100% แทนการหาร 20% ทุกหมวด
        categories = categories.map(item => ({
            ...item,
            percentage:
                item.name === 'อื่นๆ' ? 100 : 0
        }));
    } else {
        // Normalize ให้คะแนนทั้ง 5 หมวดรวมเป็น 100%
        // ไม่ปัดทศนิยมตรง Backend
        categories = categories.map(item => ({
            ...item,
            percentage:
                (item.percentage / total) * 100
        }));
    }

    // เรียงคะแนนจากมากไปน้อย
    categories.sort(
        (a, b) => b.percentage - a.percentage
    );

    return {
        reason:
            typeof parsed.reason === 'string'
                ? parsed.reason.trim()
                : '',
        categories
    };
}

/* =====================================================
   CLASSIFY
===================================================== */

app.post(
    '/api/classify',
    checkAuth,
    upload.single('image'),
    async (req, res) => {

        if (!req.file)
            return res.status(400).json({
                error: 'กรุณาอัปโหลดไฟล์'
            });

        req.file.originalname =
            fixThaiFilename(req.file.originalname);

        const filePath = req.file.path;

        const ext = req.file.originalname
            .split('.')
            .pop()
            .toLowerCase();

        let ocrSource = filePath;
        let tempFile = null;

        try {

            /* PDF */

            if (
                ext === 'pdf' ||
                req.file.mimetype === 'application/pdf'
            ) {
                tempFile =
                    await convertPdfFirstPage(filePath);

                ocrSource = tempFile;

            /* HEIC */

            } else if (
                ext === 'heic' ||
                ext === 'heif'
            ) {

                const buffer = await heicConvert({
                    buffer: fs.readFileSync(filePath),
                    format: 'JPEG',
                    quality: 0.9
                });

                tempFile =
                    filePath + '_converted.jpg';

                fs.writeFileSync(tempFile, buffer);

                ocrSource = tempFile;
            }

            /* OCR */

            const text =
                await recognizeText(ocrSource);

            cleanupFile(tempFile);
            tempFile = null;

            const trimmedText = text.trim();

            if (!trimmedText) {
                cleanupFile(filePath);

                return res.status(400).json({
                    error: 'ไม่พบข้อความในเอกสาร'
                });
            }

            /* AI */

            const prompt = `
คุณคือผู้เชี่ยวชาญด้านการจำแนกภาระงานอาจารย์ของมหาวิทยาลัย
วิเคราะห์วัตถุประสงค์ สาระสำคัญ กลุ่มเป้าหมาย และกิจกรรมหลักของเอกสาร
แล้วประเมิน "คะแนนความสอดคล้อง" กับหมวดทั้ง 5 หมวด

1. ภาระงานบริการวิชาการ
งานบริการความรู้หรือวิชาชีพแก่ชุมชน สังคม หน่วยงานภายนอก
การอบรม ให้คำปรึกษา และถ่ายทอดองค์ความรู้หรือเทคโนโลยี

2. ภาระงานทำนุบำรุงศิลปวัฒนธรรม
งานด้านศิลปะ วัฒนธรรม ประเพณี ภูมิปัญญาท้องถิ่น
ศาสนา การอนุรักษ์และสืบสานวัฒนธรรม

3. ภาระงานที่ปรากฏเป็นผลงานทางวิชาการ
งานวิจัย บทความวิจัย บทความวิชาการ ตำรา หนังสือ
สิ่งประดิษฐ์ นวัตกรรม และการเผยแพร่ผลงานทางวิชาการ

4. ภาระงานพัฒนานักศึกษา
กิจกรรมพัฒนานักศึกษา การดูแล ให้คำปรึกษา
กิจกรรมนักศึกษา และการพัฒนาทักษะหรือคุณลักษณะนักศึกษา

5. อื่นๆ
เอกสารที่ไม่สามารถจัดอยู่ใน 4 หมวดข้างต้นได้
เช่น ธุรการทั่วไป หนังสือแจ้งเวียน การเงิน พัสดุ บุคลากร
การประชุมทั่วไป เอกสารส่วนตัว หรือข้อมูลไม่เพียงพอ

กฎการวิเคราะห์:
- วิเคราะห์จากวัตถุประสงค์หลัก ไม่ใช่นับคำสำคัญ
- พิจารณากลุ่มเป้าหมาย กิจกรรม และผลลัพธ์ของเอกสารประกอบกัน
- การพบคำว่า นักศึกษา วิจัย บริการวิชาการ หรือวัฒนธรรมเพียงอย่างเดียวไม่เพียงพอ
- เอกสารสามารถเกี่ยวข้องหลายหมวดได้
- หากไม่ตรงกับ 4 ภาระงานแรก ห้ามฝืนเลือก ให้ "อื่นๆ" มีคะแนนสูงสุด
- หาก OCR ไม่ชัดเจนหรือข้อมูลไม่เพียงพอ ให้ลดความมั่นใจและเพิ่มคะแนน "อื่นๆ"
- เอกสารที่มีหลักฐานชัดเจนสามารถมีคะแนนอันดับหนึ่งมากกว่า 90
- เอกสารกำกวมต้องกระจายคะแนนตามความสอดคล้องและไม่ให้ความมั่นใจสูงเกินจริง
- ห้ามสร้างชื่อหมวดใหม่

กฎการให้คะแนน:
- ต้องประเมินครบทั้ง 5 หมวด
- คะแนนของทั้ง 5 หมวดรวมกันต้องเท่ากับ 100.0
- คะแนนแต่ละหมวดต้องสะท้อนสัดส่วนความสอดคล้องกับเนื้อหาเอกสาร
- หมวดที่ตรงกับวัตถุประสงค์หลักของเอกสารต้องมีคะแนนสูงที่สุด
- หมวดที่ไม่พบหลักฐานว่าสอดคล้อง ให้คะแนน 0.0
- ห้ามแจกคะแนนขั้นต่ำให้ทุกหมวดเพียงเพื่อให้ครบ 100
- หากเอกสารเกี่ยวข้องหลายหมวด ให้กระจายคะแนนตามระดับความเกี่ยวข้องจริง
- หากเอกสารตรงกับหมวดเดียวอย่างชัดเจน สามารถให้หมวดนั้น 100.0 และหมวดอื่น 0.0 ได้
- หากไม่ตรงกับ 4 ภาระงานหลัก ให้ "อื่นๆ" มีคะแนนสูงที่สุด
- หาก OCR ไม่ชัดเจนหรือข้อมูลไม่เพียงพอ ให้เพิ่มสัดส่วนของ "อื่นๆ"

ตอบ JSON เท่านั้น:

{
  "reason":"อธิบายวัตถุประสงค์ของเอกสารและเหตุผลที่หมวดอันดับหนึ่งเหมาะสมที่สุดแบบสั้นๆ",
  "categories":[
    {"name":"ภาระงานบริการวิชาการ","percentage":0.0},
    {"name":"ภาระงานทำนุบำรุงศิลปวัฒนธรรม","percentage":0.0},
    {"name":"ภาระงานที่ปรากฏเป็นผลงานทางวิชาการ","percentage":0.0},
    {"name":"ภาระงานพัฒนานักศึกษา","percentage":0.0},
    {"name":"อื่นๆ","percentage":0.0}
  ]
}

ข้อความจากเอกสาร:
"""${trimmedText}"""
`;

            const completion =
                await groq.chat.completions.create({
                    messages: [{
                        role: 'user',
                        content: prompt
                    }],
                    model: 'openai/gpt-oss-120b',
                    temperature: 0
                });

            const aiResult = parseAiJson(
                completion.choices?.[0]?.message?.content || ''
            );

            /* เก็บไฟล์รอยืนยัน */

            const uploadToken = crypto.randomUUID();

            const userEmail =
                req.user.dbUser?.email?.toLowerCase() ||
                req.user.emails?.[0]?.value?.toLowerCase();

            pendingUploads.set(uploadToken, {
                filePath,
                originalFileName: req.file.originalname,
                originalMimeType: req.file.mimetype,
                userEmail,
                userId: req.user.dbUser?.id,
                categories: aiResult.categories,
                reason: aiResult.reason,
                createdAt: Date.now()
            });

            res.json({
                success: true,
                uploadToken,
                reason: aiResult.reason,
                categories: aiResult.categories,
                recommendedCategory:
                    aiResult.categories[0]?.name || null
            });

        } catch (error) {

            console.error(
                '❌ Classification Error:',
                error
            );

            cleanupFile(filePath);
            cleanupFile(tempFile);

            res.status(500).json({
                error: 'ระบบวิเคราะห์เอกสารผิดพลาด',
                detail: error.message
            });
        }
    }
);

/* =====================================================
   UPLOAD SELECTED CATEGORY
===================================================== */

app.post(
    '/api/upload-selected-category',
    checkAuth,
    async (req, res) => {

        const { uploadToken, category } = req.body;

        if (!uploadToken || !category)
            return res.status(400).json({
                error: 'ข้อมูลการอัปโหลดไม่ครบ'
            });

        if (!CATEGORIES.includes(category))
            return res.status(400).json({
                error: 'หมวดหมู่ไม่ถูกต้อง'
            });

        const pending =
            pendingUploads.get(uploadToken);

        if (!pending)
            return res.status(404).json({
                error: 'ไม่พบไฟล์ที่รออัปโหลด กรุณาวิเคราะห์เอกสารใหม่อีกครั้ง'
            });

        const currentEmail =
            req.user.dbUser?.email?.toLowerCase() ||
            req.user.emails?.[0]?.value?.toLowerCase();

        if (pending.userEmail !== currentEmail)
            return res.status(403).json({
                error: 'ไม่มีสิทธิ์อัปโหลดไฟล์นี้'
            });

        if (!fs.existsSync(pending.filePath)) {
            pendingUploads.delete(uploadToken);

            return res.status(404).json({
                error: 'ไฟล์ชั่วคราวหาย กรุณาวิเคราะห์ใหม่'
            });
        }

        try {

            const oauth2Client =
                new google.auth.OAuth2(
                    process.env.GOOGLE_CLIENT_ID,
                    process.env.GOOGLE_CLIENT_SECRET,
                    process.env.GOOGLE_CALLBACK_URL ||
                    'http://localhost:3000/auth/google/callback'
                );

            oauth2Client.setCredentials({
                access_token: req.user.accessToken,
                refresh_token:
                    req.user.refreshToken || undefined
            });

            const drive =
                google.drive({
                    version: 'v3',
                    auth: oauth2Client
                });

            const folderId =
                await getUserCategoryFolder(
                    category,
                    drive
                );

            const response =
                await drive.files.create({
                    resource: {
                        name: pending.originalFileName,
                        parents: [folderId]
                    },

                    media: {
                        mimeType:
                            pending.originalMimeType,

                        body:
                            fs.createReadStream(
                                pending.filePath
                            )
                    },

                    fields: 'id,name'
                });

            const userId =
                pending.userId ||
                req.user.dbUser?.id;

            if (!userId)
                throw new Error(
                    'ไม่พบ user_id ของผู้ใช้งาน'
                );

            const selected =
                pending.categories.find(
                    item =>
                        item.name === category
                );

            const confidence =
                selected
                    ? Number(selected.percentage)
                    : null;

            /* DATABASE */

            const connection =
                await db.getConnection();

            try {

                await connection.beginTransaction();

                await connection.execute(
                    `INSERT INTO files
                    (user_id,original_name,category,drive_file_id,created_at)
                    VALUES (?,?,?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 7 HOUR))`,
                    [
                        userId,
                        pending.originalFileName,
                        category,
                        response.data.id
                    ]
                );

                await connection.execute(
                    `INSERT INTO logs
                    (user_id,category,confidence,created_at)
                    VALUES (?,?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 7 HOUR))`,
                    [
                        userId,
                        category,
                        confidence
                    ]
                );

                await connection.commit();

            } catch (error) {

                await connection.rollback();
                throw error;

            } finally {

                connection.release();
            }

            cleanupFile(pending.filePath);
            pendingUploads.delete(uploadToken);

            res.json({
                success: true,
                category,
                confidence,
                driveFileId: response.data.id,
                message:
                    `จัดเก็บเอกสารเข้า Google Drive หมวด [${category}] เรียบร้อยแล้ว`
            });

        } catch (error) {

            console.error(
                '❌ Upload Error:',
                error
            );

            res.status(500).json({
                error:
                    'อัปโหลด Google Drive ไม่สำเร็จ',
                detail:
                    error.message
            });
        }
    }
);

/* =====================================================
   CLEAN TEMP FILES
===================================================== */

setInterval(() => {

    const now = Date.now();

    for (const [token, pending] of pendingUploads) {

        if (
            now - pending.createdAt >
            30 * 60 * 1000
        ) {

            cleanupFile(pending.filePath);
            pendingUploads.delete(token);
        }
    }

}, 5 * 60 * 1000).unref();

/* =====================================================
   START SERVER
===================================================== */

async function startServer() {

    try {

        const connection =
            await db.getConnection();

        console.log(
            '✅ เชื่อมต่อ MySQL สำเร็จ'
        );

        connection.release();

        const [users] =
            await db.execute(
                `SHOW TABLES LIKE 'users'`
            );

        const [logs] =
            await db.execute(
                `SHOW TABLES LIKE 'logs'`
            );

        const [files] =
            await db.execute(
                `SHOW TABLES LIKE 'files'`
            );

        if (!users.length)
            throw new Error(
                'ไม่พบตาราง users'
            );

        if (!logs.length)
            throw new Error(
                'ไม่พบตาราง logs'
            );

        if (!files.length)
            throw new Error(
                'ไม่พบตาราง files'
            );

        /* เตรียม OCR ก่อนเปิด Server */

        await initOcrPool();

        app.listen(
            PORT,
            '0.0.0.0',
            () => {
                console.log(
                    `🚀 Server รันอยู่ที่ port ${PORT}`
                );
            }
        );

    } catch (error) {

        console.error(
            '❌ Start Server Error:',
            error.message
        );

        process.exit(1);
    }
}

startServer();