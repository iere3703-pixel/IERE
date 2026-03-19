const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Generate AI draft messages for a lead
async function generateDraftMessages(lead) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return generateDefaultDrafts(lead);
  }

  try {
    const response = await anthropic.messages.create({
      model: 'claude-3-sonnet-20240229',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `You are a professional Dubai real estate agent writing personalized messages to a lead.

LEAD INFORMATION:
Name: ${lead.name || 'Unknown'}
Type: ${lead.lead_type || 'potential client'}
Interested in: ${lead.location_preference?.join(', ') || 'Dubai properties'}
Budget: ${lead.budget_min ? `AED ${lead.budget_min}-${lead.budget_max}` : 'Not specified'}
Timeline: ${lead.move_timeline || 'Not specified'}
Their message: "${lead.post_quote || ''}"

Write two personalized messages:
1. A WhatsApp message (short, friendly, professional)
2. An email (slightly more formal)

Respond ONLY as JSON:
{
  "ai_draft_whatsapp": "...",
  "ai_draft_email": "..."
}`
      }]
    });

    return JSON.parse(response.content[0].text);
  } catch (error) {
    console.error('Error generating drafts:', error);
    return generateDefaultDrafts(lead);
  }
}

// Generate default drafts when API is not available
function generateDefaultDrafts(lead) {
  const name = lead.name || 'there';
  const location = lead.location_preference?.[0] || 'Dubai';
  const type = lead.lead_type || 'client';
  
  const whatsappTemplates = [
    `Hi ${name}, I saw your inquiry about ${location}. I have some great options that match what you're looking for. Can we schedule a quick call?`,
    `Hello ${name}, I'm a Dubai real estate specialist. I'd love to help you find the perfect property in ${location}. When are you free to chat?`,
    `Hi ${name}, thanks for reaching out about ${location}! I have several listings that might interest you. Would you like to see some options?`,
  ];
  
  const emailTemplates = [
    `Dear ${name},

Thank you for your interest in ${location} properties. As a Dubai real estate specialist, I have access to exclusive listings that may match your requirements.

I'd be happy to schedule a consultation to discuss your needs in detail and show you relevant options.

Best regards`,
    `Hello ${name},

I noticed you're looking for properties in ${location}. I specialize in this area and have helped many clients find their ideal homes/investments.

Would you be available for a brief call this week to discuss your requirements?

Kind regards`,
  ];

  return {
    ai_draft_whatsapp: whatsappTemplates[Math.floor(Math.random() * whatsappTemplates.length)],
    ai_draft_email: emailTemplates[Math.floor(Math.random() * emailTemplates.length)],
  };
}

module.exports = { generateDraftMessages };
