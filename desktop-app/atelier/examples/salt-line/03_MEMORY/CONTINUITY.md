---
doc_id: CONTINUITY
doc_type: continuity_memory
owner: claude
version: 1
last_updated: 2026-08-12
canon_status: approved
supersedes: none
affects: []
---

# CONTINUITY MEMORY

**APPEND-ONLY.** Facts are never edited in place. A fact that becomes wrong is
superseded by a new entry pointing back at it. This preserves what was true
when — which is what's needed to fix a contradiction correctly rather than
paper over it.

Categories: INJURY · CLOTHING · OBJECT · OBJECT_LOCATION · CHARACTER_LOCATION ·
RELATIONSHIP · KNOWLEDGE · SECRET_REVEALED · PROMISE · DEATH · DAMAGE ·
ENVIRONMENT · MAGIC_USE · TECH_USE · TIME · QUESTION_OPEN

Format:
```
FACT-0001 | ch01 s01 | CATEGORY | <fact> | est: CH01 | status: active
                                          | expires: <if it has a lifetime>
FACT-0002 | ch03 s02 | SUPERSEDES FACT-0001 | <replacement fact>
```

**Expiry:** facts with natural lifetimes carry `expires`. On expiry the fact is
flagged for review, never auto-deleted — the system asks whether it healed,
scarred, or worsened, and a legible answer replaces the guess.

**Update discipline:** appended after every approved scene, by Claude, as a
distinct job. Never as a side effect of drafting — extraction while drafting is
unreliable because attention is on the prose.

---
