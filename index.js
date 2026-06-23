const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// Configuration
const EXTERNAL_API = 'https://music-api--s1fuh4x.replit.app';
const ALLOWED_ORIGINS = [
    'https://searchmusic.gt.tc',
    'https://jay-music.onrender.com'
];

// CORS Configuration
app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (like mobile apps or curl)
        if (!origin) return callback(null, true);
        if (ALLOWED_ORIGINS.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            console.log('Bawal gamitin ang API pm moko para maka gamit ka:', origin);
            // Allow all for testing (remove in production)
            callback(null, true);
        }
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());
app.use(express.static('public'));

// Logging middleware
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

// ===== SEARCH ENDPOINT =====
app.get('/api/music/search', async (req, res) => {
    try {
        const { q, limit = 10 } = req.query;
        
        if (!q) {
            return res.status(400).json({
                success: false,
                error: 'Search query (q) is required'
            });
        }

        console.log(`🔍 Searching for: "${q}" (limit: ${limit})`);

        // Forward request to external API
        const response = await axios.get(`${EXTERNAL_API}/api/music/search`, {
            params: {
                q: q,
                limit: parseInt(limit)
            },
            timeout: 30000
        });

        // Return the external API response
        res.json(response.data);

    } catch (error) {
        console.error('Search error:', error.message);
        
        if (error.response) {
            // The external API responded with an error
            res.status(error.response.status).json({
                success: false,
                error: 'External API error',
                details: error.response.data
            });
        } else if (error.request) {
            // The external API didn't respond
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

// ===== DOWNLOAD ENDPOINT =====
app.get('/api/music/download', async (req, res) => {
    try {
        const { url, quality = '320' } = req.query;
        
        if (!url) {
            return res.status(400).json({
                success: false,
                error: 'URL parameter is required'
            });
        }

        console.log(`⬇️ Downloading: ${url} (quality: ${quality})`);

        // Check if external API is available
        try {
            await axios.get(`${EXTERNAL_API}/api/health`, { timeout: 3000 });
        } catch (healthError) {
            console.warn('External API health check failed, but continuing...');
        }

        // Forward download request to external API
        const response = await axios.get(`${EXTERNAL_API}/api/music/download`, {
            params: {
                url: url,
                quality: quality
            },
            responseType: 'arraybuffer',
            timeout: 60000, // 60 seconds timeout
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        // Check if response is audio
        const contentType = response.headers['content-type'] || 'audio/mpeg';
        
        // Forward the audio file
        res.set({
            'Content-Type': contentType,
            'Content-Length': response.data.length,
            'Cache-Control': 'public, max-age=3600',
            'Access-Control-Expose-Headers': 'Content-Disposition'
        });

        // If the external API returns JSON (error or metadata), handle it
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
            // The external API responded with an error
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

// ===== HEALTH CHECK =====
app.get('/api/health', async (req, res) => {
    try {
        // Check external API health
        await axios.get(`${EXTERNAL_API}/api/health`, { timeout: 5000 });
        
        res.json({
            success: true,
            status: 'online',
            timestamp: new Date().toISOString(),
            version: '1.0.0',
            external_api: 'connected'
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

// ===== STATUS ENDPOINT =====
app.get('/api/status', (req, res) => {
    res.json({
        success: true,
        message: 'JAY MUSIC API is running',
        endpoints: {
            search: '/api/music/search?q=umaasa',
            download: '/api/music/download?url=https://www.youtube.com/watch?v=GX3X9PmQOHY',
            health: '/api/health'
        },
        external_api: EXTERNAL_API,
        cors_origins: ALLOWED_ORIGINS
    });
});

// ===== ROOT ENDPOINT (HTML) =====
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ===== ERROR HANDLER =====
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: err.message
    });
});

// ===== START SERVER =====
app.listen(PORT, () => {
    console.log('========================================');
    console.log('🎵 JAY MUSIC API - Proxy Server');
    console.log('========================================');
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📡 External API: ${EXTERNAL_API}`);
    console.log(`🔗 Local: http://localhost:${PORT}`);
    console.log(`🔍 Search: http://localhost:${PORT}/api/music/search?q=umaasa`);
    console.log(`⬇️ Download: http://localhost:${PORT}/api/music/download?url=...`);
    console.log(`🌐 Health: http://localhost:${PORT}/api/health`);
    console.log('========================================');
});
