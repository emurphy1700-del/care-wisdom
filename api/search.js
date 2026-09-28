export const maxDuration = 60;

export default async function handler(req,res){
  if(req.method!=="POST") return res.status(405).json({error:"Method not allowed"});
  if(!process.env.PARALLEL_API_KEY) return res.status(503).json({error:"Live search provider credential is not configured on the server"});
  try{
    const q=String(req.body?.query||"").trim();
    if(!q) return res.status(400).json({error:"Query required"});

    const queries=buildQueries(q);
    const response=await fetch("https://api.parallel.ai/v1/search",{
      method:"POST",
      headers:{
        "Authorization":"Bearer "+process.env.PARALLEL_API_KEY,
        "Content-Type":"application/json"
      },
      body:JSON.stringify({
        objective:"Find high-value sources for a caregiving research question. Prioritize genuinely independent patient/caregiver lived-experience discussions and high-quality clinical or patient-organization context. Return source titles, URLs, domains, publication dates when available, and concise excerpts. Do not synthesize or diagnose.",
        search_queries:queries,
        advanced_settings:{max_results:40}
      })
    });
    const raw=await response.text();
    let data;
    try{data=JSON.parse(raw)}catch{
      return res.status(502).json({error:"Research provider returned a non-JSON response",detail:raw.slice(0,900)});
    }
    if(!response.ok){
      return res.status(502).json({error:"Research provider rejected the request",detail:data?.error?.message||data?.message||raw.slice(0,900)});
    }

    const results=extractResults(data).map(normalizeResult).filter(x=>x.url);
    const deduped=[]; const seen=new Set();
    for(const x of results){
      const key=canonical(x.url);
      if(!key||seen.has(key)) continue;
      seen.add(key); deduped.push({...x,url:key});
    }

    // Deliberately protect space for the kind of evidence Care Wisdom is built around:
    // firsthand caregiver/patient discussions. Clinical sources are then used as a check,
    // not allowed to crowd the lived-experience pool out of the result set.
    const community=deduped.filter(x=>x.type==="community");
    const clinical=deduped.filter(x=>x.type==="clinical"||x.type==="patient_org");
    const other=deduped.filter(x=>x.type==="journalism"||x.type==="other");
    const selected=diversifyByDomain([...community,...clinical,...other],18);

    const domains=[...new Set(selected.map(x=>x.domain).filter(Boolean))];

    return res.status(200).json({
      question:q,
      research_branches:buildBranches(q),
      sources:selected,
      source_stats:{
        total:selected.length,
        independent_domains:domains.length,
        lived_experience_sources:community.length,
        selected_lived_experience_sources:selected.filter(x=>x.type==="community").length,
        domains
      },
      search_queries:queries
    });
  }catch(e){
    return res.status(500).json({error:"Research failed",detail:String(e).slice(0,900)});
  }
}

function buildQueries(q){
  return [
    q,
    q+" Parkinson's caregiver firsthand experience what helped",
    "site:agingcare.com Parkinson's physical therapy rehabilitation caregiver experience",
    "site:reddit.com/r/Parkinsons Parkinson's physical therapy rehabilitation progress caregiver",
    "site:myparkinsons.org Parkinson's caregiver forum physical therapy rehabilitation",
    "Parkinson's caregiver forum rehabilitation stalled progress physical therapy",
    q+" Parkinson's orthostatic hypotension medication timing fatigue rehabilitation",
    q+" Parkinson's physical therapy clinical guideline systematic review",
    "Parkinson's rehabilitation nursing home caregiver experience"
  ].map(x=>x.slice(0,240));
}
function buildBranches(q){
  const lower=q.toLowerCase();
  const b=[
    ["What barriers are people actually encountering?","Look for recurring patient and caregiver descriptions rather than assuming a cause."],
    ["What does the clinical literature say may explain the problem?","Compare lived experience with clinical guidance and research."],
    ["Could symptoms, timing, or day-to-day fluctuations be affecting the outcome?","Check relevant motor, non-motor, medication, fatigue, blood-pressure, or cognitive factors."],
    ["What changes when care happens in a rehabilitation or nursing setting?","Look for facility routines, staffing, communication, and functional-goal issues when relevant."],
    ["Where do reports disagree?","Preserve conflicting experiences and uncertainty instead of choosing a winner."]
  ];
  if(/toilet|transfer|hoyer|snf|nursing|rehab|physical therapy|pt/.test(lower)){
    b.splice(3,0,["What are care teams observing outside the therapy session?","Consider nursing, OT, transfers, toileting, falls, vital signs, and functional performance across the day."]);
  }
  return b.slice(0,6).map(([name,why])=>({name,why}));
}
function extractResults(data){
  const candidates=data?.results||data?.search_results||data?.items||data?.data||[];
  return Array.isArray(candidates)?candidates:[];
}
function normalizeResult(x){
  const url=x?.url||x?.link||x?.source_url||"";
  const title=x?.title||x?.name||url;
  const excerpts=Array.isArray(x?.excerpts)?x.excerpts:(typeof x?.excerpt==="string"?[x.excerpt]:typeof x?.snippet==="string"?[x.snippet]:[]);
  return {
    title,url,domain:domainOf(url),
    published_date:x?.publish_date||x?.published_date||null,
    excerpts:excerpts.slice(0,3).map(String),
    type:guessType(url,title)
  };
}
function canonical(u){try{const x=new URL(u);["utm_source","utm_medium","utm_campaign","utm_term","utm_content","fbclid","gclid","mc_cid","mc_eid"].forEach(k=>x.searchParams.delete(k));x.hash="";return x.origin+x.pathname.replace(/\/$/,"")}catch{return ""}}
function domainOf(url){try{return new URL(url).hostname.replace(/^www\./,"")}catch{return ""}}
function guessType(url,title){
  const h=(url+" "+title).toLowerCase();
  if(/reddit|agingcare|forum|community|discussion|caregiver|patient.?story/.test(h))return "community";
  if(/parkinson\.org|lbda|movementdisorders\.org/.test(h))return "patient_org";
  if(/pubmed|nih\.gov|ncbi\.nlm|mayoclinic|hopkinsmedicine|stanford\.edu|neuropt\.org|apta\.org|\.edu\//.test(h))return "clinical";
  if(/reuters|nytimes|washingtonpost|aarp|statnews|npr\.org/.test(h))return "journalism";
  return "other";
}


function diversifyByDomain(items,max){
  const out=[],used=new Set();
  // First pass: one result per domain, preserving the evidence-class priority above.
  for(const x of items){
    if(out.length>=max)break;
    if(!x.domain||used.has(x.domain))continue;
    used.add(x.domain);out.push(x);
  }
  // Second pass: fill remaining slots when a domain has multiple genuinely useful pages.
  for(const x of items){
    if(out.length>=max)break;
    if(out.some(y=>canonical(y.url)===canonical(x.url)))continue;
    out.push(x);
  }
  return out;
}
