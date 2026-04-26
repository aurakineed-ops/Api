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
const jwt = require('jsonwebtoken');
const maxmind = require('maxmind');
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

// ========== GEOIP (optional) ==========
let geoipLookup = null;
if (fs.existsSync(process.env.GEOIP_DB_PATH)) {
    maxmind.open(process.env.GEOIP_DB_PATH).then(lookup => { geoipLookup = lookup; });
}

// ========== TELEGRAM ALERT ==========
async function sendTelegramAlert(message) {
    if (!process.env.TELEGRAM_BOT_TOKEN) return;
    try {
        await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: process.env.TELEGRAM_CHAT_ID,
            text: `🔔 OSINT Alert:\n${message}`
        });
    } catch(e) { console.error('Telegram alert failed', e.message); }
}

// ========== DATABASE SETUP (SQLITE) ==========
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const DB_PATH = path.join(dataDir, 'api_keys.db');
const db = new sqlite3.Database(DB_PATH);

db.serialize(() => {
    // Users (admins)
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        role TEXT,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // API keys (for developers)
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

    // Portal users (customers)
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

    // ========== CREATE ADMINS WITH CORRECT CREDENTIALS ==========
    // Head Admin: main / sahil
    db.get(`SELECT * FROM users WHERE username = 'main'`, [], (err, row) => {
        if (!row) {
            db.run(`INSERT INTO users (username, password, role, created_by) VALUES (?, ?, ?, ?)`, 
                ['main', bcrypt.hashSync('sahil', 10), 'head_admin', 'system']);
            console.log('✅ Head Admin Created: main / sahil');
        }
    });

    // Normal Admin: admin / admin123
    db.get(`SELECT * FROM users WHERE username = 'admin'`, [], (err, row) => {
        if (!row) {
            // Remove old superadmin if exists
            db.run(`DELETE FROM users WHERE username = 'superadmin'`);
            db.run(`INSERT INTO users (username, password, role, created_by) VALUES (?, ?, ?, ?)`, 
                ['admin', bcrypt.hashSync('admin123', 10), 'admin', 'main']);
            console.log('✅ Admin Created: admin / admin123');
        }
    });

    // Seed default APIs if empty
    db.get(`SELECT COUNT(*) as count FROM available_apis`, [], (err, row) => {
        if (row && row.count === 0) {
            const apis = [
                ['telegram', '📞 Telegram Number Lookup', '/api/v1/telegram', '{"id":"8489944328"}', '{"id":"8489944328"}', 'Get Telegram account details', 'phone'],
                ['email_info', '📧 Email to Info', '/api/v1/email', '{"email":"test@gmail.com"}', '{"email":"test@gmail.com"}', 'Email breach lookup', 'email'],
                ['family', '👨‍👩‍👧‍👦 Family Tree', '/api/v1/family', '{"term":"701984830542"}', '{"term":"701984830542"}', 'Aadhar to family details', 'aadhar'],
                ['num_india', '🇮🇳 Indian Number', '/api/v1/num-india', '{"num":"9876543210"}', '{"num":"9876543210"}', 'Indian mobile details', 'phone'],
                ['aadhar_ration', '📋 Aadhar to Ration', '/api/v1/aadhar-ration', '{"aadhaar":"984154610245"}', '{"aadhaar":"984154610245"}', 'Aadhar to ration card', 'aadhar'],
                ['full_search', '🔎 Full Aadhar X-Ray', '/api/v1/full-search', '{"aadhar":"984154610245"}', '{"aadhar":"984154610245"}', 'Complete Aadhar search', 'aadhar'],
                ['pan_info', '📄 PAN Card Info', '/api/v1/pan', '{"pan":"AXDPR2606K"}', '{"pan":"AXDPR2606K"}', 'PAN card details', 'identity'],
                ['vehicle_info', '🚗 Vehicle Info', '/api/v1/vehicle', '{"vehicle":"HR26DA1337"}', '{"vehicle":"HR26DA1337"}', 'Vehicle registration', 'vehicle'],
                ['ip_info', '🌐 IP Geolocation', '/api/v1/ip', '{"ip":"8.8.8.8"}', '{"ip":"8.8.8.8"}', 'IP address location', 'network'],
                ['insta_info', '📸 Instagram Info', '/api/v1/insta', '{"username":"ankit.vaid"}', '{"username":"ankit.vaid"}', 'Instagram profile', 'social']
            ];
            apis.forEach(api => {
                db.run(`INSERT INTO available_apis (name, display_name, endpoint, required_params, example_params, description, category) VALUES (?,?,?,?,?,?,?)`, api);
            });
            console.log('✅ 10 Default APIs seeded');
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
async function getCountryFromIP(ip) {
    if (!geoipLookup) return null;
    try {
        const result = geoipLookup.get(ip);
        return result?.country?.isoCode || null;
    } catch { return null; }
}

async function detectAnomaly(keyData) {
    const now = new Date();
    const minuteAgo = new Date(now.getTime() - 60 * 1000).toISOString();
    return new Promise((resolve) => {
        db.get(`SELECT COUNT(*) as cnt FROM analytics WHERE api_key = ? AND timestamp > ?`, [keyData.key, minuteAgo], (err, row) => {
            const allowed = keyData.rate_limit_per_minute || 5;
            if (row && row.cnt > allowed * 5) {
                db.run(`UPDATE api_keys SET status = 'suspended_anomaly' WHERE id = ?`, [keyData.id]);
                sendTelegramAlert(`🚨 Anomaly on key ${keyData.key}: ${row.cnt} requests/min (limit ${allowed})`);
                resolve(true);
            } else resolve(false);
        });
    });
}

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

// ========== API PROXY MAP ==========
const apiProxyMap = {
    'telegram': (p) => `https://cyber-osint-tg-num.vercel.app/api/tginfo?key=${MASTER_KEYS.rogers}&id=${p.id}`,
    'email': (p) => `https://leak-api-xtradeep.ramaxinfo.workers.dev/?email=${p.email}`,
    'family': (p) => `https://aadhar-2-ration.noobgamingv40.workers.dev/api/aadhaar?id=${p.term}`,
    'num-india': (p) => `https://ft-osint-api.duckdns.org/api/number?key=${MASTER_KEYS.ftosint}&num=${p.num}`,
    'aadhar-ration': (p) => `https://aadhar-x-ray.onrender.com/full-search?aadhaar=${p.aadhaar}`,
    'full-search': (p) => `https://aadhar-x-ray.onrender.com/full-search?aadhaar=${p.aadhar}`,
    'pan': (p) => `https://ft-osint-api.duckdns.org/api/pan?key=${MASTER_KEYS.ftosint}&pan=${p.pan}`,
    'vehicle': (p) => `https://ft-osint-api.duckdns.org/api/vehicle?key=${MASTER_KEYS.ftosint}&vehicle=${p.vehicle}`,
    'ip': (p) => `https://ft-osint-api.duckdns.org/api/ip?key=${MASTER_KEYS.ftosint}&ip=${p.ip}`,
    'insta': (p) => `https://ft-osint-api.duckdns.org/api/insta?key=${MASTER_KEYS.ftosint}&username=${p.username}`
};

function cleanResponseData(data) {
    if (!data || typeof data !== 'object') return data;
    let cleaned = JSON.parse(JSON.stringify(data));
    const removeFields = ['Developer', 'DM TO BUY ACCESS', 'owner', 'xtradeep', 'Kon_Hu_Mai', 'channel', 'telegram', 'contact', 'instagram', 'twitter', 'fb', 'facebook', 'website', 'github', 'created_by', 'owner_username', 'owner_channel', 'credit', 'Credits', 'Credit', 'Source', 'source', 'provider', 'Provider', 'api_source', 'API_Source', 'TATANIUM_ANSH', 'superadmin'];
    function cleanObject(obj) {
        if (!obj || typeof obj !== 'object') return;
        for (let key in obj) {
            if (removeFields.includes(key.toLowerCase()) || removeFields.includes(key)) delete obj[key];
            else if (typeof obj[key] === 'string' && obj[key].includes('@') && !obj[key].includes('bmw_aura5') && !obj[key].includes('OSINT_ERA1')) delete obj[key];
            else if (typeof obj[key] === 'object') cleanObject(obj[key]);
        }
    }
    cleanObject(cleaned);
    cleaned.owner = '@bmw_aura5';
    cleaned.channel = '@OSINT_ERA1';
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

// ========== ROUTES ==========
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

// Add new API (Head Admin)
app.post('/head-admin/add-api', requireHeadAdmin, (req, res) => {
    const { name, display_name, endpoint, required_params, category } = req.body;
    if (!name || !endpoint) return res.json({ error: 'Name and endpoint required' });
    db.run(`INSERT INTO available_apis (name, display_name, endpoint, required_params, category) VALUES (?,?,?,?,?)`,
        [name, display_name, endpoint, required_params || '{}', category || 'general'], function(err) {
            res.json({ success: !err, error: err?.message });
        });
});

// Remove API (Head Admin)
app.post('/head-admin/remove-api', requireHeadAdmin, (req, res) => {
    db.run('DELETE FROM available_apis WHERE id = ?', [req.body.api_id], function(err) {
        res.json({ success: !err });
    });
});

// Update rate limits (Head Admin)
app.post('/head-admin/update-rate-limit', requireHeadAdmin, (req, res) => {
    const { key_id, unlimited_hits, rate_limit_enabled, rate_limit_per_day, rate_limit_per_hour, rate_limit_per_minute, max_total_hits } = req.body;
    const isUnlimited = unlimited_hits === 'true';
    db.run(`UPDATE api_keys SET unlimited_hits = ?, rate_limit_enabled = ?, rate_limit_per_day = ?, rate_limit_per_hour = ?, rate_limit_per_minute = ?, max_total_hits = ? WHERE id = ?`,
        [isUnlimited?1:0, isUnlimited?0:(rate_limit_enabled==='true'?1:0), rate_limit_per_day||100, rate_limit_per_hour||20, rate_limit_per_minute||5, max_total_hits||0, key_id],
        function(err) { res.json({ success: !err }); });
});

// Create admin user (Head Admin)
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

// Remove admin user (Head Admin)
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

// Generate API key (Admin)
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
            [apiKey, name, customer_name, app_name, '@bmw_aura5', '@OSINT_ERA1', expires_at, unlimited_hits==='true'?1:0, max_total_hits||0, JSON.stringify(allowed_apis==='all'?['all']:[allowed_apis]), rate_limit_per_day||100, rate_limit_per_hour||20, rate_limit_per_minute||5, JSON.stringify(ip_whitelist?.split(',').map(i=>i.trim())||[]), webhook_url, jwt_secret], 
            (err) => { 
                if(err) return res.status(500).send(err.message); 
                res.redirect('/admin/dashboard'); 
            });
});

// Delete API key (Admin)
app.post('/admin/delete-key', requireAuth, (req, res) => {
    db.run('DELETE FROM api_keys WHERE id = ?', [req.body.id], () => res.redirect('/admin/dashboard'));
});

// Toggle key status (Admin)
app.post('/admin/toggle-status', requireAuth, (req, res) => {
    db.run('UPDATE api_keys SET status = ? WHERE id = ?', [req.body.status === 'active' ? 'disabled' : 'active', req.body.id], () => res.redirect('/admin/dashboard'));
});

// ========== BULK API ENDPOINT ==========
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
            if (cached) { 
                results.push(cached); 
                continue; 
            }
            const proxyFn = apiProxyMap[reqItem.endpoint];
            if (!proxyFn) { 
                results.push({ error: 'Unknown endpoint' }); 
                continue; 
            }
            try {
                const url = proxyFn(reqItem.params);
                const response = await axios.get(url, { timeout: 10000 });
                const cleaned = cleanResponseData(response.data);
                apiCache.set(cacheKey, cleaned);
                results.push(cleaned);
            } catch(e) { 
                results.push({ error: e.message }); 
            }
        }
        db.run(`UPDATE api_keys SET hits = hits + ? WHERE id = ?`, [requests.length, keyData.id]);
        res.json({ bulk_results: results, total: results.length });
    });
});

// ========== MAIN VERSIONED API HANDLER ==========
app.all('/api/v1/:endpoint', globalLimiter, async (req, res) => {
    const userKey = req.query.key || req.body.key;
    const endpoint = req.params.endpoint;
    if (!userKey) return res.json({ error: 'API key required', contact: '@bmw_aura5' });

    db.get('SELECT * FROM api_keys WHERE key = ? AND status = "active"', [userKey], async (err, keyData) => {
        if (err || !keyData) return res.json({ error: 'Invalid API key', contact: '@bmw_aura5' });

        // Request signature verification
        if (!verifyRequestSignature(req, keyData)) return res.json({ error: 'Invalid request signature' });

        // Geo-IP (optional)
        const country = await getCountryFromIP(req.ip);
        
        // Anomaly detection
        await detectAnomaly(keyData);

        // Rate limit check
        const rateCheck = await checkRateLimit(userKey, keyData);
        if (!rateCheck.allowed) return res.json({ error: rateCheck.reason, contact: '@bmw_aura5' });

        // Check expiry
        if (keyData.expires_at && new Date(keyData.expires_at) < new Date()) {
            db.run('UPDATE api_keys SET status = "expired" WHERE id = ?', [keyData.id]);
            return res.json({ error: 'Key expired', contact: '@bmw_aura5' });
        }

        // Allowed APIs check
        let allowedApis = [];
        try { allowedApis = JSON.parse(keyData.allowed_apis || '[]'); } catch(e) { allowedApis = []; }
        if (!allowedApis.includes('all') && allowedApis.length > 0 && !allowedApis.includes(endpoint)) {
            return res.json({ error: 'Endpoint not allowed for this key' });
        }

        // IP whitelist
        let ipWhitelist = [];
        try { ipWhitelist = JSON.parse(keyData.ip_whitelist || '[]'); } catch(e) {}
        if (ipWhitelist.length > 0 && !ipWhitelist.includes(req.ip)) {
            return res.json({ error: 'IP not whitelisted', contact: '@bmw_aura5' });
        }

        // Cache check for GET
        const cacheKey = `${userKey}:${endpoint}:${JSON.stringify(req.query)}`;
        let cached = apiCache.get(cacheKey);
        if (cached && req.method === 'GET') {
            return res.json(cached);
        }

        const proxyFn = apiProxyMap[endpoint];
        if (!proxyFn) return res.json({ error: 'Unknown endpoint' });

        try {
            const targetUrl = proxyFn({ ...req.query, ...req.body });
            const response = await axios.get(targetUrl, { timeout: 30000 });
            let cleanedData = cleanResponseData(response.data);
            cleanedData.unlimited = keyData.unlimited_hits === 1;

            // Cache response
            apiCache.set(cacheKey, cleanedData);

            // Update hits and daily calls
            db.run(`UPDATE api_keys SET hits = hits + 1 WHERE id = ?`, [keyData.id]);
            db.run(`INSERT INTO daily_calls (api_key, date, calls) VALUES (?, date('now'), 1) ON CONFLICT(api_key, date) DO UPDATE SET calls = calls + 1`, [userKey]);

            // Record analytics
            db.run(`INSERT INTO analytics (api_key, endpoint, status_code, ip_address, country, response_time) VALUES (?,?,?,?,?,?)`,
                [userKey, endpoint, response.status, req.ip, country, Date.now()]);

            // Trigger webhook
            await triggerWebhook(userKey, endpoint, cleanedData);

            // Rate limit headers
            const remaining = keyData.rate_limit_per_day - (await getCount(userKey, new Date().toISOString().split('T')[0], null, null));
            res.set('X-RateLimit-Limit', keyData.rate_limit_per_day);
            res.set('X-RateLimit-Remaining', remaining > 0 ? remaining : 0);
            res.set('X-RateLimit-Reset', new Date().setHours(24,0,0,0));

            res.json(cleanedData);
        } catch (error) {
            db.run(`INSERT INTO analytics (api_key, endpoint, status_code, ip_address, country) VALUES (?,?,?,?,?)`,
                [userKey, endpoint, 500, req.ip, country]);
            res.json({ error: 'API request failed', details: error.message, contact: '@bmw_aura5' });
        }
    });
});

// API info endpoint
app.get('/api-info', (req, res) => {
    db.all('SELECT name, display_name, endpoint, required_params, description FROM available_apis WHERE is_active = 1', [], (err, apis) => {
        res.json({ 
            owner: '@bmw_aura5', 
            channel: '@OSINT_ERA1', 
            total_apis: apis?.length || 0, 
            apis: apis || [] 
        });
    });
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', owner: '@bmw_aura5', timestamp: new Date() }));

// ========== CRON JOBS ==========
cron.schedule('0 0 * * *', () => {
    console.log('🔄 Daily reset running...');
    db.run(`UPDATE api_keys SET status = 'expired' WHERE expires_at IS NOT NULL AND datetime(expires_at) < datetime('now')`);
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    db.run(`DELETE FROM rate_limit_tracking WHERE date < ?`, [sevenDaysAgo.toISOString().split('T')[0]]);
});

// ========== START SERVER ==========
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n🚀 OSINT API HUB RUNNING`);
    console.log(`📍 http://localhost:${PORT}`);
    console.log(`=====================================`);
    console.log(`👑 HEAD ADMIN: main / sahil`);
    console.log(`🔐 ADMIN: admin / admin123`);
    console.log(`=====================================`);
    console.log(`✅ Owner: @bmw_aura5 | Channel: @OSINT_ERA1`);
    console.log(`✅ Head Admin can add/remove APIs dynamically`);
    console.log(`✅ WebSocket live dashboard at ws://localhost:${PORT}/live`);
    console.log(`✅ API Base URL: http://localhost:${PORT}/api/v1/`);
    console.log(`=====================================\n`);
});

module.exports = app;
