const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// GET /api/market/offplan - Get off-plan projects
router.get('/offplan', async (req, res) => {
  try {
    const { developer, area, status, minPrice, maxPrice } = req.query;
    
    let query = supabase
      .from('offplan_projects')
      .select('*')
      .order('starting_price', { ascending: true });
    
    if (developer && developer !== 'all') {
      query = query.eq('developer', developer);
    }
    
    if (area && area !== 'all') {
      query = query.eq('area', area);
    }
    
    if (status && status !== 'all') {
      query = query.eq('status', status);
    }
    
    if (minPrice) {
      query = query.gte('starting_price', parseInt(minPrice));
    }
    
    if (maxPrice) {
      query = query.lte('starting_price', parseInt(maxPrice));
    }
    
    const { data, error } = await query;
    
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('Error fetching off-plan projects:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/market/offplan/:id - Get single project
router.get('/offplan/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const { data, error } = await supabase
      .from('offplan_projects')
      .select('*')
      .eq('id', id)
      .single();
    
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('Error fetching off-plan project:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/market/area-prices - Get area price data for heat map
router.get('/area-prices', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('area_price_data')
      .select('*')
      .order('area', { ascending: true });
    
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('Error fetching area prices:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/market/developers - Get list of developers
router.get('/developers', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('offplan_projects')
      .select('developer')
      .order('developer', { ascending: true });
    
    if (error) throw error;
    
    const developers = [...new Set(data?.map(d => d.developer) || [])];
    res.json(developers);
  } catch (err) {
    console.error('Error fetching developers:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/market/yield-calculate - Calculate rental yield
router.post('/yield-calculate', async (req, res) => {
  try {
    const { area, propertyType, beds, size, purchasePrice, annualRent, serviceCharges, managementFee } = req.body;
    
    // Get market data for comparison
    const { data: marketData } = await supabase
      .from('area_price_data')
      .select('*')
      .eq('area', area)
      .single();
    
    // Calculate yields
    const grossYield = (annualRent / purchasePrice) * 100;
    
    const costs = (serviceCharges || 0) + (annualRent * (managementFee || 0) / 100);
    const netIncome = annualRent - costs;
    const netYield = (netIncome / purchasePrice) * 100;
    
    // Compare to area average
    const areaAvgYield = marketData?.avg_rental_yield || 6.0;
    const yieldComparison = netYield > areaAvgYield ? 'above' : 'below';
    
    res.json({
      grossYield: parseFloat(grossYield.toFixed(2)),
      netYield: parseFloat(netYield.toFixed(2)),
      annualRent,
      costs,
      netIncome,
      purchasePrice,
      areaAvgYield,
      yieldComparison,
      pricePerSqft: Math.round(purchasePrice / size),
    });
  } catch (err) {
    console.error('Error calculating yield:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
