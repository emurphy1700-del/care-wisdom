export const maxDuration=60;

export default async function handler(req,res){
 if(req.method!=="POST")return res.status(405).json({error:"Method not allowed"});
 if(!process.env.PARALLEL_API_KEY)return res.status(503).json({error:"Provider not configured"});
 try{
  const q=String(req.body?.query||"").trim(), sources=Array.isArray(req.body?.sources)?req.body.sources.slice(0,24):[];
  if(!q||!sources.length)return res.status(400).json({error:"Query and sources required"});
  const evidence=sources.map((s,i)=>`SOURCE ${i+1}\nTitle: ${s.title}\nURL: ${s.url}\nType: ${s.type}\nDomain: ${s.domain}\nExcerpts: ${(s.excerpts||[]).join(" ")}`).join("\n\n");
  const prompt=`You are Care Wisdom. Synthesize ONLY the supplied sources for this caregiving question. Do not search again. Do not invent claims or sources.

Question: ${q}

Sources:
${evidence}

Return ONLY valid JSON with this shape:
{"question":"","overview":"","patterns":[{"title":"","category":"lived_experience|clinical_context|mixed","evidence_profile":{"level":"repeated_independent|limited_support|strong_clinical_limited_lived|mixed_conflicting|too_thin","label":"","rationale":""},"what_people_reported":"","evidence_check":"","disagreement":"","independence_note":"","care_team_questions":[{"provider":"","questions":[""]}],"evidence_trail":[{"title":"","url":"","type":"","role":""}],"why_this_surfaced":"","rabbit_holes":[""],"source_titles":[""]}],"limitations":[""],"safety_flags":[""]}

Produce no more than 4 strong patterns. A pattern must be an underlying recurring issue, not a webpage title. Prefer genuinely independent lived-experience reports and compare them with clinical context. Do not count multiple pages from one publisher as independent. Preserve disagreement. Care-team questions must be for professionals only; for rehab/SNF questions consider PT, OT, nursing supervisor/charge nurse, bedside nurse, neurologist, pharmacist, NP/PA, primary care, SLP, social worker/case manager, or dietitian as relevant. Do not prescribe or tell the user to change treatment. Flag near-fainting/fainting, repeated falls, acute confusion, chest pain, breathing difficulty, choking, or sudden neurological change for clinical evaluation.`;
  const r=await fetch("https://api.parallel.ai/v1/responses",{method:"POST",headers:{"Authorization":"Bearer "+process.env.PARALLEL_API_KEY,"Content-Type":"application/json"},body:JSON.stringify({model:"parallel",reasoning:{effort:"low"},instructions:"Return only valid JSON. Never invent evidence.",input:prompt})});
  const raw=await r.text();let d;try{d=JSON.parse(raw)}catch{return res.status(502).json({error:"Synthesis provider returned non-JSON",detail:raw.slice(0,700)})}
  if(!r.ok)return res.status(502).json({error:"Synthesis provider rejected request",detail:d?.error?.message||d?.message||raw.slice(0,700)});
  const text=d?.output_text||((d?.output||[]).flatMap(x=>[x?.text,...(x?.content||[]).map(y=>y?.text)]).find(Boolean)||"");
  let result;try{result=JSON.parse(String(text).replace(/^\s*\`\`\`json\s*/,"").replace(/\s*\`\`\`\s*$/,""))}catch{return res.status(502).json({error:"Synthesis was not valid JSON",detail:String(text).slice(0,700)})}
  const domains=[...new Set(sources.map(s=>s.domain).filter(Boolean))];
  return res.status(200).json({...result,question:result.question||q,sources,source_stats:{total:sources.length,independent_domains:domains.length,lived_experience_sources:sources.filter(s=>s.type==="community").length,domains}});
 }catch(e){return res.status(500).json({error:"Synthesis failed",detail:String(e).slice(0,700)})}
}