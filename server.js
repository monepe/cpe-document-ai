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

function fixThaiFilename(filename) {
    if (!filename) return filename;

    try {
        const fixed = Buffer.from(filename, 'latin1').toString('utf8');
        if (fixed.includes('\uFFFD')) return filename;
        return fixed;
    } catch {
        return filename;
    }
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

if (process.env.NODE_ENV === 'production') {
    app.set('trust proxy', 1);
}

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
        const email = profile.emails?.[0]?.value?.trim().toLowerCase();

        if (!email) {
            return done(null, false, {
                message: 'ไม่พบ Gmail จากบัญชี Google นี้'
            });
        }

        const [rows] = await db.execute(
            `SELECT id,email,display_name,role
             FROM users
             WHERE LOWER(email)=LOWER(?)
             LIMIT 1`,
            [email]
        );

        if (!rows.length) {
            return done(null, false, {
                message: 'อีเมลของคุณไม่มีสิทธิ์เข้าใช้งานระบบนี้!'
            });
        }

        const dbUser = rows[0];

        await db.execute(
            `UPDATE users
             SET google_id=?,
                 display_name=CASE
                    WHEN display_name IS NULL OR display_name='' THEN ?
                    ELSE display_name
                 END
             WHERE id=?`,
            [profile.id || null, profile.displayName || email, dbUser.id]
        );

        profile.accessToken = accessToken;
        profile.refreshToken = refreshToken;

        profile.dbUser = {
            ...dbUser,
            google_id: profile.id || null,
            display_name: dbUser.display_name || profile.displayName || email
        };

        done(null, profile);

    } catch (error) {
        done(error);
    }
}));

function checkAuth(req, res, next) {
    if (req.isAuthenticated()) return next();
    res.redirect('/login.html');
}

app.get('/auth/google', passport.authenticate('google', {
    scope: [
        'profile',
        'email',
        'https://www.googleapis.com/auth/drive.file'
    ],
    accessType: 'offline',
    prompt: 'consent'
}));

app.get(
    '/auth/google/callback',
    passport.authenticate('google', {
        failureRedirect: '/login.html',
        failureFlash: true
    }),
    (req, res) => res.redirect('/index.html')
);

app.get('/api/auth-error', (req, res) => {
    res.json({
        error: req.flash('error')[0] || null
    });
});

app.get('/api/me', checkAuth, (req, res) => {
    res.json({
        success: true,
        user: {
            id: req.user.dbUser?.id,
            email: req.user.dbUser?.email,
            displayName:
                req.user.dbUser?.display_name ||
                req.user.displayName,
            role: req.user.dbUser?.role || 'user',
            photo: req.user.photos?.[0]?.value || null
        }
    });
});

app.get('/api/logout', (req, res, next) => {
    req.logout(error => {
        if (error) return next(error);

        req.session.destroy(() => {
            res.redirect('/login.html');
        });
    });
});

app.get('/index.html', checkAuth);

app.get('/', checkAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

function escapeDriveQuery(value) {
    return String(value)
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'");
}

async function findDriveFolder(name, parentId, drive) {
    const folderName = escapeDriveQuery(name);

    let q =
        `name='${folderName}' ` +
        `and mimeType='application/vnd.google-apps.folder' ` +
        `and trashed=false`;

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

    const created = await createDriveFolder(name, parentId, drive);
    return created.id;
}

async function getUserCategoryFolder(category, drive) {
    const mainFolder = await getOrCreateDriveFolder(
        APP_DRIVE_FOLDER,
        null,
        drive
    );

    return getOrCreateDriveFolder(category, mainFolder, drive);
}

function cleanupFile(file) {
    try {
        if (file && fs.existsSync(file)) fs.unlinkSync(file);
    } catch (error) {
        console.error('ลบไฟล์ไม่สำเร็จ:', error.message);
    }
}


// ======================================================
// PDF -> JPEG สำหรับ Docker / Linux
// ======================================================

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

    if (!fs.existsSync(outputFile)) {
        throw new Error('ไม่สามารถแปลง PDF เป็นรูปภาพได้');
    }

    return outputFile;
}


// ======================================================
// PARSE AI RESULT
// ======================================================

function parseAiJson(text) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');

    if (start === -1 || end === -1) {
        throw new Error('AI ไม่ได้ส่ง JSON กลับมา');
    }

    const parsed = JSON.parse(text.slice(start, end + 1));
    const result = new Map();

    if (Array.isArray(parsed.categories)) {
        for (const item of parsed.categories) {
            if (!item || !CATEGORIES.includes(item.name)) continue;

            const value = Number(item.percentage);

            result.set(
                item.name,
                Number.isFinite(value)
                    ? Math.max(0, Math.min(100, value))
                    : 0
            );
        }
    }

    let categories = CATEGORIES.map(name => ({
        name,
        percentage: result.get(name) ?? 0
    }));

    const total = categories.reduce(
        (sum, item) => sum + item.percentage,
        0
    );

    if (total <= 0) {
        categories = categories.map(item => ({
            ...item,
            percentage: 100 / CATEGORIES.length
        }));
    } else {
        categories = categories.map(item => ({
            ...item,
            percentage:
                Math.round((item.percentage / total) * 1000) / 10
        }));
    }

    const normalizedTotal = categories.reduce(
        (sum, item) => sum + item.percentage,
        0
    );

    const diff =
        Math.round((100 - normalizedTotal) * 10) / 10;

    if (categories.length && diff !== 0) {
        const index = categories.reduce(
            (best, item, i, arr) =>
                item.percentage > arr[best].percentage
                    ? i
                    : best,
            0
        );

        categories[index].percentage =
            Math.round(
                (categories[index].percentage + diff) * 10
            ) / 10;
    }

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


// ======================================================
// CLASSIFY
// ======================================================

app.post(
    '/api/classify',
    checkAuth,
    upload.single('image'),
    async (req, res) => {

        if (!req.file) {
            return res.status(400).json({
                error: 'กรุณาอัปโหลดไฟล์'
            });
        }

        req.file.originalname = fixThaiFilename(
            req.file.originalname
        );

        const filePath = req.file.path;

        const ext = req.file.originalname
            .split('.')
            .pop()
            .toLowerCase();

        let ocrSource = filePath;
        let tempFile = null;
        let worker = null;

        try {

            // PDF
            if (
                ext === 'pdf' ||
                req.file.mimetype === 'application/pdf'
            ) {
                tempFile = await convertPdfFirstPage(filePath);
                ocrSource = tempFile;

            // HEIC / HEIF
            } else if (
                ext === 'heic' ||
                ext === 'heif'
            ) {
                const buffer = await heicConvert({
                    buffer: fs.readFileSync(filePath),
                    format: 'JPEG',
                    quality: 0.9
                });

                tempFile = filePath + '_converted.jpg';

                fs.writeFileSync(
                    tempFile,
                    buffer
                );

                ocrSource = tempFile;
            }


            // OCR
            worker = await createWorker([
                'tha',
                'eng'
            ]);

            const { data: { text } } =
                await worker.recognize(ocrSource);

            await worker.terminate();
            worker = null;

            cleanupFile(tempFile);
            tempFile = null;

            const trimmedText = text.trim();

            if (!trimmedText) {
                cleanupFile(filePath);

                return res.status(400).json({
                    error: 'ไม่พบข้อความในเอกสาร'
                });
            }


            // ==================================================
            // AI PROMPT
            // ==================================================

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
- ต้องให้คะแนนครบทั้ง 5 หมวด
- คะแนนทั้งหมดรวมกันต้องเท่ากับ 100.0
- ประเมินคะแนนจากวัตถุประสงค์ เนื้อหา กลุ่มเป้าหมาย และกิจกรรมของเอกสาร
- หากเอกสารตรงกับหมวดใดหมวดหนึ่งอย่างชัดเจนมาก และไม่มีสาระสำคัญที่สอดคล้องกับหมวดอื่น สามารถให้หมวดนั้น 100.0 และหมวดอื่น 0.0 ได้
- หากเอกสารมีความเกี่ยวข้องหลายหมวด ให้กระจายคะแนนตามระดับความสอดคล้อง
- หากผลไม่ชัดเจน ให้ใช้ทศนิยม 1 ตำแหน่งเพื่อสะท้อนระดับความสอดคล้อง เช่น 73.6, 14.2, 7.1
- ไม่จำเป็นต้องหลีกเลี่ยงเลขลงท้าย 0 หากคะแนนนั้นเหมาะสมกับหลักฐานจริง
- ห้ามสร้างหรือสุ่มทศนิยมเพียงเพื่อให้คะแนนดูละเอียด
- หากข้อมูลกำกวม ต้องไม่ให้คะแนนสูงเกินจริง
- หากข้อมูลไม่เพียงพอหรือ OCR อ่านไม่รู้เรื่อง ให้เพิ่มคะแนน "อื่นๆ"
- หมวดที่ตรงกับวัตถุประสงค์หลักต้องมีคะแนนสูงที่สุด

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


            // เก็บไฟล์รอผู้ใช้ยืนยันหมวด
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

            if (worker) {
                try {
                    await worker.terminate();
                } catch {}
            }

            cleanupFile(filePath);
            cleanupFile(tempFile);

            res.status(500).json({
                error: 'ระบบวิเคราะห์เอกสารผิดพลาด',
                detail: error.message
            });
        }
    }
);


// ======================================================
// UPLOAD SELECTED CATEGORY
// ======================================================

app.post(
    '/api/upload-selected-category',
    checkAuth,
    async (req, res) => {

        const {
            uploadToken,
            category
        } = req.body;


        if (!uploadToken || !category) {
            return res.status(400).json({
                error: 'ข้อมูลการอัปโหลดไม่ครบ'
            });
        }


        if (!CATEGORIES.includes(category)) {
            return res.status(400).json({
                error: 'หมวดหมู่ไม่ถูกต้อง'
            });
        }


        const pending =
            pendingUploads.get(uploadToken);


        if (!pending) {
            return res.status(404).json({
                error:
                    'ไม่พบไฟล์ที่รออัปโหลด กรุณาวิเคราะห์เอกสารใหม่อีกครั้ง'
            });
        }


        const currentEmail =
            req.user.dbUser?.email?.toLowerCase() ||
            req.user.emails?.[0]?.value?.toLowerCase();


        if (pending.userEmail !== currentEmail) {
            return res.status(403).json({
                error: 'ไม่มีสิทธิ์อัปโหลดไฟล์นี้'
            });
        }


        if (!fs.existsSync(pending.filePath)) {
            pendingUploads.delete(uploadToken);

            return res.status(404).json({
                error:
                    'ไฟล์ชั่วคราวหาย กรุณาวิเคราะห์ใหม่'
            });
        }


        try {

            // Google OAuth
            const oauth2Client =
                new google.auth.OAuth2(
                    process.env.GOOGLE_CLIENT_ID,
                    process.env.GOOGLE_CLIENT_SECRET,
                    process.env.GOOGLE_CALLBACK_URL ||
                    'http://localhost:3000/auth/google/callback'
                );


            oauth2Client.setCredentials({
                access_token:
                    req.user.accessToken,

                refresh_token:
                    req.user.refreshToken ||
                    undefined
            });


            const drive =
                google.drive({
                    version: 'v3',
                    auth: oauth2Client
                });


            // หา/สร้างโฟลเดอร์หมวด
            const folderId =
                await getUserCategoryFolder(
                    category,
                    drive
                );


            // Upload ไฟล์ต้นฉบับ
            const response =
                await drive.files.create({
                    resource: {
                        name:
                            pending.originalFileName,
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


            if (!userId) {
                throw new Error(
                    'ไม่พบ user_id ของผู้ใช้งาน'
                );
            }


            const selected =
                pending.categories.find(
                    item =>
                        item.name === category
                );


            const confidence =
                selected
                    ? Number(selected.percentage)
                    : null;


            // ==================================================
            // DATABASE TRANSACTION
            // ==================================================

            const connection =
                await db.getConnection();


            try {

                await connection.beginTransaction();


                await connection.execute(
    `INSERT INTO files
     (user_id, original_name, category, drive_file_id, created_at)
     VALUES (?, ?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 7 HOUR))`,
    [
        userId,
        pending.originalFileName,
        category,
        response.data.id
    ]
);

await connection.execute(
    `INSERT INTO logs
     (user_id, category, confidence, created_at)
     VALUES (?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 7 HOUR))`,
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


            cleanupFile(
                pending.filePath
            );

            pendingUploads.delete(
                uploadToken
            );


            res.json({
                success: true,
                category,
                confidence,
                driveFileId:
                    response.data.id,

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


// ======================================================
// CLEAN TEMP FILES
// ======================================================

setInterval(() => {

    const now = Date.now();

    for (
        const [token, pending]
        of pendingUploads
    ) {

        if (
            now - pending.createdAt >
            30 * 60 * 1000
        ) {

            cleanupFile(
                pending.filePath
            );

            pendingUploads.delete(
                token
            );
        }
    }

}, 5 * 60 * 1000).unref();


// ======================================================
// START SERVER
// ======================================================

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


        if (!users.length) {
            throw new Error(
                'ไม่พบตาราง users'
            );
        }

        if (!logs.length) {
            throw new Error(
                'ไม่พบตาราง logs'
            );
        }

        if (!files.length) {
            throw new Error(
                'ไม่พบตาราง files'
            );
        }


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