export const maxDuration=60;

export default async function handler(req,res){
 if(req.method!=="POST")return res.status(405).json({error:"Method not allowed"});
 if(!process.env.PARALLEL_API_KEY)return res.status(503).json({error:"Provider not configured"});
 try{
  const q=String(req.body?.query||"").trim(), sources=Array.isArray(req.body?.sources)?req.body.sources.slice(0,18):[];
  if(!q||!sources.length)return res.status(400).json({error:"Query and sources required"});
  const evidence=sources.map((s,i)=>"SOURCE "+(i+1)+"\nTitle: "+String(s.title).slice(0,180)+"\nURL: "+s.url+"\nType: "+s.type+"\nDomain: "+s.domain+"\nExtracted: "+(s.extracted?"yes":"no")+"\nPassages: "+(s.excerpts||[]).slice(0,4).map(x=>String(x).slice(0,650)).join(" ")).join("\n\n");
  const prompt=`You are Care Wisdom. Synthesize ONLY the supplied sources for this caregiving question. Do not search again. Do not invent claims or sources.

Question: ${q}

Sources:
${evidence}

Return ONLY valid JSON with this shape:
{"question":"","overview":"","single_reports":[],"patterns":[{"title":"","category":"lived_experience|clinical_context|mixed","evidence_profile":{"level":"repeated_independent|limited_support|strong_clinical_limited_lived|mixed_conflicting|too_thin","label":"","rationale":""},"what_people_reported":"","evidence_check":"","disagreement":"","independence_note":"","care_team_questions":[{"provider":"","questions":[""]}],"evidence_trail":[{"title":"","url":"","type":"","role":""}],"why_this_surfaced":"","rabbit_holes":[""],"source_titles":[""]}],"limitations":[""],"safety_flags":[""]}

Produce 1–4 strong patterns, but ONLY when the evidence clears the following bar. A pattern must be an underlying recurring issue, not a webpage title or generic Parkinson's fact.

EVIDENCE THRESHOLD:
- A lived-experience pattern requires at least 2 experiential source records from different domains. This is a MINIMUM source-diversity threshold, not proof that the reports come from different people.
- Treat multiple URLs from AARP, one forum, one publication, or one organization as ONE publisher/source cluster, not multiple independent experiences.
- Do not call sources "independent people" unless the supplied records actually establish distinct people or discussion threads.
- A single firsthand report can be shown only as a clearly labeled "single report worth exploring," NOT as a recurring pattern.
- If the evidence contains only one experiential source plus clinical sources, do NOT create a mixed/lived pattern. Put the firsthand item in single_reports and, if useful, create a separate clinical-context pattern.
- A clinical-context pattern may be included when supported by multiple independent clinical sources, but it must be labeled CLINICAL CONTEXT and must NEVER claim that "people reported" the clinical finding.
- If the evidence does not meet these thresholds, omit the pattern and put the finding in research limitations or "single reports worth exploring."
- Prefer fewer genuine patterns over filling the page with weak ones.

For every pattern, explicitly separate:
1. WHAT PEOPLE REPORTED — only firsthand patient/caregiver/public-reporting observations.
2. EVIDENCE CHECK — what clinical literature or professional guidance says, if anything.
3. DISAGREEMENT/UNCERTAINTY — what remains unresolved.
Never put clinical study findings in WHAT PEOPLE REPORTED.

Do not manufacture independent counts. Do not treat a search snippet, generic caregiver guide, or one publisher's collection of stories as multiple independent experiences. Do not count multiple pages from one publisher as independent. Preserve disagreement. Care-team questions must be for professionals only; for rehab/SNF questions consider PT, OT, nursing supervisor/charge nurse, bedside nurse, neurologist, pharmacist, NP/PA, primary care, SLP, social worker/case manager, or dietitian as relevant. Do not prescribe or tell the user to change treatment. Flag near-fainting/fainting, repeated falls, acute confusion, chest pain, breathing difficulty, choking, or sudden neurological change for clinical evaluation.`;
  const schema={
 type:"object",additionalProperties:false,
 properties:{
  question:{type:"string"},overview:{type:"string"},
  single_reports:{type:"array",items:{type:"string"}},
  patterns:{type:"array",items:{type:"object",additionalProperties:false,properties:{
   title:{type:"string"},category:{type:"string"},
   evidence_profile:{type:"object",additionalProperties:false,properties:{level:{type:"string"},label:{type:"string"},rationale:{type:"string"}},required:["level","label","rationale"]},
   what_people_reported:{type:"string"},evidence_check:{type:"string"},disagreement:{type:"string"},independence_note:{type:"string"},
   care_team_questions:{type:"array",items:{type:"object",additionalProperties:false,properties:{provider:{type:"string"},questions:{type:"array",items:{type:"string"}}},required:["provider","questions"]}},
   evidence_trail:{type:"array",items:{type:"object",additionalProperties:false,properties:{title:{type:"string"},url:{type:"string"},type:{type:"string"},role:{type:"string"}},required:["title","url","type","role"]}},
   why_this_surfaced:{type:"string"},rabbit_holes:{type:"array",items:{type:"string"}},source_titles:{type:"array",items:{type:"string"}}
  },required:["title","category","evidence_profile","what_people_reported","evidence_check","disagreement","independence_note","care_team_questions","evidence_trail","why_this_surfaced","rabbit_holes","source_titles"]}},
  limitations:{type:"array",items:{type:"string"}},safety_flags:{type:"array",items:{type:"string"}}
 },required:["question","overview","single_reports","patterns","limitations","safety_flags"]
};
const r=await fetch("https://api.parallel.ai/v1/responses",{method:"POST",headers:{"Authorization":"Bearer "+process.env.PARALLEL_API_KEY,"Content-Type":"application/json"},body:JSON.stringify({
 model:"parallel",reasoning:{effort:"low"},instructions:"Synthesize only the supplied sources. Never invent evidence. Produce no more than 4 genuine underlying patterns. A pattern must be a recurring issue supported by the supplied evidence, not a webpage title. Distinguish lived experience from clinical context. Preserve disagreement. Do not diagnose or prescribe.",
 input:prompt,text:{format:{type:"json_schema",name:"care_wisdom_synthesis",strict:true,schema}}
})});
  const raw=await r.text();let d;try{d=JSON.parse(raw)}catch{return res.status(502).json({error:"Synthesis provider returned non-JSON",detail:raw.slice(0,700)})}
  if(!r.ok)return res.status(502).json({error:"Synthesis provider rejected request",detail:d?.error?.message||d?.message||raw.slice(0,700)});
  const text=d?.output_text||((d?.output||[]).flatMap(x=>[x?.text,...(x?.content||[]).map(y=>y?.text)]).find(Boolean)||"");
  let result;
const cleaned=String(text).replace(/^\\s*\\\`\\\`\\\`(?:json)?\\s*/,"").replace(/\\s*\\\`\\\`\\\`\\s*$/,"").trim();
try{result=JSON.parse(cleaned)}
catch{
  const a=cleaned.indexOf("{"),b=cleaned.lastIndexOf("}");
  if(a>=0&&b>a){try{result=JSON.parse(cleaned.slice(a,b+1))}catch{}}
}
if(!result||typeof result!=="object"){
  result={
    question:q,
    overview:cleaned,
    patterns:[],
    single_reports:[],
    limitations:["The research model returned a narrative synthesis rather than structured evidence. No unsupported claims were converted into patterns."],
    safety_flags:[]
  };
}
  // Deterministic evidence guard: the model cannot promote a pattern to lived/mixed
  // experience unless its own evidence trail contains at least two experiential
  // source domains. This prevents clinical pages from being counted as caregiver reports.
  const sourceByUrl=new Map(sources.map(s=>[String(s.url||""),s]));
  const experientialTypes=new Set(["community","journalism"]);
  const promotedSingleReports=[];
  result.patterns=(Array.isArray(result.patterns)?result.patterns:[]).filter(p=>{
    const trail=Array.isArray(p.evidence_trail)?p.evidence_trail:[];
    const exp=trail.map(t=>sourceByUrl.get(String(t.url||""))||t)
      .filter(s=>experientialTypes.has(s.type));
    const expDomains=[...new Set(exp.map(s=>s.domain).filter(Boolean))];
    if((p.category==="lived_experience"||p.category==="mixed") && expDomains.length<2){
      const title=String(p.title||"");
      promotedSingleReports.push(`The research surfaced "${title}" but did not find enough distinct experiential source domains to call it a recurring lived-experience pattern.`);
      return false;
    }
    return true;
  });
  if(promotedSingleReports.length){
    result.single_reports=[...(Array.isArray(result.single_reports)?result.single_reports:[]),...promotedSingleReports];
    result.limitations=[...(Array.isArray(result.limitations)?result.limitations:[]),"Lived-experience evidence was thinner than the clinical evidence for some findings; source-domain diversity was not treated as proof of independent people."];
  }
  // Normalize the evidence boundary after synthesis so the UI cannot accidentally
  // present clinical material as firsthand experience.
  result.patterns=(Array.isArray(result.patterns)?result.patterns:[]).map(p=>{
    const x={...p};
    if(x.category==="clinical_context"){
      x.what_people_reported="This is clinical context. The supplied evidence does not establish a recurring firsthand patient/caregiver report of this specific finding.";
      x.evidence_profile={...(x.evidence_profile||{}),level:x.evidence_profile?.level||"strong_clinical_limited_lived"};
    }
    // Rabbit holes are research directions, not treatment instructions.
    x.rabbit_holes=(Array.isArray(x.rabbit_holes)?x.rabbit_holes:[]).map(v=>{
      let s=String(v);
      s=s.replace(/^(investigate|try|consider|use|increase|decrease|adjust|start|stop)\\b/i,"Explore evidence on");
      return s;
    });
    return x;
  });
  const domains=[...new Set(sources.map(s=>s.domain).filter(Boolean))];
  const lived=sources.filter(s=>s.type==="community");
  const reddit=sources.filter(s=>s.domain==="reddit.com");
  const aarp=sources.filter(s=>s.domain==="aarp.org");
  const publicReporting=sources.filter(s=>s.type==="journalism");
  const source_stats={
    total:sources.length,
    independent_domains:domains.length,
    lived_experience_sources:lived.length,
    selected_lived_experience_sources:lived.length,
    reddit_sources:reddit.length,
    aarp_sources:aarp.length,
    public_sources:publicReporting.length,
    domains
  };
  return res.status(200).json({...result,question:result.question||q,sources,source_stats});
 }catch(e){return res.status(500).json({error:"Synthesis failed",detail:String(e).slice(0,700)})}
}