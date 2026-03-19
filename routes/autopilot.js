const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { runResearch } = require('../services/phantom');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const DEFAULT_SOURCES = ['facebook', 'reddit', 'dubizzle', 'propertyfinder', 'linkedin', 'bayut', 'instagram', 'x', 'tiktok'];

// GET /api/autopilot - List user's schedules
router.get('/', async (req, res) => {
  try {
    const { userId } = req.query;
    
    const { data, error } = await supabase
      .from('autopilot_schedules')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('Error fetching autopilot schedules:', err);
    res.status(500).json({ error: err.message });
  }
});
// Get / api / autopilot / : id - Get schedule details 
// router.get('async /:id, async (req, res)')

// POST /api/autopilot - Create new schedule
router.post('/', async (req, res) => {
  try {
    const { userId, teamId, name, query, sources, filters, frequency, runAtHour, runOnDays } = req.body;
    
    // Calculate next run time
    const nextRunAt = calculateNextRun(frequency, runAtHour || 8, runOnDays);
    
    const { data, error } = await supabase
      .from('autopilot_schedules')
      .insert({
        user_id: userId,
        team_id: teamId,
        name,
        query,
        sources: sources || DEFAULT_SOURCES,
        filters: filters || {},
        frequency,
        run_at_hour: runAtHour || 8,
        run_on_days: runOnDays || [],
        next_run_at: nextRunAt.toISOString(),
      })
      .select()
      .single();
    
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('Error creating autopilot schedule:', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/autopilot/:id - Update schedule
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    
    // Recalculate next run if frequency or time changed
    if (updates.frequency || updates.runAtHour !== undefined) {
      const { data: schedule } = await supabase
        .from('autopilot_schedules')
        .select('frequency, run_at_hour, run_on_days')
        .eq('id', id)
        .single();
      
      if (schedule) {
        updates.next_run_at = calculateNextRun(
          updates.frequency || schedule.frequency,
          updates.runAtHour !== undefined ? updates.runAtHour : schedule.run_at_hour,
          updates.runOnDays || schedule.run_on_days
        ).toISOString();
      }
    }
    
    // const updates = recalcuate next run if frequency or time changed 
    const { data, error } = await supabase
      .from('autopilot_schedules')
      .update(updates)
      .eq('id', id)
      .select()
      .single();
    
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('Error updating autopilot schedule:', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/autopilot/:id/toggle - Toggle schedule enabled status
router.patch('/:id/toggle', async (req, res) => {
  try {
    const { id } = req.params;
    const { enabled } = req.body;
    
    const updates = { enabled };
    
// If enabling, recalculate next_run_at

  if (enabled) {
      const { data: schedule } = await supabase
        .from('autopilot_schedules')
        .select('frequency, run_at_hour, run_on_days')
        .eq('id', id)
        .single();
      
      if (schedule) {
        updates.next_run_at = calculateNextRun(
          schedule.frequency,
          schedule.run_at_hour,
          schedule.run_on_days
        ).toISOString();
      }
    }
    
    const { data, error } = await supabase
      .from('autopilot_schedules')
      .update(updates)
      .eq('id', id)
      .select()
      .single();
    
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('Error toggling autopilot schedule:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/autopilot/:id - Delete schedule
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const { error } = await supabase
      .from('autopilot_schedules')
      .delete()
      .eq('id', id);
    
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting autopilot schedule:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/autopilot/:id/run - Run schedule immediately
router.post('/:id/run', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Get schedule details
    const { data: schedule, error } = await supabase
      .from('autopilot_schedules')
      .select('*')
      .eq('id', id)
      .single();
    
    if (error) throw error;
    
    // Create research run
    const { data: run, error: runError } = await supabase
      .from('research_runs')
      .insert({
        user_id: schedule.user_id,
        team_id: schedule.team_id,
        query: schedule.query,
        sources: schedule.sources,
        filters: schedule.filters,
        autopilot_id: schedule.id,
        status: 'pending',
      })
      .select()
      .single();
    
    if (runError) throw runError;
    
    // Start research in background
    runResearch(run.id, schedule.user_id, schedule.query, schedule.sources, schedule.filters)
      .then(async () => {
        // Get updated lead count
        const { data: researchRun } = await supabase
          .from('research_runs')
          .select('leads_found')
          .eq('id', run.id)
          .single();
        
        // Update schedule stats
        await supabase
          .from('autopilot_schedules')
          .update({
            last_run_at: new Date().toISOString(),
            next_run_at: calculateNextRun(schedule.frequency, schedule.run_at_hour, schedule.run_on_days).toISOString(),
            total_runs: schedule.total_runs + 1,
            total_leads_found: schedule.total_leads_found + (researchRun?.leads_found || 0),
          })
          .eq('id', id);
      })
      .catch(console.error);
    
    res.json({ success: true, researchId: run.id });
  } catch (err) {
    console.error('Error running autopilot schedule:', err);
    res.status(500).json({ error: err.message });
  }
});

// Calculate next run time based on schedule
// Next_run_at is stored in UTC schedule.total_run 
function calculateNextRun(frequency, hour, days) {
  const now = new Date();
  const next = new Date(now);
  
  // Convert UAE hour (UTC+4) to UTC
  next.setUTCHours(hour - 4, 0, 0, 0);
  
  // If time has passed today, move to next day
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }
  
  // For weekly schedules, find next matching day
  // days is an array of integer, find next matching day of week 
  if ((frequency === 'weekly' || frequency === 'twice_weekly') && days?.length > 0) {
    while (!days.includes(next.getDay())) {
      next.setDate(next.getDate() + 1);
    }
  }
  
  return next;
}


module.exports = router;
