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

// ============================================
// HOME ROUTE (This fixes your error)
// ============================================
app.get('/', (req, res) => {
    res.json({
        name: 'Millnest Vendor Intelligence API',
        version: '1.0.0',
        status: 'running',
        timestamp: new Date().toISOString(),
        endpoints: {
            health: 'GET /',
            checkVendor: 'POST /api/vendors/check',
            listVendors: 'GET /api/vendors',
            getAudit: 'GET /api/audit',
            dashboard: 'GET /api/dashboard'
        }
    });
});

// ============================================
// MAIN AI ENDPOINT - Check for duplicates
// ============================================
app.post('/api/vendors/check', async (req, res) => {
    try {
        const { name, gst, pan, userEmail, userIp } = req.body;
        
        if (!name || name.trim().length < 2) {
            return res.status(400).json({ 
                success: false, 
                error: 'Vendor name must be at least 2 characters' 
            });
        }
        
        console.log(`🔍 Checking vendor: "${name}"`);
        
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
            
            if (confidenceScore >= 0.85) {
                recommendation = 'BLOCK';
            } else if (confidenceScore >= 0.65) {
                recommendation = 'WARNING';
            } else if (confidenceScore >= 0.45) {
                recommendation = 'REVIEW';
            } else {
                recommendation = 'CREATE';
            }
        }
        
        // Also check by GST if provided (exact match)
        if (gst && gst.trim()) {
            const gstCheck = await pool.query(
                `SELECT * FROM vendors WHERE gst = $1 AND status = 'ACTIVE'`,
                [gst.toUpperCase()]
            );
            if (gstCheck.rows.length > 0) {
                matches.unshift({
                    ...gstCheck.rows[0],
                    similarity_score: 1.0,
                    match_type: 'exact_gst'
                });
                recommendation = 'BLOCK';
                bestMatch = gstCheck.rows[0];
                confidenceScore = 1.0;
            }
        }
        
        // Log to audit
        try {
            await pool.query(
                `SELECT log_vendor_check($1, $2, $3, $4, $5, $6)`,
                [userEmail || 'demo@millnest.com', userIp || req.ip || 'unknown', name, bestMatch?.id || null, confidenceScore, recommendation]
            );
        } catch (logError) {
            console.log('Audit log warning:', logError.message);
            // Continue even if logging fails
        }
        
        // Prepare response message
        let message = '';
        switch(recommendation) {
            case 'BLOCK':
                message = '⚠️ DUPLICATE DETECTED! This vendor already exists. Please use existing record.';
                break;
            case 'WARNING':
                message = '⚠️ POTENTIAL DUPLICATE FOUND! Please review before creating.';
                break;
            case 'REVIEW':
                message = '🔍 LOW CONFIDENCE MATCH. Manual verification recommended.';
                break;
            default:
                message = '✅ No existing vendor found. Safe to create new record.';
        }
        
        res.json({
            success: true,
            search_term: name,
            gst_searched: gst || null,
            recommendation: recommendation,
            message: message,
            matches: matches.slice(0, 5).map(m => ({
                vendor_code: m.vendor_code,
                legal_name: m.legal_name,
                trade_name: m.trade_name,
                gst: m.gst,
                city: m.city,
                similarity_score: parseFloat(m.similarity_score),
                match_type: m.match_type
            })),
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('Error in vendor check:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Internal server error',
            message: error.message
        });
    }
});

// ============================================
// GET ALL VENDORS
// ============================================
app.get('/api/vendors', async (req, res) => {
    try {
        const { limit = 50, search } = req.query;
        
        let query = `SELECT id, vendor_code, legal_name, trade_name, gst, city, status FROM vendors WHERE status = 'ACTIVE'`;
        let params = [];
        
        if (search) {
            query += ` AND (legal_name ILIKE $1 OR trade_name ILIKE $1 OR vendor_code ILIKE $1)`;
            params.push(`%${search}%`);
        }
        
        query += ` ORDER BY legal_name LIMIT $${params.length + 1}`;
        params.push(limit);
        
        const result = await pool.query(query, params);
        
        res.json({
            success: true,
            count: result.rows.length,
            vendors: result.rows
        });
        
    } catch (error) {
        console.error('Error fetching vendors:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// GET AUDIT LOGS
// ============================================
app.get('/api/audit', async (req, res) => {
    try {
        const { limit = 50 } = req.query;
        
        const result = await pool.query(
            `SELECT * FROM vendor_audit ORDER BY created_at DESC LIMIT $1`,
            [limit]
        );
        
        res.json({
            success: true,
            count: result.rows.length,
            audits: result.rows
        });
        
    } catch (error) {
        console.error('Error fetching audit:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// DASHBOARD STATISTICS
// ============================================
app.get('/api/dashboard', async (req, res) => {
    try {
        const vendorCount = await pool.query(`SELECT COUNT(*) as total FROM vendors WHERE status = 'ACTIVE'`);
        const auditStats = await pool.query(`
            SELECT 
                COUNT(*) as total_checks,
                COUNT(CASE WHEN action_taken = 'BLOCK' THEN 1 END) as duplicates_blocked,
                COUNT(CASE WHEN action_taken = 'WARNING' THEN 1 END) as warnings,
                COUNT(CASE WHEN action_taken = 'CREATED' THEN 1 END) as vendors_created
            FROM vendor_audit
        `);
        
        res.json({
            success: true,
            stats: {
                active_vendors: parseInt(vendorCount.rows[0].total),
                total_checks: parseInt(auditStats.rows[0].total_checks),
                duplicates_blocked: parseInt(auditStats.rows[0].duplicates_blocked),
                warnings: parseInt(auditStats.rows[0].warnings),
                vendors_created: parseInt(auditStats.rows[0].vendors_created)
            },
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('Error fetching dashboard:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// CREATE NEW VENDOR
// ============================================
app.post('/api/vendors', async (req, res) => {
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        
        const {
            legal_name, trade_name, gst, pan, address, city, state,
            pincode, contact_person, contact_email, contact_phone, created_by
        } = req.body;
        
        if (!legal_name) {
            return res.status(400).json({ success: false, error: 'Legal name is required' });
        }
        
        // Check for duplicates
        const duplicateCheck = await client.query(
            `SELECT * FROM search_similar_vendors($1, 0.7)`,
            [legal_name]
        );
        
        if (duplicateCheck.rows.length > 0 && parseFloat(duplicateCheck.rows[0].similarity_score) >= 0.85) {
            await client.query('ROLLBACK');
            return res.status(409).json({
                success: false,
                error: 'DUPLICATE_DETECTED',
                existing_vendor: duplicateCheck.rows[0],
                message: 'Vendor already exists with high confidence match'
            });
        }
        
        // Generate vendor code
        const codeResult = await client.query(`
            SELECT 'V-' || LPAD(COALESCE(MAX(CAST(SUBSTRING(vendor_code FROM 3) AS INTEGER)), 0) + 1, 6, '0') as new_code
            FROM vendors
        `);
        const vendorCode = codeResult.rows[0].new_code;
        
        // Insert new vendor
        const insertResult = await client.query(`
            INSERT INTO vendors (
                vendor_code, legal_name, trade_name, gst, pan, address, city, state, pincode,
                contact_person, contact_email, contact_phone, status, created_by
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'ACTIVE', $13)
            RETURNING *
        `, [
            vendorCode, legal_name, trade_name || null, gst || null, pan || null, address || null,
            city || null, state || null, pincode || null,
            contact_person || null, contact_email || null, contact_phone || null,
            created_by || 'api'
        ]);
        
        await client.query('COMMIT');
        
        res.json({
            success: true,
            vendor: insertResult.rows[0],
            message: 'Vendor created successfully'
        });
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error creating vendor:', error);
        
        if (error.code === '23505') {
            res.status(409).json({ success: false, error: 'Duplicate GST or PAN detected' });
        } else {
            res.status(500).json({ success: false, error: 'Internal server error' });
        }
    } finally {
        client.release();
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`
    ╔═══════════════════════════════════════╗
    ║   🏗️  MILLNEST VENDOR INTELLIGENCE    ║
    ║                                       ║
    ║   ✅ API running on port ${PORT}         ║
    ║   🌐 https://your-railway-url         ║
    ║                                       ║
    ║   📍 Test with: curl /                ║
    ╚═══════════════════════════════════════╝
    `);
});