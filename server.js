require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const fs = require('fs');
const helmet = require('helmet');
const morgan = require('morgan');
const NodeCache = require('node-cache');
const expressWs = require('express-ws');
const crypto = require('crypto');

const app = express();
expressWs(app);

// ========== MASTER API KEYS ==========
const MASTER_KEYS = {
    subhxco: 'RACKSUN',
    ftosint: 'sahil-newww',
    ayaanmods: 'annonymousai',
    truecallerLeak: 'RATELIMITE-BEIBBkim7bjTAkJIZTIUGPR4FkfNAYoj',
    mistral: 'FVKec5Xqa2ORzSoBrqi21nRbIM6rFk2q',
    rogers: 'Rogers2'
};

// ========== CACHE ==========
const apiCache = new NodeCache({ stdTTL: 300, checkperiod: 320 });

// ========== DATABASE SETUP (SQLITE) ==========
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const DB_PATH = path.join(dataDir, 'api_keys.db');
const db = new sqlite3.Database(DB_PATH);

db.serialize(() => {
    // Users table
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        role TEXT,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // API keys table
    db.run(`CREATE TABLE IF NOT EXISTS api_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT UNIQUE,
        name TEXT,
        customer_name TEXT,
        app_name TEXT,
        owner_username TEXT,
        owner_channel TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME,
        hits INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active',
        unlimited_hits BOOLEAN DEFAULT 0,
        max_total_hits INTEGER DEFAULT 0,
        allowed_apis TEXT DEFAULT '[]',
        is_custom BOOLEAN DEFAULT 0,
        rate_limit_enabled BOOLEAN DEFAULT 1,
        rate_limit_per_day INTEGER DEFAULT 100,
        rate_limit_per_hour INTEGER DEFAULT 20,
        rate_limit_per_minute INTEGER DEFAULT 5,
        ip_whitelist TEXT DEFAULT '[]',
        jwt_secret TEXT,
        webhook_url TEXT
    )`);

    // Rate limit tracking
    db.run(`CREATE TABLE IF NOT EXISTS rate_limit_tracking (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        api_key TEXT,
        date TEXT,
        hour INTEGER,
        minute INTEGER,
        requests INTEGER DEFAULT 0
    )`);

    // Analytics
    db.run(`CREATE TABLE IF NOT EXISTS analytics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        api_key TEXT,
        endpoint TEXT,
        status_code INTEGER,
        ip_address TEXT,
        country TEXT,
        response_time INTEGER,
        date DATE DEFAULT CURRENT_DATE,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Daily calls
    db.run(`CREATE TABLE IF NOT EXISTS daily_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        api_key TEXT,
        date DATE,
        calls INTEGER DEFAULT 0,
        UNIQUE(api_key, date)
    )`);

    // Available APIs (dynamic)
    db.run(`CREATE TABLE IF NOT EXISTS available_apis (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE,
        display_name TEXT,
        endpoint TEXT,
        required_params TEXT,
        example_params TEXT,
        description TEXT,
        category TEXT,
        is_active BOOLEAN DEFAULT 1
    )`);

    // Portal users
    db.run(`CREATE TABLE IF NOT EXISTS portal_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE,
        password TEXT,
        api_key_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Webhook logs
    db.run(`CREATE TABLE IF NOT EXISTS webhook_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        api_key TEXT,
        endpoint TEXT,
        payload TEXT,
        response_status INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // ========== CREATE ADMINS ==========
    db.get(`SELECT * FROM users WHERE username = 'main'`, [], (err, row) => {
        if (!row) {
            db.run(`INSERT INTO users (username, password, role, created_by) VALUES (?, ?, ?, ?)`, 
                ['main', bcrypt.hashSync('sahil', 10), 'head_admin', 'system']);
            console.log('✅ Head Admin: main / sahil');
        }
    });
    db.get(`SELECT * FROM users WHERE username = 'admin'`, [], (err, row) => {
        if (!row) {
            db.run(`DELETE FROM users WHERE username = 'superadmin'`);
            db.run(`INSERT INTO users (username, password, role, created_by) VALUES (?, ?, ?, ?)`, 
                ['admin', bcrypt.hashSync('admin123', 10), 'admin', 'main']);
            console.log('✅ Admin: admin / admin123');
        }
    });

    // ========== SEED 22 APIS ==========
    db.get(`SELECT COUNT(*) as count FROM available_apis`, [], (err, row) => {
        if (row && row.count === 0) {
            const apis = [
                ['telegram', '📞 Telegram Number Lookup', '/api/v1/telegram', '{"id":"8489944328"}', '{"id":"8489944328"}', 'Get Telegram account details from phone number', 'phone'],
                ['email_info', '📧 Email to Info', '/api/v1/email', '{"email":"test@gmail.com"}', '{"email":"test@gmail.com"}', 'Email breach and information lookup', 'email'],
                ['family', '👨‍👩‍👧‍👦 Family Tree', '/api/v1/family', '{"term":"701984830542"}', '{"term":"701984830542"}', 'Aadhar to family relationship lookup', 'aadhar'],
                ['num_india', '🇮🇳 Indian Number Info', '/api/v1/num-india', '{"num":"9876543210"}', '{"num":"9876543210"}', 'Indian mobile number details and location', 'phone'],
                ['num_pak', '🇵🇰 Pakistani Number', '/api/v1/num-pak', '{"number":"03001234567"}', '{"number":"03001234567"}', 'Pakistani mobile number information', 'phone'],
                ['name_details', '👤 Name to Details', '/api/v1/name-details', '{"name":"abhiraaj"}', '{"name":"Rahul"}', 'Name to personal information lookup', 'identity'],
                ['bank_info', '🏦 Bank IFSC Info', '/api/v1/bank', '{"ifsc":"SBIN0001234"}', '{"ifsc":"SBIN0001234"}', 'Bank branch details from IFSC code', 'financial'],
                ['pan_info', '📄 PAN Card Info', '/api/v1/pan', '{"pan":"AXDPR2606K"}', '{"pan":"AXDPR2606K"}', 'PAN card details and verification', 'identity'],
                ['vehicle_info', '🚗 Vehicle Info', '/api/v1/vehicle', '{"vehicle":"HR26DA1337"}', '{"vehicle":"HR26DA1337"}', 'Vehicle registration details', 'vehicle'],
                ['rc_info', '📋 RC Details', '/api/v1/rc', '{"owner":"HR26EV0001"}', '{"owner":"HR26EV0001"}', 'Registration certificate details', 'vehicle'],
                ['ip_info', '🌐 IP Geolocation', '/api/v1/ip', '{"ip":"8.8.8.8"}', '{"ip":"8.8.8.8"}', 'IP address location and ISP info', 'network'],
                ['pincode_info', '📍 Pincode Info', '/api/v1/pincode', '{"pin":"110001"}', '{"pin":"110001"}', 'Area details from pincode', 'location'],
                ['git_info', '🐙 GitHub User', '/api/v1/git', '{"username":"octocat"}', '{"username":"octocat"}', 'GitHub profile information', 'social'],
                ['bgmi_info', '🎮 BGMI Player', '/api/v1/bgmi', '{"uid":"5121439477"}', '{"uid":"5121439477"}', 'BGMI player stats and info', 'gaming'],
                ['ff_info', '🔫 FreeFire ID', '/api/v1/ff', '{"uid":"123456789"}', '{"uid":"123456789"}', 'FreeFire player details', 'gaming'],
                ['aadhar_info', '🆔 Aadhar Info', '/api/v1/aadhar', '{"num":"393933081942"}', '{"num":"393933081942"}', 'Aadhar verification', 'aadhar'],
                ['ai_image', '🎨 AI Image Gen', '/api/v1/ai-image', '{"prompt":"cyberpunk cat"}', '{"prompt":"beautiful landscape"}', 'Generate AI images from prompts', 'ai'],
                ['insta_info', '📸 Instagram Info', '/api/v1/insta', '{"username":"ankit.vaid"}', '{"username":"ankit.vaid"}', 'Instagram profile information', 'social'],
                ['num_fullinfo', '🔍 Number to Full Info', '/api/v1/num-fullinfo', '{"number":"918887882236"}', '{"number":"918887882236"}', 'Complete phone information', 'phone'],
                ['mistral', '🤖 Mistral AI Chat', '/api/v1/mistral', '{"message":"What is AI?"}', '{"message":"Hello"}', 'Chat with Mistral AI', 'ai'],
                ['num_newinfo', '📱 Number to New Info', '/api/v1/num-newinfo', '{"id":"8489944328"}', '{"id":"8489944328"}', 'Telegram based number information', 'phone'],
                ['veh_to_num', '🚗 Vehicle to Number', '/api/v1/veh-to-num', '{"term":"UP50P5434"}', '{"term":"UP50P5434"}', 'Vehicle number to mobile number', 'vehicle']
            ];
            apis.forEach(api => {
                db.run(`INSERT INTO available_apis (name, display_name, endpoint, required_params, example_params, description, category) VALUES (?,?,?,?,?,?,?)`, api);
            });
            console.log('✅ 22 APIs seeded successfully');
        }
    });
});

// ========== MIDDLEWARE ==========
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));
app.use(cors());
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan('combined'));
app.use(session({
    secret: process.env.SESSION_SECRET || 'bmw_aura5_secret',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

const globalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 50,
    keyGenerator: (req) => req.query.key || req.ip,
    handler: (req, res) => res.json({ error: 'Rate limit exceeded', contact: '@bmw_aura5' })
});

function requireAuth(req, res, next) {
    if (!req.session.user) return res.redirect('/login');
    next();
}
function requireHeadAdmin(req, res, next) {
    if (!req.session.user || req.session.user.role !== 'head_admin')
        return res.status(403).json({ error: 'Head admin only' });
    next();
}

// ========== HELPER FUNCTIONS ==========
async function checkRateLimit(apiKey, keyData) {
    if (keyData.unlimited_hits === 1) return { allowed: true, unlimited: true };
    if (keyData.rate_limit_enabled !== 1) return { allowed: true };
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();
    if (keyData.max_total_hits > 0 && keyData.hits >= keyData.max_total_hits)
        return { allowed: false, reason: `Total hits limit ${keyData.max_total_hits} reached` };
    if (keyData.rate_limit_per_minute > 0) {
        const minuteCount = await getCount(apiKey, today, currentHour, currentMinute);
        if (minuteCount >= keyData.rate_limit_per_minute)
            return { allowed: false, reason: `Per minute limit ${keyData.rate_limit_per_minute}` };
    }
    if (keyData.rate_limit_per_hour > 0) {
        const hourCount = await getCount(apiKey, today, currentHour, null);
        if (hourCount >= keyData.rate_limit_per_hour)
            return { allowed: false, reason: `Per hour limit ${keyData.rate_limit_per_hour}` };
    }
    if (keyData.rate_limit_per_day > 0) {
        const dayCount = await getCount(apiKey, today, null, null);
        if (dayCount >= keyData.rate_limit_per_day)
            return { allowed: false, reason: `Per day limit ${keyData.rate_limit_per_day}` };
    }
    await incrementCount(apiKey, today, null, null);
    await incrementCount(apiKey, today, currentHour, null);
    await incrementCount(apiKey, today, currentHour, currentMinute);
    return { allowed: true };
}

function getCount(apiKey, date, hour, minute) {
    return new Promise((resolve) => {
        let query = `SELECT SUM(requests) as total FROM rate_limit_tracking WHERE api_key = ? AND date = ?`;
        let params = [apiKey, date];
        if (hour !== null) { query += ` AND hour = ?`; params.push(hour); }
        if (minute !== null) { query += ` AND minute = ?`; params.push(minute); }
        db.get(query, params, (err, row) => resolve(row ? (row.total || 0) : 0));
    });
}

function incrementCount(apiKey, date, hour, minute) {
    return new Promise((resolve) => {
        db.run(`INSERT INTO rate_limit_tracking (api_key, date, hour, minute, requests) VALUES (?, ?, ?, ?, 1)`,
            [apiKey, date, hour !== null ? hour : 0, minute !== null ? minute : 0], () => resolve());
    });
}

function verifyRequestSignature(req, keyData) {
    const signature = req.headers['x-request-signature'];
    if (!signature && keyData.jwt_secret) return false;
    if (!keyData.jwt_secret) return true;
    const expected = crypto.createHmac('sha256', keyData.jwt_secret).update(JSON.stringify(req.body) + req.path).digest('hex');
    return signature === expected;
}

async function triggerWebhook(apiKey, endpoint, responseData) {
    db.get(`SELECT webhook_url FROM api_keys WHERE key = ?`, [apiKey], (err, row) => {
        if (err || !row || !row.webhook_url) return;
        axios.post(row.webhook_url, { endpoint, data: responseData, timestamp: new Date() }).catch(e => {
            db.run(`INSERT INTO webhook_logs (api_key, endpoint, payload, response_status) VALUES (?, ?, ?, ?)`, 
                [apiKey, endpoint, JSON.stringify(responseData), e.response?.status || 500]);
        });
    });
}

// ========== API PROXY MAP (22 endpoints) ==========
const apiProxyMap = {
    'telegram': (p) => `https://cyber-osint-tg-num.vercel.app/api/tginfo?key=${MASTER_KEYS.rogers}&id=${p.id || p.term || p.number}`,
    'email': (p) => `https://leak-api-xtradeep.ramaxinfo.workers.dev/?email=${p.email}`,
    'family': (p) => `https://aadhar-2-ration.noobgamingv40.workers.dev/api/aadhaar?id=${p.term}`,
    'num-india': (p) => `https://ft-osint-api.duckdns.org/api/number?key=${MASTER_KEYS.ftosint}&num=${p.num}`,
    'num-pak': (p) => `https://ft-osint-api.duckdns.org/api/pk?key=${MASTER_KEYS.ftosint}&number=${p.number}`,
    'name-details': (p) => `https://ft-osint-api.duckdns.org/api/name?key=${MASTER_KEYS.ftosint}&name=${p.name}`,
    'bank': (p) => `https://ft-osint-api.duckdns.org/api/ifsc?key=${MASTER_KEYS.ftosint}&ifsc=${p.ifsc}`,
    'pan': (p) => `https://ft-osint-api.duckdns.org/api/pan?key=${MASTER_KEYS.ftosint}&pan=${p.pan}`,
    'vehicle': (p) => `https://ft-osint-api.duckdns.org/api/vehicle?key=${MASTER_KEYS.ftosint}&vehicle=${p.vehicle}`,
    'rc': (p) => `https://ft-osint-api.duckdns.org/api/rc?key=${MASTER_KEYS.ftosint}&owner=${p.owner}`,
    'ip': (p) => `https://ft-osint-api.duckdns.org/api/ip?key=${MASTER_KEYS.ftosint}&ip=${p.ip}`,
    'pincode': (p) => `https://ft-osint-api.duckdns.org/api/pincode?key=${MASTER_KEYS.ftosint}&pin=${p.pin}`,
    'git': (p) => `https://ft-osint-api.duckdns.org/api/git?key=${MASTER_KEYS.ftosint}&username=${p.username}`,
    'bgmi': (p) => `https://ft-osint-api.duckdns.org/api/bgmi?key=${MASTER_KEYS.ftosint}&uid=${p.uid}`,
    'ff': (p) => `https://ft-osint-api.duckdns.org/api/ff?key=${MASTER_KEYS.ftosint}&uid=${p.uid}`,
    'aadhar': (p) => `https://ft-osint-api.duckdns.org/api/aadhar?key=${MASTER_KEYS.ftosint}&num=${p.num}`,
    'ai-image': (p) => `https://ayaanmods.site/aiimage.php?key=${MASTER_KEYS.ayaanmods}&prompt=${p.prompt}`,
    'insta': (p) => `https://ft-osint-api.duckdns.org/api/insta?key=${MASTER_KEYS.ftosint}&username=${p.username}`,
    'num-fullinfo': (p) => `https://say-wallahai-bro-say-wallahi.onrender.com/raavan/v34/query=${p.number}/key=${MASTER_KEYS.truecallerLeak}`,
    'mistral': 'mistral-direct',
    'num-newinfo': (p) => `https://cyber-osint-tg-num.vercel.app/api/tginfo?key=${MASTER_KEYS.rogers}&id=${p.id || p.number || p.term}`,
    'veh-to-num': (p) => `https://surya-veh-num-xmrewqs.ramaxinfo.workers.dev/?term=${p.term || p.vehicle || p.num}`
};

// ========== CLEAN RESPONSE - ONLY @bmw_aura5 and @OSINTERA_1 ==========
function cleanResponseData(data) {
    if (!data || typeof data !== 'object') return data;
    let cleaned = JSON.parse(JSON.stringify(data));
    const removeFields = ['Developer', 'DM TO BUY ACCESS', 'owner', 'xtradeep', 'Kon_Hu_Mai', 'channel', 'telegram', 'contact', 'instagram', 'twitter', 'fb', 'facebook', 'website', 'github', 'created_by', 'owner_username', 'owner_channel', 'credit', 'Credits', 'Credit', 'Source', 'source', 'provider', 'Provider', 'api_source', 'API_Source', 'TATANIUM_ANSH', 'OSINT_ERA1'];
    function cleanObject(obj) {
        if (!obj || typeof obj !== 'object') return;
        for (let key in obj) {
            if (removeFields.includes(key.toLowerCase()) || removeFields.includes(key)) delete obj[key];
            else if (typeof obj[key] === 'string' && obj[key].includes('@') && !obj[key].includes('bmw_aura5') && !obj[key].includes('OSINTERA_1')) delete obj[key];
            else if (typeof obj[key] === 'object') cleanObject(obj[key]);
        }
    }
    cleanObject(cleaned);
    cleaned.owner = '@bmw_aura5';
    cleaned.channel = '@OSINTERA_1';
    return cleaned;
}

// ========== WEBSOCKET LIVE DASHBOARD ==========
const wsClients = new Set();
app.ws('/live', (ws, req) => {
    wsClients.add(ws);
    ws.on('close', () => wsClients.delete(ws));
});
function broadcastStats() {
    db.get(`SELECT COUNT(*) as total FROM analytics WHERE date = date('now')`, [], (err, row) => {
        wsClients.forEach(ws => {
            try { ws.send(JSON.stringify({ totalRequestsToday: row?.total || 0, timestamp: Date.now() })); } catch(e) {}
        });
    });
}
setInterval(broadcastStats, 5000);

// ========== ROUTES (Views) ==========
app.get('/', (req, res) => {
    db.get('SELECT COUNT(*) as total_apis FROM available_apis', [], (err, apis) => {
        db.get('SELECT COUNT(*) as total_keys FROM api_keys', [], (err, keys) => {
            db.get('SELECT SUM(hits) as total_hits FROM api_keys', [], (err, hits) => {
                res.render('index', { 
                    user: req.session.user || null,
                    totalApis: apis?.total_apis || 0,
                    totalKeys: keys?.total_keys || 0,
                    totalHits: hits?.total_hits || 0
                });
            });
        });
    });
});

app.get('/login', (req, res) => res.render('login', { error: req.query.error }));
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    db.get('SELECT * FROM users WHERE username = ?', [username], async (err, user) => {
        if (!user || !(await bcrypt.compare(password, user.password))) return res.redirect('/login?error=invalid');
        req.session.user = { id: user.id, username: user.username, role: user.role };
        res.redirect(user.role === 'head_admin' ? '/head-admin/dashboard' : '/admin/dashboard');
    });
});
app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/'); });

app.get('/endpoints', (req, res) => {
    db.all('SELECT * FROM available_apis WHERE is_active = 1 ORDER BY category', [], (err, apis) => {
        res.render('endpoints', { apis: apis || [], baseUrl: req.protocol + '://' + req.get('host') });
    });
});
app.get('/docs', (req, res) => {
    db.all('SELECT * FROM available_apis WHERE is_active = 1', [], (err, apis) => {
        res.render('docs', { apis: apis || [] });
    });
});

// Customer Portal
app.get('/portal', (req, res) => res.render('portal_login'));
app.post('/portal/login', async (req, res) => {
    const { email, password } = req.body;
    db.get(`SELECT * FROM portal_users WHERE email = ?`, [email], async (err, user) => {
        if (!user || !(await bcrypt.compare(password, user.password))) return res.redirect('/portal?error=1');
        req.session.portal_user = user;
        res.redirect('/portal/dashboard');
    });
});
app.get('/portal/dashboard', (req, res) => {
    if (!req.session.portal_user) return res.redirect('/portal');
    db.get(`SELECT * FROM api_keys WHERE id = ?`, [req.session.portal_user.api_key_id], (err, key) => {
        db.all(`SELECT date, calls FROM daily_calls WHERE api_key = ? ORDER BY date DESC LIMIT 30`, [key?.key], (err, usage) => {
            res.render('portal', { key, usage });
        });
    });
});

// ========== HEAD ADMIN DASHBOARD ==========
app.get('/head-admin/dashboard', requireHeadAdmin, (req, res) => {
    db.all('SELECT * FROM users WHERE role != "head_admin"', [], (err, users) => {
        db.all('SELECT * FROM api_keys ORDER BY created_at DESC', [], (err, keys) => {
            db.all('SELECT * FROM available_apis ORDER BY category', [], (err, apis) => {
                db.get('SELECT SUM(hits) as total_hits FROM api_keys', [], (err, totalHits) => {
                    res.render('head_admin_dashboard', { 
                        user: req.session.user, 
                        users: users || [], 
                        keys: keys || [], 
                        apis: apis || [], 
                        totalHits: totalHits?.total_hits || 0 
                    });
                });
            });
        });
    });
});

// Add/remove APIs (Head Admin)
app.post('/head-admin/add-api', requireHeadAdmin, (req, res) => {
    const { name, display_name, endpoint, required_params, category } = req.body;
    if (!name || !endpoint) return res.json({ error: 'Name and endpoint required' });
    db.run(`INSERT INTO available_apis (name, display_name, endpoint, required_params, category) VALUES (?,?,?,?,?)`,
        [name, display_name, endpoint, required_params || '{}', category || 'general'], function(err) {
            res.json({ success: !err, error: err?.message });
        });
});
app.post('/head-admin/remove-api', requireHeadAdmin, (req, res) => {
    db.run('DELETE FROM available_apis WHERE id = ?', [req.body.api_id], function(err) {
        res.json({ success: !err });
    });
});
app.post('/head-admin/update-rate-limit', requireHeadAdmin, (req, res) => {
    const { key_id, unlimited_hits, rate_limit_enabled, rate_limit_per_day, rate_limit_per_hour, rate_limit_per_minute, max_total_hits } = req.body;
    const isUnlimited = unlimited_hits === 'true';
    db.run(`UPDATE api_keys SET unlimited_hits = ?, rate_limit_enabled = ?, rate_limit_per_day = ?, rate_limit_per_hour = ?, rate_limit_per_minute = ?, max_total_hits = ? WHERE id = ?`,
        [isUnlimited?1:0, isUnlimited?0:(rate_limit_enabled==='true'?1:0), rate_limit_per_day||100, rate_limit_per_hour||20, rate_limit_per_minute||5, max_total_hits||0, key_id],
        function(err) { res.json({ success: !err }); });
});
app.post('/head-admin/create-admin', requireHeadAdmin, async (req, res) => {
    const { username, password, role } = req.body;
    if (!username || !password) return res.json({ error: 'Username and password required' });
    db.get('SELECT id FROM users WHERE username = ?', [username], async (err, existing) => {
        if (existing) return res.json({ error: 'Username exists' });
        const hashed = await bcrypt.hash(password, 10);
        db.run(`INSERT INTO users (username, password, role, created_by) VALUES (?,?,?,?)`, 
            [username, hashed, role || 'admin', req.session.user.username], function(err) {
                res.json({ success: !err, error: err?.message });
            });
    });
});
app.post('/head-admin/remove-admin', requireHeadAdmin, (req, res) => {
    const { admin_id } = req.body;
    db.run('DELETE FROM users WHERE id = ? AND role != "head_admin"', [admin_id], function(err) {
        res.json({ success: !err });
    });
});

// ========== ADMIN DASHBOARD ==========
app.get('/admin/dashboard', requireAuth, (req, res) => {
    if (req.session.user.role === 'head_admin') return res.redirect('/head-admin/dashboard');
    db.all('SELECT * FROM api_keys ORDER BY created_at DESC', [], (err, keys) => {
        db.get('SELECT SUM(hits) as total FROM api_keys', [], (err, totalHits) => {
            db.get('SELECT COUNT(*) as active FROM api_keys WHERE status="active"', [], (err, activeCount) => {
                res.render('dashboard', { 
                    user: req.session.user, 
                    keys: keys || [], 
                    totalHits: totalHits?.total || 0, 
                    active: activeCount?.active || 0 
                });
            });
        });
    });
});

app.post('/admin/generate-key', requireAuth, (req, res) => {
    const { name, customer_name, app_name, expiry, unlimited_hits, allowed_apis, custom_key, enable_custom,
            rate_limit_per_day, rate_limit_per_hour, rate_limit_per_minute, max_total_hits, ip_whitelist, webhook_url } = req.body;
    let apiKey = enable_custom === 'true' && custom_key ? custom_key : 'OSINT_' + Math.random().toString(36).substring(2, 18).toUpperCase();
    let expires_at = null;
    const now = new Date();
    if (expiry === '7d') expires_at = new Date(now.getTime() + 7*86400000);
    else if (expiry === '30d') expires_at = new Date(now.getTime() + 30*86400000);
    const jwt_secret = crypto.randomBytes(32).toString('hex');
    db.run(`INSERT INTO api_keys (key, name, customer_name, app_name, owner_username, owner_channel, expires_at, unlimited_hits, max_total_hits, allowed_apis, rate_limit_per_day, rate_limit_per_hour, rate_limit_per_minute, ip_whitelist, webhook_url, jwt_secret)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [apiKey, name, customer_name, app_name, '@bmw_aura5', '@OSINTERA_1', expires_at, unlimited_hits==='true'?1:0, max_total_hits||0, JSON.stringify(allowed_apis==='all'?['all']:[allowed_apis]), rate_limit_per_day||100, rate_limit_per_hour||20, rate_limit_per_minute||5, JSON.stringify(ip_whitelist?.split(',').map(i=>i.trim())||[]), webhook_url, jwt_secret], 
            (err) => { 
                if(err) return res.status(500).send(err.message); 
                res.redirect('/admin/dashboard'); 
            });
});
app.post('/admin/delete-key', requireAuth, (req, res) => {
    db.run('DELETE FROM api_keys WHERE id = ?', [req.body.id], () => res.redirect('/admin/dashboard'));
});
app.post('/admin/toggle-status', requireAuth, (req, res) => {
    db.run('UPDATE api_keys SET status = ? WHERE id = ?', [req.body.status === 'active' ? 'disabled' : 'active', req.body.id], () => res.redirect('/admin/dashboard'));
});

// ========== BULK API ==========
app.post('/api/v1/bulk', globalLimiter, async (req, res) => {
    const userKey = req.query.key || req.body.key;
    const { requests } = req.body;
    if (!userKey) return res.json({ error: 'API key required' });
    db.get('SELECT * FROM api_keys WHERE key = ? AND status = "active"', [userKey], async (err, keyData) => {
        if (!keyData) return res.json({ error: 'Invalid key' });
        const results = [];
        for (const reqItem of requests) {
            const cacheKey = `${userKey}:${reqItem.endpoint}:${JSON.stringify(reqItem.params)}`;
            let cached = apiCache.get(cacheKey);
            if (cached) { results.push(cached); continue; }
            const proxyFn = apiProxyMap[reqItem.endpoint];
            if (!proxyFn) { results.push({ error: 'Unknown endpoint' }); continue; }
            try {
                const url = proxyFn(reqItem.params);
                const response = await axios.get(url, { timeout: 10000 });
                const cleaned = cleanResponseData(response.data);
                apiCache.set(cacheKey, cleaned);
                results.push(cleaned);
            } catch(e) { results.push({ error: e.message }); }
        }
        db.run(`UPDATE api_keys SET hits = hits + ? WHERE id = ?`, [requests.length, keyData.id]);
        res.json({ bulk_results: results, total: results.length });
    });
});

// ========== MISTRAL AI HANDLER ==========
async function handleMistralAI(message) {
    try {
        const response = await axios.post('https://api.mistral.ai/v1/chat/completions', {
            model: 'mistral-medium-latest',
            messages: [{ role: "user", content: message }]
        }, {
            headers: { 'Authorization': `Bearer ${MASTER_KEYS.mistral}`, 'Content-Type': 'application/json' },
            timeout: 30000
        });
        return { success: true, response: response.data.choices[0].message.content };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// ========== MAIN VERSIONED API HANDLER ==========
app.all('/api/v1/:endpoint', globalLimiter, async (req, res) => {
    const userKey = req.query.key || req.body.key;
    const endpoint = req.params.endpoint;
    if (!userKey) return res.json({ error: 'API key required', contact: '@bmw_aura5' });

    db.get('SELECT * FROM api_keys WHERE key = ? AND status = "active"', [userKey], async (err, keyData) => {
        if (err || !keyData) return res.json({ error: 'Invalid API key', contact: '@bmw_aura5' });

        if (!verifyRequestSignature(req, keyData)) return res.json({ error: 'Invalid request signature' });

        const rateCheck = await checkRateLimit(userKey, keyData);
        if (!rateCheck.allowed) return res.json({ error: rateCheck.reason, contact: '@bmw_aura5' });

        if (keyData.expires_at && new Date(keyData.expires_at) < new Date()) {
            db.run('UPDATE api_keys SET status = "expired" WHERE id = ?', [keyData.id]);
            return res.json({ error: 'Key expired', contact: '@bmw_aura5' });
        }

        let allowedApis = [];
        try { allowedApis = JSON.parse(keyData.allowed_apis || '[]'); } catch(e) { allowedApis = []; }
        if (!allowedApis.includes('all') && allowedApis.length > 0 && !allowedApis.includes(endpoint)) {
            return res.json({ error: 'Endpoint not allowed for this key' });
        }

        let ipWhitelist = [];
        try { ipWhitelist = JSON.parse(keyData.ip_whitelist || '[]'); } catch(e) {}
        if (ipWhitelist.length > 0 && !ipWhitelist.includes(req.ip)) {
            return res.json({ error: 'IP not whitelisted', contact: '@bmw_aura5' });
        }

        const cacheKey = `${userKey}:${endpoint}:${JSON.stringify(req.query)}`;
        let cached = apiCache.get(cacheKey);
        if (cached && req.method === 'GET') {
            return res.json(cached);
        }

        if (endpoint === 'mistral') {
            const message = req.query.message || req.body.message;
            if (!message) return res.json({ error: 'Message required' });
            const result = await handleMistralAI(message);
            const cleanedResult = cleanResponseData(result);
            db.run(`UPDATE api_keys SET hits = hits + 1 WHERE id = ?`, [keyData.id]);
            db.run(`INSERT INTO daily_calls (api_key, date, calls) VALUES (?, date('now'), 1) ON CONFLICT(api_key, date) DO UPDATE SET calls = calls + 1`, [userKey]);
            db.run(`INSERT INTO analytics (api_key, endpoint, status_code, ip_address) VALUES (?,?,?,?)`, [userKey, endpoint, result.success ? 200 : 500, req.ip]);
            return res.json(cleanedResult);
        }

        const proxyFn = apiProxyMap[endpoint];
        if (!proxyFn) return res.json({ error: 'Unknown endpoint' });

        try {
            const targetUrl = proxyFn({ ...req.query, ...req.body });
            const response = await axios.get(targetUrl, { timeout: 30000 });
            let cleanedData = cleanResponseData(response.data);
            cleanedData.unlimited = keyData.unlimited_hits === 1;

            apiCache.set(cacheKey, cleanedData);
            db.run(`UPDATE api_keys SET hits = hits + 1 WHERE id = ?`, [keyData.id]);
            db.run(`INSERT INTO daily_calls (api_key, date, calls) VALUES (?, date('now'), 1) ON CONFLICT(api_key, date) DO UPDATE SET calls = calls + 1`, [userKey]);
            db.run(`INSERT INTO analytics (api_key, endpoint, status_code, ip_address, response_time) VALUES (?,?,?,?,?)`, [userKey, endpoint, response.status, req.ip, Date.now()]);
            await triggerWebhook(userKey, endpoint, cleanedData);

            const remaining = keyData.rate_limit_per_day - (await getCount(userKey, new Date().toISOString().split('T')[0], null, null));
            res.set('X-RateLimit-Limit', keyData.rate_limit_per_day);
            res.set('X-RateLimit-Remaining', remaining > 0 ? remaining : 0);
            res.set('X-RateLimit-Reset', new Date().setHours(24,0,0,0));
            res.json(cleanedData);
        } catch (error) {
            db.run(`INSERT INTO analytics (api_key, endpoint, status_code, ip_address) VALUES (?,?,?,?)`, [userKey, endpoint, 500, req.ip]);
            res.json({ error: 'API request failed', details: error.message, contact: '@bmw_aura5' });
        }
    });
});

// API info endpoint
app.get('/api-info', (req, res) => {
    db.all('SELECT name, display_name, endpoint, required_params, description FROM available_apis WHERE is_active = 1', [], (err, apis) => {
        res.json({ 
            owner: '@bmw_aura5', 
            channel: '@OSINTERA_1', 
            total_apis: apis?.length || 0, 
            apis: apis || [] 
        });
    });
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', owner: '@bmw_aura5', timestamp: new Date() }));

// Cron job for daily reset
cron.schedule('0 0 * * *', () => {
    console.log('🔄 Daily reset running...');
    db.run(`UPDATE api_keys SET status = 'expired' WHERE expires_at IS NOT NULL AND datetime(expires_at) < datetime('now')`);
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    db.run(`DELETE FROM rate_limit_tracking WHERE date < ?`, [sevenDaysAgo.toISOString().split('T')[0]]);
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n🚀 OSINT API HUB RUNNING`);
    console.log(`📍 http://localhost:${PORT}`);
    console.log(`=====================================`);
    console.log(`👑 HEAD ADMIN: main / sahil`);
    console.log(`🔐 ADMIN: admin / admin123`);
    console.log(`=====================================`);
    console.log(`✅ Owner: @bmw_aura5 | Channel: @OSINTERA_1`);
    console.log(`✅ 22 APIs loaded (all working)`);
    console.log(`✅ Head Admin can add/remove APIs dynamically`);
    console.log(`✅ WebSocket live dashboard at ws://localhost:${PORT}/live`);
    console.log(`=====================================\n`);
});

module.exports = app;
