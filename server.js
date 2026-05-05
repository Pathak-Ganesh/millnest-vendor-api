const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100
});
app.use('/api/', limiter);

// Database connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Test database connection
pool.connect((err) => {
    if (err) {
        console.error('❌ Database connection failed:', err.message);
    } else {
        console.log('✅ Database connected');
    }
});

// Health check
app.get('/', (req, res) => {
    res.json({
        name: 'Millnest Vendor Intelligence API',
        status: 'running',
        endpoints: ['POST /api/vendors/check', 'GET /api/vendors', 'GET /api/audit', 'GET /api/dashboard']
    });
});

// MAIN AI ENDPOINT - Check for duplicates
app.post('/api/vendors/check', async (req, res) => {
    try {
        const { name, gst, pan, userEmail, userIp } = req.body;
        
        if (!name || name.trim().length < 2) {
            return res.status(400).json({ success: false, error: 'Vendor name required' });
        }
        
        console.log(`🔍 Checking: "${name}"`);
        
        // Call PostgreSQL fuzzy search function
        const searchResult = await pool.query(
            `SELECT * FROM search_similar_vendors($1, 0.3)`,
            [name]
        );
        
        let matches = searchResult.rows;
        let recommendation = 'CREATE';
        let bestMatch = null;
        let confidenceScore = 0;
        
        if (matches.length > 0) {
            bestMatch = matches[0];
            confidenceScore = parseFloat(bestMatch.similarity_score);
            
            if (confidenceScore >= 0.85) recommendation = 'BLOCK';
            else if (confidenceScore >= 0.65) recommendation = 'WARNING';
            else if (confidenceScore >= 0.45) recommendation = 'REVIEW';
        }
        
        // Check GST if provided
        if (gst && gst.trim()) {
            const gstCheck = await pool.query(
                `SELECT * FROM vendors WHERE gst = $1`,
                [gst.toUpperCase()]
            );
            if (gstCheck.rows.length > 0) {
                matches.unshift({
                    ...gstCheck.rows[0],
                    similarity_score: 1.0,
                    match_type: 'exact_gst'
                });
                recommendation = 'BLOCK';
                confidenceScore = 1.0;
            }
        }
        
        // Log to audit
        await pool.query(
            `SELECT log_vendor_check($1, $2, $3, $4, $5, $6)`,
            [userEmail || 'demo@millnest.com', userIp || req.ip, name, bestMatch?.id || null, confidenceScore, recommendation]
        );
        
        res.json({
            success: true,
            search_term: name,
            recommendation: recommendation,
            message: recommendation === 'BLOCK' ? 'Duplicate detected! Use existing vendor.' :
                     recommendation === 'WARNING' ? 'Potential duplicate found. Review before creating.' :
                     recommendation === 'REVIEW' ? 'Low confidence match. Manual review recommended.' :
                     'No existing vendor found. Safe to create.',
            matches: matches.slice(0, 5).map(m => ({
                vendor_code: m.vendor_code,
                legal_name: m.legal_name,
                gst: m.gst,
                city: m.city,
                similarity_score: parseFloat(m.similarity_score)
            })),
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Get all vendors
app.get('/api/vendors', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT vendor_code, legal_name, trade_name, gst, city, status FROM vendors WHERE status = 'ACTIVE' ORDER BY legal_name LIMIT 100`
        );
        res.json({ success: true, vendors: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get audit logs
app.get('/api/audit', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT * FROM vendor_audit ORDER BY created_at DESC LIMIT 50`
        );
        res.json({ success: true, audits: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Dashboard stats
app.get('/api/dashboard', async (req, res) => {
    try {
        const vendorCount = await pool.query(`SELECT COUNT(*) as total FROM vendors WHERE status = 'ACTIVE'`);
        const auditStats = await pool.query(`SELECT COUNT(*) as checks, COUNT(CASE WHEN action_taken = 'BLOCK' THEN 1 END) as blocked FROM vendor_audit`);
        
        res.json({
            success: true,
            stats: {
                active_vendors: parseInt(vendorCount.rows[0].total),
                total_checks: parseInt(auditStats.rows[0].checks),
                duplicates_blocked: parseInt(auditStats.rows[0].blocked)
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Millnest API running on port ${PORT}`);
});
