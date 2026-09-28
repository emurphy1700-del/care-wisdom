export const maxDuration=60;

export default async function handler(req,res){
 if(req.method!=="POST")return res.status(405).json({error:"Method not allowed"});
 if(!process.env.PARALLEL_API_KEY)return res.status(503).json({error:"Provider not configured"});
 try{
  const q=String(req.body?.query||"").trim(), sources=Array.isArray(req.body?.sources)?req.body.sources.slice(0,18):[];
  if(!q||!sources.length)return res.status(400).json({error:"Query and sources required"});
  const evidence=sources.map((s,i)=>"SOURCE "+(i+1)+"\nTitle: "+String(s.title).slice(0,180)+"\nURL: "+s.url+"\nType: "+s.type+"\nDomain: "+s.domain+"\nExtracted: "+(s.extracted?"yes":"no")+"\nPassages: "+(s.excerpts||[]).slice(0,4).map(x=>String(x).slice(0,650)).join(" ")).join("\n\n");
    // Deterministic evidence synthesis. The app does not invent patterns or call an unsupported
  // generation endpoint. It groups source excerpts into a small set of explicit research themes.
  const themes=[
    {key:"cueing",title:"Slowing down and using simple cues",words:["cue","rhythm","count","metronome","music","visual","auditory","step","slow"],providers:["Physical Therapist","Occupational Therapist"],rabbit:["Explore visual, auditory, rhythmic, and verbal cueing.","Explore how caregivers adapt cueing during chair transfers."]},
    {key:"transfer",title:"The transfer setup may matter as much as the freezing",words:["chair","transfer","sit","stand","foot","feet","armrest","walker","position","stance","lean","environment","doorway","space"],providers:["Physical Therapist","Occupational Therapist"],rabbit:["Explore chair height, foot placement, armrests, and transfer setup.","Explore OT assessment of the environment around transfers."]},
    {key:"rushing",title:"Rushing or pressure can make freezing harder to manage",words:["rush","hurry","pull","force","faster","frustrat","panic","stress","pressure","talking"],providers:["Physical Therapist","Occupational Therapist"],rabbit:["Explore caregiver communication and pacing during freezing.","Explore strategies for reducing triggers during transfers."]},
    {key:"medication",title:"Medication timing may affect when mobility is easier or harder",words:["medication","meds","dose","levodopa","carbidopa","on time","off time","wearing off","timing"],providers:["Neurologist","Pharmacist","Physical Therapist"],rabbit:["Explore mobility fluctuations and medication timing.","Explore how therapy observations relate to the medication schedule."]},
    {key:"fatigue",title:"Fatigue, weakness, or deconditioning can overlap with freezing",words:["fatigue","tired","weak","weakness","decondition","endurance","stamina","exhaust","sleep"],providers:["Physical Therapist","Occupational Therapist"],rabbit:["Explore how fatigue, weakness, and conditioning interact with mobility.","Explore how the team distinguishes freezing from weakness or fatigue."]},
    {key:"falls",title:"Freezing can create a safety problem during transfers",words:["fall","balance","safety","injury","near fall","unstable"],providers:["Physical Therapist","Occupational Therapist","Nursing"],rabbit:["Explore fall-risk assessment during chair transfers.","Explore safer transfer strategies with the PT/OT team."]},
    {key:"orthostasis",title:"Blood-pressure symptoms can complicate standing and mobility",words:["blood pressure","orthostatic","dizzy","lightheaded","faint","passing out","syncope"],providers:["Nurse/NP/PA","Neurologist","Physical Therapist"],rabbit:["Explore orthostatic symptoms during standing and transfers.","Explore how blood pressure is assessed around therapy."]},
    {key:"cognition",title:"Cognition or communication may affect how well cues work",words:["confus","cognitive","memory","attention","dementia","hallucination","communication","understand"],providers:["Occupational Therapist","Speech-Language Pathologist","Neurologist"],rabbit:["Explore whether cognitive or communication changes affect cueing.","Explore OT/SLP approaches to movement instructions."]}
  ];
  const ql=q.toLowerCase();
  const patterns=themes.map(t=>{
    const hits=sources.map(s=>{const txt=(s.title+" "+(s.excerpts||[]).join(" ")).toLowerCase();const score=t.words.reduce((n,w)=>n+(txt.includes(w)?1:0),0)+(t.words.some(w=>ql.includes(w))?1:0);return score?{...s,_score:score}:null}).filter(Boolean).sort((a,b)=>b._score-a._score);
    const exp=hits.filter(s=>s.type==="community"||s.type==="journalism");
    const clin=hits.filter(s=>s.type==="clinical"||s.type==="patient_org");
    const domains=[...new Set(exp.map(s=>s.domain).filter(Boolean))];
    const repeated=domains.length>=2, clinicalOnly=clin.length>=2&&!repeated;
    if(!repeated&&!clinicalOnly)return null;
    const trail=[...exp.slice(0,4),...clin.slice(0,4)].map(s=>({title:s.title,url:s.url,type:s.type,role:s.type==="community"?"firsthand/community record":s.type==="journalism"?"public reporting":"clinical context"}));
    const excerptText=(items)=>items.flatMap(s=>s.excerpts||[]).filter(x=>t.words.some(w=>String(x).toLowerCase().includes(w))).slice(0,2).map(x=>"“"+String(x).replace(/\\s+/g," ").slice(0,240)+"”").join(" ");
    const qset={
      cueing:["Which verbal, visual, or rhythmic cues are most useful during the specific transfer?","How should staff respond if a cue appears to make freezing worse?"],
      transfer:["What is the safest transfer setup, including chair height, foot position, and assistive device?","Would an OT/PT assessment of the chair and surrounding space change the transfer plan?"],
      rushing:["What pacing or communication approach should staff use when freezing occurs?","Are there cues we should avoid because they increase pressure or confusion?"],
      medication:["Do mobility problems vary with medication timing or wearing-off periods?","Should therapy observations be documented relative to the medication schedule?"],
      fatigue:["How are you distinguishing freezing from weakness, fatigue, or deconditioning?","What objective measures are you using to track functional progress?"],
      falls:["What specific fall risks are present during this transfer?","What level of assistance or equipment is appropriate when freezing occurs?"],
      orthostasis:["Could orthostatic blood-pressure changes contribute to difficulty standing?","What measurements should be documented during therapy or transfers?"],
      cognition:["Could attention, memory, or communication changes affect response to cues?","Would OT or SLP assessment help tailor the instructions?"]
    };
    return {title:t.title,category:clinicalOnly?"clinical_context":clin.length?"mixed":"lived_experience",
      evidence_profile:{level:repeated?(clin.length?"limited_support":"repeated_independent"):"strong_clinical_limited_lived",label:repeated?(clin.length?"Repeated lived-experience reports with clinical context":"Repeated across source domains"):"Clinical context; lived-experience evidence limited",rationale:repeated?"Appears in experiential records from "+domains.length+" source domains. This is source diversity, not a count of independent people.":"Clinical sources converge on this theme, but firsthand evidence does not establish a recurring pattern."},
      what_people_reported:exp.length?(excerptText(exp)||"Firsthand sources discuss this theme, but their available excerpts are too thin for a stronger summary."):"This is clinical context. The supplied evidence does not establish a recurring firsthand patient/caregiver report of this specific finding.",
      evidence_check:clin.length?(excerptText(clin)||"Clinical sources address this theme, but the available excerpts are too thin for a stronger evidence statement."):"No qualifying clinical source in the supplied evidence directly addressed this theme.",
      disagreement:exp.length&&clin.length?"The source set does not show a clear contradiction, but the reports differ in context and do not establish that the same approach works for every person.":exp.length?"The firsthand sources point in a similar direction, but the evidence set does not establish how generalizable the experience is.":"The clinical sources do not establish a firsthand caregiver pattern in this evidence pool.",
      independence_note:"Found across "+domains.length+" experiential source domains. This is a source-diversity measure, not a count of independent people.",
      care_team_questions:t.providers.map(p=>({provider:p,questions:qset[t.key]||["What is the care team's assessment of this issue?"]})),
      evidence_trail:trail,why_this_surfaced:"Multiple supplied sources contained concrete discussion of "+t.words.slice(0,5).join(", ")+" in connection with the research question.",rabbit_holes:t.rabbit,source_titles:trail.map(x=>x.title)};
  }).filter(Boolean).sort((a,b)=>(b.evidence_profile.level==="repeated_independent"?2:1)-(a.evidence_profile.level==="repeated_independent"?2:1)).slice(0,4);

  const used=new Set(patterns.flatMap(p=>p.evidence_trail.map(x=>x.url)));
  const single_reports=sources.filter(s=>(s.type==="community"||s.type==="journalism")&&!used.has(s.url)).slice(0,5).map(s=>s.title+" ("+s.domain+") — individual report worth exploring. "+String(s.excerpts?.[0]||"").replace(/\\s+/g," ").slice(0,280));
  const result={question:q,overview:patterns.length?"The strongest themes surfaced were: "+patterns.slice(0,3).map(p=>p.title).join("; ")+". Care Wisdom separates firsthand reports from clinical context and does not treat source-domain diversity as proof of independent people.":"The evidence pool did not produce a recurring pattern strong enough to promote. "+(single_reports.length?"Individual reports are shown for exploration.":""),single_reports,patterns,limitations:patterns.length?[]:["The available evidence was not diverse enough to establish a recurring pattern."],safety_flags:safetyFlags(q)};
  if(sources.filter(s=>s.type==="community").length<2) result.limitations.push("Few qualifying firsthand discussion records were found; source-domain diversity is not the same as independent people.");
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
