// Generate realistic mock leads for demo mode
function generateMockLeads(query, sources) {
  const mockLeads = [
    {
      name: 'Khalid Al-Mansouri',
      username: 'khalid.dubai',
      phone: '+971501112222',
      whatsapp: '+971501112222',
      email: 'khalid.am@outlook.com',
      source_platform: 'facebook',
      source_group: 'Dubai Property Seekers',
      source_url: 'https://facebook.com/groups/dubai-property/12345',
      post_quote: 'Looking for a 3 bedroom villa in Arabian Ranches, budget up to 6M AED. Moving in July. Serious buyer, can close quickly.',
      post_date: new Date(Date.now() - 86400000).toISOString(),
      lead_type: 'buyer',
      property_type: 'villa',
      location_preference: ['Arabian Ranches'],
      budget_min: 5000000,
      budget_max: 6000000,
      move_timeline: '3_months',
      is_direct_owner: false,
    },
    {
      name: 'Emma Williams',
      username: 'emma.w.dxb',
      phone: '+971552223333',
      whatsapp: '+971552223333',
      email: null,
      source_platform: 'reddit',
      source_group: 'r/dubaihousing',
      source_url: 'https://reddit.com/r/dubaihousing/comments/xyz',
      post_quote: 'Tenant looking for 1BR in Business Bay, max 90k/year. Relocating for work. Need to move by end of April.',
      post_date: new Date(Date.now() - 172800000).toISOString(),
      lead_type: 'tenant',
      property_type: 'apartment',
      location_preference: ['Business Bay'],
      budget_min: 80000,
      budget_max: 90000,
      move_timeline: '1_month',
      is_direct_owner: false,
    },
    {
      name: 'Raj Patel',
      username: 'raj.investor',
      phone: '+971503334444',
      whatsapp: null,
      email: 'raj.patel@investment.com',
      source_platform: 'linkedin',
      source_group: 'Dubai Real Estate Investors',
      source_url: 'https://linkedin.com/posts/raj-patel',
      post_quote: 'Seeking off-plan investment opportunities in Dubai Creek Harbour and MBR City. Budget 2-3M AED. Looking for 8%+ ROI.',
      post_date: new Date(Date.now() - 259200000).toISOString(),
      lead_type: 'investor',
      property_type: 'apartment',
      location_preference: ['Dubai Creek Harbour', 'Mohammed Bin Rashid City'],
      budget_min: 2000000,
      budget_max: 3000000,
      move_timeline: 'flexible',
      is_direct_owner: false,
    },
    {
      name: 'Fatima Hassan',
      username: 'fatima.h.2024',
      phone: '+971554445555',
      whatsapp: '+971554445555',
      email: 'fatima.h@gmail.com',
      source_platform: 'dubizzle',
      source_group: 'Dubizzle Listings',
      source_url: 'https://dubizzle.com/property/67890',
      post_quote: 'Selling my 2BR apartment in Downtown Dubai. Full Burj Khalifa view. Asking 3.2M AED. Direct owner, no agents please.',
      post_date: new Date(Date.now() - 432000000).toISOString(),
      lead_type: 'seller',
      property_type: 'apartment',
      location_preference: ['Downtown Dubai'],
      budget_min: 3200000,
      budget_max: 3200000,
      move_timeline: 'immediate',
      is_direct_owner: true,
    },
    {
      name: 'Omar Al-Rashid',
      username: 'omar.ar',
      phone: '+971505556666',
      whatsapp: '+971505556666',
      email: 'omar@alrashid.ae',
      source_platform: 'propertyfinder',
      source_group: 'Property Finder',
      source_url: 'https://propertyfinder.ae/en/search/abcde',
      post_quote: 'Looking for commercial retail space in DIFC or Business Bay. 500-800 sqft. Budget 150k/year. Opening a cafe.',
      post_date: new Date(Date.now() - 345600000).toISOString(),
      lead_type: 'buyer',
      property_type: 'commercial',
      location_preference: ['DIFC', 'Business Bay'],
      budget_min: 120000,
      budget_max: 150000,
      move_timeline: '3_months',
      is_direct_owner: false,
    },
    {
      name: 'Lisa Chen',
      username: 'lisa.chen.hk',
      phone: '+971556667777',
      whatsapp: '+971556667777',
      email: 'lisa.chen@hkproperty.com',
      source_platform: 'facebook',
      source_group: 'Expats in Dubai - Housing',
      source_url: 'https://facebook.com/groups/expats-dubai/54321',
      post_quote: 'Family of 4 looking for 3BR in Dubai Hills or Mirdif. Budget 2M AED. Need good schools nearby. Moving in August.',
      post_date: new Date(Date.now() - 518400000).toISOString(),
      lead_type: 'buyer',
      property_type: 'apartment',
      location_preference: ['Dubai Hills Estate', 'Mirdif'],
      budget_min: 1800000,
      budget_max: 2000000,
      move_timeline: '3_months',
      is_direct_owner: false,
    },
    {
      name: 'Mohammed Al-Farsi',
      username: 'malfarsi',
      phone: '+971507778888',
      whatsapp: null,
      email: 'm.alfarsi@realestate.ae',
      source_platform: 'reddit',
      source_group: 'r/dubai',
      source_url: 'https://reddit.com/r/dubai/comments/lmn',
      post_quote: 'Landlord with multiple units in JVC. Looking for reliable tenants. 1BR from 55k, 2BR from 75k. Direct deals only.',
      post_date: new Date(Date.now() - 604800000).toISOString(),
      lead_type: 'landlord',
      property_type: 'apartment',
      location_preference: ['JVC'],
      budget_min: 55000,
      budget_max: 90000,
      move_timeline: 'immediate',
      is_direct_owner: true,
    },
  ];

  // Filter leads based on query keywords
  const queryLower = (query || '').toLowerCase();
  const relevantLeads = mockLeads.filter(lead => {
    const searchText = `${lead.name} ${lead.post_quote} ${lead.location_preference?.join(' ')} ${lead.lead_type}`.toLowerCase();
    
    // If query mentions specific locations, filter by those
    const locationMatches = ['business bay', 'downtown', 'marina', 'jvc', 'palm', 'difc', 'arabian ranches']
      .filter(loc => queryLower.includes(loc));
    
    if (locationMatches.length > 0) {
      return locationMatches.some(loc => searchText.includes(loc));
    }
    
    // If query mentions specific lead types, filter by those
    const typeMatches = ['buyer', 'seller', 'tenant', 'landlord', 'investor']
      .filter(type => queryLower.includes(type));
    
    if (typeMatches.length > 0) {
      return typeMatches.some(type => lead.lead_type === type);
    }
    
    // Otherwise return all leads
    return true;
  });

  // Return 3-5 relevant leads
  const count = Math.min(relevantLeads.length, Math.floor(Math.random() * 3) + 3);
  return relevantLeads.slice(0, count);
}

module.exports = { generateMockLeads };
