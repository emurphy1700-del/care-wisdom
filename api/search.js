export const maxDuration = 60;

export default async function handler(req,res){
  if(req.method!=="POST") return res.status(405).json({error:"Method not allowed"});
  if(!process.env.PARALLEL_API_KEY) return res.status(503).json({error:"Live search provider credential is not configured on the server"});
  try{
    const q=String(req.body?.query||"").trim();
    if(!q) return res.status(400).json({error:"Query required"});

    const queries=buildQueries(q);
    async function providerSearch(objective, search_queries, max_results, include_domains){
      const response=await fetch("https://api.parallel.ai/v1/search",{
        method:"POST",
        headers:{
          "x-api-key":process.env.PARALLEL_API_KEY,
          "Content-Type":"application/json"
        },
        body:JSON.stringify({
          objective,
          search_queries:search_queries.slice(0,8),
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
    const communityQueries=[
      "site:reddit.com/r/Parkinsons/comments/ "+q+" caregiver",
      "site:reddit.com/r/ParkinsonsCaregivers/comments/ "+q+" caregiver",
      "site:agingcare.com/questions "+q+" caregiver experience",
      q+" caregiver experience what helped forum",
      q+" patient caregiver discussion what helped",
      q+" freezing standing from chair caregiver",
      "site:myparkinsons.org "+q+" forum",
      "site:parkinson.org caregiver freezing chair transfer"
    ];
    const clinicalQueries=[
      q+" clinical evidence rehabilitation",
      q+" systematic review physical therapy",
      q+" orthostatic hypotension rehabilitation"
    ];
    const publicQueries=[
      "site:aarp.org "+q+" caregiver",
      q+" caregiver story public reporting",
      q+" patient experience rehabilitation"
    ];

    const searches=[
      providerSearch(
        "Find FIRSTHAND patient or caregiver discussions about the specific caregiving problem. Prioritize discussion threads and Q&A where an individual describes what happened, what was tried, and what the outcome was. Prefer AgingCare, Reddit Parkinson's communities, Parkinson's forums, and other patient/caregiver discussion communities. Do NOT return general medical guides, clinic marketing, or generic educational pages unless needed as a last resort.",
        communityQueries,
        18
      ),
      providerSearch(
        "Find high-quality clinical evidence and patient-organization guidance relevant to the question. Prioritize systematic reviews, clinical practice guidelines, PubMed/NIH, major academic medical centers, Parkinson's Foundation, and Movement Disorder Society. This is the verification/context layer, not the lived-experience layer.",
        clinicalQueries,
        18
      ),
      providerSearch(
        "Find broader public-facing reporting and firsthand discussion relevant to the caregiving question. Include reputable general-public sources such as AARP, NPR, major newspapers or magazines, and Reddit patient/caregiver discussions when relevant. Prefer articles or threads that contain concrete experiences, practical observations, or caregiver perspectives. Do not substitute generic clinic marketing for firsthand experience.",
        publicQueries,
        18
      ),
      providerSearch(
        "Return ONLY individual Reddit discussion pages from reddit.com relevant to this question. Prefer r/Parkinsons and r/ParkinsonsCaregivers. Look for people describing actual experiences with PT, rehabilitation, weakness, mobility, caregiving, falls, or stalled progress. Do not return subreddit landing pages or generic medical pages.",
        [
          "site:reddit.com/r/Parkinsons "+q,
          "site:reddit.com/r/ParkinsonsCaregivers "+q,
          "site:reddit.com/r/Parkinsons \"freezing\" \"chair\"",
          "site:reddit.com/r/ParkinsonsCaregivers \"freezing\" \"chair\""
        ],
        10,
        ["reddit.com"]
      ),
      providerSearch(
        "Return ONLY AARP articles relevant to this caregiving question, preferably firsthand caregiver stories or practical reporting about Parkinson's, rehabilitation, physical therapy, hospital-to-rehab transitions, mobility, or caregiving. Do not return non-AARP pages.",
        [
          q+" caregiver experience physical therapy",
          q+" patient caregiver story what helped"
        ],
        8,
        []
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
    const community=deduped
      .filter(x=>x.type==="community" && isUsefulFirsthand(x))
      .filter(x=>isQuestionRelevant(x,q,2));
    const clinical=deduped
      .filter(x=>x.type==="clinical"||x.type==="patient_org")
      .filter(x=>isQuestionRelevant(x,q,1));
    const journalism=deduped
      .filter(x=>x.type==="journalism" && isUsefulPublicReporting(x))
      .filter(x=>isQuestionRelevant(x,q,1));
    // Never pad the evidence pool with navigation pages, directories, event pages,
    // generic topic hubs, or unrelated "other" results. Care Wisdom would rather
    // return 9 good sources than 18 impressive-looking but irrelevant ones.
    const reddit=community.filter(x=>x.domain==="reddit.com");
    // Build the pool in evidence order. Firsthand discussions get priority;
    // clinical context comes next; journalism is supplementary context.
    const selected=diversifyByDomain([
      ...reddit,
      ...community,
      ...clinical,
      ...journalism
    ],18);

    // Second stage: retrieve focused passages from the actual pages.
    // Parallel Extract supports batches of up to 10 URLs, so use two batches.
    let extracted=[];
    const urls=selected.map(x=>x.url).slice(0,18);
    for(let i=0;i<urls.length;i+=10){
      try{
        const er=await fetch("https://api.parallel.ai/v1/extract",{
          method:"POST",
          headers:{
            "x-api-key":process.env.PARALLEL_API_KEY,
            "Content-Type":"application/json"
          },
          body:JSON.stringify({
            urls:urls.slice(i,i+10),
            objective:"For the user's research question — "+q+" — extract only passages directly relevant to that question. For firsthand sources, extract the person's actual experience: what happened, what barrier or problem was observed, what was tried, and what happened afterward. For clinical sources, extract the specific evidence or guidance relevant to the question. Ignore navigation, marketing, generic disease definitions, unrelated material, and broad background that does not answer the question."
          })
        });
        const eraw=await er.text();
        if(er.ok){
          const ed=JSON.parse(eraw);
          if(Array.isArray(ed.results)) extracted.push(...ed.results);
        }
      }catch{}
    }
    const extractedByUrl=new Map(extracted.map(x=>[canonical(x.url),x]));
    for(const s of selected){
      const e=extractedByUrl.get(canonical(s.url));
      if(e){
        s.excerpts=(e.excerpts||s.excerpts||[]).slice(0,4).map(String);
        s.extracted=true;
      }
    }

    // Final evidence gate: a firsthand source must still contain the question's
    // substantive terms after extraction. This prevents an unrelated caregiver
    // article from becoming "evidence" merely because it came from AgingCare.
    const relevantSelected=selected.filter(s =>
      s.type!=="community" || isQuestionRelevant(s,q,2)
    );

    const domains=[...new Set(relevantSelected.map(x=>x.domain).filter(Boolean))];

    return res.status(200).json({
      question:q,
      research_branches:buildBranches(q),
      sources:relevantSelected,
      source_stats:{
        total:relevantSelected.length,
        independent_domains:domains.length,
        lived_experience_sources:community.length,
        selected_lived_experience_sources:relevantSelected.filter(x=>x.type==="community").length,
        reddit_sources:relevantSelected.filter(x=>x.domain==="reddit.com").length,
        aarp_sources:relevantSelected.filter(x=>x.domain==="aarp.org").length,
        public_sources:relevantSelected.filter(x=>x.type==="journalism").length,
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
function isUsefulFirsthand(x){
  const h=(String(x.url||"")+" "+String(x.title||"")+" "+(x.excerpts||[]).join(" ")).toLowerCase();
  const bad=/(^|\.)support\.zoom\.com|eventbrite|wikipedia\.org|dictionary|glossary|directory|webinar|workshop|landing|\/topics?\/|\/caregiving-information|\/carepartner|\/resources-support\/carepartners\/pointers|\/caregiver-forum$|\/caregiver-forum\/discussions\?/.test(h);
  if(bad)return false;
  if(x.domain==="reddit.com") return /\/r\/[^/]+\/comments\//.test(String(x.url||""));
  if(x.domain==="agingcare.com") return /\/questions\/[^/]+\.htm/.test(String(x.url||""));
  // Generic sites must contain evidence of an actual person's experience,
  // not merely the word "caregiver" in an article title.
  return /(forum|question|discussion|my (mom|dad|mother|father|husband|wife|partner)|we found|i found|in my experience|our experience|what helped us|what worked for us|we tried|i tried)/.test(h);
}
function isUsefulPublicReporting(x){
  const h=(String(x.url||"")+" "+String(x.title||"")+" "+(x.excerpts||[]).join(" ")).toLowerCase();
  return !/(directory|eventbrite|webinar|workshop|support\.zoom|wikipedia)/.test(h);
}
function guessType(url,title){
  const h=(url+" "+title).toLowerCase();
  if(/agingcare\.com|reddit\.com|myparkinsons\.org|parkinsonssupport|parkinsonsforum|patient.?forum|caregiver.?forum/.test(h))return "community";
  if(/parkinson\.org|lbda|movementdisorders\.org/.test(h))return "patient_org";
  if(/pubmed|nih\.gov|ncbi\.nlm|mayoclinic|hopkinsmedicine|stanford\.edu|neuropt\.org|apta\.org|\.edu\//.test(h))return "clinical";
  if(/reuters|nytimes|washingtonpost|aarp|statnews|npr\.org|apnews|bbc|theatlantic|time\.com|usatoday|forbes|bloomberg/.test(h))return "journalism";
  return "other";
}


function isQuestionRelevant(source, question, minHits=1){
  const stop=new Set(["what","have","has","had","when","where","why","how","does","did","can","could","would","should","someone","people","person","caregiver","caregivers","patient","patients","with","from","that","this","they","their","getting","helpful","found","tried","help","parkinsons","parkinson","disease"]);
  const qTokens=String(question||"").toLowerCase().replace(/[^a-z0-9\\s-]/g," ").split(/\\s+/).filter(w=>w.length>=4&&!stop.has(w));
  const text=[source.title||"",source.url||"",...(source.excerpts||[])].join(" ").toLowerCase();
  const unique=[...new Set(qTokens)];
  return unique.filter(w=>text.includes(w)).length>=minHits;
}

function diversifyByDomain(items,max){
  const out=[],counts=new Map(),seen=new Set();
  // First pass: maximize source-domain diversity, with a hard cap of 2
  // records from any one domain.
  for(const x of items){
    if(out.length>=max)break;
    const key=canonical(x.url);
    if(!key||seen.has(key)||!x.domain)continue;
    const count=counts.get(x.domain)||0;
    if(count>=2)continue;
    seen.add(key); counts.set(x.domain,count+1); out.push(x);
  }
  // Second pass: fill only with genuinely new domains/pages, still capped at 2.
  for(const x of items){
    if(out.length>=max)break;
    const key=canonical(x.url);
    if(!key||seen.has(key))continue;
    const count=counts.get(x.domain)||0;
    if(count>=2)continue;
    seen.add(key); counts.set(x.domain,count+1); out.push(x);
  }
  return out;
}
