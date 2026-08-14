---
doc_id: CANDIDATES
doc_type: canon_candidates
owner: claude
version: 2
canon_status: draft
---
# CANON CANDIDATES — proposals only, not canon

Enter CONTINUITY.md only on approval + successful commit.

## From CH01-S01-DRAFT-v1

```yaml
- id: CAND-0001  entity: CHAR-marla-vane  property: father_name
  value: "Thomas Vane (T.V.)"            valid_from: CH01-S01  status: proposed
- id: CAND-0002  entity: CHAR-marla-vane  property: carrying
  value: "brass lighter, moved from shelf to jacket pocket"   status: proposed
- id: CAND-0003  entity: CHAR-marla-vane  property: history
  value: "first carried the chain at nineteen"                status: proposed
- id: CAND-0004  entity: OBJ-lighter      property: description
  value: "brass, worn smooth one face, stiff hinge, engraved V.R."  status: proposed
- id: CAND-0005  entity: OBJ-field-book-1994 property: description
  value: "canvas-backed, 1994 hand-inked on spine; he called it 'a year'"  status: proposed
- id: CAND-0006  entity: OBJ-press        property: contents
  value: "31 field books, one per year walked"                status: proposed
- id: CAND-0007  entity: LOC-cobbs-fence  property: witness_post
  value: "second post well inland of stake 11, weathered, no survey mark; distance unmeasured in CH01"  status: proposed
- id: CAND-0008  entity: SURVEY           property: stake_1
  value: "set 12 May 07:20, 4.0 m landward, dated, unwitnessed"  status: proposed
- id: CAND-0009  entity: TIDE             property: low_water_12_may
  value: "06:40"                                              status: proposed
```

**Gemini extraction-completeness audit: NOT PERFORMED.** §4.8.3 — this chapter
cannot reach APPROVED. Held at `PENDING_AUDIT`.

## From CH02-S01-DRAFT-v1

```yaml
- id: CAND-0010  entity: SURVEY  property: stakes_8_9_10
  value: "13 May: -2.0, -2.5, -1.0 m"                      status: proposed
- id: CAND-0011  entity: SURVEY  property: stake_11_chain
  value: "reads -41.2 m from 1994 recorded position"       status: proposed
- id: CAND-0012  entity: SURVEY  property: stake_11_as_set
  value: "1995-2025 position stands +40 m seaward"         status: proposed
- id: CAND-0013  entity: SURVEY  property: stake_11_state
  value: "NOT DRIVEN on 13 May — the only stake left unset" status: proposed
- id: CAND-0014  entity: LOC-sea-wall  property: benchmark
  value: "granite, cut 1911, independent datum"            status: proposed
- id: CAND-0015  entity: LOC-sanders-point property: shelter
  value: "shingle bar shelters that stretch; less drift"   status: proposed
- id: CAND-0016  entity: CHAR-ivor-cobb property: physical
  value: "hip set badly in 1998"                           status: proposed
- id: CAND-0017  entity: CHAR-ivor-cobb property: knows
  value: "asked which year's figures she is using (CH02)"  status: proposed
- id: CAND-0018  entity: CHAR-marla-vane property: knows
  value: "stake 11 is 40 m out; does NOT know why"         status: proposed
- id: CAND-0019  entity: SP-003 property: measurement
  value: "unmarked post measured 40 m from stake 11 — matches" status: proposed
```

**Gemini extraction-completeness audit: NOT PERFORMED** for CH01 or CH02.
Neither chapter can reach APPROVED (§4.8.3). Both held at `PENDING_AUDIT`.
19 candidates pending. `CONTINUITY.md` remains untouched.

## From CH03-S01-DRAFT-v1

```yaml
- id: CAND-0020  entity: LOC-harbour-office  property: theodolite
  value: "kept in back cupboard, used ~twice a decade"      status: proposed
- id: CAND-0021  entity: CHAR-ellen-sarai   property: manner
  value: "procedural; warns by stating facts aloud for the record"  status: proposed
- id: CAND-0022  entity: SURVEY  property: theodolite_signout
  value: "14 May, purpose 'verification, stake 11'"         status: proposed
- id: CAND-0023  entity: SURVEY  property: stake_11_reading_3
  value: "-41.1 m, theodolite, datum 1911 granite benchmark" status: proposed
- id: CAND-0024  entity: SURVEY  property: corroboration
  value: "3 readings, 2 instruments, 2 datums, all agree"    status: proposed
- id: CAND-0025  entity: CHAR-ivor-cobb property: witnessed
  value: "signed 14 May, added 'own ground' unprompted"      status: proposed
- id: CAND-0026  entity: WORLD  property: storm_1994
  value: "Nov 1994 storm: net store roof, 3 ft water low road, salt in fields
          town-wide"                                        status: proposed
- id: CAND-0027  entity: CHAR-thomas-vane property: survey_1994
  value: "took unusually long over the May 1994 survey"      status: proposed
- id: CAND-0028  entity: CHAR-ivor-cobb property: knows
  value: "knows why stake 11 is wrong; declines to say"      status: proposed
- id: CAND-0029  entity: CHAR-marla-vane property: knows
  value: "the error is not hers — possibility one eliminated" status: proposed
```

**Count established by check_candidates.py, not reported.** `CONTINUITY.md` still untouched. No audit of
record for CH01, CH02 or CH03 (§4.8.3) — all three held at `PENDING_AUDIT`.

## From CH04-S01-DRAFT-v1

```yaml
- id: CAND-0030  entity: SURVEY  property: tide_window_16may
  value: "Kell Head->Sanders Point 07:50-11:50; 6 km shingle, submerged at HW"  status: proposed
- id: CAND-0031  entity: SURVEY  property: readings_16may
  value: "stake 2 -1.8 true; 3 out 8 m; 4 true; 5 out 22 m; 6 true; 7 out 14 m;
          8 true; 9 out 31 m; 11 out 40 m undriven"                 status: proposed
- id: CAND-0032  entity: SURVEY  property: distribution
  value: "every stake on open ground true within 2 m; every stake on farmland seaward"  status: proposed
- id: CAND-0033  entity: WORLD  property: condemnation_rule
  value: "ground inside the line 2 consecutive years comes off the agricultural
          register; compensation inadequate; in force since 1995"    status: proposed
- id: CAND-0034  entity: WORLD  property: affected_farms
  value: "Cobb, Reddin, Hale, Sowerby — the four with land below the 1995 level"  status: proposed
- id: CAND-0035  entity: CHAR-marla-vane property: knows
  value: "discrepancies map to farm boundaries; possibility two eliminated"  status: proposed
- id: CAND-0036  entity: CHAR-reddin property: relationship
  value: "taught Marla to swim off the slipway"                      status: proposed
- id: CAND-0037  entity: CHAR-hale property: family
  value: "daughter Jenny, Marla's schoolmate"                        status: proposed
- id: CAND-0038  entity: CHAR-sowerby property: status
  value: "deceased; two fields now his son's; grandson aged ~7-8"    status: proposed
```

## From CH05-S01-DRAFT-v1

```yaml
- id: CAND-0039  entity: WORLD  property: grant_formula
  value: "coastal maintenance grant = defended frontage x rate; frontage =
          everything seaward of the filed line; formula written 1988, survived
          four reviews; ~GBP1,100 per metre"                         status: proposed
- id: CAND-0040  entity: WORLD  property: filed_frontage
  value: "4,112 m; pier repair and flood insurance both costed against it"  status: proposed
- id: CAND-0041  entity: SURVEY property: true_frontage_estimate
  value: "~3,900 m; ~212 m short; exposure ~GBP233,000/yr"           status: proposed
- id: CAND-0042  entity: SURVEY property: log_entry_18may
  value: "theodolite returned; log reads 'Reading confirmed' — true, omits all"  status: proposed
- id: CAND-0043  entity: CHAR-ellen-sarai property: manner
  value: "reads upside down; calls the grant formula bad; states facts for the record"  status: proposed
- id: CAND-0044  entity: CHAR-jenny-hale property: detail
  value: "schoolmate; infant on hip; father farms the wet corner, barley this year"  status: proposed
- id: CAND-0045  entity: CHAR-hale property: fear
  value: "feared the council would send someone 'strict about it'"   status: proposed
- id: CAND-0046  entity: CHAR-marla-vane property: act
  value: "18 May — let a false figure stand in public; wrote 'Reading confirmed'"  status: proposed
- id: CAND-0047  entity: CHAR-marla-vane property: knows
  value: "a true line costs the town its harbour money, not only four farms"  status: proposed
```

**80 candidates pending. CONTINUITY.md untouched. No audit of record for any
chapter (§4.8.3) — CH01–CH05 all held at PENDING_AUDIT.**


**ISS-003 repair:** CH04/CH05 candidates converted from prose summary to
structured records (CAND-0030 … CAND-0047). Ledger is now machine-countable.


## From CH06-S01-DRAFT-v1 (midpoint — load-bearing evidence)

```yaml
- id: CAND-0048  entity: OBJ-field-book-1994 property: first_page
  value: "T. VANE — SURVEY — MAY 1994, careful capitals"             status: proposed
- id: CAND-0049  entity: SURVEY-1994-TRUE property: figures
  value: "stake 3 = -11.4 m; 5 = -26.1 m; 7 = -19.8 m; 9 = -34.9 m; 11 = -43.6 m"
  units: metres  precision: 0.1 m                                    status: proposed
- id: CAND-0050  entity: SURVEY-1994-FILED property: figures
  value: "stake 3 = -3.1 m; 5 = -4.0 m; 7 = -2.8 m; 9 = -5.2 m; 11 = -3.6 m"
  units: metres  precision: 0.1 m                                    status: proposed
- id: CAND-0051  entity: SURVEY-1994 property: displacement
  value: "stake 3 = 8.3 m; 5 = 22.1 m; 7 = 17.0 m; 9 = 29.7 m; 11 = 40.0 m"
  units: metres  precision: 0.1 m
  provenance: "CH06-S01-DRAFT-v1, read from the 1994 field book"
  source_chapter: CH06
  classification: LOAD-BEARING
  affects: [02_BIBLE/TIMELINE.md, 02_BIBLE/locations/cobbs-fence.md,
            02_BIBLE/characters/marla-vane.md, 03_MEMORY/STATE_SNAPSHOT.md]
  note: "stake-11 displacement 40.0 m equals Marla's 2026 measurement. CH11 rests
         on this correspondence."
  status: proposed
- id: CAND-0052  entity: SURVEY-1994 property: open_ground
  value: "council strip, shingle and common identical in both sets to the decimetre;
          ONLY farm positions differ"                                status: proposed
- id: CAND-0053  entity: SURVEY-1994 property: dates
  value: "true survey completed 14 May 1994; false set filed 3 June 1994; 20-day gap"
  status: proposed
- id: CAND-0054  entity: SURVEY-1994 property: handwriting
  value: "filed copy NEATER than the true one — written at a table, columns
          square, totals ruled twice; true copy field-written, rain-spotted"  status: proposed
- id: CAND-0055  entity: OBJ-press property: contents_verified
  value: "31 field books; EVERY year contains a true and a filed set;
          sampled 2003 and 2011, both confirmed"                     status: proposed
- id: CAND-0056  entity: CHAR-thomas-vane property: method
  value: "corrected for chain temperature; wrote tide before time; small dash
          after any figure taken twice"                              status: proposed
- id: CAND-0057  entity: CHAR-thomas-vane property: only_statement
  value: "last ruled page, ordinary hand, undated: 'Two years and the ground is
          gone. It is not gone yet.'"                                status: proposed
- id: CAND-0058  entity: OBJ-field-book-1994 property: eleven_day_gap
  value: "no entries for 11 days after the November 1994 storm"      status: proposed
- id: CAND-0059  entity: CHAR-marla-vane property: knows
  value: "her father falsified the line deliberately from 1994 and preserved the
          true figures for 31 years"                                 status: proposed
- id: CAND-0060  entity: OBJ-field-book-1994 property: inside_cover
  value: "shopping list in her mother's handwriting"                 status: proposed
```

**ISS-004 repair:** CH06 was never extracted. Now recorded with units and
precision carried explicitly on every numeric.

## From CH07-S01-DRAFT-v1

```yaml
- id: CAND-0061  entity: SURVEY-2026 property: all_stakes
  value: "-4.0, -1.8, -8.0, -2.0, -22.0, -1.0, -14.0, -2.5, -31.0, -1.0, -41.2"
  units: metres  precision: 0.1 m                                    status: proposed
- id: CAND-0062  entity: SURVEY-2026 property: sum_corrections
  value: "-128.5 m"  units: metres                                   status: proposed
- id: CAND-0063  entity: SURVEY-2026 property: frontage
  value: "true 3983.5 m vs filed 4112.0 m"
  units: metres  precision: 0.1 m
  provenance: "CH07-S01-DRAFT-v1, totalled twice from 11 stake readings"
  source_chapter: CH07
  classification: LOAD-BEARING
  affects: [02_BIBLE/TIMELINE.md, 02_BIBLE/characters/marla-vane.md,
            03_MEMORY/STATE_SNAPSHOT.md]
  note: "the figure CH11 submits"                                     status: proposed
- id: CAND-0064  entity: SURVEY-2026 property: grant_shortfall
  value: "128.5 m x GBP1,100/m = GBP141,350 per year"                status: proposed
- id: CAND-0065  entity: SURVEY-2026 property: estimate_divergence
  value: "CH05 estimate ~200 m / ~GBP220k; CH07 calculation 128.5 m / GBP141,350"
  divergence: intentional  ruling: ISS-005                           status: proposed
- id: CAND-0066  entity: LAND-reddin property: loss
  value: "11 acres seaward strip, inside the true line by 6 m; grazed not cropped"  status: proposed
- id: CAND-0067  entity: LAND-hale property: loss
  value: "NONE — true line runs 4 m seaward of his boundary; wet corner survives"  status: proposed
- id: CAND-0068  entity: LAND-sowerby property: loss
  value: "far field lost entirely (9 acres, holds road access); near field kept
          but becomes landlocked"                                    status: proposed
- id: CAND-0069  entity: LAND-cobb property: loss
  value: "the long acre ENTIRELY — true line runs along the top hedge where the
          unmarked 1994 post stands"                                 status: proposed
- id: CAND-0070  entity: SP-003 property: confirmed
  value: "the unmarked post IS the true 1994 line position"          status: proposed
- id: CAND-0071  entity: CHAR-ivor-cobb property: act
  value: "24 May — saw her at the post, said nothing, reversed away"  status: proposed
- id: CAND-0072  entity: CHAR-marla-vane property: knows
  value: "wanted the number catastrophic so publishing would stop being a choice"  status: proposed
```

## From CH08-S01-DRAFT-v1

```yaml
- id: CAND-0073  entity: WORLD property: section_14
  value: "surveyor unable to certify may file provisional; carries previous
          year's figure forward; legal, intended for illness/accident"  status: proposed
- id: CAND-0074  entity: WORLD property: pier_commitment
  value: "GBP160,000 over 3 years, ~GBP90,000 already contracted"     status: proposed
- id: CAND-0075  entity: WORLD property: insurance_exposure
  value: "flood COVER written off frontage; reprices below 4,000 m; never tested"  status: proposed
- id: CAND-0076  entity: CHAR-ellen-sarai property: history
  value: "wrote the last four grant applications; suspected since 2011 —
          frontage moved <1 m/yr for 19 years then 4 m in one"        status: proposed
- id: CAND-0077  entity: CHAR-ellen-sarai property: inaction
  value: "did not check; would have had to be right about Tom Vane and live here"  status: proposed
- id: CAND-0078  entity: CHAR-marla-vane property: knows
  value: "stake 11 undriven qualifies as incomplete survey under s.14"  status: proposed
- id: CAND-0079  entity: CHAR-thomas-vane property: mechanism
  value: "not one lie in 1994 — a mechanism run 31 times: no field ever inside
          the line two consecutive years, so none ever left the register"  status: proposed
- id: CAND-0080  entity: SP-002 property: second_payoff
  value: "'Two years and the ground is gone. It is not gone yet.' — reinterpreted
          at CH08. Words unchanged, meaning inverted. NOT a retcon"    status: proposed
```

## From CH09-S01-DRAFT-v1

```yaml
- id: CAND-0081  entity: SURVEY property: interim_filing
  value: "26 May, 3,983.5 m, marked INTERIM pending stake 11"  status: proposed
- id: CAND-0082  entity: CHAR-ivor-cobb property: motive_1994
  value: "asked Thomas Vane in May 1994 to hold the true figure; Vane came to
          tell the truth, thought 3 weeks, then did it"        status: proposed
- id: CAND-0083  entity: CHAR-ivor-cobb property: circumstances_1994
  value: "wife Peggy ill (d.1997), son aged 19, GBP8,000 borrowing on the field"  status: proposed
- id: CAND-0084  entity: CHAR-ivor-cobb property: aftermath
  value: "son went to Aberdeen; four years grateful, the rest hoping Vane would
          die before anyone found out"                          status: proposed
- id: CAND-0085  entity: CHAR-reddin property: knowledge
  value: "probably asked"                                       status: proposed
- id: CAND-0086  entity: CHAR-sowerby property: knowledge
  value: "knew and said nothing"                                status: proposed
- id: CAND-0087  entity: CHAR-hale property: knowledge
  value: "NEVER KNEW — and loses nothing. Consistent with CAND-0067"  status: proposed
- id: CAND-0088  entity: CHAR-ivor-cobb property: request
  value: "asks Marla to use section 14 — first thing he has ever asked her"  status: proposed
```

## From CH10-S01-DRAFT-v1

```yaml
- id: CAND-0089  entity: FACT property: hearing
  value: "29 May, town hall, 31 attendees, harbour board scheduled meeting"  status: proposed
- id: CAND-0090  entity: THR-006 property: payoff
  value: "'Reading confirmed' read back; Marla states it is true but not complete"  status: proposed
- id: CAND-0091  entity: CHAR-ellen-sarai property: act
  value: "notes disclosure 24 May unprompted and interim filing 26 May"  status: proposed
- id: CAND-0092  entity: FACT property: no_one_asked_falsely
  value: "Marla states on record nobody asked her to file a false figure"  status: proposed
- id: CAND-0093  entity: CHAR-hale property: speech
  value: "spoke publicly; declines to vote on the year; 'I'd not want it done in
          the dark again'"                                      status: proposed
- id: CAND-0094  entity: CHAR-ivor-cobb property: restraint
  value: "did not speak; shook his head once — would not ask twice in public"  status: proposed
- id: CAND-0095  entity: FACT property: field_book_admissible
  value: "Sarai rules the 1994 book admissible: 'It's a survey record. It should
          have been filed in 1994.'"                            status: proposed
- id: CAND-0096  entity: FACT property: deadline
  value: "board will receive either form by 1 June"              status: proposed
```

## From CH11-S01-DRAFT-v1

```yaml
- id: CAND-0097  entity: FACT property: stake_11_driven
  value: "31 May 07:00, top hedge, 40 m landward, rain, unwitnessed"  status: proposed
- id: CAND-0098  entity: FACT property: true_filing
  value: "31 May 09:00, 3983.5 m certified, one day before deadline"  status: proposed
- id: CAND-0099  entity: FACT property: field_book_filed
  value: "1994 field book filed with the survey plus covering note"   status: proposed
- id: CAND-0100  entity: SP-003 property: payoff
  value: "unmarked post cited in the filing as the physical marker of the true
          1994 position"                                              status: proposed
- id: CAND-0101  entity: CHAR-marla-vane property: reason
  value: "refused the 'sloppy predecessor' filing — 'I'd have been keeping a
          press of my own'"                                           status: proposed
```

## From CH12-S01-DRAFT-v1

```yaml
- id: CAND-0102  entity: FACT property: line_driven
  value: "4 June, LW 05:55; Cobb held the chain"                      status: proposed
- id: CAND-0103  entity: CHAR-thomas-vane property: witness_post_origin
  value: "1994: set all posts true FIRST, then after Cobb's request pulled and
          reset every one EXCEPT the witness post — left deliberately"
  provenance: "CH12-S01, Cobb's account"  source_chapter: CH12       status: proposed
- id: CAND-0104  entity: SP-001 property: payoff
  value: "1979 book: 'T. Vane, assisting. Surveyor: V. Reid.' The lighter was
          Vera Reid's. Marla does not investigate further"           status: proposed
- id: CAND-0105  entity: FACT property: appointment
  value: "board confirms 3983.5 m; 1994 record referred; appoints her for 2027;
          appointment discretionary, not hereditary"                  status: proposed
- id: CAND-0106  entity: CHAR-reddin property: reconciliation
  value: "lifted his chin about a centimetre and went inside"         status: proposed
```
