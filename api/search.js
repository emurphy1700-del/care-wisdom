export default async function handler(req,res){
 if(req.method!=='POST')return res.status(405).json({error:'Method not allowed'});
 const q=String(req.body?.query||'').trim();
 if(!q)return res.status(400).json({error:'Query required'});
 if(!process.env.PARALLEL_API_KEY)return res.status(503).json({error:'Live search provider credential is not configured on the server'});
 const prompt=researchPrompt(q);
 try{
  const r=await fetch('https://api.parallel.ai/v1/responses',{method:'POST',headers:{'Authorization':`Bearer ${process.env.PARALLEL_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:'parallel',input:prompt,reasoning:{effort:'medium'},text:{format:{type:'json_schema',name:'care_wisdom_research',schema:{type:'object',properties:{question:{type:'string'},research_branches:{type:'array',items:{type:'object',properties:{name:{type:'string'},why:{type:'string'}},required:['name','why'],additionalProperties:false}},overview:{type:'string'},patterns:{type:'array',items:{type:'object',properties:{title:{type:'string'},category:{type:'string',enum:['lived_experience','clinical_context','mixed']},evidence_profile:{type:'object',properties:{level:{type:'string',enum:['repeated_independent','limited_support','strong_clinical_limited_lived','mixed_conflicting','too_thin']},label:{type:'string'},rationale:{type:'string'}},required:['level','label','rationale'],additionalProperties:false},what_people_reported:{type:'string'},evidence_check:{type:'string'},disagreement:{type:'string'},independence_note:{type:'string'},care_team_questions:{type:'array',items:{type:'object',properties:{provider:{type:'string'},questions:{type:'array',items:{type:'string'}}},required:['provider','questions'],additionalProperties:false}},evidence_trail:{type:'array',items:{type:'object',properties:{title:{type:'string'},url:{type:'string'},type:{type:'string'},role:{type:'string'}},required:['title','url','type','role'],additionalProperties:false}},why_this_surfaced:{type:'string'},rabbit_holes:{type:'array',items:{type:'string'}},source_titles:{type:'array',items:{type:'string'}}},required:['title','category','evidence_profile','what_people_reported','evidence_check','disagreement','independence_note','care_team_questions','source_titles'],additionalProperties:false}},sources:{type:'array',items:{type:'object',properties:{title:{type:'string'},url:{type:'string'},type:{type:'string',enum:['community','patient_org','clinical','journalism','other']},domain:{type:'string'}},required:['title','url','type','domain'],additionalProperties:false}},limitations:{type:'array',items:{type:'string'}},safety_flags:{type:'array',items:{type:'string'}}},required:['question','research_branches','overview','patterns','sources','limitations','safety_flags'],additionalProperties:false}}}} )});
  const raw=await r.text();let data;try{data=JSON.parse(raw)}catch{return res.status(502).json({error:'Research provider returned a non-JSON response',detail:raw.slice(0,500)})}
  if(!r.ok)return res.status(502).json({error:'Research provider error',detail:data?.error?.message||data?.message||'Provider rejected the request'});
  const text=outputText(data);let result;try{result=JSON.parse(text.replace(/^\s*```json\s*/,'').replace(/\s*```\s*$/,''))}catch{return res.status(502).json({error:'Research synthesis was not valid JSON',detail:text.slice(0,1000)})}
  const citations=getCitations(data);result.sources=normalizeSources([...(result.sources||[]),...citations]);
  const domains=[...new Set(result.sources.map(s=>domainOf(s.url)).filter(Boolean))];
  return res.status(200).json({...result,source_stats:{total:result.sources.length,independent_domains:domains.length,lived_experience_sources:result.sources.filter(s=>s.type==='community').length,domains}});
 }catch(e){return res.status(500).json({error:'Research failed',detail:String(e).slice(0,500)})}
}
function researchPrompt(q){return `You are Care Wisdom's deep-research engine. User question: "${q.replace(/"/g,'\\\"')}"
Do a source-diverse, evidence-traceable web investigation. Decompose the question into 5-8 RESEARCH BRANCHES. A research branch is a question or avenue being investigated; it must NOT assert an answer unless the cited evidence supports it. Example: "Medication timing and exercise" rather than "Patients often exercise during off periods."

SOURCE REQUIREMENTS:
- Aim for 12-25 genuinely useful sources when available.
- Seek at least 3 independent lived-experience/community sources or independent discussions when the question calls for practical experience.
- Seek at least 3 independent clinical/medical sources for medical claims.
- Use multiple independent domains. Do not pad with multiple pages from one organization.
- If the evidence really is thin, return fewer sources but explicitly say that evidence is thin in limitations.
- Never invent a source, URL, quotation, patient experience, study result, or consensus.
- Distinguish a source's actual findings from your own synthesis.

SYNTHESIS:
A pattern is an underlying practical issue supported by multiple relevant independent reports, or by strong clinical evidence. It is NOT a webpage title, generic advice, or a plausible-sounding hypothesis.
For each pattern:
- "what_people_reported" must summarize actual lived-experience evidence and identify whether reports are repeated, mixed, or sparse.
- "evidence_check" must summarize actual clinical/medical evidence and its limitations.
- "disagreement" must preserve meaningful disagreement rather than manufacture it.
- "independence_note" must explain the actual basis for independence (for example, separate studies, separate authors, separate community discussions, or multiple domains). Do not call multiple pages from one publisher independent.
- "why_this_surfaced" must explain the evidence trail behind the pattern.
- "evidence_trail" should contain 2-5 of the most directly supporting sources, with their actual role.
- "rabbit_holes" should be useful next research questions, not claims.
- "evidence_profile" must be a transparent evidence-strength description, NOT a medical recommendation or score. Choose exactly one:
  * "repeated_independent" / "Repeated across independent sources" = multiple genuinely independent sources support a similar lived-experience pattern.
  * "limited_support" / "Some support, but limited" = there is some relevant evidence, but it is sparse, indirect, or concentrated in a small number of sources.
  * "strong_clinical_limited_lived" / "Strong clinical context; limited lived experience" = clinical evidence is substantial, but independent lived-experience evidence is sparse.
  * "mixed_conflicting" / "Mixed or conflicting reports" = credible sources materially disagree or report different outcomes.
  * "too_thin" / "Evidence too thin to form a reliable pattern" = the available evidence does not support a meaningful synthesis.
The rationale must briefly explain WHY that label applies, referring to the actual source mix. Do not assign a label merely because a pattern sounds plausible.

CARE-TEAM QUESTIONS:
Generate 2-4 concrete, caregiver-ready questions for the relevant PROFESSIONALS only. Do not put "Caregiver" or "Family" inside care_team_questions; those are not providers.
Possible providers include:
- Neurologist / movement-disorders clinician
- Physical therapist (PT)
- Occupational therapist (OT)
- SNF nursing supervisor / charge nurse
- Bedside SNF nurse
- Nurse practitioner / physician assistant
- Primary-care clinician
- Pharmacist
- Speech-language pathologist (SLP)
- Social worker / case manager
- Dietitian
Use only providers genuinely relevant to the pattern.
For ANY question involving a skilled nursing facility, rehabilitation facility, transfers, falls, toileting, day-to-day functional changes, blood-pressure/orthostatic events, or what happens outside therapy sessions, actively consider "SNF nursing supervisor / charge nurse" as a separate audience. They may have observations that PT/OT do not.
Questions should help the family clarify what is happening, what is being measured, what barriers have been identified, and what should be reassessed. Do not instruct the user to change medication, exercise, hydration, diet, or treatment.

SAFETY:
Do not diagnose, prescribe, rank treatments, or turn anecdotes into instructions. For potentially urgent symptoms, identify the need for appropriate clinical evaluation. Avoid blanket statements such as "do not begin exercise without medical clearance" unless the actual evidence specifically supports that context.

Return ONLY valid JSON:
{"question":string,"research_branches":[{"name":string,"why":string}],"overview":string,"patterns":[{"title":string,"category":"lived_experience|clinical_context|mixed","evidence_profile":{"level":"repeated_independent|limited_support|strong_clinical_limited_lived|mixed_conflicting|too_thin","label":string,"rationale":string},"what_people_reported":string,"evidence_check":string,"disagreement":string,"independence_note":string,"care_team_questions":[{"provider":string,"questions":[string]}],"evidence_trail":[{"title":string,"url":string,"type":string,"role":string}],"why_this_surfaced":string,"rabbit_holes":[string],"source_titles":[string]}],"sources":[{"title":string,"url":string,"type":"community|patient_org|clinical|journalism|other","domain":string}],"limitations":[string],"safety_flags":[string]}
Use only sources actually researched; never invent URLs or citations.`;}

function outputText(data){if(data.output_text)return data.output_text;for(const item of(data.output||[]))for(const p of(item.content||[]))if(p.type==='output_text'&&p.text)return p.text;return '';}
function getCitations(data){const a=[];for(const item of(data.output||[]))for(const p of(item.content||[]))for(const x of(p.annotations||[]))if(x.type==='url_citation'&&x.url)a.push({title:x.title||x.url,url:x.url,type:guessType(x.url,x.title||'')});return a;}
function normalizeSources(items){const seen=new Set(),out=[];for(const s of items){const url=canonical(s.url||'');if(!url||seen.has(url))continue;seen.add(url);out.push({title:s.title||url,url,type:['community','patient_org','clinical','journalism','other'].includes(s.type)?s.type:guessType(url,s.title||''),domain:domainOf(url)});}return out.slice(0,30);}
function domainOf(url){try{return new URL(url).hostname.replace(/^www\./,'')}catch{return ''}}
function canonical(u){try{const x=new URL(u);['utm_source','utm_medium','utm_campaign','utm_term','utm_content','fbclid','gclid','mc_cid','mc_eid'].forEach(k=>x.searchParams.delete(k));x.hash='';return x.origin+x.pathname.replace(/\/$/,'')}catch{return ''}}
function guessType(url,title){const h=(url+' '+title).toLowerCase();if(/reddit|agingcare|forum|community|discussion/.test(h))return 'community';if(/parkinson\.org|lbda|movementdisorders\.org/.test(h))return 'patient_org';if(/pubmed|nih\.gov|ncbi\.nlm|mayoclinic|hopkinsmedicine|stanford\.edu|neuropt\.org|apta\.org|\.edu\//.test(h))return 'clinical';if(/reuters|nytimes|washingtonpost|aarp|statnews|npr\.org/.test(h))return 'journalism';return 'other';}
