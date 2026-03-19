const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const { runResearch } = require('../services/phantom');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Runs every minute to check for due schedules
function startAutopilotWorker() {
  console.log('[AutoPilot Worker] Starting...');
  
  cron.schedule('* * * * *', async () => {
    try {
      const now = new Date();
      
      // Find schedules that are due
      const { data: dueSchedules, error } = await supabase
        .from('autopilot_schedules')
        .select('*')
        .eq('enabled', true)
        .lte('next_run_at', now.toISOString());
      
      if (error) {
        console.error('[AutoPilot Worker] Error fetching schedules:', error);
        return;
      }
      
      if (!dueSchedules || dueSchedules.length === 0) {
        return;
      }
      
      console.log(`[AutoPilot Worker] Found ${dueSchedules.length} due schedules`);
      
      for (const schedule of dueSchedules) {
        try {
          console.log(`[AutoPilot Worker] Running schedule: ${schedule.name}`);
          
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
              
              const leadsFound = researchRun?.leads_found || 0;
              
              // Calculate next run time
              const nextRun = calculateNextRun(
                schedule.frequency,
                schedule.run_at_hour,
                schedule.run_on_days
              );
              
              // Update schedule
              await supabase
                .from('autopilot_schedules')
                .update({
                  last_run_at: now.toISOString(),
                  next_run_at: nextRun.toISOString(),
                  total_runs: schedule.total_runs + 1,
                  total_leads_found: schedule.total_leads_found + leadsFound,
                })
                .eq('id', schedule.id);
              
              console.log(`[AutoPilot Worker] Schedule ${schedule.name} completed, found ${leadsFound} leads`);
              
              // Send completion email notification
              await sendCompletionEmail(schedule, leadsFound);
            })
            .catch(err => {
              console.error(`[AutoPilot Worker] Research failed for schedule ${schedule.id}:`, err);
            });
          
        } catch (err) {
          console.error(`[AutoPilot Worker] Error processing schedule ${schedule.id}:`, err);
        }
      }
      
    } catch (err) {
      console.error('[AutoPilot Worker] Error:', err);
    }
  });
  
  console.log('[AutoPilot Worker] Started successfully');
}

// Send completion email notification
async function sendCompletionEmail(schedule, leadsFound) {
  if (!process.env.RESEND_API_KEY) return;
  
  try {
    // Get user email
    const { data: profile } = await supabase
      .from('profiles')
      .select('email')
      .eq('id', schedule.user_id)
      .single();
    
    if (!profile?.email) return;
    
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);
    
    await resend.emails.send({
      from: process.env.FROM_EMAIL || 'alerts@iere.ae',
      to: profile.email,
      subject: `Auto-Pilot: ${schedule.name} completed`,
      html: `
        <h2>Auto-Pilot Run Complete</h2>
        <p>Your scheduled research "${schedule.name}" has completed.</p>
        <p><strong>${leadsFound}</strong> new leads were found.</p>
        <a href="${process.env.APP_URL || 'http://localhost:3000'}/leads" 
           style="padding: 12px 24px; background: #F59E0B; color: #050E1A; text-decoration: none; border-radius: 8px;">
          View New Leads
        </a>
      `,
    });
    
    // Create notification
    await supabase.from('notifications').insert({
      user_id: schedule.user_id,
      type: 'autopilot_complete',
      title: 'Auto-Pilot completed',
      message: `"${schedule.name}" found ${leadsFound} new leads`,
    });
  } catch (error) {
    console.error('[AutoPilot Worker] Failed to send completion email:', error);
  }
}

// Calculate next run time based on schedule
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
  if ((frequency === 'weekly' || frequency === 'twice_weekly') && days?.length > 0) {
    while (!days.includes(next.getDay())) {
      next.setDate(next.getDate() + 1);
    }
  }
  
  return next;
}

module.exports = { startAutopilotWorker };
