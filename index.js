const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { query, validationResult } = require('express-validator');
const NodeCache = require('node-cache');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// ===== 1. TRUST PROXY (for Render deployment) =====
app.set('trust proxy', 1);

// ===== 2. DISABLE EXPRESS FINGERPRINTING =====
app.disable('x-powered-by');

// ===== 3. CONFIGURATION =====
const EXTERNAL_API = process.env.EXTERNAL_API || 'https://music-api--s1fuh4x.replit.app';
const VALID_API_KEYS = [
    process.env.API_KEY_1,
    process.env.API_KEY_2
].filter(key => key);

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS 
    ? process.env.ALLOWED_ORIGINS.split(',')
    : ['https://searchmusic.gt.tc'];

const ALLOWED_DOMAINS = [
    'youtube.com',
    'www.youtube.com',
    'youtu.be'
];

// ===== 4. CACHE SETUP =====
const cache = new NodeCache({ 
    stdTTL: parseInt(process.env.CACHE_TTL) || 300,
    checkperiod: 120
});

// ===== 5. HELMET - Security Headers =====
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "data:", "https:"],
        },
    },
    crossOriginEmbedderPolicy: true,
    crossOriginOpenerPolicy: true,
    crossOriginResourcePolicy: { policy: "same-site" },
    dnsPrefetchControl: true,
    frameguard: { action: "deny" },
    hidePoweredBy: true,
    hsts: true,
    ieNoOpen: true,
    noSniff: true,
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    xssFilter: true,
}));

// ===== 6. CORS - Strict Configuration =====
app.use(cors({
    origin: function (origin, callback) {
        if (!origin) {
            return callback(null, true);
        }
        
        if (ALLOWED_ORIGINS.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            console.log(`🚫 BAWAL YAN origin: ${origin}`);
            callback(new Error(`Origin not allowed`));
        }
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'x-api-key'],
    exposedHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
    credentials: true,
    maxAge: 86400
}));

// ===== 7. REQUEST SIZE LIMIT =====
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));
app.use(express.static('public'));

// ===== 8. REQUEST TIMEOUT PROTECTION =====
app.use((req, res, next) => {
    const timeout = parseInt(process.env.REQUEST_TIMEOUT) || 30000;
    res.setTimeout(timeout, () => {
        res.status(408).json({
            success: false,
            error: 'Request timeout'
        });
    });
    next();
});

// ===== 9. API KEY VALIDATION =====
const validateApiKey = (req, res, next) => {
    const apiKey = req.headers['x-api-key'] || req.headers['authorization'];
    
    if (!apiKey) {
        console.log(`🔑 [SECURITY] No API key provided - IP: ${req.ip}`);
        return res.status(401).json({
            success: false,
            error: 'API key required'
        });
    }

    const cleanKey = apiKey.replace(/^Bearer\s+/i, '');
    
    if (!VALID_API_KEYS.includes(cleanKey)) {
        console.log(`🔑 [SECURITY] Invalid API key attempt - IP: ${req.ip}`);
        return res.status(403).json({
            success: false,
            error: 'Invalid API key'
        });
    }

    next();
};

// ===== 10. RATE LIMITERS =====

// Search limiter: 50 requests per minute
const searchLimiter = rateLimit({
    windowMs: parseInt(process.env.SEARCH_RATE_LIMIT_WINDOW) * 1000 || 60000,
    max: parseInt(process.env.SEARCH_RATE_LIMIT_MAX) || 50,
    message: {
        success: false,
        error: 'Rate limit exceeded'
    },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        const apiKey = req.headers['x-api-key'] || req.headers['authorization'];
        const cleanKey = apiKey ? apiKey.replace(/^Bearer\s+/i, '') : 'unknown';
        return `${req.ip}:${cleanKey}`;
    },
    handler: (req, res) => {
        console.log(`⏱️ [SECURITY] Search rate limit exceeded - IP: ${req.ip}`);
        res.status(429).json({
            success: false,
            error: 'Rate limit exceeded'
        });
    }
});

// Download limiter: 10 requests per minute
const downloadLimiter = rateLimit({
    windowMs: parseInt(process.env.DOWNLOAD_RATE_LIMIT_WINDOW) * 1000 || 60000,
    max: parseInt(process.env.DOWNLOAD_RATE_LIMIT_MAX) || 10,
    message: {
        success: false,
        error: 'Rate limit exceeded'
    },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        const apiKey = req.headers['x-api-key'] || req.headers['authorization'];
        const cleanKey = apiKey ? apiKey.replace(/^Bearer\s+/i, '') : 'unknown';
        return `${req.ip}:${cleanKey}`;
    },
    handler: (req, res) => {
        console.log(`⏱️ [SECURITY] Download rate limit exceeded - IP: ${req.ip}`);
        res.status(429).json({
            success: false,
            error: 'Rate limit exceeded'
        });
    }
});

// ===== 11. REFERER VALIDATION =====
const validateReferer = (req, res, next) => {
    if (req.path === '/api/health' || req.path === '/api/status') {
        return next();
    }

    const referer = req.headers.referer || req.headers.referrer || '';
    
    const apiKey = req.headers['x-api-key'] || req.headers['authorization'];
    if (apiKey) {
        const cleanKey = apiKey.replace(/^Bearer\s+/i, '');
        if (VALID_API_KEYS.includes(cleanKey)) {
            return next();
        }
    }

    const isAllowed = ALLOWED_ORIGINS.some(origin => {
        return referer.startsWith(origin) || referer.startsWith(origin + '/');
    });

    if (!isAllowed && referer) {
        console.log(`🚫 [SECURITY] BLOCKED referer: ${referer} - IP: ${req.ip}`);
        return res.status(403).json({
            success: false,
            error: 'Access denied'
        });
    }

    next();
};

// ===== 12. URL DOMAIN VALIDATION =====
const isValidDomain = (url) => {
    try {
        const parsedUrl = new URL(url);
        const hostname = parsedUrl.hostname.toLowerCase();
        return ALLOWED_DOMAINS.some(domain => hostname === domain || hostname.endsWith(`.${domain}`));
    } catch {
        return false;
    }
};

// ===== 13. LOGGING MIDDLEWARE =====
app.use((req, res, next) => {
    const origin = req.headers.origin || 'unknown';
    const apiKey = req.headers['x-api-key'] ? '[PRESENT]' : 'none';
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} - Origin: ${origin} - IP: ${req.ip}`);
    next();
});

// ===== 14. REQUEST VALIDATION =====
const validateSearch = [
    query('q').notEmpty().withMessage('Search query required').isString().trim().escape(),
    query('limit').optional().isInt({ min: 1, max: 50 }).withMessage('Limit must be between 1 and 50')
];

const validateDownload = [
    query('url').notEmpty().withMessage('URL required').isURL().withMessage('Invalid URL format'),
    query('quality').optional().isIn(['128', '192', '320']).withMessage('Quality must be 128, 192, or 320')
];

// ===== 15. APPLY MIDDLEWARE =====
app.use('/api', validateApiKey);
app.use('/api', validateReferer);

// ===== 16. API ROUTES =====

// Search Endpoint with Caching
app.get('/api/music/search', searchLimiter, validateSearch, async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                errors: errors.array()
            });
        }

        const { q, limit = 12 } = req.query;
        const cacheKey = `search:${q}:${limit}`;
        
        // Check cache
        const cachedResult = cache.get(cacheKey);
        if (cachedResult) {
            console.log(`📦 Cache hit: "${q}"`);
            return res.json(cachedResult);
        }

        console.log(`🔍 Searching: "${q}" (limit: ${limit})`);

        const response = await axios.get(`${EXTERNAL_API}/api/music/search`, {
            params: {
                q: q,
                limit: parseInt(limit)
            },
            timeout: 30000
        });

        // Cache the result
        cache.set(cacheKey, response.data);
        console.log(`💾 Cached: "${q}"`);

        res.json(response.data);

    } catch (error) {
        console.error('Search error:', error.message);
        
        if (error.response) {
            res.status(error.response.status).json({
                success: false,
                error: 'External API error'
            });
        } else if (error.request) {
            res.status(503).json({
                success: false,
                error: 'Service unavailable'
            });
        } else {
            res.status(500).json({
                success: false,
                error: 'Internal server error'
            });
        }
    }
});

// Download Endpoint with Domain Validation
app.get('/api/music/download', downloadLimiter, validateDownload, async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                errors: errors.array()
            });
        }

        const { url, quality = '320' } = req.query;

        // Validate domain
        if (!isValidDomain(url)) {
            console.log(`🚫 [SECURITY] Invalid domain: ${url} - IP: ${req.ip}`);
            return res.status(400).json({
                success: false,
                error: 'Invalid URL domain'
            });
        }

        console.log(`⬇️ Downloading: ${url} (quality: ${quality})`);

        const response = await axios.get(`${EXTERNAL_API}/api/music/download`, {
            params: {
                url: url,
                quality: quality
            },
            responseType: 'arraybuffer',
            timeout: 60000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        const contentType = response.headers['content-type'] || 'audio/mpeg';
        
        res.set({
            'Content-Type': contentType,
            'Content-Length': response.data.length,
            'Cache-Control': 'public, max-age=3600'
        });

        if (contentType.includes('application/json')) {
            const jsonData = JSON.parse(response.data.toString());
            if (jsonData.error || !jsonData.success) {
                return res.status(400).json({
                    success: false,
                    error: 'External API error'
                });
            }
        }

        res.send(response.data);

    } catch (error) {
        console.error('Download error:', error.message);
        
        if (error.response) {
            if (error.response.status === 404) {
                res.status(404).json({
                    success: false,
                    error: 'Audio not found'
                });
            } else if (error.response.status === 503) {
                res.status(503).json({
                    success: false,
                    error: 'Service unavailable'
                });
            } else {
                res.status(error.response.status).json({
                    success: false,
                    error: 'External API error'
                });
            }
        } else if (error.code === 'ECONNABORTED') {
            res.status(504).json({
                success: false,
                error: 'Request timeout'
            });
        } else {
            res.status(500).json({
                success: false,
                error: 'Internal server error'
            });
        }
    }
});

// ===== 17. PUBLIC ENDPOINTS (Minimal Information) =====

// Health Check - Minimal
app.get('/api/health', async (req, res) => {
    try {
        await axios.get(`${EXTERNAL_API}/api/health`, { timeout: 5000 });
        res.json({ success: true, status: 'online' });
    } catch (error) {
        res.json({ success: true, status: 'online' });
    }
});

// Status - Minimal
app.get('/api/status', (req, res) => {
    res.json({ success: true, status: 'online' });
});

// ===== 18. ROOT ENDPOINT =====
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ===== 19. 404 HANDLER =====
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Not found'
    });
});

// ===== 20. ERROR HANDLER =====
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    
    if (err.message && err.message.includes('Origin')) {
        console.log(`🚫 [SECURITY] CORS error - IP: ${req.ip}`);
        return res.status(403).json({
            success: false,
            error: 'Access denied'
        });
    }
    
    res.status(500).json({
        success: false,
        error: 'Internal server error'
    });
});

// ===== 21. CACHE CLEANUP =====
setInterval(() => {
    const stats = cache.getStats();
    console.log(`📊 Cache stats: ${stats.keys} keys, hits: ${stats.hits}, misses: ${stats.misses}`);
}, 300000); // Every 5 minutes

// ===== 22. START SERVER =====
app.listen(PORT, () => {
    console.log('========================================');
    console.log('🔒 JAY MUSIC API - Secure Proxy Server');
    console.log('========================================');
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📡 External API: ${EXTERNAL_API}`);
    console.log('========================================');
    console.log('🔐 SECURITY FEATURES:');
    console.log(`✅ CORS: Restricted to ${ALLOWED_ORIGINS.length} origins`);
    console.log(`✅ API Keys: ${VALID_API_KEYS.length} active keys`);
    console.log(`✅ Search Rate Limit: ${process.env.SEARCH_RATE_LIMIT_MAX || 50}/min`);
    console.log(`✅ Download Rate Limit: ${process.env.DOWNLOAD_RATE_LIMIT_MAX || 10}/min`);
    console.log(`✅ Referer Validation: Enabled`);
    console.log(`✅ Domain Restriction: ${ALLOWED_DOMAINS.join(', ')}`);
    console.log(`✅ Search Caching: ${process.env.CACHE_TTL || 300}s TTL`);
    console.log(`✅ Request Timeout: ${process.env.REQUEST_TIMEOUT || 30000}ms`);
    console.log('========================================');
});
