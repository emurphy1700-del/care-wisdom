export const maxDuration = 60;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const body = req.body || {};
    const query = String(body.query || "").trim();
    const sources = Array.isArray(body.sources) ? body.sources.slice(0, 18) : [];

    if (!query) return res.status(400).json({ error: "Query required" });
    if (!sources.length) return res.status(400).json({ error: "Sources required" });

    const q = query.toLowerCase();

    const has = (source, words) => {
      const text = [
        source.title || "",
        ...(Array.isArray(source.excerpts) ? source.excerpts : [])
      ].join(" ").toLowerCase();
      return words.some(w => text.includes(w));
    };

    const community = sources.filter(s => s && s.type === "community");
    const clinical = sources.filter(s => s && (s.type === "clinical" || s.type === "patient_org"));

    const communityRelevantToQuestion = (source) => {
      if (!source || source.type !== "community") return false;
      const text = [
        source.title || "",
        ...(Array.isArray(source.excerpts) ? source.excerpts : [])
      ].join(" ").toLowerCase();
      const pd = /parkinson|parkinsonism|pd\b/.test(text);
      const freezing = /freez|frozen|stuck|couldn.?t move|unable to move/.test(text);
      const transfer = /chair|sit.?to.?stand|stand up|get(ting)? up|transfer|bathroom|walker|walking|gait/.test(text);
      return pd && freezing && transfer;
    };
    const journalism = sources.filter(s => s && s.type === "journalism");

    const patterns = [];

    const isCleanEvidenceExcerpt = (excerpt, words) => {
      const t=String(excerpt||"").replace(/\s+/g," ").trim();
      if(t.length<80) return false;
      const lower=t.toLowerCase();
      const navLinks=(t.match(/\[[^\]]+\]\(https?:/g)||[]).length;
      const navWords=(lower.match(/caregiver forum|parkinson'?s disease|questions|topics|resources|sign in|create account|home|search/g)||[]).length;
      if(navLinks>=2 || navWords>=4) return false;
      if(!words.some(w=>lower.includes(String(w).toLowerCase()))) return false;
      return /\b(i|we|my|our|husband|wife|mother|father|mom|dad|patient|caregiver|tried|helped|worked|found|asked|experience|happened|couldn'?t|unable)\b/i.test(t);
    };



    const focusEvidenceExcerpt = (excerpt, words) => {
      const t=String(excerpt||"").replace(/\s+/g," ").trim();
      const sentences=t.split(/(?<=[.!?])\s+/);
      const hits=sentences.filter(s => words.some(w => s.toLowerCase().includes(String(w).toLowerCase())));
      return (hits.length ? hits.slice(0,2).join(" ") : t).slice(0,420);
    };

    const addPattern = (title, words, questionList, rabbitHoles, sourceMatcher = null) => {
      const matching = sourceMatcher
        ? sources.filter(s => s && sourceMatcher(s))
        : sources.filter(s => s && (s.type === "community" ? communityRelevantToQuestion(s) && has(s, words) : has(s, words)));
      if (!matching.length) return;

      const exp = matching.filter(s => s.type === "community" && communityRelevantToQuestion(s));
      const clin = matching.filter(s => s.type === "clinical" || s.type === "patient_org");
      const domains = [...new Set(exp.map(s => s.domain).filter(Boolean))];

      const trail = matching.slice(0, 8).map(s => ({
        title: String(s.title || "").slice(0, 180),
        url: String(s.url || ""),
        type: s.type || "other",
        role: s.type === "community" ? "firsthand/community record"
          : s.type === "journalism" ? "public reporting"
          : "clinical context"
      }));

      const excerpts = exp
        .flatMap(s => Array.isArray(s.excerpts) ? s.excerpts : [])
        .filter(x => isCleanEvidenceExcerpt(x, words))
        .slice(0, 4)
        .map(x => focusEvidenceExcerpt(x, words))
        .filter(Boolean)
        .slice(0, 2);

      // If extraction is too thin, preserve the firsthand source signal rather
      // than telling the user that no report exists. We deliberately describe
      // this as a report/discussion, not as proof that an intervention worked.
      const fallbackReports = exp
        .filter(s => !excerpts.length || !Array.isArray(s.excerpts) || !s.excerpts.length)
        .slice(0, 3)
        .map(s => {
          const title = String(s.title || "Caregiver discussion").trim();
          return title + " — firsthand discussion relevant to this question.";
        });

      const clinicalExcerpts = clin
        .flatMap(s => Array.isArray(s.excerpts) ? s.excerpts : [])
        .filter(x => words.some(w => String(x).toLowerCase().includes(w)))
        .slice(0, 3)
        .map(x => focusEvidenceExcerpt(x, words))
        .filter(Boolean)
        .slice(0, 2);

      const repeated = exp.length >= 2 && domains.length >= 2 && exp.every(communityRelevantToQuestion);

      patterns.push({
        title,
        category: exp.length ? (clin.length ? "mixed" : "lived_experience") : "clinical_context",
        evidence_profile: {
          level: repeated ? "repeated_independent" : "limited_support",
          label: repeated ? "Repeated across source domains" : "Limited support",
          rationale: repeated
            ? "This appeared in firsthand sources from at least two source domains. That still does not establish independent people or prove the approach works for everyone."
            : "This appeared in the supplied evidence, but the available sources do not establish independent repeated reports."
        },
        what_people_reported: excerpts.length
          ? excerpts.map(x => "“" + x + "”").join(" ")
          : fallbackReports.length
            ? fallbackReports.join(" ")
            : exp.length
              ? "Firsthand sources were found, but the page extracts were too thin to safely summarize what was reported."
              : "No qualifying firsthand report was found for this specific theme.",
        evidence_check: clinicalExcerpts.length
          ? clinicalExcerpts.map(x => "“" + x + "”").join(" ")
          : clin.length
            ? "Clinical sources address this theme, but the available extracts are too thin for a stronger evidence statement."
            : "No qualifying clinical source in this evidence set directly addressed this theme.",
        disagreement: exp.length && clin.length
          ? "The evidence comes from different kinds of sources and contexts. It does not establish that the same approach works for everyone."
          : exp.length
            ? "The reports point in a similar direction, but the available evidence does not establish how generalizable the experience is."
            : "This is clinical context rather than a recurring firsthand pattern.",
        independence_note: exp.length ? "This pattern uses " + exp.length + " firsthand source(s) across " + domains.length + " domain(s). Source count is not a count of independent people." : "No firsthand source was strong enough to support this pattern.",
        care_team_questions: [{
          provider: q.includes("freez") ? "Physical Therapist" : "Appropriate care-team clinician",
          questions: questionList
        }],
        evidence_trail: trail,
        why_this_surfaced: exp.length ? "The pattern was surfaced from firsthand/community sources plus any clinical context shown separately." : "The pattern was surfaced from clinical or public context; it is not presented as a recurring firsthand experience.",
        rabbit_holes: rabbitHoles,
        source_titles: trail.map(x => x.title)
      });
    };

    if (/freez|chair|stand|transfer|cue|getting out/.test(q)) {
      addPattern(
        "Caregivers describe freezing during transfers",
        ["freez", "freeze", "transfer", "chair", "bathroom", "getting", "stand", "mobility"],
        ["What transfer technique has PT/OT taught for this specific person?", "What should caregivers do when freezing occurs during a chair-to-bathroom transfer?", "Which parts of the transfer are actually unsafe or causing near-misses?"],
        ["Transfer training with PT/OT", "Chair-to-bathroom setup", "Freezing during sit-to-stand"],
        s => (s.type === "community" ? communityRelevantToQuestion(s) : ((s.type === "clinical" || s.type === "patient_org") && has(s, ["freez", "freeze", "transfer", "chair", "bathroom", "getting", "stand", "mobility"])))
      );
      addPattern(
        "Using simple cues and slowing the movement",
        ["cue", "count", "rhythm", "music", "visual", "slow", "march", "step"],
        ["Which verbal, visual, or rhythmic cues are appropriate for this specific transfer?", "What should staff do if a cue makes freezing worse?"],
        ["Visual cueing", "Auditory or rhythmic cueing", "Chair-to-stand transfer strategies"]
      );
      addPattern(
        "The chair and transfer setup may matter",
        ["chair", "transfer", "stand", "feet", "foot", "armrest", "position", "walker", "lean"],
        ["Is the chair height, foot position, armrest setup, or assistive device affecting the transfer?", "Would PT/OT assessment of the setup change the plan?"],
        ["Chair height and armrests", "Foot placement and nose-over-toes", "OT assessment of the environment"]
      );
      addPattern(
        "Avoiding rushing or pulling",
        ["rush", "hurry", "pull", "force", "pressure", "frustrat", "panic"],
        ["What pacing and communication should caregivers use during a freezing episode?", "Which cues or physical assistance should caregivers avoid?"],
        ["Caregiver communication", "Freezing triggers", "Safe transfer assistance"]
      );
    } else {
      addPattern(
        "Recurring practical approaches in the source set",
        ["help", "try", "care", "patient", "caregiver", "experience"],
        ["What does the care team think is most relevant to this situation?", "What should be measured or documented to see whether an approach helps?"],
        ["Caregiver experiences", "Clinical context", "Questions for the care team"]
      );
    }

    const used = new Set(patterns.flatMap(p => p.evidence_trail.map(x => x.url)));
    const qTerms = [...new Set(q
      .replace(/[^a-z0-9\\s-]/g," ")
      .split(/\\s+/)
      .filter(w => w.length >= 5)
      .filter(w => !["what","have","found","helpful","someone","caregiver","caregivers","parkinsons","disease"].includes(w))
    )];

    const singleReports = sources
      .filter(s => {
        if(!s || s.type !== "community" || used.has(s.url)) return false;
        const excerpts = Array.isArray(s.excerpts) ? s.excerpts : [];
        return excerpts.some(e => {
          const t=String(e||"").toLowerCase();
          const clean=isCleanEvidenceExcerpt(e, qTerms);
          const conceptHits=qTerms.filter(w=>t.includes(w)).length;
          return clean && conceptHits >= Math.min(2, Math.max(1,qTerms.length));
        });
      })
      .slice(0, 5)
      .map(s => String(s.title || "Untitled") + " (" + String(s.domain || "") + ") — individual report worth exploring.");

    const domains = [...new Set(sources.map(s => s && s.domain).filter(Boolean))];

    const safety = [];
    if (/faint|pass(?:es|ed|ing)? out|syncope|near[- ]?faint/.test(q)) {
      safety.push("Near-fainting or fainting warrants clinical evaluation; Care Wisdom should not turn anecdotes into treatment instructions.");
    }
    if (/fall|falling|fell/.test(q)) {
      safety.push("Falls or repeated near-falls warrant clinical fall-risk assessment.");
    }
    if (/medication|levodopa|dose/.test(q)) {
      safety.push("Medication changes should be discussed with the prescribing clinician or pharmacist.");
    }

    return res.status(200).json({
      question: query,
      overview: patterns.length
        ? "The strongest themes surfaced were: " + patterns.slice(0, 3).map(p => p.title).join("; ") + ". Care Wisdom separates firsthand reports from clinical context and preserves uncertainty."
        : "The evidence pool did not produce a recurring pattern strong enough to promote.",
      single_reports: singleReports,
      patterns: patterns.slice(0, 4),
      limitations: community.filter(communityRelevantToQuestion).length < 2
        ? ["Few directly relevant firsthand discussion records were found. Source-domain diversity is not the same as independent people."]
        : [],
      safety_flags: safety,
      sources,
      source_stats: {
        total: sources.length,
        independent_domains: domains.length,
        lived_experience_sources: community.length,
        selected_lived_experience_sources: community.length,
        reddit_sources: sources.filter(s => s && s.domain === "reddit.com").length,
        aarp_sources: sources.filter(s => s && s.domain === "aarp.org").length,
        public_sources: journalism.length,
        domains
      }
    });
  } catch (e) {
    console.error("Synthesis failed", e);
    return res.status(500).json({
      error: "Synthesis failed",
      detail: String(e && e.stack ? e.stack : e).slice(0, 1200)
    });
  }
}
