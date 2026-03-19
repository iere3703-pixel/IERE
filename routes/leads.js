const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const VALID_STATUSES = new Set(['new', 'contacted', 'qualified', 'proposal', 'converted', 'archived']);

// GET /api/leads - List leads with filters
router.get('/', async (req, res) => {
  try {
    const { userId, teamId, status, source, assignedTo, search, limit = 50 } = req.query;
    
    let query = supabase
      .from('leads')
      .select('*')
      .order('score', { ascending: false })
      .limit(parseInt(limit));
    
    if (userId) {
      query = query.eq('user_id', userId);
    }
    
    if (teamId) {
      query = query.eq('team_id', teamId);
    }
    
    if (status && status !== 'all') {
      query = query.eq('status', status);
    }
    
    if (source && source !== 'all') {
      query = query.eq('source_platform', source);
    }
    
    if (assignedTo) {
      query = query.eq('assigned_to', assignedTo);
    }
    
    if (search) {
      query = query.or(`name.ilike.%${search}%,email.ilike.%${search}%,phone.ilike.%${search}%`);
    }
    
    const { data, error } = await query;
    
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('Error fetching leads:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/leads/:id - Get single lead
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const { data, error } = await supabase
      .from('leads')
      .select('*')
      .eq('id', id)
      .single();
    
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('Error fetching lead:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/leads/:id/activity - Get lead activity log
router.get('/:id/activity', async (req, res) => {
  try {
    const { id } = req.params;
    
    const { data, error } = await supabase
      .from('lead_activity')
      .select('*')
      .eq('lead_id', id)
      .order('created_at', { ascending: false });
    
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('Error fetching lead activity:', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/leads/:id - Update lead
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    
    const { data, error } = await supabase
      .from('leads')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();
    
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('Error updating lead:', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/leads/:id/status - Update lead status
router.patch('/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, userId } = req.body;

    if (!VALID_STATUSES.has(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    
    // Get current status for activity log
    const { data: currentLead, error: currentLeadError } = await supabase
      .from('leads')
      .select('status, user_id')
      .eq('id', id)
      .single();

    if (currentLeadError) throw currentLeadError;
    
    const oldStatus = currentLead?.status;
    
    const { data, error } = await supabase
      .from('leads')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();
    
    if (error) throw error;
    
    // Log activity
    await supabase.from('lead_activity').insert({
      lead_id: id,
      user_id: userId || currentLead?.user_id || null,
      action: 'status_change',
      detail: { from: oldStatus, to: status },
    });
    
    res.json(data);
  } catch (err) {
    console.error('Error updating lead status:', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/leads/:id/assign - Assign lead to team member
router.patch('/:id/assign', async (req, res) => {
  try {
    const { id } = req.params;
    const { assignedTo, userId } = req.body;

    if (!assignedTo) {
      return res.status(400).json({ error: 'assignedTo required' });
    }
    
    const { data, error } = await supabase
      .from('leads')
      .update({ assigned_to: assignedTo, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();
    
    if (error) throw error;
    
    // Log activity
    await supabase.from('lead_activity').insert({
      lead_id: id,
      user_id: userId || data?.user_id || null,
      action: 'assigned',
      detail: { assigned_to: assignedTo },
    });
    
    res.json(data);
  } catch (err) {
    console.error('Error assigning lead:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/leads/:id/note - Add note to lead
router.post('/:id/note', async (req, res) => {
  try {
    const { id } = req.params;
    const { note, userId } = req.body;

    if (typeof note !== 'string') {
      return res.status(400).json({ error: 'note must be a string' });
    }
    
    const { data, error } = await supabase
      .from('leads')
      .update({ notes: note, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();
    
    if (error) throw error;
    
    // Log activity
    await supabase.from('lead_activity').insert({
      lead_id: id,
      user_id: userId || data?.user_id || null,
      action: 'note_added',
      detail: { note },
    });
    
    res.json(data);
  } catch (err) {
    console.error('Error adding note:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/leads/:id/send-whatsapp - Send WhatsApp message via Twilio
router.post('/:id/send-whatsapp', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId, body } = req.body;
    
    // Get lead details
    const { data: lead, error: leadError } = await supabase
      .from('leads')
      .select('*')
      .eq('id', id)
      .single();
    
    if (leadError || !lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }
    
    if (!lead.whatsapp) {
      return res.status(400).json({ error: 'Lead has no WhatsApp number' });
    }
    
    // Check if Twilio is configured
    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
      return res.status(503).json({ error: 'WhatsApp not configured' });
    }
    
    // Send via Twilio
    const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    
    const message = await twilio.messages.create({
      from: process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886',
      to: `whatsapp:${lead.whatsapp}`,
      body: body || lead.ai_draft_whatsapp || 'Hello, I saw your inquiry about Dubai real estate.',
    });
    
    // Log activity
    await supabase.from('lead_activity').insert({
      lead_id: id,
      user_id: userId || lead.user_id || null,
      action: 'whatsapp_sent',
      detail: { message_sid: message.sid },
    });
    
    // Update lead status to contacted if new
    if (lead.status === 'new') {
      await supabase
        .from('leads')
        .update({ status: 'contacted', updated_at: new Date().toISOString() })
        .eq('id', id);
    }
    
    res.json({ success: true, messageSid: message.sid });
  } catch (err) {
    console.error('Error sending WhatsApp:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/leads/:id/send-email - Send email via Resend
router.post('/:id/send-email', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId, subject, text } = req.body;
    
    // Get lead details
    const { data: lead, error: leadError } = await supabase
      .from('leads')
      .select('*')
      .eq('id', id)
      .single();
    
    if (leadError || !lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }
    
    if (!lead.email) {
      return res.status(400).json({ error: 'Lead has no email address' });
    }
    
    // Check if Resend is configured
    if (!process.env.RESEND_API_KEY) {
      return res.status(503).json({ error: 'Email not configured' });
    }
    
    // Send via Resend
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);
    
    const finalSubject = subject || `Property opportunity for you in ${lead.location_preference?.[0] || 'Dubai'}`;
    const finalText = text || lead.ai_draft_email || 'Hello, I saw your inquiry about Dubai real estate.';
    
    const { data, error } = await resend.emails.send({
      from: process.env.FROM_EMAIL || 'noreply@iere.ae',
      to: lead.email,
      subject: finalSubject,
      text: finalText,
    });
    
    if (error) throw error;
    
    // Log activity
    await supabase.from('lead_activity').insert({
      lead_id: id,
      user_id: userId || lead.user_id || null,
      action: 'email_sent',
      detail: { email_id: data?.id },
    });
    
    // Update lead status to contacted if new
    if (lead.status === 'new') {
      await supabase
        .from('leads')
        .update({ status: 'contacted', updated_at: new Date().toISOString() })
        .eq('id', id);
    }
    
    res.json({ success: true, emailId: data?.id });
  } catch (err) {
    console.error('Error sending email:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/leads/:id - Archive/delete lead
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const { error } = await supabase
      .from('leads')
      .update({ status: 'archived', updated_at: new Date().toISOString() })
      .eq('id', id);
    
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('Error archiving lead:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
