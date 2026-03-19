const { createClient } = require('@supabase/supabase-js');
const { scoreLeadWithClaude } = require('./scoring');
const { filterDuplicates } = require('./deduplication');
const { generateDraftMessages } = require('./claude');
const { generateMockLeads } = require('../utils/mockData');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function getManusConfig() {
  const raw = (process.env.MANUS_API_URL || '').trim();
  const baseFromEnv = (process.env.MANUS_API_BASE_URL || '').trim();

  // Back-compat: older env used MANUS_API_URL="https://api.manus.im/v1/tasks"
  // Newer docs use base "https://api.manus.ai" + path "/v1/tasks".
  const defaultBase = 'https://api.manus.ai';

  const normalizeBase = (base) =>
    String(base || '')
      .replace('https://api.manus.im', 'https://api.manus.ai')
      .replace('http://api.manus.im', 'https://api.manus.ai')
      .replace(/\/+$/, '');

  if (baseFromEnv) {
    const base = normalizeBase(baseFromEnv);
    return {
      base,
      createTaskUrl: `${base}/v1/tasks`,
      getTaskUrl: (taskId) => `${base}/v1/tasks/${encodeURIComponent(taskId)}`,
    };
  }

  if (raw) {
    const createTaskUrl = normalizeBase(raw);
    const base = normalizeBase(raw.replace(/\/v1\/tasks\/?$/, '')) || defaultBase;
    return {
      base,
      createTaskUrl,
      getTaskUrl: (taskId) => `${base}/v1/tasks/${encodeURIComponent(taskId)}`,
    };
  }

  return {
    base: defaultBase,
    createTaskUrl: `${defaultBase}/v1/tasks`,
    getTaskUrl: (taskId) => `${defaultBase}/v1/tasks/${encodeURIComponent(taskId)}`,
  };
}

function getManusHeaders(includeJsonContentType = false) {
  const headers = {
    accept: 'application/json',
    API_KEY: `${process.env.MANUS_API_KEY}`,
  };

  if (includeJsonContentType) {
    headers['Content-Type'] = 'application/json';
  }

  return headers;
}

function createManusApiError(message, status, body) {
  const error = new Error(message);
  error.status = status;
  error.body = body || '';
  return error;
}

function isRetryableManusPollError(error) {
  const status = Number(error?.status || 0);
  const code = String(error?.code || error?.cause?.code || '').toUpperCase();
  const message = String(error?.message || '').toLowerCase();

  if (!status) {
    return (
      code === 'ECONNRESET' ||
      code === 'ECONNREFUSED' ||
      code === 'ETIMEDOUT' ||
      code === 'ENOTFOUND' ||
      code === 'EAI_AGAIN' ||
      code === 'EPIPE' ||
      message.includes('fetch failed') ||
      message.includes('network') ||
      message.includes('socket') ||
      message.includes('connection closed') ||
      message.includes('timed out') ||
      message.includes('aborted')
    );
  }

  return (
    status === 404 ||
    status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 429 ||
    status >= 500
  );
}

function normalizeManusTaskStatus(task) {
  return String(task?.status || '').toLowerCase();
}

function getResearchErrorMessage(error) {
  const rawMessage = String(error?.message || '').trim();
  const message = rawMessage.toLowerCase();

  if (message.includes('timed out')) {
    return 'Research is taking longer than expected on Manus. Use Refresh to sync the final result.';
  }

  if (isRetryableManusPollError(error)) {
    return 'Lost contact with Manus while polling. The task may still finish there. Use Refresh to sync the final result.';
  }

  if (message.includes('manus task failed')) {
    const detail = rawMessage.replace(/^manus task failed:\s*/i, '').trim();
    if (detail && detail.toLowerCase() !== 'task failed') {
      return `Manus failed the research task: ${detail}`;
    }

    return 'Manus reported that the research task failed before any results were returned. Check the Manus task and try again.';
  }

  if (message.includes('manus api error: 401') || message.includes('manus api error: 403')) {
    return 'Manus authentication failed. Check the MANUS_API_KEY and workspace access.';
  }

  if (message.includes('manus api error: 429')) {
    return 'Manus rate-limited the research request. Wait a moment and try again.';
  }

  if (message.includes('manus api error: 400')) {
    return 'Manus rejected the research request. Check the prompt or agent profile and try again.';
  }

  if (message.includes('credit balance is too low to access the anthropic api')) {
    return 'Anthropic billing is exhausted, so lead scoring and message drafts cannot be generated until credits are added.';
  }

  return 'Research encountered an error. Please try again.';
}

async function fetchManusTask(taskId) {
  const { getTaskUrl } = getManusConfig();

  const response = await fetch(getTaskUrl(taskId), {
    method: 'GET',
    headers: getManusHeaders(false),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw createManusApiError(`Manus API error: ${response.status}${body ? ` - ${body}` : ''}`, response.status, body);
  }

  try {
    return await response.json();
  } catch (error) {
    const parseError = createManusApiError('Manus API returned invalid JSON while polling task status');
    parseError.cause = error;
    throw parseError;
  }
}

async function markResearchCompleted(researchId, userId, leadsCount, options = {}) {
  const completedAt = new Date().toISOString();
  const duration = await calculateDuration(researchId, completedAt);

  await supabase
    .from('research_runs')
    .update({
      status: 'completed',
      completed_at: completedAt,
      duration_seconds: duration,
    })
    .eq('id', researchId);

  if (options.broadcast !== false) {
    await broadcastEvent(researchId, userId, {
      event_type: 'agent_complete',
      message: `Research complete! Found ${leadsCount} qualified leads.`,
    });
  }
}

async function markResearchFailed(researchId, userId, error) {
  await supabase
    .from('research_runs')
    .update({
      status: 'failed',
      completed_at: new Date().toISOString(),
    })
    .eq('id', researchId);

  await broadcastEvent(researchId, userId, {
    event_type: 'agent_error',
    message: getResearchErrorMessage(error),
  });
}

// Main research function
async function runResearch(researchId, userId, query, sources, filters) {
  console.log(`[Research ${researchId}] Starting research for user ${userId}`);
  console.log(`[Research ${researchId}] Query: ${query}`);

  try {
    await supabase
      .from('research_runs')
      .update({ status: 'running', started_at: new Date().toISOString() })
      .eq('id', researchId);

    await broadcastEvent(researchId, userId, {
      event_type: 'agent_start',
      message: 'Your AI agent is starting research...',
    });

    const hasManusKey = process.env.MANUS_API_KEY && process.env.MANUS_API_KEY.length > 10;

    let leads = [];

    if (hasManusKey) {
      leads = await runManusResearch(researchId, userId, query, sources, filters);
    } else {
      console.log(`[Research ${researchId}] No Manus API key, using mock data`);
      await broadcastEvent(researchId, userId, {
        event_type: 'agent_message',
        message: 'IERE Research Engine initialized (Demo Mode)',
      });

      await delay(1500);
      await broadcastEvent(researchId, userId, {
        event_type: 'agent_thought',
        message: 'Scanning Facebook groups for property inquiries...',
        source_platform: 'facebook',
      });

      await delay(2000);
      leads = generateMockLeads(query, sources);
    }

    const processing = await processLeads(researchId, userId, leads, query);
    await markResearchCompleted(researchId, userId, processing?.totalSavedCount || processing?.savedCount || 0);

    console.log(`[Research ${researchId}] Completed successfully`);
  } catch (error) {
    console.error(`[Research ${researchId}] Error:`, error);
    await markResearchFailed(researchId, userId, error);
  }
}

// Run actual Manus research (when API key is available)
async function runManusResearch(researchId, userId, query, sources, filters) {
  const { createTaskUrl } = getManusConfig();

  const initResponse = await fetch(createTaskUrl, {
    method: 'POST',
    headers: getManusHeaders(true),
    body: JSON.stringify({
      prompt: buildResearchPrompt(query, sources, filters),
      agentProfile: process.env.MANUS_AGENT_PROFILE || 'manus-1.6',
      interactiveMode: false,
      taskMode: 'agent',
    }),
  });

  if (!initResponse.ok) {
    const body = await initResponse.text().catch(() => '');
    throw new Error(`Manus API error: ${initResponse.status}${body ? ` - ${body}` : ''}`);
  }

  const created = await initResponse.json();
  const taskId = created?.task_id || created?.id;
  if (!taskId) {
    throw new Error('Manus API did not return task_id');
  }

  const taskUrl = created?.task_url || created?.metadata?.task_url || '';
  if (taskUrl) {
    console.log(`[Research ${researchId}] Task URL: ${taskUrl}`);
  }

  await supabase
    .from('research_runs')
    .update({ manus_task_id: taskId })
    .eq('id', researchId);

  await broadcastEvent(researchId, userId, {
    event_type: 'agent_action',
    message: 'Analyzing sources...',
  });

  const startedAt = Date.now();
  const timeoutMs = Number(process.env.MANUS_POLL_TIMEOUT_MS || 600000);
  const pollEveryMs = Number(process.env.MANUS_POLL_INTERVAL_MS || 2000);
  const maxTransientErrors = Number(process.env.MANUS_POLL_MAX_TRANSIENT_ERRORS || 8);
  let consecutivePollErrors = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Manus task timed out');
    }

    let task;
    try {
      task = await fetchManusTask(taskId);
      consecutivePollErrors = 0;
    } catch (error) {
      consecutivePollErrors += 1;

      if (isRetryableManusPollError(error) && consecutivePollErrors <= maxTransientErrors) {
        const backoffMs = Math.min(pollEveryMs * consecutivePollErrors, 15000);
        console.warn(
          `[Research ${researchId}] Poll retry ${consecutivePollErrors}/${maxTransientErrors} after transient Manus error:`,
          error?.message || error
        );
        await delay(backoffMs);
        continue;
      }

      throw error;
    }

    const status = normalizeManusTaskStatus(task);

    if (status === 'completed') {
      const leads = await extractLeadsFromTaskOutput(task?.output);
      return Array.isArray(leads) ? leads : [];
    }

    if (status === 'failed') {
      const err = task?.error || task?.incomplete_details || 'Task failed';
      throw new Error(`Manus task failed: ${err}`);
    }

    await delay(pollEveryMs);
  }
}

// Note: we intentionally do not stream assistant chat messages into feed_events.

function parseLeadsJsonBlock(text) {
  if (typeof text !== 'string') return [];

  const trimmed = text.trim();
  if (!trimmed) return [];

  const candidates = [];
  const fenced = trimmed.match(/```json\s*([\s\S]*?)\s*```/im);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  const section = trimmed.match(/LEADS_JSON[\s\S]*?(\{[\s\S]*"leads"\s*:\s*\[[\s\S]*?\][\s\S]*\})/m);
  if (section?.[1]) candidates.push(section[1]);

  const fallback = trimmed.match(/\{[\s\S]*"leads"\s*:\s*\[[\s\S]*?\][\s\S]*\}/m);
  if (fallback?.[0]) candidates.push(fallback[0]);

  candidates.push(trimmed);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed?.leads && Array.isArray(parsed.leads)) {
        return parsed.leads;
      }
    } catch (_) {}
  }

  return [];
}

async function extractLeadsFromTaskOutput(output) {
  const allText = [];
  const outputFiles = [];
  const messages = Array.isArray(output) ? output : [];

  for (const msg of messages) {
    if (msg?.role !== 'assistant') continue;
    const content = Array.isArray(msg?.content) ? msg.content : [];

    for (const item of content) {
      if (item?.type === 'output_text' && typeof item?.text === 'string') {
        allText.push(item.text);
      }

      if (item?.type === 'output_file' && typeof item?.fileUrl === 'string') {
        outputFiles.push(item.fileUrl);
      }
    }
  }

  const combined = allText.join('\n\n');
  const fromText = parseLeadsJsonBlock(combined);
  if (fromText.length > 0) {
    return fromText;
  }

  for (const fileUrl of outputFiles) {
    try {
      const response = await fetch(fileUrl);
      if (!response.ok) continue;

      const fileText = await response.text();
      const fromFile = parseLeadsJsonBlock(fileText);
      if (fromFile.length > 0) {
        return fromFile;
      }
    } catch (_) {
      // Ignore file fetch failures and fall back to any text output we have.
    }
  }

  return [];
}

function normalizePostDate(value) {
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (!trimmed || /^n\/a$/i.test(trimmed)) {
    return null;
  }

  if (/\b(ago|today|yesterday|tomorrow)\b/i.test(trimmed)) {
    return null;
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
}

function normalizeLeadForInsert(lead) {
  const asNumberOrNull = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };

  return {
    ...lead,
    post_date: normalizePostDate(lead?.post_date),
    budget_min: asNumberOrNull(lead?.budget_min),
    budget_max: asNumberOrNull(lead?.budget_max),
    location_preference: Array.isArray(lead?.location_preference)
      ? lead.location_preference.filter((item) => typeof item === 'string' && item.trim().length > 0)
      : null,
  };
}

// Process and save leads with scoring and deduplication
async function processLeads(researchId, userId, leads, query) {
  if (leads.length === 0) {
    return { savedCount: 0, uniqueCount: 0 };
  }

  await broadcastEvent(researchId, userId, {
    event_type: 'agent_message',
    message: `Analyzing ${leads.length} potential leads...`,
  });

  const scoredLeads = [];
  for (const lead of leads) {
    try {
      const scored = await scoreLeadWithClaude(lead, query);
      scoredLeads.push(scored);

      await broadcastEvent(researchId, userId, {
        event_type: 'lead_scored',
        message: `Scored lead: ${scored.score}/100`,
        source_platform: lead.source_platform,
      });
    } catch (error) {
      console.error('Error scoring lead:', error);
      scoredLeads.push({ ...lead, score: 50, score_label: 'warm' });
    }
  }

  const withDrafts = [];
  for (const lead of scoredLeads) {
    try {
      const drafts = await generateDraftMessages(lead);
      withDrafts.push({ ...lead, ...drafts });
    } catch (error) {
      console.error('Error generating drafts:', error);
      withDrafts.push(lead);
    }
  }

  const { unique, duplicateCount } = await filterDuplicates(withDrafts, userId);

  if (duplicateCount > 0) {
    await broadcastEvent(researchId, userId, {
      event_type: 'agent_message',
      message: `Skipped ${duplicateCount} duplicate lead${duplicateCount > 1 ? 's' : ''} already in your database`,
    });
  }

  let savedCount = 0;
  for (const lead of unique) {
    const leadToInsert = normalizeLeadForInsert(lead);
    const { data: savedLead, error } = await supabase
      .from('leads')
      .insert({
        user_id: userId,
        research_id: researchId,
        ...leadToInsert,
      })
      .select()
      .single();

    if (error) {
      console.error('Error saving lead:', error);
    } else {
      savedCount += 1;
      await broadcastEvent(researchId, userId, {
        event_type: 'lead_saved',
        message: `Lead saved: ${lead.name || 'Unknown'}`,
        source_platform: lead.source_platform,
        lead_id: savedLead.id,
      });
    }
  }

  const { count: totalSavedCount } = await supabase
    .from('leads')
    .select('id', { count: 'exact', head: true })
    .eq('research_id', researchId);

  const totalSaved = Number(totalSavedCount || savedCount || 0);
  const avgScore = Math.round(unique.reduce((sum, lead) => sum + (lead.score || 50), 0) / unique.length) || 0;
  await supabase
    .from('research_runs')
    .update({
      leads_found: totalSaved,
      avg_score: avgScore,
    })
    .eq('id', researchId);

  return { savedCount, uniqueCount: unique.length, totalSavedCount: totalSaved };
}

async function syncResearchRun(researchId) {
  const { data: run, error } = await supabase
    .from('research_runs')
    .select('*')
    .eq('id', researchId)
    .single();

  if (error) throw error;
  if (!run) throw new Error('Research run not found');

  if (!run.manus_task_id) {
    return { synced: false, taskStatus: null, run };
  }

  const { count: existingLeadCount } = await supabase
    .from('leads')
    .select('id', { count: 'exact', head: true })
    .eq('research_id', researchId);

  if (run.status === 'completed' && Number(existingLeadCount || 0) >= Number(run.leads_found || 0)) {
    if (Number(existingLeadCount || 0) !== Number(run.leads_found || 0)) {
      await supabase
        .from('research_runs')
        .update({ leads_found: Number(existingLeadCount || 0) })
        .eq('id', researchId);

      const { data: updatedRun } = await supabase
        .from('research_runs')
        .select('*')
        .eq('id', researchId)
        .single();

      return { synced: true, taskStatus: 'completed', run: updatedRun || { ...run, leads_found: Number(existingLeadCount || 0) } };
    }

    return { synced: false, taskStatus: 'completed', run };
  }

  const task = await fetchManusTask(run.manus_task_id);
  const taskStatus = normalizeManusTaskStatus(task);

  if (taskStatus === 'completed') {
    const leads = await extractLeadsFromTaskOutput(task?.output);
    const processing = await processLeads(run.id, run.user_id, leads, run.query);
    await markResearchCompleted(run.id, run.user_id, processing?.totalSavedCount || processing?.savedCount || 0, {
      broadcast: run.status !== 'completed',
    });

    const { data: updatedRun } = await supabase
      .from('research_runs')
      .select('*')
      .eq('id', researchId)
      .single();

    return {
      synced: true,
      taskStatus,
      leadsCount: processing?.totalSavedCount || processing?.savedCount || 0,
      run: updatedRun || {
        ...run,
        status: 'completed',
        leads_found: processing?.totalSavedCount || processing?.savedCount || 0,
      },
    };
  }

  if (taskStatus === 'failed') {
    if (run.status !== 'failed') {
      const err = task?.error || task?.incomplete_details || 'Task failed';
      await markResearchFailed(run.id, run.user_id, new Error(`Manus task failed: ${err}`));
    }

    const { data: updatedRun } = await supabase
      .from('research_runs')
      .select('*')
      .eq('id', researchId)
      .single();

    return {
      synced: run.status !== 'failed',
      taskStatus,
      run: updatedRun || { ...run, status: 'failed' },
    };
  }

  if (run.status !== 'running') {
    await supabase
      .from('research_runs')
      .update({
        status: 'running',
        completed_at: null,
      })
      .eq('id', researchId);

    await broadcastEvent(run.id, run.user_id, {
      event_type: 'agent_action',
      message: 'Reconnected to Manus. Research is still running...',
    });
  }

  const { data: updatedRun } = await supabase
    .from('research_runs')
    .select('*')
    .eq('id', researchId)
    .single();

  return {
    synced: run.status !== 'running',
    taskStatus,
    run: updatedRun || { ...run, status: 'running' },
  };
}

// Build research prompt for Manus
function buildResearchPrompt(query, sources, filters) {
  return `
You are IERE Research Engine, an AI agent specialized in finding real estate leads in Dubai.

TASK: ${query}

Search the following platforms: ${
    sources?.join(', ') ||
    'facebook, reddit, dubizzle, propertyfinder, linkedin, bayut, instagram, x, tiktok'
  }

Focus first on the selected sources above.
If strong leads are limited, expand into closely related Dubai real estate groups, channels, hashtags, comment threads, and portal communities connected to those sources.
For social platforms, search posts, comments, groups, channels, and hashtags.
Prefer direct lead-intent posts over generic market news or broad listing pages.

For each potential lead you find, extract:
- Name and username
- Contact info (phone, email, WhatsApp)
- Source platform and URL
- What they posted (exact quote)
- Lead type (buyer, seller, tenant, landlord, investor)
- Property preferences (type, location, budget)
- Timeline

As you work, narrate your progress in plain English (like a chat).

When you are done, include a final section titled "LEADS_JSON" containing a single JSON object in this format:
{
  "leads": [
    {
      "name": "...",
      "username": "...",
      "phone": "...",
      "email": "...",
      "whatsapp": "...",
      "source_platform": "facebook|reddit|dubizzle|propertyfinder|linkedin|bayut|instagram|x|tiktok",
      "source_group": "...",
      "source_url": "...",
      "post_quote": "...",
      "post_date": "...",
      "lead_type": "buyer|seller|tenant|landlord|investor",
      "property_type": "apartment|villa|townhouse",
      "location_preference": ["Business Bay", "Downtown"],
      "budget_min": 1000000,
      "budget_max": 2000000,
      "move_timeline": "immediate|1_month|3_months|flexible"
    }
  ]
}

Focus on leads with clear intent and contact information. Be thorough but efficient.
`;
}

// Translate Manus thoughts to IERE language
function translateThought(content) {
  return content
    .replace(/manus/gi, 'IERE Research Engine')
    .replace(/scraping/gi, 'scanning')
    .replace(/bot/gi, 'agent')
    .replace(/crawling/gi, 'monitoring');
}

// Detect platform from content
function detectPlatform(content) {
  const lower = (content || '').toLowerCase();
  const patterns = [
    ['facebook', /\bfacebook\b/],
    ['reddit', /\breddit\b/],
    ['dubizzle', /\bdubizzle\b/],
    ['propertyfinder', /\bproperty\s*finder\b|\bpropertyfinder\b/],
    ['linkedin', /\blinkedin\b/],
    ['bayut', /\bbayut\b/],
    ['instagram', /\binstagram\b/],
    ['x', /\b(?:twitter|x\.com)\b/],
    ['tiktok', /\btiktok\b/],
  ];

  const match = patterns.find(([, pattern]) => pattern.test(lower));
  return match?.[0] || null;
}

// Parse leads from Manus output
function parseLeadsFromOutput(output) {
  try {
    if (typeof output === 'string') {
      const parsed = JSON.parse(output);
      return parsed.leads || [];
    }
    return output.leads || [];
  } catch (error) {
    console.error('Error parsing leads:', error);
    return [];
  }
}

// Broadcast event to Supabase realtime
async function broadcastEvent(researchId, userId, data) {
  try {
    await supabase.from('feed_events').insert({
      research_id: researchId,
      user_id: userId,
      event_type: data.event_type,
      message: data.message,
      source_platform: data.source_platform || null,
      lead_id: data.lead_id || null,
    });
  } catch (error) {
    console.error('Error broadcasting event:', error);
  }
}

// Calculate research duration
async function calculateDuration(researchId, completedAt = null) {
  const { data } = await supabase
    .from('research_runs')
    .select('started_at, completed_at')
    .eq('id', researchId)
    .single();

  const endTime = completedAt || data?.completed_at;
  if (data?.started_at && endTime) {
    return Math.round((new Date(endTime) - new Date(data.started_at)) / 1000);
  }

  return 0;
}

// Utility delay function
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { runResearch, syncResearchRun };
