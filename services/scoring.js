const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Rate limiting: max 5 concurrent scoring requests
const MAX_CONCURRENT = 5;
let activeRequests = 0;
const requestQueue = [];

// Score a lead using Claude across 5 dimensions
async function scoreLeadWithClaude(lead, researchQuery) {
  // If no API key, return default scoring
  if (!process.env.ANTHROPIC_API_KEY) {
    return calculateDefaultScore(lead);
  }

  // Rate limiting
  if (activeRequests >= MAX_CONCURRENT) {
    await new Promise(resolve => requestQueue.push(resolve));
  }

  activeRequests++;

  try {
    const result = await scoreWithRetry(lead, researchQuery);
    return result;
  } finally {
    activeRequests--;
    // Process next queued request
    const next = requestQueue.shift();
    if (next) next();
  }
}

// Retry logic: 3 attempts with 2s delay on 529/overloaded errors
async function scoreWithRetry(lead, researchQuery, attempt = 1) {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `You are a Dubai real estate expert scoring a lead.

ORIGINAL RESEARCH QUERY: "${researchQuery}"

LEAD INFORMATION:
Name: ${lead.name || 'Unknown'}
Post/Message: "${lead.post_quote || 'No content'}"
Contact available: ${[lead.phone, lead.email, lead.whatsapp].filter(Boolean).join(', ') || 'none'}
Location mentioned: ${lead.location_preference?.join(', ') || 'not specified'}
Budget mentioned: ${lead.budget_min ? `AED ${lead.budget_min}-${lead.budget_max}` : 'not specified'}
Timeline: ${lead.move_timeline || 'not specified'}
Lead type: ${lead.lead_type || 'unknown'}

Score this lead on each dimension (0-20 each):
1. Intent: How clearly do they want to transact?
2. Budget: How specific and realistic is their budget?
3. Timeline: How urgent is their need?
4. Contact Quality: How reachable are they?
5. Location Fit: How specifically did they name Dubai locations?

Respond ONLY as JSON:
{
  "score_intent": 0-20,
  "score_budget": 0-20,
  "score_timeline": 0-20,
  "score_contact": 0-20,
  "score_location": 0-20,
  "score_reasons": "2-3 sentence explanation of the scores",
  "ai_summary": "3-4 sentence professional summary of this lead"
}`
      }]
    });

    // Try to parse JSON response
    let result;
    try {
      result = JSON.parse(response.content[0].text);
    } catch (parseError) {
      // Try to extract JSON from text with regex
      const jsonMatch = response.content[0].text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        result = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('Could not parse JSON from response');
      }
    }

    const total = result.score_intent + result.score_budget + result.score_timeline + result.score_contact + result.score_location;
    
    return {
      ...lead,
      score: total,
      score_label: getScoreLabel(total),
      score_intent: result.score_intent,
      score_budget: result.score_budget,
      score_timeline: result.score_timeline,
      score_contact: result.score_contact,
      score_location: result.score_location,
      score_reasons: result.score_reasons,
      ai_summary: result.ai_summary,
    };
  } catch (error) {
    // Retry on 529 (overloaded) or rate limit errors
    if (attempt < 3 && (error.status === 529 || error.status === 429)) {
      console.log(`[Scoring] Retrying attempt ${attempt + 1} after 2s delay...`);
      await new Promise(resolve => setTimeout(resolve, 2000));
      return scoreWithRetry(lead, researchQuery, attempt + 1);
    }
    
    console.error('Error scoring with Claude:', error);
    return calculateDefaultScore(lead);
  }
}

// Calculate default score when Claude API is not available
function calculateDefaultScore(lead) {
  let score_intent = 10;
  let score_budget = 10;
  let score_timeline = 10;
  let score_contact = 10;
  let score_location = 10;

  // Intent scoring
  if (lead.lead_type && lead.lead_type !== 'unknown') score_intent = 16;
  if (lead.post_quote) {
    const urgentWords = ['urgent', 'asap', 'immediately', 'looking for', 'need', 'want'];
    if (urgentWords.some(w => lead.post_quote.toLowerCase().includes(w))) {
      score_intent = Math.min(20, score_intent + 3);
    }
  }

  // Budget scoring
  if (lead.budget_min && lead.budget_max) {
    score_budget = 18;
  } else if (lead.budget_min || lead.budget_max) {
    score_budget = 14;
  }

  // Timeline scoring
  if (lead.move_timeline) {
    if (lead.move_timeline === 'immediate') score_timeline = 20;
    else if (lead.move_timeline === '1_month') score_timeline = 16;
    else if (lead.move_timeline === '3_months') score_timeline = 12;
    else score_timeline = 10;
  }

  // Contact scoring
  const contacts = [lead.phone, lead.email, lead.whatsapp].filter(Boolean).length;
  if (contacts >= 2) score_contact = 18;
  else if (contacts === 1) score_contact = 14;

  // Location scoring
  if (lead.location_preference?.length > 0) {
    score_location = Math.min(20, 12 + lead.location_preference.length * 2);
  }

  const total = score_intent + score_budget + score_timeline + score_contact + score_location;

  return {
    ...lead,
    score: total,
    score_label: getScoreLabel(total),
    score_intent,
    score_budget,
    score_timeline,
    score_contact,
    score_location,
    score_reasons: 'Auto-scored based on available lead information.',
    ai_summary: `${lead.lead_type || 'Potential client'} interested in ${lead.location_preference?.join(', ') || 'Dubai'} properties.`,
  };
}

// Get score label based on total score
function getScoreLabel(total) {
  if (total >= 80) return 'hot';
  if (total >= 60) return 'warm';
  if (total >= 40) return 'cold';
  return 'low';
}

module.exports = { scoreLeadWithClaude };
