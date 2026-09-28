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
{"question":"","overview":"","patterns":[{"title":"","category":"lived_experience|clinical_context|mixed","evidence_profile":{"level":"repeated_independent|limited_support|strong_clinical_limited_lived|mixed_conflicting|too_thin","label":"","rationale":""},"what_people_reported":"","evidence_check":"","disagreement":"","independence_note":"","care_team_questions":[{"provider":"","questions":[""]}],"evidence_trail":[{"title":"","url":"","type":"","role":""}],"why_this_surfaced":"","rabbit_holes":[""],"source_titles":[""]}],"limitations":[""],"safety_flags":[""]}

Produce 2–5 strong patterns. A pattern must be an underlying recurring issue supported by multiple relevant passages or by one unusually direct firsthand report plus clinical context—not a webpage title and not a generic fact about Parkinson's. At least half of the patterns should come from lived experience/public reporting when the supplied sources contain such material. Do NOT turn a clinical fact into a "what people reported" claim. For each pattern, explicitly distinguish firsthand reports, public reporting, and clinical evidence. Count independent people/discussions conservatively: different URLs from the same publisher are not independent people. Do not count multiple pages from one publisher as independent. Preserve disagreement. Care-team questions must be for professionals only; for rehab/SNF questions consider PT, OT, nursing supervisor/charge nurse, bedside nurse, neurologist, pharmacist, NP/PA, primary care, SLP, social worker/case manager, or dietitian as relevant. Do not prescribe or tell the user to change treatment. Flag near-fainting/fainting, repeated falls, acute confusion, chest pain, breathing difficulty, choking, or sudden neurological change for clinical evaluation.`;
  const schema={
 type:"object",additionalProperties:false,
 properties:{
  question:{type:"string"},overview:{type:"string"},
  patterns:{type:"array",items:{type:"object",additionalProperties:false,properties:{
   title:{type:"string"},category:{type:"string"},
   evidence_profile:{type:"object",additionalProperties:false,properties:{level:{type:"string"},label:{type:"string"},rationale:{type:"string"}},required:["level","label","rationale"]},
   what_people_reported:{type:"string"},evidence_check:{type:"string"},disagreement:{type:"string"},independence_note:{type:"string"},
   care_team_questions:{type:"array",items:{type:"object",additionalProperties:false,properties:{provider:{type:"string"},questions:{type:"array",items:{type:"string"}}},required:["provider","questions"]}},
   evidence_trail:{type:"array",items:{type:"object",additionalProperties:false,properties:{title:{type:"string"},url:{type:"string"},type:{type:"string"},role:{type:"string"}},required:["title","url","type","role"]}},
   why_this_surfaced:{type:"string"},rabbit_holes:{type:"array",items:{type:"string"}},source_titles:{type:"array",items:{type:"string"}}
  },required:["title","category","evidence_profile","what_people_reported","evidence_check","disagreement","independence_note","care_team_questions","evidence_trail","why_this_surfaced","rabbit_holes","source_titles"]}},
  limitations:{type:"array",items:{type:"string"}},safety_flags:{type:"array",items:{type:"string"}}
 },required:["question","overview","patterns","limitations","safety_flags"]
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
    limitations:["The research model returned a narrative synthesis rather than structured evidence. No unsupported claims were converted into patterns."],
    safety_flags:[]
  };
}
  const domains=[...new Set(sources.map(s=>s.domain).filter(Boolean))];
  return res.status(200).json({...result,question:result.question||q,sources,source_stats:{total:sources.length,independent_domains:domains.length,lived_experience_sources:sources.filter(s=>s.type==="community").length,domains}});
 }catch(e){return res.status(500).json({error:"Synthesis failed",detail:String(e).slice(0,700)})}
}