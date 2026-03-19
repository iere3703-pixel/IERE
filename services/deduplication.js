const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Generate a hash for deduplication
function generateLeadHash(lead) {
  // Hash based on the most stable identifiers
  const components = [
    lead.phone?.replace(/\D/g, '') || '',
    lead.email?.toLowerCase() || '',
    lead.source_url || '',
    (lead.name || lead.username || '').toLowerCase().trim(),
  ].filter(Boolean);
  
  if (components.length === 0) return null;
  
  return crypto
    .createHash('sha256')
    .update(components.sort().join('|'))
    .digest('hex')
    .substring(0, 32);
}

// Filter out duplicate leads
async function filterDuplicates(leads, userId) {
  const mapped = leads.map(l => ({ lead: l, hash: generateLeadHash(l) }));
  const hashes = mapped.filter(x => x.hash !== null);
  const withoutHash = mapped
    .filter(x => x.hash === null)
    .map(x => x.lead);

  if (hashes.length === 0) return { unique: leads, duplicateCount: 0 };

  // Check existing hashes in DB
  const { data: existing } = await supabase
    .from('leads')
    .select('dedup_hash')
    .eq('user_id', userId)
    .in('dedup_hash', hashes.map(x => x.hash));

  const existingSet = new Set((existing || []).map(r => r.dedup_hash));
  
  const unique = hashes
    .filter(x => !existingSet.has(x.hash))
    .map(x => ({ ...x.lead, dedup_hash: x.hash }))
    .concat(withoutHash);

  const duplicateCount = leads.length - unique.length;
  
  return { unique, duplicateCount };
}

// Check if a single lead is duplicate
async function isDuplicate(lead, userId) {
  const hash = generateLeadHash(lead);
  if (!hash) return false;

  const { data } = await supabase
    .from('leads')
    .select('id')
    .eq('user_id', userId)
    .eq('dedup_hash', hash)
    .maybeSingle();

  return !!data;
}

module.exports = { filterDuplicates, generateLeadHash, isDuplicate };
