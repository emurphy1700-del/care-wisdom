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

      // Match firsthand reports to the actual question rather than using a
      // hard-coded freezing/transfer gate for every Parkinson's query.
      const groups = [];
      if (/freez|stuck|chair|recliner|sit[- ]?to[- ]stand|getting out|get(ting)? up|transfer/.test(q)) {
        groups.push(/freez|frozen|stuck|couldn.?t move|unable to move/);
        groups.push(/chair|recliner|seat|sit.?to.?stand|stand up|get(ting)? up|transfer|bathroom|walker|walking|gait/);
      }
      if (/rehab|physical therapy|\bpt\b|occupational therapy|\bot\b|progress|plateau|not making progress|skilled nursing|snf/.test(q)) {
        groups.push(/rehab|rehabilitation|physical therapy|\bpt\b|occupational therapy|\bot\b|therapy session|therapist/);
        groups.push(/progress|plateau|improv|declin|stalled|not making|unable|difficulty|barrier|goal/);
      }
      if (/blood pressure|orthostatic|hypotension|faint|near[- ]?faint|dizzy|lightheaded|syncope/.test(q)) {
        groups.push(/blood pressure|orthostatic|hypotension|faint|near[- ]?faint|dizz|lightheaded|syncope|passed out/);
      }
      if (/toilet|toileting|bathroom|commode/.test(q)) {
        groups.push(/toilet|toileting|bathroom|commode/);
      }

      if (!groups.length) return true;
      // A firsthand record should address at least two substantive aspects of
      // the actual question. We intentionally do not require it to repeat
      // "Parkinson's" because people often rely on conversation context.
      return groups.filter(re => re.test(text)).length >= Math.min(2, groups.length);
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

    const addPattern = (title, words, questionList, rabbitHoles, sourceMatcher = null, clinicalWords = null) => {
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
        .flatMap(s => Array.isArray(s.excerpts) ? s.excerpts.map(x => ({
          sourceTitle: String(s.title || "").replace(/\s+/g, " ").trim(),
          excerpt: String(x || "").replace(/\s+/g, " ").trim()
        })) : [])
        .flatMap(({sourceTitle, excerpt}) => {
          const titleLower = sourceTitle.toLowerCase();
          // Extract sentences from the body, then discard sentences that are
          // effectively the article title, author/affiliation metadata, or
          // navigation/abstract labels. Care Wisdom should quote evidence, not
          // simply repeat the title of the paper.
          return excerpt.split(/(?<=[.!?])\s+/)
            .map(s => s.trim())
            .filter(s => s.length >= 55)
            .filter(s => s.toLowerCase() !== titleLower)
            .filter(s => !/^(abstract|introduction|background|methods|results|conclusion|quick summary|affiliations?)\b/i.test(s))
            .filter(s => !/quick summary|management includes|sign in|create account|home|topics|resources|search|table of contents/i.test(s))
            // Do not treat image captions, alt text, or figure descriptions as
            // clinical evidence. These often describe a person in a photo rather
            // than report a finding from the study.
            .filter(s => !/^(man|woman|person|patient|patient[s']?)\s+(standing|sitting|walking|using|holding|shown|pictured)|using (a )?(crane|walker|cane|wheelchair) and holding|pictured|shown in (the )?(image|photo|figure)/i.test(s))
            .map(s => ({sourceTitle, sentence:s}));
        })
        .filter(({sentence}) => {
          const lower = sentence.toLowerCase();
          const evidenceWords = Array.isArray(clinicalWords) && clinicalWords.length ? clinicalWords : words;
          const hits = evidenceWords.filter(w => lower.includes(String(w).toLowerCase())).length;
          // Require substantive clinical relevance to THIS pattern, not merely
          // a shared disease word or a generic therapy/freezing mention.
          const substantive = /(freez|transfer|sit.?to.?stand|standing|gait|fall|cue|rehab|physical therapy|occupational therapy|mobility|functional|outcome|goal|measure|progress|participat|orthostatic|blood pressure|hypotension|dizz|lightheaded|fatigue|medication|symptom|pain|weakness)/i.test(lower);
          return hits >= Math.min(2, Math.max(1, words.length)) && substantive;
        })
        .map(({sourceTitle, sentence}) => focusEvidenceExcerpt(sentence, words))
        .filter(Boolean)
        .slice(0, 2);

      const repeated = exp.length >= 2 && domains.length >= 2 && exp.every(communityRelevantToQuestion);

      // Never let a clinical-only finding masquerade as a caregiver/lived-experience
      // finding. The title and evidence profile must agree with the actual evidence.
      const displayTitle = !exp.length
        ? title === "Caregivers describe freezing during transfers"
          ? "Freezing can occur during transfers"
          : title === "Using simple cues and slowing the movement"
            ? "Cueing and slowing are described as possible strategies"
            : title === "The chair and transfer setup may matter"
              ? "Transfer setup may affect safety"
              : title === "Avoiding rushing or pulling"
                ? "Pacing and communication may matter during transfers"
                : title
        : title;

      const evidenceLevel = repeated
        ? "repeated_independent"
        : (!exp.length && clin.length ? "strong_clinical_limited_lived" : "limited_support");

      const evidenceLabel = repeated
        ? "Repeated across source domains"
        : (!exp.length && clin.length ? "Clinical context; limited lived experience" : "Limited support");

      const evidenceRationale = repeated
        ? "This appeared in firsthand sources from at least two source domains. That still does not establish independent people or prove the approach works for everyone."
        : (!exp.length && clin.length
          ? "Clinical sources address this theme, but no qualifying firsthand report was found in this evidence set. It is presented as clinical context, not as a recurring caregiver experience."
          : "This appeared in the supplied evidence, but the available sources do not establish independent repeated reports.");

      patterns.push({
        title: displayTitle,
        category: exp.length ? (clin.length ? "mixed" : "lived_experience") : "clinical_context",
        evidence_profile: {
          level: evidenceLevel,
          label: evidenceLabel,
          rationale: evidenceRationale
        },
        what_people_reported: excerpts.length
          ? excerpts.map(x => "“" + x + "”").join(" ")
          : fallbackReports.length
            ? fallbackReports.join(" ")
            : exp.length
              ? "A relevant firsthand source was found, but its extracted passage was too thin to safely summarize what was reported. This is not treated as a recurring pattern."
              : "No qualifying firsthand report was found for this specific theme.",
        evidence_check: clinicalExcerpts.length
          ? clinicalExcerpts.map(x => "“" + x + "”").join(" ")
          : clin.length
            ? "Clinical sources address this theme, but the extracted passages did not contain a clean, directly relevant evidence passage. Care Wisdom is not treating the article title or abstract label as evidence."
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

    // Rehabilitation/PT questions need their own synthesis path. Do not
    // force them through the freezing library just because "standing" or
    // "getting up" appears in a rehab description.
    if (/(rehab|rehabilitation|physical therapy|\\bpt\\b|occupational therapy|\\bot\\b|not making progress|plateau|stalled|skilled nursing|snf)/i.test(q)) {
      addPattern(
        "Progress in rehabilitation needs to be judged by specific functional goals",
        ["progress","goal","improv","rehab","therapy","physical"],
        ["What specific functional goal is PT trying to improve, and what measurable change would count as progress?", "Is performance being measured across the day and during ordinary care—not only during the therapy session?", "What is preventing the patient from participating consistently enough to assess progress?"],
        ["Functional goals and measures", "Performance outside therapy", "Barriers to participation"],
        null,
        ["functional","outcome","goal","measure","progress","gait","walking","balance","mobility","activities of daily living"]
      );
      addPattern(
        "Parkinson's symptoms and other clinical factors can affect rehabilitation participation",
        ["parkinson","orthostatic","blood pressure","fatigue","dizzy","freez","weakness","medication"],
        ["What symptoms or physiologic changes are limiting participation in therapy?", "Has the team considered whether blood-pressure changes, freezing, fatigue, medication timing, pain, or other symptoms are affecting performance?", "Which clinician should evaluate the limiting symptom before the therapy plan is changed?"],
        ["Orthostatic symptoms", "Motor fluctuations/freezing", "Medication timing and fatigue"],
        null,
        ["orthostatic","blood pressure","hypotension","dizziness","lightheaded","freezing","fatigue","medication","symptom","participation","rehabilitation","therapy"]
      );
    }

    // Only use the freezing/transfer pattern library when the question
    // explicitly asks about that problem. Generic words such as "standing"
    // or "getting up" can appear in many unrelated clinical questions
    // (orthostatic symptoms, falls, weakness, PT, etc.) and must not trigger
    // freezing-specific synthesis.
    if (/(freez|stuck|transfer|chair|recliner|sit[- ]?to[- ]stand|getting out of (a |the )?(chair|bed)|cueing|cue|gait freezing)/i.test(q)) {
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
    }

    const used = new Set(patterns.flatMap(p => p.evidence_trail.map(x => x.url)));
    const qTerms = [...new Set(q
      .replace(/[^a-z0-9\\s-]/g," ")
      .split(/\\s+/)
      .filter(w => w.length >= 5)
      .filter(w => !["what","have","found","helpful","someone","caregiver","caregivers","parkinsons","disease"].includes(w))
    )];

    // Preserve relevant firsthand records even when they are not strong
    // enough to support a synthesized pattern. Do not compare the excerpt
    // against every word in the full question: ordinary caregiver language
    // often omits disease names and uses different phrasing.
    const singleReports = sources
      .filter(s => {
        if(!s || s.type !== "community" || used.has(s.url)) return false;
        if(communityRelevantToQuestion(s)) return true;
        const excerpts = Array.isArray(s.excerpts) ? s.excerpts : [];
        const relevanceWords = /rehab|rehabilitation|physical therapy|\bpt\b|occupational therapy|\bot\b|progress|plateau|improv|stalled|goal|freez|frozen|stuck|chair|recliner|transfer|stand|get(ting)? up|blood pressure|orthostatic|hypotension|faint|dizz|lightheaded|toilet|toileting|bathroom|commode/;
        return excerpts.some(e =>
          isCleanEvidenceExcerpt(e, String(e).match(relevanceWords) ? [String(e).match(relevanceWords)[0]] : [])
        );
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
      overview: (() => {
        const recurring = patterns.filter(p => p.evidence_profile?.level === "repeated_independent");
        const clinicalOnly = patterns.filter(p => p.evidence_profile?.level === "strong_clinical_limited_lived");
        const limited = patterns.filter(p => p.evidence_profile?.level === "limited_support");

        if (recurring.length) {
          return "The strongest recurring lived-experience patterns were: " +
            recurring.slice(0, 3).map(p => p.title).join("; ") +
            ". Clinical context is shown separately, and source counts are not treated as counts of independent people.";
        }

        if (clinicalOnly.length) {
          return "The research surfaced clinical context relevant to this question, but it did not find qualifying repeated firsthand reports strong enough to call these caregiver patterns. Care Wisdom keeps clinical context separate from lived experience and preserves uncertainty.";
        }

        if (limited.length) {
          return "The research surfaced potentially relevant reports, but the evidence is too limited to call them recurring independent patterns. Care Wisdom separates firsthand reports from clinical context and preserves uncertainty.";
        }

        return "No reliable recurring pattern was found for this question. Care Wisdom found some potentially related clinical information, but not enough directly relevant evidence to form a useful pattern.";
      })(),
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
