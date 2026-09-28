export const maxDuration = 10;

const OUTPUT_SCHEMA = {
  type: "json",
  json_schema: {
    type: "object",
    properties: {
      question: {type:"string"},
      overview: {type:"string"},
      research_branches: {type:"array",items:{type:"object",properties:{
        name:{type:"string"}, why:{type:"string"}
      },required:["name","why"]}},
      patterns: {type:"array",items:{type:"object",properties:{
        title:{type:"string"},
        category:{type:"string",enum:["lived_experience","clinical_context","mixed"]},
        evidence_profile:{type:"object",properties:{
          level:{type:"string",enum:["repeated_independent","limited_support","strong_clinical_limited_lived","mixed_conflicting","too_thin"]},
          label:{type:"string"}, rationale:{type:"string"}
        },required:["level","label","rationale"]},
        what_people_reported:{type:"string"},
        evidence_check:{type:"string"},
        disagreement:{type:"string"},
        independence_note:{type:"string"},
        care_team_questions:{type:"array",items:{type:"object",properties:{
          provider:{type:"string"},questions:{type:"array",items:{type:"string"}}
        },required:["provider","questions"]}},
        evidence_trail:{type:"array",items:{type:"object",properties:{
          title:{type:"string"},url:{type:"string"},type:{type:"string"},role:{type:"string"}
        },required:["title","url","type","role"]}},
        why_this_surfaced:{type:"string"},
        rabbit_holes:{type:"array",items:{type:"string"}},
        source_titles:{type:"array",items:{type:"string"}}
      },required:["title","category","evidence_profile","what_people_reported","evidence_check","disagreement","independence_note","care_team_questions","evidence_trail","why_this_surfaced","rabbit_holes","source_titles"]}},
      sources:{type:"array",items:{type:"object",properties:{
        title:{type:"string"},url:{type:"string"},type:{type:"string",enum:["community","patient_org","clinical","journalism","other"]},domain:{type:"string"}
      },required:["title","url","type","domain"]}},
      limitations:{type:"array",items:{type:"string"}},
      safety_flags:{type:"array",items:{type:"string"}}
    },
    required:["question","overview","research_branches","patterns","sources","limitations","safety_flags"]
  }
};

export default async function handler(req,res){
  if(req.method!=="POST" && req.method!=="GET") return res.status(405).json({error:"Method not allowed"});
  if(!process.env.PARALLEL_API_KEY) return res.status(503).json({error:"Live search provider credential is not configured on the server"});

  try{
    if(req.method==="POST"){
      const q=String(req.body?.query||"").trim();
      if(!q) return res.status(400).json({error:"Query required"});
      const runResp=await fetch("https://api.parallel.ai/v1/tasks/runs",{
        method:"POST",
        headers:{"x-api-key":process.env.PARALLEL_API_KEY,"Content-Type":"application/json"},
        body:JSON.stringify({
          processor:"core-fast",
          input:researchPrompt(q),
          task_spec:{output_schema:OUTPUT_SCHEMA}
        })
      });
      const runRaw=await runResp.text();
      let runData; try{runData=JSON.parse(runRaw)}catch{
        return res.status(502).json({error:"Research provider returned a non-JSON task response",detail:runRaw.slice(0,700)});
      }
      if(!runResp.ok) return res.status(502).json({error:"Research provider rejected the task",detail:runData?.error?.message||runData?.message||runRaw.slice(0,700)});
      const runId=runData.run_id||runData.id||runData.run?.run_id;
      if(!runId) return res.status(502).json({error:"Research provider did not return a task ID"});
      return res.status(202).json({runId,status:runData.status||runData.run?.status||"queued",question:q});
    }

    const runId=String(req.query?.runId||"").trim();
    if(!runId) return res.status(400).json({error:"runId required"});

    const statusResp=await fetch("https://api.parallel.ai/v1/tasks/runs/"+encodeURIComponent(runId),{
      headers:{"x-api-key":process.env.PARALLEL_API_KEY}
    });
    const statusRaw=await statusResp.text();
    let statusData; try{statusData=JSON.parse(statusRaw)}catch{
      return res.status(502).json({error:"Research provider returned a non-JSON status response",detail:statusRaw.slice(0,700)});
    }
    if(!statusResp.ok) return res.status(502).json({error:"Could not check research task",detail:statusData?.error?.message||statusData?.message||statusRaw.slice(0,700)});

    const run=statusData.run||statusData;
    const status=run.status||statusData.status||"unknown";
    if(status==="queued"||status==="running") return res.status(200).json({status,runId});
    if(status==="failed") return res.status(200).json({status:"failed",runId,error:run.errors||run.error||"Research task failed"});
    if(status!=="completed") return res.status(200).json({status,runId});

    const resultResp=await fetch("https://api.parallel.ai/v1/tasks/runs/"+encodeURIComponent(runId)+"/result?timeout=5",{
      headers:{"x-api-key":process.env.PARALLEL_API_KEY}
    });
    const resultRaw=await resultResp.text();
    let resultData; try{resultData=JSON.parse(resultRaw)}catch{
      return res.status(502).json({error:"Research result was not valid JSON",detail:resultRaw.slice(0,700)});
    }
    if(!resultResp.ok) return res.status(502).json({error:"Research task result could not be retrieved",detail:resultData?.error?.message||resultData?.message||resultRaw.slice(0,700)});
    return res.status(200).json(normalizeResult(resultData,run.input?.query||""));
  }catch(e){
    return res.status(500).json({error:"Research failed",detail:String(e).slice(0,700)});
  }
}

function researchPrompt(q){
return `You are Care Wisdom, a deep-research companion for Parkinson's disease and related caregiving questions.

USER QUESTION:
${q}

RESEARCH METHOD:
Conduct genuine multi-source web research. Break the question into 5-8 research branches, search across caregiver/patient lived experience, patient organizations, clinical guidance/reviews, and reputable journalism where useful, then synthesize only what the sources support.

Care Wisdom is NOT a medical advice engine. Do not diagnose, prescribe, rank treatments, or turn anecdotes into instructions.

SOURCE QUALITY:
- Prefer genuinely independent sources and independent discussions.
- Do not count multiple pages from the same publisher as independent.
- Seek both lived-experience evidence and clinical evidence when the question calls for both.
- Preserve disagreement and uncertainty.
- Never invent a source, URL, quotation, study result, patient experience, or consensus.
- A pattern must be an underlying recurring issue, not a webpage title.
- If evidence is thin, say so.

EVIDENCE PROFILE:
Choose exactly one:
repeated_independent = repeated across genuinely independent sources
limited_support = some support but sparse, indirect, or concentrated
strong_clinical_limited_lived = substantial clinical context but sparse lived experience
mixed_conflicting = credible sources materially disagree
too_thin = insufficient evidence for a meaningful pattern
The rationale must explain the actual source mix. This is not a treatment recommendation or score.

FOR EACH PATTERN:
- What people reported: summarize actual patient/caregiver experiences; distinguish repeated from isolated reports.
- Evidence check: summarize clinical evidence and limitations.
- Disagreement: identify real disagreement or say when little disagreement was found.
- Independence note: explain whether support comes from separate authors, studies, discussions, or domains.
- Evidence trail: give 2-5 actual URLs that directly support the pattern.
- Why this surfaced: explain the evidence trail.
- Rabbit holes: useful next questions to investigate.
- Source titles: actual source titles.

CARE-TEAM QUESTIONS:
Generate 2-4 concrete questions for relevant PROFESSIONALS only. Never list "Caregiver" or "Family" as a provider.
Possible audiences:
Neurologist / movement-disorders clinician; Physical therapist (PT); Occupational therapist (OT); SNF nursing supervisor / charge nurse; bedside SNF nurse; nurse practitioner / physician assistant; primary-care clinician; pharmacist; speech-language pathologist (SLP); social worker / case manager; dietitian.
For questions involving an SNF, rehabilitation facility, transfers, falls, toileting, day-to-day function, blood-pressure/orthostatic events, or what happens outside therapy sessions, actively consider SNF nursing supervisor / charge nurse as a separate audience.
Questions should clarify observations, measurements, barriers, goals, timing, safety, and what should be reassessed. Do not tell the user to change medication, exercise, hydration, diet, or treatment.

SAFETY:
Flag potentially urgent symptoms appropriately. Near-fainting/fainting, repeated falls, acute confusion, chest pain, breathing difficulty, choking, or sudden neurological change should lead to appropriate clinical evaluation rather than self-experimentation. Keep the warning proportional to the evidence.

Return only the requested structured JSON.`;
}

function normalizeResult(data,q){
  const raw=data?.output?.content ?? data?.output ?? data?.content ?? data;
  let r=raw;
  if(typeof r==="string"){
    try{r=JSON.parse(r.replace(/^\s*\`\`\`json\s*/,"").replace(/\s*\`\`\`\s*$/,""))}
    catch{throw new Error("Task output was not valid structured JSON")}
  }
  if(!r || typeof r!=="object") throw new Error("Task output was empty");

  const patterns=Array.isArray(r.patterns)?r.patterns:[];
  const sources=normalizeSources([
    ...(Array.isArray(r.sources)?r.sources:[]),
    ...patterns.flatMap(p=>Array.isArray(p.evidence_trail)?p.evidence_trail:[])
  ]);

  const domains=[...new Set(sources.map(s=>s.domain).filter(Boolean))];
  return {
    question:r.question||q,
    overview:r.overview||"The research did not produce a reliable overall synthesis.",
    research_branches:Array.isArray(r.research_branches)?r.research_branches:[],
    patterns:patterns.map(p=>({
      ...p,
      evidence_profile:p.evidence_profile||{level:"too_thin",label:"Evidence too thin",rationale:"The available research did not support a stronger classification."},
      care_team_questions:Array.isArray(p.care_team_questions)?p.care_team_questions:[],
      evidence_trail:Array.isArray(p.evidence_trail)?p.evidence_trail:[],
      rabbit_holes:Array.isArray(p.rabbit_holes)?p.rabbit_holes:[]
    })),
    sources,
    limitations:Array.isArray(r.limitations)?r.limitations:[],
    safety_flags:Array.isArray(r.safety_flags)?r.safety_flags:[],
    source_stats:{
      total:sources.length,
      independent_domains:domains.length,
      lived_experience_sources:sources.filter(s=>s.type==="community").length,
      domains
    }
  };
}

function normalizeSources(items){
  const seen=new Set(),out=[];
  for(const s of items){
    const url=canonical(s?.url||"");
    if(!url||seen.has(url))continue;
    seen.add(url);
    out.push({
      title:s?.title||url,
      url,
      type:["community","patient_org","clinical","journalism","other"].includes(s?.type)?s.type:guessType(url,s?.title||""),
      domain:domainOf(url)
    });
  }
  return out.slice(0,40);
}
function domainOf(url){try{return new URL(url).hostname.replace(/^www\./,"")}catch{return ""}}
function canonical(u){try{const x=new URL(u);["utm_source","utm_medium","utm_campaign","utm_term","utm_content","fbclid","gclid","mc_cid","mc_eid"].forEach(k=>x.searchParams.delete(k));x.hash="";return x.origin+x.pathname.replace(/\/$/,"")}catch{return ""}}
function guessType(url,title){
  const h=(url+" "+title).toLowerCase();
  if(/reddit|agingcare|forum|community|discussion|caregiver/.test(h))return "community";
  if(/parkinson\.org|lbda|movementdisorders\.org/.test(h))return "patient_org";
  if(/pubmed|nih\.gov|ncbi\.nlm|mayoclinic|hopkinsmedicine|stanford\.edu|neuropt\.org|apta\.org|\.edu\//.test(h))return "clinical";
  if(/reuters|nytimes|washingtonpost|aarp|statnews|npr\.org/.test(h))return "journalism";
  return "other";
}
