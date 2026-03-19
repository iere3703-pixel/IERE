const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// GET /api/analytics - Get all analytics for user
router.get('/', async (req, res) => {
  try {
    const { userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ error: 'userId required' });
    }
    
    const { data: leads, error: leadsError } = await supabase
      .from('leads')
      .select('source_platform, score, status, created_at')
      .eq('user_id', userId);

    if (leadsError) throw leadsError;
    
    const sourceStats = {};
    leads?.forEach((lead) => {
      const source = lead.source_platform || 'unknown';
      if (!sourceStats[source]) {
        sourceStats[source] = { count: 0, totalScore: 0 };
      }
      sourceStats[source].count++;
      sourceStats[source].totalScore += lead.score || 0;
    });
    
    const leads_by_source = Object.entries(sourceStats)
      .map(([source_platform, stats]) => ({
        source_platform,
        count: stats.count,
        avg_score: Math.round(stats.totalScore / stats.count),
      }))
      .sort((a, b) => b.count - a.count);
    
    // Score distribution
    const score_distribution = {
      hot: leads?.filter((l) => (l.score || 0) >= 80).length || 0,
      warm: leads?.filter((l) => (l.score || 0) >= 60 && (l.score || 0) < 80).length || 0,
      cold: leads?.filter((l) => (l.score || 0) >= 40 && (l.score || 0) < 60).length || 0,
      low: leads?.filter((l) => (l.score || 0) < 40).length || 0,
    };
    
    // Status funnel
    const statusCounts = {};
    leads?.forEach((lead) => {
      const status = lead.status || 'new';
      statusCounts[status] = (statusCounts[status] || 0) + 1;
    });

    const status_funnel = Object.entries(statusCounts).map(([status, count]) => ({
      status,
      count,
    }));
    
    // Conversion rate
    const total_count = leads?.length || 0;
    const converted_count = statusCounts['converted'] || 0;
    const conversion_rate = total_count > 0 ? (converted_count / total_count) * 100 : 0;
    
    // Weekly leads trend (last 7 days)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    
    const weeklyTrend = {};
    for (let i = 6; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateKey = date.toISOString().split('T')[0];
      weeklyTrend[dateKey] = 0;
    }
    
    leads
      ?.filter((l) => !!l.created_at && new Date(l.created_at) >= sevenDaysAgo)
      .forEach((lead) => {
        const dateKey = new Date(lead.created_at).toISOString().split('T')[0];
      if (weeklyTrend[dateKey] !== undefined) {
        weeklyTrend[dateKey]++;
      }
    });
    
    const weekly_leads = Object.entries(weeklyTrend).map(([date, count]) => ({
      date,
      count,
    }));
    
    // Research performance
    const { data: researchData, error: researchError } = await supabase
      .from('research_runs')
      .select('query, leads_found, avg_score, duration_seconds, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(10);

    if (researchError) throw researchError;
    
    const research_performance = researchData?.map((run) => ({
      query: run.query,
      leads_found: run.leads_found,
      avg_score: run.avg_score,
      duration_seconds: run.duration_seconds,
    })) || [];

    res.json({
      leads_by_source,
      score_distribution,
      status_funnel,
      weekly_leads,
      conversion_rate,
      research_performance,
    });
  } catch (err) {
    console.error('Error fetching analytics:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
