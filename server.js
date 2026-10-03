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

/* =====================================================
   CONFIG
===================================================== */

const env = process.env;
const IS_PRODUCTION = env.NODE_ENV === 'production';

const PORT = Number(env.PORT) || 3000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');

const GOOGLE_CALLBACK_URL =
    env.GOOGLE_CALLBACK_URL || 'http://localhost:3000/auth/google/callback';
const GOOGLE_SCOPES = [
    'profile',
    'email',
    'https://www.googleapis.com/auth/drive.file'
];

const ENABLE_USER_WHITELIST = env.ENABLE_USER_WHITELIST === 'true';
const OCR_POOL_SIZE = Math.max(1, Number(env.OCR_POOL_SIZE) || 2);

const AI_MODEL = 'openai/gpt-oss-20b';
const APP_DRIVE_FOLDER = 'CPE Document AI';

const MAX_FILE_SIZE = 50 * 1024 * 1024;
const SESSION_MAX_AGE = 30 * 60 * 1000;
const PENDING_TTL = 30 * 60 * 1000;
const PENDING_SWEEP_INTERVAL = 5 * 60 * 1000;

// เวลาไทย (UTC+7) สำหรับบันทึกลงฐานข้อมูล
const NOW_TH = 'DATE_ADD(UTC_TIMESTAMP(), INTERVAL 7 HOUR)';

const CATEGORIES = [
    'ภาระงานบริการวิชาการ',
    'ภาระงานทำนุบำรุงศิลปวัฒนธรรม',
    'ภาระงานที่ปรากฏเป็นผลงานทางวิชาการ',
    'ภาระงานพัฒนานักศึกษา',
    'อื่นๆ'
];

const REQUIRED_TABLES = ['users', 'logs', 'files'];

/* =====================================================
   SERVICES
===================================================== */

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();

const upload = multer({
    dest: UPLOAD_DIR,
    limits: { fileSize: MAX_FILE_SIZE }
});

const db = mysql.createPool({
    host: env.DB_HOST || '127.0.0.1',
    port: Number(env.DB_PORT) || 3306,
    user: env.DB_USER || 'root',
    password: env.DB_PASSWORD || '',
    database: env.DB_NAME || 'document_ai',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    charset: 'utf8mb4',
    timezone: '+07:00'
});

const groq = new Groq({ apiKey: env.GROQ_API_KEY });

// ไฟล์ที่วิเคราะห์แล้วและรอผู้ใช้เลือกหมวด
const pendingUploads = new Map();

/* =====================================================
   HELPERS
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

function getUserEmail(req) {
    return (
        req.user.dbUser?.email?.toLowerCase() ||
        req.user.emails?.[0]?.value?.toLowerCase()
    );
}

function sendError(res, status, error, detail) {
    const body = { error };
    if (detail !== undefined) body.detail = detail;
    return res.status(status).json(body);
}

/* =====================================================
   OCR WORKER POOL
===================================================== */

const idleOcrWorkers = [];
const ocrWaiters = [];

async function initOcrPool() {
    console.log(`⏳ เตรียม OCR workers ${OCR_POOL_SIZE} ตัว...`);

    for (let i = 0; i < OCR_POOL_SIZE; i++)
        idleOcrWorkers.push(await createWorker(['tha', 'eng']));

    console.log('✅ OCR workers พร้อมใช้งาน');
}

function acquireOcrWorker() {
    if (idleOcrWorkers.length) return Promise.resolve(idleOcrWorkers.pop());
    return new Promise(resolve => ocrWaiters.push(resolve));
}

function releaseOcrWorker(worker) {
    const waiter = ocrWaiters.shift();
    if (waiter) waiter(worker);
    else idleOcrWorkers.push(worker);
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
   FILE CONVERSION (PDF / HEIC -> JPEG)
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

async function convertHeicToJpeg(filePath) {
    const buffer = await heicConvert({
        buffer: fs.readFileSync(filePath),
        format: 'JPEG',
        quality: 0.9
    });

    const outputFile = filePath + '_converted.jpg';
    fs.writeFileSync(outputFile, buffer);

    return outputFile;
}

/**
 * คืนค่าเป็นไฟล์ที่ OCR อ่านได้ และไฟล์ชั่วคราว (ถ้ามี) ที่ต้องลบทีหลัง
 */
async function prepareOcrSource(file, ext) {
    if (ext === 'pdf' || file.mimetype === 'application/pdf') {
        const tempFile = await convertPdfFirstPage(file.path);
        return { source: tempFile, tempFile };
    }

    if (ext === 'heic' || ext === 'heif') {
        const tempFile = await convertHeicToJpeg(file.path);
        return { source: tempFile, tempFile };
    }

    return { source: file.path, tempFile: null };
}

/* =====================================================
   AI CLASSIFICATION
===================================================== */

function buildPrompt(text) {
    return `
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
"""${text}"""
`;
}

/**
 * แปลงข้อความจาก AI เป็นคะแนน 5 หมวดที่รวมได้ 100% เรียงจากมากไปน้อย
 * (ไม่ปัดทศนิยมที่ Backend ให้หน้าเว็บปัดเอง)
 */
function parseAiJson(text) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');

    if (start === -1 || end === -1)
        throw new Error('AI ไม่ได้ส่ง JSON กลับมา');

    const parsed = JSON.parse(text.slice(start, end + 1));

    const scores = new Map();

    if (Array.isArray(parsed.categories)) {
        for (const item of parsed.categories) {
            if (!item || !CATEGORIES.includes(item.name)) continue;

            const value = Number(item.percentage);
            scores.set(item.name, Number.isFinite(value) ? Math.max(0, value) : 0);
        }
    }

    const raw = CATEGORIES.map(name => ({
        name,
        percentage: scores.get(name) ?? 0
    }));

    const total = raw.reduce((sum, item) => sum + item.percentage, 0);

    // AI ไม่ส่งคะแนนที่ใช้ได้ → ให้ "อื่นๆ" 100% แทนการหารเท่ากันทุกหมวด
    const categories = raw.map(item => ({
        ...item,
        percentage: total <= 0
            ? (item.name === 'อื่นๆ' ? 100 : 0)
            : (item.percentage / total) * 100
    }));

    categories.sort((a, b) => b.percentage - a.percentage);

    return {
        reason: typeof parsed.reason === 'string' ? parsed.reason.trim() : '',
        categories
    };
}

async function classifyText(text) {
    const completion = await groq.chat.completions.create({
        messages: [{ role: 'user', content: buildPrompt(text) }],
        model: AI_MODEL,
        temperature: 0
    });

    return parseAiJson(completion.choices?.[0]?.message?.content || '');
}

/* =====================================================
   GOOGLE DRIVE
===================================================== */

const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

function createDriveClient(user) {
    const auth = new google.auth.OAuth2(
        env.GOOGLE_CLIENT_ID,
        env.GOOGLE_CLIENT_SECRET,
        GOOGLE_CALLBACK_URL
    );

    auth.setCredentials({
        access_token: user.accessToken,
        refresh_token: user.refreshToken || undefined
    });

    return google.drive({ version: 'v3', auth });
}

function escapeDriveQuery(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function findDriveFolder(drive, name, parentId) {
    const q =
        `name='${escapeDriveQuery(name)}' and ` +
        `mimeType='${FOLDER_MIME_TYPE}' and trashed=false and ` +
        `'${parentId || 'root'}' in parents`;

    const response = await drive.files.list({
        q,
        spaces: 'drive',
        fields: 'files(id,name,parents)',
        pageSize: 10
    });

    return response.data.files?.[0] || null;
}

async function createDriveFolder(drive, name, parentId) {
    const response = await drive.files.create({
        requestBody: {
            name,
            mimeType: FOLDER_MIME_TYPE,
            parents: [parentId || 'root']
        },
        fields: 'id,name,parents'
    });

    return response.data;
}

async function getOrCreateDriveFolder(drive, name, parentId) {
    const folder =
        (await findDriveFolder(drive, name, parentId)) ||
        (await createDriveFolder(drive, name, parentId));

    return folder.id;
}

async function getCategoryFolderId(drive, category) {
    const mainFolderId = await getOrCreateDriveFolder(drive, APP_DRIVE_FOLDER, null);
    return getOrCreateDriveFolder(drive, category, mainFolderId);
}

async function uploadToDrive(drive, { folderId, name, mimeType, filePath }) {
    const response = await drive.files.create({
        requestBody: { name, parents: [folderId] },
        media: { mimeType, body: fs.createReadStream(filePath) },
        fields: 'id,name'
    });

    return response.data;
}

/* =====================================================
   DATABASE
===================================================== */

async function findUserByEmail(email) {
    const [rows] = await db.execute(
        `SELECT id, email
         FROM users
         WHERE LOWER(email) = LOWER(?)
         LIMIT 1`,
        [email]
    );

    return rows[0] || null;
}

async function createUser(email) {
    const [result] = await db.execute(
        `INSERT INTO users (email, created_at)
         VALUES (?, ${NOW_TH})`,
        [email]
    );

    return { id: result.insertId, email };
}

async function saveUploadRecord({ userId, fileName, category, driveFileId, confidence }) {
    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        await connection.execute(
            `INSERT INTO files
             (user_id, original_name, category, drive_file_id, created_at)
             VALUES (?, ?, ?, ?, ${NOW_TH})`,
            [userId, fileName, category, driveFileId]
        );

        await connection.execute(
            `INSERT INTO logs
             (user_id, category, confidence, created_at)
             VALUES (?, ?, ?, ${NOW_TH})`,
            [userId, category, confidence]
        );

        await connection.commit();
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

async function assertDatabaseReady() {
    const connection = await db.getConnection();
    connection.release();
    console.log('✅ เชื่อมต่อ MySQL สำเร็จ');

    for (const table of REQUIRED_TABLES) {
        const [rows] = await db.execute(`SHOW TABLES LIKE '${table}'`);
        if (!rows.length) throw new Error(`ไม่พบตาราง ${table}`);
    }
}

/* =====================================================
   MIDDLEWARE
===================================================== */

if (IS_PRODUCTION) app.set('trust proxy', 1);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
    secret: env.SESSION_SECRET || 'change-this-session-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: SESSION_MAX_AGE,
        httpOnly: true,
        sameSite: 'lax',
        secure: IS_PRODUCTION
    }
}));

app.use(flash());
app.use(passport.initialize());
app.use(passport.session());

function checkAuth(req, res, next) {
    if (req.isAuthenticated()) return next();
    res.redirect('/login.html');
}

/* =====================================================
   GOOGLE LOGIN
===================================================== */

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

/**
 * ENABLE_USER_WHITELIST
 *   true  = เฉพาะ email ที่มีอยู่ใน users เท่านั้น
 *   false = ทุก Google Account เข้าได้ และเพิ่ม email ลง users อัตโนมัติ
 */
async function verifyGoogleUser(accessToken, refreshToken, profile, done) {
    try {
        const email = profile.emails?.[0]?.value?.trim().toLowerCase();

        if (!email)
            return done(null, false, { message: 'ไม่พบ Gmail จากบัญชี Google นี้' });

        let dbUser = await findUserByEmail(email);

        if (!dbUser) {
            if (ENABLE_USER_WHITELIST)
                return done(null, false, {
                    message: 'อีเมลของคุณไม่มีสิทธิ์เข้าใช้งานระบบนี้!'
                });

            dbUser = await createUser(email);
            console.log(`👤 เพิ่มผู้ใช้ใหม่อัตโนมัติ: ${email}`);
        }

        // Token สำหรับ Google Drive และข้อมูลผู้ใช้จาก Database
        profile.accessToken = accessToken;
        profile.refreshToken = refreshToken;
        profile.dbUser = dbUser;

        return done(null, profile);
    } catch (error) {
        console.error('❌ Google Login Error:', error);
        return done(error);
    }
}

passport.use(new GoogleStrategy({
    clientID: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    callbackURL: GOOGLE_CALLBACK_URL
}, verifyGoogleUser));

/* =====================================================
   AUTH & PAGE ROUTES
===================================================== */

app.get('/auth/google', passport.authenticate('google', {
    scope: GOOGLE_SCOPES,
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
            displayName: req.user.displayName || req.user.dbUser?.email,
            photo: req.user.photos?.[0]?.value || null
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
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'))
);

app.use(express.static(PUBLIC_DIR));

/* =====================================================
   API: CLASSIFY
===================================================== */

app.post('/api/classify', checkAuth, upload.single('image'), async (req, res) => {
    if (!req.file)
        return sendError(res, 400, 'กรุณาอัปโหลดไฟล์');

    req.file.originalname = fixThaiFilename(req.file.originalname);

    const filePath = req.file.path;
    const ext = req.file.originalname.split('.').pop().toLowerCase();

    let tempFile = null;

    try {
        const ocr = await prepareOcrSource(req.file, ext);
        tempFile = ocr.tempFile;

        const text = await recognizeText(ocr.source);

        cleanupFile(tempFile);
        tempFile = null;

        const trimmedText = text.trim();

        if (!trimmedText) {
            cleanupFile(filePath);
            return sendError(res, 400, 'ไม่พบข้อความในเอกสาร');
        }

        const { reason, categories } = await classifyText(trimmedText);

        const uploadToken = crypto.randomUUID();

        pendingUploads.set(uploadToken, {
            filePath,
            originalFileName: req.file.originalname,
            originalMimeType: req.file.mimetype,
            userEmail: getUserEmail(req),
            userId: req.user.dbUser?.id,
            categories,
            reason,
            createdAt: Date.now()
        });

        res.json({
            success: true,
            uploadToken,
            reason,
            categories,
            recommendedCategory: categories[0]?.name || null
        });
    } catch (error) {
        console.error('❌ Classification Error:', error);

        cleanupFile(filePath);
        cleanupFile(tempFile);

        sendError(res, 500, 'ระบบวิเคราะห์เอกสารผิดพลาด', error.message);
    }
});

/* =====================================================
   API: UPLOAD SELECTED CATEGORY
===================================================== */

app.post('/api/upload-selected-category', checkAuth, async (req, res) => {
    const { uploadToken, category } = req.body;

    if (!uploadToken || !category)
        return sendError(res, 400, 'ข้อมูลการอัปโหลดไม่ครบ');

    if (!CATEGORIES.includes(category))
        return sendError(res, 400, 'หมวดหมู่ไม่ถูกต้อง');

    const pending = pendingUploads.get(uploadToken);

    if (!pending)
        return sendError(
            res, 404,
            'ไม่พบไฟล์ที่รออัปโหลด กรุณาวิเคราะห์เอกสารใหม่อีกครั้ง'
        );

    if (pending.userEmail !== getUserEmail(req))
        return sendError(res, 403, 'ไม่มีสิทธิ์อัปโหลดไฟล์นี้');

    if (!fs.existsSync(pending.filePath)) {
        pendingUploads.delete(uploadToken);
        return sendError(res, 404, 'ไฟล์ชั่วคราวหาย กรุณาวิเคราะห์ใหม่');
    }

    try {
        const drive = createDriveClient(req.user);
        const folderId = await getCategoryFolderId(drive, category);

        const uploaded = await uploadToDrive(drive, {
            folderId,
            name: pending.originalFileName,
            mimeType: pending.originalMimeType,
            filePath: pending.filePath
        });

        const userId = pending.userId || req.user.dbUser?.id;

        if (!userId) throw new Error('ไม่พบ user_id ของผู้ใช้งาน');

        const selected = pending.categories.find(item => item.name === category);
        const confidence = selected ? Number(selected.percentage) : null;

        await saveUploadRecord({
            userId,
            fileName: pending.originalFileName,
            category,
            driveFileId: uploaded.id,
            confidence
        });

        cleanupFile(pending.filePath);
        pendingUploads.delete(uploadToken);

        res.json({
            success: true,
            category,
            confidence,
            driveFileId: uploaded.id,
            message: `จัดเก็บเอกสารเข้า Google Drive หมวด [${category}] เรียบร้อยแล้ว`
        });
    } catch (error) {
        console.error('❌ Upload Error:', error);

        sendError(res, 500, 'อัปโหลด Google Drive ไม่สำเร็จ', error.message);
    }
});

/* =====================================================
   CLEAN TEMP FILES
===================================================== */

function startPendingSweeper() {
    setInterval(() => {
        const now = Date.now();

        for (const [token, pending] of pendingUploads) {
            if (now - pending.createdAt > PENDING_TTL) {
                cleanupFile(pending.filePath);
                pendingUploads.delete(token);
            }
        }
    }, PENDING_SWEEP_INTERVAL).unref();
}

/* =====================================================
   START SERVER
===================================================== */

async function startServer() {
    try {
        await assertDatabaseReady();

        // เตรียม OCR ก่อนเปิด Server
        await initOcrPool();

        startPendingSweeper();

        app.listen(PORT, '0.0.0.0', () =>
            console.log(`🚀 Server รันอยู่ที่ port ${PORT}`)
        );
    } catch (error) {
        console.error('❌ Start Server Error:', error.message);
        process.exit(1);
    }
}

startServer();