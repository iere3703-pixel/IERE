const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const VALID_ROLES = new Set(['owner', 'admin', 'member', 'viewer']);

// GET /api/team - Get team info and members
router.get('/', async (req, res) => {
  try {
    const { userId } = req.query;
    
    // Get user's profile to find team
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('team_id, team_role')
      .eq('id', userId)
      .single();
    
    if (profileError || !profile?.team_id) {
      return res.json({ team: null, members: [], invites: [] });
    }
    
    // Get team details
    const { data: team, error: teamError } = await supabase
      .from('teams')
      .select('*')
      .eq('id', profile.team_id)
      .single();
    
    if (teamError) throw teamError;
    
    // Get team members
    const { data: members, error: membersError } = await supabase
      .from('profiles')
      .select('id, full_name, email, avatar_url, team_role, created_at')
      .eq('team_id', profile.team_id);
    
    if (membersError) throw membersError;
    
    // Get pending invites
    const { data: invites, error: invitesError } = await supabase
      .from('team_invites')
      .select('*')
      .eq('team_id', profile.team_id)
      .eq('accepted', false)
      .gt('expires_at', new Date().toISOString());
    
    res.json({ team, members: members || [], invites: invites || [] });
  } catch (err) {
    console.error('Error fetching team:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/team - Create new team
router.post('/', async (req, res) => {
  try {
    const { userId, name } = req.body;

    if (!userId || !name) {
      return res.status(400).json({ error: 'userId and name required' });
    }
    
    // Create team
    const { data: team, error: teamError } = await supabase
      .from('teams')
      .insert({ name, owner_id: userId })
      .select()
      .single();
    
    if (teamError) throw teamError;
    
    // Update user's profile
    const { error: profileError } = await supabase
      .from('profiles')
      .update({ team_id: team.id, team_role: 'owner' })
      .eq('id', userId);
    
    if (profileError) throw profileError;
    
    res.json(team);
  } catch (err) {
    console.error('Error creating team:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/team/invite - Send team invite
router.post('/invite', async (req, res) => {
  try {
    const { teamId, invitedBy, userId, email, role } = req.body;

    const inviterId = invitedBy || userId;
    if (!teamId || !inviterId || !email) {
      return res.status(400).json({ error: 'teamId, userId(invitedBy), and email required' });
    }
    if (role && !VALID_ROLES.has(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    
    // Check if invite already exists
    const { data: existingInvite } = await supabase
      .from('team_invites')
      .select('*')
      .eq('team_id', teamId)
      .eq('email', email)
      .eq('accepted', false)
      .single();
    
    if (existingInvite) {
      return res.status(400).json({ error: 'Invite already sent to this email' });
    }
    
    const { data: invite, error } = await supabase
      .from('team_invites')
      .insert({
        team_id: teamId,
        invited_by: inviterId,
        email,
        role: role || 'member',
      })
      .select()
      .single();
    
    if (error) throw error;
    
    // Send invite email via Resend if configured
    if (process.env.RESEND_API_KEY) {
      try {
        const { Resend } = require('resend');
        const resend = new Resend(process.env.RESEND_API_KEY);
        
        const inviteUrl = `${process.env.APP_URL || 'http://localhost:3000'}/join?token=${invite.token}`;
        
        await resend.emails.send({
          from: process.env.FROM_EMAIL || 'invites@iere.ae',
          to: email,
          subject: 'You have been invited to join a team on IERE',
          html: `
            <h2>Team Invitation</h2>
            <p>You have been invited to join a team on IERE Intelligence Platform.</p>
            <p>Click the link below to accept the invitation:</p>
            <a href="${inviteUrl}" style="padding: 12px 24px; background: #F59E0B; color: #050E1A; text-decoration: none; border-radius: 8px;">Accept Invitation</a>
            <p>This link will expire in 7 days.</p>
          `,
        });
      } catch (emailError) {
        console.error('Failed to send invite email:', emailError);
        // Don't fail the request if email fails
      }
    }
    
    res.json({ success: true, invite });
  } catch (err) {
    console.error('Error sending invite:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/team/join - Accept team invite
router.post('/join', async (req, res) => {
  try {
    const { token, userId } = req.body;

    if (!token || !userId) {
      return res.status(400).json({ error: 'token and userId required' });
    }
    
    // Validate token
    const { data: invite, error: inviteError } = await supabase
      .from('team_invites')
      .select('*')
      .eq('token', token)
      .single();
    
    if (inviteError || !invite) {
      return res.status(404).json({ error: 'Invalid invite token' });
    }
    
    if (invite.accepted) {
      return res.status(400).json({ error: 'Invite already accepted' });
    }
    
    if (new Date(invite.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Invite has expired' });
    }
    
    // Update user's profile
    const { error: profileError } = await supabase
      .from('profiles')
      .update({ team_id: invite.team_id, team_role: invite.role })
      .eq('id', userId);
    
    if (profileError) throw profileError;
    
    // Mark invite as accepted
    await supabase
      .from('team_invites')
      .update({ accepted: true })
      .eq('id', invite.id);
    
    // Get team details
    const { data: team } = await supabase
      .from('teams')
      .select('*')
      .eq('id', invite.team_id)
      .single();
    
    res.json({ success: true, team });
  } catch (err) {
    console.error('Error joining team:', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/team/members/:id - Update member role
router.patch('/members/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { role } = req.body;

    if (!VALID_ROLES.has(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    
    const { data, error } = await supabase
      .from('profiles')
      .update({ team_role: role })
      .eq('id', id)
      .select()
      .single();
    
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('Error updating member:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/team/members/:id - Remove member
router.delete('/members/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.query;

    if (!userId) {
      return res.status(400).json({ error: 'userId required' });
    }

    const { data: requester, error: requesterError } = await supabase
      .from('profiles')
      .select('team_id, team_role')
      .eq('id', userId)
      .single();

    if (requesterError) throw requesterError;
    if (!requester?.team_id || requester.team_role !== 'owner') {
      return res.status(403).json({ error: 'Only team owner can remove members' });
    }

    const { data: target, error: targetError } = await supabase
      .from('profiles')
      .select('team_id, team_role')
      .eq('id', id)
      .single();

    if (targetError) throw targetError;
    if (target.team_id !== requester.team_id) {
      return res.status(400).json({ error: 'Member is not in your team' });
    }
    if (target.team_role === 'owner') {
      return res.status(400).json({ error: 'Cannot remove team owner' });
    }
    
    const { error } = await supabase
      .from('profiles')
      .update({ team_id: null, team_role: null })
      .eq('id', id);
    
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('Error removing member:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/team/leads/auto-assign - Auto-assign leads
router.post('/leads/auto-assign', async (req, res) => {
  try {
    const { teamId } = req.body;
    
    // Get team members
    const { data: members } = await supabase
      .from('profiles')
      .select('id')
      .eq('team_id', teamId)
      .in('team_role', ['owner', 'admin', 'member']);
    
    if (!members || members.length === 0) {
      return res.status(400).json({ error: 'No team members found' });
    }
    
    // Get unassigned leads
    const { data: unassignedLeads } = await supabase
      .from('leads')
      .select('id')
      .eq('team_id', teamId)
      .is('assigned_to', null);
    
    if (!unassignedLeads || unassignedLeads.length === 0) {
      return res.json({ assigned: 0 });
    }
    
    // Distribute leads evenly
    let assignedCount = 0;
    for (let i = 0; i < unassignedLeads.length; i++) {
      const member = members[i % members.length];
      
      const { error } = await supabase
        .from('leads')
        .update({ assigned_to: member.id })
        .eq('id', unassignedLeads[i].id);
      
      if (!error) assignedCount++;
    }
    
    res.json({ assigned: assignedCount });
  } catch (err) {
    console.error('Error auto-assigning leads:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/team/performance - Get team performance stats
router.get('/performance', async (req, res) => {
  try {
    const { teamId } = req.query;
    
    // Get team members
    const { data: members } = await supabase
      .from('profiles')
      .select('id, full_name')
      .eq('team_id', teamId);
    
    if (!members) {
      return res.json([]);
    }
    
    // Get stats for each member
    const performance = await Promise.all(
      members.map(async (member) => {
        const { data: leads } = await supabase
          .from('leads')
          .select('status')
          .eq('assigned_to', member.id);
        
        const stats = {
          id: member.id,
          name: member.full_name,
          totalAssigned: leads?.length || 0,
          contacted: leads?.filter(l => ['contacted', 'qualified', 'proposal', 'converted'].includes(l.status)).length || 0,
          qualified: leads?.filter(l => ['qualified', 'proposal', 'converted'].includes(l.status)).length || 0,
          converted: leads?.filter(l => l.status === 'converted').length || 0,
        };
        
        stats.conversionRate = stats.totalAssigned > 0
          ? ((stats.converted / stats.totalAssigned) * 100).toFixed(1)
          : 0;
        
        return stats;
      })
    );
    
    res.json(performance);
  } catch (err) {
    console.error('Error fetching performance:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
