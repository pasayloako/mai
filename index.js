const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { body, query, validationResult } = require('express-validator');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// ===== CONFIGURATION =====
const EXTERNAL_API = process.env.EXTERNAL_API || 'https://music-api--s1fuh4x.replit.app';
const VALID_API_KEYS = [
    process.env.API_KEY_1,
    process.env.API_KEY_2
].filter(key => key); // Remove undefined keys

// Allowed Origins from .env
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS 
    ? process.env.ALLOWED_ORIGINS.split(',')
    : ['https://searchmusic.gt.tc'];

// ===== 1. HELMET - Security Headers =====
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

// ===== 2. CORS - Strict Configuration =====
app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (like mobile apps or server-to-server)
        if (!origin) {
            return callback(null, true);
        }
        
        // Check if origin is allowed
        if (ALLOWED_ORIGINS.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            console.log(`🚫 BLOCKED CORS origin: ${origin}`);
            callback(new Error(`Origin ${origin} Bawal Ka gumamit ng API`));
        }
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'x-api-key'],
    exposedHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
    credentials: true,
    maxAge: 86400 // 24 hours
}));

// ===== 3. API KEY VALIDATION =====
const validateApiKey = (req, res, next) => {
    // Check for API key in headers (both formats)
    const apiKey = req.headers['x-api-key'] || req.headers['authorization'];
    
    if (!apiKey) {
        console.log(`🔑 No API key provided - IP: ${req.ip}`);
        return res.status(401).json({
            success: false,
            error: 'API key required',
            message: 'Please provide a valid API key in the x-api-key header'
        });
    }

    // Remove 'Bearer ' prefix if present
    const cleanKey = apiKey.replace(/^Bearer\s+/i, '');
    
    // Check if API key is valid
    if (!VALID_API_KEYS.includes(cleanKey)) {
        console.log(`🔑 Invalid API key attempt - IP: ${req.ip}`);
        return res.status(403).json({
            success: false,
            error: 'Invalid API key',
            message: 'The provided API key is not valid'
        });
    }

    console.log(`🔑 Valid API key used - IP: ${req.ip}`);
    next();
};

// ===== 4. RATE LIMITING =====
const limiter = rateLimit({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW) * 60 * 1000 || 15 * 60 * 1000, // 15 minutes
    max: parseInt(process.env.RATE_LIMIT_MAX) || 100, // Limit each IP to 100 requests per windowMs
    message: {
        success: false,
        error: 'Too many requests',
        message: 'Rate limit exceeded. Please try again later.'
    },
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
    keyGenerator: (req) => {
        // Use API key or IP as identifier
        const apiKey = req.headers['x-api-key'] || req.headers['authorization'];
        if (apiKey) {
            return `key:${apiKey.replace(/^Bearer\s+/i, '')}`;
        }
        return `ip:${req.ip}`;
    },
    skip: (req) => {
        // Skip rate limiting for health checks from localhost
        return req.path === '/api/health' && req.ip === '::1';
    },
    handler: (req, res) => {
        console.log(`⏱️ Rate limit exceeded - IP: ${req.ip}`);
        res.status(429).json({
            success: false,
            error: 'Rate limit exceeded',
            message: 'Too many requests. Please wait before trying again.'
        });
    }
});

// ===== 5. REFERER VALIDATION =====
const validateReferer = (req, res, next) => {
    // Skip for health check and status endpoints
    if (req.path === '/api/health' || req.path === '/api/status') {
        return next();
    }

    const referer = req.headers.referer || req.headers.referrer || '';
    
    // Allow direct API calls with valid API key (no referer needed)
    const apiKey = req.headers['x-api-key'] || req.headers['authorization'];
    if (apiKey) {
        const cleanKey = apiKey.replace(/^Bearer\s+/i, '');
        if (VALID_API_KEYS.includes(cleanKey)) {
            return next();
        }
    }

    // Check if referer is from allowed origins
    const isAllowed = ALLOWED_ORIGINS.some(origin => {
        // Check if referer starts with the allowed origin
        return referer.startsWith(origin) || referer.startsWith(origin + '/');
    });

    if (!isAllowed && referer) {
        console.log(`🚫 BLOCKED referer: ${referer}`);
        return res.status(403).json({
            success: false,
            error: 'Access denied',
            message: 'Invalid referer. Only allowed domains can access this API.'
        });
    }

    next();
};

// ===== 6. REQUEST VALIDATION =====
const validateSearch = [
    query('q').notEmpty().withMessage('Search query is required').isString().trim().escape(),
    query('limit').optional().isInt({ min: 1, max: 50 }).withMessage('Limit must be between 1 and 50')
];

const validateDownload = [
    query('url').notEmpty().withMessage('URL is required').isURL().withMessage('Invalid URL format'),
    query('quality').optional().isIn(['128', '192', '320']).withMessage('Quality must be 128, 192, or 320')
];

// ===== 7. LOGGING MIDDLEWARE =====
app.use((req, res, next) => {
    const origin = req.headers.origin || 'unknown';
    const apiKey = req.headers['x-api-key'] ? '***' : 'none';
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} - Origin: ${origin} - API Key: ${apiKey}`);
    next();
});

// ===== 8. APPLY MIDDLEWARE =====
app.use(express.json());
app.use(express.static('public'));

// Apply rate limiting to all routes except health
app.use((req, res, next) => {
    if (req.path === '/api/health') {
        return next();
    }
    limiter(req, res, next);
});

// Apply referer validation
app.use(validateReferer);

// Apply API key validation to all API routes
app.use('/api', validateApiKey);

// ===== 9. API ROUTES =====

// Search Endpoint
app.get('/api/music/search', validateSearch, async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                errors: errors.array()
            });
        }

        const { q, limit = 12 } = req.query;

        console.log(`🔍 Searching for: "${q}" (limit: ${limit})`);

        const response = await axios.get(`${EXTERNAL_API}/api/music/search`, {
            params: {
                q: q,
                limit: parseInt(limit)
            },
            timeout: 30000
        });

        res.json(response.data);

    } catch (error) {
        console.error('Search error:', error.message);
        
        if (error.response) {
            res.status(error.response.status).json({
                success: false,
                error: 'External API error',
                details: error.response.data
            });
        } else if (error.request) {
            res.status(503).json({
                success: false,
                error: 'External API unavailable',
                message: 'The music service is currently down. Please try again later.'
            });
        } else {
            res.status(500).json({
                success: false,
                error: 'Internal server error',
                message: error.message
            });
        }
    }
});

// Download Endpoint
app.get('/api/music/download', validateDownload, async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                success: false,
                errors: errors.array()
            });
        }

        const { url, quality = '320' } = req.query;

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
            'Cache-Control': 'public, max-age=3600',
            'Access-Control-Expose-Headers': 'Content-Disposition'
        });

        if (contentType.includes('application/json')) {
            const jsonData = JSON.parse(response.data.toString());
            if (jsonData.error || !jsonData.success) {
                return res.status(400).json({
                    success: false,
                    error: 'External API returned error',
                    details: jsonData
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
                    error: 'Audio not found',
                    message: 'The requested audio could not be found'
                });
            } else if (error.response.status === 503) {
                res.status(503).json({
                    success: false,
                    error: 'Service unavailable',
                    message: 'The music download service is temporarily unavailable'
                });
            } else {
                res.status(error.response.status).json({
                    success: false,
                    error: 'External API error',
                    status: error.response.status
                });
            }
        } else if (error.code === 'ECONNABORTED') {
            res.status(504).json({
                success: false,
                error: 'Timeout',
                message: 'The download took too long. Please try again.'
            });
        } else {
            res.status(500).json({
                success: false,
                error: 'Internal server error',
                message: error.message
            });
        }
    }
});

// ===== 10. PUBLIC ENDPOINTS (No API Key Required) =====

// Health Check (Rate limited but no API key)
app.get('/api/health', async (req, res) => {
    try {
        await axios.get(`${EXTERNAL_API}/api/health`, { timeout: 5000 });
        
        res.json({
            success: true,
            status: 'online',
            timestamp: new Date().toISOString(),
            version: '1.0.0',
            external_api: 'connected',
            security: {
                cors: ALLOWED_ORIGINS,
                rate_limit: {
                    window: `${process.env.RATE_LIMIT_WINDOW || 15} minutes`,
                    max: process.env.RATE_LIMIT_MAX || 100
                },
                api_keys: `${VALID_API_KEYS.length} active keys`
            }
        });
    } catch (error) {
        res.json({
            success: true,
            status: 'online',
            timestamp: new Date().toISOString(),
            version: '1.0.0',
            external_api: 'disconnected',
            error: error.message
        });
    }
});

// Status Endpoint (No API key needed)
app.get('/api/status', (req, res) => {
    res.json({
        success: true,
        message: 'JAY MUSIC API - Secure Proxy Server',
        endpoints: {
            search: '/api/music/search?q=umaasa',
            download: '/api/music/download?url=https://www.youtube.com/watch?v=GX3X9PmQOHY',
            health: '/api/health'
        },
        security: {
            cors_enabled: true,
            allowed_origins: ALLOWED_ORIGINS,
            rate_limit_enabled: true,
            rate_limit_window: `${process.env.RATE_LIMIT_WINDOW || 15} minutes`,
            rate_limit_max: process.env.RATE_LIMIT_MAX || 100,
            api_keys: `${VALID_API_KEYS.length} active keys`,
            referer_validation: true
        },
        external_api: EXTERNAL_API
    });
});

// ===== 11. ROOT ENDPOINT =====
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ===== 12. 404 HANDLER =====
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Not found',
        message: 'The requested endpoint does not exist'
    });
});

// ===== 13. ERROR HANDLER =====
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    
    if (err.message && err.message.includes('Origin')) {
        return res.status(403).json({
            success: false,
            error: 'Access denied',
            message: 'Your origin is not allowed to access this API'
        });
    }
    
    res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: err.message
    });
});

// ===== 14. START SERVER =====
app.listen(PORT, () => {
    console.log('========================================');
    console.log('🔒 JAY MUSIC API - Secure Proxy Server');
    console.log('========================================');
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📡 External API: ${EXTERNAL_API}`);
    console.log(`🔗 Local: http://localhost:${PORT}`);
    console.log('========================================');
    console.log('🔐 SECURITY FEATURES:');
    console.log(`✅ CORS: ${ALLOWED_ORIGINS.join(', ')}`);
    console.log(`✅ API Keys: ${VALID_API_KEYS.length} active keys`);
    console.log(`✅ Rate Limiting: ${process.env.RATE_LIMIT_MAX || 100} requests per ${process.env.RATE_LIMIT_WINDOW || 15} minutes`);
    console.log(`✅ Referer Validation: Enabled`);
    console.log(`✅ Helmet Security Headers: Enabled`);
    console.log(`✅ Input Validation: Enabled`);
    console.log('========================================');
    console.log('📋 TESTING:');
    console.log(`curl -H "x-api-key: ${VALID_API_KEYS[0]}" "http://localhost:${PORT}/api/music/search?q=umaasa"`);
    console.log('========================================');
});
