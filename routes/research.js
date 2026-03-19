const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { runResearch, syncResearchRun } = require('../services/phantom');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const DEFAULT_SOURCES = ['facebook', 'reddit', 'dubizzle', 'propertyfinder', 'linkedin', 'bayut', 'instagram', 'x', 'tiktok'];

// GET /api/research - List user's research runs
router.get('/', async (req, res) => {
  try {
    const { userId } = req.query;
    
    const { data, error } = await supabase
      .from('research_runs')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('Error fetching research runs:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/research/:id - Get specific research run with events
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const { data: run, error: runError } = await supabase
      .from('research_runs')
      .select('*')
      .eq('id', id)
      .single();
    
    if (runError) throw runError;
    
    const { data: events, error: eventsError } = await supabase
      .from('feed_events')
      .select('*')
      .eq('research_id', id)
      .order('created_at', { ascending: true });
    
    if (eventsError) throw eventsError;
    
    const { data: leads, error: leadsError } = await supabase
      .from('leads')
      .select('*')
      .eq('research_id', id)
      .order('score', { ascending: false });
    
    if (leadsError) throw leadsError;
    
    res.json({ ...run, events: events || [], leads: leads || [] });
  } catch (err) {
    console.error('Error fetching research run:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/research - Start new research run
router.post('/', async (req, res) => {
  try {
    const { userId, query, sources, filters } = req.body;
    
    // Create research run record
    const { data: run, error: runError } = await supabase
      .from('research_runs')
      .insert({
        user_id: userId,
        query,
        sources: sources || DEFAULT_SOURCES,
        filters: filters || {},
        status: 'pending',
      })
      .select()
      .single();
    
    if (runError) throw runError;
    
    // Start research in background
    runResearch(run.id, userId, query, sources, filters).catch(console.error);
    
    res.json({ success: true, researchId: run.id });
  } catch (err) {
    console.error('Error starting research:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/research/:id/sync - Reconcile a run with the latest Manus task status
router.post('/:id/sync', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await syncResearchRun(id);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Error syncing research run:', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/research/:id/cancel - Cancel research run
router.patch('/:id/cancel', async (req, res) => {
  try {
    const { id } = req.params;
    
    const { error } = await supabase
      .from('research_runs')
      .update({ status: 'cancelled', completed_at: new Date().toISOString() })
      .eq('id', id);
    
    if (error) throw error;
    
    res.json({ success: true });
  } catch (err) {
    console.error('Error cancelling research:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
