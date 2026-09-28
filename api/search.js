export const maxDuration = 60;

export default async function handler(req,res){
  if(req.method!=="POST") return res.status(405).json({error:"Method not allowed"});
  if(!process.env.PARALLEL_API_KEY) return res.status(503).json({error:"Live search provider credential is not configured on the server"});
  try{
    const q=String(req.body?.query||"").trim();
    if(!q) return res.status(400).json({error:"Query required"});

    const queries=buildQueries(q);
    async function providerSearch(objective, search_queries, max_results){
      const response=await fetch("https://api.parallel.ai/v1/search",{
        method:"POST",
        headers:{
          "Authorization":"Bearer "+process.env.PARALLEL_API_KEY,
          "Content-Type":"application/json"
        },
        body:JSON.stringify({
          objective,
          search_queries,
          advanced_settings:{max_results}
        })
      });
      const raw=await response.text();
      let data;
      try{data=JSON.parse(raw)}catch{
        throw new Error("Research provider returned non-JSON: "+raw.slice(0,500));
      }
      if(!response.ok) throw new Error(data?.error?.message||data?.message||raw.slice(0,500));
      return extractResults(data);
    }

    // Run distinct evidence searches. This is intentional: a single broad search
    // tends to over-return clinical/SEO pages and under-return firsthand discussions.
    const communityQueries=queries.filter(x=>/site:agingcare|site:reddit|site:myparkinsons|forum|caregiver experience|firsthand/i.test(x));
    const clinicalQueries=queries.filter(x=>/clinical|systematic review|orthostatic|medication timing/i.test(x));
    const publicQueries=[
      q+" caregiver experience Parkinson's AARP",
      q+" Parkinson's caregiver experience Reddit",
      q+" Parkinson's caregiver story NPR AARP patient experience",
      q+" Parkinson's rehabilitation patient caregiver discussion forum"
    ];

    const searches=[
      providerSearch(
        "Find FIRSTHAND patient or caregiver discussions about the specific caregiving problem. Prioritize discussion threads and Q&A where an individual describes what happened, what was tried, and what the outcome was. Prefer AgingCare, Reddit Parkinson's communities, Parkinson's forums, and other patient/caregiver discussion communities. Do NOT return general medical guides, clinic marketing, or generic educational pages unless needed as a last resort.",
        communityQueries.length?communityQueries:[q+" caregiver firsthand experience"],
        12
      ),
      providerSearch(
        "Find high-quality clinical evidence and patient-organization guidance relevant to the question. Prioritize systematic reviews, clinical practice guidelines, PubMed/NIH, major academic medical centers, Parkinson's Foundation, and Movement Disorder Society. This is the verification/context layer, not the lived-experience layer.",
        clinicalQueries.length?clinicalQueries:[q+" clinical evidence"],
        12
      ),
      providerSearch(
        "Find broader public-facing reporting and firsthand discussion relevant to the caregiving question. Include reputable general-public sources such as AARP, NPR, major newspapers or magazines, and Reddit patient/caregiver discussions when relevant. Prefer articles or threads that contain concrete experiences, practical observations, or caregiver perspectives. Do not substitute generic clinic marketing for firsthand experience.",
        publicQueries,
        10
      ),
      providerSearch(
        "Return ONLY individual Reddit discussion pages from reddit.com relevant to this question. Prefer r/Parkinsons and r/ParkinsonsCaregivers. Look for people describing actual experiences with PT, rehabilitation, weakness, mobility, caregiving, falls, or stalled progress. Do not return subreddit landing pages or generic medical pages.",
        [
          "site:reddit.com/r/Parkinsons "+q,
          "site:reddit.com/r/ParkinsonsCaregivers "+q,
          'site:reddit.com/r/Parkinsons "physical therapy" Parkinson\'s',
          'site:reddit.com/r/ParkinsonsCaregivers rehabilitation Parkinson\'s'
        ],
        6
      ),
      providerSearch(
        "Return ONLY AARP articles relevant to this caregiving question, preferably firsthand caregiver stories or practical reporting about Parkinson's, rehabilitation, physical therapy, hospital-to-rehab transitions, mobility, or caregiving. Do not return non-AARP pages.",
        [
          "site:aarp.org/caregiving Parkinson's rehabilitation caregiver",
          "site:aarp.org/caregiving Parkinson's physical therapy caregiver",
          "site:aarp.org/caregiving hospital rehab Parkinson's caregiver",
          "site:aarp.org/caregiving mobility Parkinson's caregiver"
        ],
        6
      )
    ];
    const settled=await Promise.allSettled(searches);
    const [communityResults,clinicalResults,generalResults,redditResults,aarpResults]=settled.map(x=>x.status==="fulfilled"?x.value:[]);
    const searchFailures=settled.filter(x=>x.status==="rejected").length;
        const results=[...redditResults,...aarpResults,...communityResults,...generalResults,...clinicalResults].map(normalizeResult).filter(x=>x.url);
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
    // Keep the lived-experience layer visible even when the provider returns many
    // clinical pages. Up to 10 community sources, then clinical verification, then other context.
    const reddit=deduped.filter(x=>x.domain==="reddit.com");
    const aarp=deduped.filter(x=>x.domain==="aarp.org");
    const selected=diversifyByDomain([
      ...reddit,
      ...aarp,
      ...community,
      ...other,
      ...clinical
    ],18);

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
        reddit_sources:selected.filter(x=>x.domain==="reddit.com").length,
        aarp_sources:selected.filter(x=>x.domain==="aarp.org").length,
        public_sources:selected.filter(x=>x.type==="journalism").length,
        domains,
        search_failures:searchFailures
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
  if(/agingcare\.com|reddit\.com|myparkinsons\.org|parkinsonssupport|parkinsonsforum|patient.?forum|caregiver.?forum/.test(h))return "community";
  if(/parkinson\.org|lbda|movementdisorders\.org/.test(h))return "patient_org";
  if(/pubmed|nih\.gov|ncbi\.nlm|mayoclinic|hopkinsmedicine|stanford\.edu|neuropt\.org|apta\.org|\.edu\//.test(h))return "clinical";
  if(/reuters|nytimes|washingtonpost|aarp|statnews|npr\.org|apnews|bbc|theatlantic|time\.com|usatoday|forbes|bloomberg/.test(h))return "journalism";
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
