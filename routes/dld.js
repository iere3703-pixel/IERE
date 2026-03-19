const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// GET /api/dld/transactions - Get DLD transactions
router.get('/transactions', async (req, res) => {
  try {
    const { area, type, beds, days = 30, limit = 200 } = req.query;
    
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - parseInt(days));
    
    let query = supabase
      .from('dld_transactions')
      .select('*')
      .gte('transaction_date', cutoffDate.toISOString().split('T')[0])
      .order('transaction_date', { ascending: false })
      .limit(parseInt(limit));
    
    if (area && area !== 'all') {
      query = query.eq('area', area);
    }
    
    if (type && type !== 'all') {
      query = query.eq('property_type', type);
    }
    
    if (beds && beds !== 'all') {
      query = query.eq('bedrooms', parseInt(beds));
    }
    
    const { data, error } = await query;
    
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('Error fetching DLD transactions:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dld/summary - Get summary stats
router.get('/summary', async (req, res) => {
  try {
    const { area, days = 30 } = req.query;
    
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - parseInt(days));
    
    let query = supabase
      .from('dld_transactions')
      .select('*')
      .gte('transaction_date', cutoffDate.toISOString().split('T')[0]);
    
    if (area && area !== 'all') {
      query = query.eq('area', area);
    }
    
    const { data, error } = await query;
    
    if (error) throw error;
    
    // Calculate summary stats
    const transactions = data || [];
    const totalDeals = transactions.length;
    const avgPricePerSqft = totalDeals > 0
      ? Math.round(transactions.reduce((sum, t) => sum + (t.price_per_sqft || 0), 0) / totalDeals)
      : 0;
    const avgSize = totalDeals > 0
      ? Math.round(transactions.reduce((sum, t) => sum + (t.size_sqft || 0), 0) / totalDeals)
      : 0;
    const totalValue = transactions.reduce((sum, t) => sum + (t.sale_price || 0), 0);
    
    // Find top area
    const areaCounts = {};
    transactions.forEach(t => {
      areaCounts[t.area] = (areaCounts[t.area] || 0) + 1;
    });
    const topArea = Object.entries(areaCounts)
      .sort((a, b) => b[1] - a[1])[0]?.[0] || 'N/A';
    
    res.json({
      totalDeals,
      avgPricePerSqft,
      avgSize,
      totalValue,
      topArea,
      periodDays: days,
    });
  } catch (err) {
    console.error('Error fetching DLD summary:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dld/areas - Get all areas
router.get('/areas', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('area_price_data')
      .select('area, avg_price_per_sqft_sale, avg_price_per_sqft_rent, avg_rental_yield, transactions_last_30d')
      .order('area', { ascending: true });
    
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('Error fetching areas:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
