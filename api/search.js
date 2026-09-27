export default async function handler(req,res){
 if(req.method!=='POST') return res.status(405).json({error:'Method not allowed'});
 const q=String(req.body?.query||'').trim(); if(!q)return res.status(400).json({error:'Query required'});
 if(!process.env.PARALLEL_API_KEY)return res.status(503).json({error:'Live search provider credential is not configured on the server'});
 const queries=[q,`${q} caregiver patient experience`,`${q} caregiver forum lived experience`,`${q} clinical guidance safety`];
 try{
  const r=await fetch('https://api.parallel.ai/v1beta/search',{method:'POST',headers:{'x-api-key':process.env.PARALLEL_API_KEY,'content-type':'application/json'},body:JSON.stringify({objective:'Research a caregiving/health question. Return a diverse set of sources. Prioritize patient/caregiver lived experience for discovery, authoritative clinical sources for context, and journalism/patient organizations for broader context. Do not diagnose, prescribe, rank treatments, or turn anecdotes into medical conclusions. Preserve disagreement.',search_queries:queries})});
  const data=await r.json(); if(!r.ok)return res.status(502).json({error:'Search provider error'});
  const raw=(data.results||[]).map(x=>({url:x.url,title:x.title||x.url,excerpts:Array.isArray(x.excerpts)?x.excerpts:[],text:x.text||x.content||''}));
  const sources=dedupe(raw).map(x=>({...x,kind:classify(x.url,x.title)}));
  const clusters=buildClusters(sources);
  return res.status(200).json({sources,clusters,safety:detectSafety(q)});
 }catch(e){return res.status(500).json({error:'Search failed',detail:process.env.NODE_ENV==='development'?String(e):undefined})}
}
function canonical(u){try{const x=new URL(u);['utm_source','utm_medium','utm_campaign','utm_term','utm_content','fbclid','gclid','mc_cid','mc_eid'].forEach(k=>x.searchParams.delete(k));x.hash='';return x.origin+x.pathname.replace(/\/$/,'')}catch{return ''}}
function dedupe(items){const seen=new Set();const out=[];for(const x of items){const u=canonical(x.url||'');if(!u||seen.has(u))continue;seen.add(u);out.push({...x,url:u})}return out}
function norm(s){return String(s||'').toLowerCase().replace(/https?:\/\/\S+/g,' ').replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim()}
function tokens(s){return new Set(norm(s).split(' ').filter(x=>x.length>3))}
function jaccard(a,b){const A=tokens(a),B=tokens(b);let inter=0;for(const x of A)if(B.has(x))inter++;const union=new Set([...A,...B]).size;return union?inter/union:0}
function classify(url,title){const h=(url+' '+title).toLowerCase();if(/pubmed|nih\.gov|ncbi\.nlm|mayoclinic|hopkinsmedicine|stanford\.edu|parkinson\.org|movementdisorders\.org|lbda/.test(h))return 'clinical/patient organization';if(/reddit|agingcare|forum|community|discussion|patient|caregiver/.test(h))return 'community/lived experience';return 'journalism/general web'}
function buildClusters(src){
 const groups=[];
 for(const s of src){const text=norm([s.title,...s.excerpts,s.text].join(' '));if(!text)continue;let best=null,bestScore=0;for(const g of groups){const score=jaccard(text,g.text);if(score>bestScore){bestScore=score;best=g}}
  if(best&&bestScore>=0.28){best.items.push(s);best.text+=` ${text}`}else groups.push({items:[s],text,seed:s});
 }
 return groups.map((g,i)=>{const items=g.items;const kinds=[...new Set(items.map(x=>x.kind))];const community=items.filter(x=>x.kind==='community/lived experience');const clinical=items.filter(x=>x.kind==='clinical/patient organization');const disagreement=items.length>1&&Math.min(...items.map(x=>norm([x.title,...x.excerpts].join(' ')).length))>0?'Different sources describe different practical experiences; inspect the source trail rather than treating the cluster as a consensus.':'';return{id:`p${i}`,category:community.length?'Lived experience':'Clinical context',title:g.seed.title||'Research pattern',summary:community.length?'This cluster contains caregiver/patient reports that appear related, but the app cannot establish that they are independent or universally applicable.':'This cluster is primarily contextual material from clinical or patient-organization sources; use it to check what the lived-experience reports do and do not establish.',report_summary:community.length?`${community.length} community/lived-experience source(s) surfaced.`:`${clinical.length} clinical/patient-organization source(s) surfaced.`,evidence_check:clinical.length?'Clinical/context sources are present; they should be read separately from anecdotal reports.':'No strong clinical corroboration was identified in this result set.',disagreement,independence:items.length>1?'provisional — source independence not fully verified':'single-source',report_count:items.length,tags:kinds.map(k=>k.startsWith('community')?'community':'context'),sources:items.slice(0,8).map(x=>({url:x.url,title:x.title,kind:x.kind}))}}).sort((a,b)=>b.report_count-a.report_count).slice(0,12)
}
function detectSafety(q){const t=q.toLowerCase();const rules=[['urgent-clinical-review',['faint','pass out','syncope','near-faint','near faint','chest pain','trouble breathing','blue lips']],['fall-risk',['fall','falls','falling']],['swallowing-risk',['swallow','aspiration','choking']],['acute-confusion',['acute confusion','sudden confusion','delirium']],['medication-review',['medication','dose','levodopa','drug interaction']]];return rules.filter(([,ks])=>ks.some(k=>t.includes(k))).map(([name])=>name)}
