# vendor/ig-human

`slop.json` is copied verbatim from
[jakeschincariol/instagram-agent-skill](https://github.com/jakeschincariol/instagram-agent-skill)
(`skills/ig-human/slop.json`, v3), MIT licensed — see `LICENSE` in this folder.

Why it is vendored instead of imported: the bot is a single browser-console
script and the skill's Python CLIs cannot run inside an Instagram tab. The
lexicon is embedded in `ig-agent-chat.js` as `SLOP_WORDS` / `SLOP_PHRASES` /
`STRUCTURES`, generated from this file, so the two stay in sync by hand.

Only the parts that can survive into a DM are used. The appearance words
(`stunning`, `captivating`, `breathtaking`, `iconic`) are deliberately
excluded in the bot — in a flirty chat those are real compliments, not filler.

The detection model (fingerprint · slop density · burstiness · specificity ·
voice, overall = mean×0.6 + weakest×0.4) is ported to `checkDraft()` in
`ig-agent-chat.js`.
