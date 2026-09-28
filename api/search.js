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
        advanced_settings:{max_results:24}
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
    const domains=[...new Set(deduped.map(x=>x.domain).filter(Boolean))];

    return res.status(200).json({
      question:q,
      research_branches:buildBranches(q),
      sources:deduped.slice(0,30),
      source_stats:{total:deduped.length,independent_domains:domains.length,domains},
      search_queries:queries
    });
  }catch(e){
    return res.status(500).json({error:"Research failed",detail:String(e).slice(0,900)});
  }
}

function buildQueries(q){
  return [
    q,
    q+" caregiver patient experience what helped",
    q+" Parkinson's rehabilitation physical therapy caregiver",
    q+" Parkinson's orthostatic hypotension medication timing fatigue rehabilitation",
    q+" nursing home skilled nursing rehabilitation Parkinson's caregiver experience"
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
