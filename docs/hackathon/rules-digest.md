# Hackathon rules digest

**Event:** Meta Global AI Developer Hackathon (Cerebral Valley). The full text is in `guide-full-text.md` and the original page in `guide-original.html`.

All times are given in Eastern Time (ET) and **Cambodia time (ICT, UTC+7)**. US clocks fall back on Sun 1 Nov: ET is UTC−4 until then, and UTC−5 after.

## Dates
| What | ET | ICT |
|---|---|---|
| Kickoff | Mon 26 Oct 12:00 PM | Mon 26 Oct 11:00 PM |
| Agents 101: Build a Multimodal AI Agent (livestream) | Tue 27 Oct 12–1 PM | Tue 27 Oct 11 PM–12 AM |
| Agents 102: Best Practices for Verifiable Agents | Wed 28 Oct 12–1 PM | Wed 28 Oct 11 PM–12 AM |
| Building Specialized Intelligence on Fireworks with Muse Open Models | Fri 30 Oct 12–1 PM | Fri 30 Oct 11 PM–12 AM |
| Discord office hours (weekdays) | 10–11 AM | **9–10 PM** until Fri 30 Oct; **10–11 PM** from Mon 2 Nov |
| Last full day for submission questions | Tue 3 Nov | Tue 3 Nov (office hours 10–11 PM) |
| Final office hours, and **submissions due** | **Wed 4 Nov 9:00 PM** | **Thu 5 Nov 9:00 AM** |
| Judging | Thu 5 – Sun 8 Nov | |
| Closing ceremony: top 10 (5 per track), live final judging | Mon 9 Nov 12:00 PM | Tue 10 Nov 12:00 AM (midnight) |
| Most Viral: X engagement counted until | Sun 8 Nov, end of day | |
| Community vote winner announced (Discord) | Mon 16 Nov | |

**Plan:** submit on Wed 4 Nov in the evening ICT. Don't plan to use the Thursday morning before the deadline.

## Problem statements (the project must build toward one)
- **Build for Your World:** bring Meta's models into your domain. Solve a problem you know first-hand, free up time and mental space, and make something possible that wasn't before.
- **Push the Frontier:** use Meta's models on challenges in software, robotics, manufacturing, energy, materials and beyond.

**Required:** the project must incorporate Meta's models. The options are:
- through the Meta Model API: the Muse Spark series, Muse Wonder, Muse Image, Muse Voice Transcribe, SAM 3.1
- open weights, run yourself or through a partner: Muse Glimmer, Muse Spark Open
- Muse Code, the coding agent

## Rules
- **Repositories must be public.**
- Teams of at most **4**. Solo entries are allowed.
- **The demo must show only what was built during the hackathon.** Judges must be able to tell clearly what was created during the event. **Failing to identify original contributions means immediate disqualification**, at the judges' discretion.
- **New work only.** "Startups may build on existing products or codebases, but you must clearly identify what was newly developed." The indie track is not addressed. **Ask** (see `../00-today-checklist.md`).
- **Banned:** projects that break legal, ethical or platform policies, or that use code, data or assets you don't have the rights to.
- **"Anti-projects"** (generic, or against platform policies), listed as not exhaustive:
  - medical-advice AI
  - basic RAG
  - simple image analyzers
  - simple education chatbots
  - job screeners
  - nutrition coaches
  - personality analyzers
  - sports coaches
  - **"Anything political or involving war"**

  This last item is why the plan reframes VANGUARD as The Wardens.

## Submission
- Submit on the Cerebral Valley platform by **Wed 4 Nov, 9:00 PM ET**. Late entries aren't considered.
- **One submission per team.** One person, the "Representative", submits for the team.
- Check that the **repository is public**, the **video link works**, and **every team member is listed**.
- **A 3-minute demo video is required.** It must highlight the features, code and functionality built during the hackathon. Judges use it as a primary artifact, together with the code and the live product.

## Judging
**Stage 1, pass/fail:** is the project viable, does it fit the theme, and did it reasonably use the Meta Model API and/or Meta open-weight models, built during the hackathon?

**Stage 2:** four criteria, equally weighted, each scored 0–10.

| Criterion | What they ask | Our answer |
|---|---|---|
| **Impact** | Real-world potential? Who benefits, how much? Could people actually use it? Does it fit a problem statement? | Voice plus a few marks makes real-time strategy playable without fast, precise hands: an accessibility pattern, proven on a game. Privacy: the voice is interpreted on the device. |
| **Use of Meta AI tooling** | Creative, beyond a basic integration? "Surfaced capabilities that surprised even us"? | A local Glimmer turns speech into orders, grounded in what the player can see, under a schema built per battle. The same model plays the enemy. Muse Voice Transcribe is the ears. Muse Image paints faces, if you can get access. |
| **Technical depth and execution** | Sound engineering, thought through with craft? | A deterministic Rust sim (native and WASM), replays, a headless harness with bots and balance bands, a validated order queue, and a pixel-art 3D pipeline. |
| **Demo** | Working, impressive, holds up live, cool to watch? | The "shout at the cavalry" opening; see `../02-plan/plan-8-days.md`. |

**Stage 3:** the top 5 per track are ranked live by the final judges, from the videos, using the same rubric.

## Prizes
- **Indie Developer track:** $150k / $100k / $75k / $50k / $25k.
- **Startups track:** $250k / $150k / $75k / $50k / $25k.
- **Bonus prizes:**

| Bonus | Prize | How it is judged | Our angle |
|---|---|---|---|
| Most Viral | $20k | highest engagement on an X post of the demo, until 8 Nov; submit the link | "Total War, but you command your army by voice" |
| **Best Build on Meta Open Weight Models** | $10k | Muse Glimmer or Spark Open, on your own hardware or partner inference; the partner verifies | **The core target**: Glimmer on the M5 Pro, plus a hosted copy for the judges |
| Community Vote | $10k | public gallery votes, one per verified account | |
| Best Agentic Use-Case | $5k | autonomy, effectiveness, usefulness | the broodlord agent, and commanders that act on intent (stretch) |
| Best Creative Build | $5k | using Muse Image or Muse Wonder | portraits and banners, if you have Meta Model API access |

## Credits and resources
- **Meta Model API:** $150 per participant, each claimed individually. A credit card is required, so set a spend limit. Claim by Wed 4 Nov, 9 PM ET.
- **Baseten:** $100 plus a 2M TPM rate limit, up to 2,000 participants, reviewed per individual. **Use the model id `meta-models/muse-spark-open-1026`**, not the one in the docs.
- **Modal:** $100, the first 1,000 participants. Covers serving Meta's open-weight models on Endpoints, plus GPUs.
- **Fireworks:** $25 per team, for selected teams.
- **Discord channels:** `#questions` (Cerebral Valley), `#office-hours` (the Meta team), `#announcements`, `#team-search`.
