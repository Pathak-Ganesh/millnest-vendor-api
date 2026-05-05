const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Database connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// ============================================
// FUZZY MATCHING FUNCTION
// ============================================
function getSimilarity(str1, str2) {
    if (!str1 || !str2) return 0;
    
    const s1 = str1.toLowerCase().replace(/[^a-z0-9]/g, '');
    const s2 = str2.toLowerCase().replace(/[^a-z0-9]/g, '');
    
    if (s1 === s2) return 1;
    if (s1.includes(s2) || s2.includes(s1)) return 0.9;
    
    // Levenshtein distance
    const track = Array(s2.length + 1).fill(null).map(() => Array(s1.length + 1).fill(null));
    
    for (let i = 0; i <= s1.length; i++) track[0][i] = i;
    for (let j = 0; j <= s2.length; j++) track[j][0] = j;
    
    for (let j = 1; j <= s2.length; j++) {
        for (let i = 1; i <= s1.length; i++) {
            const indicator = s1[i - 1] === s2[j - 1] ? 0 : 1;
            track[j][i] = Math.min(
                track[j][i - 1] + 1,
                track[j - 1][i] + 1,
                track[j - 1][i - 1] + indicator
            );
        }
    }
    
    const distance = track[s2.length][s1.length];
    const maxLen = Math.max(s1.length, s2.length);
    return maxLen === 0 ? 1 : 1 - distance / maxLen;
}

// ============================================
// VENDOR DATABASE (In-memory for reliability)
// ============================================
const VENDORS = [
    { id: "1", vendor_code: "V-1001", legal_name: "Larsen & Toubro Ltd", trade_name: "L&T", gst: "27AAACL1234A1Z", city: "Mumbai", status: "ACTIVE" },
    { id: "2", vendor_code: "V-1002", legal_name: "Tata Projects Ltd", trade_name: "Tata Projects", gst: "27AAACT5678B2Z", city: "Mumbai", status: "ACTIVE" },
    { id: "3", vendor_code: "V-1003", legal_name: "Siemens India Pvt Ltd", trade_name: "Siemens", gst: "27AAACS9012C3Z", city: "Mumbai", status: "ACTIVE" },
    { id: "4", vendor_code: "V-1004", legal_name: "ACC Limited", trade_name: "ACC", gst: "27AAACA3456D4Z", city: "Mumbai", status: "ACTIVE" },
    { id: "5", vendor_code: "V-1005", legal_name: "Reliance Infrastructure Ltd", trade_name: "Reliance Infra", gst: "27AAACR7890E5Z", city: "Mumbai", status: "ACTIVE" },
    { id: "6", vendor_code: "V-1006", legal_name: "Bharat Heavy Electricals Ltd", trade_name: "BHEL", gst: "27AAACB1122F6Z", city: "New Delhi", status: "ACTIVE" },
    { id: "7", vendor_code: "V-1007", legal_name: "Gammon India Ltd", trade_name: "Gammon", gst: "27AAACG3344G7Z", city: "Mumbai", status: "ACTIVE" },
    { id: "8", vendor_code: "V-1008", legal_name: "Hindustan Construction Co Ltd", trade_name: "HCC", gst: "27AAACH5566H8Z", city: "Mumbai", status: "ACTIVE" },
    { id: "9", vendor_code: "V-1009", legal_name: "Punj Lloyd Ltd", trade_name: "Punj Lloyd", gst: "27AAACP7788I9Z", city: "Gurgaon", status: "ACTIVE" },
    { id: "10", vendor_code: "V-1010", legal_name: "Essar Projects India Ltd", trade_name: "Essar", gst: "27AAACE9900J0Z", city: "Mumbai", status: "ACTIVE" }
];

// ============================================
// API ENDPOINTS
// ============================================

// Health check
app.get('/', (req, res) => {
    res.json({
        name: 'Millnest Vendor Intelligence API',
        version: '2.0.0',
        status: 'running',
        endpoints: {
            health: 'GET /',
            checkVendor: 'POST /api/vendors/check',
            listVendors: 'GET /api/vendors',
            createVendor: 'POST /api/vendors'
        }
    });
});

// GET all vendors
app.get('/api/vendors', (req, res) => {
    const activeVendors = VENDORS.filter(v => v.status === 'ACTIVE');
    res.json({
        success: true,
        count: activeVendors.length,
        vendors: activeVendors
    });
});

// POST - Check for duplicates
app.post('/api/vendors/check', (req, res) => {
    try {
        const { name, gst } = req.body;
        
        if (!name || name.trim().length < 2) {
            return res.status(400).json({ success: false, error: 'Vendor name required' });
        }
        
        console.log(`Checking: "${name}"`);
        
        // Find matches
        const matches = [];
        
        for (const vendor of VENDORS) {
            if (vendor.status !== 'ACTIVE') continue;
            
            const nameScore = getSimilarity(name, vendor.legal_name);
            const tradeScore = vendor.trade_name ? getSimilarity(name, vendor.trade_name) : 0;
            let bestScore = Math.max(nameScore, tradeScore);
            
            if (gst && vendor.gst && gst.toUpperCase() === vendor.gst.toUpperCase()) {
                bestScore = 1.0;
            }
            
            if (bestScore > 0.3) {
                matches.push({
                    id: vendor.id,
                    vendor_code: vendor.vendor_code,
                    legal_name: vendor.legal_name,
                    trade_name: vendor.trade_name,
                    gst: vendor.gst,
                    city: vendor.city,
                    similarity_score: bestScore
                });
            }
        }
        
        matches.sort((a, b) => b.similarity_score - a.similarity_score);
        
        let recommendation = 'CREATE';
        let message = '';
        
        if (matches.length > 0) {
            const bestMatch = matches[0];
            const bestScore = bestMatch.similarity_score;
            
            if (bestScore >= 0.85) {
                recommendation = 'BLOCK';
                message = 'Duplicate vendor detected. Creation blocked.';
            } else if (bestScore >= 0.65) {
                recommendation = 'WARNING';
                message = 'Potential duplicate found. Please review.';
            } else {
                recommendation = 'REVIEW';
                message = 'Low confidence match. Manual review recommended.';
            }
        } else {
            message = 'No existing vendor found. Safe to create.';
        }
        
        console.log(`Result: ${recommendation}`);
        
        res.json({
            success: true,
            search_term: name,
            recommendation: recommendation,
            message: message,
            matches: matches.slice(0, 5),
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST - Create new vendor
app.post('/api/vendors', (req, res) => {
    try {
        const { legal_name, trade_name, gst, pan, city, contact_person, contact_email, contact_phone, address } = req.body;
        
        if (!legal_name) {
            return res.status(400).json({ success: false, error: 'Legal name required' });
        }
        
        // Check for duplicates
        let isDuplicate = false;
        let existingVendor = null;
        
        for (const vendor of VENDORS) {
            const score = getSimilarity(legal_name, vendor.legal_name);
            if (score >= 0.85) {
                isDuplicate = true;
                existingVendor = vendor;
                break;
            }
            if (gst && vendor.gst && gst.toUpperCase() === vendor.gst.toUpperCase()) {
                isDuplicate = true;
                existingVendor = vendor;
                break;
            }
        }
        
        if (isDuplicate) {
            return res.status(409).json({
                success: false,
                error: 'DUPLICATE_DETECTED',
                existing_vendor: existingVendor,
                message: 'Vendor already exists'
            });
        }
        
        // Generate new vendor code
        const lastCode = VENDORS[VENDORS.length - 1].vendor_code;
        const lastNum = parseInt(lastCode.split('-')[1]);
        const newCode = 'V-' + (lastNum + 1);
        
        // Create new vendor
        const newVendor = {
            id: String(Date.now()),
            vendor_code: newCode,
            legal_name: legal_name,
            trade_name: trade_name || null,
            gst: gst || null,
            pan: pan || null,
            city: city || null,
            contact_person: contact_person || null,
            contact_email: contact_email || null,
            contact_phone: contact_phone || null,
            address: address || null,
            status: 'ACTIVE'
        };
        
        VENDORS.push(newVendor);
        
        console.log('Created vendor:', newCode, '-', legal_name);
        
        res.json({
            success: true,
            vendor: newVendor,
            message: 'Vendor created successfully'
        });
        
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET - Dashboard stats
app.get('/api/dashboard', (req, res) => {
    const activeCount = VENDORS.filter(v => v.status === 'ACTIVE').length;
    res.json({
        success: true,
        stats: {
            active_vendors: activeCount,
            total_checks: 0,
            duplicates_blocked: 0
        }
    });
});

// GET - Audit logs
app.get('/api/audit', (req, res) => {
    res.json({
        success: true,
        audits: []
    });
});

// Start server
app.listen(PORT, () => {
    console.log('Millnest Vendor API running on port', PORT);
    console.log('Vendors loaded:', VENDORS.length);
    console.log('Fuzzy matching: ENABLED');
});