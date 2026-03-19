const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// POST /api/webhooks/supabase - Handle Supabase webhooks
router.post('/supabase', async (req, res) => {
  try {
    const event = req.body;
    
    console.log('Received Supabase webhook:', event.type);
    
    // Handle different event types
    switch (event.type) {
      case 'INSERT':
        if (event.table === 'leads') {
          await handleNewLead(event.record);
        }
        break;
      case 'UPDATE':
        if (event.table === 'research_runs' && event.record.status === 'completed') {
          await handleResearchComplete(event.record);
        }
        break;
      default:
        console.log('Unhandled webhook type:', event.type);
    }
    
    res.json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/webhooks/twilio - Handle Twilio WhatsApp
router.post('/twilio', async (req, res) => {
  try {
    const { From, Body, MessageSid } = req.body;
    
    console.log('Received WhatsApp message:', { from: From, body: Body });
    
    // Extract phone number (remove whatsapp: prefix)
    const phoneNumber = From.replace('whatsapp:', '');
    
    // Find lead by phone or whatsapp
    const { data: lead, error } = await supabase
      .from('leads')
      .select('*')
      .eq('whatsapp', phoneNumber)
      .single();
    
    if (error || !lead) {
      console.log('No lead found for phone:', phoneNumber);
      return res.json({ received: true });
    }
    
    // Log activity
    await supabase.from('lead_activity').insert({
      lead_id: lead.id,
      user_id: lead.user_id,
      action: 'whatsapp_received',
      detail: { message: Body, message_sid: MessageSid },
    });
    
    // Update lead status to contacted if new
    if (lead.status === 'new') {
      await supabase
        .from('leads')
        .update({ status: 'contacted', updated_at: new Date().toISOString() })
        .eq('id', lead.id);
    }
    
    // Send acknowledgment for hot leads (score >= 70)
    if ((lead.score || 0) >= 70 && process.env.TWILIO_ACCOUNT_SID) {
      try {
        const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
        await twilio.messages.create({
          from: process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886',
          to: From,
          body: "Thanks for your message! Our agent will follow up shortly.",
        });
      } catch (twilioError) {
        console.error('Failed to send acknowledgment:', twilioError);
      }
    }
    
    res.json({ received: true });
  } catch (err) {
    console.error('Twilio webhook error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Handle new lead - send WhatsApp if score >= 80
async function handleNewLead(lead) {
  if ((lead.score || 0) >= 80 && lead.whatsapp && process.env.TWILIO_ACCOUNT_SID) {
    try {
      const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      
      await twilio.messages.create({
        from: process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886',
        to: `whatsapp:${lead.whatsapp}`,
        body: lead.ai_draft_whatsapp || 'Hello! Thank you for your interest in Dubai real estate.',
      });
      
      // Log activity
      await supabase.from('lead_activity').insert({
        lead_id: lead.id,
        user_id: lead.user_id,
        action: 'whatsapp_sent_auto',
        detail: { trigger: 'high_score', score: lead.score },
      });
      
      // Create notification
      await supabase.from('notifications').insert({
        user_id: lead.user_id,
        type: 'lead_found',
        title: 'New hot lead found',
        message: `A new hot lead (${lead.score}/100) was found and contacted automatically.`,
        lead_id: lead.id,
      });
    } catch (error) {
      console.error('Failed to auto-send WhatsApp:', error);
    }
  }
}

// Handle research complete - send email summary
async function handleResearchComplete(run) {
  if (!process.env.RESEND_API_KEY) return;
  
  try {
    // Best-effort: profiles.email if present, otherwise skip.
    const { data: profile } = await supabase
      .from('profiles')
      .select('email')
      .eq('id', run.user_id)
      .single();

    if (!profile?.email) return;
    
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);
    
    const subject = run.autopilot_id 
      ? 'Your Auto-Pilot run is complete'
      : 'Your research run is complete';
    
    const html = `
      <h2>Research Complete</h2>
      <p>Your query: "${run.query}"</p>
      <p>Found <strong>${run.leads_found}</strong> qualified leads</p>
      <p>Average score: ${run.avg_score}/100</p>
      <p>Duration: ${run.duration_seconds}s</p>
      <a href="${process.env.APP_URL || 'http://localhost:3000'}/leads" 
         style="padding: 12px 24px; background: #F59E0B; color: #050E1A; text-decoration: none; border-radius: 8px;">
        View Leads
      </a>
    `;
    
    await resend.emails.send({
      from: process.env.FROM_EMAIL || 'alerts@iere.ae',
      to: profile.email,
      subject,
      html,
    });
    
    // Create notification
    await supabase.from('notifications').insert({
      user_id: run.user_id,
      type: 'research_complete',
      title: 'Research completed',
      message: `Found ${run.leads_found} new leads`,
      research_id: run.id,
    });
  } catch (error) {
    console.error('Failed to send completion email:', error);
  }
}

module.exports = router;
