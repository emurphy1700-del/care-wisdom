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
        console.warn("Research provider returned non-JSON; skipping this search:", raw.slice(0,300));
        return [];
      }
      if(!response.ok){
        console.warn("Research provider search failed; skipping:", response.status, data?.error?.message||data?.message||raw.slice(0,300));
        return [];
      }
      return extractResults(data);
    }

    async function discoverRedditViaSearchPages(question){
  const lower=String(question||"").toLowerCase();
  const q=/freez|stuck/.test(lower) ? "freezing transfers" : String(question||"").slice(0,180);
  const found=new Map();

  for(const subreddit of ["ParkinsonsCaregivers","Parkinsons"]){
    const urls=[
      "https://www.reddit.com/r/"+subreddit+"/search.rss?q="+encodeURIComponent(q)+"&restrict_sr=1&sort=relevance&t=all",
      "https://old.reddit.com/r/"+subreddit+"/search.rss?q="+encodeURIComponent(q)+"&restrict_sr=1&sort=relevance&t=all"
    ];
    let xml="";
    for(const u of urls){
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),7000);
      try{
        const rr=await fetch(u,{
          headers:{
            "User-Agent":"Mozilla/5.0 (compatible; CareWisdomResearch/1.0; +https://care-wisdom.vercel.app)",
            "Accept":"application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8"
          },
          signal:controller.signal
        });
        if(rr.ok){
          const candidate=await rr.text();
          if(candidate.includes("<entry>")){ xml=candidate; break; }
        }
      }catch{}finally{
        clearTimeout(timer);
      }
    }
    if(!xml) continue;
    try{
      const entries=xml.split("<entry>").slice(1);

      for(const block of entries){
        const linkMatch=block.match(/<link href="([^"]+)"/i);
        const rawUrl=linkMatch?.[1]||"";
        if(!/reddit\.com\/r\/[^/]+\/comments\//i.test(rawUrl)) continue;
        const url=canonical(rawUrl);
        if(!url) continue;

        const titleMatch=block.match(/<title>([\\s\\S]*?)<\/title>/i);
        const contentMatch=block.match(/<content[^>]*>([\\s\\S]*?)<\/content>/i);
        const title=decodeXml(titleMatch?.[1]||"Reddit caregiver discussion");
        const rawContent=decodeXml(contentMatch?.[1]||"");

        found.set(url,{
          title,
          url,
          domain:"reddit.com",
          published_date:null,
          excerpts:rawContent ? [stripHtml(rawContent).slice(0,1800)] : [],
          type:"community",
          discovery_method:"reddit_rss"
        });
      }
    }catch{}finally{
      clearTimeout(timer);
    }
  }
  return [...found.values()].slice(0,12);
}


    // Run distinct evidence searches. This is intentional: a single broad search
    // tends to over-return clinical/SEO pages and under-return firsthand discussions.
    // Use the targeted discovery queries built above for the lived-experience
    // search. The previous version accidentally built them but then ignored them.
    const communityQueries=[
      ...buildQueries(q).filter(x =>
        /reddit\.com|agingcare\.com|caregiver|carepartner|forum|freez|stuck|chair|recliner|sit to stand|transfer|getting up|what helped|what worked/i.test(x)
      ).slice(0,8)
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
      discoverRedditViaSearchPages(q),
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
          "site:reddit.com/r/Parkinsons freezing chair",
          "site:reddit.com/r/ParkinsonsCaregivers freezing chair",
          "site:reddit.com/r/ParkinsonsCaregivers freezing transfers",
          "site:reddit.com/r/Parkinsons freezing transfers",
          "site:reddit.com/r/ParkinsonsCaregivers freezing sit to stand",
          "site:reddit.com/r/Parkinsons stuck getting up"
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
    const [redditDiscoveryResults,communityResults,clinicalResults,generalResults,redditResults,aarpResults]=settled.map(x=>x.status==="fulfilled"?x.value:[]);
    let recoveryResults=[];
    let recoveryAttempts=0;
    // Adaptive recovery: if the provider did not return any Reddit/community
    // candidates, run one focused pass with simpler human-language formulations.
    if(redditResults.length===0 || communityResults.length===0){
      recoveryAttempts=1;
      const recoverySettled=await Promise.allSettled([
        providerSearch(
          "Find direct individual patient or caregiver discussion threads about this exact problem. Prefer Reddit Parkinson's communities and Parkinson's News Today forums. Return the thread itself, not a topic page or forum index. Look for concrete descriptions of what someone tried and what happened.",
          buildCommunityRecoveryQueries(q),
          14
        )
      ]);
      recoveryResults=recoverySettled[0].status==="fulfilled"?recoverySettled[0].value:[];
    }
    const searchFailures=settled.filter(x=>x.status==="rejected").length;
        const results=[...redditDiscoveryResults,...redditResults,...recoveryResults,...aarpResults,...communityResults,...generalResults,...clinicalResults].map(normalizeResult).filter(x=>x.url);
    const deduped=[]; const seen=new Set();
    for(const x of results){
      const key=canonical(x.url);
      if(!key||seen.has(key)) continue;
      seen.add(key); deduped.push({...x,url:key});
    }

    // Deliberately protect space for the kind of evidence Care Wisdom is built around:
    // firsthand caregiver/patient discussions. Clinical sources are then used as a check,
    // not allowed to crowd the lived-experience pool out of the result set.
    // Do not apply the question-relevance gate yet. Search results often have
    // thin titles/snippets; a genuinely relevant firsthand discussion may only
    // reveal its relevance after page extraction.
    const communityCandidates=deduped.filter(x=>x.type==="community");
    const communityRejections=[];
    const community=communityCandidates.filter(x=>{
      if(isUsefulFirsthand(x)) return true;
      let reason="firsthand-evidence-gate";
      const h=(String(x.url||"")+" "+String(x.title||"")+" "+(x.excerpts||[]).join(" ")).toLowerCase();
      if(x.domain==="reddit.com" && !/\/r\/[^/]+\/comments\/[^/?#]+/.test(String(x.url||""))) reason="reddit-not-individual-thread";
      else if(/\/topics?\/|\/forums\/?$|directory|webinar|workshop|landing|\/caregiving-information|\/carepartner|\/caregiver-forum/.test(h)) reason="navigation-or-topic-page";
      communityRejections.push({domain:x.domain,title:String(x.title||"").slice(0,180),url:x.url,reason});
      return false;
    });
    const clinical=deduped.filter(x=>x.type==="clinical"||x.type==="patient_org");
    const journalism=deduped.filter(x=>x.type==="journalism" && isUsefulPublicReporting(x));
    // Never pad the evidence pool with navigation pages, directories, event pages,
    // generic topic hubs, or unrelated "other" results. Care Wisdom would rather
    // return 9 good sources than 18 impressive-looking but irrelevant ones.
    const reddit=community.filter(x=>x.domain==="reddit.com");
    const communityForums=community.filter(x=>x.domain!=="reddit.com");
    // Build the pool in evidence order. Firsthand discussions get priority;
    // clinical context comes next; journalism is supplementary context.
    const selected=diversifyByDomain([
      ...reddit,
      ...communityForums,
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
        s.excerpts=(e.excerpts&&e.excerpts.length?e.excerpts:s.excerpts||[]).slice(0,4).map(cleanEvidenceText).filter(x=>x.length>=40);
        s.extracted=true;
      }
    }

    // Final evidence gate: a firsthand source must still contain the question's
    // substantive terms after extraction. This prevents an unrelated caregiver
    // article from becoming "evidence" merely because it came from AgingCare.
    const relevanceRejections=[];
    const relevantSelected=selected.filter(s => {
      let ok=false;
      if(s.type==="community") ok=isQuestionRelevant(s,q,2);
      else if(s.type==="clinical" || s.type==="patient_org") ok=isQuestionRelevant(s,q,1);
      else if(s.type==="journalism") ok=isQuestionRelevant(s,q,1);
      if(!ok) relevanceRejections.push({domain:s.domain,title:String(s.title||"").slice(0,180),url:s.url,type:s.type});
      return ok;
    });

    const domains=[...new Set(relevantSelected.map(x=>x.domain).filter(Boolean))];
    const redditAll=[...redditDiscoveryResults,...redditResults,...recoveryResults].map(normalizeResult).filter(x=>x.url);
    const redditDebug={
      discovery_candidates:redditDiscoveryResults.length,
      provider_candidates:redditResults.length,
      recovery_candidates:recoveryResults.length,
      unique_reddit_candidates:redditAll.filter(x=>x.domain==="reddit.com").length,
      unique_reddit_candidate_samples:redditAll.filter(x=>x.domain==="reddit.com").slice(0,6).map(x=>({title:String(x.title||"").slice(0,180),url:x.url,excerpt:String((x.excerpts||[])[0]||"").slice(0,500)})),
      rejected_by_firsthand_gate:communityRejections.filter(x=>x.domain==="reddit.com").length,
      firsthand_rejection_samples:communityRejections.filter(x=>x.domain==="reddit.com").slice(0,6),
      rejected_by_relevance_gate:relevanceRejections.filter(x=>x.domain==="reddit.com").length,
      relevance_rejection_samples:relevanceRejections.filter(x=>x.domain==="reddit.com").slice(0,6),
      selected_reddit:selected.filter(x=>x.domain==="reddit.com").length,
      final_reddit:relevantSelected.filter(x=>x.domain==="reddit.com").length
    };

    return res.status(200).json({
      question:q,
      research_branches:buildBranches(q),
      sources:relevantSelected,
      source_stats:{
        total:relevantSelected.length,
        independent_domains:domains.length,
        // These counts are based on the final evidence set, not pre-filter candidates.
        lived_experience_sources:relevantSelected.filter(x=>x.type==="community").length,
        selected_lived_experience_sources:relevantSelected.filter(x=>x.type==="community").length,
        reddit_sources:relevantSelected.filter(x=>x.domain==="reddit.com").length,
        retrieval_debug:{
          raw_community_candidates:communityResults.length,
          raw_reddit_candidates:redditResults.length,
          recovery_attempts:recoveryAttempts,
          recovery_candidates:recoveryResults.length,
          qualifying_community_candidates:community.length,
          qualifying_reddit_candidates:reddit.length,
          final_lived_experience:relevantSelected.filter(x=>x.type==="community").length,
          final_reddit:relevantSelected.filter(x=>x.domain==="reddit.com").length,
          reddit:redditDebug
        },
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
  const lower=q.toLowerCase();
  const queries=[
    q,
    q+" caregiver firsthand experience what helped",
    q+" patient caregiver what worked what didn't work",
    "site:reddit.com/r/ParkinsonsCaregivers "+q,
    "site:reddit.com/r/Parkinsons "+q+" caregiver",
    "site:agingcare.com/questions "+q+" Parkinson's",
    "site:agingcare.com/questions Parkinson's freezing chair getting up",
    "site:agingcare.com/questions Parkinson's stuck getting out of chair",
    "site:parkinson.org "+q+" freezing cueing",
    "Parkinson's caregiver forum freezing sit to stand transfer",
    "Parkinson's freezing getting out of chair caregiver experience",
    "Parkinson's freezing chair transfer what helped caregivers"
  ];
  if(/freez|stuck|chair|sit to stand|get(ting)? up|transfer/.test(lower)){
    queries.push(
      "site:reddit.com/r/ParkinsonsCaregivers freezing chair stand up",
      "site:reddit.com/r/ParkinsonsCaregivers stuck in chair Parkinson's",
      "site:reddit.com/r/Parkinsons freezing getting out of chair",
      "site:agingcare.com/questions Parkinson's freeze standing chair caregiver",
      "site:agingcare.com/questions Parkinson's freezing transfer caregiver",
      "Parkinson's caregiver stuck in chair",
      "Parkinson's caregiver can't get up freezing",
      "Parkinson's caregiver gets stuck recliner"
    );
  }
  if(/rehab|physical therapy|pt|nursing|snf|progress/.test(lower)){
    queries.push(
      "site:reddit.com/r/ParkinsonsCaregivers rehabilitation physical therapy experience",
      "site:agingcare.com/questions Parkinson's rehab physical therapy caregiver experience",
      "Parkinson's caregiver rehabilitation plateau what helped what failed"
    );
  }
  return [...new Set(queries)].map(x=>x.slice(0,240)).slice(0,20);
}
function buildCommunityRecoveryQueries(q){
  const lower=String(q||"").toLowerCase();
  const out=[];
  out.push("site:reddit.com/r/ParkinsonsCaregivers "+q);
  out.push("site:reddit.com/r/Parkinsons "+q+" caregiver");
  if(/freez|stuck|chair|sit to stand|get(ting)? up|transfer/.test(lower)){
    out.push("site:reddit.com/r/ParkinsonsCaregivers Parkinson's freezing chair transfer what helped");
    out.push("site:reddit.com/r/Parkinsons freezing sit to stand caregiver");
    out.push("site:parkinsonsnewstoday.com/forums/forums/topic Parkinson's freezing caregiver");
  } else if(/rehab|physical therapy|pt|nursing|snf|progress/.test(lower)){
    out.push("site:reddit.com/r/ParkinsonsCaregivers Parkinson's rehabilitation physical therapy caregiver experience");
    out.push("site:reddit.com/r/Parkinsons Parkinson's rehab PT caregiver what helped");
    out.push("site:parkinsonsnewstoday.com/forums/forums/topic Parkinson's rehabilitation caregiver");
  } else {
    out.push("site:reddit.com/r/ParkinsonsCaregivers Parkinson's caregiver what helped");
    out.push("site:reddit.com/r/Parkinsons Parkinson's caregiver what worked");
    out.push("site:parkinsonsnewstoday.com/forums/forums/topic Parkinson's caregiver experience");
  }
  return [...new Set(out)].map(x=>x.slice(0,240)).slice(0,6);
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
function cleanEvidenceText(value){
  let s=String(value||"");
  s=s.replace(/\[([^\]]+)\]\((?:https?:\/\/|\/)[^)]*\)/g,"$1");
  s=s.replace(/https?:\/\/[^\s)]+/g,"");
  s=s.replace(/\*\*([^*]+)\*\*/g,"$1");
  s=s.replace(/^\s*#{1,6}\s*/gm,"");
  s=s.replace(/\s+/g," ").trim();
  return s;
}
function normalizeResult(x){
  const url=x?.url||x?.link||x?.source_url||"";
  const title=x?.title||x?.name||url;
  const excerpts=Array.isArray(x?.excerpts)?x.excerpts:(typeof x?.excerpt==="string"?[x.excerpt]:typeof x?.snippet==="string"?[x.snippet]:[]);
  return {
    title,url,domain:domainOf(url),
    published_date:x?.publish_date||x?.published_date||null,
    excerpts:excerpts.slice(0,3).map(cleanEvidenceText).filter(x=>x.length>=40),
    type:guessType(url,title)
  };
}
function canonical(u){try{const x=new URL(u);["utm_source","utm_medium","utm_campaign","utm_term","utm_content","fbclid","gclid","mc_cid","mc_eid"].forEach(k=>x.searchParams.delete(k));x.hash="";return x.origin+x.pathname.replace(/\/$/,"")}catch{return ""}}
function decodeXml(s){
  return String(s||"")
    .replace(/&quot;/g,'"')
    .replace(/&apos;/g,"'")
    .replace(/&amp;/g,"&")
    .replace(/&lt;/g,"<")
    .replace(/&gt;/g,">");
}
function stripHtml(s){ return String(s||"").replace(/<[^>]+>/g," ").replace(/\\s+/g," ").trim(); }
function domainOf(url){try{return new URL(url).hostname.replace(/^www\./,"")}catch{return ""}}
function isUsefulFirsthand(x){
  const h=(String(x.url||"")+" "+String(x.title||"")+" "+(x.excerpts||[]).join(" ")).toLowerCase();
  const bad=/(^|\.)support\.zoom\.com|eventbrite|wikipedia\.org|dictionary|glossary|directory|webinar|workshop|landing|\/topics?\/|\/caregiving-information|\/carepartner|\/resources-support\/carepartners\/pointers|\/caregiver-forum|\/forums\/?$/.test(h);
  if(bad)return false;
  if(x.domain==="reddit.com") return /\/r\/[^/]+\/comments\/[^/?#]+/.test(String(x.url||""));
  if(x.domain==="agingcare.com") {
    const u=String(x.url||"").toLowerCase();
    return /\/questions\/(?:[^/?#]+-)?\d+(?:\.htm)?(?:[?#].*)?$/.test(u)
      && !/\/topics\/|\/caregiver-forum/.test(u);
  }
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
  if(/agingcare\.com|reddit\.com|parkinson(s)?snewstoday\.com\/forums|myparkinsons\.org|parkinsonssupport|parkinsonsforum|patient.?forum|caregiver.?forum/.test(h))return "community";
  if(/parkinson\.org|lbda|movementdisorders\.org/.test(h))return "patient_org";
  if(/pubmed|nih\.gov|ncbi\.nlm|mayoclinic|hopkinsmedicine|stanford\.edu|neuropt\.org|apta\.org|\.edu\//.test(h))return "clinical";
  if(/reuters|nytimes|washingtonpost|aarp|statnews|npr\.org|apnews|bbc|theatlantic|time\.com|usatoday|forbes|bloomberg/.test(h))return "journalism";
  return "other";
}


function isQuestionRelevant(source, question, minHits=1){
  const q=String(question||"").toLowerCase();
  const text=[source.title||"",source.url||"",...(source.excerpts||[])].join(" ").toLowerCase();

  const groups=[
    ["freezing","freeze","freezes","frozen","stuck","gets stuck","can't move","cannot move","feet won't move"],
    ["chair","recliner","seat","sitting","sit to stand","stand up","rising","getting up","rise from"],
    ["transfer","mobility","walking","gait","movement","move","steps","standing"],
    ["cue","cueing","count","countdown","music","rhythm","visual","verbal","march","rock"],
    ["parkinson","parkinson's","parkinsonism","pd"],
    ["caregiver","carepartner","care partner","husband","wife","mother","father","mom","dad","patient"]
  ];

  const active=groups.filter(g=>g.some(term=>q.includes(term)));
  if(!active.length) return true;

  let hits=0;
  for(const g of active){
    if(g.some(term=>text.includes(term))) hits++;
  }

  // For community sources, require two distinct concepts from the question.
  // This prevents unrelated caregiver Q&A from qualifying merely because it
  // happens to be on AgingCare or another discussion site.
  return hits >= minHits;
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
