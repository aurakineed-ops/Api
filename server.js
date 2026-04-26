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
const app = express();

// ========== MASTER API KEYS ==========
const MASTER_KEYS = {
    subhxco: 'RACKSUN',
    ftosint: 'sahil-newww',
    ayaanmods: 'annonymousai',
    truecallerLeak: 'RATELIMITE-BEIBBkim7bjTAkJIZTIUGPR4FkfNAYoj',
    mistral: 'FVKec5Xqa2ORzSoBrqi21nRbIM6rFk2q',
    rogers: 'Rogers2'
};

// ========== DATABASE SETUP ==========
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

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
        owner_username TEXT,
        owner_channel TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME,
        hits INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active',
        unlimited_hits BOOLEAN DEFAULT 0,
        allowed_apis TEXT DEFAULT '[]',
        is_custom BOOLEAN DEFAULT 0,
        rate_limit_enabled BOOLEAN DEFAULT 1,
        rate_limit_per_day INTEGER DEFAULT 100,
        rate_limit_per_hour INTEGER DEFAULT 20,
        rate_limit_per_minute INTEGER DEFAULT 5
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
        date DATE DEFAULT CURRENT_DATE
    )`);

    // Daily calls
    db.run(`CREATE TABLE IF NOT EXISTS daily_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        api_key TEXT,
        date DATE,
        calls INTEGER DEFAULT 0,
        UNIQUE(api_key, date)
    )`);

    // API status
    db.run(`CREATE TABLE IF NOT EXISTS api_status (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        endpoint_name TEXT,
        is_up BOOLEAN DEFAULT 1,
        last_checked DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Available APIs
    db.run(`CREATE TABLE IF NOT EXISTS available_apis (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        display_name TEXT,
        endpoint TEXT,
        required_params TEXT,
        example_params TEXT,
        description TEXT,
        is_active BOOLEAN DEFAULT 1
    )`);

    // ========== CREATE HEAD ADMIN (main / sahil) ==========
    db.get(`SELECT * FROM users WHERE username = 'main'`, [], (err, row) => {
        if (!row) {
            const headAdminPassword = bcrypt.hashSync('sahil', 10);
            db.run(`INSERT INTO users (username, password, role, created_by) VALUES (?, ?, ?, ?)`, 
                ['main', headAdminPassword, 'head_admin', 'system']);
            console.log('✅ Head Admin created: main / sahil');
        }
    });

    // ========== CREATE NORMAL ADMIN (admin / aura@1234) ==========
    db.get(`SELECT * FROM users WHERE username = 'admin'`, [], (err, row) => {
        if (!row) {
            const adminPassword = bcrypt.hashSync('aura@1234', 10);
            db.run(`INSERT INTO users (username, password, role, created_by) VALUES (?, ?, ?, ?)`, 
                ['admin', adminPassword, 'admin', 'main']);
            console.log('✅ Normal Admin created: admin / aura@1234');
        }
    });

    // Insert APIs if empty
    db.get(`SELECT COUNT(*) as count FROM available_apis`, [], (err, row) => {
        if (row && row.count === 0) {
            const apis = [
                ['telegram', '📞 Telegram Number Lookup', '/api/telegram', 'id', '{"id":"8489944328"}', 'Get Telegram account details'],
                ['email_info', '📧 Email to Info', '/api/email', 'email', '{"email":"test@gmail.com"}', 'Email information'],
                ['family', '👨‍👩‍👧‍👦 Family Tree', '/api/family', 'term', '{"term":"979607168114"}', 'Family relationship lookup'],
                ['num_india', '🇮🇳 Indian Number Info', '/api/num-india', 'num', '{"num":"9876543210"}', 'Indian mobile number details'],
                ['num_pak', '🇵🇰 Pakistani Number', '/api/num-pak', 'number', '{"number":"03001234567"}', 'Pakistani mobile number'],
                ['name_details', '👤 Name to Details', '/api/name-details', 'name', '{"name":"abhiraaj"}', 'Name information'],
                ['bank_info', '🏦 Bank IFSC Info', '/api/bank', 'ifsc', '{"ifsc":"SBIN0001234"}', 'Bank branch details'],
                ['pan_info', '📄 PAN Card Info', '/api/pan', 'pan', '{"pan":"AXDPR2606K"}', 'PAN card details'],
                ['vehicle_info', '🚗 Vehicle Info', '/api/vehicle', 'vehicle', '{"vehicle":"HR26DA1337"}', 'Vehicle registration'],
                ['rc_info', '📋 RC Details', '/api/rc', 'owner', '{"owner":"HR26EV0001"}', 'Registration certificate'],
                ['ip_info', '🌐 IP Geolocation', '/api/ip', 'ip', '{"ip":"8.8.8.8"}', 'IP address location'],
                ['pincode_info', '📍 Pincode Info', '/api/pincode', 'pin', '{"pin":"110001"}', 'Area details'],
                ['git_info', '🐙 GitHub User', '/api/git', 'username', '{"username":"octocat"}', 'GitHub profile'],
                ['bgmi_info', '🎮 BGMI Player', '/api/bgmi', 'uid', '{"uid":"5121439477"}', 'BGMI player stats'],
                ['ff_info', '🔫 FreeFire ID', '/api/ff', 'uid', '{"uid":"123456789"}', 'FreeFire player'],
                ['aadhar_info', '🆔 Aadhar Info', '/api/aadhar', 'num', '{"num":"393933081942"}', 'Aadhar verification'],
                ['ai_image', '🎨 AI Image Gen', '/api/ai-image', 'prompt', '{"prompt":"cyberpunk cat"}', 'Generate AI images'],
                ['insta_info', '📸 Instagram Info', '/api/insta', 'username', '{"username":"ankit.vaid"}', 'Instagram profile'],
                ['num_fullinfo', '🔍 Number to Full Info', '/api/num-fullinfo', 'number', '{"number":"918887882236"}', 'Complete phone info'],
                ['mistral', '🤖 Mistral AI Chat', '/api/mistral', 'message', '{"message":"What is AI?"}', 'Chat with Mistral AI'],
                ['num_newinfo', '📱 Number to New Info', '/api/num-newinfo', 'id', '{"id":"8489944328"}', 'Telegram based number info'],
                ['veh_to_num', '🚗 Vehicle to Number', '/api/veh-to-num', 'term', '{"term":"UP50P5434"}', 'Vehicle to mobile number']
            ];
            
            apis.forEach(api => {
                db.run(`INSERT INTO available_apis (name, display_name, endpoint, required_params, example_params, description) VALUES (?, ?, ?, ?, ?, ?)`, api);
            });
            console.log('✅ 22 APIs inserted');
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

app.use(session({
    secret: 'osint_secret_2024',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

const globalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    keyGenerator: (req) => req.query.key || req.ip,
    handler: (req, res) => res.json({ error: 'Rate limit exceeded', contact: '@BMW_AURA5' })
});

function requireAuth(req, res, next) {
    if (!req.session.user) return res.redirect('/login');
    next();
}

// ONLY head_admin can access head admin routes
function requireHeadAdmin(req, res, next) {
    if (!req.session.user || req.session.user.role !== 'head_admin') {
        return res.status(403).json({ error: 'Access denied. Only Head Admin can access this.' });
    }
    next();
}

// ========== RATE LIMIT FUNCTION ==========
async function checkRateLimit(apiKey, keyData) {
    if (keyData.unlimited_hits === 1) {
        return { allowed: true, unlimited: true };
    }
    
    if (keyData.rate_limit_enabled !== 1) {
        return { allowed: true };
    }
    
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();
    
    if (keyData.rate_limit_per_minute > 0) {
        const minuteCount = await getCount(apiKey, today, currentHour, currentMinute);
        if (minuteCount >= keyData.rate_limit_per_minute) {
            return { allowed: false, reason: `Per minute limit: ${keyData.rate_limit_per_minute}` };
        }
    }
    
    if (keyData.rate_limit_per_hour > 0) {
        const hourCount = await getCount(apiKey, today, currentHour, null);
        if (hourCount >= keyData.rate_limit_per_hour) {
            return { allowed: false, reason: `Per hour limit: ${keyData.rate_limit_per_hour}` };
        }
    }
    
    if (keyData.rate_limit_per_day > 0) {
        const dayCount = await getCount(apiKey, today, null, null);
        if (dayCount >= keyData.rate_limit_per_day) {
            return { allowed: false, reason: `Per day limit: ${keyData.rate_limit_per_day}` };
        }
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
        
        if (hour !== null) {
            query += ` AND hour = ?`;
            params.push(hour);
        }
        if (minute !== null) {
            query += ` AND minute = ?`;
            params.push(minute);
        }
        
        db.get(query, params, (err, row) => {
            resolve(row ? (row.total || 0) : 0);
        });
    });
}

function incrementCount(apiKey, date, hour, minute) {
    return new Promise((resolve) => {
        const query = `INSERT INTO rate_limit_tracking (api_key, date, hour, minute, requests)
                       VALUES (?, ?, ?, ?, 1)`;
        const params = [apiKey, date, hour !== null ? hour : 0, minute !== null ? minute : 0];
        db.run(query, params, () => resolve());
    });
}

// ========== API PROXY MAP ==========
const apiProxyMap = {
    'telegram': (p) => `https://cyber-osint-tg-num.vercel.app/api/tginfo?key=${MASTER_KEYS.rogers}&id=${p.id || p.term || p.number}`,
    'email_info': (p) => `https://leak-api-xtradeep.ramaxinfo.workers.dev/?email=${p.email}`,
    'family': (p) => `https://ayaanmods.site/family.php?key=${MASTER_KEYS.subhxco}&term=${p.term}`,
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
    'mistral': `mistral-direct`,
    'num-newinfo': (p) => `https://cyber-osint-tg-num.vercel.app/api/tginfo?key=${MASTER_KEYS.rogers}&id=${p.id || p.number || p.term}`,
    'veh-to-num': (p) => `https://surya-veh-num-xmrewqs.ramaxinfo.workers.dev/?term=${p.term || p.vehicle || p.num}`
};

// ========== CLEAN RESPONSE - ONLY @BMW_AURA5 and @OSINT_ERA1 ==========
function cleanResponseData(data) {
    if (!data || typeof data !== 'object') return data;
    
    let cleaned = JSON.parse(JSON.stringify(data));
    
    // Remove all unwanted fields
    const removeFields = ['Developer', 'DM TO BUY ACCESS', 'owner', 'xtradeep', 'Kon_Hu_Mai', 'channel', 'telegram', 'contact', 'instagram', 'twitter', 'fb', 'facebook', 'website', 'github', 'created_by', 'owner_username', 'owner_channel', 'credit', 'Credits', 'Credit', 'Source', 'source', 'provider', 'Provider', 'api_source', 'API_Source'];
    
    function cleanObject(obj) {
        if (!obj || typeof obj !== 'object') return;
        for (let key in obj) {
            if (removeFields.includes(key.toLowerCase()) || removeFields.includes(key)) {
                delete obj[key];
            } 
            else if (typeof obj[key] === 'string') {
                if (obj[key].includes('@') && !obj[key].includes('BMW_AURA5') && !obj[key].includes('OSINT_ERA1')) {
                    delete obj[key];
                }
            }
            else if (typeof obj[key] === 'object') {
                cleanObject(obj[key]);
            }
        }
    }
    
    cleanObject(cleaned);
    
    // ONLY ADD THESE TWO
    cleaned.owner = '@BMW_AURA5';
    cleaned.channel = '@OSINT_ERA1';
    
    return cleaned;
}

// ========== PUBLIC ROUTES ==========
app.get('/', (req, res) => {
    db.get('SELECT COUNT(*) as total_apis FROM available_apis', [], (err, apisCount) => {
        const totalApis = (apisCount && apisCount.total_apis) ? apisCount.total_apis : 0;
        
        db.get('SELECT COUNT(*) as total_keys FROM api_keys', [], (err, keysCount) => {
            const totalKeys = (keysCount && keysCount.total_keys) ? keysCount.total_keys : 0;
            
            db.get('SELECT SUM(hits) as total_hits FROM api_keys', [], (err, hitsTotal) => {
                const totalHits = (hitsTotal && hitsTotal.total_hits) ? hitsTotal.total_hits : 0;
                
                res.render('index', { 
                    user: req.session.user || null,
                    totalApis: totalApis,
                    totalKeys: totalKeys,
                    totalHits: totalHits
                });
            });
        });
    });
});

app.get('/endpoints', (req, res) => {
    db.all('SELECT * FROM available_apis WHERE is_active = 1', [], (err, apis) => {
        const formattedApis = (apis || []).map(api => {
            let params = {};
            try {
                params = JSON.parse(api.required_params || '{}');
            } catch(e) {
                params = {};
            }
            const paramName = Object.keys(params)[0] || 'param';
            
            return {
                ...api,
                param_name: paramName,
                param_example: params[paramName] || 'value',
                full_url: `${api.endpoint}`,
                example_usage: `${api.endpoint}?key=YOUR_API_KEY&${paramName}=${params[paramName] || 'value'}`
            };
        });
        
        const statusMap = {};
        (apis || []).forEach(api => {
            statusMap[api.name] = true;
        });
        
        res.render('endpoints', { 
            apis: formattedApis, 
            baseUrl: req.protocol + '://' + req.get('host'),
            statusMap: statusMap
        });
    });
});

app.get('/docs', (req, res) => {
    db.all('SELECT * FROM available_apis WHERE is_active = 1', [], (err, apis) => {
        const formattedApis = (apis || []).map(api => {
            let params = {};
            try {
                params = JSON.parse(api.required_params || '{}');
            } catch(e) {
                params = {};
            }
            const paramName = Object.keys(params)[0] || 'param';
            
            return {
                ...api,
                param_name: paramName,
                param_example: params[paramName] || 'value',
                full_url: `${api.endpoint}`,
                example_usage: `${api.endpoint}?key=YOUR_API_KEY&${paramName}=${params[paramName] || 'value'}`
            };
        });
        
        const statusMap = {};
        (apis || []).forEach(api => {
            statusMap[api.name] = true;
        });
        
        res.render('docs', { 
            apis: formattedApis, 
            baseUrl: req.protocol + '://' + req.get('host'),
            statusMap: statusMap
        });
    });
});

app.get('/login', (req, res) => {
    res.render('login', { error: req.query.error || null });
});

// ========== LOGIN ROUTE ==========
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    
    if (!username || !password) {
        return res.redirect('/login?error=missing');
    }
    
    db.get('SELECT * FROM users WHERE username = ?', [username], async (err, user) => {
        if (err || !user) {
            return res.redirect('/login?error=invalid');
        }
        
        try {
            const match = await bcrypt.compare(password, user.password);
            if (match) {
                req.session.user = { 
                    id: user.id, 
                    username: user.username, 
                    role: user.role 
                };
                
                // head_admin goes to head admin dashboard
                if (user.role === 'head_admin') {
                    return res.redirect('/head-admin/dashboard');
                } 
                // normal admin goes to admin dashboard
                else if (user.role === 'admin') {
                    return res.redirect('/admin/dashboard');
                }
                else {
                    return res.redirect('/login?error=invalid');
                }
            } else {
                return res.redirect('/login?error=invalid');
            }
        } catch (bcryptError) {
            return res.redirect('/login?error=server_error');
        }
    });
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// ========== HEAD ADMIN DASHBOARD ==========
app.get('/head-admin/dashboard', requireHeadAdmin, (req, res) => {
    db.all('SELECT id, username, role, created_by, created_at FROM users WHERE role != "head_admin"', [], (err, admins) => {
        db.all('SELECT * FROM api_keys ORDER BY created_at DESC', [], (err, keys) => {
            db.get('SELECT SUM(hits) as total_hits FROM api_keys', [], (err, totalHits) => {
                const today = new Date().toISOString().split('T')[0];
                
                db.all('SELECT api_key, SUM(calls) as calls FROM daily_calls WHERE date = ? GROUP BY api_key', [today], (err, todayCallsData) => {
                    const todayCalls = {};
                    if (todayCallsData) {
                        todayCallsData.forEach(item => {
                            todayCalls[item.api_key] = item.calls;
                        });
                    }
                    
                    db.all(`
                        SELECT endpoint, COUNT(*) as count 
                        FROM analytics 
                        WHERE endpoint IS NOT NULL
                        GROUP BY endpoint 
                        ORDER BY count DESC 
                        LIMIT 10
                    `, [], (err, popular) => {
                        db.all(`
                            SELECT api_key, SUM(calls) as calls 
                            FROM daily_calls 
                            GROUP BY api_key 
                            ORDER BY calls DESC 
                            LIMIT 10
                        `, [], (err, topUsers) => {
                            res.render('head_admin_dashboard', {
                                user: req.session.user,
                                admins: admins || [],
                                keys: keys || [],
                                totalHits: (totalHits && totalHits.total_hits) ? totalHits.total_hits : 0,
                                popular: popular || [],
                                topUsers: topUsers || [],
                                todayCalls: todayCalls
                            });
                        });
                    });
                });
            });
        });
    });
});

app.post('/head-admin/update-rate-limit', requireHeadAdmin, (req, res) => {
    const { key_id, unlimited_hits, rate_limit_enabled, rate_limit_per_day, rate_limit_per_hour, rate_limit_per_minute } = req.body;
    
    const isUnlimited = unlimited_hits === 'true';
    
    db.run(`UPDATE api_keys 
            SET unlimited_hits = ?,
                rate_limit_enabled = ?,
                rate_limit_per_day = ?,
                rate_limit_per_hour = ?,
                rate_limit_per_minute = ?
            WHERE id = ?`,
            [isUnlimited ? 1 : 0, 
             isUnlimited ? 0 : (rate_limit_enabled === 'true' ? 1 : 0),
             rate_limit_per_day || 100,
             rate_limit_per_hour || 20,
             rate_limit_per_minute || 5,
             key_id],
            function(err) {
                if (err) {
                    return res.json({ error: err.message });
                }
                res.json({ success: true });
            });
});

app.post('/head-admin/create-admin', requireHeadAdmin, async (req, res) => {
    const { username, password, role } = req.body;
    
    if (!username || !password) {
        return res.json({ error: 'Username and password required' });
    }
    
    // Only allow creating 'admin' role, not head_admin
    const newRole = (role === 'head_admin') ? 'admin' : 'admin';
    
    db.get('SELECT id FROM users WHERE username = ?', [username], async (err, existing) => {
        if (existing) {
            return res.json({ error: 'Username already exists' });
        }
        
        const hashedPassword = await bcrypt.hash(password, 10);
        db.run(`INSERT INTO users (username, password, role, created_by) VALUES (?, ?, ?, ?)`,
            [username, hashedPassword, 'admin', req.session.user.username],
            function(err) {
                if (err) return res.json({ error: err.message });
                res.json({ success: true });
            });
    });
});

app.post('/head-admin/remove-admin', requireHeadAdmin, (req, res) => {
    const { admin_id } = req.body;
    // Don't allow deleting head_admin
    db.run('DELETE FROM users WHERE id = ? AND role = "admin"', [admin_id], function(err) {
        if (err) return res.json({ error: err.message });
        res.json({ success: true });
    });
});

// ========== NORMAL ADMIN DASHBOARD ==========
app.get('/admin/dashboard', requireAuth, (req, res) => {
    // If head_admin tries to access admin dashboard, redirect to head_admin dashboard
    if (req.session.user.role === 'head_admin') {
        return res.redirect('/head-admin/dashboard');
    }
    
    // Only allow normal admin
    if (req.session.user.role !== 'admin') {
        return res.status(403).send('Access denied');
    }
    
    db.all('SELECT * FROM api_keys ORDER BY created_at DESC', [], (err, keys) => {
        db.get('SELECT SUM(hits) as total FROM api_keys', [], (err, hits) => {
            db.get('SELECT COUNT(*) as active FROM api_keys WHERE status="active"', [], (err, active) => {
                db.all('SELECT * FROM available_apis WHERE is_active = 1', [], (err, apis) => {
                    const today = new Date().toISOString().split('T')[0];
                    
                    db.all('SELECT api_key, SUM(calls) as calls FROM daily_calls WHERE date = ? GROUP BY api_key', [today], (err, todayCallsData) => {
                        const todayCalls = {};
                        if (todayCallsData) {
                            todayCallsData.forEach(item => {
                                todayCalls[item.api_key] = item.calls;
                            });
                        }
                        
                        db.all(`
                            SELECT endpoint, COUNT(*) as count 
                            FROM analytics 
                            WHERE endpoint IS NOT NULL
                            GROUP BY endpoint 
                            ORDER BY count DESC 
                            LIMIT 10
                        `, [], (err, popular) => {
                            db.all(`
                                SELECT api_key, SUM(calls) as calls 
                                FROM daily_calls 
                                GROUP BY api_key 
                                ORDER BY calls DESC 
                                LIMIT 10
                            `, [], (err, topUsers) => {
                                const formattedApis = (apis || []).map(api => {
                                    let params = {};
                                    try {
                                        params = JSON.parse(api.required_params || '{}');
                                    } catch(e) {
                                        params = {};
                                    }
                                    const paramName = Object.keys(params)[0] || 'param';
                                    
                                    return {
                                        ...api,
                                        param_name: paramName,
                                        param_example: params[paramName] || 'value'
                                    };
                                });
                                
                                res.render('dashboard', { 
                                    keys: keys || [], 
                                    totalHits: (hits && hits.total) ? hits.total : 0,
                                    active: (active && active.active) ? active.active : 0,
                                    apis: formattedApis,
                                    popular: popular || [],
                                    topUsers: topUsers || [],
                                    todayCalls: todayCalls,
                                    user: req.session.user,
                                    baseUrl: req.protocol + '://' + req.get('host')
                                });
                            });
                        });
                    });
                });
            });
        });
    });
});

app.post('/admin/generate-key', requireAuth, (req, res) => {
    // Only normal admin can generate keys
    if (req.session.user.role !== 'admin') {
        return res.status(403).send('Access denied');
    }
    
    const { name, owner_username, owner_channel, expiry, unlimited_hits, allowed_apis, custom_key, enable_custom,
            rate_limit_enabled, rate_limit_per_day, rate_limit_per_hour, rate_limit_per_minute } = req.body;
    
    function createKey(apiKey, isCustom) {
        let expires_at = null;
        const now = new Date();
        
        if (expiry === '7d') expires_at = new Date(now.getTime() + (7 * 24 * 60 * 60 * 1000));
        else if (expiry === '15d') expires_at = new Date(now.getTime() + (15 * 24 * 60 * 60 * 1000));
        else if (expiry === '1m') expires_at = new Date(now.getTime() + (30 * 24 * 60 * 60 * 1000));
        else if (expiry === '1y') expires_at = new Date(now.getTime() + (365 * 24 * 60 * 60 * 1000));
        
        let allowedApisJson = allowed_apis === 'all' ? '["all"]' : JSON.stringify([allowed_apis]);
        
        const isUnlimited = unlimited_hits === 'true';
        const rateLimitEnabled = isUnlimited ? 0 : (rate_limit_enabled === 'true' ? 1 : 0);
        
        // Force owner to @BMW_AURA5 and channel to @OSINT_ERA1
        const finalOwner = '@BMW_AURA5';
        const finalChannel = '@OSINT_ERA1';
        
        db.run(`INSERT INTO api_keys (key, name, owner_username, owner_channel, expires_at, unlimited_hits, allowed_apis, status, is_custom,
                rate_limit_enabled, rate_limit_per_day, rate_limit_per_hour, rate_limit_per_minute)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`, 
                [apiKey, name, finalOwner, finalChannel, expires_at, 
                 isUnlimited ? 1 : 0, allowedApisJson, isCustom ? 1 : 0,
                 rateLimitEnabled,
                 isUnlimited ? 0 : (rate_limit_per_day || 100),
                 isUnlimited ? 0 : (rate_limit_per_hour || 20),
                 isUnlimited ? 0 : (rate_limit_per_minute || 5)], 
                function(err) {
                    if (err) {
                        return res.status(500).send('Error: ' + err.message);
                    }
                    res.redirect('/admin/dashboard');
                });
    }
    
    if (enable_custom === 'true' && custom_key && custom_key.trim() !== '') {
        let apiKey = custom_key.trim();
        if (apiKey.includes(' ') || apiKey.length < 5) {
            return res.status(400).send('Invalid custom key');
        }
        db.get('SELECT key FROM api_keys WHERE key = ?', [apiKey], (err, existing) => {
            if (existing) return res.status(400).send('Key already exists');
            createKey(apiKey, true);
        });
    } else {
        let apiKey = 'OSINT_' + Math.random().toString(36).substring(2, 18).toUpperCase();
        createKey(apiKey, false);
    }
});

app.post('/admin/delete-key', requireAuth, (req, res) => {
    if (req.session.user.role !== 'admin') {
        return res.status(403).send('Access denied');
    }
    db.run('DELETE FROM api_keys WHERE id = ?', [req.body.id]);
    res.redirect('/admin/dashboard');
});

app.post('/admin/toggle-status', requireAuth, (req, res) => {
    if (req.session.user.role !== 'admin') {
        return res.status(403).send('Access denied');
    }
    const { id, status } = req.body;
    db.run('UPDATE api_keys SET status = ? WHERE id = ?', [status === 'active' ? 'disabled' : 'active', id]);
    res.redirect('/admin/dashboard');
});

// ========== MISTRAL AI ==========
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

// ========== MAIN API HANDLER ==========
app.all('/api/:endpoint', globalLimiter, async (req, res) => {
    const userKey = req.query.key || req.body.key;
    const endpoint = req.params.endpoint;
    const today = new Date().toISOString().split('T')[0];
    const clientIp = req.ip || req.connection.remoteAddress;
    
    if (!userKey) {
        return res.json({ error: 'API key required', contact: '@BMW_AURA5' });
    }
    
    db.get('SELECT * FROM api_keys WHERE key = ? AND status = "active"', [userKey], async (err, keyData) => {
        if (err || !keyData) {
            return res.json({ error: 'Invalid API key', contact: '@BMW_AURA5' });
        }
        
        const rateCheck = await checkRateLimit(userKey, keyData);
        if (!rateCheck.allowed) {
            db.run(`INSERT INTO analytics (api_key, endpoint, status_code, ip_address, date) VALUES (?, ?, ?, ?, ?)`,
                [userKey, endpoint, 429, clientIp, today]);
            return res.json({ error: rateCheck.reason, contact: '@BMW_AURA5' });
        }
        
        if (keyData.expires_at && new Date(keyData.expires_at) < new Date()) {
            db.run('UPDATE api_keys SET status = "expired" WHERE id = ?', [keyData.id]);
            db.run(`INSERT INTO analytics (api_key, endpoint, status_code, ip_address, date) VALUES (?, ?, ?, ?, ?)`,
                [userKey, endpoint, 403, clientIp, today]);
            return res.json({ error: 'Key expired', contact: '@BMW_AURA5' });
        }
        
        let allowedApis = [];
        try { allowedApis = JSON.parse(keyData.allowed_apis || '[]'); } catch(e) { allowedApis = []; }
        if (!allowedApis.includes('all') && allowedApis.length > 0 && !allowedApis.includes(endpoint)) {
            db.run(`INSERT INTO analytics (api_key, endpoint, status_code, ip_address, date) VALUES (?, ?, ?, ?, ?)`,
                [userKey, endpoint, 403, clientIp, today]);
            return res.json({ error: 'Endpoint not allowed for this key' });
        }
        
        db.run('UPDATE api_keys SET hits = hits + 1 WHERE id = ?', [keyData.id]);
        db.run(`INSERT INTO daily_calls (api_key, date, calls) VALUES (?, ?, 1) 
                ON CONFLICT(api_key, date) DO UPDATE SET calls = calls + 1`, [userKey, today]);
        
        if (endpoint === 'mistral') {
            const message = req.query.message || req.body.message;
            if (!message) {
                db.run(`INSERT INTO analytics (api_key, endpoint, status_code, ip_address, date) VALUES (?, ?, ?, ?, ?)`,
                    [userKey, endpoint, 400, clientIp, today]);
                return res.json({ error: 'Message required' });
            }
            const result = await handleMistralAI(message);
            const cleanedResult = cleanResponseData(result);
            db.run(`INSERT INTO analytics (api_key, endpoint, status_code, ip_address, date) VALUES (?, ?, ?, ?, ?)`,
                [userKey, endpoint, result.success ? 200 : 500, clientIp, today]);
            return res.json(cleanedResult);
        }
        
        const proxyFn = apiProxyMap[endpoint];
        if (!proxyFn) {
            db.run(`INSERT INTO analytics (api_key, endpoint, status_code, ip_address, date) VALUES (?, ?, ?, ?, ?)`,
                [userKey, endpoint, 404, clientIp, today]);
            return res.json({ error: 'Unknown endpoint' });
        }
        
        try {
            const targetUrl = proxyFn({ ...req.query, ...req.body });
            const response = await axios.get(targetUrl, { timeout: 30000 });
            let cleanedData = cleanResponseData(response.data);
            cleanedData.unlimited = keyData.unlimited_hits === 1;
            
            db.run(`INSERT INTO analytics (api_key, endpoint, status_code, ip_address, date) VALUES (?, ?, ?, ?, ?)`,
                [userKey, endpoint, response.status, clientIp, today]);
            res.json(cleanedData);
        } catch (error) {
            db.run(`INSERT INTO analytics (api_key, endpoint, status_code, ip_address, date) VALUES (?, ?, ?, ?, ?)`,
                [userKey, endpoint, 500, clientIp, today]);
            res.json({ error: 'API request failed', details: error.message, contact: '@BMW_AURA5' });
        }
    });
});

// API info endpoint
app.get('/api-info', (req, res) => {
    db.all('SELECT name, display_name, endpoint, required_params, example_params, description FROM available_apis WHERE is_active = 1', [], (err, apis) => {
        res.json({
            owner: '@BMW_AURA5',
            channel: '@OSINT_ERA1',
            total_apis: (apis || []).length,
            apis: apis || []
        });
    });
});

// Test endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ========== ERROR HANDLING ==========
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Internal Server Error', message: err.message });
});

// ========== CRON JOBS ==========
cron.schedule('0 0 * * *', () => {
    console.log('🔄 Daily reset running...');
    db.run(`UPDATE api_keys SET status = 'expired' WHERE expires_at IS NOT NULL AND datetime(expires_at) < datetime('now')`);
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const dateStr = sevenDaysAgo.toISOString().split('T')[0];
    db.run(`DELETE FROM rate_limit_tracking WHERE date < ?`, [dateStr]);
});

// ========== START SERVER ==========
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log('\n🚀 OSINT API HUB RUNNING');
    console.log(`📍 http://localhost:${PORT}`);
    console.log('=====================================');
    console.log('👑 HEAD ADMIN LOGIN:');
    console.log('   Username: main');
    console.log('   Password: sahil');
    console.log('-------------------------------------');
    console.log('🔐 NORMAL ADMIN LOGIN:');
    console.log('   Username: admin');
    console.log('   Password: aura@1234');
    console.log('=====================================');
    console.log('✅ ONLY @BMW_AURA5 and @OSINT_ERA1 showing');
    console.log('✅ Health check: /health');
    console.log('=====================================\n');
});

module.exports = app;
