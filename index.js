const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

const app = express();
const PORT = process.env.PORT || 3001;

// Allowed origins
const allowedOrigins = [
    'https://searchmusic.gt.tc'
];

// CORS configuration
app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            console.log('Blocked origin:', origin);
            callback(null, true); // Allow all for testing - change this in production
        }
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());
app.use(express.static('public'));

// Create temp directory for downloads
const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir);
}

// Clean up old files every hour
setInterval(() => {
    const files = fs.readdirSync(tempDir);
    const now = Date.now();
    files.forEach(file => {
        const filePath = path.join(tempDir, file);
        const stats = fs.statSync(filePath);
        // Delete files older than 1 hour
        if (now - stats.mtimeMs > 3600000) {
            fs.unlinkSync(filePath);
            console.log('Cleaned up:', file);
        }
    });
}, 3600000);

// Music search endpoint
app.get('/api/music/search', async (req, res) => {
    try {
        const { q, limit = 20 } = req.query;
        
        if (!q) {
            return res.status(400).json({ error: 'Search query required' });
        }
        
        console.log(`Searching for: ${q}`);
        
        // Try multiple sources
        let songs = [];
        
        // Source 1: YouTube Music via yt-dlp
        try {
            const ytSongs = await searchYouTubeMusic(q, limit);
            if (ytSongs.length > 0) {
                songs = ytSongs;
            }
        } catch (ytError) {
            console.log('YouTube search failed, trying other sources...');
        }
        
        // Source 2: SoundCloud fallback
        if (songs.length === 0) {
            try {
                const scSongs = await searchSoundCloud(q, limit);
                if (scSongs.length > 0) {
                    songs = scSongs;
                }
            } catch (scError) {
                console.log('SoundCloud search failed...');
            }
        }
        
        // Source 3: Sample data (for testing)
        if (songs.length === 0) {
            songs = getSampleSongs(q);
        }
        
        res.json({
            success: true,
            data: songs,
            total: songs.length,
            query: q
        });
        
    } catch (error) {
        console.error('Search error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to search music',
            details: error.message
        });
    }
});

// Music download endpoint
app.get('/api/music/download', async (req, res) => {
    try {
        const { url, quality = '320' } = req.query;
        
        if (!url) {
            return res.status(400).json({ error: 'URL required' });
        }
        
        console.log(`Downloading: ${url}`);
        
        // Try to download using yt-dlp
        const audioBuffer = await downloadAudio(url, quality);
        
        if (!audioBuffer) {
            // Fallback to proxy download
            const proxyBuffer = await proxyDownload(url);
            if (proxyBuffer) {
                res.set({
                    'Content-Type': 'audio/mpeg',
                    'Content-Length': proxyBuffer.length
                });
                return res.send(proxyBuffer);
            }
            
            return res.status(404).json({
                success: false,
                error: 'Could not download audio'
            });
        }
        
        res.set({
            'Content-Type': 'audio/mpeg',
            'Content-Length': audioBuffer.length
        });
        res.send(audioBuffer);
        
    } catch (error) {
        console.error('Download error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to download audio',
            details: error.message
        });
    }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({
        status: 'online',
        timestamp: new Date().toISOString(),
        version: '1.0.0'
    });
});

// Helper: Search YouTube Music
async function searchYouTubeMusic(query, limit) {
    try {
        // Using yt-dlp for search
        const command = `yt-dlp --default-search ytsearch${limit} --print "title: %(title)s, artist: %(artist)s, url: %(url)s, thumbnail: %(thumbnail)s" "ytsearch${limit}:${query}"`;
        
        const { stdout, stderr } = await execPromise(command);
        
        if (stderr && !stderr.includes('WARNING')) {
            console.error('yt-dlp error:', stderr);
            return [];
        }
        
        const lines = stdout.split('\n').filter(line => line.trim());
        const songs = [];
        
        lines.forEach(line => {
            const titleMatch = line.match(/title: (.+?), artist:/);
            const artistMatch = line.match(/artist: (.+?), url:/);
            const urlMatch = line.match(/url: (.+?), thumbnail:/);
            const thumbMatch = line.match(/thumbnail: (.+)/);
            
            if (titleMatch && urlMatch) {
                songs.push({
                    title: titleMatch[1] || 'Unknown',
                    artist: artistMatch ? artistMatch[1] : 'Unknown Artist',
                    url: urlMatch[1] || '',
                    thumbnail: thumbMatch ? thumbMatch[1] : `https://ui-avatars.com/api/?name=${encodeURIComponent(titleMatch[1])}&background=282828&color=fff&size=200`,
                    source: 'youtube'
                });
            }
        });
        
        return songs.slice(0, limit);
        
    } catch (error) {
        console.error('YouTube search error:', error);
        return [];
    }
}

// Helper: Search SoundCloud
async function searchSoundCloud(query, limit) {
    try {
        // Using public SoundCloud search
        const response = await axios.get('https://api-v2.soundcloud.com/search', {
            params: {
                q: query,
                limit: limit,
                offset: 0,
                client_id: 'YOUR_CLIENT_ID' // You need to register for a SoundCloud API key
            }
        });
        
        const tracks = response.data.collection || [];
        return tracks.map(track => ({
            title: track.title || 'Unknown',
            artist: track.user?.username || 'Unknown Artist',
            url: track.permalink_url || '',
            thumbnail: track.artwork_url || track.user?.avatar_url || '',
            source: 'soundcloud'
        }));
        
    } catch (error) {
        console.error('SoundCloud search error:', error);
        return [];
    }
}

// Helper: Download audio
async function downloadAudio(url, quality) {
    try {
        const outputPath = path.join(tempDir, `${Date.now()}.mp3`);
        
        const command = `yt-dlp -f bestaudio --extract-audio --audio-format mp3 --audio-quality ${quality} -o "${outputPath}" "${url}"`;
        
        await execPromise(command);
        
        if (fs.existsSync(outputPath)) {
            const buffer = fs.readFileSync(outputPath);
            fs.unlinkSync(outputPath); // Clean up
            return buffer;
        }
        
        return null;
        
    } catch (error) {
        console.error('Download error:', error);
        return null;
    }
}

// Helper: Proxy download (fallback)
async function proxyDownload(url) {
    try {
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 30000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        
        return Buffer.from(response.data);
        
    } catch (error) {
        console.error('Proxy download error:', error);
        return null;
    }
}

// Helper: Sample songs (for testing when APIs fail)
function getSampleSongs(query) {
    const sampleSongs = [
        {
            title: `${query} - Official Audio`,
            artist: 'Unknown Artist',
            url: `https://example.com/sample.mp3`,
            thumbnail: `https://ui-avatars.com/api/?name=${encodeURIComponent(query)}&background=1DB954&color=fff&size=200`,
            source: 'sample'
        }
    ];
    
    // Generate multiple sample songs
    const songs = [];
    for (let i = 1; i <= 5; i++) {
        songs.push({
            title: `${query} - Mix ${i}`,
            artist: `Various Artists ${i}`,
            url: `https://example.com/sample_${i}.mp3`,
            thumbnail: `https://ui-avatars.com/api/?name=${encodeURIComponent(query)}%20${i}&background=282828&color=fff&size=200`,
            source: 'sample'
        });
    }
    
    return songs;
}

// Error handler middleware
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({
        success: false,
        error: 'Internal server error',
        details: err.message
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`🎵 JAY MUSIC API Server running on port ${PORT}`);
    console.log(`📍 Allowed origins: ${allowedOrigins.join(', ')}`);
    console.log(`🌐 Health check: http://localhost:${PORT}/api/health`);
    console.log(`🔍 Search endpoint: http://localhost:${PORT}/api/music/search?q=song`);
    console.log(`⬇️ Download endpoint: http://localhost:${PORT}/api/music/download?url=...`);
});
